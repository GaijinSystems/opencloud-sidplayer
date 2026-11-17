import { songlengthLines } from '../sid/songlengths'
import { validCollectionPath } from './sync'
import { rooted } from '../sid/source'

/**
 * `DOCUMENTS/Songlengths.md5`, read as a list of files rather than as a
 * lookup table.
 *
 * The player already parses this file (`src/sid/songlengths.ts`), but keyed
 * by MD5, because what it has in hand is a tune's bytes. The library wants
 * the other direction: every path in the collection, which is what makes this
 * file the collection's manifest as well as its length database.
 *
 * Release 85 has 61,157 entries and 61,157 distinct MD5s, so today the two
 * readings hold the same information. Keying by path anyway costs nothing and
 * survives a release that files one rip in two places, which HVSC's own
 * update notes show it occasionally does before eliminating the repeat.
 */

export interface ManifestEntry {
  /** Collection path with a leading slash: `/MUSICIANS/H/Hubbard_Rob/Commando.sid`. */
  path: string
  /** Whole-file MD5, lower case. */
  md5: string
  /**
   * Seconds per subsong, index 0 = subsong 1, `undefined` where the file
   * gave a time this parser could not read. The position is kept because it
   * is the subsong number; dropping the unreadable ones would slide every
   * later subsong one place to the left and quietly report the wrong length
   * for each of them.
   */
  lengths: Array<number | undefined>
}

export interface Manifest {
  entries: ManifestEntry[]
  /** Entries whose comment line was missing, which would be a broken file. */
  skipped: number
  /**
   * Entries whose path was not one this app will act on: outside the three
   * collection folders, not a `.sid`, or carrying `.` or `..` segments.
   * Counted rather than silently dropped so a caller can tell a manifest it
   * does not understand from one that is simply short.
   */
  rejected: number
}

/**
 * Parses the whole manifest. The path arrives in the comment line above each
 * `md5=lengths` line, so the two are read as a pair; a line without a path
 * above it is counted and dropped, since it cannot be placed.
 */
export function parseManifest(text: string): Manifest {
  const entries: ManifestEntry[] = []
  let skipped = 0
  let rejected = 0
  for (const { md5, lengths, path: named } of songlengthLines(text)) {
    if (!named) {
      skipped++
      continue
    }
    const path = rooted(named)
    if (!validCollectionPath(path)) {
      rejected++
      continue
    }
    // The same reader the player uses, so the one file format has one
    // meaning: a time that cannot be read leaves a hole at that subsong's
    // position rather than shifting every later one down a place.
    entries.push({ path, md5, lengths })
  }
  return { entries, skipped, rejected }
}
