import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ instances: [] as any[] }));

vi.mock('@ffmpeg/ffmpeg', () => ({
  FFmpeg: class {
    handlers: Record<string, (e: unknown) => void> = {};
    finishLoad!: () => void;
    terminate = vi.fn();
    constructor() {
      m.instances.push(this);
    }
    on(event: string, cb: (e: unknown) => void) {
      this.handlers[event] = cb;
    }
    load() {
      return new Promise<void>((r) => (this.finishLoad = r));
    }
    writeFile = vi.fn(async () => undefined);
    exec = vi.fn(async () => 0);
    readFile = vi.fn(async () => new Uint8Array([1]));
    deleteFile = vi.fn(async () => undefined);
  },
}));
vi.mock('@ffmpeg/util', () => ({ toBlobURL: async (url: string) => url }));
vi.mock('mediabunny', () => ({ canEncodeVideo: async () => false }));

import { MAX_FFMPEG_INPUT_BYTES, TOO_LARGE_FOR_WEB } from './definitions';
import { NativeVideoCompressorWeb } from './web';

const start = async (plugin: NativeVideoCompressorWeb, jobId: string) => {
  const before = m.instances.length;
  const run = plugin.compressVideo({ sourcePath: `blob:${jobId}`, jobId });
  run.catch(() => undefined);
  await vi.waitFor(() => expect(m.instances.length).toBe(before + 1));
  return { run, ffmpeg: m.instances[before] };
};

beforeEach(() => {
  m.instances.splice(0);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ blob: async () => new Blob(['v']) })),
  );
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:out' }));
});

describe('NativeVideoCompressorWeb: job bỏ dở rồi job mới chạy', () => {
  it('job cũ load xong muộn: tự huỷ, không chiếm ffmpeg, không bắn tiến độ; job mới vẫn huỷ được', async () => {
    const plugin = new NativeVideoCompressorWeb();
    const progress = vi.fn();
    await plugin.addListener('onProgress', progress);

    const stale = await start(plugin, 'A');
    await plugin.cancel({ jobId: 'A' });
    const live = await start(plugin, 'B');

    stale.ffmpeg.finishLoad();
    await expect(stale.run).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(stale.ffmpeg.terminate).toHaveBeenCalled();
    expect(stale.ffmpeg.exec).not.toHaveBeenCalled();
    progress.mockClear();
    stale.ffmpeg.handlers.progress?.({ progress: 0.5 });
    expect(progress).not.toHaveBeenCalled();

    expect(await plugin.cancel({ jobId: 'B' })).toEqual({ cancelled: true });
    live.ffmpeg.finishLoad();
    await expect(live.run).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('job mới vẫn nén xong bình thường sau job cũ bị bỏ', async () => {
    const plugin = new NativeVideoCompressorWeb();
    const stale = await start(plugin, 'A');
    await plugin.cancel({ jobId: 'A' });
    const live = await start(plugin, 'B');

    stale.ffmpeg.finishLoad();
    await expect(stale.run).rejects.toMatchObject({ code: 'CANCELLED' });
    live.ffmpeg.finishLoad();

    await expect(live.run).resolves.toEqual({ success: true, destPath: 'blob:out' });
    expect(live.ffmpeg.exec).toHaveBeenCalledTimes(1);
  });

  it('WebCodecs không dùng được và file lớn hơn trần ffmpeg: từ chối TOO_LARGE_FOR_WEB, không nạp ffmpeg', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ blob: async () => ({ size: MAX_FFMPEG_INPUT_BYTES + 1 }) })),
    );
    const plugin = new NativeVideoCompressorWeb();
    await expect(plugin.compressVideo({ sourcePath: 'blob:big', jobId: 'big' })).rejects.toMatchObject({
      code: TOO_LARGE_FOR_WEB,
    });
    expect(m.instances).toHaveLength(0);
  });
});
