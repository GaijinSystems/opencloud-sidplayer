import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readConfig } from '../src/config'
import { useSidPlayer } from '../src/composables/useSidPlayer'
import type { SidHeader } from '../src/sid/types'

/**
 * The player against a fake audio graph.
 *
 * Nothing here emulates a SID: the point is the state machine around the
 * worklet, which is where the recovery paths live and where a real
 * AudioContext would make a unit test impossible. The fake answers the
 * worklet protocol from docs/engine-contract.md and nothing else.
 */

/** Whether the next worklet node answers `init` with ready or with an error. */
let engineStarts = true
/** Whether the next subsong change is refused, as the engine refuses a damaged one. */
let subsongFails = false
const nodes: FakeNode[] = []
const contexts: FakeAudioContext[] = []

class FakePort {
  onmessage: ((event: { data: unknown }) => void) | null = null
  readonly sent: Array<Record<string, unknown>> = []

  postMessage(msg: Record<string, unknown>) {
    this.sent.push(msg)
    // A microtask, as a real port is asynchronous: answering synchronously
    // would hide any ordering bug the main thread has.
    const answer = (data: unknown) => queueMicrotask(() => this.onmessage?.({ data }))
    if (msg.type === 'init') {
      answer(engineStarts ? { type: 'engine-ready' } : { type: 'engine-error', message: 'no wasm here' })
    } else if (msg.type === 'subsong' && subsongFails) {
      answer({ type: 'error', id: msg.id, message: 'the engine refused it' })
    } else if (msg.type === 'load' || msg.type === 'subsong') {
      answer({ type: 'loaded', id: msg.id })
    }
  }
}

class FakeNode {
  readonly port = new FakePort()
  connected = true
  constructor() {
    nodes.push(this)
  }
  connect() {}
  disconnect() {
    this.connected = false
  }
}

class FakeAudioContext {
  state: 'running' | 'suspended' | 'closed' = 'running'
  sampleRate = 44100
  destination = {}
  audioWorklet = { addModule: () => Promise.resolve() }
  private listeners: Array<() => void> = []

  constructor() {
    contexts.push(this)
  }
  addEventListener(type: string, fn: () => void) {
    if (type === 'statechange') this.listeners.push(fn)
  }
  removeEventListener(_type: string, fn: () => void) {
    this.listeners = this.listeners.filter((l) => l !== fn)
  }
  createAnalyser() {
    return { fftSize: 0, smoothingTimeConstant: 0, frequencyBinCount: 1024, connect() {}, disconnect() {} }
  }
  createGain() {
    return { gain: { value: 0, setTargetAtTime() {} }, connect() {}, disconnect() {} }
  }
  resume() {
    return Promise.resolve()
  }
  close() {
    this.state = 'closed'
    return Promise.resolve()
  }
  /** What the OS does to us: a phone call, a tab the browser discards. */
  goTo(state: 'running' | 'suspended') {
    this.state = state
    for (const listener of [...this.listeners]) listener()
  }
}

const header = {
  format: 'PSID',
  songs: 3,
  startSong: 1,
  name: 'Commando',
  author: 'Rob Hubbard',
  released: '1985 Elite'
} as unknown as SidHeader

const bytes = () => new Uint8Array([0x50, 0x53, 0x49, 0x44, 0x00, 0x02])

