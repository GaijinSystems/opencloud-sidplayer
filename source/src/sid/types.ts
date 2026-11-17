/**
 * Contract between the UI and everything that touches SID bytes or audio.
 * The UI never sees the engine directly; it sees a parsed header, a player
 * state, and these errors.
 */

/** PSID and RSID are the header formats; MUS and MUS+STR are Compute!'s Sidplayer files. */
export type SidFormat = 'PSID' | 'RSID' | 'MUS' | 'MUS+STR'
export type SidClock = 'unknown' | 'PAL' | 'NTSC' | 'PAL and NTSC'
export type SidModel = 'unknown' | 'MOS6581' | 'MOS8580' | 'MOS6581 and MOS8580'

/** Everything the PSID/RSID header declares, decoded. */
export interface SidHeader {
  format: SidFormat
  /** Header version 1..4 for PSID/RSID; 0 for a MUS file, which has none. */
  version: number
  /** Offset of the C64 data within the file. */
  dataOffset: number
  /** Where the data loads in C64 memory. Read from the data when the header says 0. */
  loadAddress: number
  initAddress: number
  /** 0 means the init routine installs its own interrupt handler. */
  playAddress: number
  /** Number of subsongs, 1..256. */
  songs: number
  /** Default subsong, 1-based. */
  startSong: number
  /** Raw speed bitfield; use `speedOf` rather than reading it directly. */
  speed: number
  name: string
  author: string
  released: string
  /** v2+ only; false for v1. */
  musPlayer: boolean
  /** PSID: uses PlaySID-specific features. RSID: is a C64 BASIC program. */
  playSidSpecific: boolean
  clock: SidClock
  sidModel: SidModel
  secondSidModel: SidModel
  thirdSidModel: SidModel
  /** Absolute addresses, present for v3/v4 when the header names them. */
  secondSidAddress: number | null
  thirdSidAddress: number | null
  /**
   * Bytes of C64 data after the header (and after an embedded load address).
   * For a MUS tune, which has no such header, the score: the three voices of
   * each part, without the length tables or the credit text. Both are the
   * music rather than the file, so the one label over them compares.
   */
  dataLength: number
  /** Free-text lines the file carries: a MUS file's credits. PSID has none. */
  comments?: string[]
}

/** Raised for every failure the UI is expected to render as a friendly state. */
export class SidPlayerError extends Error {
  constructor(
    public readonly code:
      'unsupported-format' | 'corrupt' | 'too-large' | 'network' | 'backend-unavailable' | 'engine',
    message: string,
    public override readonly cause?: unknown
  ) {
    super(message)
    this.name = 'SidPlayerError'
  }
}
