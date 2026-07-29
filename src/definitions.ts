import type { PluginListenerHandle } from '@capacitor/core';

/**
 * `code` on the error `compressVideo` rejects with when `cancel()` stopped it.
 * Callers should treat it as "the user asked for this" — no error toast, no
 * retry prompt — and tell it apart from a genuine compression failure.
 */
export const CANCELLED = 'CANCELLED';

export interface CompressOptions {
  sourcePath: string;
  destPath?: string;
  quality?: 'VERY_HIGH' | 'HIGH' | 'MEDIUM' | 'LOW' | 'VERY_LOW' | '360P';
  /**
   * Names this compress so `cancel({ jobId })` can target it.
   *
   * Every platform compresses one video at a time, so cancellation is global
   * by nature. Two independent callers in the same app (say a comment queue
   * and a notes queue) therefore need a way to say *which* job they mean —
   * without one, a cancel from either kills whatever the other is running.
   */
  jobId?: string;
}

export interface CompressResult {
  success: boolean;
  destPath: string;
}

export interface CancelOptions {
  /**
   * Only cancel if this is the job currently running. Omit to cancel whatever
   * is running, whoever started it.
   */
  jobId?: string;
}

export interface CancelResult {
  /** False when nothing was running, or when a different job was. */
  cancelled: boolean;
}

export interface NativeVideoCompressorPlugin {
  compressVideo(options: CompressOptions): Promise<CompressResult>;

  /**
   * Stop the compress that is running now. `compressVideo` then rejects with
   * code {@link CANCELLED} and its partial output is deleted.
   *
   * This is the only way to stop one: the work is synchronous WASM inside a
   * web worker (web) or an AVFoundation / LightCompressor pass on its own
   * thread (native), and none of them watch an AbortSignal.
   */
  cancel(options?: CancelOptions): Promise<CancelResult>;

  initialize(): Promise<{ success: boolean; message?: string }>;

  // Đã sửa lại chuẩn cho Capacitor mới nhất (chỉ trả về Promise)
  addListener(
    eventName: 'onProgress',
    listenerFunc: (info: { status: string; percent?: number }) => void,
  ): Promise<PluginListenerHandle>;
}
