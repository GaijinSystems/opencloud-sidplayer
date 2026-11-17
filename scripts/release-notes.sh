#!/bin/sh
#
# Checks that the version is the same everywhere it is recorded, and prints
# that version's section of CHANGELOG.md: the release notes.
#
#   sh scripts/release-notes.sh          check, and print the current notes
#   sh scripts/release-notes.sh 1.2.3    the same, and fail unless it is 1.2.3
#
# The version is recorded in source/package.json and twice in
# source/package-lock.json (the top level and the root package), and
# CHANGELOG.md needs a non-empty "## <version>" section; a date may follow the
# version after a space. Run it before tagging; the release workflow runs it on
# every push to main.

set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail() {
  printf 'release-notes: %s\n' "$*" >&2
  exit 1
}

# The first top-level "version" of a package.json or package-lock.json.
top_version() { sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$1" | head -n 1; }

version="$(top_version "$ROOT/source/package.json")"
[ -n "$version" ] || fail "no version in source/package.json"

lock="$ROOT/source/package-lock.json"
lock_top="$(top_version "$lock")"
# The root package's entry: the first "version" after the `"": {` line.
lock_root="$(awk '/^    "": \{/ { inside = 1; next }
  inside && /^      "version": / { sub(/^      "version": "/, ""); sub(/".*/, ""); print; exit }
  inside && /^    }/ { exit }' "$lock")"
[ "$lock_top" = "$version" ] ||
  fail "source/package-lock.json says ${lock_top:-nothing}, source/package.json says $version"
[ "$lock_root" = "$version" ] ||
  fail "source/package-lock.json's root package says ${lock_root:-nothing}, source/package.json says $version"

if [ $# -gt 0 ]; then
  [ "$1" = "$version" ] || fail "asked for $1, but the code says $version"
fi

# The section: everything after "## <version>" (alone, or followed by a space)
# up to the next "## ", with blank lines trimmed from both ends.
awk -v v="$version" '
  /^## / { if (inside) exit; if ($0 == "## " v || index($0, "## " v " ") == 1) { inside = 1; next } }
  inside { lines[++n] = $0; if (NF) { if (!first) first = n; last = n } }
  END { if (!first) exit 1; for (i = first; i <= last; i++) print lines[i] }' "$ROOT/CHANGELOG.md" ||
  fail "CHANGELOG.md has no \"## $version\" section, or it is empty"
