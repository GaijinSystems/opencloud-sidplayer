import { isSidFile, parseSidHeader, V1_HEADER_LENGTH } from '../sid/header'
import type { SidHeader } from '../sid/types'
import type { CatalogRow } from './catalog'
import type { SpaceOps } from './space'
import { isMissing } from '../sid/source'
import { runWorkers } from '../helpers/async'

/**
 * The header fields, which are in no document.
 *
 * A tune's declared title, author, release line, chip and clock live in the
 * first 124 bytes of the file itself. The manifest does not carry them, so
 * the catalogue starts without them and the library fills them in:
 *
 * - during a sync, for nothing, because the bytes are already in hand;
 * - otherwise a folder at a time as it is opened, or as a background pass.
 *
 * A header read is a range request for 128 bytes, which OpenCloud honours
 * (`206`, `content-range: bytes 0-127/163`). The whole collection is then
 * about 8 MB of transfer rather than the 395 MB the files themselves weigh.
 */

export interface HeaderFields {
  title?: string
  author?: string
  released?: string
  format?: 'PSID' | 'RSID'
  model?: 'unknown' | '6581' | '8580' | 'both'
  clock?: 'unknown' | 'pal' | 'ntsc' | 'both'
  songs?: number
}

/** Header bytes needed: the v2+ header, plus a little slack for safety. */
export const HEADER_BYTES = 128

const MODELS: Record<string, HeaderFields['model']> = {
  unknown: 'unknown',
  MOS6581: '6581',
  MOS8580: '8580',
  'MOS6581 and MOS8580': 'both'
}
const CLOCKS: Record<string, HeaderFields['clock']> = {
  unknown: 'unknown',
  PAL: 'pal',
  NTSC: 'ntsc',
  'PAL and NTSC': 'both'
}

/**
 * The searchable fields of a parsed header. The names HVSC puts in a header
 * are often better than the file name - "Monty on the Run" against
 * `Monty_on_the_Run.sid` is a wash, but "Rambo: First Blood Part II" against
 * `Rambo.sid` is not - which is why they are worth collecting.
 */
function fieldsFromHeader(header: SidHeader): HeaderFields {
  return {
    /*
     * The empty string, not undefined, for a header that declares no name.
     * `title === undefined` is what every caller uses to mean "not read
     * yet", so mapping an empty name to undefined left those rows
     * permanently unread: re-fetched on every visit to their folder, and
     * counted as failures by the whole-collection pass. The list and the
     * detail pane already fall back to the file name for an empty title.
     */
    title: header.name,
    author: header.author || undefined,
    released: header.released || undefined,
    format: header.format === 'RSID' ? 'RSID' : header.format === 'PSID' ? 'PSID' : undefined,
    model: MODELS[header.sidModel] ?? 'unknown',
    clock: CLOCKS[header.clock] ?? 'unknown',
    songs: header.songs
  }
}

/** Fields from raw bytes, or null when this is not a PSID/RSID file at all. */
export function fieldsFromBytes(bytes: Uint8Array): HeaderFields | null {
  if (!isSidFile(bytes.subarray(0, 4))) return null
  // A v1 header is the shortest a real file can have.
  if (bytes.byteLength < V1_HEADER_LENGTH) return null
  try {
    return fieldsFromHeader(parseSidHeader(bytes))
  } catch {
    return null
  }
}

export interface FillProgress {
  /** Reads finished, whether or not they found a header. */
  done: number
}

export interface FillOptions {
  concurrency?: number
  onProgress?: (progress: FillProgress) => void
  shouldStop?: () => boolean
  /**
   * A tune that will not be read however often it is asked for: not there,
   * or there and not a SID. Not one whose read merely failed - an expired
   * token, a server having a bad minute - which says nothing about the file.
   */
  onUnreadable?: (path: string) => void
  /** A read that failed for some other reason, which may go better next time. */
  onFailed?: (path: string) => void
}

/**
 * Reads headers for the rows that do not have them yet and returns the fields
 * by path. Rows are left alone rather than mutated, so the caller decides
 * when the catalogue and its cache change.
 */
export async function fillHeaders(
  rows: CatalogRow[],
  ops: SpaceOps,
  options: FillOptions = {}
): Promise<Map<string, HeaderFields>> {
  const { concurrency = 8, onProgress, shouldStop, onUnreadable, onFailed } = options
  const pending = rows.filter((row) => row.title === undefined && row.name.toLowerCase().endsWith('.sid'))
  const out = new Map<string, HeaderFields>()
  const progress: FillProgress = { done: 0 }
  let next = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      if (shouldStop?.()) return
      const i = next++
      if (i >= pending.length) return
      const row = pending[i]
      try {
        const fields = fieldsFromBytes(await ops.readHead(row.path, HEADER_BYTES))
        if (fields) out.set(row.path, fields)
        else onUnreadable?.(row.path)
      } catch (e) {
        // Not read: the caller counts what is missing from the result.
        if (isMissing(e)) onUnreadable?.(row.path)
        else onFailed?.(row.path)
      }
      progress.done++
      onProgress?.(progress)
    }
  }

  await runWorkers(concurrency, worker)
  return out
}

/** A copy of the rows with the given fields applied, found by `keyOf`; a row with no key takes none. */
const applyBy =
  (keyOf: (row: CatalogRow) => string) =>
  (rows: CatalogRow[], fields: Map<string, HeaderFields>): CatalogRow[] => {
    if (!fields.size) return rows
    return rows.map((row) => {
      const key = keyOf(row)
      const found = key ? fields.get(key) : undefined
      return found ? { ...row, ...found } : row
    })
  }

/** A copy of the rows with the given fields applied, by collection path. */
export const applyHeaders = applyBy((row) => row.path)

/**
 * The same, by MD5, which is how the browser's cache holds them.
 *
 * Header fields describe the bytes, not the location, so the hash is what
 * they belong to: a tune HVSC moves to another folder in a later release
 * keeps its fields, and so does a collection whose release number is not
 * known yet.
 */
export const applyHeadersByMd5 = applyBy((row) => row.md5)
