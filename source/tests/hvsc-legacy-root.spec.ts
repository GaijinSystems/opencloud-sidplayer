import { describe, it, expect, vi } from 'vitest'
import type { Resource, SpaceResource } from '@opencloud-eu/web-client'
import { createLibrary } from '../src/library/useLibrary'
import { readConfig } from '../src/config'
import type { WebDav } from '../src/sid/source'

/**
 * A collection left where the app's folder used to be called something else.
 *
 * The folder was renamed from `SID Player` to `SID Library` to match the name
 * in the launcher, and nobody's several hundred megabytes are going to move
 * themselves. Without this, an existing collection would be met by the
 * first-run screen and an offer to download it all again into a new folder
 * beside the one already holding it.
 *
 * These go through `createSpaceOps` over a fake WebDAV client rather than the
 * injected `SpaceOps` the other library tests use, because the whole point is
 * which space paths get asked for.
 */

const MANIFEST = ['[Database]', '; /MUSICIANS/H/Hubbard_Rob/Commando.sid', `${'a'.repeat(32)}=3:43`].join('\n')

const space = { id: 'personal' } as unknown as SpaceResource

const folder = (path: string): Resource => ({ path, type: 'folder', isFolder: true }) as unknown as Resource

/**
 * A space holding a collection under exactly one of the two names. Records
 * every path listed, so a test can say what was never looked at.
 */
function fakeDav(where: '/SID Library' | '/SID Player') {
  const listed: string[] = []
  const webdav = {
    listFiles: async (_s: SpaceResource, { path }: { path: string }) => {
      listed.push(path)
      if (path === where) return { children: [folder(`${where}/C64Music`)] }
      if (path === `${where}/C64Music`) {
        return {
          children: ['MUSICIANS', 'DEMOS', 'DOCUMENTS'].map((n) => folder(`${where}/C64Music/${n}`))
        }
      }
      // Anything else - the other name, or a folder inside the collection.
      return { children: [] }
    },
    getFileContents: async (_s: SpaceResource, { path }: { path: string }) => {
      if (path.endsWith('Songlengths.md5')) return { body: new TextEncoder().encode(MANIFEST).buffer }
      throw Object.assign(new Error('404'), { statusCode: 404 })
    },
    putFileContents: async () => undefined,
    createFolder: async () => undefined,
    deleteFile: async () => undefined
  }
  return { webdav: webdav as unknown as WebDav, listed }
}

const open = async (where: '/SID Library' | '/SID Player') => {
  const { webdav, listed } = fakeDav(where)
  const lib = createLibrary({
    webdav,
    space,
    config: readConfig({}),
    play: vi.fn(),
    mirror: {
      release: vi.fn(async () => 85),
      document: vi.fn(async () => MANIFEST),
      tune: vi.fn(async () => new Uint8Array(0)),
      reachable: vi.fn(async () => true)
    }
  })
  await lib.init()
  return { lib, listed }
}

describe('a collection under the folder’s old name', () => {
  it('is found and used where it is, rather than offered a first sync', async () => {
    const { lib, listed } = await open('/SID Player')
    expect(lib.phase.value).toBe('ready')
    expect(lib.rows.value).toHaveLength(1)
    // The configured name was tried first, and the old one only after it
    // turned out to be empty.
    expect(listed.indexOf('/SID Library')).toBeLessThan(listed.indexOf('/SID Player'))
  })

  it('plays out of the folder it was found in', async () => {
    const { lib } = await open('/SID Player')
    const row = lib.rows.value[0]
    await lib.play(row)
    // Not `/SID Library/...`, which is where nothing is.
    expect(lib.selected.value?.path).toBe('/MUSICIANS/H/Hubbard_Rob/Commando.sid')
    expect(lib.phase.value).toBe('ready')
  })

  it('is not looked for when the configured folder has one', async () => {
    const { lib, listed } = await open('/SID Library')
    expect(lib.phase.value).toBe('ready')
    expect(lib.rows.value).toHaveLength(1)
    // Costing nothing at all to anyone already using the new name.
    expect(listed.some((path) => path.startsWith('/SID Player'))).toBe(false)
  })

  it('still offers a first sync when neither name holds anything', async () => {
    const { webdav } = fakeDav('/nowhere' as '/SID Library')
    const lib = createLibrary({
      webdav,
      space,
      config: readConfig({}),
      play: vi.fn(),
      mirror: {
        release: vi.fn(async () => 85),
        document: vi.fn(async () => MANIFEST),
        tune: vi.fn(async () => new Uint8Array(0)),
        reachable: vi.fn(async () => true)
      }
    })
    await lib.init()
    expect(lib.phase.value).toBe('first-run')
  })
})
