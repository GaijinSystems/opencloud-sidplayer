import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Resource, SpaceResource } from '@opencloud-eu/web-client'
import { createLibrary } from '../src/library/useLibrary'
import { md5Hex } from '../src/sid/md5'
import { readConfig } from '../src/config'
import type { SpaceOps } from '../src/hvsc/space'
import { totalLength } from '../src/hvsc/catalog'
import type { MirrorOps } from '../src/hvsc/mirror'
import type { WebDav } from '../src/sid/source'
import { psidHeader } from './helpers/bytes'
import { fakeCache, fakeSpaceOps } from './helpers/fakes'
import { decodeLatin1 } from '../src/hvsc/text'

/**
 * The library composable, driven with a fake space and a fake mirror.
 *
 * Two behaviours are worth this much setup. A catalogue describes the whole
 * release, so it lists tunes the space may not have - during a first sync, or
 * in a collection unpacked from an older archive - and playing one of those
 * has to fetch it rather than fail. And a collection that arrived as an
 * unpacked archive has no header fields at all, because nothing read the
 * bytes on the way in, so there has to be a way to read them all.
 */

/** A PSID header with the fields the list and the filters want. */
const psid = psidHeader

interface Rig {
  ops: SpaceOps
  mirror: MirrorOps
  play: ReturnType<
    typeof vi.fn<(space: SpaceResource, resource: Resource, options?: { autoplay?: boolean }) => void>
  >
  present: Set<string>
  written: Map<string, Uint8Array>
}

/** Every tune in the fixture release; the mirror has all of them, as upstream does. */
const RELEASE_PATHS = [
  '/MUSICIANS/H/Hubbard_Rob/Commando.sid',
  '/MUSICIANS/H/Hubbard_Rob/Delta.sid',
  '/MUSICIANS/G/Galway_Martin/Wizball.sid'
]

/** What the mirror serves for a path: a small PSID named after the file. */
const served = (path: string): Uint8Array => psid(path.split('/').pop()!.replace('.sid', ''), 'Someone', '1987')

/**
 * The release's manifest, listing each tune under the MD5 of exactly what the
 * mirror serves for it, as a real mirror's does - so a fetch can be checked
 * against it the way the library checks one.
 */
const MANIFEST = `[Database]
${RELEASE_PATHS.map((path, i) => `; ${path}\n${md5Hex(served(path))}=${['3:58', '6:33', '4:22'][i]}`).join('\n')}
`

function rig(options: { present?: string[]; mirrorHas?: string[] } = {}): Rig {
  const present = new Set(options.present ?? [])
  const mirrorHas = new Set(options.mirrorHas ?? RELEASE_PATHS)
  const written = new Map<string, Uint8Array>()

  const ops = fakeSpaceOps({
    list: vi.fn(async (path: string) => {
      if (path === '/') return { folders: ['/MUSICIANS', '/DOCUMENTS'], files: [] }
      const files = [...present]
        .filter((p) => p.slice(0, p.lastIndexOf('/')) === path)
        // What the server would say: the MD5 of what is on disk, which here is
        // what the mirror serves - a collection in step with its release.
        .map((p) => ({ path: p, md5: md5Hex(served(p)), size: 128 }))
      const folders = [...new Set([...present].map((p) => p.slice(0, p.lastIndexOf('/'))))]
        .filter((f) => f.startsWith(path === '/' ? '/' : `${path}/`) && f !== path)
        .map((f) =>
          f
            .split('/')
            .slice(0, path.split('/').filter(Boolean).length + 2)
            .join('/')
        )
      return { folders: [...new Set(folders)], files }
    }),
    readHead: vi.fn(async (path: string) => {
      if (!present.has(path)) throw new Error('404')
      return psid(path.split('/').pop()!.replace('.sid', ''), 'Someone', '1987 Somebody')
    }),
    readText: vi.fn(async (path: string) => (path.endsWith('Songlengths.md5') ? MANIFEST : null)),
    write: vi.fn(async (path: string, bytes: Uint8Array) => {
      written.set(path, bytes)
      present.add(path)
    })
  })

  const mirror: MirrorOps = {
    release: vi.fn(async () => 85),
    document: vi.fn(async () => MANIFEST),
    tune: vi.fn(async (path: string) => {
      if (!mirrorHas.has(path)) throw new Error('404')
      return served(path)
    }),
    reachable: vi.fn(async () => true)
  }

  const play = vi.fn<(space: SpaceResource, resource: Resource, options?: { autoplay?: boolean }) => void>()
  return { ops, mirror, play, present, written }
}

const library = (r: Rig, overrides: Partial<Parameters<typeof createLibrary>[0]> = {}) =>
  createLibrary({
    webdav: {} as WebDav,
    space: {} as SpaceResource,
    config: readConfig({}),
    play: r.play,
    ops: r.ops,
    mirror: r.mirror,
    ...overrides
  })

/** Text as the bytes a mirror would send for it, one byte per character. */
const bytesOf = (t: string) => Uint8Array.from(t, (c) => c.charCodeAt(0))
/** Long enough for what a call set going without awaiting it to land. */
const settle = () => new Promise((done) => setTimeout(done, 20))
const tuneFetches = (r: Rig) =>
  vi.mocked(r.mirror.tune).mock.calls.filter(([p]) => String(p).endsWith('.sid')).length
const statusWrites = (r: Rig) =>
  vi
    .mocked(r.ops.writeText)
    .mock.calls.filter(([p]) => String(p).endsWith('status.json'))
    .map(([, text]) => JSON.parse(String(text)) as { release: number | null; mode?: string })
const lastStatus = (r: Rig) => statusWrites(r).at(-1)

