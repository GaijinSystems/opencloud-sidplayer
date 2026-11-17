import { describe, it, expect, vi } from 'vitest'
import {
  md5FromChecksums,
  spacePath,
  inFolderRenamed,
  withReadFallbacks,
  type SpaceListing,
  type SpaceOps
} from '../src/hvsc/space'
import { resolveCollectionRoot, walkSpace } from '../src/hvsc/inventory'
import { parseRelease } from '../src/hvsc/mirror'
import { applyHeaders, fieldsFromBytes, fillHeaders, HEADER_BYTES } from '../src/hvsc/headers'
import {
  isFavourite,
  mergeFavourites,
  moveFavouriteTo,
  orderedFavourites,
  parseFavourites,
  saveFavourites,
  toggleFavourite,
  FavouritesUnreadable,
  type FavouritesFile
} from '../src/hvsc/favourites'
import type { CatalogRow } from '../src/hvsc/catalog'
import { psidHeader } from './helpers/bytes'
import { fakeSpaceOps } from './helpers/fakes'
import { LEGACY_PRIVATE_FOLDER, PRIVATE_FOLDER } from '../src/hvsc/sync'

/** A space made of a path -> content map, enough for the walk and the filler. */
function fakeSpace(tree: Record<string, { md5?: string | null; bytes?: Uint8Array } | 'folder'>): SpaceOps {
  const listing = (path: string): SpaceListing => {
    const prefix = path === '/' ? '/' : `${path}/`
    const folders: string[] = []
    const files: SpaceListing['files'] = []
    for (const [key, value] of Object.entries(tree)) {
      if (!key.startsWith(prefix) || key === path) continue
      const rest = key.slice(prefix.length)
      if (rest.includes('/')) continue
      if (value === 'folder') folders.push(key)
      else files.push({ path: key, md5: value.md5 ?? null, size: value.bytes?.byteLength ?? 0 })
    }
    return { folders, files }
  }
  return fakeSpaceOps({
    list: vi.fn(async (path: string) => listing(path)),
    read: vi.fn(async (path: string) => {
      const entry = tree[path]
      if (!entry || entry === 'folder' || !entry.bytes) throw new Error('not found')
      return entry.bytes
    }),
    readHead: vi.fn(async (path: string, bytes: number) => {
      const entry = tree[path]
      if (!entry || entry === 'folder' || !entry.bytes) throw new Error('not found')
      return entry.bytes.subarray(0, bytes)
    })
  })
}

describe('checksums and paths', () => {
  it('picks the MD5 out of what OpenCloud reports', () => {
    expect(md5FromChecksums('SHA1:d0584265eaa8 MD5:9cee7d4077e9def93f24946ef2527021 ADLER32:e4de1f74')).toBe(
      '9cee7d4077e9def93f24946ef2527021'
    )
    expect(md5FromChecksums({ checksum: 'MD5:9CEE7D4077E9DEF93F24946EF2527021' })).toBe(
      '9cee7d4077e9def93f24946ef2527021'
    )
    expect(md5FromChecksums('SHA1:only')).toBeNull()
    expect(md5FromChecksums(undefined)).toBeNull()
    expect(md5FromChecksums(42)).toBeNull()
  })

  it('puts the collection root in front of a collection path', () => {
    expect(spacePath('HVSC', '/MUSICIANS/H/x.sid')).toBe('/HVSC/MUSICIANS/H/x.sid')
    expect(spacePath('/HVSC/', 'DOCUMENTS/STIL.txt')).toBe('/HVSC/DOCUMENTS/STIL.txt')
    expect(spacePath('HVSC', '/')).toBe('/HVSC')
  })
})

