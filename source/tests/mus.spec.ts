import { describe, it, expect } from 'vitest'
import { detectMus, readMusCredits, assembleMus, musHeader, MUS_SID2_ADDR } from '../src/sid/mus'
import { detectFormat, unsupportedMessage } from '../src/sid/detect'
import { parseWords } from '../src/sid/words'
import { readPetsciiLine } from '../src/sid/petscii'
import { SidPlayerError } from '../src/sid/types'
import { mus } from './helpers/bytes'

/** A MUS file whose three voices are just HLT, followed by credit lines. */
const makeMus = mus

describe('detectMus', () => {
  it('accepts a well-formed file and reports where the credits start', () => {
    const mus = makeMus(['A'])
    expect(detectMus(mus)).toBe(8 + 6)
  })
  it('rejects a voice that does not end in HLT', () => {
    const mus = makeMus(['A'])
    mus[9] = 0x00 // break voice 1's HLT
    expect(detectMus(mus)).toBeNull()
  })
  it('rejects a voice declared with no length, which can hold no terminator', () => {
    // A zero-length voice would put the HLT before the voice data starts,
    // which is in the length table: libsidplayfp refuses these too.
    const mus = makeMus(['A'])
    mus[2] = 0x00
    mus[3] = 0x00
    expect(detectMus(mus)).toBeNull()
  })
  it('rejects lengths that overrun the file', () => {
    const mus = makeMus(['A'])
    mus[2] = 0xff
    expect(detectMus(mus)).toBeNull()
    expect(detectMus(new Uint8Array(4))).toBeNull()
  })
})

describe('readMusCredits', () => {
  it('reads NUL-terminated lines up to the first empty one, as libsidplayfp does', () => {
    const mus = makeMus(['TITLE', 'COMPOSER'])
    const { lines, end } = readMusCredits(mus, detectMus(mus)!)
    expect(lines).toEqual(['TITLE', 'COMPOSER'])
    expect(end).toBe(mus.length)
    // Two blank lines then the terminator: reading stops at the first blank,
    // which is where an appended STR part would be looked for.
    const padded = makeMus(['TITLE', '', ''])
    const second = readMusCredits(padded, detectMus(padded)!)
    expect(second.lines).toEqual(['TITLE'])
    expect(second.end).toBe(padded.length - 2)
  })
  it('ends a line on a carriage return as well as a NUL', () => {
    // Real files use both; `isPetsciiLineEnd` takes either, and a CR still
    // leaves the credits ended by the empty line that follows.
    const mus = makeMus([])
    const text = Uint8Array.from([0x54, 0x57, 0x4f, 0x0d, 0x4c, 0x49, 0x4e, 0x45, 0x00, 0x00])
    const withCredits = new Uint8Array(mus.length - 1 + text.length)
    withCredits.set(mus.subarray(0, mus.length - 1), 0)
    withCredits.set(text, mus.length - 1)
    const { lines, end } = readMusCredits(withCredits, detectMus(withCredits)!)
    expect(lines).toEqual(['TWO', 'LINE'])
    expect(end).toBe(withCredits.length)
  })

  /*
   * A crafted file must not become half a million DOM nodes in the song
   * information panel. The walk still has to reach the end of the credits,
   * because that offset is where libsidplayfp looks for an appended STR
   * part: capping the lines must not cost a stereo tune its second SID.
   */
  it('caps the line count and still finds the end of the credits', () => {
    const many = Array.from({ length: 2000 }, () => 'A')
    const mus = makeMus(many)
    const str = makeMus(['RIGHT'])
    const combined = new Uint8Array(mus.length + str.length)
    combined.set(mus)
    combined.set(str, mus.length)
    const { lines, end } = readMusCredits(combined, detectMus(combined)!)
    expect(lines).toHaveLength(500)
    expect(end).toBe(mus.length)
    const tune = assembleMus(combined)
    expect(tune.stereo).toBe(true)
    expect(tune.strCredits).toEqual(['RIGHT'])
  })

  it('converts PETSCII as libsidplayfp does', () => {
    // Shifted letters (0xC1..) are graphics in upstream's table, quotes are dropped,
    // 0x9D deletes the previous character, and lines are capped at 32 characters.
    const bytes = Uint8Array.from([0x41, 0x42, 0x22, 0x43, 0x9d, 0x44, 0x00])
    expect(readPetsciiLine(bytes, 0).text).toBe('ABD')
    const long = Uint8Array.from([...Array.from({ length: 40 }, () => 0x58), 0x00])
    expect(readPetsciiLine(long, 0).text).toHaveLength(32)
  })
})

