# Building the libsidplayfp engine

`build.sh` produces `public/vendor/sid-engine/libsidplayfp.wasm` from a
pinned libsidplayfp release plus `shim.cpp`. The output is a standalone
WebAssembly module with WASI imports and no JavaScript glue, which is what
`engine.js` expects.

```
source /path/to/emsdk/emsdk_env.sh
./build.sh
```

Then `npm run build` in `source/` so `dist/` picks up the binary.

## Why standalone, and why no Embind

The module is instantiated inside an `AudioWorkletGlobalScope`, which has no
`fetch`, no DOM, and no guarantee of `console` or `TextDecoder`. Emscripten's
usual JavaScript glue assumes a browser or worker environment and does not
run there. A standalone module needs only an import object, and `engine.js`
builds that from `WebAssembly.Module.imports()`, stubbing the handful of WASI
calls libc wants (`fd_write`, `environ_sizes_get`, `clock_time_get`, …).

Embind would generate its C++/JS wrappers with `new Function()`, which needs
`'unsafe-eval'` in the content security policy. Plain `extern "C"` exports
need only `'wasm-unsafe-eval'`, which permits WebAssembly compilation and
nothing else.

## What shim.cpp exposes

| Export | Purpose |
|---|---|
| `sid_create(sampleRate)` | Engine handle, reSIDfp, stereo, interpolated sampling. 0 on failure. |
| `sid_set_roms(e, kernal, basic, chargen)` | Optional ROM images; any may be 0. |
| `sid_load(e, data, length, subsong)` | Whole SID file; returns the selected subsong or −1. Resets emulation. |
| `sid_render(e, out, frames)` | Interleaved stereo int16; returns frames produced or −1. |
| `sid_error()` | Last error message. |
| `sid_version(e)` | libsidplayfp's version string. |
| `sid_time(e)` | Emulated seconds since load. |
| `sid_mute(e, sid, voice, mute)` | Per-voice mute, applied where the voices are mixed. |
| `sid_set_model(e, model, force)` | Chip: 1 MOS6581, 2 MOS8580. `force` overrides the tune's header; otherwise it only fills in for headers that do not say. Restarts a loaded tune. 0, or −1. |
| `sid_set_clock(e, clock, force)` | Machine: 1 PAL, 2 NTSC, `force` as above. Restarts a loaded tune. 0, or −1. |
| `sid_destroy(e)` | |
| `malloc`, `free` | For the adapter to place bytes in the module's memory. |

`docs/engine-contract.md` points here for the C API, so any `sid_*` function
added to `shim.cpp` - which is what `build.sh` exports - belongs in this table.

## ROM images

libsidplayfp plays PSID tunes without any ROM. RSID tunes, and PSID tunes
flagged as BASIC, need the C64 kernal (and BASIC) images. The repository
carries `kernal.bin` (8192 bytes), `basic.bin` (8192) and `chargen.bin` (4096)
in `public/vendor/sid-engine/`; they are Commodore's, not this project's, and
`THIRD-PARTY-NOTICES.txt` says so. `engine.json` lists them as optional and the
adapter checks their sizes, so removing them leaves a player for PSID tunes.

## Pinning

Three things are pinned, and all three end up recorded rather than assumed.

`LIBSIDPLAYFP_VERSION` defaults to 2.6.0 and `LIBSIDPLAYFP_SHA256` already
carries the checksum of that tarball, so a download that differs stops the
build. Setting the variable empty skips the check and prints the hash of what
arrived, which is how you get the value for a new version.

`EMSDK_VERSION` defaults to 3.1.74, and `build.sh` reads `emcc --version` and
refuses to build with anything else. Two Emscripten versions produce different
bytes from identical sources, and the version used to live only in prose here
and in `e2e/README.md`, so nothing could tell one build from another. To build
with a different toolchain deliberately, pass `EMSDK_VERSION=<yours>`; the
version that actually built the binary is what gets written down.

`build.sh` then writes `libsidplayfp`, `emsdk` and `wasmSha256` into
`public/vendor/sid-engine/engine.json`, beside the `files` and `optional` lists
the app already reads. `scripts/prune-dist.mjs` checks that hash against the
binary in `dist/` and fails the build on a mismatch. Commit the engine.json
with the wasm; they are one artefact.

`patches/` is fingerprinted too: the extracted source under `build/` carries a
hash of the patch files and the compile flags, and a change to either forces a
fresh extract. Editing a patch no longer needs `CLEAN=1`.

## Changing shim.cpp

`shim.cpp` is source for a binary that is committed. Editing it changes nothing
that runs until someone with an Emscripten toolchain runs `build.sh` and
commits the new `libsidplayfp.wasm` **and** the `engine.json` beside it. There
is no build step in the app's own `npm run build` that would catch the
difference: `prune-dist.mjs` verifies that the wasm matches its recorded hash,
not that the hash matches the C++.

