#!/usr/bin/env bash
#
# Packages the built app into a tarball that extracts straight into
# OpenCloud's apps folder, with checksums beside it.
#
#   scripts/package.sh                 build, then package with the ROMs
#   scripts/package.sh --no-roms       package without them
#   scripts/package.sh --skip-build    package source/dist as it stands
#
# The tarball's top-level directory is `sidplayer/`, so
#
#   tar -xzf opencloud-sidplayer-<version>.tar.gz -C "$WEB_ASSET_APPS_PATH"
#
# puts `manifest.json` exactly where the web service looks for it.
#
# About the ROMs: the C64 kernal, BASIC and character ROMs are Commodore's,
# not this project's, and are included by default, as they are in the
# repository, because RSID tunes need the kernal to play at all. `--no-roms`
# builds a tarball without them, for whoever wants one; the app then plays PSID
# tunes and says which file is missing for the rest.
#
# And they are PUBLIC once installed. Everything in the app folder is served
# to browsers by the web service, without authentication: after unpacking,
# https://<host>/assets/apps/sidplayer/vendor/sid-engine/kernal.bin is a plain
# download for anyone who can reach the instance. e2e/smoke.mjs fetches one
# that way with no session at all. Nothing here can change that, so if it is
# not a redistribution you are willing to make, use --no-roms.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$HERE/source"
DIST="$SOURCE/dist"
OUT="$HERE/release"

WITH_ROMS=1
BUILD=1
for arg in "$@"; do
  case "$arg" in
    --no-roms) WITH_ROMS=0 ;;
    --skip-build) BUILD=0 ;;
    -h | --help)
      # The header comment block, up to the first line that is not one. A
      # range of line numbers went wrong each time the block changed length.
      sed -n '2,/^[^#]/{/^#/!d;s/^# \{0,1\}//;p}' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

say() { printf '[package] %s\n' "$*"; }
die() {
  printf '[package] error: %s\n' "$*" >&2
  exit 1
}

# The container runner, so this works with either podman or docker.
RUNNER=""
for candidate in podman docker; do
  if command -v "$candidate" >/dev/null 2>&1; then
    RUNNER="$candidate"
    break
  fi
done

COMMIT="$(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || echo unknown)"
# Dirty if anything the build reads differs from the commit, new files
# included: `git diff` alone misses an untracked file, and a build carrying
# one would share its `?v=` stamp with the clean commit, so browsers would
# keep the cached engine files. Only what the build reads counts.
DIRTY=""
if [ -n "$(git -C "$HERE" status --porcelain -- source LICENSE 2>/dev/null)" ]; then DIRTY="-dirty"; fi

# The image the build runs in, by digest: the tag moves with every Node 22
# release, and a release build should be the same build whenever it is made.
# This is the multi-architecture index, so it resolves on arm64 as on amd64.
# Override with NODE_IMAGE=... to build with something else on purpose.
NODE_IMAGE="${NODE_IMAGE:-docker.io/library/node:22-bookworm@sha256:0e5f906573693feaa1e21057ebdcfdb5bd5021f050b2dc7c9deceb629c7da2a8}"

# --- build -------------------------------------------------------------------
# The emulator is not in git, only its hash (in engine.json), so a fresh
# checkout builds it first. engine/build.sh refuses a binary that does not
# match that hash, so this is the same engine whoever packages it.
if [ "$BUILD" = "1" ] && [ ! -f "$SOURCE/public/vendor/sid-engine/libsidplayfp.wasm" ]; then
  say "building the emulator in the pinned Emscripten image"
  "$SOURCE/engine/build-in-container.sh" >/dev/null
fi
if [ "$BUILD" = "1" ]; then
  if [ -n "$RUNNER" ]; then
    say "building in a container (commit ${COMMIT}${DIRTY})"
    # The whole repository is mounted, not just source/, because the build
    # copies the repository's LICENSE into dist: this is an AGPL project and
    # the artefact people install has to carry the text. With only source/
    # mounted, prune-dist.mjs would find no ../LICENSE and warn.
    # So that what the build writes belongs to whoever ran this. The flag
    # is podman's; docker has no such thing and is told the user instead.
    if [ "$RUNNER" = "podman" ]; then
      AS_USER=(--userns=keep-id)
    else
      # A user the image has never heard of has `/` for a home, which npm
      # cannot write its cache or logs to.
      AS_USER=(--user "$(id -u):$(id -g)" -e HOME=/tmp)
    fi
    # No network: the build reads what is already in node_modules, and a
    # step that reached for anything else should fail, not fetch.
    "$RUNNER" run --rm --network=none "${AS_USER[@]}" -v "$HERE":/repo:z -w /repo/source \
      -e "SOURCE_COMMIT=${COMMIT}${DIRTY}" \
      "$NODE_IMAGE" npm run build >/dev/null
  elif command -v npm >/dev/null 2>&1; then
    say "building with the local npm (commit ${COMMIT}${DIRTY})"
    (cd "$SOURCE" && SOURCE_COMMIT="${COMMIT}${DIRTY}" npm run build >/dev/null)
  else
    die "neither podman/docker nor npm found; build first and pass --skip-build"
  fi
