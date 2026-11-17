import { PRIVATE_FOLDER } from './sync'

/**
 * `/SID Library/.sidplayer/status.json`: what the library knows about its own
 * collection, kept beside the collection rather than in the browser so it is
 * the same on every device.
 *
 * Nothing polls. The app reads the status when it opens; if there is none, or
 * the last look was more than a day ago, it asks the mirror which release is
 * current and writes the answer back. An update is only ever started by a
 * person pressing the button.
 */

export const STATUS_PATH = `${PRIVATE_FOLDER}/status.json`

export interface CollectionStatus {
  /** Release the local collection is believed to be, from the last sync. */
  release: number | null
  /** Release the mirror offered when it was last asked. */
  upstream: number | null
  /** When the mirror was last asked, ISO 8601. */
  checkedAt: string | null
  /** When a sync last finished, ISO 8601. */
  syncedAt?: string | null
  /** Tunes in the collection after that sync. */
  files?: number
  /** Written by whichever version of the app wrote the file. */
  app?: string
  /**
   * `online`: the collection holds only the documents and whatever has been
   * played, each tune fetched the first time it is, and an update refreshes
   * what is there rather than fetching the rest. Absent means the whole
   * collection, which is what every status written before this meant.
   */
  mode?: 'online'
  /**
   * The last sync wrote the collection's documents and claimed no release:
   * it stopped short, or the mirror moved on while it ran. Its `HVSC.txt`
   * may then name a release the tunes are not, so the release is not read
   * back from it; the next update works out what is left.
   */
  unfinished?: true
}

export const EMPTY_STATUS: CollectionStatus = {
  release: null,
  upstream: null,
  checkedAt: null
}

/** A day, the interval the app was asked for. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

/**
 * Whether to ask the mirror for its release number.
 *
 * True when nothing has ever been recorded, when the recorded time is
 * unreadable, or when it is older than a day. A clock that has gone backwards
 * counts as stale too: a future timestamp would otherwise suppress checks
 * until it came around.
 */
export function shouldCheck(status: CollectionStatus | null, now: number = Date.now()): boolean {
  if (!status || !status.checkedAt) return true
  const at = Date.parse(status.checkedAt)
  if (!Number.isFinite(at)) return true
  if (at > now) return true
  return now - at >= CHECK_INTERVAL_MS
}

/** Whether the mirror has something the collection does not. */
export const updateAvailable = (status: CollectionStatus | null): boolean =>
  !!status && status.upstream !== null && (status.release === null || status.upstream > status.release)

/**
 * Reads a status file. Anything malformed reads as "never checked" rather
 * than throwing: this file is in the user's own space, where it can be
 * edited, truncated by a failed write, or replaced by a folder.
 */
export function parseStatus(text: string): CollectionStatus | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>
    // `typeof [] === 'object'`, and an array has none of these fields.
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const num = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null
    const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
    return {
      release: num(raw.release),
      upstream: num(raw.upstream),
      checkedAt: str(raw.checkedAt),
      syncedAt: str(raw.syncedAt),
      files: num(raw.files) ?? undefined,
      app: str(raw.app) ?? undefined,
      ...(raw.mode === 'online' ? { mode: 'online' as const } : {}),
      ...(raw.unfinished === true ? { unfinished: true as const } : {})
    }
  } catch {
    return null
  }
}

export const serialiseStatus = (status: CollectionStatus): string => JSON.stringify(status, null, 2)
