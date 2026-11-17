import type { ManifestEntry } from './manifest'
import { runWorkers } from '../helpers/async'

/**
 * Syncing the collection, by comparing two lists of MD5s.
 *
 * `DOCUMENTS/Songlengths.md5` says what release N contains and what each file
 * hashes to; OpenCloud reports the MD5 of every file it holds
 * (`<oc:checksum>MD5:...`). The difference between those two lists is the
 * work, which makes the sync stateless: it keeps no record of what it did
 * last time, resumes after any interruption, and repairs a collection that
 * was half-copied or edited by hand. Nothing else in the app needs to know
 * whether a previous sync finished.
 *
 * Planning is separated from doing so the plan can be shown to a person
 * before anything is written, which is what the removals policy requires.
 */

/** What the space holds: collection path -> MD5, or null when unknown. */
export type LocalIndex = Map<string, string | null>

export interface SyncPlan {
  /** Not in the space at all. */
  add: ManifestEntry[]
  /** Present with different content. */
  replace: ManifestEntry[]
  /** In the space, under the collection, and no longer in the release. */
  remove: string[]
  /** Already correct, so not touched. */
  unchanged: number
  /** Present but with no checksum reported, so it cannot be judged. */
  unverified: string[]
}

/**
 * The folders the manifest describes, and so the only ones a sync reads or
 * writes. Checked against release 85: all 61,157 entries are under these
 * three, and DOCUMENTS is not mentioned once.
 */
export const COLLECTION_FOLDERS = ['DEMOS', 'GAMES', 'MUSICIANS'] as const

/** Where HVSC keeps its documents, beside the three tune folders. */
export const DOCUMENTS_FOLDER = 'DOCUMENTS'

/** The collection's own documents, by what each is for. */
export const DOCUMENTS = {
  release: 'HVSC.txt',
  manifest: 'Songlengths.md5',
  stil: 'STIL.txt',
  musicians: 'Musicians.txt'
} as const

/**
 * Folders a sync visits, which includes the documentation it fetches by name
 * even though the manifest never lists it.
 */
export const SYNCED_FOLDERS = [...COLLECTION_FOLDERS, DOCUMENTS_FOLDER] as const

/** The app's own folder inside the collection, never part of a sync. */
export const PRIVATE_FOLDER = '.sidplayer'
/**
 * What that folder was called before the app's name became `sidplayer`. Read
 * from where the new one has nothing yet, never written, and kept out of
 * every walk like the new one.
 */
export const LEGACY_PRIVATE_FOLDER = '.sidplay'
/** Both, for whatever has to leave the app's folder alone under either name. */
export const PRIVATE_FOLDERS: readonly string[] = [PRIVATE_FOLDER, LEGACY_PRIVATE_FOLDER]

/**
 * Whether a path out of the manifest is one this app may write to or delete.
 *
 * The manifest is a text file fetched from a third-party mirror, and its
 * paths are used unchecked to build both PUT and DELETE targets. Nothing
 * resolves `..` on the way: `spacePath` just joins, and the browser's URL
 * parser collapses the segments at the last moment, so an entry reading
 * `; /MUSICIANS/../../Documents/thesis.docx` writes mirror bytes over a file
 * in the user's space that has nothing to do with the collection, and enough
 * `../` escapes the space's DAV prefix entirely.
 *
 * That needs a compromised or substituted mirror to matter, which is a long
 * way from likely - but the fix is a few lines and the alternative is
 * trusting a downloaded document to choose where files land. The rule is the
 * same one `removable` already applies to deletions: a `.sid` file, at least
 * one folder deep, under one of the three folders the manifest describes.
 */
export function validCollectionPath(path: string): boolean {
  if (!path.startsWith('/')) return false
  const segments = path.slice(1).split('/')
  if (segments.length < 2) return false
  if (!(COLLECTION_FOLDERS as readonly string[]).includes(segments[0])) return false
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') return false
  }
  return segments[segments.length - 1].toLowerCase().endsWith('.sid')
}

/**
 * What a sync may propose deleting: a `.sid` file under one of the three tune
 * folders that the release no longer lists.
 *
 * Narrow on purpose. A real unpacked collection holds far more than the
 * manifest describes - `DOCUMENTS/` is full of faqs, `Update_Announcements/`
 * and `hv_sids.txt`, none of it listed; the top level carries `readme.1st`
 * and half a dozen `.d64` disk images; someone who has applied an update
 * package has an `update/` folder as well. All of that is legitimately
 * theirs, and an earlier version of this rule would have offered to delete
 * every one of the DOCUMENTS files on the first sync. The same rule as a
 * path the app may write, so nothing is deleted that could not be put back.
 */
const removable = validCollectionPath

