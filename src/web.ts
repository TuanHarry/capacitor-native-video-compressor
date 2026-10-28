import { WebPlugin } from '@capacitor/core';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  ConversionCanceledError,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  canEncodeVideo,
} from 'mediabunny';

import type {
  NativeVideoCompressorPlugin,
  CompressOptions,
  CompressResult,
  CancelOptions,
  CancelResult,
} from './definitions';
import { CANCELLED } from './definitions';

type VideoQuality = NonNullable<CompressOptions['quality']>;

/**
 * Rejection shape for a cancelled compress. `code` matches what `call.reject`
 * puts on the error object on iOS/Android, so one `error.code === 'CANCELLED'`
 * check works on every platform — and on both web engines below.
 */
class CancelledError extends Error {
  code = CANCELLED;
  constructor() {
    super('Đã hủy nén');
    this.name = 'CancelledError';
  }
}

/**
 * WebCodecs target per quality tier: cap height + a bitrate ceiling. The
 * quantizer (constant 26, CRF-like) drives quality where the encoder honours
 * it; H.264 on most browsers is bitrate-driven, so `bitrate` is the real knob.
 * fps is capped to 30 at call time (never upsampled). Audio is left to
 * mediabunny, which re-encodes to AAC for the MP4 container.
 */
const WEBCODECS_LADDER: Record<VideoQuality, { height: number; bitrate: number }> = {
  VERY_HIGH: { height: 1080, bitrate: 4000000 },
  HIGH: { height: 720, bitrate: 2000000 },
  MEDIUM: { height: 540, bitrate: 1200000 },
  LOW: { height: 480, bitrate: 1000000 },
  '360P': { height: 360, bitrate: 700000 },
  VERY_LOW: { height: 240, bitrate: 350000 },
};

const WEBCODECS_QUANTIZER = 26;
const FPS_CAP = 30;

const CORE_BASE_URL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';

