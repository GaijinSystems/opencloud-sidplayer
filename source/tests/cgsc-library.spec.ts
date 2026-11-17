import { describe, it, expect, vi } from 'vitest'
import type { Resource, SpaceResource } from '@opencloud-eu/web-client'
import { createLibrary, type Library } from '../src/library/useLibrary'
import { readConfig } from '../src/config'
import { CGSC_INDEX_FILE } from '../src/cgsc/load'
import type { SpaceFile, SpaceOps } from '../src/hvsc/space'
import type { MirrorOps } from '../src/hvsc/mirror'
import type { WebDav } from '../src/sid/source'
import { assembleMus } from '../src/sid/mus'
import { musLength } from '../src/sid/musLength'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { DocumentCache, MusRecord } from '../src/hvsc/store'
import { fakeSpaceOps } from './helpers/fakes'

/**
 * The second collection inside the library: how it is read, where it appears
 * and what it deliberately does not do.
 *
 * The HVSC side is stubbed down to the smallest collection that opens, since
 * none of what is tested here depends on it - except the one thing that
 * does, which is that a search reaches both and keeps them apart.
 */

const MANIFEST = `[Database]
; /MUSICIANS/H/Hubbard_Rob/Commando.sid
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1=3:58
; /MUSICIANS/G/Galway_Martin/Wizball.sid
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3=4:22
`

const CGSC_FILES = [
  '/00_Documents/MUS_format_B.txt',
  '/Dave_Marquis/Bolero.mus',
  '/Dave_Marquis/Bolero.pic',
  '/Dave_Marquis/Four_Seasons/Spring.mus',
  '/Dave_Marquis/Four_Seasons/Spring.str',
  '/Misc/Anon/Greensleeves.mus',
  '/Sandy_C/Commando_March.mus'
]

/** A space with no tune in it to read: a header asked for is a 404. */
const emptySpace = (overrides: Partial<SpaceOps>): SpaceOps =>
  fakeSpaceOps({
    readHead: vi.fn(async () => {
      throw new Error('404')
    }),
    ...overrides
  })

/** A space holding exactly these files, listable folder by folder. */
function fakeSpace(
  paths: string[],
  options: { index?: boolean; md5?: (path: string) => string | null } = {}
): SpaceOps {
  return emptySpace({
    list: vi.fn(async (path: string) => {
      const base = path === '/' ? '' : path.replace(/\/+$/, '')
      const folders = new Set<string>()
      const files: SpaceFile[] = []
      for (const p of paths) {
        if (!p.startsWith(`${base}/`)) continue
        const rest = p.slice(base.length + 1)
        const slash = rest.indexOf('/')
        if (slash < 0) files.push({ path: p, md5: options.md5?.(p) ?? null, size: 1 })
        else folders.add(`${base}/${rest.slice(0, slash)}`)
      }
      return { folders: [...folders], files }
    }),
    readText: vi.fn(async (path: string) =>
      options.index && path === `/${CGSC_INDEX_FILE}` ? paths.map((p) => p.slice(1)).join('\n') : null
    )
  })
}

/** The smallest HVSC collection that opens. */
function hvscSpace(): SpaceOps {
  return emptySpace({
    list: vi.fn(async (path: string) =>
      path === '/' ? { folders: ['/MUSICIANS', '/DOCUMENTS'], files: [] } : { folders: [], files: [] }
    ),
    readText: vi.fn(async (path: string) => (path.endsWith('Songlengths.md5') ? MANIFEST : null))
  })
}

const mirror = (): MirrorOps => ({
  release: vi.fn(async () => 85),
  document: vi.fn(async () => MANIFEST),
  tune: vi.fn(async () => new Uint8Array(128)),
  reachable: vi.fn(async () => true)
})

interface Rig {
  lib: Library
  play: ReturnType<typeof vi.fn<(space: SpaceResource, resource: Resource) => void>>
  mirror: MirrorOps
  cgscOps: SpaceOps
}

