import type { PluginListenerHandle } from '@capacitor/core';

export interface CompressOptions {
  sourcePath: string;
  destPath?: string;
  quality?: 'VERY_HIGH' | 'HIGH' | 'MEDIUM' | 'LOW' | 'VERY_LOW';
}

export interface CompressResult {
  success: boolean;
  destPath: string;
}

export interface NativeVideoCompressorPlugin {
  compressVideo(options: CompressOptions): Promise<CompressResult>;

  // Đã sửa lại chuẩn cho Capacitor mới nhất (chỉ trả về Promise)
  addListener(
    eventName: 'onProgress',
    listenerFunc: (info: { status: string; percent?: number }) => void,
  ): Promise<PluginListenerHandle>;
}