/**
 * The documents a sync must fetch by name.
 *
 * `Songlengths.md5` lists every tune in the release and nothing else - not
 * even itself - so a sync driven purely by the manifest downloads 61,157
 * tunes and no documentation at all, leaving the library with no song
 * lengths, no commentary and no composer names. These four are therefore
 * fetched explicitly, and compared by their own MD5 like everything else.
 */
export const DOCUMENT_FILES = Object.values(DOCUMENTS)

export const documentPath = (name: string): string => `/${DOCUMENTS_FOLDER}/${name}`

export function planSync(entries: ManifestEntry[], local: LocalIndex): SyncPlan {
  const plan: SyncPlan = { add: [], replace: [], remove: [], unchanged: 0, unverified: [] }
  const wanted = new Set<string>()

  /*
   * A manifest with nothing in it is a failed fetch, not a release in which
   * every tune was withdrawn, so it proposes no deletions.
   *
   * The way it happens is in this project's own deployment notes: get the
   * HAProxy rule wrong and requests for the mirror fall through to OpenCloud,
   * whose single-page fallback answers 200 with HTML. That parses to zero
   * entries, `wanted` ends up empty, and every local `.sid` - 61,157 of them
   * on a full collection - lands in `remove` with an approve button beside
   * it. The caller checks the size of the answer as well; this is the floor
   * that holds whatever the caller forgets.
   */
  const trustworthy = entries.length > 0

  for (const entry of entries) {
    wanted.add(entry.path)
    if (!local.has(entry.path)) {
      plan.add.push(entry)
      continue
    }
    const mine = local.get(entry.path)
    if (mine === null || mine === undefined) {
      // No checksum: assume it is right rather than re-fetch 61,157 files,
      // and say so, so the UI can offer a verify pass.
      plan.unverified.push(entry.path)
      plan.unchanged++
      continue
    }
    if (mine.toLowerCase() === entry.md5) plan.unchanged++
    else plan.replace.push(entry)
  }

  if (trustworthy) {
    for (const path of local.keys()) {
      if (wanted.has(path)) continue
      if (!removable(path)) continue
      plan.remove.push(path)
    }
    plan.remove.sort()
  }
  return plan
}

/* ---- carrying a plan out ------------------------------------------------- */

export interface MirrorReader {
  /** Bytes of one collection file, tune or document. */
  tune(path: string): Promise<Uint8Array>
}

export interface DocumentSyncResult {
  written: string[]
  unchanged: string[]
  failed: string[]
  /**
   * The bytes of every document that is now in the space as the mirror has
   * it - written, or already the same - by path. What failed is not here,
   * so whoever reads these reads only what the space holds.
   */
  arrived: Map<string, Uint8Array>
}

/**
 * Brings the collection's documents up to date. Each is fetched, hashed and
 * written only when it differs from the copy in the space, so a sync that
 * changes nothing costs four small downloads rather than four writes.
 */
export async function syncDocuments(
  mirror: MirrorReader,
  space: SpaceWriter,
  local: LocalIndex,
  md5Of: (bytes: Uint8Array) => string,
  names: readonly string[] = DOCUMENT_FILES,
  options: {
    /**
     * Whether what arrived is the document it claims to be. The manifest
     * lists no MD5 for these, so this is the only check there is between a
     * proxy's error page and the collection's Songlengths.md5.
     */
    accept?: (path: string, bytes: Uint8Array) => boolean
  } = {}
): Promise<DocumentSyncResult> {
  const result: DocumentSyncResult = { written: [], unchanged: [], failed: [], arrived: new Map() }
  for (const name of names) {
    const path = documentPath(name)
    try {
      const bytes = await mirror.tune(path)
      if (options.accept && !options.accept(path, bytes)) {
        result.failed.push(path)
        continue
      }
      if (local.get(path) === md5Of(bytes)) {
        result.unchanged.push(path)
        result.arrived.set(path, bytes)
        continue
      }
      await space.write(path, bytes)
      result.written.push(path)
      result.arrived.set(path, bytes)
    } catch {
      result.failed.push(path)
    }
  }
  return result
}

export interface SpaceWriter {
  write(path: string, bytes: Uint8Array): Promise<void>
  remove(path: string): Promise<void>
}

export interface SyncProgress {
  /** Files finished, of `total`. */
  done: number
  total: number
  bytes: number
  added: number
  replaced: number
  removed: number
  failed: number
  /**
   * Files fetched whose bytes did not hash to what the manifest said, and so
   * were not written. Counted apart from `failed` because it means something
   * different: the mirror answered, and answered with the wrong thing.
   */
  mismatched: number
  /** The last few paths touched, newest last, for the activity log. */
  recent: Array<{ path: string; action: 'add' | 'replace' | 'remove' | 'fail' }>
  /** Removals approved and not carried out, because some of the fetches failed. */
  removalsHeld?: number
  /** Set when the run stopped early. */
  stopped?: 'paused' | 'cancelled'
}