describe('walking the space', () => {
  const tree = {
    '/DOCUMENTS': 'folder' as const,
    '/DOCUMENTS/Songlengths.md5': { md5: 'aa' },
    '/MUSICIANS': 'folder' as const,
    '/MUSICIANS/H': 'folder' as const,
    '/MUSICIANS/H/Hubbard_Rob': 'folder' as const,
    '/MUSICIANS/H/Hubbard_Rob/Commando.sid': { md5: 'bb' },
    '/MUSICIANS/H/Hubbard_Rob/Delta.sid': { md5: null },
    '/.sidplayer': 'folder' as const,
    '/.sidplayer/status.json': { md5: 'cc' }
  }

  it('walks only the folders a sync touches', async () => {
    /*
     * A real collection has disk images and a readme at the top level, and
     * often an `update/` folder from an applied update package. Listing them
     * costs requests and inventory entries for files no sync will touch.
     */
    const withExtras = {
      ...tree,
      '/readme.1st': { md5: 'x' },
      '/10_Years_HVSC.d81': { md5: 'x' },
      '/update': 'folder' as const,
      '/update/new': 'folder' as const,
      '/update/new/Tune.sid': { md5: 'x' }
    }
    const ops = fakeSpace(withExtras)
    const { index } = await walkSpace(ops)
    expect([...index.keys()].some((p) => p.startsWith('/update'))).toBe(false)
    expect([...index.keys()].some((p) => p.endsWith('.d81'))).toBe(false)
    expect(index.has('/MUSICIANS/H/Hubbard_Rob/Commando.sid')).toBe(true)
    expect(index.has('/DOCUMENTS/Songlengths.md5')).toBe(true)
  })

  it('finds every file with its checksum, at any depth', async () => {
    const ops = fakeSpace(tree)
    const { index } = await walkSpace(ops, { concurrency: 2 })
    expect([...index.keys()].sort()).toEqual([
      '/DOCUMENTS/Songlengths.md5',
      '/MUSICIANS/H/Hubbard_Rob/Commando.sid',
      '/MUSICIANS/H/Hubbard_Rob/Delta.sid'
    ])
    expect(index.get('/MUSICIANS/H/Hubbard_Rob/Commando.sid')).toBe('bb')
    expect(index.get('/MUSICIANS/H/Hubbard_Rob/Delta.sid')).toBeNull()
  })

  it("never descends into the app's own folder", async () => {
    const { index } = await walkSpace(fakeSpace(tree))
    expect([...index.keys()].some((p) => p.startsWith('/.sidplayer'))).toBe(false)
  })

  it('reports progress and can be stopped', async () => {
    const seen: string[] = []
    const { index, stopped } = await walkSpace(fakeSpace(tree), {
      concurrency: 1,
      onProgress: (p) => seen.push(p.at),
      shouldStop: () => seen.length >= 2
    })
    expect(seen.length).toBeLessThanOrEqual(3)
    expect(index.size).toBeLessThan(3)
    expect(stopped).toBe(true)
  })

  it('survives a folder that cannot be listed', async () => {
    const ops = fakeSpace(tree)
    const listing = ops.list
    ops.list = vi.fn(async (path: string) => {
      if (path === '/MUSICIANS') throw new Error('boom')
      return listing(path)
    })
    const { index, failed } = await walkSpace(ops)
    // The unreadable branch is absent from the index and named in `failed`,
    // which is what lets the planner refuse to act on half a picture.
    expect([...index.keys()]).toEqual(['/DOCUMENTS/Songlengths.md5'])
    expect(failed).toEqual(['/MUSICIANS'])
  })

  it('recognises a collection folder by what is in it', async () => {
    await expect(resolveCollectionRoot(fakeSpace(tree))).resolves.toBe('')
    await expect(resolveCollectionRoot(fakeSpace({ '/Photos': 'folder' as const }))).resolves.toBeNull()
  })

  /*
   * Two layouts, both legitimate: a sync by this app writes MUSICIANS/ &c
   * straight into the configured folder, while HVSC's own archives unpack
   * into C64Music/ first - which is also why the mirror serves the unpacked
   * collection under that name.
   */
  it('finds the collection in the flat layout', async () => {
    await expect(resolveCollectionRoot(fakeSpace(tree))).resolves.toBe('')
  })

  it('finds it inside C64Music when an archive was unpacked', async () => {
    const unpacked = {
      '/C64Music': 'folder' as const,
      '/C64Music/DOCUMENTS': 'folder' as const,
      '/C64Music/DOCUMENTS/Songlengths.md5': { md5: 'aa' },
      '/C64Music/MUSICIANS': 'folder' as const,
      '/C64Music/MUSICIANS/H': 'folder' as const
    }
    await expect(resolveCollectionRoot(fakeSpace(unpacked))).resolves.toBe('/C64Music')
    await expect(resolveCollectionRoot(fakeSpace(unpacked))).resolves.toBe('/C64Music')
  })

  it('is not fooled by a C64Music folder with nothing in it', async () => {
    const empty = { '/C64Music': 'folder' as const, '/C64Music/Notes.txt': { md5: 'aa' } }
    await expect(resolveCollectionRoot(fakeSpace(empty))).resolves.toBeNull()
  })

  it('reports no collection for an unrelated folder', async () => {
    await expect(resolveCollectionRoot(fakeSpace({ '/Photos': 'folder' as const }))).resolves.toBeNull()
  })
})

