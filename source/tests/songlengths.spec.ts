import { describe, it, expect } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { md5Hex } from '../src/sid/md5'
import { lookupSonglengths, parseLength, parseLengths, parseSonglengths } from '../src/sid/songlengths'

describe('md5Hex', () => {
  it('matches the reference vectors', () => {
    const enc = (s: string) => new TextEncoder().encode(s)
    expect(md5Hex(enc(''))).toBe('d41d8cd98f00b204e9800998ecf8427e')
    expect(md5Hex(enc('abc'))).toBe('900150983cd24fb0d6963f7d28e17f72')
    expect(md5Hex(enc('The quick brown fox jumps over the lazy dog'))).toBe('9e107d9d372bb6826bd81d3542a419d6')
  })
  it('agrees with Node across padding boundaries and typical SID sizes', () => {
    for (const size of [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 163, 1000, 4097, 65536 + 124]) {
      const bytes = new Uint8Array(randomBytes(size))
      expect(md5Hex(bytes)).toBe(createHash('md5').update(bytes).digest('hex'))
    }
  })
})

describe('parseLength', () => {
  it('reads minutes, seconds, milliseconds and ignores flags', () => {
    expect(parseLength('4:01')).toBe(241)
    expect(parseLength('0:37(G)')).toBe(37)
    expect(parseLength('0:23.560')).toBeCloseTo(23.56)
    expect(parseLength('1:02.5(M)')).toBeCloseTo(62.5)
    expect(parseLength('nonsense')).toBeNull()
    // A tune the collection lists as silent, which is a length and not a
    // failure to read one.
    expect(parseLength('0:00')).toBe(0)
  })
})

describe('parseLengths', () => {
  it('keeps every length in its own place', () => {
    expect(parseLengths('4:01 0:37(G) 0:31')).toEqual([241, 37, 31])
    /*
     * The old walker dropped what it could not read and kept the rest, which
     * turned this into [241, 31]: subsong 2 reported as 31 seconds, which is
     * subsong 3's length, and the player stopping it two and a half minutes
     * early with nothing to say it had. The hole keeps subsongs 1 and 3
     * honest and lets 2 fall back to the configured length.
     */
    expect(parseLengths('4:01 ??? 0:31')).toEqual([241, undefined, 31])
    expect(parseLengths('')).toEqual([])
  })

  it('is not thrown by the spacing around the lengths', () => {
    expect(parseLengths('  4:01   0:31  ')).toEqual([241, 31])
  })
})

describe('parseSonglengths', () => {
  const text = [
    '[Database]',
    '; /MUSICIANS/H/Hubbard_Rob/Commando.sid',
    'e9c1b52f7f9c5d8d0e2c2f3a1b4c5d6e=4:01 0:37(G) 0:31',
    '',
    '; /DEMOS/0-9/1_45_Tune.sid',
    'ABCDEF0123456789ABCDEF0123456789=0:23.560',
    'not a line at all',
    '0123456789abcdef0123456789abcdef=',
    'deadbeefdeadbeefdeadbeefdeadbeef=1:00'
  ].join('\r\n')

  it('keys by lowercase md5 and keeps the path from the comment above', () => {
    const db = parseSonglengths(text)
    expect(db.size).toBe(3)
    expect(db.get('e9c1b52f7f9c5d8d0e2c2f3a1b4c5d6e')).toEqual({
      lengths: [241, 37, 31],
      path: '/MUSICIANS/H/Hubbard_Rob/Commando.sid'
    })
    expect(db.get('abcdef0123456789abcdef0123456789')?.lengths[0]).toBeCloseTo(23.56)
    // A comment does not leak onto an unrelated later entry.
    expect(db.get('deadbeefdeadbeefdeadbeefdeadbeef')?.path).toBeUndefined()
  })

  it('leaves a hole for a length it cannot read rather than shifting the rest', () => {
    const db = parseSonglengths(
      [
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=4:01 ??? 0:31',
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb=4:01 0:37 0:31'
      ].join('\n')
    )
    // Subsong 3 is still subsong 3, and only subsong 2 is unknown.
    expect(db.get('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')?.lengths).toEqual([241, undefined, 31])
    expect(db.get('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')?.lengths).toEqual([241, 37, 31])
  })

  it('does not let a malformed entry hand its path on to the next one', () => {
    const db = parseSonglengths(
      ['; /MUSICIANS/A/Broken.sid', 'not-an-md5=3:00', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=1:00'].join('\n')
    )
    expect(db.get('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')?.path).toBeUndefined()
  })

  it('keeps a 0:00 subsong, which the collection does list', () => {
    const db = parseSonglengths('cccccccccccccccccccccccccccccccc=0:00 1:00')
    expect(db.get('cccccccccccccccccccccccccccccccc')?.lengths).toEqual([0, 60])
  })

  it('looks a tune up by its whole-file md5', () => {
    const bytes = new TextEncoder().encode('pretend this is a SID file')
    const db = parseSonglengths(`${md5Hex(bytes)}=2:30 0:10`)
    expect(lookupSonglengths(db, bytes)?.lengths).toEqual([150, 10])
    expect(lookupSonglengths(db, new Uint8Array([1, 2, 3]))).toBeNull()
  })
})
