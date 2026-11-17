import type { SpaceListing, SpaceOps } from './space'
import type { LocalIndex } from './sync'
import { DOCUMENTS_FOLDER, PRIVATE_FOLDERS, SYNCED_FOLDERS } from './sync'
import { runWorkers } from '../helpers/async'

/**
 * What the space already holds, as a path-to-MD5 map.
 *
 * This has to be a folder-by-folder walk. `Depth: infinity` is refused by
 * OpenCloud with "Invalid Depth header value", so there is no single request
 * that returns 61,157 files, and the collection is about 3,500 folders deep
 * and wide. At roughly ten listings a second that is a few minutes, which is
 * why the result is cached and why the walk reports progress.
 *
 * The app's own folder is skipped: its status and favourites files are not
 * part of the collection and must never look like tunes to remove.
 */

export interface WalkProgress {
  folders: number
  files: number
  /** The folder being listed, for a "looking at..." line. */
  at: string
}

export interface WalkOptions {
  /** Folders listed at once. Each is one PROPFIND. */
  concurrency?: number
  onProgress?: (progress: WalkProgress) => void
  shouldStop?: () => boolean
  /** Where to start; the folders a sync touches by default. */
  from?: string[]
}

export interface WalkResult {
  /** What was found: collection path to MD5, or null where none was reported. */
  index: LocalIndex
  /**
   * Folders that could not be listed.
   *
   * The reason this is reported rather than shrugged off: a walk of the real
   * collection is about 1,951 listings over some three minutes, which is long
   * enough for an access token to expire in the middle of it. Every folder
   * after that point then comes back unreadable, and an inventory missing
   * half the collection makes the sync plan a re-download of thousands of
   * files that are already there. A caller that is about to decide what to
   * download or delete has to know the list is incomplete.
   */
  failed: string[]
  /** True when `shouldStop` ended the walk before it ran out of folders. */
  stopped: boolean
}

/**
 * What the space holds under the folders a sync cares about.
 *
 * Starting from the three tune folders and DOCUMENTS rather than from the
 * root is not just tidiness. A real unpacked collection has `readme.1st`,
 * half a dozen `.d64` disk images and often an `update/` folder left over
 * from applying an update package, and walking those costs listings and
 * inventory entries for files a sync will never touch.
 */
export async function walkSpace(ops: SpaceOps, options: WalkOptions = {}): Promise<WalkResult> {
  const { concurrency = 6, onProgress, shouldStop } = options
  const index: LocalIndex = new Map()
  const failed: string[] = []
  const queue: string[] = options.from ? [...options.from] : SYNCED_FOLDERS.map((name) => `/${name}`)
  const progress: WalkProgress = { folders: 0, files: 0, at: '/' }
  let active = 0
  let stopped = false
  /** Workers waiting for a listing in flight to queue more, woken when one ends. */
  let waiting: Array<() => void> = []
  const wakeAll = (): void => {
    const woken = waiting
    waiting = []
    for (const wake of woken) wake()
  }

  const take = async (): Promise<void> => {
    for (;;) {
      if (shouldStop?.()) {
        stopped = true
        return
      }
      const path = queue.shift()
      if (path === undefined) {
        // Nothing queued, but another worker may still be about to queue
        // children of the folder it is listing.
        if (active === 0) return
        await new Promise<void>((resolve) => waiting.push(resolve))
        continue
      }
      active++
      let listing: SpaceListing
      try {
        listing = await ops.list(path)
      } catch {
        // Recorded rather than ignored. `list` answers a missing folder with
        // an empty listing, so reaching here means the server could not or
        // would not say what is in it.
        listing = { folders: [], files: [] }
        failed.push(path)
      } finally {
        active--
      }
      progress.folders++
      progress.at = path
      for (const folder of listing.folders) {
        // Any segment, not just the first: the default walk starts inside the
        // collection, where an old `.sidplay` can only be at the top, but the
        // Compute's walk starts at the root of its own folder.
        if (folder.split('/').some((segment) => PRIVATE_FOLDERS.includes(segment))) continue
        queue.push(folder)
      }
      for (const file of listing.files) {
        index.set(file.path, file.md5)
        progress.files++
      }
      // Whatever this listing queued is there to take, and if it queued
      // nothing and was the last in flight, the waiting can finish. Before
      // the report, so a report that throws cannot leave them waiting.
      wakeAll()
      onProgress?.(progress)
    }
  }

  await runWorkers(concurrency, take)
  return { index, failed, stopped }
}

/** The folder HVSC's own archives unpack into. */
export const ARCHIVE_FOLDER = 'C64Music'

/** The collection's top-level folders, any one of which identifies it. */
const HALLMARKS = [DOCUMENTS_FOLDER, 'MUSICIANS', 'DEMOS', 'GAMES']

/**
 * Where the collection actually is, relative to the configured folder.
 *
 * Two layouts turn up, and both are reasonable. A sync written by this app
 * puts `MUSICIANS/` and friends straight into the configured folder, because
 * that is what the manifest's paths say. Someone who unpacks HVSC's own
 * archive instead gets a `C64Music/` folder in the way, since that is the
 * archive's top-level directory - which is also why the mirror serves the
 * unpacked collection under `C64Music/`.
 *
 * Returns '' for the flat layout, '/C64Music' for the archive's, or null when
 * the folder holds no collection at all, which is what sends the library to
 * its first-run screen. Costs one listing, or two for the archive layout.
 */
export async function resolveCollectionRoot(ops: SpaceOps): Promise<string | null> {
  const top = (await ops.list('/')).folders.map((f) => f.replace(/^\/+/, '').split('/')[0])
  const names = new Set(top)
  if (HALLMARKS.some((name) => names.has(name))) return ''
  if (!names.has(ARCHIVE_FOLDER)) return null

  const inside = (await ops.list(`/${ARCHIVE_FOLDER}`)).folders.map((f) => f.split('/').pop() ?? '')
  const within = new Set(inside)
  return HALLMARKS.some((name) => within.has(name)) ? `/${ARCHIVE_FOLDER}` : null
}
