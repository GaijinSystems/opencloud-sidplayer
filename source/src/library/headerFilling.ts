import { ref, type Ref } from 'vue'
import type { CatalogRow } from '../hvsc/catalog'
import type { SpaceOps } from '../hvsc/space'
import type { DocumentCache, HeaderRecord } from '../hvsc/store'
import { applyHeaders, fillHeaders, type HeaderFields } from '../hvsc/headers'
import { COLLECTIONS, collectionOf } from './collections'
import { throttle } from '../helpers/async'

/**
 * Reading SID headers out of the space, for the titles, years and chip
 * models the manifest does not carry.
 *
 * Two ways in - whatever is on screen, quietly, and the whole catalogue when
 * someone asks - and one way out: `takeHeaders`, which puts what was read
 * onto its rows, into the search index and into the browser's cache. This
 * owns both passes, the progress of the long one, and the memory of which
 * tunes had no header to give.
 */

export interface IndexingState {
  running: boolean
  done: number
  total: number
  failed: number
}

export interface HeaderFillingDeps {
  /** Whether there is a catalogue on screen to fill. */
  ready: () => boolean
  /** The catalogue whose rows take the headers; replaced whole as they arrive. */
  rows: Ref<CatalogRow[]>
  /** The list on screen. */
  visible: () => CatalogRow[]
  /** False for a row whose file is known, or must be assumed, not to be in the space. */
  mayHave: (row: CatalogRow) => boolean
  /** The collection's folder, wherever it now is. */
  ops: () => SpaceOps
  cache: DocumentCache
  /** How many catalogues have been built, to tell when a pass has been overtaken by one. */
  generation: () => number
  /** What the server says each file on disk is, where it has said. */
  diskMd5: () => Map<string, string>
  /** Folds the rows as they now are into the search index. */
  refreshIndex: () => void
}

export interface HeaderFilling {
  /** Progress of a whole-collection header pass. */
  indexing: Ref<IndexingState>
  /** Puts headers just read onto their rows, into the search index and into the cache. */
  takeHeaders(fields: Map<string, HeaderFields>): void
  fillVisibleHeaders(): Promise<void>
  /** Reads every tune's header, so titles and the chip filters are complete. */
  indexAll(): Promise<void>
  stopIndexing(): void
  /** Lets every tune be asked for its header again: what was missing may have arrived. */
  forgetUnread(): void
}