function rig(cgscOps: SpaceOps, cache?: DocumentCache): Rig {
  const play = vi.fn<(space: SpaceResource, resource: Resource) => void>()
  const m = mirror()
  const lib = createLibrary({
    webdav: {} as WebDav,
    space: {} as SpaceResource,
    config: readConfig({}),
    play,
    ops: hvscSpace(),
    cgscOps,
    mirror: m,
    cache
  })
  return { lib, play, mirror: m, cgscOps }
}

/**
 * The second collection is read after the library is up and not awaited, so
 * that someone who only has HVSC never waits on a folder that is not there.
 * Tests have to wait for it explicitly.
 */
async function settled(lib: Library): Promise<void> {
  for (let i = 0; i < 400 && lib.cgsc.loading.value; i++) {
    await new Promise((done) => setTimeout(done, 5))
  }
}

const open = async (ops: SpaceOps, cache?: DocumentCache): Promise<Rig> => {
  const r = rig(ops, cache)
  await r.lib.init()
  await settled(r.lib)
  return r
}

describe('reading the collection', () => {
  it('takes the index file when there is one, and lists no folders at all', async () => {
    const ops = fakeSpace(CGSC_FILES, { index: true })
    const { lib } = await open(ops)
    expect(lib.cgsc.source.value).toBe('index')
    expect(lib.cgsc.rows.value.map((r) => r.name)).toEqual([
      'Bolero.mus',
      'Spring.mus',
      'Greensleeves.mus',
      'Commando_March.mus'
    ])
    expect(ops.list).not.toHaveBeenCalled()
  })

  it('walks the folders when there is no index', async () => {
    const ops = fakeSpace(CGSC_FILES)
    const { lib } = await open(ops)
    expect(lib.cgsc.source.value).toBe('walk')
    expect(lib.cgsc.rows.value).toHaveLength(4)
    expect(ops.list).toHaveBeenCalled()
  })

  it('arrives at the same catalogue either way', async () => {
    const withIndex = await open(fakeSpace(CGSC_FILES, { index: true }))
    const walked = await open(fakeSpace(CGSC_FILES))
    expect(walked.lib.cgsc.rows.value.map((r) => r.path).sort()).toEqual(
      withIndex.lib.cgsc.rows.value.map((r) => r.path).sort()
    )
  })

  it('leaves the section out entirely when the folder is not there', async () => {
    const { lib } = await open(fakeSpace([]))
    expect(lib.cgsc.source.value).toBeNull()
    expect(lib.cgsc.tree.value).toBeNull()
    expect(lib.cgsc.rows.value).toEqual([])
  })

  it('does not hold up the library it sits beside', async () => {
    const r = rig(fakeSpace(CGSC_FILES, { index: true }))
    await r.lib.init()
    // Ready before the second collection has been read at all.
    expect(r.lib.phase.value).toBe('ready')
    expect(r.lib.cgsc.rows.value).toEqual([])
    await settled(r.lib)
    expect(r.lib.cgsc.rows.value).toHaveLength(4)
  })

  it('files the composers into groups in a tree of its own', async () => {
    const { lib } = await open(fakeSpace(CGSC_FILES, { index: true }))
    const groups = lib.cgsc.tree.value?.children ?? []
    expect(groups.map((g) => g.name)).toEqual(['D', 'M', 'S'])
    expect(groups.every((g) => g.group)).toBe(true)
    expect(lib.cgsc.folders.value).toBe(3)
    // The HVSC tree is untouched by any of it.
    expect(lib.tree.value?.children.map((c) => c.name)).toEqual(['MUSICIANS'])
  })
})