/** One turn of the microtask queue, for the answers the fake port posts back. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('useSidPlayer', () => {
  beforeEach(() => {
    engineStarts = true
    subsongFails = false
    nodes.length = 0
    contexts.length = 0
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('AudioWorkletNode', FakeNode)
    // No engine.json: fetchEngineAssets reads 404 as "an engine that needs
    // no files", which is what a pure JavaScript engine would be.
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, status: 404 } as Response))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('rebuilds the graph after the engine has refused to start', async () => {
    const player = useSidPlayer(readConfig({}), {})
    engineStarts = false

    await player.open(bytes(), header, 1)
    expect(player.state.value).toBe('failed')
    expect(nodes).toHaveLength(1)
    expect(nodes[0].connected).toBe(false)

    // What "Try again" reaches. A cached rejected `engineReady` would make
    // this fail identically for the rest of the page's life.
    engineStarts = true
    await player.open(bytes(), header, 1)
    expect(player.state.value).toBe('ready')
    expect(nodes).toHaveLength(2)

    player.destroy()
  })

  /*
   * A failure that leaves the worklet running is a tune nobody can stop:
   * every transport button is disabled in `failed`, and Stop goes through
   * `pause()`. The worklet keeps the old tune when a subsong change fails, so
   * the failure itself has to silence it, and pausing has to work from there.
   */
  it('silences the worklet when a subsong change fails', async () => {
    const player = useSidPlayer(readConfig({}), {})
    await player.open(bytes(), header, 1)
    await player.play()
    subsongFails = true
    player.next()
    await settle()
    expect(player.state.value).toBe('failed')
    const port = nodes[0].port
    expect(port.sent.at(-1)).toMatchObject({ type: 'pause', paused: true })

    port.sent.length = 0
    player.pause()
    expect(port.sent).toContainEqual({ type: 'pause', paused: true })
    player.destroy()
  })

  /*
   * The full view's keys reach the player before its first tune has loaded.
   * A subsong change then went to a worklet that did not exist yet, was
   * dropped, timed out five seconds later and failed the player under a tune
   * that was by then playing.
   */
  it('ignores a subsong change while the tune is still loading', async () => {
    const player = useSidPlayer(readConfig({}), {})
    const opening = player.open(bytes(), header, 1)
    player.next()
    await opening
    expect(player.subsong.value).toBe(1)
    expect(player.state.value).toBe('ready')
    expect(nodes[0].port.sent.some((m) => m.type === 'subsong')).toBe(false)
    player.destroy()
  })

  /*
   * The engine's files are handed to the worklet once, when the graph is
   * built. A second tune used to fetch them all again for nothing - and to
   * fail with "the engine is unavailable" if that needless fetch did, with
   * a perfectly good engine already running.
   */
  it('fetches the engine files once, not once a tune', async () => {
    const fetches = vi.fn(() => Promise.resolve({ ok: false, status: 404 } as Response))
    vi.stubGlobal('fetch', fetches)
    const player = useSidPlayer(readConfig({}), {})
    await player.open(bytes(), header, 1)
    const afterFirst = fetches.mock.calls.length
    expect(afterFirst).toBeGreaterThan(0)

    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))
    await player.open(bytes(), header, 2)
    expect(player.state.value).toBe('ready')
    player.destroy()
  })

  /*
   * When the list takes over at the end of a tune, the next one may be a
   * folder listing or a mirror fetch away. The finished tune went on playing
   * meanwhile, and every position report past its end - four a second -
   * handed over again, so the list raced ahead and skipped tunes.
   */
  it('hands the end of a tune to the list once, and goes quiet while it does', async () => {
    const onEnd = vi.fn(() => true)
    const player = useSidPlayer(readConfig({ defaultSongLengthSeconds: 5 }), { onEnd })
    await player.open(bytes(), { ...header, songs: 1 } as SidHeader, 1)
    await player.play()
    const port = nodes[0].port
    for (let i = 0; i < 4; i++) port.onmessage?.({ data: { type: 'position', frames: 44100 * (6 + i) } })
    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(port.sent.at(-1)).toMatchObject({ type: 'pause', paused: true })
    player.destroy()
  })

  /*
   * A Sidplayer tune is ended by the worklet hearing it stop, since its
   * length is worked out and not exact. One that never stops - a score that
   * holds a note for ever, or never sounds one - had no end at all, and a
   * running order stood still on it.
   */
  it('ends a tune that is listened to for its end, once it is far past any end', async () => {
    const onEnd = vi.fn(() => true)
    const player = useSidPlayer(readConfig({ defaultSongLengthSeconds: 5 }), { onEnd })
    await player.open(bytes(), { ...header, songs: 1, format: 'MUS' } as SidHeader, 1)
    await player.play()
    const port = nodes[0].port
    // Past its length, and past twice its length: still the worklet's call.
    port.onmessage?.({ data: { type: 'position', frames: 44100 * 60 } })
    expect(onEnd).not.toHaveBeenCalled()
    port.onmessage?.({ data: { type: 'position', frames: 44100 * 601 } })
    expect(onEnd).toHaveBeenCalledTimes(1)
    player.destroy()
  })

  /*
   * Stopping lets go of the tune. Paused, it was still there: the library's
   * Play button, which outlives the dock, and the OS media keys resumed it
   * under "Nothing playing".
   */
  it('has nothing left to play once the tune is unloaded', async () => {
    const player = useSidPlayer(readConfig({}), {})
    await player.open(bytes(), header, 1)
    await player.play()
    const port = nodes[0].port
    player.unload()
    expect(player.state.value).toBe('idle')
    expect(player.header.value).toBeNull()
    expect(port.sent.at(-1)).toMatchObject({ type: 'pause', paused: true })
    port.sent.length = 0
    await player.play()
    expect(port.sent).toEqual([])
    expect(player.state.value).toBe('idle')
    player.destroy()
  })

  /*
   * A paused tune kept the audio device open and the worklet rendering
   * silence for as long as the tab stayed open.
   */
  it('lets the audio context go idle while paused, and wakes it to play', async () => {
    const player = useSidPlayer(readConfig({}), {})
    await player.open(bytes(), header, 1)
    await player.play()
    const ctx = contexts[0] as FakeAudioContext & { suspend?: () => Promise<void> }
    const suspend = vi.fn(async () => ctx.goTo('suspended'))
    const resume = vi.spyOn(ctx, 'resume').mockImplementation(async () => ctx.goTo('running'))
    ctx.suspend = suspend
    vi.useFakeTimers()
    try {
      player.pause()
      vi.advanceTimersByTime(9_000)
      expect(suspend).not.toHaveBeenCalled()
      vi.advanceTimersByTime(2_000)
      expect(suspend).toHaveBeenCalledOnce()
      // Paused is still paused: this suspension is not the browser's.
      expect(player.state.value).toBe('paused')
    } finally {
      vi.useRealTimers()
    }
    await player.play()
    expect(resume).toHaveBeenCalled()
    expect(player.state.value).toBe('playing')
    player.destroy()
    await settle()
  })

  /*
   * A subsong chosen while the tune was only open stopped the idle clock,
   * and `ready` over `ready` never started it again.
   */
  it('goes idle after a subsong is chosen on a tune that is only open', async () => {
    const player = useSidPlayer(readConfig({}), {})
    await player.open(bytes(), header, 1)
    const ctx = contexts[0] as FakeAudioContext & { suspend?: () => Promise<void> }
    const suspend = vi.fn(async () => ctx.goTo('suspended'))
    ctx.suspend = suspend
    vi.useFakeTimers()
    try {
      player.next()
      await vi.advanceTimersByTimeAsync(11_000)
      expect(player.state.value).toBe('ready')
      expect(suspend).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
    player.destroy()
    await settle()
  })

  /*
   * A suspend under way still reads as running, so a Play pressed then did
   * not ask to resume, and was left waiting once the suspend landed.
   */
  it('asks to resume when Play is pressed while an idle suspend is under way', async () => {
    const player = useSidPlayer(readConfig({}), {})
    await player.open(bytes(), header, 1)
    await player.play()
    const ctx = contexts[0] as FakeAudioContext & { suspend?: () => Promise<void> }
    ctx.suspend = vi.fn(() => new Promise<void>(() => undefined))
    const resume = vi.spyOn(ctx, 'resume')
    vi.useFakeTimers()
    try {
      player.pause()
      vi.advanceTimersByTime(11_000)
    } finally {
      vi.useRealTimers()
    }
    await player.play()
    expect(resume).toHaveBeenCalled()
    player.destroy()
    await settle()
  })

  it('keeps a Pause pressed while the context wakes', async () => {
    const player = useSidPlayer(readConfig({}), {})
    await player.open(bytes(), header, 1)
    await player.play()
    const ctx = contexts[0] as FakeAudioContext & { suspend?: () => Promise<void> }
    ctx.suspend = vi.fn(async () => ctx.goTo('suspended'))
    let woken: () => void = () => undefined
    vi.spyOn(ctx, 'resume').mockImplementation(
      () =>
        new Promise<void>((done) => {
          woken = () => {
            ctx.goTo('running')
            done()
          }
        })
    )
    vi.useFakeTimers()
    try {
      player.pause()
      vi.advanceTimersByTime(11_000)
    } finally {
      vi.useRealTimers()
    }
    const playing = player.play()
    player.pause()
    woken()
    await playing
    expect(player.state.value).toBe('paused')
    player.destroy()
    await settle()
  })

  it('asks for a gesture when the context is suspended mid-play', async () => {
    const player = useSidPlayer(readConfig({}), {})
    await player.open(bytes(), header, 1)
    await player.play()
    expect(player.state.value).toBe('playing')

    contexts[0].goTo('suspended')
    // Not 'playing': the clock has stopped and a Pause button would be a lie.
    expect(player.state.value).toBe('resume')

    contexts[0].goTo('running')
    expect(player.state.value).toBe('playing')

    player.destroy()
    await settle()
  })

  /**
   * What happens when a subsong runs out.
   *
   * A file with several subsongs plays through them on its own; only after
   * the last one is the tune over, and only then does the list get asked what
   * follows. Driven by feeding the worklet's own position messages back in,
   * which is how the real end is noticed.
   */
  describe('the end of a subsong', () => {
    /** Tells the player the subsong has run past its length. */
    const reachTheEnd = async (node: FakeNode) => {
      // One second of frames against a one-second length.
      node.port.onmessage?.({ data: { type: 'position', frames: 44100 * 2 } })
      await settle()
    }

    it('moves to the next subsong of the same file', async () => {
      const onEnd = vi.fn(() => true)
      const player = useSidPlayer(readConfig({}), { songLength: () => 1, onEnd })
      await player.open(bytes(), header, 1)
      await player.play()

      await reachTheEnd(nodes[0])
      expect(player.subsong.value).toBe(2)
      await reachTheEnd(nodes[0])
      expect(player.subsong.value).toBe(3)
      // Three subsongs, two of them finished: the list has not been asked yet.
      expect(onEnd).not.toHaveBeenCalled()

      player.destroy()
    })

    it('hands over to the list once the last subsong is done', async () => {
      const onEnd = vi.fn(() => true)
      const player = useSidPlayer(readConfig({}), { songLength: () => 1, onEnd })
      await player.open(bytes(), header, 3)
      await player.play()

      await reachTheEnd(nodes[0])
      expect(onEnd).toHaveBeenCalledTimes(1)
      // Paused, not rewound: whoever answered is starting something else,
      // which may take a folder listing or a fetch, and this tune must not
      // play on past its end meanwhile. The next tune's load replaces it.
      expect(player.state.value).toBe('paused')

      player.destroy()
    })

    it('stops at the beginning when nothing follows', async () => {
      const onEnd = vi.fn(() => false)
      const player = useSidPlayer(readConfig({}), { songLength: () => 1, onEnd })
      await player.open(bytes(), header, 3)
      await player.play()

      await reachTheEnd(nodes[0])
      expect(onEnd).toHaveBeenCalledTimes(1)
      // Stopped and rewound: `restart` reloads the subsong without playing
      // it, which leaves the transport offering Play from the top.
      expect(player.state.value).toBe('ready')
      expect(player.position.value).toBe(0)

      player.destroy()
    })
  })

  describe('length', () => {
    const config = readConfig({})

    it('falls back to the configured length when the database says 0:00', () => {
      const player = useSidPlayer(config, { songLength: () => 0 })
      player.header.value = header
      // Taking the 0 would end the subsong on the first position message,
      // about 250ms in, and skip straight on to the next tune.
      expect(player.length.value).toBe(config.defaultSongLengthSeconds)
    })

    it('uses a real length when there is one', () => {
      const player = useSidPlayer(config, { songLength: () => 42 })
      player.header.value = header
      expect(player.length.value).toBe(42)
    })
  })
})
