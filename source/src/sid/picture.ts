/**
 * Pictures from the Compute's Gazette Sid Collection's add-on.
 *
 * Some Sidplayer tunes were passed around with a picture to look at while
 * they played. The collection ships them separately from the music, in a
 * tree that mirrors it, in four extensions that turn out to be two formats
 * and a packer:
 *
 *   .pic  a Koala Painter or Doodle! bitmap, usually whole
 *   .pgg  a Koala bitmap, run-length packed
 *   .pjj  a Doodle bitmap, run-length packed
 *   .ani  not a picture at all - 6502 machine code the player runs
 *
 * `.ani` is left alone. Showing one means executing it on a 6502, which is
 * a different job from decoding a bitmap.
 *
 * Nothing here is guesswork about the two bitmap layouts, which are well
 * known, but the packing is: it is undocumented as far as this app's authors
 * could find, and was read off the files themselves. See `unpack`.
 */

/** The VIC-II's sixteen colours, as the usual Pepto measurements. */
export const C64_PALETTE: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [255, 255, 255],
  [104, 55, 43],
  [112, 164, 178],
  [111, 61, 134],
  [88, 141, 67],
  [53, 40, 121],
  [184, 199, 111],
  [111, 79, 37],
  [67, 57, 0],
  [154, 103, 89],
  [68, 68, 68],
  [108, 108, 108],
  [154, 210, 132],
  [108, 94, 181],
  [149, 149, 149]
]

/** The extensions the picture add-on uses for things this can draw. */
export const PICTURE_EXTENSIONS = new Set(['pic', 'pgg', 'pjj'])

export type PictureFormat = 'koala' | 'doodle'

export interface Picture {
  format: PictureFormat
  /** Whether the bytes had to be unpacked first. */
  packed: boolean
  width: 320
  height: 200
  /**
   * RGBA, ready for `putImageData`. Tied to a plain ArrayBuffer because
   * `ImageData` will not take the SharedArrayBuffer-backed variant.
   */
  pixels: Uint8ClampedArray<ArrayBuffer>
}

export const PICTURE_WIDTH = 320
export const PICTURE_HEIGHT = 200

/*
 * Both formats are a C64 memory dump behind the usual two-byte load address,
 * and that address is what tells them apart:
 *
 *   $6000  Koala Painter    8000 bitmap, 1000 screen, 1000 colour, 1 border
 *   $5C00  Doodle!          1024 screen (1000 used), then 8192 bitmap
 *
 * Koala is multicolour - 160 pixels across, each drawn twice as wide - and
 * Doodle is hires at the full 320.
 */
const KOALA_LOAD = 0x6000
const DOODLE_LOAD = 0x5c00
const KOALA_SIZE = 10001
const DOODLE_SIZE = 9216

/**
 * The packer: `$FE`, the byte to repeat, then how many times, with a count
 * of zero meaning 256. Any other byte is itself, so a literal `$FE` travels
 * as a run of one.
 *
 * Read from the files rather than from a document, then checked against all
 * sixty of them in the 1.47b add-on: every `.pgg` unpacks to exactly the
 * 10,001 bytes a Koala wants, and every `.pjj` to a whole Doodle.
 */
export function unpack(body: Uint8Array, limit = Number.POSITIVE_INFINITY): Uint8Array {
  return unpackRuns(body, limit).bytes
}

/**
 * `unpack` with the reading position it stopped at, which is what tells a
 * packed file from a whole one: a real run-length stream ends exactly where
 * the file ends, while a stream stopped by `limit` has bytes left over.
 */
function unpackRuns(body: Uint8Array, limit: number): { bytes: Uint8Array; consumed: number } {
  const out: number[] = []
  let i = 0
  while (i < body.length && out.length < limit) {
    if (body[i] === 0xfe && i + 2 < body.length) {
      const value = body[i + 1]
      // A count byte of zero means a full 256, which is how the longest
      // runs fit in one byte. Four of the six .pjj files need this.
      const count = body[i + 2] === 0 ? 256 : body[i + 2]
      // Tested inside the run and not only before it, so `limit` bounds the
      // output as its name says: a run of 256 met at the limit used to carry
      // it up to 255 bytes past.
      for (let n = 0; n < count && out.length < limit; n++) out.push(value)
      i += 3
    } else {
      out.push(body[i])
      i += 1
    }
  }
  return { bytes: Uint8Array.from(out), consumed: i }
}

/** Pads or trims to the length a decoder wants, so a ragged file still draws. */
function fit(body: Uint8Array, size: number): Uint8Array {
  if (body.length === size) return body
  const out = new Uint8Array(size)
  out.set(body.subarray(0, Math.min(body.length, size)))
  return out
}

