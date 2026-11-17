import { describe, it, expect, vi } from 'vitest'
import type { Resource, SpaceResource } from '@opencloud-eu/web-client'
import { openTune } from '../src/sid/openTune'
import type { WebDav } from '../src/sid/source'
import { SidPlayerError } from '../src/sid/types'
import { mus, sidFile } from './helpers/bytes'
import { resourceAt } from './helpers/fakes'

/**
 * Opening a file, from the click to the bytes the engine is handed.
 *
 * The cases that matter are the ones where the clicked file is not the tune:
 * a Sidplayer tune is up to four files sharing a base name and any of them
 * may be what the user opened.
 */

/** A MUS file whose three voices are a tempo, one whole note and HLT. */
const makeMus = (credits: string[]): Uint8Array => {
  const body = [0x06, 0xf0, 0x08, 0x99]
  return mus(credits, [body, body, body])
}

/** A PSID with a name and no routines to speak of: three empty bytes after the header. */
const makeSid = (name: string): Uint8Array => sidFile({ initAddress: 0, name, data: [0, 0, 0] })

/** A Koala bitmap, packed the way the add-on packs them. */
const picture = Uint8Array.from([
  0x00,
  0x60,
  ...new Array(39).fill([0xfe, 0x00, 0x00]).flat(),
  ...new Array(10001 - 39 * 256).fill(0)
])

const resource = (path: string): Resource => resourceAt(path, { type: 'file', size: 0 })

const space = {} as SpaceResource

/**
 * A WebDAV client over a path -> bytes map, which also records how many reads
 * were in flight at once so the companion fetches can be shown to overlap.
 */
function fakeWebdav(tree: Record<string, Uint8Array | 'fails'>) {
  let inFlight = 0
  let peak = 0
  const reads: string[] = []
  const getFileContents = vi.fn(async (_space: SpaceResource, ref: { path?: string }) => {
    const path = ref.path as string
    reads.push(path)
    inFlight++
    peak = Math.max(peak, inFlight)
    // A turn of the microtask queue, so parallel reads are seen as parallel.
    await Promise.resolve()
    await Promise.resolve()
    inFlight--
    const entry = tree[path]
    if (!entry || entry === 'fails') throw Object.assign(new Error('gone'), { statusCode: 404 })
    return { body: entry.buffer.slice(entry.byteOffset, entry.byteOffset + entry.byteLength) }
  })
  const listFiles = vi.fn(async (_space: SpaceResource, options: { path: string }) => {
    const prefix = options.path === '/' ? '/' : `${options.path}/`
    return {
      children: Object.keys(tree)
        .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
        .map((p) => resource(p))
    }
  })
  return { webdav: { getFileContents, listFiles } as unknown as WebDav, reads, peak: () => peak }
}

const open = (webdav: WebDav, path: string) =>
  openTune({ space, resource: resource(path), webdav, maxBytes: 1024 * 1024 })

describe('openTune', () => {
  it('opens a PSID from itself alone, with no folder listing at all', async () => {
    const { webdav, reads } = fakeWebdav({ '/M/Commando.sid': makeSid('Commando') })
    const opened = await open(webdav, '/M/Commando.sid')
    expect(opened.header.format).toBe('PSID')
    expect(opened.header.name).toBe('Commando')
    expect(opened.scoreLength).toBeNull()
    expect(opened.picture).toBeNull()
    expect(reads).toEqual(['/M/Commando.sid'])
  })

  it('assembles a Sidplayer tune from its whole family', async () => {
    const { webdav } = fakeWebdav({
      '/M/Tune.mus': makeMus(['SONG', 'WHO']),
      '/M/Tune.str': makeMus(['RIGHT']),
      '/M/Tune.wds': Uint8Array.from([0x00, 0x09, 0x4c, 0x41, 0x00]),
      '/M/Tune.pic': picture
    })
    const opened = await open(webdav, '/M/Tune.mus')
    expect(opened.header.format).toBe('MUS+STR')
    expect(opened.header.name).toBe('SONG')
    expect(opened.words).toEqual(['LA'])
    expect(opened.picture?.format).toBe('koala')
    expect(opened.scoreLength).toBeGreaterThan(0)
    expect(opened.source.name).toBe('Tune.mus')
  })

  /*
   * Three companion reads, one WebDAV round trip each. Sequentially they sit
   * between the click and the first note for no reason: none of them feeds
   * any of the others.
   */
  it('reads the companions together rather than one after another', async () => {
    const { webdav, peak } = fakeWebdav({
      '/M/Tune.mus': makeMus(['SONG']),
      '/M/Tune.str': makeMus(['RIGHT']),
      '/M/Tune.wds': Uint8Array.from([0x00, 0x09, 0x4c, 0x41, 0x00]),
      '/M/Tune.pic': picture
    })
    await open(webdav, '/M/Tune.mus')
    expect(peak()).toBeGreaterThan(1)
  })

  it.each(['/M/Tune.str', '/M/Tune.wds', '/M/Tune.pic'])('opens the tune behind %s', async (clicked) => {
    const { webdav } = fakeWebdav({
      '/M/Tune.mus': makeMus(['SONG']),
      '/M/Tune.str': makeMus(['RIGHT']),
      '/M/Tune.wds': Uint8Array.from([0x00, 0x09, 0x4c, 0x41, 0x00]),
      '/M/Tune.pic': picture
    })
    const opened = await open(webdav, clicked)
    // The role is the extension's to decide: a .str is MUS-shaped data too,
    // and reading it as the tune would play the stereo half on its own.
    expect(opened.header.name).toBe('SONG')
    expect(opened.header.format).toBe('MUS+STR')
    expect(opened.source.name).toBe('Tune.mus')
    expect(opened.words).toEqual(['LA'])
    expect(opened.picture?.format).toBe('koala')
  })

  it('plays a good .mus in mono when its .str is not Sidplayer data', async () => {
    const { webdav } = fakeWebdav({
      '/M/Tune.mus': makeMus(['SONG']),
      '/M/Tune.str': new Uint8Array(40)
    })
    const opened = await open(webdav, '/M/Tune.mus')
    expect(opened.header.format).toBe('MUS')
    expect(opened.header.name).toBe('SONG')
  })

  it('plays a good .mus when its .str cannot be fetched', async () => {
    const { webdav } = fakeWebdav({ '/M/Tune.mus': makeMus(['SONG']), '/M/Tune.str': 'fails' })
    expect((await open(webdav, '/M/Tune.mus')).header.format).toBe('MUS')
  })

  it('names the tune after its file when the credits do not name it', async () => {
    const { webdav } = fakeWebdav({ '/M/Nameless_Tune.mus': makeMus([]) })
    expect((await open(webdav, '/M/Nameless_Tune.mus')).header.name).toBe('Nameless_Tune')
  })

  it('says what a .str with no tune beside it is, rather than "not a SID"', async () => {
    const { webdav } = fakeWebdav({ '/M/Tune.str': makeMus(['RIGHT']) })
    await expect(open(webdav, '/M/Tune.str')).rejects.toThrowError(/stereo half/)
  })

  it('reports a .mus that is not MUS data as such', async () => {
    const { webdav } = fakeWebdav({ '/M/Broken.mus': new Uint8Array(40) })
    await expect(open(webdav, '/M/Broken.mus')).rejects.toThrowError(/voice table or terminators/)
  })

  it('refuses anything that is neither, with a code the UI can render', async () => {
    const { webdav } = fakeWebdav({ '/M/Notes.txt': new TextEncoder().encode('hello') })
    await expect(open(webdav, '/M/Notes.txt')).rejects.toBeInstanceOf(SidPlayerError)
  })
})
