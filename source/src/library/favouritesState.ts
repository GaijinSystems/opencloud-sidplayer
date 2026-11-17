import { computed, shallowRef, type ComputedRef, type Ref } from 'vue'
import type { CatalogRow } from '../hvsc/catalog'
import type { SpaceOps } from '../hvsc/space'
import {
  favouriteKey,
  loadFavourites,
  mergeFavourites,
  moveFavouriteTo,
  orderedFavourites,
  saveFavourites,
  toggleFavourite,
  EMPTY_FAVOURITES,
  FavouritesUnreadable,
  type FavouritesFile
} from '../hvsc/favourites'

/**
 * The starred tunes: the list in memory, and the one file it is kept in.
 *
 * This owns every write to that file and the two rules about them. Nothing
 * is written unless the file was read when the library opened, because a
 * write merges with what is there and a list that could not be read would be
 * replaced by this device's. And one write at a time, each of the list as it
 * stands when it starts, because two at once each put back a list without
 * the other's change.
 */

export interface FavouritesDeps {
  /** The app's own files, wherever they now are. */
  ops: () => SpaceOps
  /** The library's error line, which is where a refused or failed write is said. */
  error: Ref<string | null>
  /** The list on screen, which is what a position in the favourites view counts in. */
  visible: () => CatalogRow[]
}

export interface FavouritesState {
  favourites: Ref<FavouritesFile>
  /** The starred tunes' keys, so asking about one row is not a walk of the list. */
  starredKeys: ComputedRef<Set<string>>
  isStarred: (row: CatalogRow) => boolean
  /** Reads the file, as the library opens. */
  load(): Promise<void>
  toggleStar(row: CatalogRow): Promise<void>
  /** Moves a starred tune to a position in the hand-made favourites order. */
  moveFavourite(row: CatalogRow, index: number): Promise<void>
}

/**
 * The one message both favourites writes give, since the cause and the
 * consequence are the same for either.
 */
const FAVOURITES_UNSAFE =
  'Your favourites could not be read when the library opened, so they are not being written. Reload once your connection is back.'
/** The same refusal for a file that was read but is not JSON, which no reload mends. */
const FAVOURITES_CORRUPT =
  'Your favourites file (.sidplayer/favourites.json) is not valid JSON, or not in a shape this version of the library writes, so the library is leaving it alone rather than writing over it. Fix or remove it, then reload.'

export function createFavourites(deps: FavouritesDeps): FavouritesState {
  const { error } = deps

  // Shallow, like the rows: only ever replaced whole, and read once per row
  // of the table on every render.
  const favourites = shallowRef<FavouritesFile>(EMPTY_FAVOURITES)
  const starredKeys = computed(() => new Set(favourites.value.items.map((item) => favouriteKey(item))))
  /**
   * Why the starred list is not being written, or null where it may be.
   *
   * Set when the file could not be read as the library opened - not that
   * there is none - and the guard on every write to it. Which of the two
   * messages applies is settled then. See the note in `saveFavourites`.
   */
  let refusal: string | null = null

  async function load(): Promise<void> {
    /*
     * A failure here is remembered, not shrugged off. Starring writes the
     * merged list back, so a library that started with an empty list
     * because the read failed would, on the first star, replace the real
     * file with a list of one. Nothing is written while the refusal stands.
     */
    try {
      favourites.value = await loadFavourites(deps.ops())
      refusal = null
    } catch (e) {
      favourites.value = EMPTY_FAVOURITES
      // Why, kept for every refused write; and said now rather than on the
      // first star when it is the file itself, which no reload mends.
      refusal = e instanceof FavouritesUnreadable ? FAVOURITES_CORRUPT : FAVOURITES_UNSAFE
      if (e instanceof FavouritesUnreadable) error.value = FAVOURITES_CORRUPT
    }
  }

  /*
   * The favourites file is written by one save at a time, each writing the
   * list as it stands when it starts. Two at once - a star, then another
   * before the first had landed - each read the file, merged their own
   * snapshot and wrote it back, and whichever finished last decided what was
   * kept: the first could put back a list without the second star, in memory
   * and in the file.
   */
  let saving: Promise<void> | null = null
  /** Whether the list has changed since the save in flight read it. */
  let saveAgain = false
  /** What to say if the save fails, from whichever change asked for it last. */
  let saveFailure = ''

  function persistFavourites(failure: string): Promise<void> {
    // The change stays on screen; the file is not written while the refusal stands.
    if (refusal) {
      error.value = refusal
      return Promise.resolve()
    }
    saveFailure = failure
    if (saving) {
      saveAgain = true
      return saving
    }
    saving = (async () => {
      do {
        saveAgain = false
        // Cleared as each attempt starts, so a second failure is a new
        // message rather than the same one, and is shown again.
        if (error.value === saveFailure) error.value = null
        try {
          const saved = await saveFavourites(deps.ops(), favourites.value)
          // Merged into what is on screen rather than put in its place: the
          // list may have moved on while this was being written.
          favourites.value = mergeFavourites(saved, favourites.value)
        } catch {
          /*
           * The change stays on screen and in memory; the file is left
           * alone. A write that could not first read what it is merging with
           * would put this device's list in place of everybody's.
           */
          error.value = saveFailure
          return
        }
      } while (saveAgain)
    })().finally(() => {
      saving = null
    })
    return saving
  }

  async function toggleStar(row: CatalogRow): Promise<void> {
    favourites.value = toggleFavourite(favourites.value, {
      path: row.path,
      ...(row.collection ? { collection: row.collection } : {}),
      md5: row.md5
    })
    await persistFavourites('That star could not be saved. Your favourites file was left as it is.')
  }

  /**
   * Writes on every move, as starring does. A drag is one write; the
   * up and down buttons are one each, which is a few small requests if
   * someone walks a tune up a long list, and simpler than a debounce that
   * has to survive the view being closed mid-flight.
   */
  async function moveFavourite(row: CatalogRow, index: number): Promise<void> {
    /*
     * The table counts in rows it shows; the file's order also holds stars
     * with no row - a tune a release withdrew, a Compute's star while that
     * collection is not read - so the same number is a different place in
     * it. The place meant is wherever the row now at that position sits.
     */
    const target = deps.visible()[index]
    if (!target) return
    const targetKey = favouriteKey(target)
    const place = orderedFavourites(favourites.value).findIndex((item) => favouriteKey(item) === targetKey)
    if (place < 0) return
    const next = moveFavouriteTo(favourites.value, row, place)
    if (next === favourites.value) return
    favourites.value = next
    await persistFavourites('That move could not be saved. Your favourites file was left as it is.')
  }

  const isStarred = (row: CatalogRow): boolean => starredKeys.value.has(favouriteKey(row))

  return { favourites, starredKeys, isStarred, load, toggleStar, moveFavourite }
}
