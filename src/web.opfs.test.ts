import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mb = vi.hoisted(() => ({
  outputs: [] as any[],
  log: [] as string[],
  conversion: null as any,
}));

vi.mock('@ffmpeg/ffmpeg', () => ({
  FFmpeg: class {
    on() {}
    load = async () => undefined;
    terminate() {}
    writeFile = async () => undefined;
    exec = async () => {
      mb.log.push('ffmpeg');
      return 0;
    };
    readFile = async () => new Uint8Array([1]);
    deleteFile = async () => undefined;
  },
}));
vi.mock('@ffmpeg/util', () => ({ toBlobURL: async (url: string) => url }));
vi.mock('mediabunny', () => ({
  ALL_FORMATS: [],
  BlobSource: class {},
  Mp4OutputFormat: class {},
  Quality: class {},
  ConversionCanceledError: class extends Error {},
  canEncodeVideo: async () => true,
  BufferTarget: class {
    buffer = new ArrayBuffer(1);
  },
  // Like the real one, takes over the writable: only the Output can close it from here on.
  StreamTarget: class {
    constructor(public writable: any) {
      writable.lockedByTarget = true;
    }
  },
  Input: class {
    async getPrimaryVideoTrack() {
      return null;
    }
  },
  Output: class {
    target: any;
    constructor(o: { target: unknown }) {
      this.target = o.target;
      mb.outputs.push(this);
    }
    async cancel() {
      if (this.target.writable) this.target.writable.open = false;
    }
  },
  Conversion: { init: vi.fn(async () => mb.conversion) },
}));

import { BufferTarget, Conversion, StreamTarget } from 'mediabunny';

import { STORAGE_FULL } from './definitions';

const fakeDir = (onKeys?: () => void) => {
  const entries = new Map<string, any>();
  const dir = {
    entries,
    onKeys,
    removed: false,
    async getDirectoryHandle(name: string) {
      if (!entries.has(name)) entries.set(name, fakeDir());
      return entries.get(name);
    },
    async getFileHandle(name: string) {
      if (dir.removed) throw new DOMException('gone', 'NotFoundError');
      const writable = {
        open: true,
        lockedByTarget: false,
        async abort() {
          if (writable.lockedByTarget) throw new TypeError('locked');
          writable.open = false;
        },
      };
      const file = { writable, createWritable: async () => writable, getFile: async () => new File(['out'], name) };
      entries.set(name, file);
      return file;
    },
    async removeEntry(name: string) {
      if (entries.get(name)?.writable?.open) throw new DOMException('open', 'NoModificationAllowedError');
      entries.delete(name);
    },
    async *keys() {
      dir.onKeys?.();
      yield* [...entries.keys()];
    },
  };
  return dir;
};

let base: ReturnType<typeof fakeDir>;
let held: string[];
let lockRequest: (name: string, cb: () => Promise<never>) => Promise<unknown>;

const compress = async () => {
  const { NativeVideoCompressorWeb } = await import('./web');
  return new NativeVideoCompressorWeb().compressVideo({ sourcePath: 'blob:src', jobId: 'j' });
};

const onlyTabDir = () => {
  expect(base.entries.size).toBe(1);
  return [...base.entries.values()][0] as ReturnType<typeof fakeDir>;
};

beforeEach(() => {
  vi.resetModules();
  mb.outputs.splice(0);
  mb.log.splice(0);
  mb.conversion = { isValid: true, discardedTracks: [], execute: async () => undefined };
  base = fakeDir();
  held = [];
  // Like Web Locks: requesting an exclusive lock that is already held waits for its release.
  lockRequest = (name, cb) => {
    if (held.includes(name)) return new Promise(() => undefined);
    held.push(name);
    return cb();
  };
  const root = { getDirectoryHandle: async () => base };
  vi.stubGlobal('navigator', {
    storage: { getDirectory: async () => root },
    locks: {
      request: (name: string, cb: () => Promise<never>) => lockRequest(name, cb),
      query: async () => ({ held: held.map((name) => ({ name })) }),
    },
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({ blob: async () => new Blob(['v']) })));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:out');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('NativeVideoCompressorWeb OPFS output', () => {
  it('writes to OPFS and keeps the output', async () => {
    await expect(compress()).resolves.toEqual({ success: true, destPath: 'blob:out' });
    expect(mb.outputs[0].target).toBeInstanceOf(StreamTarget);
    expect(onlyTabDir().entries.size).toBe(1);
  });

  it('hands back an mp4-typed Blob', async () => {
    await compress();
    expect(vi.mocked(URL.createObjectURL).mock.calls[0][0]).toMatchObject({ type: 'video/mp4' });
  });

  it('writes no metadata tags from the input', async () => {
    await compress();
    expect(Conversion.init).toHaveBeenCalledWith(expect.objectContaining({ tags: {} }));
  });

  it('sweep never deletes a tab that takes its lock and directory while the sweep is listing', async () => {
    base.onKeys = () => {
      held.push('native-video-compressor:other');
      base.entries.set('other', fakeDir());
    };
    await compress();
    expect(base.entries.has('other')).toBe(true);
  });

  it('sweep deletes directories of closed tabs', async () => {
    base.entries.set('closed', fakeDir());
    await compress();
    expect(base.entries.has('closed')).toBe(false);
  });

  it('a rejected lock request falls back to an in-memory buffer instead of hanging', async () => {
    lockRequest = () => Promise.reject(new Error('SecurityError'));
    await expect(compress()).resolves.toEqual({ success: true, destPath: 'blob:out' });
    expect(mb.outputs[0].target).toBeInstanceOf(BufferTarget);
  });

  it('goes back to OPFS after site data is cleared, without re-requesting the lock it holds', async () => {
    await compress();
    onlyTabDir().removed = true;
    base.entries.clear();
    // The stale directory handle fails once, so this one buffers in memory.
    await expect(compress()).resolves.toEqual({ success: true, destPath: 'blob:out' });
    await expect(compress()).resolves.toEqual({ success: true, destPath: 'blob:out' });
    expect(mb.outputs[2].target).toBeInstanceOf(StreamTarget);
    expect(onlyTabDir().entries.size).toBe(1);
  }, 2000);

  it('an invalid conversion deletes its file and falls back to ffmpeg', async () => {
    mb.conversion = { isValid: false, discardedTracks: [] };
    await compress();
    expect(onlyTabDir().entries.size).toBe(0);
    expect(mb.log).toContain('ffmpeg');
  });

  it('running out of storage mid-write rejects STORAGE_FULL, without falling back to ffmpeg', async () => {
    mb.conversion.execute = async () => {
      throw new DOMException('quota', 'QuotaExceededError');
    };
    await expect(compress()).rejects.toMatchObject({ code: STORAGE_FULL });
    expect(mb.log).not.toContain('ffmpeg');
    expect(onlyTabDir().entries.size).toBe(0);
  });
});
