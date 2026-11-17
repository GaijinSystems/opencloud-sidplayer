import { computed, ref, shallowRef, watch } from 'vue'
import type { SidplayConfig } from '../config'
import type { ChipModel, ClockMode } from './usePreferences'
import { resolveEngineUrl } from '../helpers/assetUrl'
import { withTimeout } from '../helpers/async'
import { SidPlayerError, type SidHeader } from '../sid/types'
import { fetchEngineAssets } from '../sid/engineAssets'

export type PlayerState = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'resume' | 'failed'
/** 'auto' follows the tune's header; the types are the preferences' own. */
export interface Emulation {
  model: ChipModel
  clock: ClockMode
}

export interface PlayerOptions {
  /**
   * Called when the tune runs out - that is, when its *last* subsong ends.
   * Returning true means the caller has taken over, by starting the next tune
   * in the list, and the player should leave the transport alone; false means
   * there was nothing to move on to, and it stops where it is.
   *
   * A file with several subsongs plays through them first, on its own. Only
   * what happens after the last of them is somebody else's question, and it
   * is one about the list the tune came from, which lives a long way above
   * this file.
   */
  onEnd?: () => boolean
  /** Length in seconds for a subsong of the loaded tune; falls back to config. */
  songLength?: (header: SidHeader, subsong: number) => number | undefined
  /**
   * What to call the tune in the OS media widget. The header's own name is
   * not it: HVSC writes `<?>` for an unknown title and the rest of the app
   * shows the file name instead, so without this the widget is the one place
   * the placeholder leaks out. The caller owns that decision; the player has
   * no business knowing how a title is presented.
   */
  title?: () => string
}

const ENGINE_BUDGET_MS = 15000
const LOAD_BUDGET_MS = 5000
/** The least a tune that ends on silence is given before it is ended anyway. */
const SILENCE_BACKSTOP_SECONDS = 600

/**
 * Owns the AudioContext, the worklet node and the graph
 * `worklet → analyser → gain → destination`, and the playback state machine.
 *
 * Volume is applied at the gain node, after the analyser, so turning the
 * sound down or muting does not flatten the display: the tune is still
 * playing and the display should say so.
 *
 * Rounds. Every `open()` and `setSubsong()` is a request numbered by `seq`.
 * The worklet answers with the same id, and an answer for a request that is
 * no longer the newest is dropped. Without this a slow load can finish after
 * the user has opened a different file and flip the new file's state.
 */
