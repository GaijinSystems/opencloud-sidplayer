import { rowKey } from './catalog'
import type { SpaceOps } from './space'
import { PRIVATE_FOLDER } from './sync'

/**
 * `/SID Library/.sidplayer/favourites.json`: starred tunes, kept in the space rather
 * than in the browser so they follow the account to any device and survive
 * cleared site data.
 *
 * Stored by collection path with the MD5 beside it. The path is what the
 * library looks up; the MD5 is what survives a release that moves a tune to
 * another folder, which HVSC's update scripts do with `MOVE` records.
 *
 * A star means nothing to HVSC, which records no such thing anywhere: this
 * file is the app's own, and the rules are ours to set. So a Compute's
 * Gazette tune can be starred too, even though that collection gives it no
 * MD5 to be robust with - path alone is fragile if the folders are ever
 * reorganised, and that is a fair price for being able to keep a tune.
 *
 * Unstarring is recorded rather than just dropped. Two browsers writing this
 * file cannot otherwise be reconciled: a path missing from one list may have
 * been removed there, or added on the other since, and nothing in the list
 * itself says which. A tombstone with its own timestamp makes every path a
 * plain last-write-wins, which needs no coordination and no version history.
 */

const FAVOURITES_PATH = `${PRIVATE_FOLDER}/favourites.json`

export interface Favourite {
  path: string
  /**
   * Which collection the path is in. Absent means HVSC, as it does on a
   * catalogue row, so every file written before this existed reads correctly.
   */
  collection?: 'cgsc'
  /** Empty for a Compute's tune, which has no MD5 anywhere to record. */
  md5: string
  /** ISO 8601 of when it was starred. */
  at: string
  /** Subsong, when a particular one was starred rather than the file. */
  subsong?: number
  /**
   * Position in the hand-made order, ascending. Absent for a tune starred
   * somewhere that has never been reordered, which sorts to the end.
   */
  rank?: number
  /**
   * ISO 8601 of when that position was set, and the reason it exists: `at`
   * is when the tune was starred and does not change when it is moved, so
   * merging on `at` alone would throw away a reorder every time. The rank
   * travels with its own last-write-wins stamp.
   */
  rankedAt?: string
}

export interface Tombstone {
  path: string
  collection?: 'cgsc'
  /** ISO 8601 of when it was unstarred. */
  at: string
}

/** What identifies a starred tune: the same key that identifies its row. */
export const favouriteKey = rowKey

export interface FavouritesFile {
  version: 1
  items: Favourite[]
  /** Unstarred paths, for merging. Pruned after `TOMBSTONE_DAYS`. */
  removed: Tombstone[]
}

export const EMPTY_FAVOURITES: FavouritesFile = { version: 1, items: [], removed: [] }

/** Long enough for any device to have synced, short enough not to accumulate. */
const TOMBSTONE_DAYS = 90

/**
 * A timestamp normalised to the one spelling, because every merge in this
 * file compares them as strings.
 *
 * `2026-01-01`, `2026-01-01T12:00:00+02:00` and the `toISOString()` this app
 * writes all name real instants, and lexical order over the three of them is
 * not chronological order: `+02:00` sorts after `Z` for the same moment, and
 * a date alone sorts before every time on that day. Anything this file has
 * written is already canonical, so this only bites on a file someone has
 * edited by hand or another tool has written - which is exactly the case
 * tombstones exist to survive.
 */
const iso = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const at = Date.parse(value)
  return Number.isNaN(at) ? null : new Date(at).toISOString()
}

/**
 * A favourites file that is not JSON at all - hand-edited with a stray comma,
 * or cut off half-written - or JSON of some other shape. Thrown rather than read as an empty list, because
 * an empty list is what the next star merges with and writes back - which
 * would replace every star in the file with one.
 */
export class FavouritesUnreadable extends Error {
  constructor(cause: unknown) {
    super('The favourites file is not one this app can read.')
    this.name = 'FavouritesUnreadable'
    this.cause = cause
  }
}

/**
 * Reads the file, tolerating anything inside it: it lives in the user's own
 * space where it can be edited, and an entry that makes no sense is dropped
 * rather than the whole list refused. Two things are not tolerated, both for
 * the reason in `FavouritesUnreadable`: a file that is not JSON at all, and
 * one whose shape is not this file's - an array, a number, an `items` that is
 * not a list - which would otherwise read as empty and be written over.
 *
 * Fields this version does not know are kept, on the file and on each entry,
 * so a newer version's additions survive a save from this one.
 */
