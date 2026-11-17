/**
 * SID and Sidplayer files built byte by byte, for anything that needs a tune
 * without a fixture file: the fixture generator itself, the browser drivers'
 * miniature collections, and the specs (through `tests/helpers/bytes.ts`).
 *
 * There were seven copies of the header builder and four of the MUS one, and
 * they had drifted in small ways - a text field capped at 31 characters here
 * and 32 there, different flags, different play addresses. None of that is
 * decided here. Every difference is a parameter, and each caller passes what
 * its own copy used to hard-code, so the bytes each one produces are the
 * bytes it produced before.
 *
 * Importing this does nothing: no output and no files. It has no imports of
 * its own, so it loads the same under Node and under Vitest.
 */

/* ---- 6502, as much of it as a test tune needs ---------------------------- */

export const lda = (v) => [0xa9, v]
export const sta = (addr) => [0x8d, addr & 0xff, addr >> 8]

/* ---- PSID / RSID --------------------------------------------------------- */

// PAL (bits 2-3 = 01), MOS6581 (bits 4-5 = 01).
export const FLAGS_PAL_6581 = 0x04 | 0x10
// The same, asking for a MOS8580 (bits 4-5 = 10).
export const FLAGS_PAL_8580 = 0x04 | 0x20

/**
 * A PSID or RSID file: the header, then `data`.
 *
 * A version 1 header is 0x76 bytes and stops before the flags; anything later
 * is 0x7c and carries the flags and the two extra SID addresses. The text
 * fields are written one byte per character and cut at `textLimit`: the
 * fields are 32 bytes wide, and 31 leaves the terminating NUL some readers
 * expect.
 *
 * The defaults are the least a header can say - one song, loaded and started
 * at $1000, no play routine, no names - so a caller states everything it
 * means and nothing arrives by accident.
 */
export function sidFile({
  magic = 'PSID',
  version = 2,
  loadAddress = 0x1000,
  initAddress = 0x1000,
  playAddress = 0,
  songs = 1,
  startSong = 1,
  speed = 0,
  name = '',
  author = '',
  released = '',
  flags = 0,
  secondSid = 0,
  thirdSid = 0,
  textLimit = 32,
  data = []
} = {}) {
  const headerLength = version === 1 ? 0x76 : 0x7c
  const bytes = new Uint8Array(headerLength + data.length)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < 4; i++) bytes[i] = magic.charCodeAt(i)
  view.setUint16(4, version)
  view.setUint16(6, headerLength)
  view.setUint16(8, loadAddress)
  view.setUint16(10, initAddress)
  view.setUint16(12, playAddress)
  view.setUint16(14, songs)
  view.setUint16(16, startSong)
  view.setUint32(18, speed)
  const put = (offset, text) => {
    for (let i = 0; i < text.length && i < textLimit; i++) bytes[offset + i] = text.charCodeAt(i)
  }
  put(0x16, name)
  put(0x36, author)
  put(0x56, released)
  if (version >= 2) {
    view.setUint16(0x76, flags)
    bytes[0x7a] = secondSid
    bytes[0x7b] = thirdSid
  }
  bytes.set(data, headerLength)
  return bytes
}

/* ---- Compute!'s Sidplayer ------------------------------------------------ */

export const petscii = (s) => Array.from(s, (c) => c.charCodeAt(0))

/** The command that ends a voice. */
export const HLT = [0x01, 0x4f]

/**
 * A Sidplayer file: a load address the player ignores, three little-endian
 * voice lengths, the voices, then NUL-terminated PETSCII credit lines ended
 * by an empty line.
 *
 * `voices` is what each voice plays before its HLT, which is added here. With
 * none given the tune is silent but structurally complete: enough for
 * libsidplayfp to install its Sidplayer driver, accept the file, and pair a
 * .str with it.
 */
export function mus(credits, voices = [[], [], []]) {
  const ended = voices.map((body) => [...body, ...HLT])
  const text = credits.flatMap((line) => [...petscii(line), 0x00]).concat([0x00])
  return Uint8Array.from([
    0x00,
    0x09, // load address, ignored by the player
    ...ended.flatMap((voice) => [voice.length & 0xff, voice.length >> 8]), // voice lengths, little-endian
    ...ended.flat(),
    ...text
  ])
}
