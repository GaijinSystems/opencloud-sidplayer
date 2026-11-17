/**
 * Tunes built byte by byte, for specs that must not depend on fixture files.
 *
 * The builders themselves are `scripts/sid-bytes.mjs`, which the fixture
 * generator and the browser drivers use too, so a spec and the script that
 * writes `tests/fixtures/` cannot come to disagree about what a header is.
 * That file is plain JavaScript because Node runs it as it stands; this one
 * says what its types are.
 */
// @ts-expect-error -- plain JavaScript with no declarations; the types are given below
import * as built from '../../scripts/sid-bytes.mjs'

/** Every field is optional; see `sidFile` in the script for the defaults. */
export interface SidFileFields {
  magic?: string
  version?: number
  loadAddress?: number
  initAddress?: number
  playAddress?: number
  songs?: number
  startSong?: number
  speed?: number
  name?: string
  author?: string
  released?: string
  flags?: number
  secondSid?: number
  thirdSid?: number
  /** How many characters of each text field are written; the fields hold 32. */
  textLimit?: number
  /** What follows the header. */
  data?: ArrayLike<number>
}

/** A PSID or RSID file: the header, then `data`. */
export const sidFile: (fields?: SidFileFields) => Uint8Array = built.sidFile

/**
 * A Sidplayer file. `voices` is what each of the three plays before its HLT,
 * which the builder adds; with none given the tune is silent.
 */
export const mus: (credits: string[], voices?: number[][]) => Uint8Array = built.mus

export const FLAGS_PAL_6581: number = built.FLAGS_PAL_6581

/**
 * The 128 bytes the library reads from the front of a tune: a PSID v2 header
 * with the fields the list and the filters want, PAL and 6581, and nothing
 * after it but padding. The text fields are cut at 31 characters.
 */
export const psidHeader = (name: string, author: string, released: string, songs = 1): Uint8Array =>
  sidFile({
    name,
    author,
    released,
    songs,
    playAddress: 0x1006,
    flags: FLAGS_PAL_6581,
    textLimit: 31,
    data: new Uint8Array(128 - 0x7c)
  })