describe('the library over a collection', () => {
  let r: Rig

  beforeEach(() => {
    r = rig({ present: ['/MUSICIANS/H/Hubbard_Rob/Commando.sid', '/DOCUMENTS/Songlengths.md5'] })
  })

  it('opens on the collection it finds and catalogues the whole release', async () => {
    const lib = library(r)
    await lib.init()
    expect(lib.phase.value).toBe('ready')
    expect(lib.rows.value).toHaveLength(3)
    expect(lib.rows.value.map((row) => row.name)).toContain('Wizball.sid')
  })

  it('marks the tunes a folder does not have', async () => {
    const lib = library(r)
    await lib.init()
    lib.openFolder('/MUSICIANS/H/Hubbard_Rob')
    await new Promise((done) => setTimeout(done, 0))
    const here = lib.localBy.value?.get('/MUSICIANS/H/Hubbard_Rob')
    expect(here?.has('/MUSICIANS/H/Hubbard_Rob/Commando.sid')).toBe(true)
    expect(here?.has('/MUSICIANS/H/Hubbard_Rob/Delta.sid')).toBe(false)
    // A folder nobody has opened is unknown, not empty.
    expect(lib.localBy.value?.has('/MUSICIANS/G/Galway_Martin')).toBe(false)
  })

  it('says nothing about what is local while searching across folders', async () => {
    const lib = library(r)
    await lib.init()
    lib.search('delta')
    expect(lib.localBy.value).toBeNull()
  })

  /*
   * In HVSC the interesting folders hold only subfolders: MUSICIANS has
   * 56,568 tunes beneath it and not one of its own. Clicking it used to show
   * an empty list, which contradicted the count the tree prints beside it.
   */
  it('lists everything beneath a folder, not just its own files', async () => {
    const lib = library(r)
    await lib.init()

    lib.openFolder('/MUSICIANS')
    expect(lib.visible.value).toHaveLength(3)
    expect(lib.listingIsDeep.value).toBe(true)

    lib.openFolder('/MUSICIANS/H')
    expect(lib.visible.value.map((row) => row.name).sort()).toEqual(['Commando.sid', 'Delta.sid'])

    lib.openFolder('/MUSICIANS/H/Hubbard_Rob')
    expect(lib.visible.value).toHaveLength(2)
    // Its own files only, so rows need no path line.
    expect(lib.listingIsDeep.value).toBe(false)
  })

  it('lists the whole collection under All tunes', async () => {
    const lib = library(r)
    await lib.init()
    lib.openFolder('/')
    expect(lib.visible.value).toHaveLength(3)
    expect(lib.listingIsDeep.value).toBe(true)
  })

  it('does not mistake a neighbouring folder for a child', async () => {
    const lib = library(r)
    await lib.init()
    // `/MUSICIANS/G` must not pick up `/MUSICIANS/Galway...`-style siblings.
    lib.openFolder('/MUSICIANS/G')
    expect(lib.visible.value.map((row) => row.name)).toEqual(['Wizball.sid'])
  })

  it('plays a tune that is already there without fetching anything', async () => {
    const lib = library(r)
    await lib.init()
    const row = lib.rows.value.find((x) => x.name === 'Commando.sid')!
    await lib.play(row)
    expect(r.mirror.tune).not.toHaveBeenCalled()
    expect(r.play).toHaveBeenCalledTimes(1)
    expect(r.play.mock.calls[0][1].id).toBe(`hvsc:${row.path}`)
  })

  it('fetches a tune the space does not have, then plays it', async () => {
    const lib = library(r)
    await lib.init()
    const row = lib.rows.value.find((x) => x.name === 'Delta.sid')!
    await lib.play(row)
    expect(r.mirror.tune).toHaveBeenCalledWith('/MUSICIANS/H/Hubbard_Rob/Delta.sid')
    expect(r.written.has('/MUSICIANS/H/Hubbard_Rob/Delta.sid')).toBe(true)
    expect(r.play).toHaveBeenCalledTimes(1)
    expect(lib.error.value).toBeNull()
    // And it is now known to be there, so a second play fetches nothing.
    await lib.play(row)
    expect(r.mirror.tune).toHaveBeenCalledTimes(1)
  })

  /*
   * A tune the folder listing did not mention is still handed to the player
   * when the mirror cannot supply it.
   *
   * "It is missing" is a conclusion drawn from one listing, and a listing
   * that failed looks exactly like an empty folder. Refusing to play meant a
   * tune sitting on disk stayed silent because the copy we tried to write
   * beside it was refused - and the player is the one that can actually tell
   * whether the bytes are there.
   */
  it('still plays a tune it could not fetch, since it may be there all along', async () => {
    const missing = rig({
      present: ['/DOCUMENTS/Songlengths.md5', '/MUSICIANS/H/Hubbard_Rob/Commando.sid'],
      mirrorHas: []
    })
    const lib = library(missing)
    await lib.init()
    const row = lib.rows.value.find((x) => x.name === 'Wizball.sid')!
    await lib.play(row)
    expect(missing.play).toHaveBeenCalledTimes(1)
    expect(lib.fetching.value.size).toBe(0)
    /*
     * And says why the fetch failed. The listing succeeded and said the file
     * is absent, so the play is about to fail with a bare 404; the reason the
     * copy could not be had is the more useful half of that.
     */
    expect(lib.playError.value).toMatch(/is not in your collection, and fetching it failed/)
  })

  it('reads every header when asked, and remembers what it read', async () => {
    const all = rig({
      present: [
        '/DOCUMENTS/Songlengths.md5',
        '/MUSICIANS/H/Hubbard_Rob/Commando.sid',
        '/MUSICIANS/H/Hubbard_Rob/Delta.sid',
        '/MUSICIANS/G/Galway_Martin/Wizball.sid'
      ]
    })
    const lib = library(all)
    await lib.init()
    expect(lib.rows.value.every((row) => row.title === undefined)).toBe(true)

    await lib.indexAll()
    expect(lib.indexing.value).toMatchObject({ running: false, total: 3, done: 3 })
    expect(lib.rows.value.map((row) => row.title).sort()).toEqual(['Commando', 'Delta', 'Wizball'])
    // Header-only reads: 128 bytes each, not the whole file. The documents
    // are read whole, as Latin-1, which is why this looks at tunes only.
    expect(all.ops.readHead).toHaveBeenCalledWith('/MUSICIANS/H/Hubbard_Rob/Commando.sid', 128)
    const readWhole = (all.ops.read as unknown as { mock: { calls: string[][] } }).mock.calls.map(([p]) => p)
    expect(readWhole.filter((p) => p.endsWith('.sid'))).toEqual([])

    // Now the chip filter has something to work with.
    lib.search('chip:6581')
    expect(lib.hits.value.length).toBe(3)
  })

  it('counts the headers it could not read rather than failing the pass', async () => {
    const lib = library(r) // only Commando is present
    await lib.init()
    await lib.indexAll()
    expect(lib.indexing.value.total).toBe(3)
    expect(lib.indexing.value.failed).toBeGreaterThan(0)
    expect(lib.rows.value.filter((row) => row.title !== undefined)).toHaveLength(1)
  })

  /*
   * The status line exists because every one of these can look like nothing
   * happening: a release check is a round trip, planning walks about 1,951
   * folders on a real collection, and indexing is 61,157 header reads. A
   * running sync used to vanish entirely the moment its panel was closed.
   */
  it('says when it is checking for a new release', async () => {
    const slow = rig({ present: ['/DOCUMENTS/Songlengths.md5'] })
    let release: (v: number) => void = () => {}
    slow.mirror.release = vi.fn(() => new Promise<number>((r) => (release = r)))
    const lib = library(slow)
    await lib.init()
    expect(lib.activity.value).toMatchObject({ kind: 'checking', opensSync: false })
    expect(lib.activity.value?.text).toMatch(/new release/)
    release(86)
    await new Promise((r) => setTimeout(r, 0))
    expect(lib.activity.value).toBeNull()
  })

  it('says how far a header pass has got, and offers no sync panel for it', async () => {
    const all = rig({
      present: [
        '/DOCUMENTS/Songlengths.md5',
        '/MUSICIANS/H/Hubbard_Rob/Commando.sid',
        '/MUSICIANS/H/Hubbard_Rob/Delta.sid'
      ]
    })
    const seen: string[] = []
    const lib = library(all)
    await lib.init()
    const readHead = all.ops.readHead
    all.ops.readHead = vi.fn(async (path: string, n: number) => {
      if (lib.activity.value) seen.push(lib.activity.value.text)
      return readHead(path, n)
    })
    await lib.indexAll()
    expect(seen.some((line) => /Reading headers/.test(line))).toBe(true)
    expect(lib.activity.value).toBeNull()
  })

  it('shows a running sync, with a percentage, and points at its panel', async () => {
    const lib = library(r)
    await lib.init()
    lib.sync.value = {
      ...lib.sync.value,
      state: 'running',
      progress: {
        done: 25,
        total: 100,
        bytes: 1024,
        mismatched: 0,
        added: 25,
        replaced: 0,
        removed: 0,
        failed: 0,
        recent: []
      }
    }
    expect(lib.activity.value).toMatchObject({ kind: 'syncing', percent: 25, opensSync: true })
    expect(lib.activity.value?.text).toMatch(/25 of 100 files/)

    lib.sync.value = { ...lib.sync.value, state: 'paused' }
    expect(lib.activity.value).toMatchObject({ kind: 'paused', opensSync: true })
  })

  /*
   * Sorting sits in the library, not in the table, for one reason: the table
   * renders at most 400 rows, so a sort applied there would reorder whatever
   * 400 rows happened to be at the front of 56,568 and call it sorted.
   */
  describe('sorting the list', () => {
    it('cycles a column and reorders everything the view holds', async () => {
      const lib = library(r)
      await lib.init()
      lib.openFolder('/')
      const natural = lib.visible.value.map((row) => row.name)
      expect(lib.sort.value).toBeNull()

      lib.toggleSort('title')
      expect(lib.sort.value).toEqual({ column: 'title', direction: 'asc' })
      const asc = lib.visible.value.map((row) => row.title || row.stem)
      expect(asc).toEqual([...asc].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())))

      lib.toggleSort('title')
      expect(lib.sort.value).toEqual({ column: 'title', direction: 'desc' })
      expect(lib.visible.value.map((row) => row.title || row.stem)).toEqual([...asc].reverse())

      // The third click restores the order the view had on its own, which
      // is path order here and relevance in a search.
      lib.toggleSort('title')
      expect(lib.sort.value).toBeNull()
      expect(lib.visible.value.map((row) => row.name)).toEqual(natural)
    })

    it('outlives the folder it was set in', async () => {
      const lib = library(r)
      await lib.init()
      lib.toggleSort('length')
      lib.openFolder('/MUSICIANS')
      expect(lib.sort.value).toEqual({ column: 'length', direction: 'asc' })
      const lengths = lib.visible.value.map((row) => totalLength(row))
      expect(lengths).toEqual([...lengths].sort((a, b) => a - b))
    })

    it('sorts search results too, overriding relevance until it is cleared', async () => {
      const lib = library(r)
      await lib.init()
      lib.search('sid')
      const byRelevance = lib.visible.value.map((row) => row.name)
      lib.toggleSort('title')
      const byTitle = lib.visible.value.map((row) => row.title || row.stem)
      expect(byTitle).toEqual([...byTitle].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())))
      lib.toggleSort('title')
      lib.toggleSort('title')
      expect(lib.visible.value.map((row) => row.name)).toEqual(byRelevance)
    })
  })

  it('offers the first-run screen when there is no collection', async () => {
    const empty = rig()
    empty.ops.list = vi.fn(async () => ({ folders: ['/Photos'], files: [] }))
    const lib = library(empty)
    await lib.init()
    expect(lib.phase.value).toBe('first-run')
    expect(lib.rows.value).toHaveLength(0)
  })
})

