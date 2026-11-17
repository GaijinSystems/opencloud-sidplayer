#!/usr/bin/env node
/**
 * Drives the real engine, outside a browser.
 *
 * `engine.js` and `sid-processor.js` are plain ES modules written for an
 * AudioWorkletGlobalScope, which is a smaller environment than Node, so Node
 * can host them once the three worklet globals are supplied. This runs the
 * built libsidplayfp.wasm through both files against the generated fixtures
 * and asserts on the audio that comes out: that there is sound, that it is
 * at the pitch the 6502 code asked for, and that each subsong changes it.
 *
 * Usage: node scripts/verify-engine.mjs        (after engine/build.sh and npm run fixtures)
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  check,
  engineDir,
  FRAMES,
  report,
  root,
  SAMPLE_RATE,
  startEngine,
  toArrayBuffer
} from './engine-harness.mjs'
// The pitches the fixtures' 6502 code programs, from the script that writes
// them. They were copied here once and then maintained in two places; a
// fixture change that moved a frequency would have left this file checking the
// old one. Importing it writes nothing: see the guard in make-fixtures.mjs.
import { TONE_HZ, VOICE_HZ } from './make-fixtures.mjs'

const fixtures = join(root, 'tests', 'fixtures')

const readFixture = (name) => new Uint8Array(readFileSync(join(fixtures, name)))

for (const f of ['libsidplayfp.wasm', 'engine.js', 'sid-processor.js', 'engine.json']) {
  if (!existsSync(join(engineDir, f))) {
    console.error(`missing ${f}; run engine/build.sh first`)
    process.exit(2)
  }
}
for (const f of ['tone.sid', 'tone-rsid.sid', 'tone3.sid', 'tone-filter.sid', 'not-a-sid.bin']) {
  if (!existsSync(join(fixtures, f))) {
    console.error(`missing tests/fixtures/${f}; run npm run fixtures first`)
    process.exit(2)
  }
}

const wasm = toArrayBuffer(readFileSync(join(engineDir, 'libsidplayfp.wasm')))
const manifest = JSON.parse(readFileSync(join(engineDir, 'engine.json'), 'utf8'))
check(manifest.files?.includes('libsidplayfp.wasm'), 'engine.json names libsidplayfp.wasm as required')

/* ---- what the module imports: every one must be one engine.js stubs ------ */
const module = await WebAssembly.compile(wasm)
const imports = WebAssembly.Module.imports(module)
console.log('  module imports:', imports.map((i) => `${i.module}.${i.name}`).join(', ') || '(none)')
const exportsList = WebAssembly.Module.exports(module).map((e) => e.name)
for (const name of [
  'memory',
  'malloc',
  'free',
  'sid_create',
  'sid_load',
  'sid_render',
  'sid_error',
  'sid_version',
  'sid_mute',
  'sid_set_model',
  'sid_set_clock',
  '_initialize'
]) {
  check(exportsList.includes(name), `module exports ${name}`)
}

/* ---- audio measurement helpers ------------------------------------------- */
function render(engine, seconds) {
  const frames = Math.round(SAMPLE_RATE * seconds)
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  const l = new Float32Array(FRAMES)
  const r = new Float32Array(FRAMES)
  for (let o = 0; o < frames; o += FRAMES) {
    engine.render(l, r)
    left.set(l.subarray(0, Math.min(FRAMES, frames - o)), o)
    right.set(r.subarray(0, Math.min(FRAMES, frames - o)), o)
  }
  return { left, right }
}

const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length)
const peak = (a) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
/**
 * Fundamental in Hz, by scanning for the strongest sinusoid near `expected`.
 * Zero-crossing counting was tried first and drifted a few percent: the 6581
 * emulation has a DC offset that moves over the first second, and a fixed
 * mean then misses crossings. A Goertzel scan is immune to that.
 */
