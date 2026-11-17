/**
 * AudioWorkletProcessor that turns a SID engine into sound.
 *
 * This file is the stable half of the audio thread. The engine beside it
 * (`./engine.js`) is the swappable half: it is imported statically, because
 * AudioWorkletGlobalScope has no dynamic import, and it must export a
 * `createEngine({ sampleRate, assets })` factory. See docs/engine-contract.md.
 *
 * Nothing in this scope can fetch. Whatever files the engine needs (a .wasm
 * binary, ROM images) are fetched by the main thread according to
 * `engine.json` and arrive in the `init` message as `assets.files`.
 *
 * Messages in (from useSidPlayer):
 *   { type: 'init', assets: { files: { [name]: ArrayBuffer } } }   create the engine; answered once
 *   { type: 'load', id, bytes: ArrayBuffer, subsong, endOnSilence }  load a tune, start silent at frame 0
 *   { type: 'subsong', id, subsong }                               restart the loaded tune on another subsong
 *   { type: 'pause', paused: boolean }                             stop or resume advancing; position is kept
 *   { type: 'emulation', model, clock }                            chip/machine choice; ignored when it repeats the one in force
 *   { type: 'mute', sid, voice, on }                               per-voice mute, kept across loads
 *
 * Messages out:
 *   { type: 'engine-ready', version? } | { type: 'engine-error', message }   answer to init
 *   { type: 'loaded', id } | { type: 'error', id, message }                  per load/subsong request
 *   { type: 'error', message }                                               a render-time failure
 *   { type: 'position', frames }                                             about four times a second while playing
 *   { type: 'ended', frames }                                                 the tune fell silent for good (endOnSilence)
 */
import { createEngine } from './engine.js'

const POSITION_INTERVAL_DIVISOR = 4

/*
 * End-of-tune by listening, for formats that carry no length.
 *
 * A Compute!'s Sidplayer score ends with a HLT on every voice and the SID
 * then falls silent, which is the only end-of-tune signal there is:
 * libsidplayfp uses HLT to validate the file when it parses it and exposes
 * nothing at playback time, and the player it installs is a prebuilt 6502
 * binary with nothing to ask.
 *
 * The wait has to clear the longest rest *inside* a tune or a piece with a
 * dramatic pause would be cut off. Measured over a sample of the Compute's
 * Gazette collection, mid-tune gaps are under a second in twenty cases in
 * twenty-four, and the worst seen was 4.9 seconds - so eight seconds leaves
 * room without being long enough to sit through by accident. This is a
 * backstop: where the score has been read, the length from it arrives first
 * and this never fires.
 */
const SILENCE_LEVEL = 0.002
const SILENCE_SECONDS = 8

class SidProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.engine = null
    this.initialising = false
    this.bytes = null
    this.subsong = 1
    this.paused = true
    this.frames = 0
    this.sinceReport = 0
    this.reportEvery = Math.max(128, Math.floor(sampleRate / POSITION_INTERVAL_DIVISOR))
    /* Whether the loaded tune asked for its end to be listened for... */
    this.listen = false
    /* ...and whether this playing of it is still listening: off once it has ended. */
    this.endOnSilence = false
    /* What the engine was last actually configured with; see 'emulation'. */
    this.appliedModel = null
    this.appliedClock = null
    this.heardSomething = false
    this.quietFrames = 0
    this.silenceFrames = Math.floor(sampleRate * SILENCE_SECONDS)
    this.port.onmessage = (event) => this.onMessage(event.data)
  }

  onMessage(msg) {
    if (!msg || typeof msg !== 'object') return
    switch (msg.type) {
      case 'init':
        this.init(msg.assets)
        return
      case 'load':
        this.bytes = new Uint8Array(msg.bytes)
        this.subsong = msg.subsong
        this.listen = !!msg.endOnSilence
        this.restart(msg.id, true)
        return
      case 'subsong':
        this.subsong = msg.subsong
        // Not silenced: a subsong change keeps whatever the transport was
        // doing, which is what makes "next subsong" continue playing.
        this.restart(msg.id)
        return
      case 'pause':
        this.paused = !!msg.paused
        return
      case 'emulation': {
        /*
         * Only when the choice has actually changed. libsidplayfp's
         * Player::config returns early when the new configuration compares
         * equal to the old one, so a repeat of the current choice restarts
         * nothing - but the adapter still drops the frames it has buffered
         * and this still reset the clock to zero, which reads as a jump back
         * to 0:00 and about 11ms of silence for no reason at all. The main
         * thread sends this on every graph build and on every preferences
         * change, several of which are no-ops.
         */
        const model = msg.model || 'auto'
        const clock = msg.clock || 'auto'
        if (model === this.appliedModel && clock === this.appliedClock) return
        if (this.engine && this.engine.setEmulation) {
          try {
            this.engine.setEmulation({ model, clock })
            this.appliedModel = model
            this.appliedClock = clock
            this.frames = 0
            this.sinceReport = 0
          } catch (error) {
            // The engine keeps its previous configuration; the main thread
            // fails the player on an error with no id, so go quiet with it.
            this.paused = true
            this.port.postMessage({ type: 'error', message: describe(error) })
          }
        }
        return
      }
      case 'mute':
        if (this.engine && this.engine.mute) {
          try {
            this.engine.mute(msg.sid | 0, msg.voice | 0, !!msg.on)
          } catch (error) {
            this.port.postMessage({ type: 'error', message: describe(error) })
          }
        }
        return
    }
  }

  init(assets) {
    if (this.engine || this.initialising) return
    this.initialising = true
    Promise.resolve()
      .then(() => createEngine({ sampleRate, assets: assets || { files: {} } }))
      .then((engine) => {
        this.engine = engine
        this.initialising = false
        this.port.postMessage({ type: 'engine-ready', version: engine.version || null })
      })
      .catch((error) => {
        this.initialising = false
        this.port.postMessage({ type: 'engine-error', message: describe(error) })
      })
  }

  /**
   * Loads the current bytes at the current subsong.
   *
   * `silent` is set for a `load` and not for a `subsong`, which is the
   * difference the header promises: a new tune starts silent at frame 0 and
   * waits to be told to play, while moving between subsongs of the tune
   * already playing carries on playing.
   *
   * Doing it here rather than leaving it to the main thread alone is what
   * makes the failure path right: when `sid_load` fails the shim restores the
   * previously loaded tune, so without this the old tune carries on playing
   * underneath the error message the user is being shown.
   */
  restart(id, silent = false) {
    if (silent) this.paused = true
    if (!this.engine) {
      this.port.postMessage({ type: 'error', id, message: 'The SID engine is not available.' })
      return
    }
    if (!this.bytes) {
      this.port.postMessage({ type: 'error', id, message: 'No tune is loaded.' })
      return
    }
    try {
      this.engine.load(this.bytes, this.subsong)
      this.frames = 0
      this.sinceReport = 0
      this.heardSomething = false
      this.quietFrames = 0
      // Every start listens again: the main thread restarts an ended tune
      // through 'subsong', and that playing has to end as well.
      this.endOnSilence = this.listen
      this.port.postMessage({ type: 'loaded', id })
    } catch (error) {
      this.port.postMessage({ type: 'error', id, message: describe(error) })
    }
  }

  /**
   * Reports the end once the output has been quiet long enough, having been
   * loud at some point first - a tune that has not started yet is quiet too.
   */
  listenForTheEnd(left, right) {
    let peak = 0
    for (let i = 0; i < left.length; i++) {
      const v = left[i] < 0 ? -left[i] : left[i]
      if (v > peak) peak = v
    }
    if (right !== left) {
      for (let i = 0; i < right.length; i++) {
        const v = right[i] < 0 ? -right[i] : right[i]
        if (v > peak) peak = v
      }
    }
    if (peak > SILENCE_LEVEL) {
      this.heardSomething = true
      this.quietFrames = 0
      return
    }
    if (!this.heardSomething) return
    this.quietFrames += left.length
    if (this.quietFrames < this.silenceFrames) return
    // Once per playing: the tune is over and the main thread decides what
    // follows. A restart listens again.
    this.endOnSilence = false
    this.port.postMessage({ type: 'ended', frames: this.frames - this.quietFrames })
  }

  process(_inputs, outputs) {
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const left = output[0]
    const right = output.length > 1 ? output[1] : left

    if (this.paused || !this.engine || !this.bytes) {
      // Silence. The buffers arrive zeroed, so nothing to do.
      return true
    }

    try {
      this.engine.render(left, right)
    } catch (error) {
      this.paused = true
      this.port.postMessage({ type: 'error', message: describe(error) })
      return true
    }
    if (right !== left && this.engine.mono) {
      right.set(left)
    }

    if (this.endOnSilence) this.listenForTheEnd(left, right)

    this.frames += left.length
    this.sinceReport += left.length
    if (this.sinceReport >= this.reportEvery) {
      this.sinceReport = 0
      this.port.postMessage({ type: 'position', frames: this.frames })
    }
    return true
  }
}

function describe(error) {
  if (error && typeof error.message === 'string') return error.message
  return String(error)
}

registerProcessor('sid-processor', SidProcessor)