export function parseFavourites(text: string | null): FavouritesFile {
  if (!text) return { version: 1, items: [], removed: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    throw new FavouritesUnreadable(e)
  }
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
  if (
    !isRecord(parsed) ||
    (parsed.items !== undefined && !Array.isArray(parsed.items)) ||
    (parsed.removed !== undefined && !Array.isArray(parsed.removed))
  ) {
    throw new FavouritesUnreadable(new TypeError('not a favourites file'))
  }
  /*
   * A later version's file, or a star in a collection this version does not
   * know, is one this version would rewrite wrongly - as version 1, or with
   * that star filed under HVSC - so it is left alone, as an unreadable one is.
   */
  /** An entry this reads at all: a record with a path from the collection's root. */
  const readable = (entry: unknown): entry is Record<string, unknown> & { path: string } =>
    isRecord(entry) && typeof entry.path === 'string' && entry.path.startsWith('/')
  // Only entries that would be read at all; `null` is as good as absent.
  const knownCollection = (entry: unknown): boolean =>
    !readable(entry) || entry.collection == null || entry.collection === 'cgsc'
  if (
    !(parsed.version === undefined || parsed.version === 1 || parsed.version === '1') ||
    ![...((parsed.items as unknown[]) ?? []), ...((parsed.removed as unknown[]) ?? [])].every(knownCollection)
  ) {
    throw new FavouritesUnreadable(new TypeError('written by a later version'))
  }
  const raw = parsed as Partial<FavouritesFile>
  const items: Favourite[] = []
  const seen = new Set<string>()
  for (const item of raw.items ?? []) {
    if (!readable(item)) continue
    const key = favouriteKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    items.push({
      ...item,
      path: item.path,
      collection: item.collection === 'cgsc' ? 'cgsc' : undefined,
      md5: typeof item.md5 === 'string' ? item.md5.toLowerCase() : '',
      at: iso(item.at) ?? new Date(0).toISOString(),
      subsong: typeof item.subsong === 'number' && item.subsong > 0 ? Math.trunc(item.subsong) : undefined,
      rank: typeof item.rank === 'number' && Number.isFinite(item.rank) ? item.rank : undefined,
      rankedAt: iso(item.rankedAt) ?? undefined
    })
  }
  const removed: Tombstone[] = []
  const seenGone = new Set<string>()
  for (const stone of raw.removed ?? []) {
    const at = readable(stone) ? iso(stone.at) : null
    if (!readable(stone) || !at) continue
    const key = favouriteKey(stone)
    if (seenGone.has(key)) continue
    seenGone.add(key)
    removed.push({
      ...stone,
      path: stone.path,
      collection: stone.collection === 'cgsc' ? 'cgsc' : undefined,
      at
    })
  }
  return { ...raw, version: 1, items, removed }
}

const serialiseFavourites = (file: FavouritesFile): string => JSON.stringify(file, null, 2)

export const isFavourite = (file: FavouritesFile, entry: { path: string; collection?: 'cgsc' }): boolean => {
  const key = favouriteKey(entry)
  return file.items.some((item) => favouriteKey(item) === key)
}

/** Stars or unstars, returning a new file; callers keep it in a ref. */
export function toggleFavourite(
  file: FavouritesFile,
  entry: Omit<Favourite, 'at'>,
  now: string = new Date().toISOString()
): FavouritesFile {
  const key = favouriteKey(entry)
  const elsewhere = (item: { path: string; collection?: 'cgsc' }) => favouriteKey(item) !== key
  if (isFavourite(file, entry)) {
    return {
      version: 1,
      items: file.items.filter(elsewhere),
      removed: [
        ...file.removed.filter(elsewhere),
        { path: entry.path, ...(entry.collection ? { collection: entry.collection } : {}), at: now }
      ]
    }
  }
  return {
    version: 1,
    items: [...file.items, { ...entry, md5: entry.md5.toLowerCase(), at: now }],
    removed: file.removed.filter(elsewhere)
  }
}

/**
 * Merges two versions of the file. For each path the later of its star and
 * its unstar wins, so a device that starred something after another
 * unstarred it keeps the star, and the other way round.
 *
 * A tune's position is merged separately from its star, on `rankedAt`.
 * Reordering does not restar anything, so `at` is unchanged by it, and
 * picking the whole item by `at` would quietly drop every reorder made
 * since the two copies last agreed.
 *
 * Positions merge one tune at a time, which is enough for the case that
 * happens - one person, one list, several devices - and not a general
 * solution to concurrent editing. Two devices that reorder the same list
 * before either has seen the other can produce a merged list holding a
 * rank twice; `orderedFavourites` breaks that tie deterministically, so
 * every device still agrees on what it sees, but the result may be neither
 * arrangement. Fixing that properly means a sequence CRDT, which is a great
 * deal of machinery for a starred-tunes list.
 */