function pitch(a, expected, span = 80) {
  const mean = a.reduce((s, v) => s + v, 0) / a.length
  let best = -1
  let bestHz = 0
  for (let hz = expected - span; hz <= expected + span; hz += 1) {
    const w = (2 * Math.PI * hz) / SAMPLE_RATE
    let re = 0
    let im = 0
    for (let n = 0; n < a.length; n++) {
      const v = a[n] - mean
      re += v * Math.cos(w * n)
      im -= v * Math.sin(w * n)
    }
    const power = re * re + im * im
    if (power > best) {
      best = power
      bestHz = hz
    }
  }
  return bestHz
}
const near = (value, target, tolerance) => Math.abs(value - target) <= tolerance
/** Amplitude of one frequency component, for telling voices apart in a mix. */
function tonePower(a, hz) {
  const mean = a.reduce((s, v) => s + v, 0) / a.length
  const w = (2 * Math.PI * hz) / SAMPLE_RATE
  let re = 0
  let im = 0
  for (let i = 0; i < a.length; i++) {
    const v = a[i] - mean
    re += v * Math.cos(w * i)
    im += v * Math.sin(w * i)
  }
  return Math.sqrt(re * re + im * im) / a.length
}

/* ---- engine.js directly --------------------------------------------------- */
console.log('\nengine.js')
const engine = await startEngine(wasm.slice(0))
check(
  typeof engine.version === 'string' && /libsidplayfp/.test(engine.version),
  `reports a version: ${engine.version}`
)

const tone = readFixture('tone.sid')
for (let song = 1; song <= 3; song++) {
  engine.load(tone, song)
  // Skip the first tenth of a second: the attack and the SID's own settling.
  render(engine, 0.1)
  const { left, right } = render(engine, 1.0)
  const hz = pitch(left.subarray(0, 8192), TONE_HZ[song - 1])
  check(
    rms(left) > 0.01,
    `subsong ${song}: produces sound (rms ${rms(left).toFixed(3)}, peak ${peak(left).toFixed(3)})`
  )
  check(peak(left) <= 1.0, `subsong ${song}: within -1..1`)
  check(near(hz, TONE_HZ[song - 1], 3), `subsong ${song}: pitch ${hz} Hz, expected ${TONE_HZ[song - 1]}`)
  // Mono SID on a stereo bus: libsidplayfp puts the single chip on both sides.
  check(near(rms(right), rms(left), 0.002), `subsong ${song}: right channel matches left`)
}

// Reloading restarts from the top: libsidplayfp's own clock says so.
render(engine, 2.0)
const before = engine.ex.sid_time(engine.handle)
engine.load(tone, 1)
const afterReload = engine.ex.sid_time(engine.handle)
check(before >= 2 && afterReload === 0, `reload restarts the tune (emulated time ${before}s → ${afterReload}s)`)

// Error paths must throw a message a person can act on, not crash the module.
let msg = ''
try {
  engine.load(readFixture('not-a-sid.bin'), 1)
} catch (e) {
  msg = e.message
}
check(/libsidplayfp: .+/.test(msg), `rejects a non-SID file: "${msg}"`)

msg = ''
try {
  engine.load(readFixture('tone-rsid.sid'), 1)
} catch (e) {
  msg = e.message
}
check(/kernal|rom/i.test(msg), `RSID without a kernal names the missing ROM: "${msg}"`)

// After a failed load the engine must still be usable.
engine.load(tone, 2)
render(engine, 0.1)
check(near(pitch(render(engine, 0.3).left, TONE_HZ[1]), TONE_HZ[1], 3), 'plays again after a failed load')

// Per-voice mute, tested the way it is used: while the tune plays, with no
// reload. Upstream reSIDfp substitutes zero for the tune's next write to the
// voice's control register, which does nothing at all to a tune that writes
// that register once at init; engine/patches/0001-instant-voice-mute.patch
// moves the mute to the mixing stage instead. tone3.sid is exactly that kind
// of tune, with all three voices gated once on distinct pitches, so each
// voice can be measured on its own. Levels are AC (mean removed), since the
// 6581 emulation sits on a DC offset that would otherwise read as sound.
const acRms = (a) => {
  const mean = a.reduce((s, v) => s + v, 0) / a.length
  return Math.sqrt(a.reduce((s, v) => s + (v - mean) ** 2, 0) / a.length)
}
const three = readFixture('tone3.sid')
engine.load(three, 1)
render(engine, 0.3)
const mixed = render(engine, 0.3).left
const solo = VOICE_HZ.map((hz) => tonePower(mixed, hz))
check(
  solo.every((p) => p > 0.002),
  `all three voices sound: ${solo.map((p, i) => `${VOICE_HZ[i]} Hz ${p.toFixed(4)}`).join(', ')}`
)

