import { WebPlugin } from '@capacitor/core';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

import type {
  NativeVideoCompressorPlugin,
  CompressOptions,
  CompressResult,
  CancelOptions,
  CancelResult,
} from './definitions';
import { CANCELLED } from './definitions';

/**
 * Rejection shape for a cancelled compress. `code` matches what `call.reject`
 * puts on the error object on iOS/Android, so one `error.code === 'CANCELLED'`
 * check works on every platform.
 */
class CancelledError extends Error {
  code = CANCELLED;
  constructor() {
    super('Đã hủy nén');
    this.name = 'CancelledError';
  }
}

const CORE_BASE_URL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';

/**
 * Cancelling means terminating the worker, which drops the loaded core with
 * it — so without this the next compress re-downloads ~30 MB of wasm and
 * "cancel" quietly costs more than it saves. Module scope, not instance: the
 * bytes are identical for every instance and every job.
 */
let corePromise: Promise<{ coreURL: string; wasmURL: string }> | null = null;

const loadCoreURLs = () => {
  if (!corePromise) {
    corePromise = Promise.all([
      toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.js`, 'text/javascript'),
      toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.wasm`, 'application/wasm'),
    ])
      .then(([coreURL, wasmURL]) => ({ coreURL, wasmURL }))
      .catch((e) => {
        // Don't cache a failure — a flaky network shouldn't make every later
        // compress in this session fail too.
        corePromise = null;
        throw e;
      });
  }
  return corePromise;
};

export class NativeVideoCompressorWeb extends WebPlugin implements NativeVideoCompressorPlugin {
  private ffmpeg: FFmpeg | null = null;
  private isLoaded = false;
  /** The job `compressVideo` is running right now, for `cancel({ jobId })`. */
  private currentJobId: string | null = null;
  private cancelRequested = false;

  private async loadFFmpeg() {
    if (this.isLoaded && this.ffmpeg) return;

    this.notifyListeners('onProgress', { status: 'loading_core', percent: 0 });

    // Built on a local, published to the field only once it is ready and still
    // wanted. Assigning `this.ffmpeg` up front and setting `isLoaded` after the
    // await left a window where a cancel could null the instance and the load,
    // finishing a moment later, would set `isLoaded = true` on nothing at all —
    // after which every compressVideo threw 'FFmpeg failed to load' for the
    // rest of the page's life.
    const instance = new FFmpeg();

    // Listen to FFmpeg progress and map it to capacitor plugin events
    instance.on('progress', ({ progress }) => {
      // progress is a fraction between 0 and 1
      this.notifyListeners('onProgress', { status: 'progress', percent: Math.round(progress * 100) });
    });

    instance.on('log', ({ message }) => {
      console.log('[FFmpeg Log]', message);
    });

    try {
      // Use standard single-threaded version for best compatibility across browsers
      // without requiring complex SharedArrayBuffer headers configuration
      console.log('Starting to load FFmpeg core from:', CORE_BASE_URL);
      await instance.load(await loadCoreURLs());
    } catch (e: any) {
      instance.terminate();
      console.error('Failed to load FFmpeg:', e);
      throw e;
    }

    // Cancelled while this was loading. Terminate what we just built rather
    // than publish it — the caller asked for none of it.
    if (this.cancelRequested) {
      instance.terminate();
      throw new CancelledError();
    }

    this.ffmpeg = instance;
    this.isLoaded = true;
    console.log('FFmpeg core loaded successfully');
  }

  /**
   * Kill the worker outright — there is no gentler option.
   *
   * `ffmpeg.exec()` runs *synchronously* inside the worker (see
   * @ffmpeg/ffmpeg's worker.js: `ffmpeg.exec(...args)` is not awaited), so the
   * worker never reaches a message poll while encoding. The AbortSignal that
   * `exec()` accepts only rejects the main-thread promise; the encode keeps
   * burning CPU behind it. `worker.terminate()` is what actually stops it.
   *
   * The cost is the loaded core, which is why the core URLs are cached above.
   */
  async cancel(options?: CancelOptions): Promise<CancelResult> {
    if (!this.currentJobId) return { cancelled: false };
    if (options?.jobId && options.jobId !== this.currentJobId) return { cancelled: false };

    // Set even when there is no instance yet: the job may still be inside
    // loadFFmpeg, which reads this flag before publishing what it built.
    this.cancelRequested = true;
    this.ffmpeg?.terminate();
    this.ffmpeg = null;
    this.isLoaded = false;
    return { cancelled: true };
  }

  async initialize(): Promise<{ success: boolean; message?: string }> {
    try {
      if (this.isLoaded) {
        return { success: true, message: 'Already initialized' };
      }
      await this.loadFFmpeg();
      return { success: true, message: 'Initialization successful' };
    } catch (e: any) {
      return { success: false, message: e.message || 'Initialization failed' };
    }
  }