describe('the mirror', () => {
  it("reads the release number out of HVSC.txt's banner", () => {
    const banner = [
      '-----------------------------------------------------------------------------',
      '                        T H E   H I G H   V O L T A G E',
      '                          S I D   C O L L E C T I O N',
      '',
      '                                  Release 85',
      '',
      '                                June 28, 2026'
    ].join('\n')
    expect(parseRelease(banner)).toBe(85)
    expect(parseRelease('Release 100')).toBe(100)
    expect(parseRelease('no banner here')).toBeNull()
    // A mention of a release elsewhere in a line must not be mistaken for it.
    expect(parseRelease('This is Release 85 of something')).toBeNull()
  })
})

describe('header filling', () => {
  /* A minimal PSID v2 header: magic, version, offsets, and the three names. */
  const psid = psidHeader

  it('reads the fields a manifest cannot carry', () => {
    const fields = fieldsFromBytes(psid('Commando', 'Rob Hubbard', '1985 Elite', 3))
    expect(fields).toMatchObject({
      title: 'Commando',
      author: 'Rob Hubbard',
      released: '1985 Elite',
      format: 'PSID',
      model: '6581',
      clock: 'pal',
      songs: 3
    })
  })

  it('says nothing rather than guessing for a file that is not a SID', () => {
    expect(fieldsFromBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).toBeNull()
    expect(fieldsFromBytes(new Uint8Array(4))).toBeNull()
  })

  it('fills only the rows that need it, and counts what it could not read', async () => {
    const rows: CatalogRow[] = [
      { path: '/A/One.sid', md5: '1', lengths: [1], category: 'A', folder: '/A', name: 'One.sid', stem: 'One' },
      { path: '/A/Two.sid', md5: '2', lengths: [1], category: 'A', folder: '/A', name: 'Two.sid', stem: 'Two' },
      {
        path: '/A/Known.sid',
        md5: '3',
        lengths: [1],
        category: 'A',
        folder: '/A',
        name: 'Known.sid',
        stem: 'Known',
        title: 'already here'
      }
    ]
    const ops = fakeSpace({
      '/A/One.sid': { bytes: psid('One', 'Someone', '1987') },
      '/A/Two.sid': { bytes: new Uint8Array([1, 2, 3, 4, 5, 6]) }
    })
    const fields = await fillHeaders(rows, ops, { concurrency: 2 })
    expect([...fields.keys()]).toEqual(['/A/One.sid'])
    expect(ops.readHead).toHaveBeenCalledTimes(2)
    expect(ops.readHead).toHaveBeenCalledWith('/A/One.sid', HEADER_BYTES)

    const filled = applyHeaders(rows, fields)
    expect(filled[0].title).toBe('One')
    expect(filled[2].title).toBe('already here')
    expect(applyHeaders(rows, new Map())).toBe(rows)
  })
})

