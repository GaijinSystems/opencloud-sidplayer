import { resolveEngineUrl } from '../helpers/assetUrl'
import { SidPlayerError } from './types'

/**
 * Files the engine needs, fetched on the main thread because an
 * AudioWorkletGlobalScope cannot fetch anything.
 *
 * `engine.json` beside the processor names them. `files` are required and a
 * missing one is an error the user sees; `optional` ones (ROM images, say)
 * are fetched if present and silently skipped otherwise. No manifest at all
 * means an engine that needs nothing, such as a pure JavaScript one.
 */

export interface EngineAssets {
  files: Record<string, ArrayBuffer>
}

interface EngineManifest {
  name?: string
  files?: string[]
  optional?: string[]
}

/** A bare file name in the engine directory: no slashes, no parent references. */
const SAFE_NAME = /^[\w][\w.-]*$/

const namesOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && SAFE_NAME.test(v)) : []

export async function fetchEngineAssets(
  engineBaseUrl: string | null,
  signal?: AbortSignal
): Promise<{ assets: EngineAssets; transfer: ArrayBuffer[] }> {
  let manifest: EngineManifest = {}
  const manifestUrl = resolveEngineUrl(engineBaseUrl, 'engine.json')
  let response: Response
  // Only the fetch itself is under this catch. A manifest that arrives and
  // will not parse is a deployment that is there and wrong, and reporting it
  // as unreachable sends whoever has to fix it looking at the wrong thing.
  try {
    response = await fetch(manifestUrl, { signal })
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e
    // Not reachable at all, as opposed to absent: say so rather than guess.
    throw new SidPlayerError('backend-unavailable', 'The engine directory could not be reached.', e)
  }
  if (response.ok) {
    let parsed: unknown
    try {
      parsed = await response.json()
    } catch (e) {
      throw new SidPlayerError('backend-unavailable', 'The engine manifest is not valid JSON.', e)
    }
    // `null` parses, and a file holding the four characters `null` used to
    // reach `manifest.files` and throw a bare TypeError at the user instead
    // of any of these messages. An array is no more a manifest than null is.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new SidPlayerError('backend-unavailable', 'The engine manifest is not a JSON object.')
    }
    manifest = parsed as EngineManifest
  } else if (response.status !== 404) {
    throw new SidPlayerError(
      'backend-unavailable',
      `The engine manifest could not be fetched (HTTP ${response.status}).`
    )
  }

  const files: Record<string, ArrayBuffer> = {}
  const transfer: ArrayBuffer[] = []

  const fetchOne = async (name: string, required: boolean) => {
    const url = resolveEngineUrl(engineBaseUrl, name)
    let response: Response
    try {
      response = await fetch(url, { signal })
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e
      if (!required) return
      throw new SidPlayerError('backend-unavailable', `${name} could not be fetched.`, e)
    }
    if (!response.ok) {
      if (!required) return
      throw new SidPlayerError(
        'backend-unavailable',
        response.status === 404
          ? `${name} is not deployed beside the engine. Build it with source/engine/build.sh and redeploy.`
          : `${name} could not be fetched (HTTP ${response.status}).`
      )
    }
    const buffer = await response.arrayBuffer()
    files[name] = buffer
    transfer.push(buffer)
  }

  await Promise.all([
    ...namesOf(manifest.files).map((name) => fetchOne(name, true)),
    ...namesOf(manifest.optional).map((name) => fetchOne(name, false))
  ])

  return { assets: { files }, transfer }
}