describe('browsing it', () => {
  it('lists a composer folder and everything under it', async () => {
    const { lib } = await open(fakeSpace(CGSC_FILES, { index: true }))
    lib.openFolder('/Dave_Marquis', 'cgsc')
    expect(lib.collection.value).toBe('cgsc')
    expect(lib.visible.value.map((r) => r.name)).toEqual(['Bolero.mus', 'Spring.mus'])
    lib.openFolder('/Dave_Marquis/Four_Seasons', 'cgsc')
    expect(lib.visible.value.map((r) => r.name)).toEqual(['Spring.mus'])
  })

  it('goes back to the first collection when a folder there is opened', async () => {
    const { lib } = await open(fakeSpace(CGSC_FILES, { index: true }))
    lib.openFolder('/Dave_Marquis', 'cgsc')
    lib.openFolder('/MUSICIANS')
    expect(lib.collection.value).toBe('hvsc')
    expect(lib.visible.value.map((r) => r.name)).toContain('Commando.sid')
  })

  /*
   * Nothing mirrors this collection, so "not downloaded, plays on demand" is
   * a promise the library cannot keep. Claiming nothing is the honest
   * alternative, and it is also one listing per folder saved.
   */
  it('claims nothing about which of its tunes are present', async () => {
    const ops = fakeSpace(CGSC_FILES, { index: true })
    const { lib } = await open(ops)
    ;(ops.list as ReturnType<typeof vi.fn>).mockClear()
    lib.openFolder('/Dave_Marquis', 'cgsc')
    await new Promise((done) => setTimeout(done, 0))
    expect(lib.localBy.value).toBeNull()
    expect(ops.list).not.toHaveBeenCalled()
  })

  it('plays one out of its own folder, without asking any mirror', async () => {
    const { lib, play, mirror: m } = await open(fakeSpace(CGSC_FILES, { index: true }))
    const row = lib.cgsc.rows.value.find((r) => r.name === 'Bolero.mus')!
    await lib.play(row)
    expect(m.tune).not.toHaveBeenCalled()
    expect(play).toHaveBeenCalledTimes(1)
    const resource = play.mock.calls[0][1] as unknown as { path: string; id: string }
    expect(resource.path).toBe('/SID Library/CGSC/Dave_Marquis/Bolero.mus')
    expect(resource.id).toBe('cgsc:/Dave_Marquis/Bolero.mus')
  })
})

