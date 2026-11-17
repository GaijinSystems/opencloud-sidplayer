/**
 * SID engine adapter: libsidplayfp (reSIDfp) compiled to WebAssembly.
 *
 * Runs on the audio thread inside `sid-processor.js`. The binary is built by
 * `source/engine/build.sh` from a small C shim (`source/engine/shim.cpp`)
 * around libsidplayfp, as a standalone WASI-flavoured module with no
 * JavaScript glue. This file supplies the handful of WASI imports the module
 * asks for, moves bytes in and out of its memory, and adapts the C API to
 * the engine contract in docs/engine-contract.md.
 *
 * Assets arrive from the main thread, which fetched them according to
 * `engine.json`: `libsidplayfp.wasm` is required; `kernal.bin`, `basic.bin`
 * and `chargen.bin` are optional C64 ROM images. Without a kernal, PSID
 * tunes play (libsidplayfp has a built-in player driver) but RSID tunes and
 * BASIC tunes report an error naming the missing ROM.
 *
 * Deliberately no `TextDecoder` dependency and no `console` dependency:
 * neither is guaranteed in every AudioWorkletGlobalScope.
 */

const WASM_FILE = 'libsidplayfp.wasm'
const ROMS = [
  { file: 'kernal.bin', size: 8192 },
  { file: 'basic.bin', size: 8192 },
  { file: 'chargen.bin', size: 4096 }
]
/**
 * libsidplayfp's mixer works in chunks of 5000 C64 cycles, about 224 frames
 * at 44.1 kHz. A play() call for fewer samples than that never runs the CPU
 * and returns silence, so the adapter renders in bursts of this many frames
 * and serves the worklet's 128-frame quanta from the remainder. Measured at
 * about 1.5 ms of compute per burst in V8, against a 2.9 ms quantum budget.
 */
const CHUNK_FRAMES = 512

const REQUIRED_EXPORTS = [
  'memory',
  'malloc',
  'free',
  'sid_create',
  'sid_destroy',
  'sid_set_roms',
  'sid_load',
  'sid_render',
  'sid_error',
  'sid_version',
  'sid_mute',
  'sid_set_model',
  'sid_set_clock'
]

export async function createEngine({ sampleRate, assets }) {
  const files = (assets && assets.files) || {}
  const wasm = files[WASM_FILE]
  if (!wasm) {
    throw new Error(
      `${WASM_FILE} is not deployed beside engine.js. Build it with source/engine/build.sh and redeploy.`
    )
  }

  const module = await WebAssembly.compile(wasm)
  const runtime = new Runtime()
  const instance = await WebAssembly.instantiate(module, runtime.imports(module))
  runtime.attach(instance)
  const ex = instance.exports

  for (const name of REQUIRED_EXPORTS) {
    if (!(name in ex)) {
      throw new Error(`${WASM_FILE} does not export ${name}; it was not built from this app's shim.cpp.`)
    }
  }
  // A standalone "reactor" module runs its static constructors on demand.
  if (typeof ex._initialize === 'function') ex._initialize()

  const handle = ex.sid_create(sampleRate | 0)
  if (!handle) {
    throw new Error(`libsidplayfp could not start: ${runtime.cstring(ex.sid_error())}${runtime.stderrTail()}`)
  }

  const engine = new LibsidplayfpEngine(ex, runtime, handle)
  engine.setRoms(files)
  return engine
}

class LibsidplayfpEngine {
  constructor(ex, runtime, handle) {
    this.ex = ex
    this.rt = runtime
    this.handle = handle
    this.mono = false
    this.version = `libsidplayfp ${runtime.cstring(ex.sid_version(handle))}`
    this.dataPtr = 0
    this.dataCap = 0
    this.outPtr = ex.malloc(CHUNK_FRAMES * 4) // stereo int16
    if (!this.outPtr) throw new Error('libsidplayfp: out of memory for the output buffer')
    /** A view of outPtr, kept while the heap's buffer is the same one. */
    this.pcm = null
    /** Frames rendered into outPtr but not yet handed to the worklet. */
    this.pos = 0
    this.avail = 0
    /** Which ROM images were accepted, for the RSID check in load(). */
    this.roms = { kernal: false, basic: false, chargen: false }
    /**
     * Muted voices, kept here because libsidplayfp rebuilds its chips on
     * every load and forgets. Re-applied after each sid_load.
     */
    this.muted = new Set()
  }