for (let v = 0; v < 3; v++) {
  engine.mute(0, v, true)
  render(engine, 0.05) // drain the 512-frame burst rendered before the mute
  const after = VOICE_HZ.map((hz) => tonePower(render(engine, 0.3).left, hz))
  check(
    after[v] < solo[v] / 10,
    `muting voice ${v + 1} live drops its ${VOICE_HZ[v]} Hz partial (${solo[v].toFixed(4)} → ${after[v].toFixed(4)})`
  )
  check(
    VOICE_HZ.every((_, o) => o === v || after[o] > solo[o] / 2),
    `muting voice ${v + 1} leaves the other two alone`
  )
  engine.mute(0, v, false)
  render(engine, 0.05)
  const back = tonePower(render(engine, 0.3).left, VOICE_HZ[v])
  check(back > solo[v] / 2, `unmuting voice ${v + 1} live brings it back (${back.toFixed(4)})`)
}

/*
 * All three at once, which must leave silence rather than near-silence.
 *
 * The drain before measuring is longer here, and it is not the fade: a 6581
 * voice carries a DC pedestal, and when one stops contributing - muted, or
 * simply done with its note - the filter and the external filter discharge
 * that DC over about half a second. Measured 0.057 peak immediately after a
 * mute, under 0.001 by 0.5 s, nothing by 0.8 s. Ramping the mute more slowly
 * does not avoid it (66 ms was tried: same tail, and the note audibly lingers),
 * because it is the emulated analogue path doing what it does whenever a voice
 * goes quiet. So: assert the voice's own partial dies at once, above, and
 * assert real silence once the pedestal has drained, here.
 */
for (let v = 0; v < 3; v++) engine.mute(0, v, true)
render(engine, 0.6)
const allMuted = acRms(render(engine, 0.3).left)
check(
  allMuted < acRms(mixed) / 50,
  `muting every voice silences the tune (${acRms(mixed).toFixed(3)} → ${allMuted.toFixed(5)})`
)
engine.load(three, 1)
render(engine, 0.6)
check(acRms(render(engine, 0.3).left) < acRms(mixed) / 50, 'the mutes survive a reload')
for (let v = 0; v < 3; v++) engine.mute(0, v, false)

// The single-voice fixture, which is what a person is most likely to try
// first: muting its one voice must silence it without a reload.
engine.load(tone, 1)
render(engine, 0.3)
const oneLoud = acRms(render(engine, 0.3).left)
engine.mute(0, 0, true)
render(engine, 0.05)
const oneFast = tonePower(render(engine, 0.2).left, TONE_HZ[0])
check(oneFast < 0.001, `tone.sid: the note stops within 50 ms of the mute (${oneFast.toFixed(5)})`)
render(engine, 0.6)
const oneQuiet = acRms(render(engine, 0.3).left)
check(
  oneQuiet < oneLoud / 50,
  `tone.sid: muting voice 1 mid-playback silences it (${oneLoud.toFixed(3)} → ${oneQuiet.toFixed(5)})`
)
engine.mute(0, 0, false)
render(engine, 0.05)
check(acRms(render(engine, 0.3).left) > oneLoud / 2, 'tone.sid: unmuting mid-playback brings it back')

// Muting an unused voice must not touch the mix.
engine.mute(0, 2, true)
render(engine, 0.05)
check(near(acRms(render(engine, 0.3).left), oneLoud, oneLoud / 4), 'muting an unused voice changes nothing')
engine.mute(0, 2, false)

// Clock override: on NTSC the same register value is a higher pitch, by the
// ratio of the two crystal frequencies. Model override must keep playing.
engine.load(tone, 1)
engine.setEmulation({ model: 'auto', clock: 'ntsc' })
render(engine, 0.2)
const ntscHz = pitch(render(engine, 0.3).left, Math.round((TONE_HZ[0] * 1022727) / 985248))
check(
  near(ntscHz, Math.round((TONE_HZ[0] * 1022727) / 985248), 3),
  `forcing NTSC raises the pitch: ${ntscHz} Hz`
)
/*
 * The 8580, for longer than it takes to go wrong, and with a ceiling as well
 * as a floor.
 *
 * Both halves matter. `filter8580Curve` takes a position from 0 to 1, not the
 * centre frequency its public header still advertises, and passing 12500 gave
 * an 8580 filter made of nonsense: sound for about half a second, then a
 * constant, on seven of every ten HVSC tunes that ask for that chip. This
 * check used to render 0.7 s and test only `rms > 0.01`, so it saw neither
 * the collapse nor the full-scale clipping that came with it.
 */