/**
 * Where the library opens: the favourites when there are any to list, the
 * composers when there are not, and never somewhere a rebuild has to move
 * the user away from.
 */
describe('the view the library opens on', () => {
  /** A library over the smallest collection, with these tunes starred, once it is ready. */
  const opened = async (stars: Array<{ path: string; collection?: 'cgsc' }> = []) => {
    const r = rig({ present: ['/DOCUMENTS/Songlengths.md5'] })
    const file = JSON.stringify({
      version: 1,
      items: stars.map((item) => ({ ...item, md5: '', at: '2026-10-01T00:00:00.000Z' })),
      removed: []
    })
    r.ops.readText = vi.fn(async (path: string) =>
      path.endsWith('Songlengths.md5') ? MANIFEST : path.endsWith('favourites.json') ? file : null
    )
    const lib = library(r)
    await lib.init()
    expect(lib.phase.value).toBe('ready')
    return lib
  }

  it('opens on the composers when nothing is starred', async () => {
    expect((await opened()).mode.value).toBe('composers')
  })

  it('opens on the favourites when there are some', async () => {
    const lib = await opened([{ path: '/MUSICIANS/H/Hubbard_Rob/Delta.sid' }])
    expect(lib.mode.value).toBe('favourites')
    expect(lib.visible.value.map((row) => row.path)).toEqual(['/MUSICIANS/H/Hubbard_Rob/Delta.sid'])
  })

  it('does not open on a list of tunes the release no longer has', async () => {
    expect((await opened([{ path: '/MUSICIANS/W/Withdrawn/Gone.sid' }])).mode.value).toBe('composers')
  })

  it("takes a Compute's star on trust, since that collection is read afterwards", async () => {
    expect((await opened([{ path: '/Bolero/Bolero.mus', collection: 'cgsc' }])).mode.value).toBe('favourites')
  })

  it('leaves the user where they are when it loads again', async () => {
    const lib = await opened([{ path: '/MUSICIANS/H/Hubbard_Rob/Delta.sid' }])
    lib.openFolder('/MUSICIANS/G')
    await lib.init()
    expect(lib.mode.value).toBe('folder')
    expect(lib.folder.value).toBe('/MUSICIANS/G')
  })
})

/**
 * Playing from the library: what reaches the player, in what order, and what
 * is said when something does not.
 */