describe('favourites', () => {
  const star = (path: string, at: string): FavouritesFile => ({
    version: 1,
    items: [{ path, md5: 'aa', at }],
    removed: []
  })

  it('reads a file that has been edited into nonsense', () => {
    expect(parseFavourites(null).items).toEqual([])
    expect(parseFavourites('{}').items).toEqual([])
    expect(parseFavourites('{"items":[{"path":"no-slash"}, 3, null]}').items).toEqual([])
    expect(parseFavourites('{"items":[{"path":"/a.sid","md5":"AA","at":"nope"}]}').items[0]).toMatchObject({
      path: '/a.sid',
      md5: 'aa'
    })
  })

  /*
   * Read as empty, a file of the wrong shape was what the next star merged
   * with, and so was written over with a list of one.
   */
  it('refuses a file that is JSON of some other shape', () => {
    for (const text of [
      '[]',
      '3',
      'null',
      '{"items":"x"}',
      '{"items":[],"removed":{}}',
      '{"version":2,"items":[]}',
      '{"items":[{"path":"/a.sid","collection":"other"}]}'
    ]) {
      expect(() => parseFavourites(text), text).toThrow(FavouritesUnreadable)
    }
  })

  it('reads a star whose collection is null as HVSC, and ignores entries it would drop anyway', () => {
    const read = parseFavourites(
      '{"version":"1","items":[{"path":"/a.sid","collection":null},{"path":"x","collection":"y"}]}'
    )
    expect(read.items.map((item) => item.path)).toEqual(['/a.sid'])
  })

  it('keeps fields it does not know through a save', async () => {
    const text = JSON.stringify({
      version: 1,
      theme: 'dark',
      items: [{ path: '/a.sid', md5: 'aa', at: '2026-01-01T00:00:00.000Z', note: 'mine' }],
      removed: [{ path: '/b.sid', at: '2026-01-01T00:00:00.000Z', by: 'phone' }]
    })
    const read = parseFavourites(text)
    const merged = mergeFavourites(read, read, Date.parse('2026-01-02T00:00:00Z'))
    const again = JSON.parse(JSON.stringify(merged))
    expect(again.theme).toBe('dark')
    expect(again.items[0].note).toBe('mine')
    expect(again.removed[0].by).toBe('phone')
  })

  it('stars, unstars and leaves a tombstone', () => {
    const one = toggleFavourite(
      { version: 1, items: [], removed: [] },
      { path: '/a.sid', md5: 'AA' },
      '2026-09-21T10:00:00Z'
    )
    expect(isFavourite(one, { path: '/a.sid' })).toBe(true)
    expect(one.items[0].md5).toBe('aa')
    const none = toggleFavourite(one, { path: '/a.sid', md5: 'aa' }, '2026-09-21T11:00:00Z')
    expect(isFavourite(none, { path: '/a.sid' })).toBe(false)
    expect(none.removed).toEqual([{ path: '/a.sid', at: '2026-09-21T11:00:00Z' }])
  })

  it('merges two devices by which action happened later', () => {
    const starred = star('/a.sid', '2026-09-21T10:00:00Z')
    const unstarredLater: FavouritesFile = {
      version: 1,
      items: [],
      removed: [{ path: '/a.sid', at: '2026-09-21T12:00:00Z' }]
    }
    expect(isFavourite(mergeFavourites(starred, unstarredLater), { path: '/a.sid' })).toBe(false)

    const starredLater = star('/a.sid', '2026-09-21T13:00:00Z')
    const merged = mergeFavourites(unstarredLater, starredLater)
    expect(isFavourite(merged, { path: '/a.sid' })).toBe(true)
    expect(merged.removed).toEqual([])
  })

  it('keeps stars only one device knows about', () => {
    const merged = mergeFavourites(
      star('/a.sid', '2026-09-21T10:00:00Z'),
      star('/b.sid', '2026-09-21T11:00:00Z')
    )
    expect(merged.items.map((i) => i.path)).toEqual(['/a.sid', '/b.sid'])
  })

  it('forgets tombstones once they are old enough to be irrelevant', () => {
    const old: FavouritesFile = {
      version: 1,
      items: [],
      removed: [{ path: '/a.sid', at: '2026-01-01T00:00:00Z' }]
    }
    const now = Date.parse('2026-09-21T00:00:00Z')
    expect(mergeFavourites(old, { version: 1, items: [], removed: [] }, now).removed).toEqual([])
  })

  it('merges with the space before writing, so a parallel star is not lost', async () => {
    const remote = star('/remote.sid', '2026-09-21T10:00:00Z')
    const ops = fakeSpace({})
    ops.readText = vi.fn(async () => JSON.stringify(remote))
    const written = await saveFavourites(ops, star('/mine.sid', '2026-09-21T11:00:00Z'))
    expect(written.items.map((i) => i.path).sort()).toEqual(['/mine.sid', '/remote.sid'])
    expect(ops.writeText).toHaveBeenCalledWith(
      '.sidplayer/favourites.json',
      expect.stringContaining('/remote.sid')
    )
  })
})

