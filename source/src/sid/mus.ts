import { musVoiceTable } from './musLength'
import { readPetsciiLine } from './petscii'
import { SidPlayerError, type SidHeader } from './types'

/**
 * Compute!'s Sidplayer files: `.mus` holds three voices plus credit lines,
 * an optional `.str` beside it holds three more voices for a second SID
 * (the "stereo" Sidplayer), and `.wds` holds words to sing along to.
 *
 * libsidplayfp plays MUS directly from a buffer, and accepts a stereo pair as
 * one buffer with the STR data appended after the MUS data. The layout, as
 * its `MUS::detect` reads it:
 *
 *   0x00  2  load address (ignored; the player loads at $0900)
 *   0x02  2  length of voice 1 data, little-endian
 *   0x04  2  length of voice 2 data
 *   0x06  2  length of voice 3 data
 *   0x08     voice 1, voice 2, voice 3 data, each ending in HLT ($01 $4F)
 *            credit lines: PETSCII, NUL-terminated, ended by an empty line
 *            optionally a second MUS structure (the STR part) follows
 */

const HLT_HI = 0x01
const HLT_LO = 0x4f
/** Where libsidplayfp loads MUS data and puts the second SID. */
const MUS_DATA_ADDR = 0x0900
export const MUS_SID2_ADDR = 0xd500

/**
 * Checks the voice-length table and the three HLT terminators, exactly as
 * libsidplayfp does. Returns the offset of the credits (the end of voice 3)
 * relative to `offset`, or null when this is not MUS data.
 */
export function detectMus(bytes: Uint8Array, offset = 0): number | null {
  const voices = musVoiceTable(bytes, offset)
  if (!voices) return null
  const hltAt = (end: number) =>
    end >= 2 && bytes[offset + end - 2] === HLT_HI && bytes[offset + end - 1] === HLT_LO
  const ends = voices.map((v) => v.at + v.length)
  return ends.every(hltAt) ? ends[2] : null
}

/**
 * The most credit lines a file is allowed to contribute. Real Sidplayer
 * files carry a handful; the cap is there because a crafted one need not.
 * A 1 MB file - the default `maxFileSizeKb` - whose credit area is
 * `41 00 41 00 ...` holds about 500,000 one-character lines, and every one of
 * them would become a `div` in the song information panel. `words.ts` caps
 * its lyrics at the same 500 for the same reason.
 */
const MAX_CREDIT_LINES = 500

/**
 * Reads the credit lines that follow the voice data: NUL-terminated PETSCII,
 * ended by an empty line. Returns the lines and the offset just past the
 * terminating empty line, which is where an appended STR part would begin.
 */
export function readMusCredits(bytes: Uint8Array, from: number): { lines: string[]; end: number } {
  const lines: string[] = []
  let i = from
  while (i < bytes.length && bytes[i] !== 0x00) {
    const { text, next } = readPetsciiLine(bytes, i)
    // Past the cap the lines are dropped but the walk carries on, because
    // `end` is where libsidplayfp looks for an appended STR part: stopping
    // early here would put the second SID's data at the wrong offset and
    // silently turn a stereo tune into a mono one.
    if (lines.length < MAX_CREDIT_LINES) lines.push(text)
    i = next
  }
  if (i < bytes.length) i++ // the empty line that ends the credits
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return { lines, end: i }
}

export interface MusTune {
  /** What to hand the engine: MUS data, with the STR part appended when there is one. */
  bytes: Uint8Array
  stereo: boolean
  /** Credit lines from the MUS part, PETSCII converted. */
  credits: string[]
  /** Credit lines from the STR part, when there is one. */
  strCredits: string[]
  /**
   * The score itself, in bytes: the three voices of each part, without the
   * length tables, the credit text or anything trailing. This is the figure
   * worth showing beside a PSID's data length, which counts C64 data and not
   * the file's own bookkeeping.
   */
  scoreBytes: number
}