engine.setEmulation({ model: '8580', clock: 'auto' })
render(engine, 0.2)
const hz8580 = pitch(render(engine, 0.3).left, TONE_HZ[0])
check(near(hz8580, TONE_HZ[0], 3), `forcing the 8580 plays at ${hz8580} Hz`)
const late8580 = render(engine, 2.5)
const lateRms = rms(late8580.left.subarray(late8580.left.length - SAMPLE_RATE))
check(lateRms > 0.01, `and is still sounding three seconds later: rms ${lateRms.toFixed(4)}`)
const peak8580 = peak(late8580.left)
check(peak8580 < 0.98, `without driving the output to full scale: peak ${peak8580.toFixed(4)}`)
engine.setEmulation({ model: '6581', clock: 'auto' })
render(engine, 0.5)
const late6581 = render(engine, 1.5)
const peak6581 = peak(late6581.left)
check(rms(late6581.left) > 0.01, `the 6581 keeps sounding too: rms ${rms(late6581.left).toFixed(4)}`)
check(peak6581 < 0.98, `and stays off the rails as well: peak ${peak6581.toFixed(4)}`)
engine.setEmulation({ model: 'auto', clock: 'auto' })

/*
 * The filter, on the chip whose filter was wrong.
 *
 * tone-filter.sid asks for a MOS8580 and routes its voice through a resonant
 * low-pass; nothing else in the fixtures writes a filter register, which is
 * exactly why nothing else noticed that `filter8580Curve` had been given
 * 12500 - a centre frequency, as its public header still describes it -
 * where the implementation wants a position from 0 to 1. Filter8580 computes
 * `cp = 1.8 - curvePosition * 3/5` and clamps nothing, so 12500 meant
 * cp = -7498.2: sound for half a second, then a constant.
 */
engine.load(readFixture('tone-filter.sid'), 1)

/*
 * The very start, which is where the second patch earns its place.
 *
 * A C64 couples its audio out through a DC blocker, modelled here as a 1.6 Hz
 * high-pass, and upstream resets it uncharged - so the chip's whole DC
 * pedestal reached the output until it drained, about a second. 2.6.0
 * amplified the signal path and left no headroom for that: this fixture's
 * first 20 ms sat at a mean of 0.9966 with 373 samples of it clipped, and
 * 387 in the first second. Seeding the filter from the first sample instead
 * puts it where it would have settled anyway.
 */
const opening = render(engine, 1)
const clipped = opening.left.reduce((n, v) => n + (Math.abs(v) >= 0.999 ? 1 : 0), 0)
check(clipped === 0, `the first second of an 8580 tune has no sample at full scale: ${clipped} clipped`)
const dc20 = opening.left.subarray(0, Math.round(SAMPLE_RATE * 0.02))
const startMean = dc20.reduce((a, v) => a + v, 0) / dc20.length
check(Math.abs(startMean) < 0.5, `and does not open riding on the DC pedestal: mean ${startMean.toFixed(4)}`)

const filtered = render(engine, 3)
const filteredTail = rms(filtered.left.subarray(filtered.left.length - SAMPLE_RATE))
check(
  filteredTail > 0.005,
  `a resonant 8580 filter is still sounding four seconds in: rms ${filteredTail.toFixed(4)}`
)
check(peak(filtered.left) < 0.98, `and has not run away: peak ${peak(filtered.left).toFixed(4)}`)
const filteredHz = pitch(filtered.left, TONE_HZ[0])
check(near(filteredHz, TONE_HZ[0], 4), `at the pitch it asked for: ${filteredHz} Hz`)

// Compute!'s Sidplayer: libsidplayfp must accept raw MUS data, and a MUS with
// its STR appended. The fixtures are silent (HLT-only voices), so the checks
// are that loading succeeds and rendering runs without complaint.
for (const [label, bytes] of [
  ['tune.mus alone', readFixture('tune.mus')],
  [
    'tune.mus + tune.str appended',
    (() => {
      const a = readFixture('tune.mus')
      const b = readFixture('tune.str')
      const c = new Uint8Array(a.length + b.length)
      c.set(a)
      c.set(b, a.length)
      return c
    })()
  ]
]) {
  let err = ''
  try {
    engine.load(bytes, 1)
    render(engine, 0.3)
  } catch (e) {
    err = e.message
  }
  check(err === '', `Sidplayer ${label} loads and renders${err ? `: ${err}` : ''}`)
}
engine.dispose()

