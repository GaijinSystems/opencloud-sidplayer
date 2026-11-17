import { describe, it, expect, vi } from 'vitest'
import type { Resource, SpaceResource } from '@opencloud-eu/web-client'
import { createSpaceOps, readLatin1 } from '../src/hvsc/space'
import { isMissing, statusOf } from '../src/sid/source'
import type { WebDav } from '../src/sid/source'

/**
 * `createSpaceOps` itself, which had no tests at all.
 *
 * It is one of the two modules that touch the server, and every decision the
 * library makes about what to download, what to delete and what is already
 * there rests on the answers it gives. The review of 22 September 2026 found
 * three faults in it and one of them cost somebody a tune that would not
 * play, so the fakes below are shaped around the failures rather than the
 * happy path.
 */

const space = { id: 'personal', name: 'Personal' } as unknown as SpaceResource

const fail = (status: number): Error => Object.assign(new Error(`HTTP ${status}`), { statusCode: status })

interface Parts {
  children?: Resource[]
  /** What a depth-0 listing says the path itself is. */
  self?: Resource
  listError?: unknown
  body?: unknown
  readError?: unknown
  onCreate?: (path: string) => void
  createError?: (path: string) => unknown
}

function fakeDav(parts: Parts = {}): { webdav: WebDav; created: string[]; put: string[] } {
  const created: string[] = []
  const put: string[] = []
  const webdav = {
    listFiles: vi.fn(async () => {
      if (parts.listError) throw parts.listError
      return { resource: parts.self, children: parts.children ?? [] }
    }),
    getFileContents: vi.fn(async () => {
      if (parts.readError) throw parts.readError
      return { body: parts.body ?? '' }
    }),
    // The client takes the space first and the options second.
    putFileContents: vi.fn(async (_space: SpaceResource, { path }: { path: string }) => {
      put.push(path)
    }),
    deleteFile: vi.fn(async () => undefined),
    createFolder: vi.fn(async (_space: SpaceResource, { path }: { path: string }) => {
      const thrown = parts.createError?.(path)
      if (thrown) throw thrown
      created.push(path)
      parts.onCreate?.(path)
    })
  } as unknown as WebDav
  return { webdav, created, put }
}

const child = (path: string, isFolder = false): Resource =>
  ({ path, type: isFolder ? 'folder' : 'file', isFolder, size: 10 }) as unknown as Resource

const ops = (parts: Parts = {}, root = '/SID Library/C64Music') => {
  const dav = fakeDav(parts)
  return { ops: createSpaceOps({ webdav: dav.webdav, space, root }), ...dav }
}

describe('reading the space', () => {
  it('turns space paths back into collection paths', async () => {
    const { ops: o } = ops({
      children: [
        child('/SID Library/C64Music/MUSICIANS'),
        child('/SID Library/C64Music/MUSICIANS/H', true),
        child('/SID Library/C64Music/MUSICIANS/Commando.sid')
      ]
    })
    const listing = await o.list('/MUSICIANS')
    expect(listing.folders).toEqual(['/MUSICIANS/H'])
    expect(listing.files.map((f) => f.path)).toEqual(['/MUSICIANS/Commando.sid'])
  })

  it('reads a missing folder as empty and anything else as a failure', async () => {
    await expect(ops({ listError: fail(404) }).ops.list('/MUSICIANS')).resolves.toEqual({
      folders: [],
      files: []
    })
    await expect(ops({ listError: fail(500) }).ops.list('/MUSICIANS')).rejects.toThrow()
    // A token that expired mid-walk is a 401, and reporting that folder empty
    // is what made the planner offer to re-download what was already there.
    await expect(ops({ listError: fail(401) }).ops.list('/MUSICIANS')).rejects.toThrow()
  })

  /*
   * The fault behind a tune that would not play: the library decided a file
   * it could read perfectly well was absent, and tried to write a copy over
   * the top of it.
   */
  it('refuses to call a folder empty when it cannot read the paths in it', async () => {
    const { ops: o } = ops({
      children: [
        child('/SID%20Player/C64Music/MUSICIANS/Commando.sid'),
        child('/SID%20Player/C64Music/MUSICIANS/Delta.sid')
      ]
    })
    await expect(o.list('/MUSICIANS')).rejects.toThrow(/cannot be read/)
  })

  it('still reports a genuinely empty folder as empty', async () => {
    await expect(ops({ children: [] }).ops.list('/MUSICIANS')).resolves.toEqual({ folders: [], files: [] })
  })

  it('reads a missing file as null and anything else as a failure', async () => {
    await expect(ops({ readError: fail(404) }).ops.readText('/x.json')).resolves.toBeNull()
    await expect(ops({ readError: fail(503) }).ops.readText('/x.json')).rejects.toThrow()
  })

  it('reads a document as Latin-1, which is what HVSC writes', async () => {
    // "Orbán" in ISO-8859-1: the á is one byte, 0xE1.
    const { ops: o } = ops({ body: new Uint8Array([0x4f, 0x72, 0x62, 0xe1, 0x6e]).buffer })
    await expect(readLatin1(o, '/DOCUMENTS/Musicians.txt')).resolves.toBe('Orbán')
  })

  it('reports a missing document as null rather than throwing', async () => {
    const { ops: o } = ops({ readError: fail(404) })
    await expect(readLatin1(o, '/DOCUMENTS/Musicians.txt')).resolves.toBeNull()
  })
})