describe('playing from the library', () => {
  /** A promise and the hand that settles it, for holding a fetch in flight. */
  const held = <T>() => {
    let settle!: (value: T) => void
    let fail!: (reason: unknown) => void
    const promise = new Promise<T>((resolve, reject) => {
      settle = resolve
      fail = reject
    })
    return { promise, settle, fail }
  }
  const rowNamed = (lib: ReturnType<typeof library>, name: string) =>
    lib.rows.value.find((x) => x.name === name)!

  /*
   * What the mirror sends is checked before it is written, as a sync checks
   * it. A proxy answering 200 with an error page would otherwise land in the
   * collection as a `.sid`, be listed as present, and fail every play after.
   */
  it('does not write what the mirror sent unless it is the tune the release describes', async () => {
    const r = rig({ present: ['/DOCUMENTS/Songlengths.md5'] })
    r.mirror.tune = vi.fn(async () => new TextEncoder().encode('<html>Bad gateway</html>'))
    const lib = library(r)
    await lib.init()
    await lib.play(rowNamed(lib, 'Delta.sid'))
    expect(r.written.size).toBe(0)
    expect(r.play).toHaveBeenCalledTimes(1)
    expect(lib.playError.value).toMatch(/fetching it failed/)
  })

  /*
   * The latest choice wins. A tune that has to be fetched first used to be
   * handed to the player whenever its fetch finished - after a tune picked
   * later had started, which it then replaced.
   */
  it('lets a later choice win over an earlier one still being fetched', async () => {
    const r = rig({ present: ['/DOCUMENTS/Songlengths.md5', '/MUSICIANS/H/Hubbard_Rob/Commando.sid'] })
    const fetch = held<Uint8Array>()
    r.mirror.tune = vi.fn(() => fetch.promise)
    const lib = library(r)
    await lib.init()
    const slow = lib.play(rowNamed(lib, 'Delta.sid'))
    await new Promise((done) => setTimeout(done, 0))
    await lib.play(rowNamed(lib, 'Commando.sid'))
    fetch.settle(served('/MUSICIANS/H/Hubbard_Rob/Delta.sid'))
    await slow
    expect(r.play.mock.calls.map(([, resource]) => String(resource.path))).toEqual([
      expect.stringContaining('Commando.sid')
    ])
    // The file it went to fetch is still kept; only the play stands down.
    expect(r.written.has('/MUSICIANS/H/Hubbard_Rob/Delta.sid')).toBe(true)
  })

  /*
   * Why the last play went wrong is about the last play. Kept, it sat over
   * every tune after it and hid whatever the player had to say about them.
   */
  it('forgets why the last play failed when the next one starts', async () => {
    const r = rig({
      present: ['/DOCUMENTS/Songlengths.md5', '/MUSICIANS/H/Hubbard_Rob/Commando.sid'],
      mirrorHas: []
    })
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const lib = library(r)
    await lib.init()
    await lib.play(rowNamed(lib, 'Wizball.sid'))
    expect(lib.playError.value).toBeTruthy()
    await lib.play(rowNamed(lib, 'Commando.sid'))
    expect(lib.playError.value).toBeNull()
  })
})

/**
 * Favourites written while an earlier write is still on its way. Each write
 * reads the file, merges, and writes it back; two at once used to race, and
 * whichever finished last decided what was kept.
 */
describe('saving favourites', () => {
  it('keeps both of two stars made in quick succession, in memory and in the file', async () => {
    const r = rig({ present: ['/DOCUMENTS/Songlengths.md5'] })
    let file: string | null = null
    const firstWrite = (() => {
      let release!: () => void
      return { gate: new Promise<void>((done) => (release = done)), release: () => release() }
    })()
    let writes = 0
    r.ops.readText = vi.fn(async (path: string) =>
      path.endsWith('Songlengths.md5') ? MANIFEST : path.endsWith('favourites.json') ? file : null
    )
    r.ops.writeText = vi.fn(async (path: string, text: string) => {
      if (!path.endsWith('favourites.json')) return
      // The first write is slow and lands last, which is the order that lost a star.
      if (++writes === 1) await firstWrite.gate
      file = text
    })
    const lib = library(r)
    await lib.init()
    const a = lib.rows.value.find((x) => x.name === 'Commando.sid')!
    const b = lib.rows.value.find((x) => x.name === 'Delta.sid')!
    const first = lib.toggleStar(a)
    const second = lib.toggleStar(b)
    await new Promise((done) => setTimeout(done, 0))
    firstWrite.release()
    await Promise.all([first, second])
    const kept = (JSON.parse(file!) as { items: Array<{ path: string }> }).items.map((item) => item.path).sort()
    expect(kept).toEqual([a.path, b.path].sort())
    expect(lib.isStarred(a) && lib.isStarred(b)).toBe(true)
  })
})

/*
 * The library is made once and kept, so it cannot hold on to the space it
 * was first given. Opened by a deep link before the spaces had loaded, it was
 * given none, and "Try again" asked that same nothing for ever.
 */
describe('a library opened before the spaces have loaded', () => {
  it('finds the space on a later try, once there is one', async () => {
    const r = rig({ present: ['/DOCUMENTS/Songlengths.md5'] })
    let space: SpaceResource | undefined = undefined
    const lib = createLibrary({
      webdav: {} as WebDav,
      space: () => space,
      config: readConfig({}),
      play: r.play,
      ops: r.ops,
      mirror: r.mirror
    })
    await lib.init()
    expect(lib.phase.value).toBe('failed')
    space = {} as SpaceResource
    await lib.init()
    expect(lib.phase.value).toBe('ready')
  })
})

/*
 * A favourites file that is not JSON - a stray comma from a hand edit, a
 * write cut off half way - used to read as an empty list. The next star then
 * merged with nothing and wrote back a file of one, and every other star in
 * it was gone.
 */
describe('a favourites file that is not JSON', () => {
  it('is left alone, and the reason is given', async () => {
    const r = rig({ present: ['/DOCUMENTS/Songlengths.md5'] })
    const broken = '{"version":1,"items":[{"path":"/MUSICIANS/H/Hubbard_Rob/Delta.sid",}]}'
    r.ops.readText = vi.fn(async (path: string) =>
      path.endsWith('Songlengths.md5') ? MANIFEST : path.endsWith('favourites.json') ? broken : null
    )
    const lib = library(r)
    await lib.init()
    expect(lib.error.value).toMatch(/not valid JSON/)
    await lib.toggleStar(lib.rows.value[0])
    const favouriteWrites = (r.ops.writeText as ReturnType<typeof vi.fn>).mock.calls.filter(([p]) =>
      String(p).endsWith('favourites.json')
    )
    expect(favouriteWrites).toHaveLength(0)
    expect(lib.error.value).toMatch(/not valid JSON/)
  })
})

/**
 * Running an update from the library: pausing and resuming, one run at a
 * time, and claiming a release only for a collection that has it.
 */
