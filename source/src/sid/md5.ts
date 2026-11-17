/**
 * MD5, for looking a tune up in HVSC's Songlengths.md5.
 *
 * Web Crypto does not offer MD5 (rightly, for anything security-related),
 * and the only thing this hashes is a few kilobytes of SID file to match a
 * catalogue key, so a small local implementation beats a dependency. It is
 * checked against Node's crypto in the unit tests.
 */

const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]
const K = new Uint32Array(64)
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0

const rotl = (x: number, n: number): number => ((x << n) | (x >>> (32 - n))) >>> 0

export function md5Hex(data: Uint8Array): string {
  const len = data.length
  // Message, 0x80, zero padding, 64-bit little-endian bit length: a multiple of 64 bytes.
  const padded = new Uint8Array((((len + 8) >> 6) << 6) + 64)
  padded.set(data)
  padded[len] = 0x80
  const view = new DataView(padded.buffer)
  const bitLen = len * 8
  view.setUint32(padded.length - 8, bitLen >>> 0, true)
  view.setUint32(padded.length - 4, Math.floor(bitLen / 0x100000000), true)

  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476
  const M = new Uint32Array(16)

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) M[i] = view.getUint32(offset + i * 4, true)
    let A = a0
    let B = b0
    let C = c0
    let D = d0
    for (let i = 0; i < 64; i++) {
      let F: number
      let g: number
      if (i < 16) {
        F = (B & C) | (~B & D)
        g = i
      } else if (i < 32) {
        F = (D & B) | (~D & C)
        g = (5 * i + 1) & 15
      } else if (i < 48) {
        F = B ^ C ^ D
        g = (3 * i + 5) & 15
      } else {
        F = C ^ (B | ~D)
        g = (7 * i) & 15
      }
      F = (F + A + K[i] + M[g]) >>> 0
      A = D
      D = C
      C = B
      B = (B + rotl(F, S[((i >> 4) << 2) | (i & 3)])) >>> 0
    }
    a0 = (a0 + A) >>> 0
    b0 = (b0 + B) >>> 0
    c0 = (c0 + C) >>> 0
    d0 = (d0 + D) >>> 0
  }

  let out = ''
  for (const word of [a0, b0, c0, d0]) {
    for (let i = 0; i < 4; i++) out += ((word >>> (i * 8)) & 0xff).toString(16).padStart(2, '0')
  }
  return out
}
