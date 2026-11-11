import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { TOO_LARGE_FOR_WEB } from './definitions';
import { NativeVideoCompressorWeb, capBitrate, codecHeadroom, ffmpegScaleFilter, webCodecsSize } from './web';

const start = async (plugin: NativeVideoCompressorWeb, jobId?: string) => {
  const before = m.instances.length;
  const run = plugin.compressVideo({ sourcePath: 'blob:src', jobId });
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
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:out');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('NativeVideoCompressorWeb: an abandoned job followed by a new one', () => {
  it('a stale job that finishes loading late cancels itself, takes no ffmpeg, emits no progress; the new job stays cancellable', async () => {
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

  it('the new job still compresses normally after the old one was abandoned', async () => {
    const plugin = new NativeVideoCompressorWeb();
    const stale = await start(plugin, 'A');
    await plugin.cancel({ jobId: 'A' });
    const live = await start(plugin, 'B');

    stale.ffmpeg.finishLoad();
    await expect(stale.run).rejects.toMatchObject({ code: 'CANCELLED' });
    live.ffmpeg.finishLoad();

    await expect(live.run).resolves.toEqual({ success: true, destPath: 'blob:out' });
    expect(live.ffmpeg.exec).toHaveBeenCalledTimes(1);
    expect(live.ffmpeg.exec.mock.calls[0][0].join(' ')).toContain('-map_metadata -1');
  });

  it('rejects TOO_LARGE_FOR_WEB without loading ffmpeg when WebCodecs is unavailable and the file exceeds 200 MB', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ blob: async () => ({ size: 200 * 1024 * 1024 + 1 }) })),
    );
    const plugin = new NativeVideoCompressorWeb();
    await expect(plugin.compressVideo({ sourcePath: 'blob:big', jobId: 'big' })).rejects.toMatchObject({
      code: TOO_LARGE_FOR_WEB,
    });
    expect(m.instances).toHaveLength(0);
  });

  it('two jobs without a jobId: the abandoned one neither runs on nor clears the new one', async () => {
    const plugin = new NativeVideoCompressorWeb();
    const stale = await start(plugin);
    await plugin.cancel();
    const live = await start(plugin);

    stale.ffmpeg.finishLoad();
    await expect(stale.run).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(stale.ffmpeg.exec).not.toHaveBeenCalled();

    expect(await plugin.cancel()).toEqual({ cancelled: true });
    live.ffmpeg.finishLoad();
    await expect(live.run).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

describe('short-side sizing', () => {
  it('WebCodecs caps the short display side and never upscales', () => {
    expect(webCodecsSize(1080, 1920, 540)).toEqual({ width: 540 });
    expect(webCodecsSize(1920, 1080, 540)).toEqual({ height: 540 });
    expect(webCodecsSize(1080, 1080, 540)).toEqual({ height: 540 });
    expect(webCodecsSize(360, 640, 540)).toEqual({ width: 360 });
  });

  it('ffmpeg scales the short side after autorotate', async () => {
    const plugin = new NativeVideoCompressorWeb();
    const { run, ffmpeg } = await start(plugin);
    ffmpeg.finishLoad();
    await run;
    const args: string[] = ffmpeg.exec.mock.calls[0][0];
    expect(args[args.indexOf('-vf') + 1]).toBe(ffmpegScaleFilter(540));
    expect(ffmpegScaleFilter(540)).toBe(
      "scale=w='if(gt(iw,ih),-2,min(540,trunc(iw/2)*2))':h='if(gt(iw,ih),min(540,trunc(ih/2)*2),-2)'",
    );
  });
});

describe('capBitrate', () => {
  it('never targets more than the source, keeps the floor, ignores a missing estimate', () => {
    expect(capBitrate(1_200_000, 800_000, 200_000)).toBe(800_000);
    expect(capBitrate(1_200_000, 5_000_000, 200_000)).toBe(1_200_000);
    expect(capBitrate(1_200_000, 1_000, 200_000)).toBe(200_000);
    expect(capBitrate(1_200_000, 0, 200_000)).toBe(1_200_000);
    expect(capBitrate(1_200_000, undefined, 200_000)).toBe(1_200_000);
    expect(capBitrate(1_200_000, 600_000, 200_000, 1.5)).toBe(900_000);
    expect(capBitrate(1_200_000, 1_000_000, 200_000, 1.5)).toBe(1_200_000);
  });

  it('gives sources in more efficient codecs headroom over H.264', () => {
    expect(codecHeadroom('hevc')).toBe(1.5);
    expect(codecHeadroom('av1')).toBe(1.5);
    expect(codecHeadroom('avc')).toBe(1);
    expect(codecHeadroom(undefined)).toBe(1);
  });
});
