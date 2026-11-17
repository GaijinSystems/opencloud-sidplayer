import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { nextTick, ref, shallowRef } from 'vue'
import type { Router } from 'vue-router'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Resource, SpaceResource } from '@opencloud-eu/web-client'
import { readConfig } from '../src/config'
import { createSession } from '../src/player/session'
import type { WebDav } from '../src/sid/source'

/**
 * The session's recovery path: what the "Try again" button on the error panel
 * actually reaches.
 *
 * The audio graph is stubbed so that the worklet cannot be loaded, which is
 * the real shape of the failure being recovered from: the file reads fine and
 * `opened` is set, and it is the player that is dead.
 */

const tune = new Uint8Array(readFileSync(join(__dirname, 'fixtures/tone.sid')))

const space = { id: 'space-1', getDriveAliasAndItem: () => 'personal/tone.sid' } as unknown as SpaceResource
const resource = {
  id: 'res-1',
  fileId: 'res-1',
  name: 'tone.sid',
  path: '/Music/tone.sid',
  size: tune.byteLength,
  isFolder: false
} as unknown as Resource

class DeadAudioContext {
  state = 'running'
  sampleRate = 44100
  destination = {}
  // A worklet that is not deployed, or a content security policy that
  // refuses it: the commonest way for the engine never to start.
  audioWorklet = { addModule: () => Promise.reject(new Error('not deployed')) }
  addEventListener() {}
  removeEventListener() {}
  close() {
    return Promise.resolve()
  }
}

/** Counts only reads of the tune itself; the song-length walk reads other paths. */
function fakeWebdav() {
  let reads = 0
  const webdav = {
    getFileContents: (_space: SpaceResource, ref: { path?: string; fileId?: string }) => {
      if (ref.path === resource.path) {
        reads++
        return Promise.resolve({ body: tune.slice().buffer })
      }
      return Promise.reject(new Error('404'))
    },
    getFileInfo: (_space: SpaceResource, ref: { path?: string }) =>
      ref.path === resource.path
        ? Promise.resolve({ path: ref.path, size: tune.length })
        : Promise.reject(new Error('404')),
    getFileUrl: () => Promise.resolve('blob:tone'),
    revokeUrl: () => undefined
  }
  return { webdav: webdav as unknown as WebDav, reads: () => reads }
}

