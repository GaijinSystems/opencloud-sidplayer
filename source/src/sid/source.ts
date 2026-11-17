import type { Resource, SpaceResource } from '@opencloud-eu/web-client'
import type { useClientService } from '@opencloud-eu/web-pkg'
import { SidPlayerError } from './types'

export type WebDav = ReturnType<typeof useClientService>['webdav']

/** HTTP status of a WebDAV client error, where it reports one. */
export function statusOf(e: unknown): number | null {
  const withStatus = e as { statusCode?: number; status?: number; response?: { status?: number } } | null
  return withStatus?.statusCode ?? withStatus?.status ?? withStatus?.response?.status ?? null
}

/**
 * Whether an error means the file or folder is simply not there.
 *
 * 404 is the answer that carries information; 403 and 423 are included
 * because OpenCloud answers them for a path inside a share the user has lost
 * access to, where "it is not there for you" is the honest reading and
 * retrying would not help either.
 */
export const isMissing = (e: unknown): boolean => {
  const status = statusOf(e)
  return status === 404 || status === 403 || status === 423
}

/**
 * The same path from the root, whatever it was given as: `MUSICIANS/x.sid`
 * and `/MUSICIANS/x.sid` are one place.
 */
export const rooted = (path: string): string => (path.startsWith('/') ? path : `/${path}`)

/**
 * The folder a WebDAV path sits in, as the client wants it: `/A/B/Tune.mus`
 * gives `/A/B`, and anything at the root gives `/`. Three places worked this
 * out with the same slice expression; one of them is enough.
 */
export const parentFolder = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/'))) || '/'

/**
 * Reads a file's bytes through the shell's own WebDAV client.
 *
 * Earlier this went through AppWrapper's `getUrlForResource` plus a fetch
 * with hand-managed auth headers. The dock plays files from the Files list,
 * where there is no AppWrapper, so both paths now use the client the shell
 * already authenticates, on sessions and public links alike. SID files are a
 * few kilobytes; the only care taken is over size.
 */
export async function readResourceBytes(
  webdav: WebDav,
  space: SpaceResource,
  resource: Resource,
  maxBytes: number
): Promise<Uint8Array> {
  const declared = Number(resource.size) || 0
  if (declared > maxBytes) {
    throw new SidPlayerError('too-large', 'This file is too large to be a SID tune.')
  }
  let body: unknown
  try {
    const response = await webdav.getFileContents(
      space,
      resource.path ? { path: resource.path } : { fileId: resource.fileId },
      {
        responseType: 'arraybuffer',
        /*
         * With no size to go on - a resource the library builds from a
         * catalogue row has none - one byte more than the limit is asked
         * for: enough to tell a file that is too large from one that is not,
         * without fetching the rest of it. A server that ignores Range sends
         * the whole file, which the check below still catches.
         */
        ...(declared ? {} : { headers: { Range: `bytes=0-${maxBytes}` } })
      }
    )
    body = response.body
  } catch (e) {
    const status = statusOf(e)
    // An empty file has no first byte to give: not a failure to fetch it.
    if (status === 416 && !declared) return new Uint8Array(0)
    throw new SidPlayerError(
      'network',
      status ? `The file could not be fetched (HTTP ${status}).` : 'The file could not be fetched.',
      e
    )
  }
  const bytes =
    body instanceof ArrayBuffer
      ? new Uint8Array(body)
      : body instanceof Uint8Array
        ? body
        : typeof body === 'string'
          ? Uint8Array.from(body, (c) => c.charCodeAt(0) & 0xff)
          : null
  if (!bytes) {
    throw new SidPlayerError('network', 'The file came back in a form this player cannot read.')
  }
  // Servers that omit Content-Length still must not exhaust memory.
  if (bytes.byteLength > maxBytes) {
    throw new SidPlayerError('too-large', 'This file is too large to be a SID tune.')
  }
  return bytes
}