/**
 * Cancelling means terminating the worker, which drops the loaded core with
 * it — so without this the next compress re-downloads ~30 MB of wasm and
 * "cancel" quietly costs more than it saves. Module scope, not instance: the
 * bytes are identical for every instance and every job. Only the ffmpeg
 * fallback ever pays this download; the WebCodecs primary path needs no core.
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
  /** The mediabunny conversion running now, so `cancel()` can abort it. */
  private activeConversion: Conversion | null = null;
  /** The job `compressVideo` is running right now, for `cancel({ jobId })`. */
  private currentJobId: string | null = null;
  private cancelRequested = false;

  async initialize(): Promise<{ success: boolean; message?: string }> {
    // WebCodecs (the primary path) needs no core download, so there is nothing
    // to warm. Eagerly loading the ffmpeg core here would pull ~30 MB for a
    // path most compresses never take. The fallback lazy-loads its core on
    // first use. Kept as a resolving no-op so callers that await it still pass.
    return { success: true, message: 'ready' };
  }

  async compressVideo(options: CompressOptions): Promise<CompressResult> {
    this.currentJobId = options.jobId ?? 'default';
    this.cancelRequested = false;

    // Checked at every stage boundary, not just around the encode: cancelling
    // an engine only reaches work already handed to it, so a cancel during the
    // source fetch or before init has nothing to interrupt and would otherwise
    // let the compress carry on as if nothing had happened.
    const throwIfCancelled = () => {
      if (this.cancelRequested) throw new CancelledError();
    };

    try {
      throwIfCancelled();

      const blob = await this.fetchSourceBlob(options.sourcePath);
      throwIfCancelled();

      const quality: VideoQuality = options.quality ?? 'MEDIUM';

      if (await this.canUseWebCodecs(quality)) {
        try {
          const result = await this.compressWithWebCodecs(blob, quality, throwIfCancelled);
          if (result) return result;
          // null → conversion invalid / tracks discarded → fall back to ffmpeg.
        } catch (e: any) {
          if (e?.code === CANCELLED) throw e; // user cancel: never fall back
          console.warn('[compress] WebCodecs failed, falling back to ffmpeg:', e);
          throwIfCancelled();
        }
      }

      return await this.compressWithFfmpeg(blob, quality, throwIfCancelled);
    } catch (error: any) {
      if (error?.code === CANCELLED) {
        console.log('[compress] cancelled');
      } else {
        console.error('[compress] failed:', error);
      }
      throw error;
    } finally {
      this.currentJobId = null;
      this.cancelRequested = false;
      this.activeConversion = null;
    }
  }

  /**
   * Kill whichever engine is mid-compress. Only one is ever active at a time,
   * so acting on both is safe.
   *
   * WebCodecs: `conversion.cancel()` makes the in-flight `execute()` reject
   * with `ConversionCanceledError`, surfaced as a `CancelledError` below.
   * ffmpeg: `exec()` runs synchronously inside the worker and never reaches a
   * message poll while encoding, so `worker.terminate()` is the only way to
   * stop it — its cost is the loaded core, which is why the core URLs are
   * cached above.
   */
  async cancel(options?: CancelOptions): Promise<CancelResult> {
    if (!this.currentJobId) return { cancelled: false };
    if (options?.jobId && options.jobId !== this.currentJobId) return { cancelled: false };

    // Set even when neither engine exists yet: the job may still be fetching
    // the source or inside loadFFmpeg, which read this flag at their boundaries.
    this.cancelRequested = true;

    const conversion = this.activeConversion;
    this.activeConversion = null;
    // Fire-and-forget: the CancelledError surfaces from the execute() rejection,
    // not from here; awaiting would only make cancel() slower.
    conversion?.cancel().catch(() => undefined);

    this.ffmpeg?.terminate();
    this.ffmpeg = null;
    this.isLoaded = false;

    return { cancelled: true };
  }

  private async fetchSourceBlob(sourcePath: string): Promise<Blob> {
    try {
      const response = await fetch(sourcePath);
      return await response.blob();
    } catch (err) {
      console.error('[compress] Error fetching source file:', err);
      throw new Error('Could not fetch source video file');
    }
  }

  private async canUseWebCodecs(quality: VideoQuality): Promise<boolean> {
    try {
      const { bitrate } = WEBCODECS_LADDER[quality];
      return await canEncodeVideo('avc', {
        quality: new Quality({ quantizer: WEBCODECS_QUANTIZER, bitrate }),
      });
    } catch {
      return false;
    }
  }

  private async compressWithWebCodecs(
    blob: Blob,
    quality: VideoQuality,
    throwIfCancelled: () => void,
  ): Promise<CompressResult | null> {
    const { height, bitrate } = WEBCODECS_LADDER[quality];

    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
    const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });

    // Cap fps at 30, but never upsample: probe the source and take the min.
    // A failed probe just omits frameRate, leaving the source rate untouched.
    let frameRate: number | undefined;
    try {
      const track = await input.getPrimaryVideoTrack();
      if (track) {
        const stats = await track.computePacketStats(100);
        if (stats.averagePacketRate > 0) {
          frameRate = Math.min(FPS_CAP, Math.round(stats.averagePacketRate));
        }
      }
    } catch {
      frameRate = undefined;
    }

    throwIfCancelled();

    const conversion = await Conversion.init({
      input,
      output,
      video: {
        height,
        quality: new Quality({ quantizer: WEBCODECS_QUANTIZER, bitrate }),
        hardwareAcceleration: 'prefer-hardware',
        ...(frameRate ? { frameRate } : {}),
      },
    });

    if (!conversion.isValid) {
      console.warn(
        '[compress] WebCodecs conversion invalid:',
        conversion.discardedTracks.map((t) => t.reason),
      );
      return null;
    }

    this.activeConversion = conversion;

    this.notifyListeners('onProgress', { status: 'started', percent: 0 });
    conversion.onProgress = (progress) => {
      this.notifyListeners('onProgress', { status: 'progress', percent: Math.round(progress * 100) });
    };

    throwIfCancelled();
    try {
      await conversion.execute();
    } catch (e: any) {
      if (this.cancelRequested || e instanceof ConversionCanceledError) throw new CancelledError();
      throw e;
    }

    const buffer = output.target.buffer;
    if (!buffer) throw new Error('WebCodecs produced no output');

    const outBlob = new Blob([buffer], { type: 'video/mp4' });
    return { success: true, destPath: URL.createObjectURL(outBlob) };
  }

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

    instance.on('progress', ({ progress }) => {
      this.notifyListeners('onProgress', { status: 'progress', percent: Math.round(progress * 100) });
    });

    instance.on('log', ({ message }) => {
      console.log('[FFmpeg Log]', message);
    });

    try {
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
  }

  private async compressWithFfmpeg(
    blob: Blob,
    quality: VideoQuality,
    throwIfCancelled: () => void,
  ): Promise<CompressResult> {
    if (!this.isLoaded) {
      await this.loadFFmpeg();
    }
    throwIfCancelled();

    if (!this.ffmpeg) {
      throw new Error('FFmpeg failed to load');
    }
    // Bound once. `this.ffmpeg` is nulled by cancel(), so reading it after any
    // of the awaits below can hand back null on a reference the compiler
    // narrowed here — surfacing a cancel as a TypeError, not a CancelledError.
    const ffmpeg = this.ffmpeg;

    this.notifyListeners('onProgress', { status: 'started', percent: 0 });

    const inputFileName = 'input.mp4';
    const outputFileName = 'output.mp4';

    let crf = '28';
    let scale = '';
    let audioBitrate = '128k';

    switch (quality) {
      case 'VERY_HIGH':
        crf = '23';
        scale = '-vf scale=-2:1080';
        audioBitrate = '128k';
        break;
      case 'HIGH':
        crf = '28';
        scale = '-vf scale=-2:720';
        audioBitrate = '128k';
        break;
      case 'MEDIUM':
        crf = '30';
        scale = '-vf scale=-2:540';
        audioBitrate = '96k';
        break;
      case 'LOW':
        crf = '32';
        scale = '-vf scale=-2:480';
        audioBitrate = '96k';
        break;
      case '360P':
        crf = '28';
        scale = '-vf scale=-2:360';
        audioBitrate = '64k';
        break;
      case 'VERY_LOW':
        crf = '35';
        scale = '-vf scale=-2:240';
        audioBitrate = '48k';
        break;
    }

    const inputData = new Uint8Array(await blob.arrayBuffer());

    try {
      await ffmpeg.writeFile(inputFileName, inputData);
    } catch (err) {
      if (this.cancelRequested) throw new CancelledError();
      console.error('[FFmpeg] Error writing to FS:', err);
      throw new Error('Could not write to FFmpeg FS');
    }
    throwIfCancelled();

    const args: string[] = ['-i', inputFileName];
    args.push('-c:v', 'libx264', '-preset', 'superfast', '-crf', crf);
    if (scale) {
      args.push(...scale.split(' '));
    }
    args.push('-c:a', 'aac', '-b:a', audioBitrate);
    args.push(outputFileName);

    try {
      await ffmpeg.exec(args);
    } catch (err) {
      // terminate() rejects every in-flight call, so a cancel arrives here
      // looking like a generic failure unless we name it.
      if (this.cancelRequested) throw new CancelledError();
      console.error('[FFmpeg] Error executing command:', err);
      throw new Error('FFmpeg execution failed');
    }
    throwIfCancelled();

    let data: any;
    try {
      data = await ffmpeg.readFile(outputFileName);
    } catch (err) {
      if (this.cancelRequested) throw new CancelledError();
      console.error('[FFmpeg] Error reading output file:', err);
      throw new Error('Could not read FFmpeg output');
    }

    await ffmpeg.deleteFile(inputFileName);
    await ffmpeg.deleteFile(outputFileName);

    const outBlob = new Blob([data as any], { type: 'video/mp4' });
    return { success: true, destPath: URL.createObjectURL(outBlob) };
  }
}
