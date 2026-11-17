import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  C64_PALETTE,
  decodePicture,
  PICTURE_EXTENSIONS,
  PICTURE_HEIGHT,
  PICTURE_WIDTH,
  unpack
} from '../src/sid/picture'

const KOALA = 10001
const DOODLE = 9216

/** A whole file: the two-byte load address, then a body of the right length. */
function file(load: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 2)
  out[0] = load & 0xff
  out[1] = load >> 8
  out.set(body, 2)
  return out
}

const koalaBody = (
  fill: Partial<{ bitmap: Uint8Array; screen: Uint8Array; colour: Uint8Array; bg: number }> = {}
) => {
  const body = new Uint8Array(KOALA)
  if (fill.bitmap) body.set(fill.bitmap, 0)
  if (fill.screen) body.set(fill.screen, 8000)
  if (fill.colour) body.set(fill.colour, 9000)
  body[10000] = fill.bg ?? 0
  return body
}

const doodleBody = (screen: Uint8Array, bitmap: Uint8Array) => {
  const body = new Uint8Array(DOODLE)
  body.set(screen, 0)
  body.set(bitmap, 1024)
  return body
}

/** The colour at one pixel, as a palette index. */
function indexAt(pixels: Uint8ClampedArray, x: number, y: number): number {
  const o = (y * PICTURE_WIDTH + x) * 4
  const rgb = [pixels[o], pixels[o + 1], pixels[o + 2]]
  return C64_PALETTE.findIndex((c) => c[0] === rgb[0] && c[1] === rgb[1] && c[2] === rgb[2])
}

describe('picture formats', () => {
  it('knows the three extensions the add-on uses', () => {
    expect([...PICTURE_EXTENSIONS].sort()).toEqual(['pgg', 'pic', 'pjj'])
  })

  it('tells Koala from Doodle by the load address', () => {
    expect(decodePicture(file(0x6000, koalaBody()))?.format).toBe('koala')
    expect(decodePicture(file(0x5c00, doodleBody(new Uint8Array(1024), new Uint8Array(8192))))?.format).toBe(
      'doodle'
    )
  })

  it('refuses anything loading somewhere else', () => {
    expect(decodePicture(file(0x0801, new Uint8Array(KOALA)))).toBeNull()
    expect(decodePicture(new Uint8Array([0x00, 0x60]))).toBeNull()
    expect(decodePicture(new Uint8Array(0))).toBeNull()
  })

  it('fills a whole 320x200 in RGBA', () => {
    const picture = decodePicture(file(0x6000, koalaBody()))
    expect(picture?.width).toBe(PICTURE_WIDTH)
    expect(picture?.height).toBe(PICTURE_HEIGHT)
    expect(picture?.pixels.length).toBe(PICTURE_WIDTH * PICTURE_HEIGHT * 4)
    // Opaque everywhere: a C64 screen has no transparency.
    expect([...picture!.pixels.filter((_, i) => i % 4 === 3)].every((a) => a === 255)).toBe(true)
  })
})

describe('Koala, multicolour', () => {
  /*
   * One cell, one row of it: bit pairs 00 01 10 11 select, in order, the
   * background, the screen byte's high nibble, its low nibble and the
   * colour byte. 0b00011011 is exactly that sequence.
   */
  const bitmap = new Uint8Array(8000)
  bitmap[0] = 0b00011011
  const screen = new Uint8Array(1000)
  screen[0] = 0x5a
  const colour = new Uint8Array(1000)
  colour[0] = 0x0c
  const picture = decodePicture(file(0x6000, koalaBody({ bitmap, screen, colour, bg: 7 })))!

  it('reads the four sources in bit-pair order', () => {
    expect(indexAt(picture.pixels, 0, 0)).toBe(7) // 00 -> background
    expect(indexAt(picture.pixels, 2, 0)).toBe(5) // 01 -> screen high
    expect(indexAt(picture.pixels, 4, 0)).toBe(10) // 10 -> screen low
    expect(indexAt(picture.pixels, 6, 0)).toBe(12) // 11 -> colour
  })

  it('draws each pixel two across, since it is 160 wide', () => {
    for (const x of [0, 2, 4, 6]) {
      expect(indexAt(picture.pixels, x, 0)).toBe(indexAt(picture.pixels, x + 1, 0))
    }
  })

  it('leaves the row below this one on the background', () => {
    expect(indexAt(picture.pixels, 0, 1)).toBe(7)
  })
})

describe('Doodle, high resolution', () => {
  const bitmap = new Uint8Array(8192)
  bitmap[0] = 0b10000001
  const screen = new Uint8Array(1024)
  screen[0] = 0x1e
  const picture = decodePicture(file(0x5c00, doodleBody(screen, bitmap)))!

  it('takes a set bit from the high nibble and a clear one from the low', () => {
    expect(indexAt(picture.pixels, 0, 0)).toBe(1) // set   -> 0x1e >> 4
    expect(indexAt(picture.pixels, 1, 0)).toBe(14) // clear -> 0x1e & 15
    expect(indexAt(picture.pixels, 7, 0)).toBe(1)
  })

  it('is one pixel per bit across the full width', () => {
    expect(indexAt(picture.pixels, 0, 0)).not.toBe(indexAt(picture.pixels, 1, 0))
  })
})