describe('searching both', () => {
  it('keeps each collection to its own block', async () => {
    const { lib } = await open(fakeSpace(CGSC_FILES, { index: true }))
    lib.search('commando')
    expect(lib.blocks.value.map((b) => b.key)).toEqual(['hvsc', 'cgsc'])
    expect(lib.blocks.value[0].rows.map((r) => r.name)).toEqual(['Commando.sid'])
    expect(lib.blocks.value[1].rows.map((r) => r.name)).toEqual(['Commando_March.mus'])
    // And `visible` is the two of them, first collection first.
    expect(lib.visible.value.map((r) => r.name)).toEqual(['Commando.sid', 'Commando_March.mus'])
  })

  /*
   * Rows from this collection carry no MD5, and the duplicate folding in the
   * search index keys on one. Without a guard the whole result set collapsed
   * into its first hit.
   */
  it('does not fold its results together for want of an MD5', async () => {
    const { lib } = await open(fakeSpace(CGSC_FILES, { index: true }))
    // A filter with no terms, so every row in the collection is a candidate
    // and any folding would show at once.
    lib.search('songs:1')
    const cgsc = lib.blocks.value.find((b) => b.key === 'cgsc')
    expect(cgsc?.rows.map((r) => r.name)).toEqual([
      'Bolero.mus',
      'Spring.mus',
      'Greensleeves.mus',
      'Commando_March.mus'
    ])
  })

  it('leaves the blocks alone when only the first collection answers', async () => {
    const { lib } = await open(fakeSpace(CGSC_FILES, { index: true }))
    lib.search('wizball')
    expect(lib.blocks.value.map((b) => b.key)).toEqual(['only'])
    expect(lib.visible.value.map((r) => r.name)).toEqual(['Wizball.sid'])
  })

  /*
   * The point of keeping an empty block: `year:` cannot be put to a
   * collection catalogued from file names, and silence reads like an answer.
   */
  it('keeps an empty block for a filter the collection cannot answer', async () => {
    const { lib } = await open(fakeSpace(CGSC_FILES, { index: true }))
    lib.search('commando year:1985')
    expect(lib.unanswerable.value).toEqual(['year'])
    const cgsc = lib.blocks.value.find((b) => b.key === 'cgsc')
    expect(cgsc).toBeDefined()
    expect(cgsc?.rows).toEqual([])
  })

  it('names every filter in the query that cannot reach it', async () => {
    const { lib } = await open(fakeSpace(CGSC_FILES, { index: true }))
    lib.search('a year:1985 chip:6581 clock:pal stil:cover')
    expect(lib.unanswerable.value).toEqual(['year', 'chip', 'clock', 'stil'])
  })

  /*
   * `songs:` is not among them. A MUS file is one score with no subsongs, so
   * a row from here answers it with 1 and means it.
   */
  it('counts subsongs honestly rather than calling the question unanswerable', async () => {
    const { lib } = await open(fakeSpace(CGSC_FILES, { index: true }))
    lib.search('commando songs:1')
    expect(lib.unanswerable.value).toEqual([])
    expect(lib.blocks.value.find((b) => b.key === 'cgsc')?.rows).toHaveLength(1)

    lib.search('commando songs:>1')
    expect(lib.blocks.value.find((b) => b.key === 'cgsc')?.rows ?? []).toHaveLength(0)
  })

  /*
   * "This folder only" names a folder in one collection, so it is also a
   * statement about which collection to search.
   */
  it('searches only the collection the folder is in when scoped to one', async () => {
    const { lib } = await open(fakeSpace(CGSC_FILES, { index: true }))
    lib.openFolder('/Dave_Marquis', 'cgsc')
    lib.scopeToFolder.value = true
    lib.search('songs:1')
    expect(lib.blocks.value.map((b) => b.key)).toEqual(['only'])
    expect(lib.visible.value.map((r) => r.name)).toEqual(['Bolero.mus', 'Spring.mus'])

    lib.openFolder('/MUSICIANS')
    lib.scopeToFolder.value = true
    lib.search('songs:1')
    expect(lib.blocks.value.map((b) => b.key)).toEqual(['only'])
    expect(lib.visible.value.every((r) => r.collection !== 'cgsc')).toBe(true)
  })

  it('says nothing at all when there is no second collection to speak for', async () => {
    const { lib } = await open(fakeSpace([]))
    lib.search('commando year:1985')
    expect(lib.unanswerable.value).toEqual([])
    expect(lib.blocks.value.map((b) => b.key)).toEqual(['only'])
  })

  /*
   * A sort is over one list or the other, never over the two run together:
   * they are separate lists that happen to be drawn one above the other.
   */
  it('sorts within a block rather than across the pair', async () => {
    const { lib } = await open(fakeSpace(CGSC_FILES, { index: true }))
    lib.search('songs:1')
    lib.toggleSort('title')
    const [first, second] = lib.blocks.value
    expect(first.key).toBe('hvsc')
    expect(second.key).toBe('cgsc')
    expect(first.rows.map((r) => r.stem)).toEqual(['Commando', 'Wizball'])
    expect(second.rows.map((r) => r.stem)).toEqual(['Bolero', 'Commando March', 'Greensleeves', 'Spring'])
    // Run together they would interleave; kept apart they do not.
    expect(lib.visible.value.map((r) => r.stem)).toEqual([
      'Commando',
      'Wizball',
      'Bolero',
      'Commando March',
      'Greensleeves',
      'Spring'
    ])
  })
})

/**
 * Starring a Compute's tune.
 *
 * A star means nothing to HVSC - it records no such thing anywhere - so the
 * rules are the app's own, and there is no reason a tune from the second
 * collection cannot have one. It keeps only its path, that collection having
 * no MD5 to be robust with, which is a fair price for being able to keep it.
 */