describe('session.play', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('AudioContext', DeadAudioContext)
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, status: 404 } as Response))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('reloads the tune when the player has failed, so "Try again" is not a no-op', async () => {
    const { webdav, reads } = fakeWebdav()
    const session = createSession(readConfig({}), { webdav, themes: () => [] })

    await session.play(space, resource)
    // The file opened; it is the engine that did not.
    expect(session.error.value).toBeNull()
    expect(session.current.value?.opened).toBeTruthy()
    expect(session.player.state.value).toBe('failed')
    expect(reads()).toBe(1)

    // The same file, the same session: without treating `failed` as not open
    // this returns at the first line and nothing happens at all.
    await session.play(space, resource)
    expect(reads()).toBe(2)

    session.destroy()
  })

  it('still resumes a healthy tune rather than reloading it', async () => {
    const { webdav, reads } = fakeWebdav()
    const session = createSession(readConfig({}), { webdav, themes: () => [] })

    await session.play(space, resource)
    expect(reads()).toBe(1)
    // Pretend the engine came up: clicking the playing row twice must not
    // restart the tune from the top.
    session.player.state.value = 'paused'
    await session.play(space, resource)
    expect(reads()).toBe(1)

    session.destroy()
  })

  it('keeps playing across Files and its own views, and stops on leaving for another app', async () => {
    const { webdav } = fakeWebdav()
    const session = createSession(readConfig({}), { webdav, themes: () => [] })
    const route = shallowRef({ name: 'files-spaces-generic' as string | undefined })
    session.router.value = { currentRoute: route } as unknown as Router
    await session.play(space, resource)
    expect(session.current.value).not.toBeNull()

    for (const name of [
      'files-common-favorites',
      'sidplayer',
      'sidplayer-library',
      undefined,
      'files-spaces-generic'
    ]) {
      route.value = { name }
      await nextTick()
      expect(session.current.value, `on ${name}`).not.toBeNull()
    }

    route.value = { name: 'settings-general' }
    await nextTick()
    expect(session.current.value).toBeNull()
    expect(session.dockVisible.value).toBe(false)

    session.destroy()
  })

  /*
   * The library already knows a tune's lengths, from the catalogue built out
   * of the same Songlengths.md5 the player would otherwise go looking for -
   * and then parse, all five megabytes of it, a second time.
   */
  it('takes lengths it is given, without looking for a database', async () => {
    const getFileContents = vi.fn(async (_space: SpaceResource, ref: { path?: string }) => {
      if (ref.path === resource.path) return { body: tune.slice().buffer }
      throw new Error('404')
    })
    const session = createSession(readConfig({}), {
      webdav: { getFileContents } as unknown as WebDav,
      themes: () => []
    })
    await session.play(space, resource, { lengths: [61, 62], hvscPath: '/MUSICIANS/T/Tone.sid' })
    expect(session.current.value?.lengths).toEqual([61, 62])
    expect(session.current.value?.hvscPath).toBe('/MUSICIANS/T/Tone.sid')
    expect(getFileContents.mock.calls.every(([, ref]) => ref.path === resource.path)).toBe(true)
    session.destroy()
  })

  it('opens a new tune at subsong 1 even when its header names another', async () => {
    // tone.sid has three subsongs; make its header ask to start on the last.
    const asksForThree = tune.slice()
    new DataView(asksForThree.buffer).setUint16(0x10, 3)
    const webdav = {
      getFileContents: (_space: SpaceResource, ref: { path?: string }) =>
        ref.path === resource.path
          ? Promise.resolve({ body: asksForThree.slice().buffer })
          : Promise.reject(new Error('404'))
    } as unknown as WebDav
    const session = createSession(readConfig({}), { webdav, themes: () => [] })

    await session.play(space, resource)
    expect(session.current.value?.opened?.header.startSong).toBe(3)
    expect(session.player.subsong.value).toBe(1)

    session.destroy()
  })
})

/**
 * The running order as the session sees it.
 *
 * The library owns the list and hands down a cursor; everything below is
 * about what the two transport buttons may do with it, which is the part the
 * session decides on its own.
 */
