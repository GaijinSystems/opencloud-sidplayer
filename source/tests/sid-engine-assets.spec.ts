import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchEngineAssets } from '../src/sid/engineAssets'
import { SidPlayerError } from '../src/sid/types'

/**
 * The files the engine needs, fetched on the main thread because an
 * AudioWorkletGlobalScope cannot fetch anything.
 *
 * Every failure here is one an administrator has to act on, so each has to
 * name what is actually wrong: absent, unreachable, and present but not a
 * manifest are three different problems with three different fixes.
 */

const BASE = 'https://example.invalid/engine/'

type Answer = { status?: number; json?: unknown; text?: string; bytes?: number } | 'unreachable'

function stubFetch(answers: Record<string, Answer>) {
  const calls: string[] = []
  const fetchOne = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    const answer = answers[url.slice(BASE.length)]
    if (answer === 'unreachable') throw new TypeError('Failed to fetch')
    if (!answer) return { ok: false, status: 404 } as unknown as Response
    const status = answer.status ?? 200
    return {
      ok: status < 400,
      status,
      json: async () => {
        if (answer.text !== undefined) return JSON.parse(answer.text)
        return answer.json
      },
      arrayBuffer: async () => new ArrayBuffer(answer.bytes ?? 8)
    } as unknown as Response
  })
  vi.stubGlobal('fetch', fetchOne)
  return calls
}

afterEach(() => vi.unstubAllGlobals())

describe('fetchEngineAssets', () => {
  it('fetches what the manifest names, required and optional together', async () => {
    stubFetch({
      'engine.json': { json: { files: ['engine.wasm'], optional: ['kernal.bin'] } },
      'engine.wasm': { bytes: 16 },
      'kernal.bin': { bytes: 4 }
    })
    const { assets, transfer } = await fetchEngineAssets(BASE)
    expect(Object.keys(assets.files).sort()).toEqual(['engine.wasm', 'kernal.bin'])
    expect(assets.files['engine.wasm'].byteLength).toBe(16)
    // Every buffer is handed to the worklet by transfer, not by copy.
    expect(transfer).toHaveLength(2)
  })

  it('takes no manifest as an engine that needs nothing', async () => {
    stubFetch({})
    expect((await fetchEngineAssets(BASE)).assets.files).toEqual({})
  })

  it('skips an optional file that is not there and fails on a required one', async () => {
    stubFetch({
      'engine.json': { json: { files: ['engine.wasm'], optional: ['basic.bin'] } },
      'engine.wasm': {}
    })
    expect(Object.keys((await fetchEngineAssets(BASE)).assets.files)).toEqual(['engine.wasm'])

    stubFetch({ 'engine.json': { json: { files: ['engine.wasm'] } } })
    await expect(fetchEngineAssets(BASE)).rejects.toThrowError(/build.sh/)
  })

  it('ignores a name that is not a bare file in the engine directory', async () => {
    const calls = stubFetch({
      'engine.json': { json: { files: ['../../secrets', 'a/b.bin', '', 7, 'engine.wasm'] } },
      'engine.wasm': {}
    })
    await fetchEngineAssets(BASE)
    expect(calls).toEqual([`${BASE}engine.json`, `${BASE}engine.wasm`])
  })

  /*
   * A manifest that arrives and will not parse is a deployment that is there
   * and wrong. Reporting it as unreachable sent whoever has to fix it looking
   * at the web server instead of at the file.
   */
  it('tells invalid JSON apart from a directory it could not reach', async () => {
    stubFetch({ 'engine.json': { text: '{ not json' } })
    await expect(fetchEngineAssets(BASE)).rejects.toThrowError(/not valid JSON/)

    stubFetch({ 'engine.json': 'unreachable' })
    await expect(fetchEngineAssets(BASE)).rejects.toThrowError(/could not be reached/)
  })

  it('refuses a manifest that is not an object rather than throwing a TypeError at the user', async () => {
    // A file holding the four characters `null` parses perfectly well and
    // used to reach `manifest.files` on it.
    for (const json of [null, [], 'engine.wasm']) {
      stubFetch({ 'engine.json': { json } })
      const failure: unknown = await fetchEngineAssets(BASE).catch((e) => e)
      expect(failure).toBeInstanceOf(SidPlayerError)
      expect((failure as SidPlayerError).code).toBe('backend-unavailable')
      expect((failure as SidPlayerError).message).toMatch(/not a JSON object/)
    }
  })

  it('reports a manifest the server refused to serve with its status', async () => {
    stubFetch({ 'engine.json': { status: 500 } })
    await expect(fetchEngineAssets(BASE)).rejects.toThrowError(/HTTP 500/)
  })

  it('lets an abort through as an abort', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      })
    )
    await expect(fetchEngineAssets(BASE)).rejects.toThrowError(/aborted/)
  })
})