/* ---- sid-processor.js with the worklet globals supplied ------------------ */
console.log('\nsid-processor.js')
const outbox = []
let processorCtor = null
globalThis.sampleRate = SAMPLE_RATE
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = {
      onmessage: null,
      postMessage: (m) => outbox.push(m)
    }
  }
}
globalThis.registerProcessor = (name, ctor) => {
  check(name === 'sid-processor', `registers as "${name}"`)
  processorCtor = ctor
}
await import(pathToFileURL(join(engineDir, 'sid-processor.js')).href)
check(typeof processorCtor === 'function', 'registerProcessor was called')

const proc = new processorCtor()
const send = (m) => proc.port.onmessage({ data: m })
const take = (type) => {
  const i = outbox.findIndex((m) => m.type === type)
  return i === -1 ? null : outbox.splice(i, 1)[0]
}
/*
 * Wait on an answer rather than on a stopwatch.
 *
 * This is the message that follows a WebAssembly compile of about 300 kB. A
 * fixed 50 ms sleep was enough on the machine it was written on and has no
 * margin at all on a loaded CI box: the check failed as "init answers
 * engine-ready" with a perfectly good engine still compiling. The budget
 * matches the app's own engine-start timeout (15 s, see
 * docs/engine-contract.md), and engine-error is waited for too so a real
 * failure is reported as itself instead of as a timeout.
 */
const waitFor = async (types, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    for (const type of types) {
      const message = take(type)
      if (message) return message
    }
    if (Date.now() >= deadline) return null
    await new Promise((r) => setTimeout(r, 10))
  }
}
const quantum = () => {
  const out = [[new Float32Array(FRAMES), new Float32Array(FRAMES)]]
  proc.process([], out)
  return out[0]
}

// Before init: silence and a clear refusal.
let [l] = quantum()
check(rms(l) === 0, 'silent before init')
send({ type: 'load', id: 1, bytes: toArrayBuffer(Buffer.from(tone)), subsong: 1 })
check(take('error')?.message === 'The SID engine is not available.', 'load before init is refused by name')

send({ type: 'init', assets: { files: { 'libsidplayfp.wasm': wasm.slice(0) } } })
const ready = await waitFor(['engine-ready', 'engine-error'])
check(
  ready?.type === 'engine-ready',
  `init answers engine-ready (${ready?.version ?? ready?.message ?? 'nothing within 15 s'})`
)

send({ type: 'load', id: 2, bytes: toArrayBuffer(Buffer.from(tone)), subsong: 3 })
check(take('loaded')?.id === 2, 'load answers loaded with its id')
;[l] = quantum()
check(rms(l) === 0, 'still silent while paused')

send({ type: 'pause', paused: false })
const collected = new Float32Array(SAMPLE_RATE)
for (let o = 0; o < SAMPLE_RATE; o += FRAMES) {
  const [a] = quantum()
  collected.set(a.subarray(0, Math.min(FRAMES, SAMPLE_RATE - o)), o)
}
check(rms(collected) > 0.01, 'produces sound once unpaused')
const procHz = pitch(collected.subarray(SAMPLE_RATE / 10, SAMPLE_RATE / 10 + 8192), TONE_HZ[2])
check(near(procHz, TONE_HZ[2], 3), `subsong 3 pitch from the processor: ${procHz} Hz`)
const positions = outbox.filter((m) => m.type === 'position')
check(
  positions.length >= 3 && positions.length <= 5,
  `position reported ${positions.length} times in one second`
)
check(positions.at(-1).frames > SAMPLE_RATE * 0.7, `position frames advance (${positions.at(-1).frames})`)
outbox.length = 0

send({ type: 'subsong', id: 3, subsong: 1 })
check(take('loaded')?.id === 3, 'subsong answers loaded')
for (let i = 0; i < 40; i++) quantum()
const after = new Float32Array(SAMPLE_RATE / 2)
for (let o = 0; o < after.length; o += FRAMES) {
  const [a] = quantum()
  after.set(a.subarray(0, Math.min(FRAMES, after.length - o)), o)
}
const afterHz = pitch(after.subarray(0, 8192), TONE_HZ[0])
check(near(afterHz, TONE_HZ[0], 3), `subsong 1 after switch: ${afterHz} Hz`)
const firstPosition = outbox.find((m) => m.type === 'position')
check(firstPosition && firstPosition.frames <= SAMPLE_RATE, 'frame counter reset on subsong change')

send({ type: 'pause', paused: true })
;[l] = quantum()
check(rms(l) === 0, 'silent again when paused')

