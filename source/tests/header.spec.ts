import { describe, it, expect } from 'vitest'
import {
  parseSidHeader,
  isSidFile,
  speedOf,
  sidAddressOf,
  displayTitle,
  V1_HEADER_LENGTH,
  V2_HEADER_LENGTH
} from '../src/sid/header'
import { SidPlayerError } from '../src/sid/types'
import { sidFile, type SidFileFields } from './helpers/bytes'

/**
 * Builds a header byte-for-byte so the tests do not depend on fixture files.
 * With nothing asked for it is Commando: three songs starting at the second,
 * and three bytes of code after a version 2 header.
 */
const makeSid = (fields: SidFileFields = {}): Uint8Array =>
  sidFile({
    playAddress: 0x1003,
    songs: 3,
    startSong: 2,
    name: 'Commando',
    author: 'Rob Hubbard',
    released: '1985 Elite',
    data: [0xa9, 0x00, 0x60],
    ...fields
  })

describe('isSidFile', () => {
  it('recognises both magics and nothing else', () => {
    expect(isSidFile(makeSid())).toBe(true)
    expect(isSidFile(makeSid({ magic: 'RSID' }))).toBe(true)
    expect(isSidFile(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(false)
    expect(isSidFile(new Uint8Array(2))).toBe(false)
    expect(isSidFile(undefined)).toBe(false)
  })
})

describe('parseSidHeader', () => {
  it('reads a v2 PSID header', () => {
    const h = parseSidHeader(makeSid({ flags: 0b0001_0100 })) // PAL, 6581
    expect(h.format).toBe('PSID')
    expect(h.version).toBe(2)
    expect(h.dataOffset).toBe(V2_HEADER_LENGTH)
    expect(h.loadAddress).toBe(0x1000)
    expect(h.initAddress).toBe(0x1000)
    expect(h.playAddress).toBe(0x1003)
    expect(h.songs).toBe(3)
    expect(h.startSong).toBe(2)
    expect(h.name).toBe('Commando')
    expect(h.author).toBe('Rob Hubbard')
    expect(h.released).toBe('1985 Elite')
    expect(h.clock).toBe('PAL')
    expect(h.sidModel).toBe('MOS6581')
    expect(h.secondSidAddress).toBeNull()
    expect(h.dataLength).toBe(3)
  })

  it('reads a v1 header without flags', () => {
    const h = parseSidHeader(makeSid({ version: 1 }))
    expect(h.version).toBe(1)
    expect(h.dataOffset).toBe(V1_HEADER_LENGTH)
    expect(h.clock).toBe('unknown')
    expect(h.musPlayer).toBe(false)
  })

  it('takes the load address from the data when the header says 0', () => {
    const h = parseSidHeader(makeSid({ loadAddress: 0, data: [0x00, 0x08, 0xa9] }))
    expect(h.loadAddress).toBe(0x0800)
    // The two address bytes are not tune data.
    expect(h.dataLength).toBe(1)
  })

  it('decodes second and third SID addresses for v3 and v4', () => {
    const h4 = parseSidHeader(makeSid({ version: 4, secondSid: 0x42, thirdSid: 0xe0, flags: 0b11_10_00_00_00 }))
    expect(h4.secondSidAddress).toBe(0xd420)
    expect(h4.thirdSidAddress).toBe(0xde00)
    expect(h4.secondSidModel).toBe('MOS8580')
    expect(h4.thirdSidModel).toBe('MOS6581 and MOS8580')

    const h2 = parseSidHeader(makeSid({ version: 2, secondSid: 0x42 }))
    expect(h2.secondSidAddress).toBeNull()
  })

  it('clamps an absurd song count and start song', () => {
    const h = parseSidHeader(makeSid({ songs: 0, startSong: 9 }))
    expect(h.songs).toBe(1)
    expect(h.startSong).toBe(1)
  })

  it('reads a v3 header: a second model, and a third that stays unknown', () => {
    // Second model bits are 6..7 and third 8..9. Both are set here; only the
    // second may be believed, because v3 has no third SID to describe.
    const h = parseSidHeader(makeSid({ version: 3, secondSid: 0x42, thirdSid: 0xe0, flags: 0b10_01_00_00_00 }))
    expect(h.secondSidModel).toBe('MOS6581')
    expect(h.secondSidAddress).toBe(0xd420)
    expect(h.thirdSidModel).toBe('unknown')
    expect(h.thirdSidAddress).toBeNull()
  })

  it('stops a 32-byte name at its field rather than running into the next', () => {
    // The fields are NUL padded, so a name that fills all 32 has no NUL at
    // all and only the field boundary ends it.
    const name = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'
    const h = parseSidHeader(makeSid({ name, author: 'Rob Hubbard' }))
    expect(h.name).toBe(name)
    expect(h.author).toBe('Rob Hubbard')
  })

  it('rejects things that are not SID files with a friendly code', () => {
    expect(() => parseSidHeader(new Uint8Array([1, 2, 3, 4, 5]))).toThrowError(SidPlayerError)
    // Both assertions must run: without this the test passes vacuously if
    // the throw ever stops and the catch is never entered.
    expect.assertions(2)
    try {
      parseSidHeader(new Uint8Array(200))
    } catch (e) {
      expect((e as SidPlayerError).code).toBe('unsupported-format')
    }
  })

  it('rejects a truncated or inconsistent header as corrupt', () => {
    const short = makeSid().subarray(0, 40)
    expect(() => parseSidHeader(short)).toThrowError(/shorter/)

    // Below the fields this parser reads: the data would start inside them.
    const badOffset = makeSid()
    new DataView(badOffset.buffer).setUint16(6, 0x40)
    expect(() => parseSidHeader(badOffset)).toThrowError(/data offset/)

    const rsidV1 = makeSid({ magic: 'RSID', version: 1 })
    expect(() => parseSidHeader(rsidV1)).toThrowError(/RSID/)
  })

  it('rejects a file that ends inside the header it declares', () => {
    // A v1 header, 0x76 bytes of it, declaring that its data starts at 0x7C.
    const truncated = makeSid({ version: 1, data: [] })
    new DataView(truncated.buffer).setUint16(6, V2_HEADER_LENGTH)
    expect(() => parseSidHeader(truncated)).toThrowError(/ends inside/)
  })

  it('rejects a file that declares an embedded load address but has none', () => {
    expect(() => parseSidHeader(makeSid({ loadAddress: 0, data: [] }))).toThrowError(/embedded load address/)
    // One byte where two are wanted is no better.
    expect(() => parseSidHeader(makeSid({ loadAddress: 0, data: [0x00] }))).toThrowError(
      /embedded load address/
    )
  })

  /*
   * libsidplayfp takes the data from the offset the file declares and checks
   * only that it lands inside the file, so a file with a few bytes of padding
   * between the header and the data plays there. Refusing it here would have
   * meant the player rejecting a tune the engine behind it can play.
   */
  it('accepts a data offset past the canonical one and reads the data from it', () => {
    const padded = makeSid({ data: [0, 0, 0, 0, 0xa9, 0x00, 0x60] })
    new DataView(padded.buffer).setUint16(6, V2_HEADER_LENGTH + 4)
    const h = parseSidHeader(padded)
    expect(h.dataOffset).toBe(V2_HEADER_LENGTH + 4)
    expect(h.dataLength).toBe(3)
  })
})

describe('speedOf', () => {
  it('reads one bit per song and shares bit 31 past 32', () => {
    const h = parseSidHeader(makeSid({ songs: 40, speed: 0b101 | (1 << 31) }))
    expect(speedOf(h, 1)).toBe('CIA')
    expect(speedOf(h, 2)).toBe('VBI')
    expect(speedOf(h, 3)).toBe('CIA')
    expect(speedOf(h, 33)).toBe('CIA')
    expect(speedOf(h, 40)).toBe('CIA')
  })

  it('is always VBI for RSID, which installs its own interrupt', () => {
    const h = parseSidHeader(makeSid({ magic: 'RSID', speed: 0xffffffff, playAddress: 0 }))
    expect(speedOf(h, 1)).toBe('VBI')
  })
})

describe('sidAddressOf', () => {
  it('accepts only the even addresses in the two documented ranges', () => {
    expect(sidAddressOf(0)).toBeNull()
    expect(sidAddressOf(0x41)).toBeNull()
    expect(sidAddressOf(0x42)).toBe(0xd420)
    expect(sidAddressOf(0x43)).toBeNull()
    expect(sidAddressOf(0x7e)).toBe(0xd7e0)
    expect(sidAddressOf(0x80)).toBeNull()
    expect(sidAddressOf(0xe0)).toBe(0xde00)
    expect(sidAddressOf(0xfe)).toBe(0xdfe0)
    expect(sidAddressOf(0xff)).toBeNull()
  })
})

describe('displayTitle', () => {
  it('prefers the header name and falls back to the file name without extension', () => {
    const h = parseSidHeader(makeSid())
    expect(displayTitle(h, 'Commando.sid')).toBe('Commando')
    expect(displayTitle(parseSidHeader(makeSid({ name: '<?>' })), 'Unknown_Tune.sid')).toBe('Unknown_Tune')
    expect(displayTitle(null, 'x.sid')).toBe('x')
  })
})