export interface RunOptions {
  mirror: MirrorReader
  space: SpaceWriter
  /** How many fetches to have in flight. The mirror is a volunteer's server. */
  concurrency?: number
  /** Called after every file, and at most as often as that. */
  onProgress?: (progress: SyncProgress) => void
  /** Checked between files; returning true stops the run. */
  shouldStop?: () => 'paused' | 'cancelled' | false
  /**
   * Each file finished - written, or removed - as it is. Not a failure,
   * which the next run should try again. What lets a paused run be resumed
   * where it stopped rather than from the start.
   */
  onDone?: (path: string) => void
  /**
   * Each tune as it arrives, once it has been checked and written. The
   * bytes are in hand here and nowhere else, which is the one moment its
   * header can be read without asking for the file a second time.
   */
  onBytes?: (entry: ManifestEntry, bytes: Uint8Array) => void
  /** Whether the plan's removals were approved. Without this they are skipped. */
  applyRemovals?: boolean
  /**
   * Hashes what the mirror sent, so it can be checked against the manifest
   * before it is written.
   *
   * The whole plan is built by comparing MD5s, the manifest carries one for
   * every entry, and until now nothing looked at the bytes that arrived. A
   * proxy answering 200 with an HTML error page wrote that page into the
   * collection as a `.sid`; a mirror briefly out of step with its own
   * manifest wrote files that would be re-fetched on every later sync,
   * forever, because they never match. Optional only so the pure-function
   * tests can leave it out.
   */
  md5Of?: (bytes: Uint8Array) => string
}

const RECENT = 6

/**
 * Runs a plan in the order the manifest gives, which is path order. Failures
 * are counted and reported rather than thrown: one 404 on a
 * volunteer mirror should not abandon 6,000 other files, and the next run
 * picks up whatever is still missing because the plan is recomputed from the
 * MD5s each time.
 */
export async function runSync(plan: SyncPlan, options: RunOptions): Promise<SyncProgress> {
  const {
    mirror,
    space,
    concurrency = 6,
    onProgress,
    shouldStop,
    applyRemovals = false,
    md5Of,
    onDone,
    onBytes
  } = options
  const removals = applyRemovals ? plan.remove : []
  const fetches = [...plan.add, ...plan.replace]

  const progress: SyncProgress = {
    done: 0,
    total: fetches.length + removals.length,
    bytes: 0,
    added: 0,
    replaced: 0,
    removed: 0,
    failed: 0,
    mismatched: 0,
    recent: []
  }
  const note = (path: string, action: SyncProgress['recent'][number]['action']): void => {
    progress.recent.push({ path, action })
    if (progress.recent.length > RECENT) progress.recent.shift()
    progress.done++
    onProgress?.(progress)
  }

  const replacing = new Set(plan.replace.map((e) => e.path))
  let next = 0
  let stop: 'paused' | 'cancelled' | false = false

  const worker = async (): Promise<void> => {
    for (;;) {
      if (stop) return
      const check = shouldStop?.()
      if (check) {
        stop = check
        return
      }
      const i = next++
      if (i >= fetches.length) return
      const entry = fetches[i]
      try {
        const bytes = await mirror.tune(entry.path)
        // Checked before it is written, not after: a file that is not what
        // the release says it is should never reach the collection, where
        // the next plan would compare its hash and fetch it all over again.
        if (md5Of && md5Of(bytes) !== entry.md5) {
          progress.mismatched++
          progress.failed++
          note(entry.path, 'fail')
          continue
        }
        await space.write(entry.path, bytes)
        onDone?.(entry.path)
        onBytes?.(entry, bytes)
        progress.bytes += bytes.byteLength
        const replaced = replacing.has(entry.path)
        if (replaced) progress.replaced++
        else progress.added++
        note(entry.path, replaced ? 'replace' : 'add')
      } catch {
        progress.failed++
        note(entry.path, 'fail')
      }
    }
  }

  await runWorkers(concurrency, worker)

  /*
   * Nothing is removed by a run that could not fetch everything. A release
   * that moves a tune is an addition and a removal, and with the addition
   * failed the removal took the only copy. The next plan lists them again,
   * to be approved again, once what this run could not fetch is there.
   */
  if (!stop && progress.failed > 0 && removals.length) {
    progress.total -= removals.length
    progress.removalsHeld = removals.length
  } else if (!stop) {
    for (const path of removals) {
      const check = shouldStop?.()
      if (check) {
        stop = check
        break
      }
      try {
        await space.remove(path)
        onDone?.(path)
        progress.removed++
        note(path, 'remove')
      } catch {
        progress.failed++
        note(path, 'fail')
      }
    }
  }

  if (stop) progress.stopped = stop
  onProgress?.(progress)
  return progress
}
