# Changelog

Each section below is written to stand on its own as the notes for that
release.

## 1.2.1

The first release built and published by the release workflow, and the
first under the name OpenCloud SID Player. The app's code is unchanged from
1.2.0, whose
[notes in CHANGELOG.md](https://github.com/GaijinSystems/opencloud-sidplayer/blob/main/CHANGELOG.md#120)
cover everything new since 1.1.8; coming from 1.1.8, read those first, in
particular their upgrade steps.

- **The release files sit side by side, each with its `.sha256`:** the
  tarball, its `SHA256SUMS`, `csp.yaml` and `haproxy-hvsc.cfg`. 1.2.0's
  `scripts/package.sh` put the last two in `release/deploy/`. Check a
  download with `sha256sum -c ./*.sha256`.
- **The tarball is reproducible.** The manifest's `builtAt` and every time in
  the tarball are the commit's, so packaging the same commit gives the same
  bytes.
- **The emulator is built, not committed.** `libsidplayfp.wasm` is no longer
  in the repository. `engine.json` records its sha256, and every build has to
  reproduce it; `source/engine/build-in-container.sh` builds it in the pinned
  Emscripten image.

## 1.2.0

One new way to use the library, and a great deal of fixing and hardening
after a thorough review of the code, with tests for what it fixed.

### New: online collections

The first-run screen now offers **Start online** beside the full download. It
fetches only the collection's documents, about 9 MB, so the whole release can
be browsed and searched at once, and fetches each tune into your space the
first time you play it - checked against its MD5, and played from your space
after that. Updates refresh the tunes you have and fetch nothing else.
**Download all…** in the top bar fetches the rest when you choose to; it shows
the plan and waits for Start like any update, and never runs on its own.

Until a tune has been played its row shows the file name, since a tune's
title, year and chip model come from its own header, and searches by `year:`
or `chip:` reach only the tunes you have. An existing collection is
unaffected and stays a whole one.

### Upgrading

- **The app is now called `sidplayer`.** It installs as
  `$WEB_ASSET_APPS_PATH/sidplayer/`, and the library is at `/sidplayer/library`.
  When installing this release:
  - delete the old `sidplay/` folder, or both copies will claim `.sid` files;
  - move a `config.json` from the old folder to the new one;
  - rename a `sidplay:` key in `apps.yaml` to `sidplayer:`.

  Nothing in users' spaces needs moving. Favourites and status in
  `/SID Library/.sidplay/` are still read, and go to `.sidplayer/` the next time
  they change. A Compute's Gazette `.sidplay-index.txt` is still read, though
  new ones are named `.sidplayer-index.txt`. Per-device preferences carry over.
  Update every install that serves the same users at once: an old copy goes on
  writing to `.sidplay/` once `.sidplayer/` exists, where nothing reads it.
- **Update your proxy route.** The `/hvsc-mirror/` rules in
  `haproxy-hvsc.cfg` (`deploy/` in the repository) have changed in both
  halves. Replace the frontend lines and the `be_hvsc_mirror` backend with the
  new ones, then reload HAProxy. The route now:
  - normalises only its own paths, rather than every request on the frontend;
  - admits only the characters the app sends, and refuses encoded dots,
    slashes, backslashes, percents and NULs, and any query string;
  - strips every forwarding header (`X-Forwarded-*`, `Forwarded`, `Via`,
    `True-Client-IP`, `CF-Connecting-IP`, …) and the `Origin` on the way
    out, so neither your users' addresses nor your hostname reach the mirror;
  - strips headers that could set policy for your domain on the way back
    (`Set-Cookie`, `Clear-Site-Data`, `Strict-Transport-Security`,
    `Service-Worker-Allowed`, reporting headers and others);
  - answers 503 at once when 256 requests are already waiting, instead of
    queueing without limit.
- **Paths in the configuration** (`hvscPath`, `hvscMirrorPath`) are now always
  taken from the root: `hvsc-mirror` is read as `/hvsc-mirror`, and a value
  containing a backslash falls back to the default.
- **The C64 ROMs are now included** in the release: `kernal.bin`, `basic.bin`
  and `chargen.bin`, so RSID and BASIC tunes play out of the box. Like
  everything in the app folder they are then a public download from your
  instance; see `INSTALL.md`, section 5, or build with
  `scripts/package.sh --no-roms` for a tarball without them.
- Apart from the rename above, nothing else needs doing: unpack and restart
  the web service, as in `INSTALL.md`.

### Library

- A tune started from the Files app is highlighted in the library too.
- Search keeps the best 500 results and says so when there are more, instead
  of stopping at 500 without saying anything.
- Favourites load on the first-run screen, so a Compute's Gazette tune can be
  starred before HVSC is synced.
- A favourites file the library cannot safely rewrite - not JSON, the wrong
  shape, written by a later version, or naming a collection it does not
  know - is left alone with a message, instead of being read as empty and
  overwritten by the next star. Fields it does not know are kept when it
  saves.
- The cached catalogue is checked against all three documents (Songlengths,
  STIL, Musicians), so an updated STIL or musician list is no longer served
  stale.
- A finished sync records the release it was planned for, not a newer one
  announced while it ran.
- Titles read by a paused or cancelled sync appear straight away.
- A sync proposes no deletions from a release index with entries it cannot
  place.
- A document whose write failed is no longer used, or cached, as if it had
  arrived.
- A tune whose header keeps failing to read stops being asked for after three
  tries, so the rest of the folder gets its turn.
- After a sync, the documents it fetched are reused instead of downloaded
  again.

### Player

- The audio context goes idle after ten seconds with nothing playing, and
  wakes before anything plays. A paused tab no longer keeps the audio device
  open.
- The system media controls follow subsong changes made while paused.
- With no tune loaded, the player bar shows no clock instead of `0:00 / 3:00`.
- A Songlengths.md5 is sized before it is fetched; anything over 32 MB is
  skipped without being downloaded, and the walk up the folders reads at most
  64 MB in all.
- A Pause pressed while the audio is waking up is kept.

### Faster

- The library no longer redraws four times a second while a tune plays.
- Progress updates are limited to a few a second during a sync and a full
  header read.
- Search ranks only its top results instead of sorting every match.
- The composers view groups the catalogue once per build, not every time a
  title arrives.
- Folder listings for Sidplayer companion files are kept for 30 seconds.
- Smaller savings in the engine, text matching, the spectrum and writes to
  the space.

### Under the hood

- The library's main module is split into modules of its own: folder layout,
  favourites, header reading, sync and MUS details.
- One player bar for the full view and the library, one spectrum binding, one
  Songlengths parser, one MUS voice-table reader and shared worker pools,
  where there were copies.
- `engine/build.sh` reads the engine's exports from `shim.cpp`; the rebuilt
  binary is byte for byte the same.
- Tests now hold the test proxy to the deployed route, the engine glue to the
  shim, and the README's configuration table to the defaults.
- The browser tests run on Playwright 1.65.0 against OpenCloud 9.1.0, the
  version the release is in use on.
