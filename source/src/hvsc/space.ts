import type { Resource, SpaceResource } from '@opencloud-eu/web-client'
import { isMissing, parentFolder, statusOf, type WebDav } from '../sid/source'

import { decodeLatin1 } from './text'

/**
 * Everything the library does to the user's space, behind one small
 * interface so the sync and the header filler can be tested without a server.
 *
 * Paths here are collection paths - `/MUSICIANS/H/Hubbard_Rob/Commando.sid` -
 * and the implementation puts the collection root in front of them. That way
 * nothing above this file has to know or care where the collection lives.
 *
 * One rule runs through all of it: only a 404 means "not there". Everything
 * else throws. This file used to answer every failure with an empty listing
 * or a null, which reads the same as an empty folder to everything above it,
 * and the consequences were not small - an access token expiring during the
 * three-minute walk of 1,951 folders made the sync plan a re-download of
 * thousands of files it already had, and a blip while the library opened
 * could end with the favourites file overwritten by an empty one. A caller
 * that wants the old behaviour can still catch; a caller that cannot tell
 * the difference now gets the error.
 */

export interface SpaceFile {
  /** Collection path. */
  path: string
  /** Whole-file MD5 as OpenCloud reports it, or null when it reports none. */
  md5: string | null
  size: number
}

export interface SpaceListing {
  /** Collection paths of the folders directly inside. */
  folders: string[]
  files: SpaceFile[]
}

export interface SpaceOps {
  /** One folder, not recursive. A missing folder lists as empty. */
  list(path: string): Promise<SpaceListing>
  read(path: string): Promise<Uint8Array>
  /** The first `bytes` bytes, for reading a SID header without the tune. */
  readHead(path: string, bytes: number): Promise<Uint8Array>
  readText(path: string): Promise<string | null>
  write(path: string, bytes: Uint8Array): Promise<void>
  writeText(path: string, text: string): Promise<void>
  remove(path: string): Promise<void>
  /** Creates a folder and every folder above it, ignoring ones that exist. */
  ensureFolder(path: string): Promise<void>
}

/**
 * OpenCloud reports checksums as one string of space-separated algorithms:
 * `SHA1:d0584265... MD5:9cee7d40... ADLER32:e4de1f74`. Only the MD5 matters
 * here, since that is what HVSC's manifest is keyed by. Shapes other than a
 * string are tolerated because the property passes through a generic
 * PROPFIND parser, and a missing MD5 is a normal answer, not an error: the
 * sync counts such a file as unverified rather than re-fetching it.
 */
export function md5FromChecksums(value: unknown): string | null {
  const text =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object'
        ? Object.values(value as Record<string, unknown>)
            .filter((v) => typeof v === 'string')
            .join(' ')
        : ''
  const m = /MD5:([0-9a-fA-F]{32})/.exec(text)
  return m ? m[1].toLowerCase() : null
}

/** Joins a collection root and a collection path into one space path. */
export const spacePath = (root: string, path: string): string => {
  const base = `/${root.replace(/^\/+|\/+$/g, '')}`
  const rest = path.replace(/^\/+/, '')
  return rest ? `${base}/${rest}` : base
}

/**
 * A document read as Latin-1, which is what HVSC's own documents are.
 *
 * Not a method on `SpaceOps` but a function over it, so every fake in the
 * tests keeps working and there is only one place that knows the encoding.
 *
 * This exists because `readText` cannot do it. It asks the WebDAV client for
 * `responseType: 'text'`, which the browser decodes as UTF-8, and
 * `STIL.txt` and `Musicians.txt` are ISO-8859-1: every accented name in them
 * came back with U+FFFD in it, was cached that way in IndexedDB, and was
 * then indexed for search, so "Orbán" could not be found by typing it. The
 * mirror path had this right all along (`mirror.document`); the space path,
 * which is the one taken on every normal open, did not.
 */
export async function readLatin1(ops: SpaceOps, path: string): Promise<string | null> {
  try {
    return decodeLatin1(await ops.read(path))
  } catch (e) {
    if (isMissing(e)) return null
    throw e
  }
}

/** Somewhere else a file may be: other operations, and the path it would have there (null for none). */
export interface ReadFallback {
  ops: SpaceOps
  path?: (path: string) => string | null
}