describe('writing to the space', () => {
  it('creates every folder from the root of the space, not of the collection', async () => {
    const { ops: o, created } = ops()
    await o.write('/MUSICIANS/H/Hubbard_Rob/Commando.sid', new Uint8Array([1, 2, 3]))
    /*
     * `/SID Library` first. Starting at the collection root meant the very
     * first MKCOL answered 409 because its parent did not exist yet, and that
     * 409 was swallowed and the folder marked as done - so every file of a
     * first sync then failed too.
     */
    expect(created).toEqual([
      '/SID Library',
      '/SID Library/C64Music',
      '/SID Library/C64Music/MUSICIANS',
      '/SID Library/C64Music/MUSICIANS/H',
      '/SID Library/C64Music/MUSICIANS/H/Hubbard_Rob'
    ])
  })

  it('creates each folder once, however many files go into it', async () => {
    const { ops: o, created } = ops()
    await o.write('/MUSICIANS/H/Commando.sid', new Uint8Array([1]))
    await o.write('/MUSICIANS/H/Delta.sid', new Uint8Array([2]))
    await o.writeText('/MUSICIANS/H/notes.txt', 'hello')
    expect(created.filter((p) => p.endsWith('/H'))).toHaveLength(1)
  })

  it('treats "already there" as success and anything else as a failure', async () => {
    const exists = ops({ createError: (p) => (p.endsWith('/H') ? fail(405) : undefined) })
    await expect(exists.ops.write('/MUSICIANS/H/Commando.sid', new Uint8Array([1]))).resolves.toBeUndefined()

    const refused = ops({ createError: (p) => (p.endsWith('/H') ? fail(403) : undefined) })
    await expect(refused.ops.write('/MUSICIANS/H/Commando.sid', new Uint8Array([1]))).rejects.toThrow()
  })

  /*
   * Creating from the root, a 409 no longer means a missing parent; it means
   * two workers raced to make the same folder, or that something which is
   * not a folder is in the way. Only the first is the folder being there,
   * and the server is asked which. Taken as success either way, a file in
   * the way failed every write beneath it, one by one.
   */
  it('asks what a conflict means before taking it as the folder being there', async () => {
    const raced = ops({
      createError: (p) => (p.endsWith('/H') ? fail(409) : undefined),
      self: child('/SID Library/C64Music/MUSICIANS/H', true)
    })
    await expect(raced.ops.write('/MUSICIANS/H/Commando.sid', new Uint8Array([1]))).resolves.toBeUndefined()

    const blocked = ops({
      createError: (p) => (p.endsWith('/H') ? fail(409) : undefined),
      self: child('/SID Library/C64Music/MUSICIANS/H', false)
    })
    await expect(blocked.ops.write('/MUSICIANS/H/Commando.sid', new Uint8Array([1]))).rejects.toThrow()
    expect(blocked.put).toEqual([])
  })

  it('writes the app’s own files without a collection root in the way', async () => {
    const { ops: o, put } = ops({}, '/SID Library')
    await o.writeText('.sidplayer/status.json', '{}')
    expect(put).toEqual(['/SID Library/.sidplayer/status.json'])
  })
})

describe('reading a status off an error', () => {
  it('finds it wherever the client put it', () => {
    expect(statusOf({ statusCode: 404 })).toBe(404)
    expect(statusOf({ response: { status: 500 } })).toBe(500)
    expect(statusOf(new Error('nope'))).toBeNull()
  })

  it('counts the answers that mean "not there for you"', () => {
    expect(isMissing(fail(404))).toBe(true)
    expect(isMissing(fail(403))).toBe(true)
    expect(isMissing(fail(500))).toBe(false)
    expect(isMissing(new Error('offline'))).toBe(false)
  })
})
