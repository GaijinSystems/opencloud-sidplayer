#!/usr/bin/env node
/**
 * Generates the SID test fixtures in tests/fixtures/ from scratch, with no
 * external tools, so the suite is reproducible on any machine.
 *
 *   tone.sid        PSID v2, 3 subsongs. Each plays a steady triangle wave on
 *                   voice 1 at a frequency chosen by the subsong number, so a
 *                   harness can check that the emulator produces sound AND that
 *                   subsong selection reaches the 6502 (the song number
 *                   arrives in A on init).
 *   tone-rsid.sid   The same code with an RSID header. RSID needs the C64
 *                   kernal, which is not shipped, so this exercises the
 *                   "needs a ROM" error path.
 *   tone3.sid       PSID v2, one subsong, all three voices gated at once on
 *                   distinct pitches (481/797/1127 Hz) and never touched again.
 *                   Per-voice muting is measurable on it - one partial goes,
 *                   the other two stay - and because the control registers are
 *                   written once, at init, it is also the regression test for
 *                   mute being applied live rather than at the next write.
 *   tone-filter.sid PSID v2 declaring a MOS8580, one voice routed through the
 *                   filter in low-pass mode with resonance at maximum. The
 *                   only fixture whose output depends on the filter model, and
 *                   so the only one that notices when the filter is set up
 *                   wrongly: `filter8580Curve` takes a position from 0 to 1,
 *                   its public header advertises a centre frequency in Hz, and
 *                   with 12500 passed the 8580 filter collapsed to a constant
 *                   after half a second. Every other fixture writes no filter
 *                   register at all and sounded perfectly normal throughout.
 *   not-a-sid.bin   A few bytes of nothing in particular.
 *
 * The 6502 code, assembled by hand (addresses relative to $1000):
 *
 *   1000  TAX            AA          ; song number 0..2
 *   1001  LDA #$0F       A9 0F
 *   1003  STA $D418      8D 18 D4    ; volume 15
 *   1006  LDA #$00       A9 00
 *   1008  STA $D400      8D 00 D4    ; freq lo
 *   100B  TXA            8A
 *   100C  ASL A ×4       0A 0A 0A 0A ; song * 16
 *   1010  CLC            18
 *   1011  ADC #$20       69 20       ; freq hi = $20 + song*$10
 *   1013  STA $D401      8D 01 D4
 *   1016  LDA #$09       A9 09
 *   1018  STA $D405      8D 05 D4    ; attack 0, decay 9
 *   101B  LDA #$F0       A9 F0
 *   101D  STA $D406      8D 06 D4    ; sustain 15, release 0
 *   1020  LDA #$11       A9 11
 *   1022  STA $D404      8D 04 D4    ; triangle + gate
 *   1025  RTS            60
 *   1026  RTS            60          ; play routine: nothing to do
 *
 * Frequencies on a PAL C64 (985248 Hz / 2^24 per unit):
 *   song 1: $2000 → 481 Hz    song 2: $3000 → 722 Hz    song 3: $4000 → 962 Hz
 */
import { mkdirSync, writeFileSync as writeFileToDisk } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { FLAGS_PAL_6581, FLAGS_PAL_8580, lda, mus, petscii, sidFile, sta } from './sid-bytes.mjs'

const out = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures')

/*
 * Run as a script, this writes the fixtures. Imported, it writes nothing and
 * only hands over its constants: scripts/verify-engine.mjs takes TONE_HZ and
 * VOICE_HZ from here rather than keeping a second copy of the pitches the 6502
 * code below programs, which is how the two came to be maintained separately.
 *
 * The guard is not tidiness. An ES module's imports run to completion before
 * any of the importing module's own body, so an import that regenerated the
 * fixtures would silently defeat verify-engine's check that they are there and
 * its "run npm run fixtures first" message.
 */
const RUN_AS_SCRIPT = !!process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
const writeFileSync = (path, bytes) => {
  if (RUN_AS_SCRIPT) writeFileToDisk(path, bytes)
}
if (RUN_AS_SCRIPT) mkdirSync(out, { recursive: true })

const CODE = [
  0xaa, 0xa9, 0x0f, 0x8d, 0x18, 0xd4, 0xa9, 0x00, 0x8d, 0x00, 0xd4, 0x8a, 0x0a, 0x0a, 0x0a, 0x0a, 0x18, 0x69,
  0x20, 0x8d, 0x01, 0xd4, 0xa9, 0x09, 0x8d, 0x05, 0xd4, 0xa9, 0xf0, 0x8d, 0x06, 0xd4, 0xa9, 0x11, 0x8d, 0x04,
  0xd4, 0x60, 0x60
]
const LOAD = 0x1000
const INIT = 0x1000
const PLAY = 0x1026

