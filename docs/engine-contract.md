# The SID engine contract

The player is split across two threads. The main thread
(`src/composables/useSidPlayer.ts`) owns the AudioContext, the graph and the
state machine. The audio thread runs `public/vendor/sid-engine/sid-processor.js`,
an `AudioWorkletProcessor`, which imports the emulator adapter from
`./engine.js` beside it.

`engine.js` and whatever it needs are the only things that change when the
emulator changes. The shipped adapter wraps libsidplayfp compiled to
WebAssembly; `source/engine/` holds the shim and build script.

## The audio thread cannot fetch

An `AudioWorkletGlobalScope` has no `fetch`, no `XMLHttpRequest`, and does
not guarantee `console` or `TextDecoder`. So the main thread fetches the
engine's files and hands them over in an `init` message. Which files is
declared in `engine.json` beside the processor:

```json
{
  "name": "libsidplayfp",
  "files": ["libsidplayfp.wasm"],
  "optional": ["kernal.bin", "basic.bin", "chargen.bin"],
  "build": {
    "libsidplayfp": "2.6.0",
    "emsdk": "3.1.74",
    "wasmSha256": "81d5c1f2…"
  }
}
```

`files` are required; a missing one is an error the user sees, naming the
file. `optional` ones are fetched if present and skipped otherwise. Names
must be bare file names in the same directory. No `engine.json` at all means
an engine that needs nothing.

`build` is not read at runtime. `source/engine/build.sh` writes it, refuses a
build that does not reproduce a hash already recorded there, and
`scripts/prune-dist.mjs` checks `wasmSha256` against the binary in `dist/`,
failing the build on a mismatch, so a stale or foreign wasm stops looking
exactly like the right one. `prune-dist.mjs` also deletes anything in
`vendor/sid-engine/` that neither list names: everything in that directory is
served to browsers unauthenticated, and three unreferenced copies of the
copyrighted ROMs shipped in a release that way.

## What `engine.js` must export

```js
export function createEngine({ sampleRate, assets }) // → Engine | Promise<Engine>
```

Called once per worklet node, on the audio thread, after `init` arrives.
`assets.files` maps each fetched name to an `ArrayBuffer`. Returning a promise
is expected: this is where a `.wasm` is compiled and instantiated, so the
processor's readiness message reflects a real engine.

```ts
interface Engine {
  /** Whole SID file, header included. `subsong` is 1-based as the header numbers them. */
  load(bytes: Uint8Array, subsong: number): void
  /** Fill both buffers (128 frames each under current browsers) with -1..1 samples. */
  render(left: Float32Array, right: Float32Array): void
  /** Optional. When true the processor copies `left` into `right`. */
  mono?: boolean
  /** Optional. Reported to the main thread as `engineVersion`. */
  version?: string
  /** Optional. Chip and machine override; may restart the loaded tune. */
  setEmulation?(choice: { model: 'auto' | '6581' | '8580'; clock: 'auto' | 'pal' | 'ntsc' }): void
  /** Optional. Mute voice 0..2 of SID 0..2, at once; must survive `load`. */
  mute?(sid: number, voice: number, on: boolean): void
  /**
   * Optional. Nothing in the app calls this today: `useSidPlayer.destroy()`
   * disconnects the worklet node and drops it, and the whole
   * AudioWorkletGlobalScope goes with the context, so an engine that only
   * holds wasm memory needs no teardown. Implement it if yours holds
   * something the garbage collector will not reclaim, and expect it to be
   * called once the main thread starts sending a `dispose` message; do not
   * rely on it for correctness now.
   */
  dispose?(): void
}
```

`load` is also what a subsong change and a restart call, so it must fully
reset emulation state. Throwing from `createEngine` is reported once as the
engine failing to start; throwing from `load` is reported per request;
throwing from `render` silences the processor and puts the UI in the failed
state with the message.

## Messages, for reference