function koala(body: Uint8Array): Uint8ClampedArray<ArrayBuffer> {
  const bitmap = body.subarray(0, 8000)
  const screen = body.subarray(8000, 9000)
  const colour = body.subarray(9000, 10000)
  const background = body[10000] & 15
  const pixels = new Uint8ClampedArray(PICTURE_WIDTH * PICTURE_HEIGHT * 4)
  for (let y = 0; y < PICTURE_HEIGHT; y++) {
    for (let x = 0; x < 160; x++) {
      const cx = x >> 2
      const cy = y >> 3
      const bits = (bitmap[cy * 320 + cx * 8 + (y & 7)] >> (6 - 2 * (x & 3))) & 3
      const cell = cy * 40 + cx
      const index =
        bits === 0
          ? background
          : bits === 1
            ? screen[cell] >> 4
            : bits === 2
              ? screen[cell] & 15
              : colour[cell] & 15
      const [r, g, b] = C64_PALETTE[index & 15]
      // One multicolour pixel is two across.
      for (let d = 0; d < 2; d++) {
        const o = (y * PICTURE_WIDTH + x * 2 + d) * 4
        pixels[o] = r
        pixels[o + 1] = g
        pixels[o + 2] = b
        pixels[o + 3] = 255
      }
    }
  }
  return pixels
}

function doodle(body: Uint8Array): Uint8ClampedArray<ArrayBuffer> {
  const screen = body.subarray(0, 1024)
  const bitmap = body.subarray(1024, 9216)
  const pixels = new Uint8ClampedArray(PICTURE_WIDTH * PICTURE_HEIGHT * 4)
  for (let y = 0; y < PICTURE_HEIGHT; y++) {
    for (let x = 0; x < PICTURE_WIDTH; x++) {
      const cx = x >> 3
      const cy = y >> 3
      const on = (bitmap[cy * 320 + cx * 8 + (y & 7)] >> (7 - (x & 7))) & 1
      const cell = screen[cy * 40 + cx]
      const [r, g, b] = C64_PALETTE[(on ? cell >> 4 : cell) & 15]
      const o = (y * PICTURE_WIDTH + x) * 4
      pixels[o] = r
      pixels[o + 1] = g
      pixels[o + 2] = b
      pixels[o + 3] = 255
    }
  }
  return pixels
}

/**
 * How short a file may be and still hold a whole picture. A Doodle that
 * stops after the 8,000 bytes a 320x200 screen uses, rather than carrying
 * on to a full 8,192, is 192 short and perfectly good.
 */
const SHORT_BUT_WHOLE = 1024

/** That same short Doodle, as a length: 1,024 of screen and 8,000 of bitmap. */
const DOODLE_SHORT = 9024

/**
 * Decodes one picture file, or returns null if it is not one.
 *
 * Packed or whole is read from the bytes, not from the extension, because
 * the extension lies: three of the add-on's 458 `.pic` files are packed
 * Koalas that were named as though they were whole. Length cannot stand in
 * for reading them either - across the add-on the largest packed file is
 * 9,230 bytes and the smallest whole one is 9,217, so the two ranges
 * overlap.
 *
 * Unpacking settles it, and the test is that the unpacking comes out exact:
 * the runs must consume the file to its last byte and land on one of the
 * lengths the format actually has. Merely growing into the window is not
 * enough - a whole Koala trimmed to 9,500 bytes that happens to contain one
 * `FE 00 00` expands to about 9,753, which is longer than the file and
 * inside the window, and used to be drawn as unpacked garbage.
 *
 * Measured over the whole 1.47b add-on, 518 bitmaps: all 63 packed files
 * consume their body exactly and expand to 10,001 for a Koala or 9,216 or
 * 9,024 for a Doodle, and no whole file does either. The stricter test
 * classifies every one of the 518 the same way the looser one did.
 */
export function decodePicture(bytes: Uint8Array): Picture | null {
  if (bytes.length < 4) return null
  const load = bytes[0] | (bytes[1] << 8)
  const format: PictureFormat | null = load === KOALA_LOAD ? 'koala' : load === DOODLE_LOAD ? 'doodle' : null
  if (!format) return null

  const size = format === 'koala' ? KOALA_SIZE : DOODLE_SIZE
  const least = size - SHORT_BUT_WHOLE
  let body = bytes.subarray(2)

  // One byte past `size`, since an expansion that overshoots the window has
  // to be distinguishable from one that lands on it, and a whole file full of
  // $FE bytes would otherwise run to hundreds of kilobytes on the way to
  // being rejected. Overshooting stops the walk early, which leaves bytes
  // unconsumed and fails the test below.
  const { bytes: expanded, consumed } = unpackRuns(body, size + 1)
  const whole = expanded.length === size || (format === 'doodle' && expanded.length === DOODLE_SHORT)
  const packed = consumed === body.length && expanded.length > body.length && whole
  if (packed) body = expanded
  if (body.length < least) return null
  body = fit(body, size)

  return {
    format,
    packed,
    width: PICTURE_WIDTH,
    height: PICTURE_HEIGHT,
    pixels: format === 'koala' ? koala(body) : doodle(body)
  }
}
