import { md5Hex } from './md5'

/**
 * HVSC's Songlengths.md5: how long each subsong of each tune in the High
 * Voltage SID Collection actually plays before it loops, which a SID file
 * itself cannot say.
 *
 *   [Database]
 *   ; /MUSICIANS/H/Hubbard_Rob/Commando.sid
 *   e9c1b52f7f9c5d8d0e2c2f3a1b4c5d6e=4:01 0:37(G) 0:31
 *
 * One `md5=lengths` line per tune, with the collection path in the comment
 * above it. Lengths are `m:ss`, optionally `m:ss.mmm`, optionally followed by
 * a flag in parentheses that this player does not need. Since HVSC #68 the
 * key is the MD5 of the whole file, which libsidplayfp calls "new" MD5.
 */

export interface SonglengthEntry {
  /**
   * Seconds per subsong, index 0 = subsong 1, `undefined` where the file gave
   * a time this parser could not read.
   */
  lengths: Array<number | undefined>
  /** The path within the collection, when the file carried it. */
  path?: string
}

export type SonglengthsDb = Map<string, SonglengthEntry>

const LENGTH = /^(\d+):(\d{2})(?:\.(\d{1,3}))?(?:\([A-Za-z]+\))?$/

/**
 * Every length on one entry's line, keeping each one's position.
 *
 * Dropping the tokens that fail and keeping the rest is what this used to do,
 * and it is worse than useless: the array collapses, so `4:01 ??? 0:31`
 * becomes `[241, 31]` and subsong 2 is reported as 31 seconds - subsong 3's
 * length - and the player stops it two and a half minutes early. Silent
 * misalignment is the one outcome to avoid, since nothing downstream can see
 * that it happened.
 *
 * The position is the subsong number, so an unreadable time leaves a hole
 * rather than removing the entry: the other subsongs of that tune keep their
 * real lengths, and the one in question falls back to
 * `defaultSongLengthSeconds` exactly as a tune with no entry at all does.
 * The library catalogue reads the same shape, so both readers of this file
 * format answer the same way.
 */
export function parseLengths(text: string): Array<number | undefined> {
  const out: Array<number | undefined> = []
  for (const token of text.split(/\s+/)) {
    if (!token) continue // leading or doubled whitespace, not a missing length
    out.push(parseLength(token) ?? undefined)
  }
  return out
}

export function parseLength(token: string): number | null {
  const m = LENGTH.exec(token)
  if (!m) return null
  const ms = m[3] ? Number(m[3].padEnd(3, '0')) / 1000 : 0
  return Number(m[1]) * 60 + Number(m[2]) + ms
}

/** One `md5=lengths` line of the file, with the path its comment gave it, if any. */
export interface SonglengthLine {
  md5: string
  lengths: Array<number | undefined>
  /** The comment line above it, trimmed; absent where there was none. */
  path?: string
}

/**
 * The file's grammar, once, for both of its readers: the player's lookup by
 * MD5 here, and the library's manifest by path.
 */
export function* songlengthLines(text: string): Generator<SonglengthLine> {
  let path: string | undefined
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('[')) continue
    if (line.startsWith(';')) {
      path = line.slice(1).trim() || undefined
      continue
    }
    // The comment names the entry under it and no other: taken here whether
    // or not the entry turns out to be readable, so a malformed one cannot
    // hand its path on to the next entry that has no comment of its own.
    const named = path
    path = undefined
    if (line.indexOf('=') !== 32) continue
    const md5 = line.slice(0, 32).toLowerCase()
    if (!/^[0-9a-f]{32}$/.test(md5)) continue
    yield { md5, lengths: parseLengths(line.slice(33)), ...(named ? { path: named } : {}) }
  }
}

export function parseSonglengths(text: string): SonglengthsDb {
  const db: SonglengthsDb = new Map()
  for (const { md5, lengths, path } of songlengthLines(text)) {
    if (lengths.length) db.set(md5, { lengths, path })
  }
  return db
}

/** The lengths for a tune's bytes, or null when the collection does not know it. */
export function lookupSonglengths(db: SonglengthsDb, bytes: Uint8Array): SonglengthEntry | null {
  return db.get(md5Hex(bytes)) ?? null
}
