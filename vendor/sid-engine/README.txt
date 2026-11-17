sid-engine/
  sid-processor.js     AudioWorkletProcessor. Stable; do not edit per engine.
  engine.js            libsidplayfp adapter. Talks to libsidplayfp.wasm.
  engine.json          What the main thread must fetch, and what built the wasm.
  libsidplayfp.wasm    Built by ../../../engine/build.sh, and tracked in git so
                       that a checkout runs without an Emscripten toolchain.
  kernal.bin           C64 ROM images, 8192 / 8192 / 4096 bytes, copyright
  basic.bin            Commodore and its successors; see THIRD-PARTY-NOTICES.
  chargen.bin          Needed for RSID and BASIC tunes; PSID plays without them.

All files must stay in the same directory: the processor imports `./engine.js`
statically and the main thread resolves the names in engine.json relative to
the processor. The `engineBaseUrl` config key points at a directory for the
same reason.

engine.json's `build` block records the libsidplayfp and emsdk versions and the
sha256 of the wasm beside it. build.sh writes it and scripts/prune-dist.mjs
checks the hash, so a stale or foreign binary fails the build instead of
looking exactly like the right one. Rebuilding the wasm means committing the
engine.json that comes with it.

Anything else dropped in this directory does NOT ship: prune-dist keeps only
the files above and whatever engine.json names. That is how three unreferenced
copies of the ROMs (kernal.901227-03.bin and friends) used to reach a release.
And what does ship is served to browsers without authentication, the ROMs
included; scripts/package.sh --no-roms leaves them out.

Licence notices for the vendored engine are in THIRD-PARTY-NOTICES.txt at
the app root; build.sh copies libsidplayfp's COPYING beside this file.
