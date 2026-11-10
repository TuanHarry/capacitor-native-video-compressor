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
const lockName = (tabId: string) => `${OPFS_ROOT}:${tabId}`;

let tabId: string | null = null;
const getTabId = () => (tabId ??= crypto.randomUUID());
let fileCount = 0;

// Memoised apart from the directories: they are reopened after site data is
// cleared, but this tab still holds its lock, and requesting it again would
// wait forever on ourselves.
let tabLock: Promise<void> | null = null;
let tabDirsPromise: Promise<{ base: FileSystemDirectoryHandle; dir: FileSystemDirectoryHandle }> | null = null;

// A rejected request (e.g. a sandboxed iframe) rejects here, so openTabDirs
// fails and the caller buffers in memory instead of waiting forever.
const holdTabLock = () =>
  new Promise<void>((granted, rejected) => {
    navigator.locks
      .request(lockName(getTabId()), () => {
        granted();
        return new Promise<never>(() => undefined);
      })
      .catch(rejected);
  });

const sweepClosedTabs = async (base: FileSystemDirectoryHandle) => {
  // Names first, locks second: a tab that creates its directory between the two
  // reads already holds its lock, so it is never mistaken for a closed one.
  const names: string[] = [];
  for await (const name of base.keys()) names.push(name);
  const { held = [] } = await navigator.locks.query();
  const live = new Set(held.map((l) => l.name));
  for (const name of names) {
    if (!live.has(lockName(name))) await base.removeEntry(name, { recursive: true }).catch(() => undefined);
  }
};

const openTabDirs = async () => {
  const base = await (await navigator.storage.getDirectory()).getDirectoryHandle(OPFS_ROOT, { create: true });
  if (navigator.locks) {
    await (tabLock ??= holdTabLock().catch((e) => {
      tabLock = null;
      throw e;
    }));
  }
  return { base, dir: await base.getDirectoryHandle(getTabId(), { create: true }) };
};

export interface OpfsOutput {
  writable: FileSystemWritableFileStream;
  read: () => Promise<Blob>;
  discard: () => Promise<void>;
}

/** Null when OPFS or `createWritable` (missing on Safari's main thread) isn't there. */
export const createOpfsOutput = async (): Promise<OpfsOutput | null> => {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
    const { base, dir } = await (tabDirsPromise ??= openTabDirs().catch((e) => {
      tabDirsPromise = null;
      throw e;
    }));
    // Without Web Locks another tab's live files can't be told apart: no sweep.
    if (navigator.locks) await sweepClosedTabs(base).catch(() => undefined);
    const name = `${++fileCount}.mp4`;
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
    // OPFS files carry no MIME type, and callers derive the extension from it.
    const read = async () => (await handle.getFile()).slice(0, undefined, 'video/mp4');
    return { writable, read, discard };
  } catch (e) {
    console.warn('[compress] OPFS unavailable, buffering output in memory:', e);
    return null;
  }
};