export const useSidPlayer = (config: SidplayConfig, options: PlayerOptions) => {
  const state = ref<PlayerState>('idle')
  const error = shallowRef<SidPlayerError | null>(null)
  const header = shallowRef<SidHeader | null>(null)
  const subsong = ref(1)
  /** Seconds into the current subsong, from frames the worklet has rendered. */
  const position = ref(0)
  /**
   * The level as the session last set it. Plain values, not refs: nothing
   * renders from these - the bar reads the preferences - and the only reader
   * is `applyLevel` below.
   */
  let volume = 0.8
  let muted = false

  /** The analyser, for the spectrum to read. Set once the graph exists. */
  const analyser = shallowRef<AnalyserNode | null>(null)
  /** Voices of the first SID silenced by the user. Session state, not a preference. */
  const mutedVoices = ref<boolean[]>([false, false, false])
  let emulation: Emulation = { model: 'auto', clock: 'auto' }

  let ctx: AudioContext | null = null
  let node: AudioWorkletNode | null = null
  let gain: GainNode | null = null
  let moduleLoaded: Promise<void> | null = null
  let assetsLoaded: ReturnType<typeof fetchEngineAssets> | null = null
  let engineReady: Promise<void> | null = null
  let seq = 0
  let bytes: Uint8Array | null = null
  /**
   * True from a subsong request until the worklet confirms it. Position
   * messages already in flight still carry the old subsong's frame count, and
   * without this each of them would re-trigger the end-of-song handling.
   */
  let switching = false
  /** Whether this tune's end comes from the worklet listening, not the clock. */
  let endsOnSilence = false
  const pending = new Map<number, { resolve: () => void; reject: (e: Error) => void }>()

  const songCount = computed(() => header.value?.songs ?? 0)
  const length = computed(() => {
    const h = header.value
    if (!h) return config.defaultSongLengthSeconds
    const known = options.songLength?.(h, subsong.value)
    /*
     * Non-positive is unknown, not "ends immediately". HVSC writes `0:00` for
     * a handful of entries and `parseLength` returns 0 for them, which `??`
     * happily accepts; the first position message then arrives about 250ms in
     * with `position >= length` already true, and in `song` loop mode the
     * tune restarts four times a second in silence.
     */
    return known !== undefined && known > 0 ? known : config.defaultSongLengthSeconds
  })
  const canPrevious = computed(() => subsong.value > 1)
  const canNext = computed(() => subsong.value < songCount.value)

  const fail = (e: SidPlayerError) => {
    error.value = e
    state.value = 'failed'
    // Silenced as well as marked. The worklet keeps the previous tune when a
    // load or subsong change fails, and a failed player disables every
    // transport button, so whatever it was playing would otherwise play on
    // with nothing left on screen that could stop it.
    post({ type: 'pause', paused: true })
    if (navigator.mediaSession) navigator.mediaSession.playbackState = 'paused'
    console.error('[sidplayer]', e.code, e.message, e.cause ?? '')
  }

  /* ---- graph ------------------------------------------------------------ */

  const applyLevel = () => {
    if (!gain || !ctx) return
    const target = muted ? 0 : Math.min(1, Math.max(0, volume))
    // A short ramp instead of a jump: an abrupt gain change clicks.
    gain.gain.setTargetAtTime(target, ctx.currentTime, 0.015)
  }

  const onContextState = () => {
    if (!ctx) return
    // A context suspended by autoplay policy resumes on the next gesture the
    // browser accepts, which may be a click anywhere in the page.
    if (state.value === 'resume' && ctx.state === 'running') {
      state.value = 'playing'
      post({ type: 'pause', paused: false })
      return
    }
    /*
     * The other direction. A running context can be suspended out from under
     * us - a call arriving on a phone, a tab the browser decides to discard -
     * and nothing tells the worklet, so the clock freezes while the bar still
     * offers Pause on a tune that is not moving. `resume` is the honest
     * state, and because the pause flag was never set, the gesture path above
     * starts it again the moment the context comes back.
     */
    if (state.value === 'playing' && ctx.state !== 'running') state.value = 'resume'
  }

  /*
   * The context is suspended once nothing has played for a while. A running
   * context keeps the audio device open and calls the worklet 375 times a
   * second to render silence, for as long as the tab stays open on a paused
   * tune. Only a suspension made here is undone here: one the browser or the
   * OS made is the `resume` state's business, above.
   */
  const SUSPEND_AFTER_MS = 10_000
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let suspendedHere = false
  const cancelSuspend = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
  }
  const suspendWhenIdle = (): void => {
    cancelSuspend()
    idleTimer = setTimeout(() => {
      idleTimer = null
      if (!ctx || typeof ctx.suspend !== 'function' || ctx.state !== 'running') return
      if (state.value === 'playing' || state.value === 'resume' || state.value === 'loading') return
      suspendedHere = true
      void ctx.suspend().catch(() => {
        suspendedHere = false
      })
    }, SUSPEND_AFTER_MS)
  }
  /*
   * Kept in step with the state rather than called after each change of it:
   * anything not sounding, loading or about to sound starts the clock, and
   * anything that is stops it. Synchronous, so a caller can still overrule
   * it on the spot, as the end of a tune handed to the next one does.
   */
  watch(
    state,
    (now) => (now === 'playing' || now === 'resume' || now === 'loading' ? cancelSuspend() : suspendWhenIdle()),
    { flush: 'sync' }
  )
  /** Undoes that, before anything that needs the worklet to answer. */
  const wake = (): Promise<void> | undefined => {
    cancelSuspend()
    if (!ctx || !suspendedHere) return undefined
    suspendedHere = false
    // Called, not just awaited, before anything else: inside a click this
    // is still the gesture the browser wants to see.
    return withTimeout(ctx.resume(), 1000, 'Resuming the audio context').catch(() => undefined)
  }

  /**
   * Drops the worklet node and everything hanging off it, keeping the
   * AudioContext. The next `ensureGraph` builds a fresh node, which is the
   * only way back from an engine that refused to start.
   */
  const teardownGraph = () => {
    // Whoever is waiting on the start is waiting on a node that is going away.
    pending.get(0)?.reject(new Error('the audio graph was torn down'))
    pending.delete(0)
    if (node) {
      node.port.onmessage = null
      node.disconnect()
    }
    node = null
    gain?.disconnect()
    gain = null
    analyser.value?.disconnect()
    analyser.value = null
    engineReady = null
  }

  const ensureGraph = async (): Promise<void> => {
    if (!ctx) {
      ctx = new AudioContext()
      ctx.addEventListener('statechange', onContextState)
    }
    if (!moduleLoaded) {
      const url = resolveEngineUrl(config.engineBaseUrl, 'sid-processor.js')
      moduleLoaded = withTimeout(ctx.audioWorklet.addModule(url), ENGINE_BUDGET_MS, 'worklet load').catch(
        (e) => {
          moduleLoaded = null
          throw new SidPlayerError(
            'backend-unavailable',
            'The audio worklet could not be loaded. Check that vendor/sid-engine/ is deployed beside the app and that the content security policy allows it.',
            e
          )
        }
      )
    }
    // The worklet cannot fetch, so its files are fetched here, in parallel
    // with the processor script itself. Both are cached by the browser. Only
    // for a graph still to be built: a running engine already has them.
    if (!node && !assetsLoaded) {
      assetsLoaded = fetchEngineAssets(config.engineBaseUrl).catch((e) => {
        assetsLoaded = null
        throw e
      })
      // Awaited only once the worklet has loaded. When that fails first - an
      // engine directory that is not deployed fails both - nothing would ever
      // look at this one, and the browser reports it as an unhandled rejection.
      assetsLoaded.catch(() => undefined)
    }
    await moduleLoaded
    const loaded = !node && assetsLoaded ? await assetsLoaded : null
    // Asked again after the wait. Two tunes opened while the engine was
    // still arriving both got this far, and the second built a second node
    // over the first and sent it buffers the first had already taken.
    if (loaded && !node) {
      const { assets, transfer } = loaded
      // The buffers are about to be transferred and cannot be sent twice.
      assetsLoaded = null
      node = new AudioWorkletNode(ctx, 'sid-processor', { outputChannelCount: [2] })
      const an = ctx.createAnalyser()
      an.fftSize = 2048
      an.smoothingTimeConstant = 0.75
      gain = ctx.createGain()
      gain.gain.value = muted ? 0 : volume
      node.connect(an)
      an.connect(gain)
      gain.connect(ctx.destination)
      analyser.value = an

      engineReady = withTimeout(
        new Promise<void>((resolve, reject) => {
          pending.set(0, { resolve, reject })
        }),
        ENGINE_BUDGET_MS,
        'engine start'
      ).catch((e) => {
        /*
         * Tear the half-built graph down before rethrowing. A rejected
         * `engineReady` is cached like any other promise, so without this the
         * first failure - a 15 second wasm compile on a slow machine, a CSP
         * without 'wasm-unsafe-eval', a transient engine error - is permanent
         * for the life of the page: every later ensureGraph awaits the same
         * rejection and "Try again" can never rebuild.
         */
        teardownGraph()
        throw new SidPlayerError(
          'backend-unavailable',
          e instanceof SidPlayerError ? e.message : 'The SID engine did not start.',
          e
        )
      })
      node.port.onmessage = (event) => onMessage(event.data)
      post({ type: 'init', assets }, transfer)
      await engineReady
      // The worklet is new; tell it what the user had already chosen.
      post({ type: 'emulation', ...emulation })
      mutedVoices.value.forEach((on, voice) => {
        if (on) post({ type: 'mute', sid: 0, voice, on: true })
      })
    }
    await engineReady
  }

  const post = (msg: Record<string, unknown>, transfer?: Transferable[]) => {
    node?.port.postMessage(msg, transfer ?? [])
  }

  const onMessage = (msg: { type: string; id?: number; message?: string; frames?: number }) => {
    switch (msg.type) {
      case 'engine-ready':
        pending.get(0)?.resolve()
        pending.delete(0)
        return
      case 'engine-error':
        pending
          .get(0)
          ?.reject(new SidPlayerError('backend-unavailable', msg.message ?? 'The SID engine failed to start.'))
        pending.delete(0)
        return
      case 'loaded':
        if (msg.id !== undefined) {
          pending.get(msg.id)?.resolve()
          pending.delete(msg.id)
        }
        return
      case 'error':
        if (msg.id !== undefined) {
          pending
            .get(msg.id)
            ?.reject(new SidPlayerError('engine', msg.message ?? 'The tune could not be played.'))
          pending.delete(msg.id)
        } else if (state.value !== 'idle' && state.value !== 'loading') {
          // A render-time failure: the processor has already gone silent.
          fail(new SidPlayerError('engine', msg.message ?? 'The engine stopped.'))
        }
        return
      case 'position':
        // Not once the tune has been let go of: a position already on its
        // way then would put the old time back on an empty player.
        if (typeof msg.frames === 'number' && ctx && !switching && state.value !== 'idle') {
          position.value = msg.frames / ctx.sampleRate
          /*
           * A tune whose end is being listened for is ended by that and
           * nothing else. Its length is worked out from the score and is
           * close but not exact, so stopping on the clock would cut short
           * every tune the score underestimates - and the bar showing 100%
           * for a second or two is a far smaller sin than a tune being
           * clipped.
           *
           * Up to a point. A score that holds a note for ever, or never
           * sounds one, has no end to be heard, and sat in a running order
           * it stopped the order there. Twice the length the score works
           * out to, and never less than ten minutes, is past any real tune's
           * end and still an end.
           */
          const limit = endsOnSilence ? Math.max(2 * length.value, SILENCE_BACKSTOP_SECONDS) : length.value
          if (state.value === 'playing' && position.value >= limit) onSongEnd()
        }
        return
      /* The worklet heard the tune stop, which for a Sidplayer score is
       * the only trustworthy end there is. */
      case 'ended':
        if (state.value === 'playing' && !switching) onSongEnd()
        return
    }
  }

  /** Sends a load or subsong request and waits for the worklet to confirm it. */
  const request = (msg: Record<string, unknown>, transfer?: Transferable[]): Promise<void> => {
    const id = ++seq
    const answer = new Promise<void>((resolve, reject) => pending.set(id, { resolve, reject }))
    post({ ...msg, id }, transfer)
    return withTimeout(answer, LOAD_BUDGET_MS, 'tune load').finally(() => pending.delete(id))
  }

  /* ---- state machine ---------------------------------------------------- */

  /** Loads a tune. Ends in `ready`, silent; call `play()` to start. */
  const open = async (data: Uint8Array, parsed: SidHeader, startSubsong: number) => {
    endsOnSilence = parsed.format === 'MUS' || parsed.format === 'MUS+STR'
    state.value = 'loading'
    error.value = null
    position.value = 0
    header.value = parsed
    bytes = data
    switching = false
    subsong.value = Math.min(parsed.songs, Math.max(1, startSubsong))
    try {
      // Awake before the graph: a worklet node made on a suspended context
      // does not start until it runs, and the engine's start would time out.
      const waking = wake()
      if (waking) {
        await waking
        // Destroyed, unloaded or overtaken meanwhile: build nothing.
        if (bytes !== data) return
      }
      await ensureGraph()
      // Another open() may have started while the graph was coming up; the
      // identity of `bytes` says whose turn it is.
      if (bytes !== data) return
      post({ type: 'pause', paused: true })
      // A copy: the caller keeps its bytes for the next subsong change.
      const copy = data.slice().buffer
      await request(
        {
          type: 'load',
          bytes: copy,
          subsong: subsong.value,
          // A Sidplayer score has no length in it and often none anywhere
          // else, so the worklet listens for the end instead of guessing.
          endOnSilence: endsOnSilence
        },
        [copy]
      )
      if (bytes !== data) return
      state.value = 'ready'
    } catch (e) {
      if (bytes !== data) return
      fail(e instanceof SidPlayerError ? e : new SidPlayerError('engine', 'The tune could not be loaded.', e))
    }
  }

  const play = async () => {
    if (!ctx || !node || !header.value) return
    if (state.value === 'failed' || state.value === 'loading') return
    // A context suspended here for being idle takes the same road back as
    // one the browser suspended: resumed below, inside this press. Asked to
    // resume even if it still reads as running, since a suspend under way
    // does not say so until it has finished, and would then leave this
    // press waiting on a second one.
    const suspended = suspendedHere
    suspendedHere = false
    post({ type: 'pause', paused: false })
    // Read through a function: resume() can flip the state synchronously in
    // some browsers, and a direct re-read would be narrowed away by the type
    // checker as if nothing could have changed.
    const running = () => ctx?.state === 'running'
    if (!running() || suspended) {
      // Autoplay policy: resume() may hang until a gesture, so do not await it.
      void ctx.resume().catch(() => undefined)
      if (!running()) {
        // The pause flag was cleared above so the tune starts the instant the
        // context runs; `onContextState` flips to playing on that gesture.
        state.value = 'resume'
        updateMediaSession()
        return
      }
    }
    state.value = 'playing'
    updateMediaSession()
  }

  const pause = () => {
    // A failed player has nothing to resume, but Stop still has to be able to
    // silence it, whatever got it there.
    if (state.value === 'failed') {
      post({ type: 'pause', paused: true })
      return
    }
    if (state.value !== 'playing' && state.value !== 'resume') return
    post({ type: 'pause', paused: true })
    state.value = 'paused'
    if (navigator.mediaSession) navigator.mediaSession.playbackState = 'paused'
  }

  const toggle = () => {
    if (state.value === 'playing') pause()
    else void play()
  }

  /** Restarts the current subsong from the top, keeping the play/pause state. */
  const restart = () => setSubsong(subsong.value)

  const setSubsong = async (n: number) => {
    // Not while a tune is loading: the worklet may not exist yet, and a load
    // in flight is about to start the subsong it was given anyway.
    if (!header.value || !bytes || !node || state.value === 'loading') return
    const target = Math.min(header.value.songs, Math.max(1, n))
    const wasPlaying = state.value === 'playing' || state.value === 'resume'
    const data = bytes
    subsong.value = target
    position.value = 0
    // Which of previous and next there now are, whatever the state: paused,
    // nothing else would tell the OS controls the subsong had moved.
    updateMediaSession()
    switching = true
    try {
      const waking = wake()
      if (waking) await waking
      await request({ type: 'subsong', subsong: target })
      if (bytes !== data) return
      // By what the state is now, not only what it was: Pause or Play
      // pressed while the worklet was answering is the later instruction,
      // and going by the earlier one un-paused a tune just paused, or left
      // one just started marked as ready while it sounded.
      const going = state.value === 'playing' || state.value === 'resume'
      if (wasPlaying) {
        if (going) await play()
      } else if (!going && state.value !== 'failed') {
        state.value = 'ready'
        // Set again by hand: `ready` over `ready` changes nothing the watch
        // can see, and `wake` above has stopped the clock.
        suspendWhenIdle()
      }
    } catch (e) {
      if (bytes !== data) return
      fail(
        e instanceof SidPlayerError ? e : new SidPlayerError('engine', 'The subsong could not be started.', e)
      )
    } finally {
      if (bytes === data) switching = false
    }
  }

  const next = () => {
    if (canNext.value) void setSubsong(subsong.value + 1)
  }
  const previous = () => {
    if (canPrevious.value) void setSubsong(subsong.value - 1)
  }

  /**
   * The end of a subsong.
   *
   * The rest of this tune first: a file with several subsongs is played
   * through in order. Once the last one is done the tune is over, and
   * whoever owns the list decides what follows; if nothing does, it stops at
   * its beginning, ready to be played again.
   */
  const onSongEnd = () => {
    if (canNext.value) {
      next()
      return
    }
    if (options.onEnd?.()) {
      // Whoever took over may be a folder listing or a mirror fetch away from
      // the next tune. Quiet until then, or this tune plays on past its end
      // and every position report hands over again, skipping tunes.
      pause()
      // But not idle: the next tune is on its way, and a context suspended
      // meanwhile would need a gesture some browsers will not wait for.
      cancelSuspend()
      return
    }
    pause()
    void restart()
  }

  /* ---- emulation choices -------------------------------------------------- */

  /**
   * Chip and machine override. libsidplayfp rebuilds its chips and restarts
   * the tune when this changes, so a loaded tune is restarted through the
   * normal path to keep the position honest.
   */
  const setEmulation = (next: Emulation) => {
    const changed = next.model !== emulation.model || next.clock !== emulation.clock
    emulation = { ...next }
    if (!node) return
    post({ type: 'emulation', ...emulation })
    if (changed && header.value && bytes) void restart()
  }

  const setVoiceMuted = (voice: number, on: boolean) => {
    if (voice < 0 || voice > 2) return
    const next = [...mutedVoices.value]
    next[voice] = on
    mutedVoices.value = next
    post({ type: 'mute', sid: 0, voice, on })
  }
  const toggleVoice = (voice: number) => setVoiceMuted(voice, !mutedVoices.value[voice])

  /* ---- volume ------------------------------------------------------------ */

  const setVolume = (v: number) => {
    volume = Math.min(1, Math.max(0, v))
    applyLevel()
  }
  const setMuted = (m: boolean) => {
    muted = m
    applyLevel()
  }

  /* ---- media session --------------------------------------------------- */

  const updateMediaSession = () => {
    const ms = navigator.mediaSession
    const h = header.value
    if (!ms || !h) return
    try {
      ms.metadata = new MediaMetadata({
        title: options.title?.() || h.name || 'SID tune',
        artist: h.author,
        album: h.released
      })
      ms.playbackState = state.value === 'playing' ? 'playing' : 'paused'
      ms.setActionHandler('play', () => void play())
      ms.setActionHandler('pause', pause)
      ms.setActionHandler('previoustrack', canPrevious.value ? previous : null)
      ms.setActionHandler('nexttrack', canNext.value ? next : null)
    } catch {
      // Some browsers throw on unsupported actions; the session is decoration.
    }
  }

  /** Takes the tune off the OS media controls: no title, no keys that would reach it. */
  const clearMediaSession = () => {
    const ms = navigator.mediaSession
    if (!ms) return
    ms.metadata = null
    ms.playbackState = 'none'
    for (const a of ['play', 'pause', 'previoustrack', 'nexttrack'] as const) {
      try {
        ms.setActionHandler(a, null)
      } catch {
        /* unsupported action */
      }
    }
  }

  /* ---- teardown --------------------------------------------------------- */

  /**
   * Lets go of the tune, keeping the engine warm for the next one.
   *
   * Pausing was not enough to stop: the player kept the tune's header and
   * bytes, so a Play button still on screen - the library's bar, which stays
   * when the dock goes - or the OS media keys resumed the old tune under
   * "Nothing playing", and a tune that failed to open could be played as the
   * one before it under the new one's error. An open still in flight sees
   * its bytes gone and stands down, as it does for a newer open.
   */
  const unload = () => {
    post({ type: 'pause', paused: true })
    bytes = null
    header.value = null
    error.value = null
    position.value = 0
    switching = false
    state.value = 'idle'
    clearMediaSession()
  }

  const destroy = () => {
    seq++
    for (const p of pending.values()) p.reject(new Error('destroyed'))
    pending.clear()
    bytes = null
    header.value = null
    state.value = 'idle'
    teardownGraph()
    ctx?.removeEventListener('statechange', onContextState)
    void ctx?.close().catch(() => undefined)
    ctx = null
    moduleLoaded = null
    assetsLoaded = null
    clearMediaSession()
    // After the state, whose change to idle would otherwise set the clock.
    cancelSuspend()
  }

  return {
    state,
    error,
    header,
    subsong,
    songCount,
    position,
    length,
    analyser,
    mutedVoices,
    canPrevious,
    canNext,
    open,
    unload,
    play,
    pause,
    toggle,
    restart,
    next,
    previous,
    setVolume,
    setMuted,
    setEmulation,
    toggleVoice,
    destroy
  }
}
