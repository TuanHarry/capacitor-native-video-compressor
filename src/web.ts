import { WebPlugin } from '@capacitor/core';
import type { NativeVideoCompressorPlugin, CompressOptions, CompressResult } from './definitions';

export class NativeVideoCompressorWeb extends WebPlugin implements NativeVideoCompressorPlugin {
  async compressVideo(options: CompressOptions): Promise<CompressResult> {
    console.warn('Tính năng nén video bằng GPU không hỗ trợ trên trình duyệt Web.', options);

    // Báo lỗi cho chuẩn Capacitor báo rằng nền tảng này không được hỗ trợ
    throw this.unimplemented('Not implemented on web.');

    // (Hoặc nếu bạn không muốn văng lỗi trên web, bạn có thể trả về luôn đường dẫn gốc)
    // return {
    //   success: false,
    //   destPath: options.sourcePath
    // };
  }
}