fi

[ -f "$DIST/manifest.json" ] || die "no build at $DIST; run without --skip-build"
[ -f "$DIST/vendor/sid-engine/libsidplayfp.wasm" ] ||
  die "the emulator is missing from the build; run source/engine/build-in-container.sh first"

VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$DIST/manifest.json" | head -1)"
[ -n "$VERSION" ] || die "could not read the version out of the manifest"

NAME="opencloud-sidplayer-${VERSION}"
[ "$WITH_ROMS" = "1" ] || NAME="${NAME}-no-roms"
TARBALL="$OUT/${NAME}.tar.gz"

# --- stage -------------------------------------------------------------------
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/sidplayer"
cp -r "$DIST/." "$STAGE/sidplayer/"

if [ "$WITH_ROMS" = "1" ]; then
  ROMS="$(find "$STAGE/sidplayer/vendor/sid-engine" -name '*.bin' | wc -l)"
  [ "$ROMS" -gt 0 ] || say "warning: no ROM images in the build; RSID tunes will not play"
  say "including ${ROMS} ROM image(s)"
else
  find "$STAGE/sidplayer/vendor/sid-engine" -name '*.bin' -delete
  say "ROM images excluded"
fi

# Anything that should never ship, whatever ends up in dist.
find "$STAGE" \( -name '.DS_Store' -o -name '*.map' -o -name 'Thumbs.db' \) -delete

# --- tar ---------------------------------------------------------------------
mkdir -p "$OUT"
STAMP="$(sed -n 's/.*"builtAt"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$DIST/manifest.json" | head -1)"
[ -n "$STAMP" ] || STAMP="@0"

# The same bytes from the same dist: sorted, no owner names, one timestamp,
# one set of modes, gzip without its own. (Not the same bytes from the same
# source: the build stamps the time it ran into the manifest.)
#
# --mode is not decoration. The staged tree inherits whatever modes the build
# left behind - a mix of 0644 and 0664 depending on the builder's umask, and
# 0755 on anything that arrived executable, such as the linked wasm - so two
# builds of identical bytes produced different archives. u+rwX,go+rX,go-w
# normalises them to 0644 for files and 0755 for directories whatever the umask
# was.
say "writing ${TARBALL##*/}"
tar --sort=name \
  --owner=0 --group=0 --numeric-owner \
  --mtime="$STAMP" \
  --mode='u+rwX,go+rX,go-w' \
  --format=gnu \
  -C "$STAGE" -cf - sidplayer |
  gzip -9 -n >"$TARBALL"

# --- the files that do not belong inside the app folder ----------------------
#
# Nothing has to be configured to *enable* the app: the web service composes
# its app list from this folder, so unpacking and restarting is the whole
# installation (verified with no apps.yaml present at all - the app appears
# and runs on the manifest's own defaults). But two files do have to go
# elsewhere, and they are instance-level, merged into configuration an
# operator already has. They travel beside the tarball rather than inside it,
# because anything inside the app folder is served to browsers, and these are
# for the server.
mkdir -p "$OUT/deploy"
cp "$HERE/deploy/csp.yaml" "$HERE/deploy/haproxy-hvsc.cfg" "$OUT/deploy/"
say "beside it: deploy/csp.yaml (required) and deploy/haproxy-hvsc.cfg (library only)"

# --- checksums ---------------------------------------------------------------
# Two lists, because they are checked in two different directories and a
# single one would report failures wherever it was run: the paths inside the
# tarball do not exist until it is unpacked, and the deploy files never go
# into the apps folder at all.
#
#   in release/                 sha256sum -c <name>.tar.gz.sha256
#   in $WEB_ASSET_APPS_PATH     sha256sum -c <name>.SHA256SUMS
(cd "$OUT" && sha256sum "${NAME}.tar.gz" deploy/csp.yaml deploy/haproxy-hvsc.cfg >"${NAME}.tar.gz.sha256")
(cd "$STAGE" && find sidplayer -type f -print0 | sort -z | xargs -0 sha256sum) >"$OUT/${NAME}.SHA256SUMS"

SIZE="$(du -h "$TARBALL" | cut -f1)"
FILES="$(tar -tzf "$TARBALL" | grep -vc '/$' || true)"
say "done: $SIZE, $FILES files, version $VERSION, commit ${COMMIT}${DIRTY}"
say "verify:  sha256sum -c ${NAME}.tar.gz.sha256"
say "install: tar -xzf ${NAME}.tar.gz -C \"\$WEB_ASSET_APPS_PATH\" && restart the web service"
if command -v gpg >/dev/null 2>&1 && gpg --list-secret-keys >/dev/null 2>&1 &&
  [ -n "$(gpg --list-secret-keys 2>/dev/null)" ]; then
  say "sign:    gpg --armor --detach-sign ${TARBALL##*/}"
fi
