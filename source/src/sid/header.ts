import { stripExtension } from './names'
import { SidPlayerError, type SidClock, type SidHeader, type SidModel } from './types'

/**
 * PSID / RSID header parser, per the HVSC SID file format document.
 *
 *   offset  size  field
 *   0x00    4     magic 'PSID' or 'RSID'
 *   0x04    2     version (1..4)
 *   0x06    2     dataOffset (0x76 for v1, 0x7C for v2+)
 *   0x08    2     loadAddress (0 = take from the first two data bytes)
 *   0x0A    2     initAddress
 *   0x0C    2     playAddress
 *   0x0E    2     songs
 *   0x10    2     startSong
 *   0x12    4     speed
 *   0x16    32    name       (ISO-8859-1, NUL padded)
 *   0x36    32    author
 *   0x56    32    released
 *   --- v2+ ---
 *   0x76    2     flags
 *   0x78    1     startPage
 *   0x79    1     pageLength
 *   0x7A    1     secondSIDAddress (v3+)
 *   0x7B    1     thirdSIDAddress  (v4)
 *
 * All multi-byte header fields are big-endian. The embedded load address, when
 * present, is little-endian because it is a C64 PRG convention, not a header one.
 */

export const V1_HEADER_LENGTH = 0x76
export const V2_HEADER_LENGTH = 0x7c
/** Enough bytes to tell a SID from anything else. */
const MAGIC_PROBE_BYTES = 4

const latin1 = (bytes: Uint8Array): string => {
  const end = bytes.indexOf(0)
  const slice = end === -1 ? bytes : bytes.subarray(0, end)
  let out = ''
  for (const b of slice) out += String.fromCharCode(b)
  return out.trim()
}

const CLOCKS: SidClock[] = ['unknown', 'PAL', 'NTSC', 'PAL and NTSC']
const MODELS: SidModel[] = ['unknown', 'MOS6581', 'MOS8580', 'MOS6581 and MOS8580']

/**
 * A second or third SID's address is stored as the middle byte of $Dxx0:
 * value 0x42 means $D420. Valid values are 0x42..0x7F and 0xE0..0xFE, even.
 * Anything else, including 0 for "none", is reported as absent.
 */
export const sidAddressOf = (byte: number): number | null => {
  const even = (byte & 1) === 0
  const inRange = (byte >= 0x42 && byte <= 0x7f) || (byte >= 0xe0 && byte <= 0xfe)
  return even && inRange ? 0xd000 + byte * 0x10 : null
}

export function isSidFile(head: Uint8Array | undefined): boolean {
  if (!head || head.length < MAGIC_PROBE_BYTES) return false
  const magic = String.fromCharCode(head[0], head[1], head[2], head[3])
  return magic === 'PSID' || magic === 'RSID'
}

export function parseSidHeader(bytes: Uint8Array): SidHeader {
  if (!isSidFile(bytes)) {
    throw new SidPlayerError('unsupported-format', 'This file is not a PSID or RSID tune.')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const format = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) as 'PSID' | 'RSID'

  if (bytes.length < V1_HEADER_LENGTH) {
    throw new SidPlayerError('corrupt', 'The file is shorter than a SID header.')
  }
  const versionRaw = view.getUint16(4)
  if (versionRaw < 1 || versionRaw > 4) {
    throw new SidPlayerError('corrupt', `Unknown SID header version ${versionRaw}.`)
  }
  const version = versionRaw as 1 | 2 | 3 | 4
  if (format === 'RSID' && version < 2) {
    throw new SidPlayerError('corrupt', 'RSID files must be header version 2 or later.')
  }
  /*
   * The offset the file declares is where the data is taken from, which is
   * what libsidplayfp does: it reads the field and checks only that it lands
   * inside the file. Insisting on exactly 0x76 or 0x7C refused files the
   * engine plays perfectly well - a v1 header written with a v2-sized offset,
   * or a few bytes of padding before the data - before the engine ever saw
   * them. Shorter than the fields this parser reads is a different matter and
   * still corrupt: the data would start inside the header.
   */
  const dataOffset = view.getUint16(6)
  const leastOffset = version === 1 ? V1_HEADER_LENGTH : V2_HEADER_LENGTH
  if (dataOffset < leastOffset) {
    throw new SidPlayerError('corrupt', `Unexpected data offset ${dataOffset} for a v${version} header.`)
  }
  if (bytes.length < dataOffset) {
    throw new SidPlayerError('corrupt', 'The file ends inside its header.')
  }

  let loadAddress = view.getUint16(8)
  let dataStart = dataOffset
  if (loadAddress === 0) {
    if (bytes.length < dataOffset + 2) {
      throw new SidPlayerError('corrupt', 'The file declares an embedded load address but has none.')
    }
    loadAddress = bytes[dataOffset] | (bytes[dataOffset + 1] << 8)
    dataStart += 2
  }

  // Clamped rather than rejected: a handful of real files declare 0 songs.
  const songs = Math.min(256, Math.max(1, view.getUint16(14)))
  const startSong = Math.min(songs, Math.max(1, view.getUint16(16)))

  let flags = 0
  let secondByte = 0
  let thirdByte = 0
  if (version >= 2) {
    flags = view.getUint16(0x76)
    if (version >= 3) secondByte = bytes[0x7a]
    if (version >= 4) thirdByte = bytes[0x7b]
  }

  return {
    format,
    version,
    dataOffset,
    loadAddress,
    initAddress: view.getUint16(10),
    playAddress: view.getUint16(12),
    songs,
    startSong,
    speed: view.getUint32(18),
    name: latin1(bytes.subarray(0x16, 0x36)),
    author: latin1(bytes.subarray(0x36, 0x56)),
    released: latin1(bytes.subarray(0x56, 0x76)),
    musPlayer: (flags & 0x01) !== 0,
    playSidSpecific: (flags & 0x02) !== 0,
    clock: CLOCKS[(flags >> 2) & 0x03],
    sidModel: MODELS[(flags >> 4) & 0x03],
    secondSidModel: version >= 3 ? MODELS[(flags >> 6) & 0x03] : 'unknown',
    thirdSidModel: version >= 4 ? MODELS[(flags >> 8) & 0x03] : 'unknown',
    secondSidAddress: version >= 3 ? sidAddressOf(secondByte) : null,
    thirdSidAddress: version >= 4 ? sidAddressOf(thirdByte) : null,
    dataLength: bytes.length - dataStart
  }
}

/**
 * Whether a subsong is driven by the vertical-blank interrupt or a CIA timer.
 * One bit per song for songs 1..32; every song past 32 shares bit 31. RSID
 * files ignore the field entirely, since the tune installs its own interrupt.
 */
export const speedOf = (header: SidHeader, song: number): 'VBI' | 'CIA' => {
  if (header.format === 'RSID') return 'VBI'
  const bit = Math.min(Math.max(song, 1), 32) - 1
  return (header.speed >>> bit) & 1 ? 'CIA' : 'VBI'
}

/** The name to show for a tune, falling back to the file name. */
export const displayTitle = (header: SidHeader | null, fileName: string): string => {
  const name = header?.name
  if (name && name !== '<?>') return name
  return stripExtension(fileName)
}