describe('starring across both collections', () => {
  it('stars a tune and shows it in the favourites view', async () => {
    const { lib } = await open(fakeSpace(CGSC_FILES, { index: true }))
    const row = lib.cgsc.rows.value.find((r) => r.name === 'Bolero.mus')!

    expect(lib.isStarred(row)).toBe(false)
    await lib.toggleStar(row)
    expect(lib.isStarred(row)).toBe(true)

    // The list that exists to show it must actually find it: it lives in the
    // Compute's catalogue, and the favourites view used to search only HVSC's.
    lib.mode.value = 'favourites'
    expect(lib.visible.value.map((r) => r.path)).toEqual([row.path])
    expect(lib.visible.value[0].collection).toBe('cgsc')
  })

  it('keeps the two collections apart, even at the same path', async () => {
    const { lib } = await open(fakeSpace(CGSC_FILES, { index: true }))
    const cgsc = lib.cgsc.rows.value[0]
    // A tune of the same path in the other collection is a different tune.
    const twin = { ...cgsc, collection: undefined }

    await lib.toggleStar(cgsc)
    expect(lib.isStarred(cgsc)).toBe(true)
    expect(lib.isStarred(twin)).toBe(false)
  })

  it('unstars the one asked for and leaves the other alone', async () => {
    const { lib } = await open(fakeSpace(CGSC_FILES, { index: true }))
    const [first, second] = lib.cgsc.rows.value
    await lib.toggleStar(first)
    await lib.toggleStar(second)
    await lib.toggleStar(first)

    expect(lib.isStarred(first)).toBe(false)
    expect(lib.isStarred(second)).toBe(true)
    lib.mode.value = 'favourites'
    expect(lib.visible.value.map((r) => r.path)).toEqual([second.path])
  })

  it('writes the collection down, so a reload knows which archive it meant', async () => {
    const { lib } = await open(fakeSpace(CGSC_FILES, { index: true }))
    const row = lib.cgsc.rows.value[0]
    await lib.toggleStar(row)
    const stored = lib.favourites.value.items[0]
    expect(stored).toMatchObject({ path: row.path, collection: 'cgsc' })
    // And no MD5 invented for a collection that records none.
    expect(stored.md5).toBe('')
  })
})

/* ---- a selected tune's own file, for the two blocks below ---------------- */

const score = new Uint8Array(readFileSync(join(__dirname, 'fixtures/tune.mus')))
/** A space whose tunes all read as the fixture score. */
const scores = (options: Parameters<typeof fakeSpace>[1] = { index: true }, files = CGSC_FILES): SpaceOps => {
  const ops = fakeSpace(files, options)
  ops.readHead = vi.fn(async (path: string) => {
    if (path.endsWith('.mus')) return score.slice()
    throw new Error('404')
  })
  return ops
}
const row = (lib: Library, name: string) => lib.cgsc.rows.value.find((r) => r.name === name)!
/** Until the selected tune's details have arrived, which is a read away. */
const read = async (lib: Library) => {
  for (let i = 0; i < 100 && !lib.selectedMus.value; i++) await new Promise((done) => setTimeout(done, 5))
}

/**
 * What a tune says about itself. The collection documents nothing, so the
 * credits and the length come out of the selected tune's own file - read
 * when it is selected and not before, and only once.
 */
