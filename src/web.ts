import { WebPlugin } from '@capacitor/core';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

import type { NativeVideoCompressorPlugin, CompressOptions, CompressResult } from './definitions';

export class NativeVideoCompressorWeb extends WebPlugin implements NativeVideoCompressorPlugin {
  private ffmpeg: FFmpeg | null = null;
  private isLoaded = false;

  private async loadFFmpeg() {
    if (this.isLoaded && this.ffmpeg) return;

    this.notifyListeners('onProgress', { status: 'loading_core', percent: 0 });

    try {
      this.ffmpeg = new FFmpeg();

      // Listen to FFmpeg progress and map it to capacitor plugin events
      this.ffmpeg.on('progress', ({ progress }) => {
        // progress is a fraction between 0 and 1
        this.notifyListeners('onProgress', { status: 'progress', percent: Math.round(progress * 100) });
      });

      this.ffmpeg.on('log', ({ message }) => {
        console.log('[FFmpeg Log]', message);
      });

      // Use standard single-threaded version for best compatibility across browsers
      // without requiring complex SharedArrayBuffer headers configuration
      const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';

      console.log('Starting to load FFmpeg core from:', baseURL);
      await this.ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
      });

      this.isLoaded = true;
      console.log('FFmpeg core loaded successfully');
    } catch (e: any) {
      console.error('Failed to load FFmpeg:', e);
      throw e;
    }
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
    try {
      if (!this.isLoaded) {
        await this.loadFFmpeg();
      }

      if (!this.ffmpeg) {
        throw new Error('FFmpeg failed to load');
      }

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

      console.log('[FFmpeg] Writing file to FS...', inputData.byteLength, 'bytes');
      try {
        await this.ffmpeg.writeFile(inputFileName, inputData);
      } catch (err) {
        console.error('[FFmpeg] Error writing to FS:', err);
        throw new Error('Could not write to FFmpeg FS');
      }

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
        const retCode = await this.ffmpeg.exec(args);
        console.log('[FFmpeg] Exec returned code:', retCode);
      } catch (err) {
        console.error('[FFmpeg] Error executing command:', err);
        throw new Error('FFmpeg execution failed');
      }

      console.log('[FFmpeg] Reading output file...');
      let data: any;
      try {
        data = await this.ffmpeg.readFile(outputFileName);
      } catch (err) {
        console.error('[FFmpeg] Error reading output file:', err);
        throw new Error('Could not read FFmpeg output');
      }

      // Free memory
      await this.ffmpeg.deleteFile(inputFileName);
      await this.ffmpeg.deleteFile(outputFileName);

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
      console.error('[FFmpeg] Compression process failed:', error);
      throw error;
    }
  }
}
