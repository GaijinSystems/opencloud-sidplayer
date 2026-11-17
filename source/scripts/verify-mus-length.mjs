/**
 * Checks `musLength` against the engine's own playback.
 *
 * No shebang and run through Node's type stripping, because it imports the
 * TypeScript module it is checking:
 *
 *   node --experimental-strip-types scripts/verify-mus-length.mjs <dir>
 *
 * A MUS file says how long it is only in the sense that a score does: note
 * durations and a tempo, with repeats and phrase calls to expand. Two things
 * in that arithmetic are not documented anywhere the author could find - the
 * tempo the driver starts at, and whether `HED n` plays a section n times or
 * n times again - so they were measured rather than guessed, and this is the
 * measurement.
 *
 * The method: play each tune through the real engine and note the last
 * moment it makes a sound. That is the truth the score is checked against.
 * It costs about twenty seconds of wall clock per tune, since a tune has to
 * be rendered in full plus a tail of silence.
 *
 * Needs the collection, which is not ours to commit:
 *
 *   curl -O https://www.c64music.co.uk/CGSC_v147.7z    # send a browser UA
 *   7z x CGSC_v147.7z -o/tmp/cgsc
 *   node scripts/verify-mus-length.mjs /tmp/cgsc/CGSC [count]
 *
 * With no arguments it prints this and exits 0, so it is safe in a script.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { musLength } from '../src/sid/musLength.ts'
import { check, engineDir, FRAMES, report, SAMPLE_RATE, startEngine, toArrayBuffer } from './engine-harness.mjs'

/** Quieter than this counts as no sound at all. */
const SILENCE_LEVEL = 0.002
/** Long enough to clear the longest rest seen inside a tune, which was 4.9s. */
const TAIL_SECONDS = 8
const LIMIT_SECONDS = 480

const collection = process.argv[2]
if (!collection) {
  console.log('usage: node scripts/verify-mus-length.mjs <unpacked CGSC dir> [count]')
  console.log('see the comment at the top of this file for where to get it')
  process.exit(0)
}
if (!existsSync(collection)) {
  console.error(`no such directory: ${collection}`)
  process.exit(2)
}
if (!existsSync(join(engineDir, 'libsidplayfp.wasm'))) {
  console.error('missing the built engine; run engine/build.sh first')
  process.exit(2)
}

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })

const all = walk(collection)
  .filter((f) => f.toLowerCase().endsWith('.mus'))
  .sort()
const count = Math.min(Number(process.argv[3]) || 40, all.length)
// Spread through the collection rather than taking the first N, which would
// all be one composer.
const step = Math.max(1, Math.floor(all.length / count))
const chosen = Array.from({ length: count }, (_, i) => all[i * step]).filter(Boolean)

const engine = await startEngine(toArrayBuffer(readFileSync(join(engineDir, 'libsidplayfp.wasm'))))

/** The last moment this tune makes a sound, as the engine plays it. */
function playedFor(bytes) {
  engine.load(bytes, 1)
  const left = new Float32Array(FRAMES)
  const right = new Float32Array(FRAMES)
  let last = 0
  const blocks = Math.ceil((SAMPLE_RATE * LIMIT_SECONDS) / FRAMES)
  for (let b = 0; b < blocks; b++) {
    engine.render(left, right)
    let peak = 0
    for (let i = 0; i < FRAMES; i++) {
      peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]))
    }
    const at = ((b + 1) * FRAMES) / SAMPLE_RATE
    if (peak > SILENCE_LEVEL) last = at
    if (last && at - last > TAIL_SECONDS) break
  }
  return last
}

const time = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
const rows = []
for (const path of chosen) {
  const bytes = new Uint8Array(readFileSync(path))
  const heard = playedFor(bytes)
  if (!heard) continue // never made a sound; nothing to compare against
  rows.push({
    name: path.slice(collection.length + 1),
    heard,
    score: musLength(bytes) ?? 0
  })
  process.stderr.write(`\r${rows.length}/${chosen.length}`)
}
process.stderr.write('\r')

const relative = (a, b) => (b ? (a - b) / b : 0)
const errors = rows.map((r) => relative(r.score, r.heard))
const sorted = errors.map(Math.abs).sort((a, b) => a - b)
const within = (t) => errors.filter((e) => Math.abs(e) <= t).length

console.log(`\n${rows.length} tunes played against their scores\n`)
for (const r of rows.sort(
  (a, b) => Math.abs(relative(b.score, b.heard)) - Math.abs(relative(a.score, a.heard))
)) {
  const off = relative(r.score, r.heard) * 100
  console.log(
    `  ${time(r.heard).padStart(6)} heard  ${time(r.score).padStart(6)} score  ${String(off.toFixed(0)).padStart(5)}%  ${r.name}`
  )
}
console.log('')
console.log(`  median error ${(sorted[sorted.length >> 1] * 100).toFixed(1)}%`)
/*
 * What is claimed, and no more. The constants were fitted on 40 tunes and
 * the first fresh sample of 16 was worse - median 1.1% against 3.7% - so
 * these thresholds are set where a fresh sample can be expected to land,
 * not where the fitted one did.
 *
 * There is deliberately no check that the figure is safe to stop at. It is
 * not: on that fresh sample it was out by more than half on one tune, in
 * both directions. The player ends a Sidplayer tune when the sound stops
 * and shows this figure on the clock, which is all it is good for.
 */
check(
  sorted[sorted.length >> 1] <= 0.05,
  `half the tunes are within 5% (median ${(sorted[sorted.length >> 1] * 100).toFixed(1)}%)`
)
check(within(0.15) >= rows.length * 0.7, `within 15% on ${within(0.15)} of ${rows.length}`)
check(
  errors.every((e) => Math.abs(e) < 1),
  'and never out by more than the length of the tune again'
)

report()
