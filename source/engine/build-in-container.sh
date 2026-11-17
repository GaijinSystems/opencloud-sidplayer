#!/usr/bin/env bash
#
# Runs build.sh inside the pinned Emscripten image, so the engine builds with
# nothing but podman or docker on the host. Every build that needs the engine
# goes through here: by hand, scripts/package.sh, and the demo site's build.
#
#   ./build-in-container.sh            build public/vendor/sid-engine/libsidplayfp.wasm
#   CLEAN=1 ./build-in-container.sh    the same from a clean ./build
#   REPIN=1 ./build-in-container.sh    record a new hash after a deliberate change
#
# The image is pinned by digest as well as tag: build.sh refuses any emcc but
# the version it pins, and a build that does not reproduce the hash in
# engine.json is refused too, so the image is part of what the hash stands for.
# Needs the network, to fetch the libsidplayfp release (checked by sha256).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$(dirname "$HERE")"
EMSDK_IMAGE="${EMSDK_IMAGE:-docker.io/emscripten/emsdk:3.1.74@sha256:af45409f3199d88db4b1b03af0098532c8fb33a375ac257463eeb0a622870d06}"

RUNNER=""
for candidate in podman docker; do
  if command -v "$candidate" >/dev/null 2>&1; then RUNNER="$candidate"; break; fi
done
[ -n "$RUNNER" ] || { echo "[build] error: podman or docker is needed" >&2; exit 1; }
# So that what the build writes belongs to whoever ran this.
if [ "$RUNNER" = "podman" ]; then AS_USER=(--userns=keep-id); else AS_USER=(--user "$(id -u):$(id -g)" -e HOME=/tmp); fi

exec "$RUNNER" run --rm "${AS_USER[@]}" -v "$SOURCE":/app:z -w /app/engine \
  -e CLEAN -e JOBS -e REPIN "$EMSDK_IMAGE" ./build.sh