/** The three declared voice lengths of a MUS structure, added up. */
const voiceBytes = (bytes: Uint8Array, offset = 0): number =>
  (musVoiceTable(bytes, offset) ?? []).reduce((sum, voice) => sum + voice.length, 0)

/**
 * Validates a MUS file and, when given, its STR companion, and assembles
 * what the engine wants. A single file that already carries an appended STR
 * part is recognised too, as libsidplayfp recognises it.
 */
export function assembleMus(mus: Uint8Array, str?: Uint8Array | null): MusTune {
  const voice3 = detectMus(mus)
  if (voice3 === null) {
    throw new SidPlayerError(
      'corrupt',
      'This is not a Sidplayer MUS file: the voice table or terminators are wrong.'
    )
  }
  const musCredits = readMusCredits(mus, voice3)

  if (str && str.length) {
    const strVoice3 = detectMus(str)
    if (strVoice3 === null) {
      // The tune itself is fine, so it is played in mono rather than refused.
      // A .str that is damaged, or simply another file that happens to share
      // the base name, used to make its .mus unopenable from every entry
      // point - the .mus, the .wds and the picture alike - for the sake of
      // three voices that are an extra rather than the tune.
      console.info('[sidplayer] the .str beside this tune is not Sidplayer data; playing it in mono')
    } else {
      const combined = new Uint8Array(musCredits.end + str.length)
      // Only the MUS part up to the end of its credits: trailing bytes after
      // the credits would otherwise sit between the two parts.
      combined.set(mus.subarray(0, musCredits.end), 0)
      combined.set(str, musCredits.end)
      return {
        bytes: combined,
        stereo: true,
        credits: musCredits.lines,
        strCredits: readMusCredits(str, strVoice3).lines,
        scoreBytes: voiceBytes(mus) + voiceBytes(str)
      }
    }
  }

  // An STR part may already be appended inside the one file.
  const embedded = detectMus(mus, musCredits.end)
  if (embedded !== null) {
    return {
      bytes: mus,
      stereo: true,
      credits: musCredits.lines,
      strCredits: readMusCredits(mus, musCredits.end + embedded).lines,
      scoreBytes: voiceBytes(mus) + voiceBytes(mus, musCredits.end)
    }
  }

  return {
    bytes: mus,
    stereo: false,
    credits: musCredits.lines,
    strCredits: [],
    scoreBytes: voiceBytes(mus)
  }
}

/**
 * A header-shaped description of a MUS tune, so the rest of the app can
 * treat it like a PSID. Sidplayer tunes are single-song and CIA-timed; the
 * player's own addresses are libsidplayfp's business and are reported as 0.
 * The first three credit lines conventionally read title, composer and a
 * year or arranger, which is how HVSC's PSID conversions of these files
 * fill their name, author and released fields.
 */
export function musHeader(tune: MusTune): SidHeader {
  const [name = '', author = '', released = ''] = tune.credits
  return {
    format: tune.stereo ? 'MUS+STR' : 'MUS',
    version: 0,
    dataOffset: 0,
    loadAddress: MUS_DATA_ADDR,
    initAddress: 0,
    playAddress: 0,
    songs: 1,
    startSong: 1,
    speed: 1, // bit 0 set: CIA, as the player runs it
    name,
    author,
    released,
    musPlayer: true,
    playSidSpecific: false,
    clock: 'unknown',
    sidModel: 'unknown',
    secondSidModel: 'unknown',
    thirdSidModel: 'unknown',
    secondSidAddress: tune.stereo ? MUS_SID2_ADDR : null,
    thirdSidAddress: null,
    // The score, not the buffer: `dataLength` is C64 data everywhere else it
    // is read, and the buffer handed to the engine also carries the 8-byte
    // length table of each part and the credit text, which the PSID figure
    // beside it in the song information panel does not count.
    dataLength: tune.scoreBytes,
    comments: [...tune.credits, ...tune.strCredits]
  }
}