  /**
   * Chip and machine choice. `model`: 'auto' follows the header (6581 where
   * it says nothing), '6581' or '8580' override it. `clock`: 'auto', 'pal',
   * 'ntsc' likewise. libsidplayfp restarts a loaded tune when this changes.
   */
  setEmulation({ model = 'auto', clock = 'auto' } = {}) {
    const m = model === '8580' ? 2 : 1
    const c = clock === 'ntsc' ? 2 : 1
    if (this.ex.sid_set_model(this.handle, m, model === 'auto' ? 0 : 1) < 0) {
      throw new Error(`libsidplayfp: ${this.rt.cstring(this.ex.sid_error())}`)
    }
    if (this.ex.sid_set_clock(this.handle, c, clock === 'auto' ? 0 : 1) < 0) {
      throw new Error(`libsidplayfp: ${this.rt.cstring(this.ex.sid_error())}`)
    }
    this.pos = 0
    this.avail = 0
    this.applyMutes()
  }

  /** Mutes or unmutes voice 0..2 of SID 0..2. Survives loads and subsong changes. */
  mute(sid, voice, on) {
    const key = sid * 3 + voice
    if (on) this.muted.add(key)
    else this.muted.delete(key)
    this.ex.sid_mute(this.handle, sid, voice, on ? 1 : 0)
  }

  applyMutes() {
    for (const key of this.muted) this.ex.sid_mute(this.handle, Math.floor(key / 3), key % 3, 1)
  }

  /** Hands whichever ROM images were supplied to the emulator, checking sizes. */
  setRoms(files) {
    const ptrs = ROMS.map(({ file, size }) => {
      const buf = files[file]
      if (!buf) return 0
      if (buf.byteLength !== size) {
        this.rt.note(`${file} is ${buf.byteLength} bytes, expected ${size}; ignored`)
        return 0
      }
      const ptr = this.ex.malloc(size)
      // A failed malloc returns 0, and writing 8 kB of ROM at address 0
      // would corrupt whatever the module keeps at the bottom of its heap.
      // `load` below already guards its own allocation this way.
      if (!ptr) {
        this.rt.note(`no room for ${file}; ignored`)
        return 0
      }
      this.rt.heap().set(new Uint8Array(buf), ptr)
      this.roms[file.replace('.bin', '')] = true
      return ptr
    })
    if (ptrs.some(Boolean)) {
      this.ex.sid_set_roms(this.handle, ptrs[0], ptrs[1], ptrs[2])
    }
    // The shim copies the images; these buffers are no longer needed.
    for (const p of ptrs) if (p) this.ex.free(p)
  }

  load(bytes, subsong) {
    // libsidplayfp has no "ROM missing" error: without a kernal it installs a
    // stub that suits PSID tunes and lets an RSID tune run into nothing, so
    // the refusal has to happen here, where it can say what is missing.
    const isRsid = bytes[0] === 0x52 && bytes[1] === 0x53 // 'RS'
    if (isRsid) {
      const version = (bytes[4] << 8) | bytes[5]
      const flags = version >= 2 && bytes.length > 0x77 ? (bytes[0x76] << 8) | bytes[0x77] : 0
      if (!this.roms.kernal) {
        throw new Error(
          'This is an RSID tune, which needs the real C64 kernal ROM. Install kernal.bin (8192 bytes) beside the engine to play it.'
        )
      }
      if (flags & 0x02 && !this.roms.basic) {
        throw new Error(
          'This tune is a C64 BASIC program and needs the BASIC ROM. Install basic.bin (8192 bytes) beside the engine to play it.'
        )
      }
    }
    if (this.dataCap < bytes.length) {
      if (this.dataPtr) this.ex.free(this.dataPtr)
      this.dataPtr = this.ex.malloc(bytes.length)
      // The capacity only once there is a buffer to have it. Recorded before
      // the check, a failed allocation left a pointer of 0 claiming room for
      // the tune, and the next smaller one was written over address 0.
      if (!this.dataPtr) {
        this.dataCap = 0
        throw new Error('libsidplayfp: out of memory loading the tune')
      }
      this.dataCap = bytes.length
    }
    this.rt.heap().set(bytes, this.dataPtr)
    const rc = this.ex.sid_load(this.handle, this.dataPtr, bytes.length, subsong | 0)
    // Whatever was rendered ahead belongs to the previous tune or subsong.
    this.pos = 0
    this.avail = 0
    if (rc < 0) {
      throw new Error(`libsidplayfp: ${this.rt.cstring(this.ex.sid_error())}${this.rt.stderrTail()}`)
    }
    this.applyMutes()
  }

  render(left, right) {
    const frames = left.length
    const scale = 1 / 32768
    let i = 0
    while (i < frames) {
      if (this.avail === 0) {
        const got = this.ex.sid_render(this.handle, this.outPtr, CHUNK_FRAMES)
        if (got < 0) {
          throw new Error(`libsidplayfp: ${this.rt.cstring(this.ex.sid_error())}${this.rt.stderrTail()}`)
        }
        if (got === 0) break // the player stopped; pad with silence below
        this.pos = 0
        this.avail = got
      }
      // Made again only when the heap has grown and detached the old buffer;
      // otherwise one view serves every render, 375 times a second.
      if (!this.pcm || this.pcm.buffer !== this.rt.memory.buffer) {
        this.pcm = new Int16Array(this.rt.memory.buffer, this.outPtr, CHUNK_FRAMES * 2)
      }
      const pcm = this.pcm
      const n = Math.min(frames - i, this.avail)
      for (let k = 0; k < n; k++) {
        const s = (this.pos + k) * 2
        left[i + k] = pcm[s] * scale
        right[i + k] = pcm[s + 1] * scale
      }
      i += n
      this.pos += n
      this.avail -= n
    }
    for (; i < frames; i++) {
      left[i] = 0
      right[i] = 0
    }
  }