describe('assembleMus', () => {
  it('returns a mono tune as-is', () => {
    const mus = makeMus(['MONO'])
    const tune = assembleMus(mus)
    expect(tune.stereo).toBe(false)
    expect(tune.bytes).toBe(mus)
    expect(tune.credits).toEqual(['MONO'])
  })
  it('appends an STR part after the MUS credits', () => {
    const mus = makeMus(['LEFT'])
    const str = makeMus(['RIGHT'])
    const tune = assembleMus(mus, str)
    expect(tune.stereo).toBe(true)
    expect(tune.bytes.length).toBe(mus.length + str.length)
    expect(tune.strCredits).toEqual(['RIGHT'])
    // The STR data must start exactly where libsidplayfp will look for it.
    expect(detectMus(tune.bytes, mus.length)).not.toBeNull()
  })
  it('recognises an STR part already embedded in one file', () => {
    const mus = makeMus(['LEFT'])
    const str = makeMus(['RIGHT'])
    const combined = new Uint8Array(mus.length + str.length)
    combined.set(mus)
    combined.set(str, mus.length)
    const tune = assembleMus(combined)
    expect(tune.stereo).toBe(true)
    expect(tune.credits).toEqual(['LEFT'])
    expect(tune.strCredits).toEqual(['RIGHT'])
  })
  it('handles a voice with no notes at all', () => {
    // Two bytes of HLT is a legal voice and several real files have one.
    const mus = makeMus(['QUIET'], [[], [], []])
    const tune = assembleMus(mus)
    expect(tune.stereo).toBe(false)
    expect(tune.scoreBytes).toBe(6)
    expect(musHeader(tune).dataLength).toBe(6)
  })

  it('rejects bad data with a friendly code', () => {
    expect(() => assembleMus(new Uint8Array(20))).toThrowError(SidPlayerError)
  })

  /*
   * The .str is an extra: three more voices for a second SID. A damaged one,
   * or another file that merely shares the base name, used to make its .mus
   * unopenable from every entry point there is.
   */
  it('plays a tune in mono when the .str beside it is not Sidplayer data', () => {
    const tune = assembleMus(makeMus(['OK']), new Uint8Array(20))
    expect(tune.stereo).toBe(false)
    expect(tune.credits).toEqual(['OK'])
    expect(musHeader(tune).secondSidAddress).toBeNull()
  })
})

describe('musHeader', () => {
  it('maps the first three credit lines and marks stereo', () => {
    const h = musHeader(assembleMus(makeMus(['SONG', 'WHO', '1987', 'EXTRA']), makeMus(['R'])))
    expect(h.format).toBe('MUS+STR')
    expect(h.name).toBe('SONG')
    expect(h.author).toBe('WHO')
    expect(h.released).toBe('1987')
    expect(h.secondSidAddress).toBe(MUS_SID2_ADDR)
    expect(h.songs).toBe(1)
    // The score of both parts, not the buffer: six voices of two bytes each,
    // without either length table or a byte of the credit text.
    expect(h.dataLength).toBe(12)
    expect(h.comments).toEqual(['SONG', 'WHO', '1987', 'EXTRA', 'R'])
  })
})

describe('detectFormat and unsupportedMessage', () => {
  it('tells the formats apart by content', () => {
    expect(detectFormat(Uint8Array.from([0x50, 0x53, 0x49, 0x44, 0, 2]))).toBe('psid')
    expect(detectFormat(Uint8Array.from([0x52, 0x53, 0x49, 0x44, 0, 2]))).toBe('rsid')
    expect(detectFormat(makeMus(['X']))).toBe('mus')
    const sidmon = new Uint8Array(200)
    const magic = 'SIDMON II - THE MIDI VERSION'
    for (let i = 0; i < magic.length; i++) sidmon[40 + i] = magic.charCodeAt(i)
    expect(detectFormat(sidmon)).toBe('sidmon2')
    expect(detectFormat(new Uint8Array(50))).toBe('unknown')
  })
  it('names the real reason where it can', () => {
    expect(unsupportedMessage(new Uint8Array(20), 'x.str')).toMatch(/stereo half/)
    expect(unsupportedMessage(new Uint8Array(20), 'x.wds')).toMatch(/words file/)
    expect(unsupportedMessage(new Uint8Array(20), 'x.sid')).toMatch(/SidMon/)
    expect(unsupportedMessage(new Uint8Array(20), 'x.bin')).toBe('This file is not a PSID or RSID tune.')
  })
})

describe('parseWords', () => {
  it('skips the load address, splits on NUL and return, drops control bytes and collapses blanks', () => {
    const text = [
      0x00,
      0x09,
      ...'LA LA LA'.split('').map((c) => c.charCodeAt(0)),
      0x0d,
      0x93,
      0x00,
      0x00,
      ...'SECOND'.split('').map((c) => c.charCodeAt(0)),
      0x00
    ]
    expect(parseWords(Uint8Array.from(text))).toEqual(['LA LA LA', '', 'SECOND'])
    expect(parseWords(new Uint8Array(2))).toEqual([])
  })
})