| Direction | Message | Meaning |
|---|---|---|
| in | `{ type: 'init', assets }` | Create the engine. `assets.files` buffers are transferred. |
| in | `{ type: 'load', id, bytes, subsong, endOnSilence }` | Load a tune, start paused at frame 0. `bytes` is a transferred ArrayBuffer. `endOnSilence` asks the processor to watch for the end; see below. |
| in | `{ type: 'subsong', id, subsong }` | Restart the loaded tune on another subsong. |
| in | `{ type: 'pause', paused }` | Stop or resume advancing; position is kept. |
| in | `{ type: 'emulation', model, clock }` | Chip (`auto`, `6581`, `8580`) and machine (`auto`, `pal`, `ntsc`). The engine may restart the tune. |
| in | `{ type: 'mute', sid, voice, on }` | Per-voice mute; the engine keeps it across loads. |
| out | `{ type: 'engine-ready', version }` / `{ type: 'engine-error', message }` | Once, after `createEngine` settles. |
| out | `{ type: 'loaded', id }` / `{ type: 'error', id, message }` | Answer to a load or subsong request. |
| out | `{ type: 'error', message }` | A render-time failure, no id. |
| out | `{ type: 'position', frames }` | About four times a second while playing. |
| out | `{ type: 'ended', frames }` | Once per load, and only when that load asked for `endOnSilence`: the tune has fallen silent for good. `frames` is where the silence began, not where it was noticed. |

Every request from the main thread carries a timeout (`helpers/async.ts`),
because a worklet whose runtime aborted never answers, and the alternative is
a spinner forever. The engine start budget is generous (15 s) because it
includes compiling the WebAssembly.

## Ending a tune by listening

Most tunes end when the player reaches the length HVSC lists for them. A
Compute!'s Sidplayer score has no such entry and no length in the file: it ends
with a HLT on every voice and the SID falls silent, and libsidplayfp uses HLT
to validate the file at parse time and exposes nothing at playback time. So the
main thread sets `endOnSilence` on the `load` for those tunes and the processor
listens: once it has heard anything above 0.002 peak, eight seconds under it
means the tune is over and it posts `ended` once. Eight seconds is a backstop
chosen from the collection itself - mid-tune rests run under a second in twenty
of twenty-four tunes sampled and the worst was 4.9 s - and where the score has
been read the real length arrives first and this never fires.

This is the part of the protocol most likely to be missed by a processor from
an older deployment, which is why the engine files are versioned; see below.

## The libsidplayfp adapter

`engine.js` expects a standalone WASI-style module with plain C exports,
which is what `source/engine/build.sh` produces:

- It compiles the module with `WebAssembly.compile`, reads the import list
  with `WebAssembly.Module.imports()`, and supplies stubs for the WASI calls
  libc asks for. Output written to stdout or stderr is kept in a short tail
  and appended to error messages, since the audio thread has nowhere else to
  show it.
- It calls `_initialize` (static constructors), then `sid_create(sampleRate)`.
- ROM images with the right sizes are copied into the module's memory and
  passed to `sid_set_roms`; the shim copies them again, so the buffers are
  freed immediately.
- `load` copies the SID bytes into a reused allocation and calls `sid_load`.
  Before that it refuses RSID tunes when no kernal image was supplied, and
  BASIC tunes when no BASIC image was, naming the file to install:
  libsidplayfp itself has no such error and would run the tune into a stub.
- `render` fills the worklet's quantum from a FIFO that `sid_render` refills
  in 512-frame bursts. libsidplayfp's mixer works in 5000-cycle chunks, about
  224 frames at 44.1 kHz, and a `play()` for fewer samples than one chunk
  runs nothing and returns silence; 128-frame quanta therefore cannot be
  rendered directly. Views over the module's memory are created per burst,
  because the memory can grow and detach old views.