## Licence

libsidplayfp and reSIDfp are GPL-2.0-or-later. The build copies `COPYING`
beside the binary as `LICENSE-libsidplayfp.txt`. This app is AGPL-3.0, which
is compatible.

## The patches this build carries

`patches/*.patch` are applied to libsidplayfp on a fresh extract, in order,
and `build.sh` fails the build if any of them does not apply exactly.

### 0001, live voice muting

Upstream reSIDfp implements `SID::mute()` by substituting zero for the next
value the tune writes to that voice's control register, so a mute does nothing
until the tune touches that register again - and nothing ever for a tune that
programs a voice once at init, which is legal and common. The patch takes the
mute where the voices are mixed instead, and ramps it over 4096 clocks
(about 4 ms) because a 6581 voice carries a DC pedestal whose sudden removal
thumps through the external filter at -17 dBFS.

### 0002, an output filter that starts settled

A C64 couples its audio out through a DC blocker, which reSIDfp models as a
1.6 Hz high-pass in `ExternalFilter`. Upstream resets both of its networks to
zero, so a tune begins with the filter uncharged and the chip's whole DC
pedestal reaches the output until it drains - the better part of a second.

That was harmless until 2.6.0 amplified the signal path (see below), which
left no headroom for the pedestal on top. Measured on an 8580 tune before the
patch: the first second peaked at full scale with 480 of 44,100 samples
clipped and a mean sample value of 0.168, settling afterwards to a peak of
0.236. Across 27 HVSC tunes asking for that chip, all 27 put samples at full
scale in their first seconds.

With a constant input both networks converge on the input voltage, so the
settled state is just `Vlp = Vhp = Vi`. The patch seeds them from the first
sample after a reset rather than guessing a constant per model and volume
setting, and returns one sample of silence in place of the step. Afterwards:
no tune in that sample of 27 has a single sample at full scale, the worst peak
across all of them is 0.62, and steady-state levels are untouched - the same
tune measures 0.2345 against 0.2361 before.

Reset covers subsong changes and tune switches, not just start-up: the worklet
reloads the tune for both, and `SID::reset()` calls
`ExternalFilter::reset()`.

It costs about 4% of throughput for the branch it adds per SID clock, measured
at 8.0x realtime before and 7.7x after. The worklet needs 1x.

Two alternatives were rejected. An output gain would have to be about 12 dB to
clear a transient four times the steady level, making the whole collection
quiet to fix the first second of it. A second DC blocker in `engine.js` would
stack another high-pass on the one reSIDfp already models, altering the bass
of everything, and would shorten the step rather than remove it.

Patches are applied on a fresh extract, and the extracted tree carries a hash
of `patches/` and the compile flags, so editing one re-extracts and rebuilds by
itself. `CLEAN=1 ./build.sh` is still there for starting from nothing.

## The filter curves, and a doc comment worth distrusting

`shim.cpp` sets both reSIDfp filter curves to 0.5. Both parameters are
positions from 0.0 to 1.0, but the public header you build against says
otherwise for the 8580 one:

```
    /**
     * Set 8580 filter curve.
     *
     * @param filterCurve curve center frequency (default 12500)
     */
    void filter8580Curve(double filterCurve);
```

That comment is stale - reSIDfp did take a frequency there once - and the
implementation it reaches disagrees:

```
void Filter8580::setFilterCurve(double curvePosition)
{
    // Adjust cp
    // 1.2 <= cp <= 1.8
    cp = 1.8 - curvePosition * 3./5.;
```

Nothing clamps it. Passing 12500 gave `cp = -7498.2`, an 8580 filter built
out of nonsense: of 27 tunes sampled across HVSC that ask for that chip, all
27 drove the output to full scale and 19 fell to a constant after about half
a second. Forcing a 6581 played every one of them correctly, which is what
made it look like a chip quirk rather than a bad parameter. About 45% of the
collection declares the 8580.

`tests/fixtures/tone-filter.sid` exists for this: it is the only fixture that
writes a filter register, and `verify:engine` checks it is still sounding
four seconds in. Every other fixture sounded perfectly normal
throughout, on both chips, for as long as the bug lasted.

One thing 2.6.0 changed that is not a bug: its NEWS says "residfp: amplify
the output by a model dependent scale factor", and 2.5.0 "tweaked the 8580
filter parameters for increased volume". Levels are genuinely higher than
2.4.2's - measured at roughly double - which is why there was no headroom
left for the DC pedestal a tune starts with, and why patch 0002 above exists.