  dispose() {
    if (this.dataPtr) this.ex.free(this.dataPtr)
    if (this.outPtr) this.ex.free(this.outPtr)
    this.ex.sid_destroy(this.handle)
    this.handle = 0
  }
}

/**
 * The minimum of WASI a standalone Emscripten module needs to exist: no
 * files, no environment, no clock worth the name. Anything written to stdout
 * or stderr is kept in a short tail and appended to error messages, which is
 * the only place the audio thread can reliably show it.
 */
class Runtime {
  constructor() {
    this.memory = null
    this.tail = ''
  }

  attach(instance) {
    this.memory = instance.exports.memory
  }

  heap() {
    return new Uint8Array(this.memory.buffer)
  }

  view() {
    return new DataView(this.memory.buffer)
  }

  cstring(ptr) {
    if (!ptr) return ''
    const heap = this.heap()
    let end = ptr
    while (end < heap.length && heap[end] !== 0) end++
    return latin1(heap.subarray(ptr, end))
  }

  note(text) {
    this.tail = (this.tail + text + '\n').slice(-2000)
  }

  stderrTail() {
    const t = this.tail.trim()
    return t ? ` (${t.split('\n').slice(-3).join(' | ')})` : ''
  }

  /**
   * Builds the import object from what the module actually asks for, so a
   * rebuild with slightly different flags does not fail on a missing name.
   * Known WASI calls get a working stub; anything else gets a function that
   * throws a message naming it.
   */
  imports(module) {
    const rt = this
    const ENOSYS = 52
    const EBADF = 8
    const wasi = {
      fd_write(fd, iovs, count, nwritten) {
        const dv = rt.view()
        const heap = rt.heap()
        let total = 0
        let text = ''
        for (let i = 0; i < count; i++) {
          const ptr = dv.getUint32(iovs + i * 8, true)
          const len = dv.getUint32(iovs + i * 8 + 4, true)
          text += latin1(heap.subarray(ptr, ptr + len))
          total += len
        }
        dv.setUint32(nwritten, total, true)
        if (text) rt.note(text.replace(/\n$/, ''))
        return 0
      },
      fd_read: () => EBADF,
      fd_close: () => 0,
      fd_seek: () => EBADF,
      fd_fdstat_get: () => EBADF,
      fd_prestat_get: () => EBADF,
      fd_prestat_dir_name: () => EBADF,
      path_open: () => ENOSYS,
      environ_sizes_get(countPtr, sizePtr) {
        const dv = rt.view()
        dv.setUint32(countPtr, 0, true)
        dv.setUint32(sizePtr, 0, true)
        return 0
      },
      environ_get: () => 0,
      args_sizes_get(countPtr, sizePtr) {
        const dv = rt.view()
        dv.setUint32(countPtr, 0, true)
        dv.setUint32(sizePtr, 0, true)
        return 0
      },
      args_get: () => 0,
      clock_time_get(_id, _precision, outPtr) {
        rt.view().setBigUint64(outPtr, BigInt(Date.now()) * 1000000n, true)
        return 0
      },
      clock_res_get(_id, outPtr) {
        rt.view().setBigUint64(outPtr, 1000000n, true)
        return 0
      },
      random_get(ptr, len) {
        const heap = rt.heap()
        for (let i = 0; i < len; i++) heap[ptr + i] = (Math.random() * 256) | 0
        return 0
      },
      sched_yield: () => 0,
      proc_exit(code) {
        throw new Error(`libsidplayfp.wasm called exit(${code})${rt.stderrTail()}`)
      }
    }

    const out = {}
    for (const { module: mod, name, kind } of WebAssembly.Module.imports(module)) {
      out[mod] = out[mod] || {}
      if (kind !== 'function') {
        throw new Error(
          `${WASM_FILE} imports ${kind} ${mod}.${name}; build it standalone (no imported memory or table).`
        )
      }
      if (mod === 'wasi_snapshot_preview1' && wasi[name]) {
        out[mod][name] = wasi[name]
      } else if (mod === 'env' && name === 'emscripten_notify_memory_growth') {
        out[mod][name] = () => {}
      } else {
        out[mod][name] = () => {
          throw new Error(`${WASM_FILE} needs an import this adapter does not provide: ${mod}.${name}`)
        }
      }
    }
    return out
  }
}

function latin1(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return s
}
