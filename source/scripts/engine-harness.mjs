/**
 * What the scripts that drive the built engine outside a browser share: where
 * it is, the rate and block size it is rendered at, and how it is started.
 *
 * `verify-engine.mjs` and `verify-mus-length.mjs` each had their own copy,
 * and the two have to agree - a length measured at one sample rate is not
 * checked by an engine verified at another.
 *
 * Importing this does nothing. `verify-mus-length.mjs` prints its usage and
 * exits before it has looked for the engine at all, so nothing here may touch
 * the disk until it is asked to.
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export { check, failureCount, report } from './checks.mjs'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const engineDir = join(root, 'public', 'vendor', 'sid-engine')

export const SAMPLE_RATE = 44100
/** One render quantum, which is what an AudioWorklet is asked for at a time. */
export const FRAMES = 128

/**
 * The bytes of a Node Buffer as an ArrayBuffer of their own. A Buffer is
 * often a window onto a larger pool, so its `.buffer` alone would hand over
 * whatever else is in the pool.
 */
export const toArrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)

/** Starts the engine over `wasm`, the bytes of libsidplayfp.wasm as an ArrayBuffer. */
export async function startEngine(wasm) {
  const { createEngine } = await import(pathToFileURL(join(engineDir, 'engine.js')).href)
  return createEngine({ sampleRate: SAMPLE_RATE, assets: { files: { 'libsidplayfp.wasm': wasm } } })
}