describe('the order of favourites', () => {
  const star = (path: string, at: string, rank?: number, rankedAt?: string) => ({
    path,
    md5: '',
    at,
    ...(rank === undefined ? {} : { rank, rankedAt })
  })
  const file = (...items: ReturnType<typeof star>[]): FavouritesFile => ({ version: 1, items, removed: [] })
  const paths = (f: FavouritesFile) => orderedFavourites(f).map((item) => item.path)

  it('shows hand-placed tunes first and the rest oldest first', () => {
    const f = file(
      star('/c.sid', '2026-01-03T00:00:00Z'),
      star('/a.sid', '2026-01-01T00:00:00Z'),
      star('/b.sid', '2026-01-02T00:00:00Z', 0, '2026-02-01T00:00:00Z')
    )
    // b was put first by hand; a and c have no position, so they follow in
    // the order they were starred.
    expect(paths(f)).toEqual(['/b.sid', '/a.sid', '/c.sid'])
  })

  it('moves a tune and renumbers the list densely', () => {
    const f = file(
      star('/a.sid', '2026-01-01T00:00:00Z'),
      star('/b.sid', '2026-01-02T00:00:00Z'),
      star('/c.sid', '2026-01-03T00:00:00Z')
    )
    const moved = moveFavouriteTo(f, { path: '/c.sid' }, 0, '2026-03-01T00:00:00Z')
    expect(paths(moved)).toEqual(['/c.sid', '/a.sid', '/b.sid'])
    expect(orderedFavourites(moved).map((i) => i.rank)).toEqual([0, 1, 2])
    expect(moveFavouriteTo(moved, { path: '/c.sid' }, 2, '2026-03-02T00:00:00Z')).toSatisfy(
      (next: FavouritesFile) => paths(next).join() === '/a.sid,/b.sid,/c.sid'
    )
  })

  it('clamps a move past either end, and does nothing when nothing changes', () => {
    const f = file(star('/a.sid', '2026-01-01T00:00:00Z'), star('/b.sid', '2026-01-02T00:00:00Z'))
    // Past the end lands at the end, past the start lands at the start.
    expect(paths(moveFavouriteTo(f, { path: '/a.sid' }, 99))).toEqual(['/b.sid', '/a.sid'])
    expect(paths(moveFavouriteTo(f, { path: '/b.sid' }, -5))).toEqual(['/b.sid', '/a.sid'])
    // Already where it was asked to go: the same object back, so the view
    // has nothing to react to and no write is provoked.
    expect(moveFavouriteTo(f, { path: '/a.sid' }, 0)).toBe(f)
    expect(moveFavouriteTo(f, { path: '/b.sid' }, 99)).toBe(f)
    expect(moveFavouriteTo(f, { path: '/missing.sid' }, 0)).toBe(f)
  })

  /*
   * The reason rank carries its own timestamp. Reordering does not restar
   * anything, so `at` is untouched by it; merging the whole item on `at`
   * alone would hand back the other copy's order every time.
   */
  it('keeps a reorder through a merge, though the star times did not change', () => {
    const remote = file(star('/a.sid', '2026-01-01T00:00:00Z'), star('/b.sid', '2026-01-02T00:00:00Z'))
    const local = moveFavouriteTo(remote, { path: '/b.sid' }, 0, '2026-04-01T00:00:00Z')
    expect(paths(mergeFavourites(remote, local))).toEqual(['/b.sid', '/a.sid'])
    // And the other way round, so it does not depend on which side is which.
    expect(paths(mergeFavourites(local, remote))).toEqual(['/b.sid', '/a.sid'])
  })

  it('lets the later reorder win between two devices', () => {
    const base = file(
      star('/a.sid', '2026-01-01T00:00:00Z'),
      star('/b.sid', '2026-01-02T00:00:00Z'),
      star('/c.sid', '2026-01-03T00:00:00Z')
    )
    // Both devices start from the same list and each drags a different
    // tune to the front, so every position is restamped on both sides.
    const early = moveFavouriteTo(base, { path: '/c.sid' }, 0, '2026-04-01T00:00:00Z')
    const late = moveFavouriteTo(base, { path: '/b.sid' }, 0, '2026-05-01T00:00:00Z')
    expect(paths(early)).toEqual(['/c.sid', '/a.sid', '/b.sid'])
    expect(paths(late)).toEqual(['/b.sid', '/a.sid', '/c.sid'])
    expect(paths(mergeFavourites(early, late))).toEqual(['/b.sid', '/a.sid', '/c.sid'])
    expect(paths(mergeFavourites(late, early))).toEqual(['/b.sid', '/a.sid', '/c.sid'])
  })

  it('survives the round trip through the file', () => {
    const f = moveFavouriteTo(
      file(star('/a.sid', '2026-01-01T00:00:00Z'), star('/b.sid', '2026-01-02T00:00:00Z')),
      { path: '/b.sid' },
      0,
      '2026-04-01T00:00:00Z'
    )
    expect(paths(parseFavourites(JSON.stringify(f)))).toEqual(['/b.sid', '/a.sid'])
    // A rank without its stamp is not a position anyone can merge on.
    const half = parseFavourites(
      JSON.stringify({
        version: 1,
        items: [{ path: '/a.sid', md5: '', at: '2026-01-01T00:00:00Z', rank: 3 }],
        removed: []
      })
    )
    expect(half.items[0].rank).toBe(3)
    expect(half.items[0].rankedAt).toBeUndefined()
  })
})