  async compressVideo(options: CompressOptions): Promise<CompressResult> {
    this.currentJobId = options.jobId ?? 'default';
    this.cancelRequested = false;

    // Checked at every stage boundary, not just around exec: terminate() only
    // reaches work that has already got to the worker, so a cancel during the
    // core download or the source fetch has nothing to interrupt and would
    // otherwise let the compress carry on as if nothing had happened.
    const throwIfCancelled = () => {
      if (this.cancelRequested) throw new CancelledError();
    };

    try {
      if (!this.isLoaded) {
        await this.loadFFmpeg();
      }
      throwIfCancelled();

      if (!this.ffmpeg) {
        throw new Error('FFmpeg failed to load');
      }
      // Bound once. `this.ffmpeg` is nulled by cancel(), so reading it after
      // any of the four awaits below can hand back null on a reference the
      // compiler narrowed at this line — surfacing a cancel as a TypeError
      // instead of a CancelledError.
      const ffmpeg = this.ffmpeg;

      this.notifyListeners('onProgress', { status: 'started', percent: 0 });

      const { sourcePath, quality = 'MEDIUM' } = options;
      const inputFileName = 'input.mp4';
      const outputFileName = 'output.mp4';

      // Map quality to CRF, Scale, and Audio Bitrate
      let crf = '28';
      let scale = ''; // default keep resolution
      let audioBitrate = '128k';

      switch (quality) {
        case 'VERY_HIGH': // 1080p
          crf = '23';
          scale = '-vf scale=-2:1080';
          audioBitrate = '128k';
          break;
        case 'HIGH': // 720p
          crf = '28';
          scale = '-vf scale=-2:720';
          audioBitrate = '128k';
          break;
        case 'MEDIUM': // 540p
          crf = '30';
          scale = '-vf scale=-2:540';
          audioBitrate = '96k';
          break;
        case 'LOW': // 480p
          crf = '32';
          scale = '-vf scale=-2:480';
          audioBitrate = '96k';
          break;
        case '360P': // 360p
          crf = '28';
          scale = '-vf scale=-2:360';
          audioBitrate = '64k';
          break;
        case 'VERY_LOW': // 240p
          crf = '35';
          scale = '-vf scale=-2:240';
          audioBitrate = '48k';
          break;
      }

      console.log('[FFmpeg] Fetching source file...', sourcePath);
      let inputData: Uint8Array;
      try {
        inputData = await fetchFile(sourcePath);
      } catch (err) {
        console.error('[FFmpeg] Error fetching source file:', err);
        throw new Error('Could not fetch source video file');
      }
      throwIfCancelled();

      console.log('[FFmpeg] Writing file to FS...', inputData.byteLength, 'bytes');
      try {
        await ffmpeg.writeFile(inputFileName, inputData);
      } catch (err) {
        if (this.cancelRequested) throw new CancelledError();
        console.error('[FFmpeg] Error writing to FS:', err);
        throw new Error('Could not write to FFmpeg FS');
      }
      throwIfCancelled();

      // Construct FFmpeg command array
      const args: string[] = ['-i', inputFileName];

      // Video codec and compression parameters (superfast provides much better size than ultrafast)
      args.push('-c:v', 'libx264', '-preset', 'superfast', '-crf', crf);

      // Resize if needed (split by space)
      if (scale) {
        args.push(...scale.split(' '));
      }

      // Audio re-encoding to save space
      args.push('-c:a', 'aac', '-b:a', audioBitrate);

      // Output
      args.push(outputFileName);

      console.log('[FFmpeg] Executing command:', args.join(' '));
      try {
        const retCode = await ffmpeg.exec(args);
        console.log('[FFmpeg] Exec returned code:', retCode);
      } catch (err) {
        // terminate() rejects every in-flight call, so a cancel arrives here
        // looking like a generic failure unless we name it.
        if (this.cancelRequested) throw new CancelledError();
        console.error('[FFmpeg] Error executing command:', err);
        throw new Error('FFmpeg execution failed');
      }
      throwIfCancelled();

      console.log('[FFmpeg] Reading output file...');
      let data: any;
      try {
        data = await ffmpeg.readFile(outputFileName);
      } catch (err) {
        if (this.cancelRequested) throw new CancelledError();
        console.error('[FFmpeg] Error reading output file:', err);
        throw new Error('Could not read FFmpeg output');
      }

      // Free memory
      await ffmpeg.deleteFile(inputFileName);
      await ffmpeg.deleteFile(outputFileName);

      console.log('[FFmpeg] Creating Blob URL from output...', data.byteLength, 'bytes');
      // Create a blob URL for the resulting file
      const blob = new Blob([data as any], { type: 'video/mp4' });
      const destPath = URL.createObjectURL(blob);

      console.log('[FFmpeg] Compression complete, returning path:', destPath);
      return {
        success: true,
        destPath: destPath,
      };
    } catch (error: any) {
      if (error?.code === CANCELLED) {
        console.log('[FFmpeg] Compression cancelled');
      } else {
        console.error('[FFmpeg] Compression process failed:', error);
      }
      throw error;
    } finally {
      this.currentJobId = null;
      this.cancelRequested = false;
    }
  }
}
