import { registerPlugin } from '@capacitor/core';

import type { NativeVideoCompressorPlugin } from './definitions';

const NativeVideoCompressor = registerPlugin<NativeVideoCompressorPlugin>('NativeVideoCompressor', {
  web: () => import('./web').then((m) => new m.NativeVideoCompressorWeb()),
});

export * from './definitions';
export { NativeVideoCompressor };