export function mergeFavourites(
  a: FavouritesFile,
  b: FavouritesFile,
  now: number = Date.now()
): FavouritesFile {
  const stars = new Map<string, Favourite>()
  for (const item of [...a.items, ...b.items]) {
    const key = favouriteKey(item)
    const existing = stars.get(key)
    if (!existing || item.at > existing.at) stars.set(key, item)
  }
  const ranks = new Map<string, { rank: number; rankedAt: string }>()
  for (const item of [...a.items, ...b.items]) {
    if (item.rank === undefined || !item.rankedAt) continue
    const key = favouriteKey(item)
    const existing = ranks.get(key)
    if (!existing || item.rankedAt > existing.rankedAt)
      ranks.set(key, { rank: item.rank, rankedAt: item.rankedAt })
  }
  for (const [key, item] of stars) {
    const placed = ranks.get(key)
    stars.set(key, placed ? { ...item, ...placed } : item)
  }
  const stones = new Map<string, Tombstone>()
  for (const stone of [...a.removed, ...b.removed]) {
    const key = favouriteKey(stone)
    const existing = stones.get(key)
    if (!existing || stone.at > existing.at) stones.set(key, stone)
  }

  const items: Favourite[] = []
  for (const [path, item] of stars) {
    const stone = stones.get(path)
    if (stone && stone.at >= item.at) continue
    items.push(item)
    stones.delete(path)
  }
  const cutoff = new Date(now - TOMBSTONE_DAYS * 24 * 60 * 60 * 1000).toISOString()
  return {
    // Whatever else either file carries, `a`'s where both do.
    ...b,
    ...a,
    version: 1,
    items: items.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0)),
    removed: [...stones.values()].filter((stone) => stone.at >= cutoff)
  }
}

export async function loadFavourites(ops: SpaceOps): Promise<FavouritesFile> {
  return parseFavourites(await ops.readText(FAVOURITES_PATH))
}

/**
 * The starred tunes in the order they should be shown: by hand where a hand
 * has been laid on them, then everything else oldest first.
 *
 * A tune starred on another device arrives with no position of its own. It
 * goes to the end rather than to an arbitrary place in the middle, which is
 * the same rule the list columns use for a value they do not know yet.
 */
export function orderedFavourites(file: FavouritesFile): Favourite[] {
  return [...file.items].sort((x, y) => {
    const xr = x.rank ?? Number.POSITIVE_INFINITY
    const yr = y.rank ?? Number.POSITIVE_INFINITY
    if (xr !== yr) return xr - yr
    if (x.at !== y.at) return x.at < y.at ? -1 : 1
    return favouriteKey(x) < favouriteKey(y) ? -1 : favouriteKey(x) > favouriteKey(y) ? 1 : 0
  })
}

/**
 * Moves one tune to a position in that order, renumbering the lot.
 *
 * Every item is given a fresh dense rank rather than squeezing a fraction in
 * between two neighbours: the list is a handful of tunes, the file is
 * rewritten whole anyway, and dense integers are the version a person
 * reading the JSON can follow. `now` stamps only what actually moved, so a
 * merge with another device changes as little as it can.
 */
export function moveFavouriteTo(
  file: FavouritesFile,
  entry: { path: string; collection?: 'cgsc' },
  index: number,
  now: string = new Date().toISOString()
): FavouritesFile {
  const order = orderedFavourites(file)
  const key = favouriteKey(entry)
  const from = order.findIndex((item) => favouriteKey(item) === key)
  if (from < 0) return file
  const to = Math.min(order.length - 1, Math.max(0, index))
  if (to === from) return file
  const moved = order[from]
  order.splice(from, 1)
  order.splice(to, 0, moved)
  return {
    ...file,
    items: order.map((item, rank) =>
      item.rank === rank && item.rankedAt ? item : { ...item, rank, rankedAt: now }
    )
  }
}

/**
 * Writes the list, merging whatever the space holds first, so a star made in
 * another tab or on another device is not overwritten by this one.
 *
 * The read is deliberately not caught. The merge is the whole reason this
 * function exists, and a read that failed tells us nothing about what is in
 * the file - so writing anyway would replace a list we could not see with
 * this device's list alone. That is how starring one tune during a network
 * blip could erase ninety others: the library had already started with an
 * empty list for the same reason, so the merge had nothing to restore and
 * the tombstones that exist to reconcile devices had nothing to say about
 * paths that simply were not mentioned. Throwing leaves the file alone and
 * keeps the new star in memory for the next attempt.
 */
export async function saveFavourites(ops: SpaceOps, file: FavouritesFile): Promise<FavouritesFile> {
  const remote = await loadFavourites(ops)
  const merged = mergeFavourites(remote, file)
  await ops.writeText(FAVOURITES_PATH, serialiseFavourites(merged))
  return merged
}
