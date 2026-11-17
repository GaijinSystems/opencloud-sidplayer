#!/usr/bin/env bash
#
# Builds libsidplayfp + shim.cpp into public/vendor/sid-engine/libsidplayfp.wasm.
#
# Needs the Emscripten SDK on PATH (`source /path/to/emsdk/emsdk_env.sh`),
# plus curl, tar and make. Everything else is downloaded into ./build and
# can be deleted afterwards.
#
# The result is a standalone WebAssembly module: no JavaScript glue, WASI
# imports only, exceptions handled in-module. That is what lets engine.js
# instantiate it inside an AudioWorkletGlobalScope, and what keeps the CSP
# requirement at 'wasm-unsafe-eval' rather than 'unsafe-eval'.
#
# Usage:
#   ./build.sh            build with the pinned libsidplayfp version
#   CLEAN=1 ./build.sh    wipe ./build first
#   JOBS=8 ./build.sh     parallel make
#
# Editing a patch no longer needs CLEAN=1: the extracted source carries a
# fingerprint of patches/ and the compile flags, and a change to either forces
# a fresh extract by itself.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD="$HERE/build"
OUT="$HERE/../public/vendor/sid-engine"

LIBSIDPLAYFP_VERSION="${LIBSIDPLAYFP_VERSION:-2.6.0}"
LIBSIDPLAYFP_URL="https://github.com/libsidplayfp/libsidplayfp/releases/download/v${LIBSIDPLAYFP_VERSION}/libsidplayfp-${LIBSIDPLAYFP_VERSION}.tar.gz"
# Pinned from the first download (`sha256sum build/libsidplayfp-*.tar.gz`) so
# a later build cannot silently pick up a different tarball. Change it with
# the version; an empty value skips the check, with a warning.
# `:-` would substitute the default for an empty value too, and the comment
# above promises that an empty value skips the check.
LIBSIDPLAYFP_SHA256="${LIBSIDPLAYFP_SHA256-cc6bb9418ad3f64772c54c011552b113f8ef82f9820d74d4c2fed5976d4905e9}"

# The Emscripten version this engine is built with. It used to live only in
# prose (engine/README.md, e2e/README.md), which meant two builds from
# different emcc versions produced different bytes with nothing anywhere to
# tell them apart. Same convention as the checksum above: an empty value skips
# the check, with a warning, and whatever emcc is actually found is what gets
# recorded in engine.json either way.
EMSDK_VERSION="${EMSDK_VERSION-3.1.74}"

JOBS="${JOBS:-$(nproc 2>/dev/null || echo 2)}"

log() { printf '[build] %s\n' "$*"; }
die() { printf '[build] error: %s\n' "$*" >&2; exit 1; }

command -v emcc >/dev/null 2>&1 || die "emcc not found; source emsdk_env.sh first"
command -v emconfigure >/dev/null 2>&1 || die "emconfigure not found; is emsdk activated?"
command -v curl >/dev/null 2>&1 || die "curl not found"
command -v patch >/dev/null 2>&1 || die "patch not found"

EMCC_VERSION="$(emcc --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
[ -n "$EMCC_VERSION" ] || die "could not read a version out of 'emcc --version'"
if [ -n "$EMSDK_VERSION" ] && [ "$EMCC_VERSION" != "$EMSDK_VERSION" ]; then
  die "emcc is ${EMCC_VERSION}, this engine is pinned to ${EMSDK_VERSION}.
       The reference build runs in docker.io/emscripten/emsdk:${EMSDK_VERSION}.
       To build with ${EMCC_VERSION} on purpose, run EMSDK_VERSION=${EMCC_VERSION} ./build.sh
       and commit the engine.json this writes, so the binary stays accounted for."
fi
[ -n "$EMSDK_VERSION" ] || log "warning: EMSDK_VERSION is not set; building with emcc ${EMCC_VERSION} unchecked"

if [ "${CLEAN:-0}" = "1" ]; then
  log "removing $BUILD"
  rm -rf "$BUILD"
fi
mkdir -p "$BUILD" "$OUT"

TARBALL="$BUILD/libsidplayfp-${LIBSIDPLAYFP_VERSION}.tar.gz"
SRC="$BUILD/libsidplayfp-${LIBSIDPLAYFP_VERSION}"
PREFIX="$BUILD/prefix"

# --- compile flags shared by the library and the shim -------------------------
# -fwasm-exceptions: libsidplayfp's tune loaders throw internally, so exceptions
#   must work, and the WebAssembly proposal keeps them inside the module.
# -fno-strict-aliasing, -O3: what the upstream build uses for speed.
COMMON_FLAGS="-O3 -fwasm-exceptions -fno-strict-aliasing"

