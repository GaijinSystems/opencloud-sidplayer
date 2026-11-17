import { describe, it, expect, vi } from 'vitest'
import type { Resource, SpaceResource } from '@opencloud-eu/web-client'
import { createLibrary } from '../src/library/useLibrary'
import { readConfig } from '../src/config'
import type { MirrorOps } from '../src/hvsc/mirror'
import type { WebDav } from '../src/sid/source'
import { fakeSpaceOps } from './helpers/fakes'

/**
 * The running order: what "next tune" and "previous tune" mean.
 *
 * The rule being tested throughout is that the list is taken as it stood when
 * play was pressed and then left alone. Anything else makes the buttons a
 * question about where the user is looking rather than about what they put
 * on, so browsing away mid-tune would silently reroute them.
 */

const TUNES = [
  '/MUSICIANS/G/Galway_Martin/Wizball.sid',
  '/MUSICIANS/H/Hubbard_Rob/Commando.sid',
  '/MUSICIANS/H/Hubbard_Rob/Delta.sid'
]

const MANIFEST = [
  '[Database]',
  ...TUNES.flatMap((path, i) => [`; ${path}`, `${String(i).repeat(32)}=1:00`])
].join('\n')

interface Queue {
  length: number
  index: number
  playAt: (index: number) => Promise<void>
}

function rig() {
  const ops = fakeSpaceOps({
    list: vi.fn(async (path: string) => {
      if (path === '/') return { folders: ['/MUSICIANS', '/DOCUMENTS'], files: [] }
      return {
        folders: [],
        files: TUNES.filter((p) => p.startsWith(`${path}/`)).map((p) => ({ path: p, md5: 'x', size: 1 }))
      }
    }),
    readHead: vi.fn(async () => {
      throw new Error('no headers in this fixture')
    }),
    readText: vi.fn(async (path: string) => (path.endsWith('Songlengths.md5') ? MANIFEST : null))
  })
  const mirror: MirrorOps = {
    release: vi.fn(async () => 85),
    document: vi.fn(async () => MANIFEST),
    tune: vi.fn(async () => new Uint8Array(0)),
    reachable: vi.fn(async () => true)
  }
  const play = vi.fn<(space: SpaceResource, resource: Resource) => void>()
  let queue: Queue | null = null
  const lib = createLibrary({
    webdav: {} as WebDav,
    space: {} as SpaceResource,
    config: readConfig({}),
    play,
    setQueue: (q) => {
      queue = q as Queue
    },
    ops,
    mirror
  })
  /** The paths handed to the player, in order. */
  const played = (): string[] => play.mock.calls.map(([, resource]) => String(resource.path))
  return { lib, played, queue: () => queue }
}

const open = async () => {
  const r = rig()
  await r.lib.init()
  r.lib.openFolder('/MUSICIANS')
  return r
}

describe('the running order', () => {
  it('takes the list as it stands when a tune is played', async () => {
    const { lib, queue } = await open()
    const rows = lib.visible.value
    expect(rows).toHaveLength(3)

    await lib.play(rows[1])
    expect(queue()).toMatchObject({ length: 3, index: 1 })
  })

  /*
   * The whole point of freezing. Starting a tune in a folder and then
   * searching for something else must not quietly repoint "next" at the
   * search results.
   */
  it('keeps that order however far the user browses afterwards', async () => {
    const { lib, queue, played } = await open()
    await lib.play(lib.visible.value[0])
    expect(queue()?.length).toBe(3)

    lib.search('commando')
    expect(lib.visible.value.length).toBeLessThan(3)

    // Still the folder's order, and still moving along it.
    expect(queue()).toMatchObject({ length: 3, index: 0 })
    await queue()!.playAt(1)
    expect(played().at(-1)).toContain('Commando.sid')
  })

  it('plays the tune at a position in that order', async () => {
    const { lib, queue, played } = await open()
    await lib.play(lib.visible.value[0])
    expect(played().at(-1)).toContain('Wizball.sid')

    await queue()!.playAt(2)
    expect(played().at(-1)).toContain('Delta.sid')
    expect(played()).toHaveLength(2)
  })

  it('does not rebuild the order when moving along it', async () => {
    const { lib, queue } = await open()
    await lib.play(lib.visible.value[0])
    const first = queue()
    await queue()!.playAt(1)
    // `setQueue` is called when a person picks a tune, not when the player
    // walks to the next one; otherwise the index would reset to that row's
    // place in whatever list is on screen now.
    expect(queue()).toBe(first)
  })

  it('is a list of one for a tune that is not in view', async () => {
    const { lib, queue } = await open()
    const stray = lib.rows.value.find((row) => row.name === 'Delta.sid')!
    lib.search('wizball')
    expect(lib.visible.value.some((row) => row.path === stray.path)).toBe(false)

    await lib.play(stray)
    expect(queue()).toMatchObject({ length: 1, index: 0 })
  })

  it('follows the sort, so the order is the one on screen', async () => {
    const { lib, queue, played } = await open()
    lib.toggleSort('title')
    const sorted = lib.visible.value.map((row) => row.name)
    await lib.play(lib.visible.value[0])
    await queue()!.playAt(1)
    expect(played().at(-1)).toContain(sorted[1])
  })
})
