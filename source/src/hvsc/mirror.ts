import { documentPath, DOCUMENTS, DOCUMENTS_FOLDER } from './sync'
import { decodeLatin1 } from './text'
import { rooted } from '../sid/source'

/**
 * The HVSC mirror, reached through a path on this instance's own origin.
 *
 * The collection cannot be fetched from the browser directly: HVSC's version
 * API answers 403 to any request carrying an `Origin` header, and the mirror
 * sends no `Access-Control-Allow-Origin` at all. `deploy/haproxy-hvsc.cfg`
 * forwards `/hvsc-mirror/*` to it read-only, which makes every request below
 * same-origin and removes the problem; `hvscMirrorPath` in the app config
 * points here.
 *
 * The mirror serves the collection unpacked under `C64Music/`, so no archive
 * is downloaded and no 7-Zip is needed anywhere.
 */

export interface MirrorOps {
  /** Release number the mirror is currently offering, or null if unreadable. */
  release(): Promise<number | null>
  /** One file from `DOCUMENTS/`, decoded from Latin-1. */
  document(name: string): Promise<string>
  /** One tune, by collection path. */
  tune(path: string): Promise<Uint8Array>
  /** Whether the mirror answers at all, for the first-run checks. */
  reachable(): Promise<boolean>
}

/**
 * `DOCUMENTS/HVSC.txt` opens with a banner carrying a line that reads
 * "Release 85". That is the only machine-readable statement of the version
 * the mirror carries, the version API being closed to browsers.
 *
 * Found by scanning the first 4 kB rather than by counting lines, which is
 * why the exact position has never mattered: the banner puts it on the fifth
 * line of the file and the fourth that has anything on it, and the two
 * readings had ended up in different comments.
 */
export function parseRelease(text: string): number | null {
  const m = /^\s*Release\s+(\d{1,4})\s*$/m.exec(text.slice(0, 4096))
  return m ? Number(m[1]) : null
}

const HEAD = 4096
/** The document whose banner names the release. */
const RELEASE_PATH = documentPath(DOCUMENTS.release)

/**
 * More than any file the collection holds - a tune is a few kilobytes, the
 * largest document about 5 MB - and less than a tab can be asked to hold
 * six at a time. What comes back through a proxy is not trusted to be the
 * file it was asked for, and a broken or hostile upstream streaming without
 * end would otherwise be buffered until the tab ran out of memory.
 */
export const MIRROR_MAX_BYTES = 16 * 1024 * 1024

/**
 * And a tune much less than a document. A C64 has 64 kB of memory and a SID
 * file is an image of some of it; the megabyte is room to spare, not a size
 * any tune reaches. The MD5 a tune is checked against comes from the same
 * mirror, so it is no defence against one filling a space with files of the
 * larger limit, sixteen megabytes at a time.
 */
export const MIRROR_TUNE_MAX_BYTES = 1024 * 1024

/** The body, refused as soon as it is plainly not a file from the collection. */
async function boundedBody(response: Response, path: string, limit = MIRROR_MAX_BYTES): Promise<Uint8Array> {
  const tooLarge = () => new Error(`${path} came back larger than any file in the collection; refused`)
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined)
    throw tooLarge()
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > limit) throw tooLarge()
    return bytes
  }
  // Read as it arrives, so a body with no length is stopped at the limit
  // rather than after it has all been held in memory.
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => undefined)
      throw tooLarge()
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }
  return out
}

export function createMirror(basePath: string, fetchImpl: typeof fetch = fetch): MirrorOps {
  const base = basePath.replace(/\/+$/, '')
  /*
   * Each segment encoded, not the path as a whole: a `#` in a file name would
   * otherwise turn the rest of the path into a fragment the server never
   * sees, and a `?` into a query. HVSC's own naming rules make those unlikely
   * and nothing enforces them, which is the point.
   */
  const url = (path: string): string => {
    const encoded = path
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/')
    return `${base}/C64Music${rooted(encoded)}`
  }

  const get = async (path: string, headers?: Record<string, string>): Promise<Response> => {
    // No following a redirect: the real mirror answers these paths itself,
    // and one that sends the app somewhere else - back onto this origin, as
    // likely as not - is not serving the collection.
    const response = await fetchImpl(url(path), { headers, credentials: 'same-origin', redirect: 'error' })
    if (!response.ok) throw new Error(`${response.status} for ${path}`)
    return response
  }

  return {
    async release() {
      try {
        // The banner is at the top, so a range request is enough when the
        // mirror honours one; a full 12 kB read if it does not.
        const response = await get(RELEASE_PATH, { Range: `bytes=0-${HEAD - 1}` })
        // Bounded like every other read: a mirror that ignores the range
        // and never stops sending is not buffered until the tab gives out.
        return parseRelease(decodeLatin1(await boundedBody(response, RELEASE_PATH)))
      } catch {
        return null
      }
    },

    async document(name) {
      const response = await get(documentPath(name))
      return decodeLatin1(await boundedBody(response, documentPath(name)))
    },

    async tune(path) {
      // The documents come through here as well when a sync fetches them.
      const limit = path.startsWith(`/${DOCUMENTS_FOLDER}/`) ? MIRROR_MAX_BYTES : MIRROR_TUNE_MAX_BYTES
      return boundedBody(await get(path), path, limit)
    },

    async reachable() {
      try {
        await get(RELEASE_PATH, { Range: 'bytes=0-15' })
        return true
      } catch {
        return false
      }
    }
  }
}
