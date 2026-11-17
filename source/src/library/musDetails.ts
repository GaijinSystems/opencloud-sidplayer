import { computed, shallowRef, type ComputedRef, type Ref } from 'vue'
import type { CatalogRow } from '../hvsc/catalog'
import type { SpaceOps } from '../hvsc/space'
import type { DocumentCache } from '../hvsc/store'
import { musDetailsOf, type MusDetails, type ShownMusDetails } from '../cgsc/details'
import { COLLECTIONS, collectionOf } from './collections'

/**
 * What a Compute's tune says about itself.
 *
 * That collection ships no index, so a tune's title, credits and length are
 * in its own file and nowhere else. This owns the reading of them: when, how
 * much, and what is kept of it afterwards.
 */

export interface MusDetailsDeps {
  /** The browser-side cache, which keeps what was read beyond the page. */
  cache: DocumentCache
  /** The folder the tunes are in, wherever that now is. */
  ops: () => SpaceOps
  /** The most a tune can be, in bytes; the same limit the player keeps. */
  maxBytes: () => number
  /** The tune being looked at. */
  selected: Ref<CatalogRow | null>
  /** The collection's `.str` files, lower-cased, as last read. */
  strs: () => Set<string>
  /** The server's MD5 for each tune, where there is one, as last read. */
  checksums: () => Map<string, string>
}

export interface MusDetailsState {
  /** Reads a row's details if it is of a kind that has any and they are not already known. */
  read(row: CatalogRow): Promise<void>
  /** The selected tune's own credits and length, once read. */
  selectedMus: ComputedRef<ShownMusDetails | null>
}

export function createMusDetails(deps: MusDetailsDeps): MusDetailsState {
  const { cache, selected } = deps
  const described = (row: CatalogRow): boolean => COLLECTIONS[collectionOf(row)].detailsFromFile

  /**
   * Read on selection and only then: one small file, a few kilobytes, for
   * the tune someone is actually looking at. Reading all 16,601 ahead of
   * time to fill the list would be some fifty megabytes nobody asked for.
   *
   * Kept in memory for the page and in the browser's cache beyond it, so
   * going back to a tune costs nothing, even after a reload. A read that
   * fails is kept in neither, and the next selection tries again.
   */
  const musDetails = shallowRef(new Map<string, MusDetails>())
  const musReading = new Set<string>()
  const remember = (path: string, details: MusDetails): void => {
    const next = new Map(musDetails.value)
    next.set(path, details)
    musDetails.value = next
  }

  async function read(row: CatalogRow): Promise<void> {
    if (!described(row) || musDetails.value.has(row.path) || musReading.has(row.path)) return
    musReading.add(row.path)
    try {
      /*
       * A stored copy is keyed by path alone, since nothing cheaper than the
       * file itself says what the file is. Where the collection was walked,
       * the server's listing did say, and a copy whose MD5 no longer matches
       * is of a file that has since been replaced. From the index file there
       * is nothing to compare, and the copy is believed: this is an archive
       * that does not change.
       */
      const stored = await cache.loadMus(row.path)
      const server = deps.checksums().get(row.path)
      if (stored && (!server || server === stored.md5)) {
        const { path: _, ...details } = stored
        remember(row.path, details)
        return
      }
      // No more than the player itself would take: a file named .mus can be
      // anything, of any size, and this read happens on merely selecting it.
      const limit = deps.maxBytes()
      const bytes = await deps.ops().readHead(row.path, limit + 1)
      if (bytes.byteLength > limit) throw new Error('larger than a tune can be')
      const details = musDetailsOf(bytes)
      remember(row.path, details)
      void cache.saveMus({ path: row.path, ...details })
    } catch (e) {
      console.info('[sidplayer] a Compute’s tune could not be read for its details', {
        path: row.path,
        error: e
      })
    } finally {
      musReading.delete(row.path)
    }
  }

  const selectedMus = computed<ShownMusDetails | null>(() => {
    const row = selected.value
    const details = row && described(row) ? musDetails.value.get(row.path) : undefined
    if (!row || !details) return null
    // A .str beside it, matched the way the player matches companions: same
    // name, any case. Asked here rather than stored, since it is the folder's
    // fact and not the file's, and may have arrived since.
    const hasStr = deps.strs().has(row.path.replace(/\.mus$/i, '.str').toLowerCase())
    return { ...details, format: details.stereo || hasStr ? 'MUS+STR' : 'MUS' }
  })

  return { read, selectedMus }
}