# --- fetch --------------------------------------------------------------------
if [ ! -f "$TARBALL" ]; then
  log "downloading libsidplayfp ${LIBSIDPLAYFP_VERSION}"
  # Downloaded to .part and renamed, because an interrupted curl used to leave
  # a truncated tarball in place: the checksum below then failed, `die` exited,
  # and the next run skipped the download because the file existed. The build
  # died identically on every attempt until someone deleted the file by hand.
  curl -fsSL -o "$TARBALL.part" "$LIBSIDPLAYFP_URL" \
    || { rm -f "$TARBALL.part"; die "download failed: $LIBSIDPLAYFP_URL"; }
  mv "$TARBALL.part" "$TARBALL"
fi
if [ -n "$LIBSIDPLAYFP_SHA256" ]; then
  # Same reasoning: a tarball that fails the check is not one to keep.
  echo "${LIBSIDPLAYFP_SHA256}  ${TARBALL}" | sha256sum -c - >/dev/null \
    || { rm -f "$TARBALL"; die "tarball checksum mismatch; the file has been removed, run again"; }
else
  log "warning: LIBSIDPLAYFP_SHA256 is not set; tarball not verified"
  log "         sha256: $(sha256sum "$TARBALL" | cut -d' ' -f1)"
fi

# Patches are applied on a fresh extract only, so an edited patch used to need
# CLEAN=1 to be picked up - documented, and still a foot-gun, because a build
# that silently ignores the patch you just wrote looks like the patch not
# working. The extracted tree carries a fingerprint of patches/, the compile
# flags and the compiler version instead; when it no longer matches, the tree and the built library go
# and the extract runs again.
PATCH_STAMP="$BUILD/.patches.sha256"
patches_fingerprint() {
  {
    # The compiler too: a library built by one emcc relinked by another is
    # neither build, and engine.json would name only the second.
    printf '%s\n' "$LIBSIDPLAYFP_VERSION" "$COMMON_FLAGS" "$EMCC_VERSION"
    for p in "$HERE"/patches/*.patch; do
      [ -e "$p" ] || continue
      cat "$p"
    done
  } | sha256sum | cut -d' ' -f1
}
WANT_PATCHES="$(patches_fingerprint)"
HAVE_PATCHES=""
[ -f "$PATCH_STAMP" ] && HAVE_PATCHES="$(cat "$PATCH_STAMP")"
if [ -d "$SRC" ] && [ "$WANT_PATCHES" != "$HAVE_PATCHES" ]; then
  log "patches or compile flags changed since the last extract; starting over"
  rm -rf "$SRC" "$PREFIX" "$PATCH_STAMP"
fi

if [ ! -d "$SRC" ]; then
  log "extracting"
  tar -xzf "$TARBALL" -C "$BUILD"
  # Patches must apply exactly: the tarball is pinned by checksum, so a failure
  # here means the patch is stale rather than the source being unexpected. See
  # patches/ for the reasoning behind each one.
  for p in "$HERE"/patches/*.patch; do
    [ -e "$p" ] || continue
    log "applying $(basename "$p")"
    patch -p1 -d "$SRC" --fuzz=0 --no-backup-if-mismatch <"$p" >>"$BUILD/patch.log" 2>&1 \
      || { tail -20 "$BUILD/patch.log"; die "$(basename "$p") did not apply; see $BUILD/patch.log"; }
  done
  printf '%s\n' "$WANT_PATCHES" >"$PATCH_STAMP"
fi
# Release tarballs ship the assembled PSID driver, so the xa assembler is not
# needed. A git checkout would need it; say so rather than fail obscurely.
[ -f "$SRC/src/psiddrv.bin" ] || die "src/psiddrv.bin missing: use a release tarball, or install xa and run 'make' in the source once"

# --- configure + build libsidplayfp -------------------------------------------
if [ ! -f "$PREFIX/lib/libsidplayfp.a" ]; then
  log "configuring libsidplayfp"
  (
    cd "$SRC"
    # --host tells autoconf it is cross-compiling, so it stops trying to run
    # the test binaries it builds. The exSID hardware builder needs libftdi
    # and a USB port; make sure configure never finds it.
    CXXFLAGS="$COMMON_FLAGS" CFLAGS="$COMMON_FLAGS" LDFLAGS="-fwasm-exceptions" \
      emconfigure ./configure \
        --host=wasm32-unknown-emscripten \
        --prefix="$PREFIX" \
        --disable-shared --enable-static \
        --without-exsid \
        --disable-tests \
        >"$BUILD/configure.log" 2>&1 || { tail -40 "$BUILD/configure.log"; die "configure failed; see $BUILD/configure.log"; }
  )
  log "building libsidplayfp (jobs=$JOBS)"
  (
    cd "$SRC"
    emmake make -j"$JOBS" >"$BUILD/make.log" 2>&1 || { tail -40 "$BUILD/make.log"; die "make failed; see $BUILD/make.log"; }
    emmake make install >>"$BUILD/make.log" 2>&1 || die "make install failed; see $BUILD/make.log"
  )
fi
[ -f "$PREFIX/lib/libsidplayfp.a" ] || die "libsidplayfp.a was not produced"

# --- link the shim into a standalone module -----------------------------------
# Exported names carry a leading underscore here (Emscripten convention); the
# wasm exports are the plain C names, which is what engine.js uses.
#
# Every `sid_*` function shim.cpp defines at the start of a line, read from
# the file rather than listed again here, so a function added there cannot be
# left out of the binary. tests/engine-surface.spec.ts holds engine.js to the
# same set.
SHIM_FUNCTIONS="$(grep -oE '^[A-Za-z_][A-Za-z0-9_ *]*[ *](sid_[a-z_]+)\(' "$HERE/shim.cpp" | grep -oE 'sid_[a-z_]+' | sort -u || true)"
[ -n "$SHIM_FUNCTIONS" ] || die "found no sid_* functions in shim.cpp"
EXPORTS="_malloc,_free$(printf ',_%s' $SHIM_FUNCTIONS)"
log "exports: $EXPORTS"

log "linking libsidplayfp.wasm"
emcc $COMMON_FLAGS -std=c++17 \
  "$HERE/shim.cpp" \
  -I"$PREFIX/include" -L"$PREFIX/lib" -lsidplayfp \
  -sSTANDALONE_WASM --no-entry \
  -sEXPORTED_FUNCTIONS="$EXPORTS" \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=33554432 \
  -sSTACK_SIZE=1048576 \
  -sASSERTIONS=0 \
  -o "$OUT/libsidplayfp.wasm"

# libsidplayfp is GPL-2.0-or-later; the licence text ships beside the binary.
cp "$SRC/COPYING" "$OUT/LICENSE-libsidplayfp.txt"

# --- what this binary is ------------------------------------------------------
# engine.json is the main thread's fetch list (`files` required, `optional`
# skipped when absent - see src/sid/engineAssets.ts), and now also the record of
# what produced the binary beside it. Without it a stale or foreign wasm was
# indistinguishable from the right one: nothing carried a version or a hash, so
# "the file exists" was the whole of the verification. scripts/prune-dist.mjs
# checks wasmSha256 against dist/ and fails the build on a mismatch.
#
# No timestamp here on purpose: the file is tracked in git and a build stamp
# would make it differ on every rebuild of identical bytes. The hash is the
# identity; manifest.json carries the time and the commit.
WASM_SHA256="$(sha256sum "$OUT/libsidplayfp.wasm" | cut -d' ' -f1)"
cat >"$OUT/engine.json" <<JSON
{
  "name": "libsidplayfp",
  "files": ["libsidplayfp.wasm"],
  "optional": ["kernal.bin", "basic.bin", "chargen.bin"],
  "build": {
    "libsidplayfp": "${LIBSIDPLAYFP_VERSION}",
    "emsdk": "${EMCC_VERSION}",
    "wasmSha256": "${WASM_SHA256}"
  }
}
JSON
log "engine.json: libsidplayfp ${LIBSIDPLAYFP_VERSION}, emsdk ${EMCC_VERSION}, sha256 ${WASM_SHA256}"

SIZE=$(stat -c %s "$OUT/libsidplayfp.wasm" 2>/dev/null || stat -f %z "$OUT/libsidplayfp.wasm")
log "wrote $OUT/libsidplayfp.wasm ($((SIZE / 1024)) kB)"
log "imports the module asks for (engine.js must stub each):"
if command -v wasm-objdump >/dev/null 2>&1; then
  wasm-objdump -x -j Import "$OUT/libsidplayfp.wasm" | sed -n 's/^ - func.*<- \(.*\)$/    \1/p' | sort -u
else
  log "    (install wabt for wasm-objdump to list them)"
fi
log "done. Rebuild the app (npm run build) so dist/ picks up the new binary."
