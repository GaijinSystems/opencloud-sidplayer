#!/usr/bin/env bash
#
# Builds the demo site from a checkout of the app and the tunes in
# _demo/library/, inside containers, and checks it.
#
#   _demo/build.sh <app checkout> <output folder>
#       What the release workflow runs: builds from that checkout of main
#       into the output folder, which must be empty or not yet exist, and
#       changes nothing this branch tracks (what it writes under _demo/ is
#       ignored).
#
#   _demo/build.sh
#       By hand: the same from main as committed (APP_REF=<ref> for another
#       commit), and then, once built and checked, in place of the previous
#       build at the root of this gh-pages checkout. `_demo/`, `README.md`,
#       `CNAME` and `.gitignore` stay; nothing else at the root is kept.
#
# Either way the site is then checked: no name Jekyll would leave out, no file
# it would process, and the page itself in Chromium (_demo/checks.mjs).

# The release workflow runs this with `sh`.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -euo pipefail

unset GIT_DIR GIT_WORK_TREE
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(dirname "$HERE")"
die() {
  echo "build.sh: $*" >&2
  exit 1
}

NODE_IMAGE="${NODE_IMAGE:-docker.io/library/node:22-bookworm@sha256:0e5f906573693feaa1e21057ebdcfdb5bd5021f050b2dc7c9deceb629c7da2a8}"
# The Playwright the app's browser tests pin (source/e2e/package.json), with its browsers.
PLAYWRIGHT_IMAGE="${PLAYWRIGHT_IMAGE:-mcr.microsoft.com/playwright:v1.65.0-noble@sha256:9beb546099e11f52d62e505537914870e01a67e0e6b00ae41da4775324e73dbe}"

RUNNER=""
for candidate in podman docker; do
  if command -v "$candidate" >/dev/null 2>&1; then RUNNER="$candidate"; break; fi
done
[ -n "$RUNNER" ] || die "podman or docker is needed"
if [ "$RUNNER" = "podman" ]; then AS_USER=(--userns=keep-id); else AS_USER=(--user "$(id -u):$(id -g)" -e HOME=/tmp); fi

if [ $# -eq 0 ]; then
  # Only ever at the root of a gh-pages checkout: everything there but the
  # source and the branch's own files is about to be replaced.
  [ "$(git -C "$ROOT" rev-parse --show-toplevel 2>/dev/null)" = "$ROOT" ] &&
    [ "$(git -C "$ROOT" symbolic-ref --short HEAD 2>/dev/null)" = gh-pages ] ||
    die "without arguments, run this from a checkout of the gh-pages branch; $ROOT is not one"
  # The app as committed, not as it happens to be checked out, built and
  # checked into a folder of its own, and only then put in place of the
  # previous build.
  HAND="$(mktemp -d "$HERE/.work.XXXXXX")"
  trap 'rm -rf "$HAND"' EXIT
  mkdir "$HAND/app"
  git -C "$ROOT" archive "${APP_REF:-main}" source LICENSE | tar -x -C "$HAND/app"
  bash "${BASH_SOURCE[0]}" "$HAND/app" "$HAND/site"
  find "$ROOT" -mindepth 1 -maxdepth 1 \
    ! -name _demo ! -name README.md ! -name CNAME ! -name .gitignore ! -name .git \
    -exec rm -rf {} +
  cp -R "$HAND/site/." "$ROOT/"
  echo "and put in place at $ROOT"
  exit 0
fi
[ $# -eq 2 ] || {
  sed -n '2,/^[^#]/{/^#/!d;s/^# \{0,1\}//;p}' "${BASH_SOURCE[0]}" >&2
  exit 2
}
[ -d "$1/source" ] && [ -f "$1/LICENSE" ] || die "$1 is not a checkout of the app"
mkdir -p "$2"
OUT="$(cd "$2" && pwd -P)"
[ -z "$(ls -A "$OUT")" ] || die "$OUT is not empty"

# The app's sources are copied here, and seen at /app in the containers.
# Vue derives scoped-style ids from file paths relative to _demo/, so a fixed
# path inside the container keeps the bundle the same from build to build.
WORK="$(mktemp -d "$HERE/.work.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
# The checkout as it is, wasm included if it has one, without what a working
# copy builds for itself.
tar -C "$1" --exclude=node_modules --exclude=source/dist --exclude=source/engine/build \
  -cf - source LICENSE | tar -C "$WORK" -xf -

# The emulator: not in git, only the hash it must have. A checkout that brings
# one (the workflow's, from its engine job) is checked against that hash;
# otherwise it is built here, and build.sh checks its own.
if [ -f "$WORK/source/public/vendor/sid-engine/libsidplayfp.wasm" ]; then
  sh "$WORK/source/engine/check-wasm.sh"
else
  "$WORK/source/engine/build-in-container.sh" >/dev/null
fi
VERSION="$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$WORK/source/package.json" | head -n 1)"

