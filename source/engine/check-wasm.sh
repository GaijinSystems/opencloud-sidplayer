#!/bin/sh
#
# Checks that public/vendor/sid-engine/libsidplayfp.wasm is the binary
# engine.json pins, by sha256. For a wasm that arrived from somewhere else - a
# CI artifact, a copy - rather than from build.sh, which checks its own.
#
#   sh engine/check-wasm.sh          from source/, or from anywhere

set -eu

ENGINE="$(cd "$(dirname "$0")/../public/vendor/sid-engine" && pwd)"
WASM="$ENGINE/libsidplayfp.wasm"

[ -f "$WASM" ] || {
  echo "check-wasm: no $WASM; run engine/build-in-container.sh" >&2
  exit 1
}
pinned="$(sed -n 's/.*"wasmSha256"[[:space:]]*:[[:space:]]*"\([0-9a-f]*\)".*/\1/p' "$ENGINE/engine.json")"
[ -n "$pinned" ] || {
  echo "check-wasm: engine.json pins no wasmSha256" >&2
  exit 1
}
actual="$(sha256sum "$WASM" | cut -d ' ' -f 1)"
[ "$actual" = "$pinned" ] || {
  echo "check-wasm: libsidplayfp.wasm is $actual, engine.json pins $pinned" >&2
  exit 1
}
echo "check-wasm: libsidplayfp.wasm matches engine.json ($pinned)"