describe('updating the collection', () => {
  /*
   * A paused run used to start again from the first file when resumed: a
   * first sync paused at 50,000 of 61,157 fetched all 50,000 again, while
   * the panel promised that nothing was lost.
   */
  it('picks up a paused run where it stopped', async () => {
    const r = rig({ present: ['/DOCUMENTS/Songlengths.md5'] })
    const lib = library(r)
    await lib.init()
    await lib.planUpdate()
    expect(lib.sync.value.plan?.add).toHaveLength(3)
    const fetch = r.mirror.tune
    r.mirror.tune = vi.fn(async (path: string) => {
      // Pause once the first tune is in hand.
      if (tuneFetches(r) === 1) lib.pauseUpdate()
      return fetch(path)
    })
    await lib.startUpdate()
    expect(lib.sync.value.state).toBe('paused')
    const before = tuneFetches(r)
    await lib.startUpdate()
    expect(lib.sync.value.state).toBe('done')
    expect(tuneFetches(r)).toBe(3)
    expect(before).toBeGreaterThanOrEqual(1)
  })

  /*
   * The bytes of every tune pass through on their way to the space, and the
   * header is in the first 124 of them. A first sync used to end with the
   * whole release and not one title, and an offer to read 61,157 headers
   * back out of the space one request at a time.
   */
  it('ends a sync knowing every title, without reading one header back', async () => {
    const r = rig({ present: ['/DOCUMENTS/Songlengths.md5'] })
    const lib = library(r)
    await lib.init()
    await lib.startUpdate()
    expect(lib.sync.value.state).toBe('done')
    expect(lib.rows.value.map((row) => row.title).sort()).toEqual(['Commando', 'Delta', 'Wizball'])
    expect(lib.rows.value.every((row) => row.released === '1987')).toBe(true)
    expect(r.ops.readHead).not.toHaveBeenCalled()
  })

  /*
   * A tune opened from Files carries the server's id, which is no row's
   * key, so its row stayed dark until it was played again from here.
   */
  it('finds the row of a tune opened from Files by its path', async () => {
    const r = rig({ present: ['/MUSICIANS/H/Hubbard_Rob/Commando.sid', '/DOCUMENTS/Songlengths.md5'] })
    const lib = library(r)
    await lib.init()
    await lib.play(lib.rows.value.find((row) => row.name === 'Commando.sid')!)
    const played = r.play.mock.calls[0][1]
    const fromFiles = { ...played, id: 'storage$space!opaque' } as Resource
    expect(lib.keyOfPlaying(fromFiles)).toBe('hvsc:/MUSICIANS/H/Hubbard_Rob/Commando.sid')
    expect(lib.keyOfPlaying(played)).toBe(played.id)
    expect(lib.keyOfPlaying({ ...fromFiles, path: '/elsewhere/Commando.sid' } as Resource)).toBeNull()
  })

  /*
   * The text of a document whose write failed was built and cached under
   * the checksum of the old file still in the space, and trusted from then on.
   */
  it('builds from the space, not the mirror, where a document could not be written', async () => {
    const r = rig({ present: ['/DOCUMENTS/Songlengths.md5'] })
    const lib = library(r)
    await lib.init()
    await lib.planUpdate()
    const fetch = r.mirror.tune
    const shorter = MANIFEST.split('\n').slice(0, 5).join('\n')
    r.mirror.tune = vi.fn(async (path: string) =>
      path.endsWith('Songlengths.md5') ? bytesOf(shorter) : fetch(path)
    )
    const write = r.ops.write
    r.ops.write = vi.fn(async (path: string, bytes: Uint8Array) => {
      if (path.endsWith('Songlengths.md5')) throw { statusCode: 507 }
      return write(path, bytes)
    })
    // The space still holds the old three-tune file. The unwritten text in
    // hand says two and the mirror's document one, so three can only have
    // come from the space.
    r.ops.read = vi.fn(async (path: string) =>
      path.endsWith('Songlengths.md5') ? bytesOf(MANIFEST) : new Uint8Array(0)
    )
    r.mirror.document = vi.fn(async () => MANIFEST.split('\n').slice(0, 3).join('\n'))
    await lib.startUpdate()
    expect(lib.rows.value).toHaveLength(3)
  })

  it('puts the titles a cancelled run read on the rows there are', async () => {
    const r = rig({ present: ['/DOCUMENTS/Songlengths.md5'] })
    const lib = library(r)
    await lib.init()
    await lib.planUpdate()
    const fetch = r.mirror.tune
    r.mirror.tune = vi.fn(async (path: string) => {
      if (tuneFetches(r) === 1) lib.cancelUpdate()
      return fetch(path)
    })
    await lib.startUpdate()
    expect(lib.sync.value.state).toBe('idle')
    expect(lib.rows.value.filter((row) => row.title).length).toBeGreaterThanOrEqual(1)
  })

  /*
   * The cache was trusted for as long as the release number stood, and the
   * number does not move when the file does: a sync finished from another
   * device, or an archive unpacked over the collection by hand.
   */
  describe('the cached documents', () => {
    const withCache = (r: Rig, cached: Record<string, unknown> | null) =>
      library(r, { cache: fakeCache({ loadDocuments: vi.fn(async () => cached as never) }) })
    const present = ['/MUSICIANS/H/Hubbard_Rob/Commando.sid', '/DOCUMENTS/Songlengths.md5']
    const onDisk = `${md5Hex(served('/DOCUMENTS/Songlengths.md5'))} - -`
    /** One tune, where the space's own copy lists three. */
    const stale = MANIFEST.split('\n').slice(0, 3).join('\n')

    it('are used when they are of the file the space holds now', async () => {
      const r = rig({ present })
      const lib = withCache(r, {
        release: 0,
        songlengths: stale,
        checksums: onDisk,
        stil: null,
        musicians: null
      })
      await lib.init()
      expect(lib.rows.value).toHaveLength(1)
      expect(r.ops.readText).not.toHaveBeenCalledWith('/DOCUMENTS/Songlengths.md5')
    })

    it('are read again when the file has changed under the same release', async () => {
      const r = rig({ present })
      const lib = withCache(r, {
        release: 0,
        songlengths: stale,
        checksums: `${'f'.repeat(32)} - -`,
        stil: null,
        musicians: null
      })
      await lib.init()
      expect(lib.rows.value).toHaveLength(3)
    })

    it('are read again when STIL has changed under the same manifest', async () => {
      const r = rig({ present: [...present, '/DOCUMENTS/STIL.txt'] })
      const lib = withCache(r, {
        release: 0,
        songlengths: stale,
        checksums: onDisk,
        stil: null,
        musicians: null
      })
      await lib.init()
      expect(lib.rows.value).toHaveLength(3)
    })
  })

  /*
   * The first two hundred untitled rows of a listing can all be tunes the
   * space does not have. Asked for again on every visit, they answered 404
   * every time and the rows behind them never had their turn.
   */
  it('does not ask again for a header that is not there, and does for one that only failed', async () => {
    const r = rig({ present: ['/MUSICIANS/H/Hubbard_Rob/Commando.sid', '/DOCUMENTS/Songlengths.md5'] })
    // Delta is not in the space, and says so; Commando is, behind a server
    // that fails the first time it is asked.
    let commandoReads = 0
    const read = r.ops.readHead
    r.ops.readHead = vi.fn(async (path: string, bytes: number) => {
      if (path.endsWith('Delta.sid')) throw { statusCode: 404 }
      if (path.endsWith('Commando.sid') && ++commandoReads === 1) throw { statusCode: 503 }
      return read(path, bytes)
    })
    const lib = library(r)
    await lib.init()
    const asked = (name: string) => vi.mocked(r.ops.readHead).mock.calls.filter(([path]) => path.endsWith(name))
    lib.openFolder('/MUSICIANS/H/Hubbard_Rob')
    await settle()
    expect(asked('Delta.sid').length).toBe(1)
    lib.openFolder('/MUSICIANS/G')
    await settle()
    lib.openFolder('/MUSICIANS/H/Hubbard_Rob')
    await settle()
    expect(asked('Delta.sid')).toHaveLength(1)
    // A failure said nothing about the file, so it is asked for again.
    expect(asked('Commando.sid').length).toBeGreaterThan(1)
    expect(lib.rows.value.find((row) => row.name === 'Commando.sid')?.title).toBe('Commando')
  })

  it('stops asking for a header whose read fails every time', async () => {
    const r = rig({ present: ['/MUSICIANS/H/Hubbard_Rob/Commando.sid', '/DOCUMENTS/Songlengths.md5'] })
    r.ops.readHead = vi.fn(async () => {
      throw { statusCode: 500 }
    })
    const lib = library(r)
    await lib.init()
    const asked = () =>
      vi.mocked(r.ops.readHead).mock.calls.filter(([path]) => path.endsWith('Commando.sid')).length
    for (let i = 0; i < 6; i++) {
      lib.openFolder(i % 2 ? '/MUSICIANS/G' : '/MUSICIANS/H/Hubbard_Rob')
      await settle()
    }
    expect(asked()).toBe(3)
  })

  /*
   * A path the app will not act on is a manifest it does not wholly
   * understand, and the tunes behind such paths look like tunes withdrawn.
   */
  it('proposes no removals from a manifest with paths it will not act on', async () => {
    const r = rig({
      present: [
        '/MUSICIANS/H/Hubbard_Rob/Commando.sid',
        '/MUSICIANS/H/Hubbard_Rob/Old.sid',
        '/DOCUMENTS/Songlengths.md5'
      ]
    })
    const lib = library(r)
    await lib.init()
    await lib.planUpdate()
    expect(lib.sync.value.plan?.remove).toEqual(['/MUSICIANS/H/Hubbard_Rob/Old.sid'])

    r.mirror.document = vi.fn(async () => `${MANIFEST}; /ELSEWHERE/Thing.sid\n${'a'.repeat(32)}=1:00\n`)
    await lib.planUpdate()
    expect(lib.sync.value.plan?.remove).toEqual([])
  })

  /*
   * The panel can be closed during a run and the update offered again; a
   * second run alongside the first fetched and wrote everything twice and
   * then lost track of both.
   */
  it('runs one update at a time', async () => {
    const r = rig({ present: ['/DOCUMENTS/Songlengths.md5'] })
    const lib = library(r)
    await lib.init()
    await lib.planUpdate()
    await Promise.all([lib.startUpdate(), lib.startUpdate(), lib.planUpdate()])
    expect(tuneFetches(r)).toBe(3)
  })

  /*
   * A run whose documents did not arrive has not brought the collection up
   * to the release: its catalogue still comes from the old Songlengths.md5.
   * Claiming the release anyway hid the update banner that would have
   * finished the job.
   */
  it('does not claim the release when the documents could not be fetched', async () => {
    const r = rig({ present: ['/DOCUMENTS/Songlengths.md5'] })
    const fetch = r.mirror.tune
    r.mirror.tune = vi.fn(async (path: string) => {
      if (path.endsWith('Songlengths.md5')) throw new Error('503')
      return fetch(path)
    })
    r.mirror.release = vi.fn(async () => 86)
    const lib = library(r)
    await lib.init()
    await lib.planUpdate()
    await lib.startUpdate()
    expect(statusWrites(r).at(-1)?.release).not.toBe(86)
    expect(lib.sync.value.error).toMatch(/Songlengths\.md5/)
  })

  /*
   * A check that saw a newer release while the run was going was claimed
   * at the end for files that were the older release's, and the banner that
   * would have fetched the newer one never showed.
   */
  it('claims the release the plan was made for, not one seen since', async () => {
    const r = rig({ present: ['/DOCUMENTS/Songlengths.md5'] })
    r.mirror.release = vi.fn(async () => 86)
    const lib = library(r)
    await lib.init()
    await lib.planUpdate()
    const fetch = r.mirror.tune
    r.mirror.tune = vi.fn(async (path: string) => {
      lib.status.value = { ...lib.status.value!, upstream: 87 }
      if (path.endsWith('HVSC.txt')) return bytesOf('Release 86\n')
      if (path.endsWith('Songlengths.md5')) return bytesOf(MANIFEST)
      if (path.startsWith('/DOCUMENTS/')) return bytesOf('text\n')
      return fetch(path)
    })
    await lib.startUpdate()
    expect(statusWrites(r).at(-1)?.release).toBe(86)
  })

  /*
   * A folder listed before the update knew nothing of what the update wrote:
   * its new tunes went on showing as not downloaded, and playing one fetched
   * it from the mirror again, over the copy the sync had just put there.
   */
  it('forgets what folders held once an update has written to them', async () => {
    const r = rig({ present: ['/DOCUMENTS/Songlengths.md5'] })
    const lib = library(r)
    await lib.init()
    lib.openFolder('/MUSICIANS/H/Hubbard_Rob')
    await new Promise((done) => setTimeout(done, 0))
    expect(lib.localBy.value?.get('/MUSICIANS/H/Hubbard_Rob')?.has('/MUSICIANS/H/Hubbard_Rob/Delta.sid')).toBe(
      false
    )
    await lib.planUpdate()
    await lib.startUpdate()
    await new Promise((done) => setTimeout(done, 0))
    const fetched = tuneFetches(r)
    await lib.play(lib.rows.value.find((x) => x.name === 'Delta.sid')!)
    expect(tuneFetches(r)).toBe(fetched)
  })

  /*
   * Approving deletions is a decision about one plan. Carried into the
   * next, a plan proposing thousands of removals opened with them already
   * approved.
   */
  it('asks again about deletions for every new plan', async () => {
    const r = rig({ present: ['/DOCUMENTS/Songlengths.md5'] })
    const lib = library(r)
    await lib.init()
    await lib.planUpdate()
    lib.sync.value.removals = 'approved'
    await lib.planUpdate()
    expect(lib.sync.value.removals).toBe('ask')
  })
})

