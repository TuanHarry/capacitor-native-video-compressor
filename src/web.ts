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
import { CANCELLED, MAX_FFMPEG_INPUT_BYTES, STORAGE_FULL, TOO_LARGE_FOR_WEB } from './definitions';

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

class TooLargeForWebError extends Error {
  code = TOO_LARGE_FOR_WEB;
  constructor() {
    super('Video quá lớn để nén trên trình duyệt này');
    this.name = 'TooLargeForWebError';
  }
}

class StorageFullError extends Error {
  code = STORAGE_FULL;
  constructor() {
    super('Không đủ dung lượng lưu trữ để nén video');
    this.name = 'StorageFullError';
  }
}

const isQuotaError = (e: any): boolean =>
  e?.name === 'QuotaExceededError' || (!!e?.cause && isQuotaError(e.cause));

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

/**
 * WebCodecs output goes to the origin private file system so a long video
 * never sits whole in memory. The File handed back stays readable only while
 * its OPFS entry exists, and callers keep it well past `compressVideo` (until
 * the upload is done, or longer for a retry), so a successful output is never
 * deleted by this tab. Each tab writes under its own directory and holds a Web
 * Lock named after it for its whole life; every compress removes the
 * directories whose lock nobody holds any more, i.e. those of closed tabs.
 * A failed or cancelled job deletes its own file straight away.
 *
 * ponytail: outputs live until the tab closes. Upgrade path: an explicit
 * release call from the caller once it no longer needs the File.
 */
const OPFS_ROOT = 'native-video-compressor';
const TAB_ID = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Date.now());
const lockName = (tabId: string) => `${OPFS_ROOT}:${tabId}`;
let tabDirsPromise: Promise<{ base: FileSystemDirectoryHandle; dir: FileSystemDirectoryHandle }> | null = null;

// A rejected request (e.g. a sandboxed iframe) rejects here, so openTabDirs
// fails and the caller buffers in memory instead of waiting forever.
const holdTabLock = () =>
  new Promise<void>((granted, rejected) => {
    navigator.locks
      .request(lockName(TAB_ID), () => {
        granted();
        return new Promise<never>(() => undefined);
      })
      .catch(rejected);
  });

const sweepClosedTabs = async (base: FileSystemDirectoryHandle) => {
  // Names first, locks second: a tab that creates its directory between the two
  // reads already holds its lock, so it is never mistaken for a closed one.
  const names: string[] = [];
  const keys: AsyncIterator<string> = (base as any).keys();
  for (let next = await keys.next(); !next.done; next = await keys.next()) names.push(next.value);
  const { held = [] } = await navigator.locks.query();
  const live = new Set(held.map((l) => l.name));
  for (const name of names) {
    if (!live.has(lockName(name))) await base.removeEntry(name, { recursive: true }).catch(() => undefined);
  }
};

const openTabDirs = async () => {
  const base = await (await navigator.storage.getDirectory()).getDirectoryHandle(OPFS_ROOT, { create: true });
  if (navigator.locks) await holdTabLock();
  return { base, dir: await base.getDirectoryHandle(TAB_ID, { create: true }) };
};

interface OpfsOutput {
  writable: FileSystemWritableFileStream;
  read: () => Promise<File>;
  discard: () => Promise<void>;
}

