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
  StreamTarget,
  canEncodeVideo,
} from 'mediabunny';

import type {
  NativeVideoCompressorPlugin,
  CompressOptions,
  CompressResult,
  CancelOptions,
  CancelResult,
} from './definitions';
import { CANCELLED, STORAGE_FULL, TOO_LARGE_FOR_WEB } from './definitions';
import { createOpfsOutput } from './opfs-output';

type VideoQuality = NonNullable<CompressOptions['quality']>;

/**
 * Rejection shape for every coded failure. `code` matches what `call.reject`
 * puts on the error object on iOS/Android, so one `error.code === 'CANCELLED'`
 * check works on every platform and on both web engines below.
 */
class CompressError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CompressError';
  }
}

const cancelledError = () => new CompressError(CANCELLED, 'Đã hủy nén');

const isQuotaError = (e: unknown): boolean => {
  const { name, cause } = (e ?? {}) as { name?: unknown; cause?: unknown };
  return name === 'QuotaExceededError' || (!!cause && isQuotaError(cause));
};

/** ffmpeg.wasm copies the whole input into wasm memory (~2 GB ceiling). */
const MAX_FFMPEG_INPUT_BYTES = 200 * 1024 * 1024;

/**
 * Per quality tier. WebCodecs: cap height + a bitrate ceiling; the quantizer
 * (constant 26, CRF-like) drives quality where the encoder honours it, but
 * H.264 on most browsers is bitrate-driven, so `bitrate` is the real knob.
 * ffmpeg: same height, `crf` and `audioBitrate`. fps is capped to 30 at call
 * time (never upsampled). On WebCodecs audio is left to mediabunny, which
 * re-encodes to AAC for the MP4 container.
 */
const QUALITY_LADDER: Record<VideoQuality, { height: number; bitrate: number; crf: number; audioBitrate: string }> = {
  VERY_HIGH: { height: 1080, bitrate: 4000000, crf: 23, audioBitrate: '128k' },
  HIGH: { height: 720, bitrate: 2000000, crf: 28, audioBitrate: '128k' },
  MEDIUM: { height: 540, bitrate: 1200000, crf: 30, audioBitrate: '96k' },
  LOW: { height: 480, bitrate: 1000000, crf: 32, audioBitrate: '96k' },
  '360P': { height: 360, bitrate: 700000, crf: 28, audioBitrate: '64k' },
  VERY_LOW: { height: 240, bitrate: 350000, crf: 35, audioBitrate: '48k' },
};

const WEBCODECS_QUANTIZER = 26;
const FPS_CAP = 30;