describe('moving along the running order', () => {
  const build = (length: number, index: number) => {
    const { webdav } = fakeWebdav()
    const session = createSession(readConfig({}), { webdav, themes: () => [] })
    const playAt = vi.fn(async (_index: number) => {})
    return { session, playAt, queue: { length, index, playAt } }
  }

  it('offers neither direction until something has been played from a list', () => {
    const { session } = build(3, 0)
    expect(session.canNextTune.value).toBe(false)
    expect(session.canPreviousTune.value).toBe(false)
    session.destroy()
  })

  it('knows which ends of the list it is at', async () => {
    const { session, queue } = build(3, 0)
    await session.playQueue(queue)
    expect(session.canPreviousTune.value).toBe(false)
    expect(session.canNextTune.value).toBe(true)

    await session.nextTune()
    await session.nextTune()
    expect(session.canNextTune.value).toBe(false)
    expect(session.canPreviousTune.value).toBe(true)
    session.destroy()
  })

  it('walks forwards and back through the positions', async () => {
    const { session, playAt, queue } = build(4, 1)
    await session.playQueue(queue)
    await session.nextTune()
    await session.previousTune()
    await session.previousTune()
    expect(playAt.mock.calls.map(([i]) => i)).toEqual([1, 2, 1, 0])
    session.destroy()
  })

  it('stays put at either end rather than wrapping round', async () => {
    const { session, playAt, queue } = build(2, 0)
    await session.playQueue(queue)
    await session.previousTune()
    await session.nextTune()
    await session.nextTune()
    // 0 to start, then 1; the two that would fall off the ends do nothing.
    expect(playAt.mock.calls.map(([i]) => i)).toEqual([0, 1])
    session.destroy()
  })

  /*
   * The library hands its list over and then plays the tune itself. Handing
   * it over through `playQueue`, which plays as well, ran every play from
   * the library twice: two reads of the file, and for a tune not yet
   * downloaded two fetches from the mirror and two writes to the same path.
   */
  it('takes a list without playing anything from it', () => {
    const { session, playAt, queue } = build(3, 1)
    session.setQueue(queue)
    expect(playAt).not.toHaveBeenCalled()
    expect(session.canNextTune.value).toBe(true)
    session.destroy()
  })

  /*
   * A tune started from somewhere else is not part of the list. Left in
   * place, the list put its arrows on a tune from the Files app and carried
   * on into the library's next tune when that one ended.
   */
  it('lets go of the list when a tune is played from somewhere else', async () => {
    vi.stubGlobal('AudioContext', DeadAudioContext)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { session, queue } = build(3, 0)
    session.setQueue(queue)
    await session.play(space, resource)
    expect(session.canNextTune.value).toBe(false)
    session.destroy()
    vi.unstubAllGlobals()
  })

  it('keeps the list for a tune played from it', async () => {
    vi.stubGlobal('AudioContext', DeadAudioContext)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { session, queue } = build(3, 0)
    session.setQueue(queue)
    await session.play(space, resource, { fromQueue: true })
    expect(session.canNextTune.value).toBe(true)
    session.destroy()
    vi.unstubAllGlobals()
  })

  it('lets go of the tune itself when stopped, not just pauses it', async () => {
    const { session } = build(3, 0)
    session.stop()
    expect(session.player.state.value).toBe('idle')
    expect(session.player.header.value).toBeNull()
    session.destroy()
  })

  it('forgets the order when playback is stopped', async () => {
    const { session, queue } = build(3, 0)
    await session.playQueue(queue)
    expect(session.canNextTune.value).toBe(true)
    session.stop()
    expect(session.canNextTune.value).toBe(false)
    session.destroy()
  })
})

describe('what the bar is told to call the tune', () => {
  it('says nothing at all before anything is loaded', () => {
    const { webdav } = fakeWebdav()
    const session = createSession(readConfig({}), { webdav, themes: () => [] })
    /*
     * Not "tune". `displayTitle` needs a file name to fall back on and was
     * handed a literal `tune.sid`, which it stripped to "tune" - so the
     * library, which draws the player bar whether or not anything is playing,
     * opened announcing a tune of that name that exists nowhere.
     */
    expect(session.title.value).toBe('')
    session.destroy()
  })

  it('and goes quiet again when playback is stopped', async () => {
    const { webdav } = fakeWebdav()
    const session = createSession(readConfig({}), { webdav, themes: () => [] })
    await session.play(space, resource, { autoplay: false })
    expect(session.title.value).not.toBe('')
    session.stop()
    expect(session.title.value).toBe('')
    session.destroy()
  })
})

/*
 * The dock registers before the instance's themes may have loaded, and a
 * Light or Dark choice made against an empty list applied nothing until the
 * preference itself changed again. The list arriving is enough now.
 */
describe('the player theme', () => {
  it('applies a chosen theme once the instance has its themes', async () => {
    localStorage.clear()
    const themes = ref<Array<{ isDark: boolean; designTokens: { roles: Record<string, string> } }>>([])
    const { webdav } = fakeWebdav()
    const session = createSession(readConfig({}), { webdav, themes: () => themes.value })
    session.prefs.theme = 'dark'
    const el = document.createElement('div')
    session.registerThemeRoot(el)
    await nextTick()
    expect(el.getAttribute('style') ?? '').toBe('')

    themes.value = [
      { isDark: false, designTokens: { roles: { surface: '#ffffff' } } },
      { isDark: true, designTokens: { roles: { surface: '#101010' } } }
    ]
    await nextTick()
    expect(el.getAttribute('style')).toContain('#101010')
    session.destroy()
  })
})