/**
 * A SpaceOps that writes where `primary` does, and reads from the first of
 * `primary` and `fallbacks` that has the file.
 *
 * The app's own files have moved twice: out of the collection into the base
 * folder above it, and from `.sidplay/` to `.sidplayer/` when the app was
 * renamed. Files left in either old place carry on being read; writes only
 * ever go to the primary, which puts each file in its new home the first
 * time it changes.
 *
 * Every place is asked at once rather than one after another, since a file
 * nobody has written yet - favourites before the first star - is missing in
 * all of them, and that was a round trip per place on every open. The
 * answers are still taken in order, so the new place wins where it has the
 * file, and a failure is not swallowed where an earlier place said the file
 * is not there: nobody then knows whether there is a list to merge with,
 * which is exactly when writing one would lose it.
 */
export function withReadFallbacks(primary: SpaceOps, fallbacks: readonly ReadFallback[]): SpaceOps {
  const places = (path: string): Array<{ ops: SpaceOps; path: string }> => [
    { ops: primary, path },
    ...fallbacks.flatMap((f) => {
      const there = f.path ? f.path(path) : path
      return there === null ? [] : [{ ops: f.ops, path: there }]
    })
  ]
  return {
    ...primary,
    async readText(path: string): Promise<string | null> {
      const asked = places(path).map((p) => p.ops.readText(p.path))
      for (const answer of await Promise.allSettled(asked)) {
        if (answer.status === 'rejected') throw answer.reason
        if (answer.value !== null) return answer.value
      }
      return null
    },
    async read(path: string): Promise<Uint8Array> {
      const asked = places(path).map((p) => p.ops.read(p.path))
      let missing: unknown = null
      for (const answer of await Promise.allSettled(asked)) {
        if (answer.status === 'fulfilled') return answer.value
        if (!isMissing(answer.reason)) throw answer.reason
        missing ??= answer.reason
      }
      throw missing
    }
  }
}

/** A path inside `folder` as the same path inside `legacyFolder`; null for one outside it. */
export const inFolderRenamed =
  (folder: string, legacyFolder: string) =>
  (path: string): string | null => {
    const relative = path.replace(/^\/+/, '')
    return relative.startsWith(`${folder}/`)
      ? `${path.slice(0, path.length - relative.length)}${legacyFolder}${relative.slice(folder.length)}`
      : null
  }

const CHECKSUMS = 'oc:checksums'

export interface SpaceOpsDeps {
  webdav: WebDav
  space: SpaceResource
  /** Collection root inside the space, e.g. `HVSC`. */
  root: string
}

