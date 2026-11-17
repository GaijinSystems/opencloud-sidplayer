import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { decodePicture, unpack } from '../src/sid/picture'

/**
 * The decoders against every picture in the real add-on, which the made-up
 * files above cannot stand in for: 554 files from thirty years of being
 * passed around, several of them a byte or two off the size the format says.
 *
 * The packing is the reason this exists. It is undocumented, so the rule in
 * `unpack` was read off the bytes; the only honest test of it is that all
 * sixty packed files come out at exactly the length their format wants.
 *
 * Skipped unless CGSC_PICS points at the unpacked add-on, since it is not
 * ours to commit:
 *
 *   curl -O https://www.c64music.co.uk/CGSC_v147b_pics.7z
 *   7z x CGSC_v147b_pics.7z -o/tmp/cgsc-pics
 *   CGSC_PICS=/tmp/cgsc-pics npm test
 */

const dir = process.env.CGSC_PICS
const have = !!dir && existsSync(dir)

function walk(root: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(root)) {
    const path = join(root, name)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else out.push(path)
  }
  return out
}

const extensionOf = (path: string) => path.toLowerCase().match(/\.([^.]+)$/)?.[1] ?? ''
const files = have ? walk(dir as string) : []
const of = (ext: string) => files.filter((f) => extensionOf(f) === ext)
const read = (path: string) => new Uint8Array(readFileSync(path))

describe.skipIf(!have)('every picture in the add-on', () => {
  it('has something to look at', () => {
    expect(of('pic').length).toBeGreaterThan(400)
    expect(of('pgg').length + of('pjj').length).toBeGreaterThan(50)
  })

  it('decodes every .pic', () => {
    const bad = of('pic').filter((f) => decodePicture(read(f)) === null)
    expect(bad).toEqual([])
  })

  it('decodes every .pgg and .pjj', () => {
    const bad = [...of('pgg'), ...of('pjj')].filter((f) => decodePicture(read(f)) === null)
    expect(bad).toEqual([])
  })

  it('unpacks every .pgg to exactly one Koala', () => {
    const lengths = new Set(of('pgg').map((f) => unpack(read(f).subarray(2)).length))
    expect([...lengths]).toEqual([10001])
  })

  it('unpacks every .pjj to a whole Doodle', () => {
    // 1,024 bytes of screen then the bitmap, which some files stop at the
    // 8,000 bytes a 320x200 picture uses and others carry to a full 8,192.
    const lengths = [...new Set(of('pjj').map((f) => unpack(read(f).subarray(2)).length))].sort((a, b) => a - b)
    expect(lengths).toEqual([9024, 9216])
  })

  it('sorts the .pic files into the two formats by load address', () => {
    const formats = of('pic').map((f) => decodePicture(read(f))?.format)
    expect(formats.filter((f) => f === 'koala').length).toBeGreaterThan(300)
    expect(formats.filter((f) => f === 'doodle').length).toBeGreaterThan(100)
  })

  it('finds every .pgg and .pjj packed, whatever its length', () => {
    expect([...of('pgg'), ...of('pjj')].every((f) => decodePicture(read(f))?.packed === true)).toBe(true)
  })

  /*
   * The extension is not to be trusted: three .pic files are packed Koalas
   * that were named as though they were whole. Nor is length - the largest
   * packed file here is 9,230 bytes and the smallest whole one is 9,217 -
   * which is why decodePicture unpacks and looks rather than measuring.
   */
  it('has packed and whole files whose sizes overlap', () => {
    const size = (f: string) => statSync(f).size
    const packed = [...of('pgg'), ...of('pjj'), ...of('pic').filter((f) => decodePicture(read(f))?.packed)]
    const whole = of('pic').filter((f) => decodePicture(read(f))?.packed === false)
    expect(Math.max(...packed.map(size))).toBeGreaterThan(Math.min(...whole.map(size)))
  })

  it('finds the three packed files hiding among the .pic files', () => {
    const packed = of('pic').filter((f) => decodePicture(read(f))?.packed)
    expect(packed.map((f) => f.split('/').pop()).sort()).toEqual([
      'Pictures_Pt1_Promenade_The_Gnome.pic',
      'Promenade_1_and_the_Gnome.pic',
      'Swan_Lake.pic'
    ])
  })

  it('claims none of the .ani files, which are 6502 code and not pictures', () => {
    const ani = of('ani')
    expect(ani.length).toBeGreaterThan(0)
    expect(ani.filter((f) => decodePicture(read(f)) !== null)).toEqual([])
  })
})