send({ type: 'subsong', id: 4, subsong: 1 })
take('loaded')
outbox.length = 0
send({ type: 'load', id: 5, bytes: toArrayBuffer(Buffer.from(readFixture('not-a-sid.bin'))), subsong: 1 })
const bad = take('error')
check(bad?.id === 5 && /libsidplayfp/.test(bad.message), `bad file answers error with id: "${bad?.message}"`)

/* ---- end of tune by listening -------------------------------------------- */
console.log('\nend of tune by silence')
/*
 * A Sidplayer score has no length in it, so the worklet reports the end when
 * the output stays quiet - the SID falls silent once the driver halts every
 * voice. Muting a tune that is sounding produces exactly that condition
 * without needing a fixture that stops on its own.
 */
const SILENCE_SECONDS = 8
const playQuanta = (n) => {
  for (let i = 0; i < n; i++) quantum()
}
const quietenAll = () => {
  for (let v = 0; v < 3; v++) send({ type: 'mute', sid: 0, voice: v, on: true })
}
const unmuteAll = () => {
  for (let v = 0; v < 3; v++) send({ type: 'mute', sid: 0, voice: v, on: false })
}

outbox.length = 0
unmuteAll()
send({ type: 'load', id: 6, bytes: toArrayBuffer(Buffer.from(tone)), subsong: 1, endOnSilence: true })
check(take('loaded')?.id === 6, 'a tune can be loaded asking for the end to be listened for')
send({ type: 'pause', paused: false })
playQuanta(Math.ceil(SAMPLE_RATE / FRAMES))
check(!outbox.some((m) => m.type === 'ended'), 'a tune that is still sounding is not reported as ended')

quietenAll()
playQuanta(Math.ceil((SAMPLE_RATE * (SILENCE_SECONDS - 2)) / FRAMES))
check(
  !outbox.some((m) => m.type === 'ended'),
  `still not ended after ${SILENCE_SECONDS - 2}s of quiet, which a long rest would be`
)
playQuanta(Math.ceil((SAMPLE_RATE * 3) / FRAMES))
const ended = take('ended')
check(!!ended, `ended once the quiet passed ${SILENCE_SECONDS}s`)
check(
  ended && Math.abs(ended.frames / SAMPLE_RATE - 1) < 0.5,
  `and reports where the sound stopped, not where the silence ran out (${(ended?.frames ?? 0) / SAMPLE_RATE}s)`
)
outbox.length = 0
playQuanta(Math.ceil((SAMPLE_RATE * SILENCE_SECONDS) / FRAMES))
check(!outbox.some((m) => m.type === 'ended'), 'and says so once, not on every quantum afterwards')

// Once per playing, not once per load. When a tune ends the main thread
// restarts it through the subsong message, ready to be played again; that
// playing has to end too, or it runs on in silence for ever.
outbox.length = 0
unmuteAll()
send({ type: 'subsong', id: 9, subsong: 1 })
check(take('loaded')?.id === 9, 'the ended tune restarts through the subsong message')
playQuanta(Math.ceil(SAMPLE_RATE / FRAMES))
quietenAll()
playQuanta(Math.ceil((SAMPLE_RATE * (SILENCE_SECONDS + 2)) / FRAMES))
check(!!take('ended'), 'and is reported as ended again when that playing falls silent')

// A tune that has never made a sound is not over; it may not have started.
outbox.length = 0
unmuteAll()
send({ type: 'load', id: 7, bytes: toArrayBuffer(Buffer.from(tone)), subsong: 1, endOnSilence: true })
take('loaded')
quietenAll()
playQuanta(Math.ceil((SAMPLE_RATE * (SILENCE_SECONDS + 2)) / FRAMES))
check(!outbox.some((m) => m.type === 'ended'), 'a tune that never made a sound is not reported as ended')

// And without asking, nothing is watched at all.
outbox.length = 0
unmuteAll()
send({ type: 'load', id: 8, bytes: toArrayBuffer(Buffer.from(tone)), subsong: 1 })
take('loaded')
playQuanta(Math.ceil(SAMPLE_RATE / FRAMES))
quietenAll()
playQuanta(Math.ceil((SAMPLE_RATE * (SILENCE_SECONDS + 2)) / FRAMES))
check(!outbox.some((m) => m.type === 'ended'), 'a tune loaded without endOnSilence is never reported as ended')
unmuteAll()

report()