# npm's cache in a volume of its own, so a rebuild does not fetch every package again.
"$RUNNER" run --rm "${AS_USER[@]}" -v "$HERE":/demo:z -v "$WORK":/app:z -v "$OUT":/out:z -w /demo \
  -v sidplayer-demo-npm:/npm-cache -e npm_config_cache=/npm-cache \
  -e APP_SOURCE=/app/source \
  -e "DEMO_LIBRARY=/demo/library/SID Library" \
  -e OUT=/out \
  "$NODE_IMAGE" sh -euc '
    (cd "$APP_SOURCE" && npm ci --prefer-offline --no-audit --no-fund --legacy-peer-deps >/dev/null)
    ln -sfn "$APP_SOURCE/node_modules" node_modules
    node prepare.mjs
    node "$APP_SOURCE/node_modules/vite/bin/vite.js" build --logLevel warn
    rm -f node_modules
  '

# The same checks as the release workflow's demo job, which runs only once the
# release is published, so that anything it would refuse fails here first:
# no name Jekyll leaves out or treats specially, none of the branch's own
# files, and no file that opens with front matter (Jekyll would process it).
ODD="$(cd "$OUT" && find . -mindepth 1 \( \( ! -type f ! -type d \) -o -name '.*' -o -name '_*' \
  -o -path ./README.md -o -path ./CNAME \
  -o -name '#*' -o -name '~*' -o -name '*~' -o -name node_modules -o -name 'Gemfile*' \
  -o -path ./vendor/bundle -o -path ./vendor/cache -o -path ./vendor/gems \
  -o -path ./vendor/ruby \) -print)"
[ -z "$ODD" ] || die "the build has names the release workflow would refuse:
$ODD"
[ -s "$OUT/index.html" ] || die "the build has no index.html"
while IFS= read -r -d '' f; do
  ! cmp -s <(head -c 3 "$f") <(printf %s ---) || die "$f opens with front matter, which Jekyll would process"
done < <(find "$OUT" -type f -print0)

# The page itself, served as Pages serves it.
"$RUNNER" run --rm "${AS_USER[@]}" -v "$OUT":/site:ro,z \
  -v "$HERE/checks.mjs":/checks/checks.mjs:ro,z \
  -v "$WORK":/app:ro,z \
  -e SITE=/site -e "VERSION=$VERSION" \
  -v sidplayer-demo-npm:/npm-cache -e npm_config_cache=/npm-cache \
  "$PLAYWRIGHT_IMAGE" sh -euc '
    mkdir /tmp/checks && cd /tmp/checks
    cp /app/source/e2e/package.json /app/source/e2e/package-lock.json /checks/checks.mjs .
    cp /app/source/scripts/checks.mjs report.mjs
    npm ci --prefer-offline --no-audit --no-fund >/dev/null
    node checks.mjs
  '
echo "built and checked into $OUT"