/** Null when OPFS or `createWritable` (missing on Safari's main thread) isn't there. */
const createOpfsOutput = async (): Promise<OpfsOutput | null> => {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
    const { base, dir } = await (tabDirsPromise ??= openTabDirs().catch((e) => {
      tabDirsPromise = null;
      throw e;
    }));
    // Without Web Locks another tab's live files can't be told apart: no sweep.
    if (navigator.locks) await sweepClosedTabs(base).catch(() => undefined);
    const name = `${crypto.randomUUID()}.mp4`;
    const handle = await dir.getFileHandle(name, { create: true }).catch((e) => {
      // The directory was removed under us (site data cleared): reopen it next time.
      if (e?.name === 'NotFoundError') tabDirsPromise = null;
      throw e;
    });
    if (typeof handle.createWritable !== 'function') {
      await dir.removeEntry(name).catch(() => undefined);
      return null;
    }
    const writable = await handle.createWritable();
    const discard = async () => {
      // Rejects harmlessly once mediabunny holds the writer; it closes it then.
      await writable.abort().catch(() => undefined);
      await dir.removeEntry(name).catch(() => undefined);
    };
    return { writable, read: () => handle.getFile(), discard };
  } catch (e) {
    console.warn('[compress] OPFS unavailable, buffering output in memory:', e);
    return null;
  }
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

  async finishUpload(): Promise<{ released: boolean }> {
    // Nothing holds a process alive on the web — the tab either lives or the
    // whole compress is gone with it. Resolving no-op so the one call site
    // can fire unconditionally instead of branching on platform.
    return { released: false };
  }

  async compressVideo(options: CompressOptions): Promise<CompressResult> {
    const jobId = options.jobId ?? 'default';
    this.currentJobId = jobId;
    this.cancelRequested = false;
    // A job the caller gave up on (e.g. a stall timeout) runs on until its next
    // await returns. Once another job has started, the shared flags above speak
    // for that job, not this one, so a superseded job counts as cancelled.
    const isSuperseded = () => this.currentJobId !== jobId;

    // Checked at every stage boundary, not just around the encode: cancelling
    // an engine only reaches work already handed to it, so a cancel during the
    // source fetch or before init has nothing to interrupt and would otherwise
    // let the compress carry on as if nothing had happened.
    const throwIfCancelled = () => {
      if (this.cancelRequested || isSuperseded()) throw new CancelledError();
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
          // ffmpeg.wasm would need even more room; and its size cap would misreport this as TOO_LARGE_FOR_WEB.
          if (isQuotaError(e)) throw new StorageFullError();
          console.warn('[compress] WebCodecs failed, falling back to ffmpeg:', e);
          throwIfCancelled();
        }
      }

      throwIfCancelled();
      if (blob.size > MAX_FFMPEG_INPUT_BYTES) throw new TooLargeForWebError();
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
        this.currentJobId = null;
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
    const { height, bitrate } = WEBCODECS_LADDER[quality];

    const opfs = await createOpfsOutput();
    console.log(`[compress] engine=webcodecs target=${opfs ? 'opfs' : 'buffer'}`);
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
    const output = new Output({
      format: new Mp4OutputFormat(),
      target: opfs ? new StreamTarget(opfs.writable, { chunked: true }) : new BufferTarget(),
    });

    // Closes the writable, which otherwise keeps the entry locked against removal.
    const abandon = async () => {
      await output.cancel().catch(() => undefined);
      await opfs?.discard();
    };
    try {
      if (!(await this.runConversion(input, output, height, bitrate, throwIfCancelled))) {
        await abandon();
        return null;
      }
      let outBlob: Blob;
      if (opfs) {
        // OPFS files carry no MIME type, and callers derive the extension from it.
        outBlob = (await opfs.read()).slice(0, undefined, 'video/mp4');
      } else {
        const buffer = (output.target as BufferTarget).buffer;
        if (!buffer) throw new Error('WebCodecs produced no output');
        outBlob = new Blob([buffer], { type: 'video/mp4' });
      }
      return { success: true, destPath: URL.createObjectURL(outBlob) };
    } catch (e) {
      await abandon();
      throw e;
    }
  }

  /** False when mediabunny can't convert this input. */
  private async runConversion(
    input: Input,
    output: Output,
    height: number,
    bitrate: number,
    throwIfCancelled: () => void,
  ): Promise<boolean> {
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
        // Not 'prefer-hardware': machines without a hardware H.264 encoder
        // (Linux, VMs, headless) then fail mid-encode and drop to ffmpeg.wasm.
        // The browser still picks the hardware encoder when it has one, and the
        // canEncodeVideo probe asks the same question, so probe and encode agree.
        hardwareAcceleration: 'no-preference',
        ...(frameRate ? { frameRate } : {}),
      },
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

    throwIfCancelled();
    try {
      await conversion.execute();
    } catch (e: any) {
      if (this.cancelRequested || e instanceof ConversionCanceledError) throw new CancelledError();
      throw e;
    }
    throwIfCancelled();
    return true;
  }

  private async loadFFmpeg(throwIfCancelled: () => void) {
    if (this.isLoaded && this.ffmpeg) return;
    throwIfCancelled();

    this.notifyListeners('onProgress', { status: 'loading_core', percent: 0 });

    // Built on a local, published to the field only once it is ready and still
    // wanted. Assigning `this.ffmpeg` up front and setting `isLoaded` after the
    // await left a window where a cancel could null the instance and the load,
    // finishing a moment later, would set `isLoaded = true` on nothing at all —
    // after which every compressVideo threw 'FFmpeg failed to load' for the
    // rest of the page's life.
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
    // narrowed here — surfacing a cancel as a TypeError, not a CancelledError.
    const ffmpeg = this.ffmpeg;

    console.log('[compress] engine=ffmpeg');
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
      throwIfCancelled();
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