/*
 * A header is read from the copy on disk and cached under the catalogue's
 * MD5 for that path. Where the server says the copy on disk is a different
 * file - a sync that did not finish, say - what was read belongs to that
 * other file, and is shown but not kept.
 */
describe('remembering headers', () => {
  it('does not keep a header under an MD5 the file on disk is known not to have', async () => {
    const r = rig({ present: ['/DOCUMENTS/Songlengths.md5', '/MUSICIANS/H/Hubbard_Rob/Commando.sid'] })
    const list = r.ops.list
    r.ops.list = vi.fn(async (path: string) => {
      const got = await list(path)
      return { ...got, files: got.files.map((f) => ({ ...f, md5: 'f'.repeat(32) })) }
    })
    const saved: unknown[] = []
    const lib = library(r, {
      cache: fakeCache({
        saveHeaders: vi.fn(async (records: unknown[]) => {
          saved.push(...records)
        })
      })
    })
    await lib.init()
    lib.openFolder('/MUSICIANS/H/Hubbard_Rob')
    for (let i = 0; i < 50 && !lib.rows.value.find((x) => x.name === 'Commando.sid')?.title; i++) {
      await new Promise((done) => setTimeout(done, 5))
    }
    expect(lib.rows.value.find((x) => x.name === 'Commando.sid')?.title).toBe('Commando')
    expect(saved).toEqual([])
  })
})