// Cap fps at 30, but never upsample. A failed probe leaves the source rate untouched.
const probeFrameRate = async (input: Input): Promise<number | undefined> => {
  try {
    const stats = await (await input.getPrimaryVideoTrack())?.computePacketStats(100);
    return stats && stats.averagePacketRate > 0 ? Math.min(FPS_CAP, Math.round(stats.averagePacketRate)) : undefined;
  } catch {
    return undefined;
  }
};

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
  /** The job `compressVideo` is running right now; a fresh object per call, so two calls never look alike. */
  private currentJob: { id: string } | null = null;
  private cancelRequested = false;

  async initialize(): Promise<{ success: boolean; message?: string }> {
    // No-op: preloading the ~30 MB ffmpeg core would cost most compresses a download they never use.
    return { success: true, message: 'ready' };
  }

  async finishUpload(): Promise<{ released: boolean }> {
    // Nothing holds a process alive on the web — the tab either lives or the
    // whole compress is gone with it. Resolving no-op so the one call site
    // can fire unconditionally instead of branching on platform.
    return { released: false };
  }

  async compressVideo(options: CompressOptions): Promise<CompressResult> {
    const job = { id: options.jobId ?? 'default' };
    this.currentJob = job;
    this.cancelRequested = false;
    // A job the caller gave up on (e.g. a stall timeout) runs on until its next
    // await returns. Once another job has started, the shared flags above speak
    // for that job, not this one, so a superseded job counts as cancelled.
    const isSuperseded = () => this.currentJob !== job;

    // Checked at every stage boundary, not just around the encode: cancelling
    // an engine only reaches work already handed to it, so a cancel during the
    // source fetch or before init has nothing to interrupt and would otherwise
    // let the compress carry on as if nothing had happened.
    const throwIfCancelled = () => {
      if (this.cancelRequested || isSuperseded()) throw cancelledError();
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
        } catch (e: any) {
          if (e?.code === CANCELLED) throw e; // user cancel: never fall back
          // Not to ffmpeg either: it needs even more room, and its size cap would misreport this as TOO_LARGE_FOR_WEB.
          if (isQuotaError(e)) throw new CompressError(STORAGE_FULL, 'Không đủ dung lượng lưu trữ để nén video');
          console.warn('[compress] WebCodecs failed, falling back to ffmpeg:', e);
        }
      }

      throwIfCancelled();
      if (blob.size > MAX_FFMPEG_INPUT_BYTES)
        throw new CompressError(TOO_LARGE_FOR_WEB, 'Video quá lớn để nén trên trình duyệt này');
      return await this.compressWithFfmpeg(blob, quality, throwIfCancelled);
    } catch (error: any) {
      if (error?.code === CANCELLED) {
        console.log('[compress] cancelled');
      } else {
        console.error('[compress] failed:', error);
      }
      throw error;
    } finally {
      if (!isSuperseded()) {
        this.currentJob = null;
        this.cancelRequested = false;
        this.activeConversion = null;
      }
    }
  }

  /**
   * Kill whichever engine is mid-compress. Only one is ever active at a time,
   * so acting on both is safe.
   *
   * WebCodecs: `conversion.cancel()` makes the in-flight `execute()` reject
   * with `ConversionCanceledError`, surfaced as a CANCELLED `CompressError` below.
   * ffmpeg: `exec()` runs synchronously inside the worker and never reaches a
   * message poll while encoding, so `worker.terminate()` is the only way to
   * stop it — its cost is the loaded core, which is why the core URLs are
   * cached above.
   */
  async cancel(options?: CancelOptions): Promise<CancelResult> {
    if (!this.currentJob) return { cancelled: false };
    if (options?.jobId && options.jobId !== this.currentJob.id) return { cancelled: false };

    // Set even when neither engine exists yet: the job may still be fetching
    // the source or inside loadFFmpeg, which read this flag at their boundaries.
    this.cancelRequested = true;

    const conversion = this.activeConversion;
    this.activeConversion = null;
    // Fire-and-forget: the CANCELLED error surfaces from the execute() rejection,
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
      const { bitrate } = QUALITY_LADDER[quality];
      return await canEncodeVideo('avc', {
        hardwareAcceleration: 'no-preference',
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
    const opfs = await createOpfsOutput();
    console.log(`[compress] engine=webcodecs target=${opfs ? 'opfs' : 'buffer'}`);
    let output: Output | undefined;
    let kept = false;
    try {
      const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
      output = new Output({
        format: new Mp4OutputFormat(),
        target: opfs ? new StreamTarget(opfs.writable, { chunked: true }) : new BufferTarget(),
      });
      if (!(await this.runConversion(input, output, QUALITY_LADDER[quality], throwIfCancelled))) return null;
      let outBlob: Blob;
      if (opfs) {
        outBlob = await opfs.read();
      } else {
        const buffer = (output.target as BufferTarget).buffer;
        if (!buffer) throw new Error('WebCodecs produced no output');
        outBlob = new Blob([buffer], { type: 'video/mp4' });
      }
      kept = true;
      return { success: true, destPath: URL.createObjectURL(outBlob) };
    } finally {
      if (!kept) {
        // Closes the writable first, which otherwise keeps the entry locked against removal.
        await output?.cancel().catch(() => undefined);
        await opfs?.discard();
      }
    }
  }

  /** False when mediabunny can't convert this input. */
  private async runConversion(
    input: Input,
    output: Output,
    { height, bitrate }: { height: number; bitrate: number },
    throwIfCancelled: () => void,
  ): Promise<boolean> {
    const frameRate = await probeFrameRate(input);
    throwIfCancelled();

    const conversion = await Conversion.init({
      input,
      output,
      video: {
        height,
        quality: new Quality({ quantizer: WEBCODECS_QUANTIZER, bitrate }),
        // Not 'prefer-hardware': machines without a hardware H.264 encoder
        // (Linux, VMs, headless) then fail mid-encode and drop to ffmpeg.wasm.
        // The browser still picks the hardware encoder when it has one, and the
        // canEncodeVideo probe asks the same question, so probe and encode agree.
        hardwareAcceleration: 'no-preference',
        ...(frameRate ? { frameRate } : {}),
      },
      // The default copies the input's raw udta metadata tags, GPS location included.
      tags: {},
    });

    if (!conversion.isValid) {
      console.warn(
        '[compress] WebCodecs conversion invalid:',
        conversion.discardedTracks.map((t) => t.reason),
      );
      return false;
    }

    throwIfCancelled();
    this.activeConversion = conversion;

    this.notifyListeners('onProgress', { status: 'started', percent: 0 });
    conversion.onProgress = (progress) => {
      if (this.activeConversion === conversion)
        this.notifyListeners('onProgress', { status: 'progress', percent: Math.round(progress * 100) });
    };

    try {
      await conversion.execute();
    } catch (e: any) {
      if (this.cancelRequested || e instanceof ConversionCanceledError) throw cancelledError();
      throw e;
    }
    throwIfCancelled();
    return true;
  }

  private async loadFFmpeg(throwIfCancelled: () => void) {
    if (this.isLoaded && this.ffmpeg) return;
    throwIfCancelled();

    this.notifyListeners('onProgress', { status: 'loading_core', percent: 0 });

    // Published only once loaded and still wanted, so a cancel mid-load can't leave `isLoaded` set on a dropped instance.
    const instance = new FFmpeg();

    instance.on('progress', ({ progress }) => {
      // Once published the instance serves every later job; before that, or
      // after cancel() dropped it, its events belong to no job.
      if (this.ffmpeg === instance)
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
    try {
      throwIfCancelled();
    } catch (e) {
      instance.terminate();
      throw e;
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
      await this.loadFFmpeg(throwIfCancelled);
    }
    throwIfCancelled();

    if (!this.ffmpeg) {
      throw new Error('FFmpeg failed to load');
    }
    // Bound once. `this.ffmpeg` is nulled by cancel(), so reading it after any
    // of the awaits below can hand back null on a reference the compiler
    // narrowed here — surfacing a cancel as a TypeError, not a CANCELLED error.
    const ffmpeg = this.ffmpeg;

    console.log('[compress] engine=ffmpeg');
    this.notifyListeners('onProgress', { status: 'started', percent: 0 });

    const inputFileName = 'input.mp4';
    const outputFileName = 'output.mp4';

    const { height, crf, audioBitrate } = QUALITY_LADDER[quality];

    const inputData = new Uint8Array(await blob.arrayBuffer());

    try {
      await ffmpeg.writeFile(inputFileName, inputData);
    } catch (err) {
      throwIfCancelled();
      console.error('[FFmpeg] Error writing to FS:', err);
      throw new Error('Could not write to FFmpeg FS');
    }
    throwIfCancelled();

    // ffmpeg copies global metadata by default, including the GPS location (©xyz / loci).
    // prettier-ignore
    const args = [
      '-i', inputFileName, '-map_metadata', '-1',
      '-c:v', 'libx264', '-preset', 'superfast', '-crf', String(crf),
      '-vf', `scale=-2:${height}`,
      '-c:a', 'aac', '-b:a', audioBitrate,
      outputFileName,
    ];

    try {
      await ffmpeg.exec(args);
    } catch (err) {
      // terminate() rejects every in-flight call, so a cancel arrives here
      // looking like a generic failure unless we name it.
      throwIfCancelled();
      console.error('[FFmpeg] Error executing command:', err);
      throw new Error('FFmpeg execution failed');
    }
    throwIfCancelled();

    let data: any;
    try {
      data = await ffmpeg.readFile(outputFileName);
    } catch (err) {
      throwIfCancelled();
      console.error('[FFmpeg] Error reading output file:', err);
      throw new Error('Could not read FFmpeg output');
    }

    await ffmpeg.deleteFile(inputFileName);
    await ffmpeg.deleteFile(outputFileName);

    const outBlob = new Blob([data as any], { type: 'video/mp4' });
    return { success: true, destPath: URL.createObjectURL(outBlob) };
  }
}