- `mute` reaches reSIDfp's own per-voice mute, with a patch applied to it from
  `source/engine/patches/`: upstream defers a mute to the tune's next write of
  that voice's control register, which never comes in a tune that programs a
  voice once, so the mute is taken at the mixing stage instead and ramped over
  about 4 ms to keep the 6581's per-voice DC pedestal from thumping.

- A second patch in the same directory seeds reSIDfp's `ExternalFilter` - the
  C64's DC blocker - from the first sample after a reset. Upstream starts it
  uncharged, which passed the chip's DC pedestal through for about a second,
  and since 2.6.0 amplified the signal path there was no headroom for it: the
  first second of an 8580 tune clipped. Resets happen on every tune switch and
  every subsong change, so this is per track, not per session.

  `build.sh` applies every patch in that directory on a fresh extract, in
  order, and fails the build if one does not apply exactly.

The C API is documented in `source/engine/README.md`.

## Upgrading in place, and why the engine URLs carry a version

`sid-processor.js`, `engine.js`, `engine.json` and `libsidplayfp.wasm` keep
fixed names and are overwritten where they stand by an upgrade, while the app's
own entry chunk is content-hashed and changes name with every build. So a
browser that has the old worklet cached and fetches a new wasm pairs two halves
of different releases, and nothing in the protocol detects it.

The `ended` / `endOnSilence` exchange above is exactly that hazard: a cached
processor from before it existed ignores the field, never sends `ended`, and a
Sidplayer tune plays for ever under a player waiting for a message that is
never coming.

What closes it:

- `scripts/prune-dist.mjs` writes `<version>-<commit>` into the manifest's
  `config` block as `buildTag`. The web service merges `manifest.config` into
  the app's `applicationConfig`, so it reaches the running app with no new
  plumbing.
- `src/helpers/assetUrl.ts` appends it to every engine URL it builds as `?v=`,
  which covers `sid-processor.js` (added by URL through `addModule`),
  `engine.json`, the wasm and the ROM images.
- `prune-dist.mjs` also rewrites the worklet's own `import … from './engine.js'`
  in `dist/` to carry the same `?v=`. That import is static, because an
  AudioWorkletGlobalScope has no dynamic import, and a relative specifier
  resolved against `sid-processor.js?v=…` would otherwise drop the query and
  leave the adapter the one unversioned file.

The file under `public/` keeps the plain specifier so `scripts/verify-engine.mjs`
and the dev server can load it from disk.

## What the engine is handed

The main thread decides what bytes go to `load`, in `src/sid/openTune.ts`:

- A PSID or RSID file goes as is.
- A Sidplayer `.mus` goes as is; libsidplayfp tries PSID then MUS on any
  buffer. When a `.str` with the same base name sits in the same folder, its
  bytes are appended directly after the `.mus` credits, which is the layout
  libsidplayfp's MUS loader recognises as a stereo pair ("for MUS + STR via
  stdin the files come combined"). A `.wds` beside them is not sent to the
  engine at all; its text is shown by the UI.
- Clicking a `.str` or `.wds` opens the `.mus` they belong to.

The engine never sees a file name, so the format has to be decidable from
the bytes, and it is.

## Content security policy

WebAssembly compilation needs `'wasm-unsafe-eval'` in `script-src`; see
`deploy/csp.yaml`. The shim uses plain `extern "C"` exports rather than
Embind precisely so the broader `'unsafe-eval'` is not needed.

## Song lengths

A SID has no natural end. The player stops a subsong at its known length and
then moves on to the next subsong, or to the next tune in the list. Lengths come from HVSC's `Songlengths.md5`
(`src/sid/songlengths.ts`), keyed by the MD5 of the whole file as HVSC has
done since release 68, which `SonglengthsSource` looks for up the folder tree
from the tune and then at `songlengthsUrl`. The lookup runs after playback
has started and the player reads the result live through
`PlayerOptions.songLength(header, subsong)`, so a tune starts on
`defaultSongLengthSeconds` and takes the real length when the database
answers. The engine is not involved.