/*
 * The three-voice fixture's code, assembled here rather than by hand so the
 * play address stays right if it is ever edited. Each voice gets a frequency,
 * a fast attack with full sustain, and triangle + gate; nothing writes a SID
 * register after init.
 *
 *   voice N base = $D400 + 7N: freq lo/hi, pw lo/hi, control, AD, SR
 */
// 481, 797 and 1127 Hz on a PAL clock. Deliberately not in small-integer
// ratios: a harness measuring one voice's partial must not pick up a
// neighbour's harmonic, and 962 Hz would have been 481's second.
const VOICE_HI = [0x20, 0x35, 0x4b]
const CODE3 = (() => {
  const out = [...lda(0x0f), ...sta(0xd418)]
  VOICE_HI.forEach((hi, v) => {
    const base = 0xd400 + 7 * v
    out.push(
      ...lda(0x00),
      ...sta(base), // freq lo
      ...lda(hi),
      ...sta(base + 1), // freq hi
      ...lda(0x09),
      ...sta(base + 5), // attack 0, decay 9
      ...lda(0xf0),
      ...sta(base + 6), // sustain 15, release 0
      ...lda(0x11),
      ...sta(base + 4) // triangle + gate
    )
  })
  out.push(0x60) // RTS: end of init
  return out
})()
const PLAY3 = LOAD + CODE3.length

/*
 * One voice through the filter, for the filter's own sake.
 *
 *   $D415/6  cutoff, mid range          $D417  resonance 15, voice 1 filtered
 *   $D418    low-pass + volume 15       $D404  triangle + gate
 *
 * Resonance at maximum is deliberate: a resonant low-pass is the most
 * sensitive thing a few SID registers can build, so a filter whose curve has
 * been set outside its range shows up here and nowhere else.
 */
const CODE_FILTER = [
  ...lda(0x00),
  ...sta(0xd400),
  ...lda(0x20),
  ...sta(0xd401),
  ...lda(0x09),
  ...sta(0xd405),
  ...lda(0xf0),
  ...sta(0xd406),
  ...lda(0x00),
  ...sta(0xd415),
  ...lda(0x40),
  ...sta(0xd416),
  ...lda(0xf1),
  ...sta(0xd417),
  ...lda(0x1f),
  ...sta(0xd418),
  ...lda(0x11),
  ...sta(0xd404),
  0x60
]
const PLAY_FILTER = LOAD + CODE_FILTER.length

export const TONE_HZ = [481, 722, 962]
/** Pitch of each voice in tone3.sid: VOICE_HI * 256 * 985248 / 2**24. */
export const VOICE_HZ = [481, 797, 1127]

const psid = sidFile({
  magic: 'PSID',
  loadAddress: LOAD,
  initAddress: INIT,
  playAddress: PLAY,
  songs: 3,
  startSong: 1,
  speed: 0,
  name: 'Test Tone',
  author: 'sidplayer fixtures',
  released: '2026 sidplayer',
  flags: FLAGS_PAL_6581,
  data: CODE
})

// RSID rules: the header's load address is 0 and the real one is the first
// two bytes of the data (little-endian, as in a C64 PRG); play address 0;
// speed 0; the tune is expected to install its own interrupt. This one does
// not, which is fine: without a kernal image the engine refuses it before
// running a single instruction.
const rsid = sidFile({
  magic: 'RSID',
  loadAddress: 0,
  initAddress: INIT,
  playAddress: 0,
  songs: 1,
  startSong: 1,
  speed: 0,
  name: 'Test Tone (RSID)',
  author: 'sidplayer fixtures',
  released: '2026 sidplayer',
  flags: FLAGS_PAL_6581,
  data: [LOAD & 0xff, LOAD >> 8, ...CODE]
})

// All three voices at once, so each mute button has something to remove.
const psid3 = sidFile({
  magic: 'PSID',
  loadAddress: LOAD,
  initAddress: INIT,
  playAddress: PLAY3,
  songs: 1,
  startSong: 1,
  speed: 0,
  name: 'Three Voices',
  author: 'sidplayer fixtures',
  released: '2026 sidplayer',
  flags: FLAGS_PAL_6581,
  data: [...CODE3, 0x60]
})