export function createSpaceOps({ webdav, space, root }: SpaceOpsDeps): SpaceOps {
  const at = (path: string): string => spacePath(root, path)

  /*
   * Folders known to exist, by space path, so a sync does not re-create them.
   *
   * Every write has to make sure its folder is there, and the obvious way -
   * MKCOL each ancestor, ignore the 405 that says it already exists - costs
   * one request per ancestor per file. Over release 85 that is about a
   * quarter of a million pointless requests, four for every tune. Remembering
   * what has been created makes it one per folder, about 3,500 in total.
   *
   * Keyed by the full space path, which is what `ensureFolder` creates. It
   * used to be keyed by collection path while `write` looked it up by a
   * variant without the leading slash, so for the app's own files the lookup
   * never hit and the saving never applied to them.
   */
  const ensured = new Set<string>()

  const toBytes = (body: unknown): Uint8Array => {
    if (body instanceof ArrayBuffer) return new Uint8Array(body)
    if (body instanceof Uint8Array) return body
    if (typeof body === 'string') return new TextEncoder().encode(body)
    return new Uint8Array(0)
  }

  return {
    async list(path) {
      let children: Resource[] = []
      try {
        const result = await webdav.listFiles(space, { path: at(path) }, { depth: 1, extraProps: [CHECKSUMS] })
        children = result.children ?? []
      } catch (e) {
        // A folder that is not there yet lists as empty: the first sync of a
        // collection asks about folders it is about to create. Anything else
        // is a failure to answer, not an answer - see the note at the top.
        if (isMissing(e)) return { folders: [], files: [] }
        throw e
      }
      const folders: string[] = []
      const files: SpaceFile[] = []
      const base = at('')
      const prefix = at(path).replace(/\/+$/, '')
      let mismatched = 0
      for (const child of children) {
        const childPath = (child.path ?? '').replace(/\/+$/, '')
        if (!childPath || childPath === prefix) continue
        /*
         * Back to a collection path: drop the space-side root again. Checked
         * rather than assumed, because slicing a fixed number of characters
         * off a path that does not start where we think it does produces a
         * plausible-looking path pointing somewhere else entirely.
         */
        if (!childPath.startsWith(`${base}/`)) {
          mismatched++
          continue
        }
        const collectionPath = childPath.slice(base.length) || '/'
        if (child.type === 'folder' || child.isFolder) {
          folders.push(collectionPath)
        } else {
          files.push({
            path: collectionPath,
            md5: md5FromChecksums(child.extraProps?.[CHECKSUMS]),
            size: Number(child.size ?? 0)
          })
        }
      }
      /*
       * Children that all sit outside the root we are reading under mean the
       * server is spelling paths in a way this does not understand - encoded
       * differently, say - not that the folder is empty. Reporting it empty
       * is the more dangerous answer by far: the sync would plan to download
       * everything in it, and the player would decide a tune it can read
       * perfectly well is missing and try to fetch a copy over the top.
       */
      if (mismatched && !folders.length && !files.length) {
        throw new Error(
          `listing ${at(path)} returned ${mismatched} children outside it, so the paths cannot be read`
        )
      }
      return { folders, files }
    },

    async read(path) {
      const response = await webdav.getFileContents(space, { path: at(path) }, { responseType: 'arraybuffer' })
      return toBytes(response.body)
    },

    async readHead(path, bytes) {
      const response = await webdav.getFileContents(
        space,
        { path: at(path) },
        { responseType: 'arraybuffer', headers: { Range: `bytes=0-${Math.max(0, bytes - 1)}` } }
      )
      // A server that ignores Range answers with the whole file, which is
      // correct, just larger; taking the front of it is the same result.
      return toBytes(response.body).subarray(0, bytes)
    },

    async readText(path) {
      try {
        const response = await webdav.getFileContents(
          space,
          { path: at(path) },
          { responseType: 'text', noCache: true }
        )
        return typeof response.body === 'string' ? response.body : String(response.body ?? '')
      } catch (e) {
        if (isMissing(e)) return null
        throw e
      }
    },

    async write(path, bytes) {
      await this.ensureFolder(parentFolder(path))
      // The bytes' own buffer where they are all of it, which a fetched tune
      // always is; a copy only for a view into something larger.
      const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      const buffer = (
        whole ? bytes.buffer : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      ) as ArrayBuffer
      await webdav.putFileContents(space, { path: at(path), content: buffer, overwrite: true })
    },

    async writeText(path, text) {
      await this.ensureFolder(parentFolder(path))
      await webdav.putFileContents(space, { path: at(path), content: text, overwrite: true })
    },

    async remove(path) {
      await webdav.deleteFile(space, { path: at(path) })
    },

    /**
     * Creates a folder and every folder above it, counting from the root of
     * the space rather than from the root of the collection.
     *
     * The difference matters on a first sync. The collection root is
     * `/SID Library/C64Music`, and MKCOL on it answers 409 while `/SID Library`
     * does not exist yet. That 409 used to be swallowed and the folder
     * marked as ensured, so every folder and every file after it failed too
     * and the whole first sync reported thousands of failures. It only ever
     * worked because the first-run screen happened to write `status.json`
     * through an ops rooted one level up, and then only when the mirror
     * answered.
     *
     * 405 means the folder is already there, which is the goal, so it counts
     * as success. Anything else throws: a folder that cannot be created is
     * worth one loud failure here rather than a PUT failure per file.
     */
    async ensureFolder(path) {
      const segments = at(path)
        .replace(/^\/+|\/+$/g, '')
        .split('/')
        .filter(Boolean)
      let sofar = ''
      for (const segment of segments) {
        sofar += `/${segment}`
        if (ensured.has(sofar)) continue
        try {
          await webdav.createFolder(space, { path: sofar, fetchFolder: false })
        } catch (e) {
          // 405 is "already there".
          const status = statusOf(e)
          if (status === 409) {
            /*
             * Working down from the root, every parent is already ensured, so
             * a conflict is one of two things: two workers in one sync racing
             * to make the same folder, which is there by now; or a file where
             * the folder should be, which no write beneath it will get past.
             * Only the server can say which, so it is asked.
             */
            const there = await webdav
              .listFiles(space, { path: sofar }, { depth: 0 })
              .then((r) => r.resource?.type === 'folder' || Boolean(r.resource?.isFolder))
              .catch(() => false)
            if (!there) throw e
          } else if (status !== 405) {
            throw e
          }
        }
        ensured.add(sofar)
      }
    }
  }
}