describe('the packer', () => {
  it('repeats a byte the given number of times', () => {
    expect([...unpack(Uint8Array.from([0xfe, 0xaa, 0x03]))]).toEqual([0xaa, 0xaa, 0xaa])
  })

  it('treats a count of zero as a full 256', () => {
    expect(unpack(Uint8Array.from([0xfe, 0x01, 0x00])).length).toBe(256)
  })

  it('passes other bytes through', () => {
    expect([...unpack(Uint8Array.from([1, 2, 0xfe, 9, 2, 3]))]).toEqual([1, 2, 9, 9, 3])
  })

  it('carries a literal $FE as a run of one', () => {
    expect([...unpack(Uint8Array.from([0xfe, 0xfe, 0x01, 0x42]))]).toEqual([0xfe, 0x42])
  })

  it('copies a marker with no room left for its operands', () => {
    expect([...unpack(Uint8Array.from([0x11, 0xfe, 0x22]))]).toEqual([0x11, 0xfe, 0x22])
  })

  it('stops at the limit it is given, inside a run and not only before it', () => {
    // The check used to sit before each run, so a run of 256 met at the
    // limit carried the output up to 255 bytes past what was asked for.
    expect(unpack(Uint8Array.from([0xfe, 0x01, 0x00]), 10)).toHaveLength(10)
    expect(unpack(Uint8Array.from([0xfe, 0x01, 0x00, 0xfe, 0x02, 0x00]), 300)).toHaveLength(300)
  })
})

describe('packed pictures', () => {
  /** A whole Koala as runs: 39 of 256 bytes, then the 17 that are left. */
  const packedKoala = Uint8Array.from([
    ...new Array(39).fill([0xfe, 0x00, 0x00]).flat(),
    ...new Array(KOALA - 39 * 256).fill(0)
  ])

  it('unpacks a stream that expands to the size a Koala wants', () => {
    expect(unpack(packedKoala).length).toBe(KOALA)
    expect(decodePicture(file(0x6000, packedKoala))?.packed).toBe(true)
  })

  it('refuses a short stream that expands to nothing like a picture', () => {
    expect(decodePicture(file(0x6000, Uint8Array.from([0xfe, 0x00, 0x00])))).toBeNull()
  })

  it('takes a short file that does not expand as whole rather than packed', () => {
    const short = koalaBody().subarray(0, 9228)
    const picture = decodePicture(file(0x6000, short))
    expect(picture?.packed).toBe(false)
    expect(picture?.format).toBe('koala')
  })

  it('does not unpack a whole file that happens to contain $FE', () => {
    const body = koalaBody()
    body[100] = 0xfe
    const picture = decodePicture(file(0x6000, body))
    expect(picture?.packed).toBe(false)
  })

  /*
   * The shape that used to be misread. A whole Koala trimmed to about 9,500
   * bytes with one `FE 00 00` in it expands to roughly 9,753: longer than
   * the file, and inside the window a whole picture occupies, which was the
   * whole of the old test. It was then drawn from the expansion, which is
   * garbage. A real packed file lands on exactly the length its format
   * wants - 10,001 for a Koala - and all 63 in the add-on do.
   */
  it('does not call a trimmed whole file packed because it grew into the window', () => {
    const body = koalaBody().subarray(0, 9500).slice()
    body[4000] = 0xfe
    body[4001] = 0x00
    body[4002] = 0x00
    const picture = decodePicture(file(0x6000, body))
    expect(picture?.packed).toBe(false)
    expect(picture?.format).toBe('koala')
  })

  it('takes a short Doodle of 9,024 bytes as packed, since that is a whole one', () => {
    // 1,024 of screen and the 8,000 bytes a 320x200 picture uses: four of
    // the six .pjj files in the add-on unpack to exactly this.
    const packed = Uint8Array.from([
      ...new Array(35).fill([0xfe, 0x00, 0x00]).flat(),
      ...new Array(9024 - 35 * 256).fill(0)
    ])
    expect(unpack(packed).length).toBe(9024)
    expect(decodePicture(file(0x5c00, packed))?.packed).toBe(true)
  })

  it('pads a file that is a few bytes short rather than refusing it', () => {
    // Real .pic files in the add-on run from 9,217 to 10,131 bytes.
    const short = koalaBody().subarray(0, KOALA - 2)
    expect(decodePicture(file(0x6000, short))?.format).toBe('koala')
  })

  it('ignores trailing junk on a file that is a few bytes long', () => {
    const long = new Uint8Array(KOALA + 130)
    long.set(koalaBody(), 0)
    expect(decodePicture(file(0x6000, long))?.format).toBe('koala')
  })
})

describe('the browser fixture', () => {
  /*
   * tune.pic is written packed but named as a whole file, which is what
   * three of the real add-on's .pic files do. If this stops decoding, the
   * browser test that looks at its pixels is testing nothing.
   */
  const picture = decodePicture(new Uint8Array(readFileSync(join(__dirname, 'fixtures/tune.pic'))))

  it('is a packed Koala', () => {
    expect(picture?.format).toBe('koala')
    expect(picture?.packed).toBe(true)
  })

  it('is red in the top-left corner and blue everywhere else', () => {
    expect(indexAt(picture!.pixels, 0, 0)).toBe(2)
    expect(indexAt(picture!.pixels, 7, 0)).toBe(2)
    expect(indexAt(picture!.pixels, 8, 0)).toBe(6)
    expect(indexAt(picture!.pixels, 160, 100)).toBe(6)
  })
})