/*
 * An online collection holds the documents and whatever has been played:
 * the whole release can be browsed and searched, and each tune is fetched
 * the first time it is played. Downloading the rest is a separate choice.
 */
describe('an online collection', () => {
  /** A mirror that serves real documents, so a run can finish and claim its release. */
  const withDocuments = (r: Rig) => {
    const fetch = r.mirror.tune
    r.mirror.release = vi.fn(async () => 86)
    r.mirror.tune = vi.fn(async (path: string) => {
      if (path.endsWith('HVSC.txt')) return bytesOf('Release 86\n')
      if (path.endsWith('Songlengths.md5')) return bytesOf(MANIFEST)
      if (path.startsWith('/DOCUMENTS/')) return bytesOf('text\n')
      return fetch(path)
    })
  }

  it('starts with the documents only, and says it is online', async () => {
    const r = rig({ present: ['/DOCUMENTS/Songlengths.md5'] })
    withDocuments(r)
    const lib = library(r)
    await lib.init()
    await settle()
    await lib.startOnline()
    expect(tuneFetches(r)).toBe(0)
    expect(lastStatus(r)).toMatchObject({ release: 86, mode: 'online' })
    expect(lib.online.value).toBe(true)
    expect(lib.rows.value).toHaveLength(3)
  })

  it('updates what it has, and leaves the rest on the mirror', async () => {
    const r = rig({ present: ['/MUSICIANS/H/Hubbard_Rob/Commando.sid', '/DOCUMENTS/Songlengths.md5'] })
    withDocuments(r)
    const lib = library(r)
    await lib.init()
    await settle()
    await lib.startOnline()
    await lib.planUpdate()
    expect(lib.sync.value.scope).toBe('present')
    // Counted as what the release has beyond the space, and not fetched.
    expect(lib.sync.value.plan?.add).toHaveLength(2)
    await lib.startUpdate()
    expect(tuneFetches(r)).toBe(0)
    expect(lastStatus(r)?.mode).toBe('online')
  })

  it('downloads everything only when asked, and is then a whole collection', async () => {
    const r = rig({ present: ['/DOCUMENTS/Songlengths.md5'] })
    withDocuments(r)
    const lib = library(r)
    await lib.init()
    await settle()
    await lib.startOnline()
    await lib.planUpdate('all')
    expect(tuneFetches(r)).toBe(0)
    await lib.startUpdate()
    expect(tuneFetches(r)).toBe(3)
    expect(lastStatus(r)?.mode).toBeUndefined()
    expect(lib.online.value).toBe(false)
  })

  /*
   * With no release from the mirror's check, the number comes from the
   * HVSC.txt the run fetched - but only when the index beside it is the one
   * the plan was made from, or a release published mid-run would be claimed
   * for the previous one's tunes.
   */
  it('takes its release from the documents when the mirror had not said', async () => {
    const r = rig({ present: ['/DOCUMENTS/Songlengths.md5'] })
    withDocuments(r)
    r.mirror.release = vi.fn(async () => null)
    const lib = library(r)
    await lib.init()
    await settle()
    await lib.startOnline()
    expect(lastStatus(r)).toMatchObject({ release: 86, mode: 'online' })
  })

  it('claims no release when the index changed while it ran', async () => {
    const r = rig({ present: ['/DOCUMENTS/Songlengths.md5'] })
    withDocuments(r)
    r.mirror.release = vi.fn(async () => null)
    const lib = library(r)
    await lib.init()
    await settle()
    await lib.planUpdate('all')
    // A new release lands on the mirror before the documents are fetched.
    const fetch = r.mirror.tune
    r.mirror.tune = vi.fn(async (path: string) => {
      if (path.endsWith('Songlengths.md5'))
        return bytesOf(`${MANIFEST}; /MUSICIANS/N/New/Tune.sid\n${'b'.repeat(32)}=1:00\n`)
      if (path.endsWith('HVSC.txt')) return bytesOf('Release 87\n')
      return fetch(path)
    })
    await lib.startUpdate()
    expect(lastStatus(r)?.release).toBeNull()
  })

  /*
   * The run that claims nothing still writes the new release's HVSC.txt,
   * and the next load used to read the release back from it - the very
   * number the run had declined to claim.
   */
  it('does not read a release back from documents a run declined to claim', async () => {
    const r = rig({ present: ['/DOCUMENTS/Songlengths.md5'] })
    withDocuments(r)
    r.mirror.release = vi.fn(async () => null)
    const first = library(r)
    await first.init()
    await settle()
    await first.planUpdate('all')
    const fetch = r.mirror.tune
    r.mirror.tune = vi.fn(async (path: string) => {
      if (path.endsWith('Songlengths.md5'))
        return bytesOf(`${MANIFEST}; /MUSICIANS/N/New/Tune.sid\n${'b'.repeat(32)}=1:00\n`)
      if (path.endsWith('HVSC.txt')) return bytesOf('Release 87\n')
      return fetch(path)
    })
    await first.startUpdate()
    expect(lastStatus(r)).toMatchObject({ release: null, unfinished: true })
    // Opened again over what the run left: its status, and the HVSC.txt it wrote.
    const saved = JSON.stringify(lastStatus(r))
    const readText = r.ops.readText
    r.ops.readText = vi.fn(async (path: string) => (path.endsWith('status.json') ? saved : readText(path)))
    r.ops.read = vi.fn(async (path: string) =>
      path.endsWith('HVSC.txt') ? bytesOf('Release 87\n') : new Uint8Array(0)
    )
    r.mirror.release = vi.fn(async () => 87)
    const again = library(r)
    await again.init()
    expect(again.release.value).toBeNull()
  })

  /*
   * The index is compared as the mirror client decodes it, in one form on
   * both sides: its decoder is windows-1252, so bytes 0x80-0x9f do not come
   * back from text as they went in, and a raw hash at one end never matched
   * a re-encoded one at the other.
   */
  it('recognises its own index when it holds bytes the decoder remaps', async () => {
    const r = rig({ present: ['/DOCUMENTS/Songlengths.md5'] })
    withDocuments(r)
    r.mirror.release = vi.fn(async () => null)
    const raw = new Uint8Array([...bytesOf(MANIFEST), 0x3b, 0x20, 0x80, 0x0a])
    r.mirror.document = vi.fn(async () => decodeLatin1(raw))
    const fetch = r.mirror.tune
    r.mirror.tune = vi.fn(async (path: string) => (path.endsWith('Songlengths.md5') ? raw : fetch(path)))
    const lib = library(r)
    await lib.init()
    await settle()
    await lib.planUpdate('all')
    await lib.startUpdate()
    expect(lastStatus(r)?.release).toBe(86)
  })

  /*
   * A run with no tunes in it never reported progress, so the panel could
   * not tell it apart from one about to start, and offered Pause and Stop
   * for the whole of it.
   */
  it('reports a count of nothing for a run of documents alone', async () => {
    const r = rig({ present: ['/DOCUMENTS/Songlengths.md5'] })
    withDocuments(r)
    const lib = library(r)
    await lib.init()
    await settle()
    let during: unknown = undefined
    const fetch = r.mirror.tune
    r.mirror.tune = vi.fn(async (path: string) => {
      if (path.endsWith('HVSC.txt')) during = lib.sync.value.progress?.total
      return fetch(path)
    })
    await lib.startOnline()
    expect(during).toBe(0)
  })

  /*
   * A run reported nothing until its first file had finished, so the panel
   * had no count to show and no reason to offer Pause or Stop yet.
   */
  it('reports what a run will do before its first file has finished', async () => {
    const r = rig({ present: ['/DOCUMENTS/Songlengths.md5'] })
    withDocuments(r)
    const lib = library(r)
    await lib.init()
    await settle()
    await lib.planUpdate('all')
    let first: { done: number; total: number } | null | undefined = undefined
    const fetch = r.mirror.tune
    r.mirror.tune = vi.fn(async (path: string) => {
      if (first === undefined && path.endsWith('.sid')) first = lib.sync.value.progress
      return fetch(path)
    })
    await lib.startUpdate()
    expect(first).toMatchObject({ done: 0, total: 3 })
  })

  it('starts on a plan that only warns, and stays online', async () => {
    const r = rig({ present: ['/DOCUMENTS/Songlengths.md5'] })
    withDocuments(r)
    r.mirror.document = vi.fn(async () => `${MANIFEST}; /ELSEWHERE/Thing.sid\n${'a'.repeat(32)}=1:00\n`)
    const lib = library(r)
    await lib.init()
    await settle()
    await lib.startOnline()
    expect(lastStatus(r)?.mode).toBe('online')
    expect(lib.online.value).toBe(true)
    // Finished, and the warning still there to read beside it.
    expect(lib.sync.value.error).toBeNull()
    expect(lib.sync.value.notice).toMatch(/will not write to/)
  })

  /*
   * An online start that was stopped left the mode in memory on the
   * first-run screen, and a full download chosen after it, not finishing,
   * was then recorded as online - so no later update fetched the rest.
   */
  it('records a full download chosen on the first-run screen as full, whatever was tried first', async () => {
    const r = rig({ present: ['/DOCUMENTS/Songlengths.md5'] })
    withDocuments(r)
    const lib = library(r)
    await lib.init()
    await settle()
    lib.phase.value = 'first-run'
    lib.status.value = { ...lib.status.value!, mode: 'online' }
    const fetch = r.mirror.tune
    r.mirror.tune = vi.fn(async (path: string) => {
      if (path.endsWith('Delta.sid')) throw new Error('503')
      return fetch(path)
    })
    await lib.planUpdate('all')
    await lib.startUpdate()
    expect(lastStatus(r)?.mode).toBeUndefined()
    expect(lib.sync.value.error).toMatch(/Run the update again/)
  })

  it('is not online after all when it could not plan', async () => {
    const r = rig({ present: ['/DOCUMENTS/Songlengths.md5'] })
    withDocuments(r)
    r.mirror.document = vi.fn(async () => {
      throw new Error('503')
    })
    const lib = library(r)
    await lib.init()
    await settle()
    await lib.startOnline()
    expect(lib.online.value).toBe(false)
    expect(lib.sync.value.plan).toBeNull()
  })

  /*
   * A failed re-plan left the previous plan on offer under the new scope:
   * a paused download, started again, was labelled and recorded as an
   * update of what was there.
   */
  it('drops the last plan when a new one cannot be made', async () => {
    const r = rig({ present: ['/DOCUMENTS/Songlengths.md5'] })
    withDocuments(r)
    const lib = library(r)
    await lib.init()
    await settle()
    await lib.startOnline()
    expect(await lib.planUpdate('all')).toBe(true)
    r.mirror.document = vi.fn(async () => {
      throw new Error('503')
    })
    expect(await lib.planUpdate()).toBe(false)
    expect(lib.sync.value.plan).toBeNull()
  })

  it('stays online when a download of everything does not finish, and says how to finish it', async () => {
    const r = rig({ present: ['/DOCUMENTS/Songlengths.md5'] })
    withDocuments(r)
    const lib = library(r)
    await lib.init()
    await settle()
    await lib.startOnline()
    const fetch = r.mirror.tune
    r.mirror.tune = vi.fn(async (path: string) => {
      if (path.endsWith('Delta.sid')) throw new Error('503')
      return fetch(path)
    })
    await lib.planUpdate('all')
    await lib.startUpdate()
    expect(lastStatus(r)?.mode).toBe('online')
    expect(lib.sync.value.error).toMatch(/Download all/)
  })

  it('reads the header of a tune its folder listing shows', async () => {
    const r = rig({ present: ['/MUSICIANS/H/Hubbard_Rob/Commando.sid', '/DOCUMENTS/Songlengths.md5'] })
    withDocuments(r)
    const lib = library(r)
    await lib.init()
    await settle()
    await lib.startOnline()
    vi.mocked(r.ops.readHead).mockClear()
    lib.openFolder('/MUSICIANS/H/Hubbard_Rob')
    await settle()
    const asked = vi.mocked(r.ops.readHead).mock.calls.map(([path]) => path)
    expect(asked).toEqual(['/MUSICIANS/H/Hubbard_Rob/Commando.sid'])
  })

  it('does not ask the space for headers of tunes its listing does not show', async () => {
    const r = rig({ present: ['/DOCUMENTS/Songlengths.md5'] })
    withDocuments(r)
    const lib = library(r)
    await lib.init()
    await settle()
    await lib.startOnline()
    vi.mocked(r.ops.readHead).mockClear()
    lib.openFolder('/MUSICIANS/H/Hubbard_Rob')
    await settle()
    lib.search('hubbard')
    await settle()
    expect(r.ops.readHead).not.toHaveBeenCalled()
  })
})
