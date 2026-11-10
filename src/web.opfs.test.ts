import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  StreamTarget: class {},
  Input: class {
    async getPrimaryVideoTrack() {
      return null;
    }
  },
  Output: class {
    target: unknown;
    constructor(o: { target: unknown }) {
      this.target = o.target;
      mb.outputs.push(this);
    }
    async cancel() {
      mb.log.push('cancel');
    }
  },
  Conversion: { init: async () => mb.conversion },
}));

import { BufferTarget, StreamTarget } from 'mediabunny';

import { STORAGE_FULL } from './definitions';

type Dir = ReturnType<typeof fakeDir>;
const fakeDir = (onKeys?: () => void) => {
  const entries = new Map<string, any>();
  return {
    entries,
    onKeys,
    async getDirectoryHandle(name: string) {
      if (!entries.has(name)) entries.set(name, fakeDir());
      return entries.get(name);
    },
    async getFileHandle(name: string) {
      const file = {
        createWritable: async () => ({
          abort: async () => {
            mb.log.push('abort');
          },
        }),
        getFile: async () => new Blob(['out']),
      };
      entries.set(name, file);
      return file;
    },
    async removeEntry(name: string) {
      mb.log.push(`remove ${name}`);
      entries.delete(name);
    },
    keys(this: Dir) {
      this.onKeys?.();
      const names = [...entries.keys()];
      let i = 0;
      return {
        next: async () => (i < names.length ? { done: false, value: names[i++] } : { done: true, value: undefined }),
      };
    },
  };
};

let base: Dir;
let held: string[];
let lockRequest: (name: string, cb: () => Promise<never>) => Promise<unknown>;

const compress = async () => {
  const { NativeVideoCompressorWeb } = await import('./web');
  return new NativeVideoCompressorWeb().compressVideo({ sourcePath: 'blob:src', jobId: 'j' });
};

beforeEach(() => {
  vi.resetModules();
  mb.outputs.splice(0);
  mb.log.splice(0);
  mb.conversion = { isValid: true, discardedTracks: [], execute: async () => undefined };
  base = fakeDir();
  held = [];
  lockRequest = (name, cb) => {
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
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:out' }));
});

describe('NativeVideoCompressorWeb OPFS output', () => {
  it('writes to OPFS and keeps the output', async () => {
    await expect(compress()).resolves.toEqual({ success: true, destPath: 'blob:out' });
    expect(mb.outputs[0].target).toBeInstanceOf(StreamTarget);
    expect(mb.log).toEqual([]);
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

  it('an invalid conversion cancels the output before deleting its file', async () => {
    mb.conversion = { isValid: false, discardedTracks: [] };
    await compress();
    expect(mb.log[0]).toBe('cancel');
    expect(mb.log.slice(1, 3)).toEqual(['abort', expect.stringMatching(/^remove .+\.mp4$/)]);
    expect(mb.log).toContain('ffmpeg');
  });

  it('running out of storage mid-write rejects STORAGE_FULL, without falling back to ffmpeg', async () => {
    mb.conversion.execute = async () => {
      throw new DOMException('quota', 'QuotaExceededError');
    };
    await expect(compress()).rejects.toMatchObject({ code: STORAGE_FULL });
    expect(mb.log).not.toContain('ffmpeg');
    expect(mb.log).toContain('cancel');
  });
});