export function createHeaderFilling(deps: HeaderFillingDeps): HeaderFilling {
  const { rows, cache } = deps

  const indexing = ref<IndexingState>({ running: false, done: 0, total: 0, failed: 0 })
  let stopIndexRequest = false

  /**
   * Puts freshly read header fields in the browser's cache, under the MD5 of
   * each tune rather than its path.
   *
   * One pass over the catalogue to find the hash for each path. That is 61,157
   * comparisons against a set of at most a few hundred, which is a
   * millisecond, and it keeps no path-to-hash map alive between calls.
   */
  const cacheHeaders = (fields: Map<string, HeaderFields>): void => {
    if (!fields.size) return
    const records: HeaderRecord[] = []
    const diskMd5 = deps.diskMd5()
    for (const row of rows.value) {
      const found = fields.get(row.path)
      if (!found || !row.md5) continue
      // Unknown is trusted, as it always was; a known difference is not.
      const disk = diskMd5.get(row.path)
      if (disk && disk !== row.md5) continue
      records.push({ md5: row.md5, ...found })
    }
    if (records.length) void cache.saveHeaders(records)
  }

  const takeHeaders = (fields: Map<string, HeaderFields>): void => {
    rows.value = applyHeaders(rows.value, fields)
    deps.refreshIndex()
    cacheHeaders(fields)
  }

  /**
   * Tunes whose header could not be read, so that they are not asked for
   * again each time. In a collection that is partly downloaded the first
   * two hundred untitled rows of a listing can all be files that are not
   * there: every visit read the same two hundred and found nothing, and the
   * rows after them never had their turn. Forgotten when a sync has written,
   * since what was missing may have arrived.
   */
  let unread = new Set<string>()
  /**
   * How often each tune's read has failed for some other reason. One that
   * fails every time - a file the server will not serve, whatever it is -
   * would otherwise hold its place in the two hundred for good, so after a
   * few tries it is set aside with the missing ones.
   */
  let failures = new Map<string, number>()
  const GIVE_UP_AFTER = 3
  const failed = (path: string): void => {
    const count = (failures.get(path) ?? 0) + 1
    failures.set(path, count)
    if (count >= GIVE_UP_AFTER) unread.add(path)
  }

  let filling = false
  /** Set when a fill was asked for while one was already running. */
  let refill = false

  /**
   * Fills header fields for what is on screen, so the list can show titles
   * and release lines and the chip filters can be honest about being ready.
   * A folder is about fifty files, read 128 bytes at a time.
   */
  async function fillVisibleHeaders(): Promise<void> {
    if (!deps.ready()) return
    if (filling) {
      /*
       * Opening a folder while a fill is in flight used to drop the new
       * request outright, and since the previous folder's fill can be 200
       * reads long, the folder actually being looked at often never got its
       * titles at all. Remember that one is wanted instead.
       */
      refill = true
      return
    }
    filling = true
    try {
      for (;;) {
        refill = false
        // The first two hundred that want reading, without testing the
        // rest of a list that can be the whole collection.
        const pending: CatalogRow[] = []
        for (const row of deps.visible()) {
          if (pending.length >= 200) break
          if (row.title !== undefined || !COLLECTIONS[collectionOf(row)].headers) continue
          if (!unread.has(row.path) && deps.mayHave(row)) pending.push(row)
        }
        if (pending.length) {
          const generation = deps.generation()
          const fields = await fillHeaders(pending, deps.ops(), {
            concurrency: 8,
            onUnreadable: (path) => unread.add(path),
            onFailed: failed
          })
          if (fields.size && generation === deps.generation()) takeHeaders(fields)
        }
        // Whatever is on screen now, which may be somewhere else entirely.
        if (!refill) break
      }
    } finally {
      filling = false
    }
  }

  /**
   * Reads every tune's header, 128 bytes at a time, so the whole catalogue
   * has real titles and the chip and year filters apply to all of it.
   *
   * A sync reads them as it goes, having the bytes in hand; a collection
   * unpacked from an archive does not, and filling it folder by folder as
   * someone browses takes as long as they take. For release 85 this is about
   * 8 MB of transfer. Slices are applied and cached as they finish, so
   * stopping halfway keeps what was read.
   */
  async function indexAll(): Promise<void> {
    if (indexing.value.running) return
    stopIndexRequest = false
    const pending = rows.value.filter((row) => row.title === undefined && deps.mayHave(row))
    indexing.value = { running: true, done: 0, total: pending.length, failed: 0 }
    const SLICE = 500
    // A few times a second rather than once per header read.
    const showProgress = throttle((done: number) => {
      indexing.value = { running: true, done, total: pending.length, failed: indexing.value.failed }
    }, 100)

    try {
      for (let i = 0; i < pending.length; i += SLICE) {
        if (stopIndexRequest) break
        const slice = pending.slice(i, i + SLICE)
        const generation = deps.generation()
        const fields = await fillHeaders(slice, deps.ops(), {
          concurrency: 8,
          shouldStop: () => stopIndexRequest,
          onProgress: (p) => showProgress(i + p.done)
        })
        showProgress.flush()
        // A catalogue built since has rows this pass never looked at.
        if (generation !== deps.generation()) break
        // Per slice, now that it is cheap: search improves as it goes.
        if (fields.size) takeHeaders(fields)
        indexing.value = {
          ...indexing.value,
          done: Math.min(pending.length, i + slice.length),
          failed: indexing.value.failed + (slice.length - fields.size)
        }
      }
    } finally {
      showProgress.flush()
      indexing.value = { ...indexing.value, running: false }
    }
  }

  const stopIndexing = (): void => {
    stopIndexRequest = true
  }

  const forgetUnread = (): void => {
    unread = new Set()
    failures = new Map()
  }

  return { indexing, takeHeaders, fillVisibleHeaders, indexAll, stopIndexing, forgetUnread }
}