describe("a selected tune's own details", () => {
  // TEM 240 makes a quarter note one second; one quarter note, then HLT.
  const voice = (...bytes: number[]) => [...bytes, 0x01, 0x4f]
  const [v1, v2, v3] = [voice(0x06, 240, 0x10, 0x99), voice(), voice()]
  const oneSecond = Uint8Array.from([
    ...[0x00, 0x09, v1.length, 0, v2.length, 0, v3.length, 0],
    ...v1,
    ...v2,
    ...v3,
    0x00
  ])

  it('reads nothing until a tune is selected', async () => {
    const { cgscOps } = await open(scores())
    expect(cgscOps.readHead).not.toHaveBeenCalled()
  })

  it('reads the credits the file carries', async () => {
    const { lib } = await open(scores())
    lib.select(row(lib, 'Bolero.mus'))
    await read(lib)
    const [title, author, released] = assembleMus(score).credits
    expect(lib.selectedMus.value).toMatchObject({ format: 'MUS', title, author, released })
    expect(title).toBeTruthy()
  })

  it('works out the length from the score', async () => {
    const ops = scores()
    ops.readHead = vi.fn(async (path: string) =>
      path.endsWith('Greensleeves.mus') ? oneSecond : score.slice()
    )
    const { lib } = await open(ops)
    lib.select(row(lib, 'Greensleeves.mus'))
    await read(lib)
    expect(lib.selectedMus.value?.length).toBeCloseTo(1, 6)
  })

  it('calls a score with no timed notes unknown rather than 0:00', async () => {
    const { lib } = await open(scores())
    lib.select(row(lib, 'Bolero.mus'))
    await read(lib)
    expect(musLength(score)).toBe(0)
    expect(lib.selectedMus.value?.length).toBeNull()
  })

  it('says MUS+STR where a .str sits beside the tune', async () => {
    const { lib } = await open(scores())
    lib.select(row(lib, 'Spring.mus'))
    await read(lib)
    expect(lib.selectedMus.value?.format).toBe('MUS+STR')
  })

  it('reads a tune once, however often it is selected', async () => {
    const { lib, cgscOps } = await open(scores())
    const bolero = row(lib, 'Bolero.mus')
    lib.select(bolero)
    await read(lib)
    lib.select(row(lib, 'Greensleeves.mus'))
    await read(lib)
    lib.select(bolero)
    expect(lib.selectedMus.value?.format).toBe('MUS')
    expect(cgscOps.readHead).toHaveBeenCalledTimes(2)
  })

  /*
   * A file named .mus can be anything, of any size, and this read happens on
   * merely selecting it: no more is read than the player would take.
   */
  it('reads no more than a tune can be, and makes nothing of a file larger than that', async () => {
    const ops = scores()
    ops.readHead = vi.fn(async (_path: string, bytes: number) => new Uint8Array(bytes))
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const { lib } = await open(ops)
    lib.select(row(lib, 'Bolero.mus'))
    await new Promise((done) => setTimeout(done, 20))
    expect((ops.readHead as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe(1024 * 1024 + 1)
    expect(lib.selectedMus.value).toBeNull()
  })

  it('has nothing to say about an HVSC tune, and reads nothing for one', async () => {
    const { lib, cgscOps } = await open(scores())
    lib.select(lib.rows.value[0])
    await new Promise((done) => setTimeout(done, 20))
    expect(lib.selectedMus.value).toBeNull()
    expect(cgscOps.readHead).not.toHaveBeenCalled()
  })

  it('keeps no answer from a read that failed, so the next selection tries again', async () => {
    const ops = scores()
    let fail = true
    ops.readHead = vi.fn(async () => {
      if (fail) throw new Error('500')
      return score.slice()
    })
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const { lib } = await open(ops)
    const bolero = row(lib, 'Bolero.mus')
    lib.select(bolero)
    await new Promise((done) => setTimeout(done, 20))
    expect(lib.selectedMus.value).toBeNull()
    fail = false
    lib.select(null)
    lib.select(bolero)
    await read(lib)
    expect(lib.selectedMus.value?.format).toBe('MUS')
  })
})

/**
 * The same details, kept in the browser between visits. A stand-in for
 * IndexedDB, which the test environment does not have: what matters here is
 * what the library asks it and when, not how the database stores it.
 */
describe("a selected tune's details, kept between visits", () => {
  const md5 = createHash('md5').update(score).digest('hex')
  const memoryCache = () => {
    const mus = new Map<string, MusRecord>()
    const cache = {
      loadDocuments: vi.fn(async () => null),
      saveDocuments: vi.fn(async () => {}),
      loadHeaders: vi.fn(async () => new Map()),
      saveHeaders: vi.fn(async () => {}),
      loadMus: vi.fn(async (path: string) => mus.get(path) ?? null),
      saveMus: vi.fn(async (record: MusRecord) => {
        mus.set(record.path, record)
      })
    } satisfies DocumentCache
    return { cache, mus }
  }

  it("works out the file's MD5 from the bytes it read", async () => {
    const { lib } = await open(scores(), memoryCache().cache)
    lib.select(row(lib, 'Bolero.mus'))
    await read(lib)
    expect(lib.selectedMus.value?.md5).toBe(md5)
  })

  it('stores what it read, and a later visit takes it from there without reading the file', async () => {
    const { cache, mus } = memoryCache()
    const first = await open(scores(), cache)
    first.lib.select(row(first.lib, 'Bolero.mus'))
    await read(first.lib)
    expect(mus.get('/Dave_Marquis/Bolero.mus')).toMatchObject({
      path: '/Dave_Marquis/Bolero.mus',
      md5,
      stereo: false
    })

    const later = await open(scores(), cache)
    later.lib.select(row(later.lib, 'Bolero.mus'))
    await read(later.lib)
    expect(later.lib.selectedMus.value).toEqual(first.lib.selectedMus.value)
    expect(later.cgscOps.readHead).not.toHaveBeenCalled()
  })

  it('believes a stored copy the server agrees with', async () => {
    const { cache } = memoryCache()
    const walked = { md5: () => md5 }
    const first = await open(scores(walked), cache)
    first.lib.select(row(first.lib, 'Bolero.mus'))
    await read(first.lib)
    expect(first.lib.cgsc.source.value).toBe('walk')

    const later = await open(scores(walked), cache)
    later.lib.select(row(later.lib, 'Bolero.mus'))
    await read(later.lib)
    expect(later.cgscOps.readHead).not.toHaveBeenCalled()
  })

  it('reads the file again when the server says it has changed since', async () => {
    const { cache, mus } = memoryCache()
    mus.set('/Dave_Marquis/Bolero.mus', {
      path: '/Dave_Marquis/Bolero.mus',
      stereo: false,
      title: 'OLD',
      length: 1,
      md5: 'f'.repeat(32)
    })
    const { lib, cgscOps } = await open(scores({ md5: () => md5 }), cache)
    lib.select(row(lib, 'Bolero.mus'))
    await read(lib)
    expect(cgscOps.readHead).toHaveBeenCalledTimes(1)
    expect(lib.selectedMus.value?.title).not.toBe('OLD')
    expect(mus.get('/Dave_Marquis/Bolero.mus')?.md5).toBe(md5)
  })

  it('follows a .str that has arrived since the details were stored', async () => {
    const { cache, mus } = memoryCache()
    mus.set('/Dave_Marquis/Bolero.mus', { path: '/Dave_Marquis/Bolero.mus', stereo: false, length: null, md5 })
    const { lib, cgscOps } = await open(
      scores({ index: true }, [...CGSC_FILES, '/Dave_Marquis/Bolero.str']),
      cache
    )
    lib.select(row(lib, 'Bolero.mus'))
    await read(lib)
    expect(lib.selectedMus.value?.format).toBe('MUS+STR')
    expect(cgscOps.readHead).not.toHaveBeenCalled()
  })

  it('stores nothing from a read that failed', async () => {
    const { cache, mus } = memoryCache()
    const ops = scores()
    ops.readHead = vi.fn(async () => {
      throw new Error('500')
    })
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const { lib } = await open(ops, cache)
    lib.select(row(lib, 'Bolero.mus'))
    await new Promise((done) => setTimeout(done, 20))
    expect(mus.size).toBe(0)
  })
})
