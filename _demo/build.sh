#!/usr/bin/env bash
#
# Builds the demo site into the root of the gh-pages branch, from the app on
# `main` and the tunes on `demo`, inside a container.
#
#   _demo/build.sh                      from main and demo
#   APP_REF=v1.2.0 _demo/build.sh       from another commit of the app
#
# What it replaces is the previous build at the branch root. `_demo/`,
# `README.md`, `CNAME` and `.gitignore` stay; nothing else there is kept.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
APP_REF="${APP_REF:-main}"
DEMO_REF="${DEMO_REF:-demo}"
NODE_IMAGE="${NODE_IMAGE:-docker.io/library/node:22-bookworm@sha256:0e5f906573693feaa1e21057ebdcfdb5bd5021f050b2dc7c9deceb629c7da2a8}"

RUNNER=""
for candidate in podman docker; do
  if command -v "$candidate" >/dev/null 2>&1; then RUNNER="$candidate"; break; fi
done
[ -n "$RUNNER" ] || { echo "podman or docker is needed" >&2; exit 1; }
if [ "$RUNNER" = "podman" ]; then AS_USER=(--userns=keep-id); else AS_USER=(--user "$(id -u):$(id -g)" -e HOME=/tmp); fi

# The app and the tunes, as committed, not as they happen to be checked out.
WORK="$(mktemp -d "$HERE/.work.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
REPO="$(git -C "$ROOT" rev-parse --show-toplevel)"
git -C "$REPO" archive "$APP_REF" source LICENSE | tar -x -C "$WORK"
git -C "$REPO" archive "$DEMO_REF" demo | tar -x -C "$WORK"

# The previous build, and only that.
find "$ROOT" -mindepth 1 -maxdepth 1 \
  ! -name _demo ! -name README.md ! -name CNAME ! -name .gitignore ! -name .git \
  -exec rm -rf {} +

INSIDE="/site/_demo/$(basename "$WORK")"
# npm's cache in a volume of its own, so a rebuild does not fetch every package again.
"$RUNNER" run --rm "${AS_USER[@]}" -v "$ROOT":/site:z -w /site/_demo \
  -v sidplayer-demo-npm:/npm-cache -e npm_config_cache=/npm-cache \
  -e APP_SOURCE="$INSIDE/source" \
  -e DEMO_LIBRARY="$INSIDE/demo/SID Library" \
  -e OUT=/site \
  "$NODE_IMAGE" sh -c '
    set -e
    (cd "$APP_SOURCE" && npm ci --prefer-offline --no-audit --no-fund --legacy-peer-deps >/dev/null)
    ln -sfn "$APP_SOURCE/node_modules" node_modules
    node prepare.mjs
    node "$APP_SOURCE/node_modules/vite/bin/vite.js" build
    rm -f node_modules
  '

# Jekyll leaves out names that start with `_` or `.`; nothing the site needs may.
# (`.gitignore` is meant to be left out; it is the branch's, not the site's.)
HIDDEN="$(find "$ROOT" -mindepth 1 \( -path "$ROOT/_demo" -o -path "$ROOT/.git" -o -path "$ROOT/.gitignore" \) -prune -o -name '[_.]*' -print)"
if [ -n "$HIDDEN" ]; then
  printf 'the build has a file Jekyll would leave out:\n%s\n' "$HIDDEN" >&2
  exit 1
fi
echo "built into $ROOT"