const psidFilter = sidFile({
  magic: 'PSID',
  loadAddress: LOAD,
  initAddress: INIT,
  playAddress: PLAY_FILTER,
  songs: 1,
  startSong: 1,
  speed: 0,
  name: 'Filtered Tone',
  author: 'sidplayer fixtures',
  released: '2026 sidplayer',
  flags: FLAGS_PAL_8580,
  data: [...CODE_FILTER, 0x60]
})

/*
 * Compute!'s Sidplayer. Three voices, each nothing but the HLT command
 * ($01 $4F), then NUL-terminated PETSCII credit lines ended by an empty
 * line. Silent, but structurally complete: enough to prove libsidplayfp
 * installs its Sidplayer driver, accepts the file, and pairs a .str with it.
 *
 *   tune.mus   credits TEST MUS / SIDPLAYER FIXTURES / 2026
 *   tune.str   the stereo half, credits STEREO PART
 *   tune.wds   words: two lines and a page break
 */
const tuneMus = mus(['TEST MUS', 'SIDPLAYER FIXTURES', '2026', 'FOUR VOICES OF NOTHING'])
const tuneStr = mus(['STEREO PART'])
const tuneWds = Uint8Array.from([
  0x00,
  0x09,
  ...petscii('LA LA LA'),
  0x0d,
  ...petscii('WORDS FILE TEST'),
  0x00,
  0x00,
  ...petscii('SECOND PAGE'),
  0x00
])

writeFileSync(join(out, 'tone.sid'), psid)
writeFileSync(join(out, 'tone-rsid.sid'), rsid)
writeFileSync(join(out, 'tone3.sid'), psid3)
writeFileSync(join(out, 'tone-filter.sid'), psidFilter)
writeFileSync(join(out, 'not-a-sid.bin'), Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 1, 2, 3]))
writeFileSync(join(out, 'tune.mus'), tuneMus)
writeFileSync(join(out, 'tune.str'), tuneStr)
writeFileSync(join(out, 'tune.wds'), tuneWds)

/*
 * A picture for the tune, as the Compute's Gazette add-on ships them.
 *
 * A Koala: 8000 bytes of bitmap, 1000 of screen, 1000 of colour, then the
 * background. All zero except the very first cell's top row, which is set
 * to %11111111 - four bit-pairs of 11, which take their colour from the
 * colour RAM - so the top-left eight pixels come out red on a blue screen.
 *
 * It is written packed, with the extension of a whole file, because three
 * of the add-on's 458 .pic files are exactly that and the player has to
 * cope by reading the bytes rather than the name.
 */
const koala = new Uint8Array(10001)
koala[0] = 0xff // first cell, first row: all four pixels from colour RAM
koala[9000] = 2 // that cell's colour RAM entry: red
koala[10000] = 6 // background: blue

const packPicture = (body) => {
  const out = []
  let i = 0
  while (i < body.length) {
    let run = 1
    while (run < 256 && i + run < body.length && body[i + run] === body[i]) run++
    // A run of 256 is a count byte of zero, which is how the packer says it.
    if (run >= 3 || body[i] === 0xfe) {
      out.push(0xfe, body[i], run & 0xff)
      i += run
    } else {
      out.push(body[i])
      i++
    }
  }
  return Uint8Array.from(out)
}
const tunePic = Uint8Array.from([0x00, 0x60, ...packPicture(koala)])
writeFileSync(join(out, 'tune.pic'), tunePic)

/*
 * HVSC-style Songlengths.md5 naming tone.sid's three subsongs, keyed by the
 * whole-file MD5 as HVSC has done since #68. Long enough that the browser
 * test is never overtaken by an auto-advance while it is looking at a subsong.
 */
const songlengths = [
  '[Database]',
  '; /FIXTURES/tone.sid',
  `${createHash('md5').update(psid).digest('hex')}=0:45 1:00(G) 1:30.500`,
  ''
].join('\n')
writeFileSync(join(out, 'Songlengths.md5'), songlengths)
if (RUN_AS_SCRIPT)
  console.log(
    `[fixtures] wrote tone.sid (${psid.length} B), tone-rsid.sid (${rsid.length} B), tone3.sid (${psid3.length} B), tone-filter.sid (${psidFilter.length} B), not-a-sid.bin, tune.mus (${tuneMus.length} B), tune.str, tune.wds, tune.pic (${tunePic.length} B) → ${out}`
  )