const oldName = inFolderRenamed(PRIVATE_FOLDER, LEGACY_PRIVATE_FOLDER)

describe('the app folder moving out of the collection', () => {
  /*
   * `.sidplayer/` used to sit inside the collection and now sits in the base
   * folder above it. Someone who moves an old `/C64Music` into the new
   * `/SID Library` carries the old folder along inside it, so a read has to
   * look in both places - and a write has to put it in the new one.
   */
  const pair = () => {
    const base = new Map<string, string>()
    // Inside the collection the folder only ever had its old name.
    const legacy = new Map<string, string>([['.sidplay/favourites.json', 'old']])
    const ops = (store: Map<string, string>): SpaceOps =>
      fakeSpaceOps({
        readText: async (path: string) => store.get(path) ?? null,
        writeText: async (path: string, text: string) => void store.set(path, text)
      })
    return { base, legacy, ops: withReadFallbacks(ops(base), [{ ops: ops(legacy), path: oldName }]) }
  }

  it('reads the old place when the new one is empty', async () => {
    const { ops } = pair()
    await expect(ops.readText('.sidplayer/favourites.json')).resolves.toBe('old')
  })

  it('prefers the new place once something is there', async () => {
    const { base, ops } = pair()
    base.set('.sidplayer/favourites.json', 'new')
    await expect(ops.readText('.sidplayer/favourites.json')).resolves.toBe('new')
  })

  it('writes to the new place, which moves the file on first change', async () => {
    const { base, legacy, ops } = pair()
    await ops.writeText('.sidplayer/favourites.json', 'changed')
    expect(base.get('.sidplayer/favourites.json')).toBe('changed')
    expect(legacy.get('.sidplay/favourites.json')).toBe('old')
    await expect(ops.readText('.sidplayer/favourites.json')).resolves.toBe('changed')
  })

  it('says nothing is there when neither place has it', async () => {
    const { ops } = pair()
    await expect(ops.readText('.sidplayer/status.json')).resolves.toBeNull()
  })
})

/*
 * The app's folder was `.sidplay` before the app was `sidplayer`. Favourites
 * and status left there are read until the next write puts them in the new
 * one; nothing is ever written to the old.
 */
describe('the app folder under its earlier name', () => {
  it('is read where the new one has nothing yet, and never written', async () => {
    const files: Record<string, string> = {
      [`${LEGACY_PRIVATE_FOLDER}/favourites.json`]: 'old',
      [`${PRIVATE_FOLDER}/status.json`]: 'new'
    }
    const base = fakeSpaceOps({
      readText: vi.fn(async (path: string) => files[path.replace(/^\//, '')] ?? null)
    })
    const ops = withReadFallbacks(base, [{ ops: base, path: oldName }])
    expect(await ops.readText('.sidplayer/favourites.json')).toBe('old')
    expect(await ops.readText('.sidplayer/status.json')).toBe('new')
    expect(await ops.readText('/elsewhere.json')).toBeNull()
    await ops.writeText('.sidplayer/favourites.json', 'x')
    expect(base.writeText).toHaveBeenCalledWith('.sidplayer/favourites.json', 'x')
  })
})

/*
 * Every place is asked at once, but a failure still counts only where the
 * places before it said the file is not there.
 */
describe('reading through fallbacks', () => {
  const failing = () => fakeSpaceOps({ readText: vi.fn(async () => Promise.reject({ statusCode: 503 })) })
  const holding = (text: string | null) => fakeSpaceOps({ readText: vi.fn(async () => text) })

  it('ignores a failure behind a place that has the file', async () => {
    const ops = withReadFallbacks(holding('here'), [{ ops: failing() }])
    await expect(ops.readText('x')).resolves.toBe('here')
  })

  it('does not swallow a failure where the places before it have nothing', async () => {
    const ops = withReadFallbacks(holding(null), [{ ops: failing() }])
    await expect(ops.readText('x')).rejects.toMatchObject({ statusCode: 503 })
  })

  it('maps a path to its old name only inside the folder that was renamed', () => {
    expect(oldName('/.sidplayer/favourites.json')).toBe('/.sidplay/favourites.json')
    expect(oldName('.sidplayer/status.json')).toBe('.sidplay/status.json')
    expect(oldName('/C64Music/x.sid')).toBeNull()
  })
})
