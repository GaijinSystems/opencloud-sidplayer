# OpenCloud SID Player

Opens Commodore 64 `.sid` music files directly in the OpenCloud file manager —
click a tune and it plays — and browses the whole High Voltage SID Collection
from an application-menu entry of its own.

**Try it:** [sidplayer.gaijin.systems](https://sidplayer.gaijin.systems) has the
library with ten tunes, running in your browser with no server behind it.

**Status: builds, plays, tested end to end**, as a viewer in the Files app and
as a standalone library over the whole High Voltage SID Collection. Emulation is
[libsidplayfp](https://github.com/libsidplayfp/libsidplayfp) 2.6.0 with
reSIDfp, compiled to a 299 kB WebAssembly module by `source/engine/build.sh`
and driven from an AudioWorklet, with two patches of our own: live voice
muting, and an output filter that starts settled rather than clipping its way
through the first second. See [`docs/engine-contract.md`](docs/engine-contract.md) for how the
two halves talk and [`docs/hvsc-library.md`](docs/hvsc-library.md) for how the
library reads and syncs a collection.

**Needs OpenCloud 7.2.5 or newer.** The smoke, library and Compute's Gazette
browser tests below pass in full against OpenCloud 7.2.5 (stable), 8.1.0, 9.1.0
and 9.2.0 (rolling), with 1.2.2 on 2026-11-22. On 6.0.0 the player plays, but
a click opens the full view instead of playing in Files, the library's first
sync fails on some files with server errors, and later library checks fail
too; versions between 6.0.0 and 7.2.5 were not tried.

What has been verified, all inside podman containers; the table below was last
run in full on 2026-11-16, and its smoke, library and Compute's Gazette rows
again on 2026-11-22, as above.
It is also in everyday use on OpenCloud 9.1.0 rolling.

| Layer | How | Result |
|---|---|---|
| Unit | `npm test`, vitest under happy-dom | header parser, MUS detection and credits, format detection, words, MD5 against Node's, Songlengths.md5 parsing, config clamping, preferences, formatting, the HVSC manifest, STIL, the musician list, the catalogue and tree, search and its query syntax, sync planning, the status file, favourites merging and their hand-made order surviving it, folding late-arriving headers into the index without rebuilding it, column sorting with its unknowns-last and stable-tie rules, the Koala and Doodle picture decoders with the packer read off the collection's own files, the app folder's move out of the collection still reading what was left behind, the Sidplayer score interpreter that works out how long a MUS tune lasts, and the Compute's Gazette catalogue built from path names with its letter groups, its index parser and the library wiring that keeps the two collections apart. Three more hold hand-kept copies to their originals: the test rig's proxy against `deploy/haproxy-hvsc.cfg` rule for rule, the engine's calls and defaults against `shim.cpp`, and this README's configuration table against `defaults.json` |
| Real collection | `HVSC_DOCS=… npm test` | over the real 9 MB of documents: 61,157 manifest entries, 18,898 STIL entries, 1,833 musicians, and a search index built in 1.1 s answering in 0.5 ms |
| Real Compute's | `CGSC=… npm test` | over the real 27,414-file collection: every line of the index read as a path, 16,601 tunes found among them in 447 composer folders, ten groups of between 11 and 79 folders, every tune accounted for exactly once in the tree, the four document folders left out, no group path that could be mistaken for a folder, and a search index that answers without folding its results together for want of an MD5 |
| Real pictures | `CGSC_PICS=… npm test` | over all 554 files of the Compute's Gazette picture add-on: every one decodes, every packed file expands to exactly the size its format wants, the `.ani` files are refused, and the three packed files wearing a `.pic` name are found |
| Types | `npm run check:types`, vue-tsc | clean, with `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride` and `noFallthroughCasesInSwitch` on top of `strict` |
| Lint | `npm run lint`, ESLint 9 over the app, the tests, the scripts and both worklet files | clean |
| Format | `npm run format:check`, Prettier over every code, JSON and YAML file under `source/` | clean |
| Engine | `npm run verify:engine`, Node hosting the real worklet files | the wasm produces the pitch the fixture's 6502 code asks for on each subsong, restarts, rejects garbage, refuses RSID without a kernal, accepts Sidplayer MUS alone and with STR appended, removes any one voice from a three-voice mix mid-playback and puts it back while leaving the other two untouched, raises the pitch under a forced NTSC clock, keeps a resonant 8580 filter sounding four seconds in without running the output to full scale, opens without a single sample at full scale or a DC pedestal under it, the processor's message protocol round-trips, and a tune that goes quiet is reported as ended after eight seconds but not after six, not before it has made a sound, and not at all unless asked |
| Browser, Files | `e2e/smoke.mjs`, headless Chromium against OpenCloud 9.1.0 rolling | sign-in, left-click playing in the dock while staying in Files, the shell shrinking to make room, spectrum toggle saved per device, playback surviving navigation, the full view attaching without restart, dark theme applied to the player root only, Escape closing the preferences and not the app, keyboard control, a reload starting at the first subsong, right-click "Open with… › Open in SID Player", a subsong length taken from Songlengths.md5 beside the tune, the 8580 override saved, voice mute by button and by key, a Sidplayer trio from its `.str` with credits, words and the pixels of a packed picture read off the canvas, both error states, RSID on the real kernal, stop restoring the shell |
| Browser, library | `e2e/library.mjs`, the same Chromium against OpenCloud behind a real HAProxy with a miniature mirror | the application-menu entry, the first-run screen, a sync that really downloads tunes into the space, the three-pane library over what arrived, header fields read from the files themselves, STIL commentary, playback through the shared engine, search including both umlaut spellings and `songs:>1`, favourites, the composer view, and a second release that adds two tunes and withdraws one, a first sync landing in `C64Music/` inside the app's folder and a collection with no `C64Music/` level read just as readily, the app's own folder staying beside the collection when that moves, the shell's own search hidden while the library is open and handed back on the way out, clicking a column heading to sort, reverse and clear, and reordering favourites by button and by drag with the order surviving a reload, a sort putting the handles away without sliding the rows sideways, and the clear control sitting left of a search field that stays centred and keeps its width |
| Browser, online | `e2e/online.mjs`, the same rig as the library test | starting online writes the documents and not one tune, the status says so, the whole release is catalogued, a tune played is fetched into the space and nothing else with it, "Download all…" plans and waits for Start before writing anything, and once it has run every tune is there and the collection is whole |
| Browser, Compute's | `e2e/cgsc.mjs`, the same rig as the library test | a second section below the collection with its letter groups and counts, a group that expands and opens nothing, a composer folder listing their subfolders' tunes too, a breadcrumb saying which archive you are in, no "plays on demand" on rows that cannot support it, a detail pane that does not attribute a length to a file that never lists the tune, playback straight out of `CGSC/`, a search headed per collection that reaches both, `year:` saying why it cannot be asked, `songs:1` showing that it can, the same catalogue arrived at by walking when the index is deleted, and no section at all once the folder is gone |
| Browser, switching | `e2e/switching.mjs`, the same rig as the library test | one tune after another in a folder, the subsong count and clock following the tune switched to rather than lingering on the last one, a three-subsong tune left mid-way and returned to, two clicks in quick succession resolving to the second, and three tunes played out of three different searches |
| Browser, real scale | `e2e/scale.mjs`, the genuine 61,157-entry manifest with 40 real tunes behind one folder | opens in 1.6–2.4 s, the first search in 0.3–0.8 s while it builds the index and later ones in 20–100 ms, a folder of folders lists what is beneath it, the 1,298-tune folder windows and says so, the list scrolls inside its own pane and stops exactly where the player bar starts, absent tunes are marked in a folder and not guessed at in search results, headers read from a folder fold into the index without the page freezing (worst frame gap 90–110 ms, against 1,565 ms when the index was rebuilt), the search field holding still while the activity pill counts beside it, sorting all 61,157 rows rather than the 400 on screen (the longest tune in the collection reaches the top row), 117–125 MB of heap |
| Proxy, live | `deploy/haproxy-hvsc.cfg` in haproxy 3.x against hvsc.brona.dk | a tune arrives as `audio/prs.sid`, the 5.2 MB manifest in 1.3 s, a range request answers 206; `PUT`, encoded dots, backslashes and query strings are refused; a raw `..` normalises out of the route; the sandboxing headers are on every response |
| Audio suspend | Playwright WebKit and Chromium | a context the page suspended itself resumes without a fresh gesture, which the idle suspend relies on |

## Layout

```
source/                  the app; build with npm
  src/index.ts           registration: extensions, route, app info
  src/App.vue            fetch → parse → player; keyboard; theme
  src/sid/               header parser, MUS/STR/WDS, format detection, WebDAV reading,
                         engine asset fetching, Songlengths.md5 parsing and lookup, MD5
  src/player/session.ts  the one player for the page: tune, preferences, theme roots
  src/hvsc/              the collection: manifest, STIL, musicians, catalogue and tree,
                         search index, mirror client, space adapter, inventory walk,
                         sync planning and running, status file, favourites, IndexedDB cache
  src/cgsc/              Compute's Gazette: a catalogue from path names alone, its
                         letter groups, and the path index it reads instead of walking
  src/library/           the standalone library: tree, list, rows, detail, composers,
                         first run, sync panel; useLibrary drives them, with the
                         folder layout, favourites, header reading, sync and MUS
                         details each in a module of its own
  src/dock/              the bottom dock, mounted once from ready()
  src/composables/       useSidPlayer (AudioContext + worklet + state), useSpectrum and
                         usePlayerScope over it, usePreferences
  src/components/        PlayerBar, SongInfo, TunePicture, PlayerError, PreferencesPanel
  src/helpers/           formatting, asset URLs, theme, timeouts, worker pools, throttling
  tests/                 vitest suites; tests/helpers/ builds tune bytes and fake WebDAV
  e2e/                   the browser drivers, their shared harness.mjs, and the test proxy
  engine/                shim.cpp + build.sh: libsidplayfp → libsidplayfp.wasm
    patches/               applied to libsidplayfp on extract; live voice muting, settled output filter
  public/vendor/sid-engine/
    sid-processor.js     AudioWorkletProcessor (stable)
    engine.js            libsidplayfp adapter (WASI stubs, memory, C API)
    engine.json          which files the main thread fetches for the worklet
    libsidplayfp.wasm    built by engine/build.sh, not tracked; engine.json pins its sha256
  scripts/prune-dist.mjs build stamp, defaults into manifest, prune
  scripts/               also the fixture builder and the engine and MUS-length checks
  dev/docker/            OpenCloud dev stack config
  eslint.config.js       lint rules, including the AudioWorklet's own globals
LICENSE                  AGPL-3.0, the licence the app is under
scripts/package.sh       builds the release files: the tarball, the zip and SHA256SUMS
deploy/csp.yaml          the one required policy change
deploy/haproxy-hvsc.cfg  the mirror path the library needs, for your front proxy
docs/engine-contract.md  how the main thread, the worklet and the engine fit together
docs/hvsc-library.md     how the library reads, syncs and searches the collection
INSTALL.md               installing, upgrading and removing a built release
CHANGELOG.md             what changed in each release, written to serve as its notes
```

## Build

Two steps: the emulator once, then the app. Nothing needs installing on the
host if you have podman or docker; every command below has a container form.

```
cd source/engine
./build-in-container.sh              # -> public/vendor/sid-engine/libsidplayfp.wasm, in the pinned emsdk image
                                     # (or ./build.sh with emsdk 3.1.74 on PATH)

cd ..
npm ci --legacy-peer-deps            # the OpenCloud packages pin peer ranges npm 10 will not resolve alone
npm test                             # first generates tests/fixtures/ from hand-assembled 6502 code
npm run check:types
npm run verify:engine                # drives the real wasm through the real worklet files in Node
npm run build                        # -> dist/, with a build stamp in manifest.json
```

For the Node steps in a container, from the repository root, which is mounted
whole so the build can copy `LICENSE` into the app and stamp the commit:
`podman run --rm --userns=keep-id -v "$PWD":/app:z -w /app/source docker.io/library/node:22-bookworm@sha256:0e5f906573693feaa1e21057ebdcfdb5bd5021f050b2dc7c9deceb629c7da2a8 npm run build`.

Neither the wasm nor the test fixtures are in git; both are built, and the
build is reproducible. `engine.json` records the sha256 the engine build must
produce, and `build.sh` refuses a binary that differs (after a deliberate
change to `shim.cpp`, a patch or a version, build with `REPIN=1` and commit the
new `engine.json`). `scripts/package.sh` builds the engine itself when it is
missing.

The app builds without the `.wasm` too, with a loud warning, and the player
then reports exactly which file is missing. Useful for UI work; do not ship it.

The browser test against a real OpenCloud is documented in
[`source/e2e/README.md`](source/e2e/README.md).

### Two numbers worth knowing

libsidplayfp's mixer works in 5000-cycle chunks, about 224 frames at
44.1 kHz. Asked for fewer samples than that it never runs the CPU and returns
silence, so the adapter renders 512-frame bursts and feeds the worklet's
128-frame quanta from a small FIFO.

In V8's WebAssembly the emulation ran at about 7× realtime on the build
machine with all three voices sounding, which is 0.42 ms of compute per
128-frame quantum against the 2.9 ms one allows. Comfortable on a desktop; on a slow phone it may drop out. The fix
for that, if it is ever needed, is to move the engine into a Worker that
renders ahead and hands chunks to the worklet, which the message protocol
already resembles.

RSID tunes and BASIC tunes need the C64 kernal ROM. The repository carries
`kernal.bin`, `basic.bin` and `chargen.bin` in `public/vendor/sid-engine/`;
they are Commodore's, copyright its successors, and not under this project's
licence. Delete them before `npm run build` for a build without them; PSID
tunes play either way.

## Develop against a real OpenCloud

```
cd source
npm run build:w                  # rebuilds dist/ on save
docker compose up -d             # https://localhost:9200, admin / admin
```

Upload a `.sid` file and click it. Apps are discovered at startup and the
manifest's entrypoint is remembered, so restart the container after every
build that changes the JavaScript, not just the first.

## Install

Each [release](https://github.com/GaijinSystems/opencloud-sidplayer/releases)
carries a tarball and a zip whose single top-level directory is `sidplayer/`,
so either extracts straight into the apps folder:

```
sha256sum -c opencloud-sidplayer-1.2.2.tar.gz.sha256
tar -xzf opencloud-sidplayer-1.2.2.tar.gz -C "$WEB_ASSET_APPS_PATH"
```

`scripts/package.sh` builds the same tarball into `release/`.

`WEB_ASSET_APPS_PATH` defaults to `$OC_BASE_DATA_PATH/web/assets/apps`; under
opencloud-compose the host path is `config/opencloud/apps/`, not the data dir,
which the apps mount shadows. Files must be readable by the user OpenCloud
runs as; the app never writes to its own folder, so a read-only mount is fine.
**Restart the web service afterwards** — the entrypoint file name changes with
every build and is remembered at startup.

There is no apps list to edit and no activation step. The app registers the
`sid`, `psid`, `rsid`, `mus`, `str` and `wds` extensions itself and adds its
own application-menu entry.

**One policy change is required.** The emulator is WebAssembly, so
`script-src` needs `'wasm-unsafe-eval'`; see [`deploy/csp.yaml`](deploy/csp.yaml),
which is deep-merged via `PROXY_CSP_CONFIG_FILE_LOCATION`. Without it the app
opens tunes and the player says the engine could not start. Retest in a
private window: the old policy is cached with the document.

**The library needs one more route**, on whatever proxy already fronts
OpenCloud: see [`deploy/haproxy-hvsc.cfg`](deploy/haproxy-hvsc.cfg). Without
it everything except checking for and downloading HVSC releases still works.

The C64 ROMs are Commodore's, not this project's, and the release includes
them. `scripts/package.sh --no-roms` builds a tarball without them; the player
then plays PSID tunes and names the file it needs for the rest.

[`INSTALL.md`](INSTALL.md) covers all of this in order, plus upgrading and
removal.

## Configuration

Defaults ship in `manifest.json`; nothing needs to be created. Override them
globally in `$OC_BASE_DATA_PATH/config/apps.yaml` under a `sidplayer:` key, or
for one deployment in a `config.json` beside the manifest — the same file the
radio app uses — which survives an upgrade because the tarball only replaces
the paths it carries. Every value is
clamped, so a typo degrades to a default.

| Key | Default | Notes |
|---|---|---|
| `registerAsDefault` | `true` | Take over left-click at all. Off: only "Open with" and the context menu. |
| `clickPlaysInPlace` | `true` | Left-click plays in the dock and keeps the Files list. Off: left-click opens the full view. |
| `maxFileSizeKb` | `1024` | A SID is at most 64 kB plus a header. 8–65536. |
| `defaultSongLengthSeconds` | `180` | Length assumed for a subsong that Songlengths.md5 does not know. 5–3600. |
| `songlengthsUrl` | `null` | URL of an instance-wide HVSC `Songlengths.md5`. A copy found in the user's space wins. |
| `autoPlay` | `true` | Start on open. Browsers may still require a tap; the bar says so. |
| `analyserEnabled` | `true` | Spectrum display. Users can turn theirs off. |
| `hvscPath` | `/SID Library` | Folder in the user's space the app works out of. A collection left in the old `/SID Player` is found and used where it is. A first sync puts HVSC in `C64Music/` inside it — the folder HVSC's own archives unpack into — leaving room beside it for other collections. A collection sitting straight in this folder, with no `C64Music/` level, is found just the same. |
| `hvscMirrorPath` | `/hvsc-mirror` | Same-origin path forwarding to an HVSC mirror; see below. |
| `assetBaseUrl` | `null` | Override where `public/` assets are served from. |
| `version`, `buildTag` | written by the build | What the library shows under its own name, and the full stamp behind it. Not for editing. |
| `engineBaseUrl` | `null` | Directory holding `sid-processor.js` and `engine.js`, to host the engine elsewhere. |

## How it behaves in Files

**Left-click plays in place.** Clicking a tune starts it in a dock across the
bottom of the page; the Files list stays where it was and shrinks to make
room. The dock shows previous, play or pause, next, the title with composer
and subsong, the position, a spectrum strip, mute and volume, an expand
button, preferences, and stop. It stays while you browse folders and when
you open the full view or the library. Switching to any other app — from the
application menu, the settings, or another viewer opened from Files — stops
the tune and closes the dock. Clicking the tune that is already playing
resumes it rather than restarting it.

**Right-click opens the full view.** The context menu's "Open with…" submenu
offers "Open in SID Player", the full-screen view with the header details and
words. The full view attaches to whatever is already playing without a
restart, and leaving it hands the controls back to the dock. "Open" at the
top of the menu is the default action, so it plays, the same as a left-click.

**Preferences** are behind the gear in either place and are saved per device:

- Appearance: System (follow OpenCloud), Light or Dark, applied to the player
  only, the way the radio app does it. Offered when the instance has both a
  light and a dark theme.
- Spectrum display, on by default.
- Emulation: the SID chip (as the tune says, MOS 6581, or MOS 8580) and the
  machine (as the tune says, PAL, or NTSC). Changing either restarts the
  tune, because libsidplayfp rebuilds the emulated chips.

**Voices.** The full view has three buttons, one per voice of the first SID,
and the keys `1`, `2`, `3`. A mute takes effect where you press it, mid-note,
and fades over about 4 ms so there is no click. That needed a patch to
reSIDfp, which otherwise mutes a voice by zeroing the tune's next write to
its control register and so does nothing at all to a tune that sets a voice
up once and leaves it alone; see
[`source/engine/patches/`](source/engine/patches/).
`tests/fixtures/tone3.sid` is three voices on distinct pitches for checking
this by ear; `tone.sid` uses voice 1 only, so its other two buttons have
nothing to remove.

**Song lengths.** A SID tune has no end, so the player needs to be told. If
HVSC's `Songlengths.md5` is anywhere up the folder tree from the tune, beside
it or in `DOCUMENTS/` as the collection lays it out, it is used automatically;
the details panel says so and shows the collection path. The nearest one that
actually lists the tune wins, so an older copy, or one kept beside a few
tunes, does not stand in the way of one further up that knows more. Failing
those, the `songlengthsUrl` configuration key can point at an instance-wide
copy, and failing all of them the tune runs for `defaultSongLengthSeconds`. A
copy that could not be read - an expired session, a server having a bad
minute - is asked for again by the next tune rather than taken as absent.
Lookup is by the whole-file MD5, as HVSC has keyed the file since release 68.
A tune played from the library already has its lengths from the catalogue,
and the player takes them from there rather than reading the file again.

The dock is a small Vue app of its own mounted from the `ready()` hook,
because the shell has no extension point at the bottom of the page and the
route tree is torn down when the user leaves the app's route. It shares the
shell's Vue and design tokens, and shortens the shell's `#web` root by its own
height so the last row of a list is never hidden. To get the old behaviour,
left-click opening the full view, set `clickPlaysInPlace: false`.

## The library

"SID Library" in the application menu opens a second view of the same app: the
whole High Voltage SID Collection, kept in your own space at `/SID Library/C64Music`, played
through the same engine — a tune started in the library keeps playing when you
switch to Files, where the dock picks it up, and the other way round.

Three panes. The collection tree on the left, with MUSICIANS expanded because
that is where 56,568 of release 85's 61,157 tunes live, against 3,058 in DEMOS
and 1,531 in GAMES. The library opens on your favourites if you have starred
anything it can list, and on the composers if not; after that it stays where
you leave it until the page is reloaded. Clicking a folder lists everything beneath it, not just
its own files — in HVSC the folders worth clicking hold nothing but
subfolders — so the list always matches the count the tree prints beside the
name, windowed to 400 rows with the remainder counted. The tunes in the middle, with the title, release line and
subsong count the file itself declares. On the right, what the collection knows
about the selected tune: its header, the picture it was passed around with
and what it is actually being played on where it is the tune playing, its per-subsong lengths from
`Songlengths.md5`, its STIL commentary where there is one — 18,898 of the
61,157 tunes have an entry — and its composer's real name and country from
`Musicians.txt`.

**What it is playing on.** A tune declares which SID it was written for and
which machine, and neither has to be what it gets: the preferences can force
a chip or a clock, and a tune that expresses no preference is given the
engine's default rather than nothing. For the tune actually in the engine the
right-hand pane says which chip and machine are in use, the processor clock
that follows from it — 985,248.6 Hz on PAL, 1,022,727.3 Hz on NTSC, as
libsidplayfp computes them from the colour burst — and, where they differ,
what the tune had asked for. A tune written for more than one SID says how
many and at which addresses.

**Playing a list.** Starting a tune takes the list in front of you as the
running order, and the double arrows at either end of the transport move
along it. Once a tune has played through all its subsongs the next one
starts, at its own first subsong. The order is taken once, when you press
play, and then left alone: search for something else while it runs and the
double arrows still walk the list you put on, because what follows a tune is a
question about where it came from rather than about wherever you have
wandered since. A tune started from the Files browser has no list behind it,
so those two buttons are simply absent there.

The controls read outward from the middle — the list at both ends, the
subsongs of this file either side of the centre, and the circular arrow
beside play to start the current subsong again. All four arrows are the same
glyph family, a bar with triangles against it, and the count says how far the
button moves: one triangle steps within the file, two step off it. Nothing repeats on its own,
and nothing remembers where you were: a new tune always opens at subsong 1,
even where its header names another as the one to start on. That choice is
still listed in the details as the default subsong. Pausing and resuming
carries on where it was.

The ✕ at the right end of the bar stops the tune and lets go of it, as the
same button does in the dock in Files. It is there only while a tune is
loaded; with nothing playing there is nothing for it to close.

**The row above the list** reads the same way whatever you are looking at:
where you are on the left, how many on the right — `Search · hubbard` and
`412 results`, `MUSICIANS/H` and `2,183 tunes, including subfolders`,
`Favourites` and `3 favourites`. The count used to be the tail of the search
breadcrumb, where it scanned as part of a path and shifted about with the
length of the query. Clearing a search is the ✕ to the **left** of the search
field, a back action in the place back actions go; it used to be a "Clear" at
the right end of this row, four pixels above the column of stars, where it
read as an offer to unstar everything. Its slot is held open whether or not
there is anything to clear, and an empty one of the same width sits on the
other side of the field, so neither the field's width nor its position
changes as you type. Chromium's own clear button, which Firefox does not
draw at all, is suppressed so there is exactly one.

**Favourites** are starred with the ★ on each row and listed under Favourites
in the tree. They can be put in any order you like — drag a row by its handle,
or use the ▲ ▼ buttons, which is the same thing for a keyboard. The order is
kept in `.sidplayer/favourites.json` beside the stars themselves, so it follows
your account to another device rather than living in one browser, and each
position carries its own timestamp: reordering does not restar anything, so
merging on the star time alone would throw the order away every time two
devices met. A tune starred somewhere that has never been reordered has no
position of its own and goes to the end. Sorting a column overrides the
hand-made order and hides the handles while it does, keeping their column
reserved so nothing slides sideways; clearing the sort brings it back.

**Sorting.** Clicking a column heading — Title, Released, Songs or Length —
sorts, clicking it again reverses, and a third click restores the order the
view had on its own. That third click matters more than it does in most
tables: the order it comes back to is path order in a folder and *relevance*
in a search, and nothing else would bring that back. Sorting is over the whole
result set, not the 400 rows on screen, so sorting all 61,157 tunes by length
really does put the collection's longest at the top. It survives moving
between folders, rows whose header has not been read yet sort last rather than
bunching at whichever end the direction sends them, and a tie keeps the order
it already had.

**Search** is over the whole release, not just over what is downloaded.
Measured in Chromium against the genuine 61,157-entry manifest: the library
opens in 1.6–2.4 s including 9 MB of documents, the first query answers in
0.3–0.8 s from typing to painted rows while the index is built and later ones in
20–100 ms, and the page holds 117–125 MB. `/` focuses the field. Typing switches the middle pane to results and Escape switches
back. Names are matched the way the collection spells them, so "hülsbeck",
"huelsbeck" and "hulsbeck" all find `Huelsbeck_Chris`, and a composer is found
by handle, folder, real name or group. The field also takes
`composer:hubbard`, `year:1985..1988`, `songs:>1`, `chip:6581`, `path:DEMOS/`,
`stil:cover` and quoted phrases.

**Tunes you have not downloaded** are in the list too, because the catalogue
describes the release rather than the folder. In a folder listing they say
"not downloaded, plays on demand", and playing one fetches that single file
through the mirror path and writes it where it belongs — so browsing during a
first sync works, and the sync has that much less left to do. Search results
span folders nobody has opened, so there the library says nothing about what
is local rather than guessing.

**Whatever it is doing, it says so.** One status line in the top bar covers
the release check, the folder walk behind an update plan, a running or paused
sync, and a header pass — each with a count or a percentage, and clickable to
reopen the update panel. Planning in particular walks about 1,951 folders on
a real collection, and a sync used to become invisible the moment its panel
was closed.

**Index all tunes** appears in the top bar when headers are missing. A sync
reads every tune's header for free, having the bytes in hand; a collection
unpacked from an archive arrives without them, and until they are read a tune
shows its file name rather than its declared title and the chip and year
filters have little to work with. The button reads all of them — about 8 MB
for release 85, 128 bytes per file — with progress, and can be stopped
without losing what it has read.

**Where it all lives.** One folder, `/SID Library`, holding

```
/SID Library/
  C64Music/     the High Voltage SID Collection
  CGSC/         Compute's Gazette, read straight from its own folder
  .sidplayer/   favourites, and what the library knows about the release
```

`C64Music/` is the folder HVSC's own archives unpack into, so extracting one
here needs nothing moved afterwards, and anything else you keep sits beside it
rather than mixed into it. `CGSC/` is read too, as a second collection —
see below. The app's own folder hangs off `/SID Library` rather
than off the collection, so favourites are not inside a tree that a
re-extracted archive or a sync's removals pass could disturb. A collection put
straight in `/SID Library`, with no `C64Music/` level, is read just the same —
that is what older installs have.

The folder was called `/SID Player` until it was renamed to match the name in
the launcher. Nothing moves on its own: when the configured folder holds no
collection the app looks in the old one, and works out of it where it finds
it. That costs one listing on a first run and nothing at all otherwise. Rename
the folder yourself whenever you like, or set `hvscPath` to keep it where it
is.

**The second collection.** Unpack the Compute's Gazette SID Collection into
`/SID Library/CGSC` and it appears in the tree under a heading of its own,
below HVSC. It is a different kind of archive and the library treats it as
one: 16,601 `.mus` tunes in 447 composer folders, with **no manifest, no
MD5s, no song lengths, no headers and no mirror**. Everything the list shows
about a tune there is read off its path, and everything that would need a
document says so rather than showing a blank — a length column reads `—`, not
`0:00`, and the player works out how long a tune lasts from its own score as
it plays.

Selecting a tune reads that one file, a few kilobytes, and the right-hand
pane then shows what it says about itself: the title, author and release line
from its own credits, `MUS` or `MUS+STR` where a `.str` beside it adds three
more voices on a second SID, the one subsong it has, and a length worked out
from the score, with the file's MD5 under it as an HVSC tune has. What was
read is kept in the browser, so a tune is fetched once, not once a visit;
nothing is read ahead of time to fill the list. A Compute's Gazette MUS file
does not record which chip or machine it was written for, so the pane claims
neither.

The 447 composers are divided into about ten letter groups, sized by how many
folders fall in each, so `S` gets a row to itself and `W` through `Z` share
one. A group expands; it does not open, since it stands for several folders.

Search covers both collections and keeps their results apart, under a heading
each: an HVSC row can match on its title, its composer's real name and a line
of commentary, and a Compute's row has only a file name and a folder, so
ranking the two against each other would bury the second for reasons that say
nothing about which tune anyone wanted. A filter that only a header can
answer — `year:`, `chip:`, `clock:`, `stil:` — says so under that heading
rather than returning nothing and letting the silence read as an answer.
`songs:` is not one of those: a MUS file is one score with no subsongs, so a
row there answers with 1 and means it.

Favourites are keyed by path **and MD5**, the hash being what survives a tune
moving between releases, which HVSC's update scripts do with `MOVE` records.
Compute's rows can be starred too: a star is the app's own idea rather than
anything HVSC records, so there is no reason the second collection cannot have
one. Those keep only the path, that collection publishing no MD5 anywhere, so
a star there would be lost if its folders were ever reorganised. The stored
record names which collection it came from, since a path alone tells the two
apart only by the accident that they spell their top level differently.

**How it is read.** A walk of 500-odd folders is the better part of a minute
before the first row appears, so the app looks for a path index first and
falls back to walking without one:

```
cd "/path/to/CGSC"
find . -type f ! -name .sidplayer-index.txt | sed 's|^\./||' | LC_ALL=C sort \
  > .sidplayer-index.txt
```

That is one GET of about a megabyte instead. It is read, not trusted: lines
that name no `.mus` file are ignored, and a tune the index lists but the
server has not got simply fails to play. Reading it happens *after* the
library is open, so nothing about it delays HVSC.

**Getting the collection.** With nothing there the library offers two ways
to start:

- **Online** fetches only the collection's four documents, about 9 MB. The
  whole release can be browsed and searched straight away, and each tune is
  fetched into your space the first time you play it, checked against its MD5,
  and played from there afterwards. A tune's title, year and chip model come
  from its own header, so until it has been played its row shows the file
  name, and searches by `year:` or `chip:` reach only the tunes you have.
  Updates refresh what you have and fetch nothing else. **Download all…** in
  the top bar fetches the rest whenever you choose, and once that has finished
  the collection is a whole one from then on. Nothing ever starts the full
  download on its own.
- **Download everything** fetches release 85 now: 61,157 files, about
  395 MB, roughly two hours, resumable.

Or put HVSC's own archive there yourself and skip the wait, after which the
first sync only fetches what is missing or has changed, checked by MD5. Which
of these a collection is, is kept in `.sidplayer/status.json` beside it, so it
is the same on every device.

> **Through OpenCloud, never onto its storage directory.** Unpack locally and
> upload with a sync client or the web interface, so the files arrive as
> OpenCloud's own. Its storage keeps names, parents and ids as metadata beside
> the bytes, so anything written into the data directory from outside — files
> dropped in, a folder renamed with `mv` — leaves the two disagreeing: the
> folder keeps its old name in every listing, some files resolve and others do
> not, and writes fail with `decomposedfs: root has no parent`. The same goes
> for renaming this folder afterwards: do it in the web interface, or leave it
> alone and point `hvscPath` at whatever it is called.
Every file is verified against the collection's own MD5 manifest as it lands,
so an interrupted download repairs itself rather than starting again, and you
can browse and search the whole release while it runs.

**Updates** are checked when you open the library, at most once a day, and
never downloaded without being asked. When HVSC publishes a release the banner
says so; the plan is shown before anything is written, and files the release no
longer has are listed and left alone unless you choose to delete them — a
checksum diff cannot tell a withdrawn tune from one of your own that happens to
sit under `/SID Library/C64Music`. Even then nothing is deleted by an update in
which any file failed to arrive; the next plan offers the deletions again.

**One deployment change is needed**, and only for the library: a path on your
own origin that forwards to an HVSC mirror. The browser cannot reach HVSC
directly — its version API answers 403 to anything carrying an `Origin` header
and no mirror sends CORS headers — so `deploy/haproxy-hvsc.cfg` adds
`/hvsc-mirror/` to your front proxy, read-only. Without it the library still
opens and still plays whatever is already there; it simply cannot check
for or fetch anything.

## Formats

| Extension | What it is | How it is handled |
|---|---|---|
| `.sid`, `.psid`, `.rsid` | PSID or RSID, the HVSC format | Header parsed here; played by libsidplayfp. RSID and BASIC tunes need the kernal ROM. |
| `.mus` | Compute!'s Sidplayer tune | Played by libsidplayfp's built-in Sidplayer driver. Credit lines are shown; the first three become title, author and released. |
| `.str` | The stereo half of a Sidplayer tune | Appended to the `.mus` of the same name in the same folder, giving a second SID at `$D500`. Clicking it opens the tune. |
| `.wds` | Sidplayer words | Shown as text under the credits, best effort. The format's timing is undocumented, so the lines are not synced to the music. Clicking it opens the tune. |
| `.pic` | A picture that came with a Sidplayer tune | A Koala Painter or Doodle! bitmap, told apart by where it loads. Drawn beside the tune at 320x200, stretched to the 4:3 a C64 put it on a television. |
| `.pgg`, `.pjj` | The same, run-length packed | Unpacked and drawn the same way. Whether a file is packed is read from the bytes, since three of the collection's `.pic` files are packed too. |

**How long is a Sidplayer tune?** Nothing says. The Compute's Gazette
collection has no equivalent of HVSC's `Songlengths.md5` — I looked through
all 132 of its documents — and libsidplayfp offers nothing at playback time,
using the score's terminating `HLT` only to validate the file as it parses
it. So the length is worked out from the score itself: MUS carries note
durations and a tempo, and `TEM`'s operand divided into 14,400 is quarter
notes per minute. It is not a sum — 42.5% of the collection repeats sections
with `HED`/`TAL` and 68.8% calls phrases defined with `DEF`/`END`, so the
stream is interpreted, jumps and all, and a repeated section is re-walked
rather than measured once and multiplied, because the tempo may change inside
it.

Two specs for the format ship in the collection's own documents.
`MUS_format_A.txt` says up front that it was written "without any reference
to the book" and its duration masks contradict themselves — hex 20 is listed
as both DOTTED and 64TH — so `MUS_format_B.txt` is the one followed here. Its
rule that a note pair carries `00` in the low two bits of its first byte is
what makes the stream walkable at all, and it holds for every frequent byte
across all 16,601 tunes.

Two things in that arithmetic are documented nowhere — the tempo the driver
starts at, and whether `HED n` plays a section n times or n times again — so
they were measured rather than guessed. `scripts/verify-mus-length.mjs` plays
tunes through the real engine, notes where the sound stops and compares. The
starting tempo turned out to be 144, not the 120 first assumed, which was the
single largest source of error: four tunes that set no tempo anywhere were
all short by the same 1.202.

**The figure is an estimate, and playback does not rely on it.** Fitted on 40
tunes it lands within 5% of what plays on half of them and within 15% on
four in five — but on a fresh sixteen it was worse, out by more than half on
one tune, in both directions. So the clock shows it and nothing stops on it.
What ends a Sidplayer tune is the worklet listening: the driver halts every
voice and the SID falls silent, and after eight seconds of quiet the tune is
called over. That wait has to clear the longest rest *inside* a tune —
measured across a sample, mid-tune gaps are under a second in twenty cases
out of twenty-four and the worst seen was 4.9 — so eight seconds leaves room
without being long enough to sit through by accident.

**Pictures** come from the Compute's Gazette Sid Collection's separate
add-on, whose folders mirror the music's; merge the two and a tune with a
picture shows it. About 3% of the collection has one — 554 files against
16,601 tunes. The packing is undocumented, so the rule was read off the
files and then checked against every one of them: `$FE`, the byte to
repeat, then the count, with zero meaning a full 256. The add-on's `.ani`
files are left alone, being 6502 machine code rather than bitmaps.

Format is decided from the bytes, not the name: a `.sid` that is really an
Amiga SidMon II module is reported as exactly that. SidMon itself is an
Amiga tracker format and is not played; it would need a 68000 and Paula
emulation, not a 6502 and a SID.

## Keyboard

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `←` / `→` | Previous / next subsong |
| `Home` | Start this subsong again |
| `PgUp` / `PgDn` | Previous / next tune in the list |
| `↑` / `↓` in the left column | Move between rows, rather than scrolling it |
| `↑` / `↓` | Volume |
| `m` | Mute |
| `s` | Show or hide the spectrum |
| `i` | Show or hide header details |
| `1` `2` `3` | Mute or unmute a voice |

These work in the full view, which holds keyboard focus. The dock has no
global shortcuts: it shares the page with whatever the user is doing.

## Things inherited from the sibling apps, and why

These patterns come from earlier OpenCloud apps. They
are load-bearing, not style:

- **The route name equals the app id.** Other names are namespaced by the
  runtime and the file action silently disappears.
- **`App.vue` declares only the props it uses.** AppWrapper inspects them;
  declaring `url` or `currentContent` makes it fetch the file first.
- **All layout is inline styles.** The app ships no utility CSS; a Tailwind
  class works only if the OpenCloud shell happened to compile it, and a
  missing one fails silently. Colours use `var(--oc-role-*)` directly.
- **Every worklet round trip has a timeout.** A dead worklet never rejects.
- **The manifest carries a build stamp**, so a stale deployed copy is
  recognisable at a glance.

## Not yet done

- **The sync at full size.** 61,157 downloads and about 1,951 folder
  listings have only ever run against a handful of files. Everything else
  about a real collection is measured — see the scale row above — but not
  this.
- **The library on a phone.** It is a three-pane desktop layout: measured at
  390 px it overflows by 222 px. The dock in the Files app is fine on a
  phone; this view is not.
- **Spaces other than your own.** The library reads the personal space, so a
  collection kept in a project space is not supported.
- **Per-voice mute covers the first SID only.** A tune with two or three
  chips has voices the buttons do not reach.
- **`.ani` files are not shown.** The picture add-on's thirty-two of them
  are 6502 routines the C64 player executed, not images to decode.
- **Sidplayer words are shown as plain text.** Syncing them to the music
  needs the `.wds` timing format, for which nobody involved has a
  specification.
- **Seeking.** A SID is not a stream but a program: `init` is called once and
  `play` fifty times a second, and the music is the accumulated effect on the
  chip's registers. There is no position to jump to, because the state at 2:00
  exists only as the result of the six thousand `play` calls before it. So
  seeking means re-running them, and measured against this engine that is
  **7.3x realtime**, flat:

  | Seek to | Compute |
  |---|---|
  | 0:10 | 1.4 s |
  | 1:00 | 8.2 s |
  | 3:00 | 25 s |

  libsidplayfp's `fastForward` is not a way out: it takes a ratio of 1 to 32,
  but `mixer.cpp` shows it only thinning the *output* samples. The 6502 and
  reSIDfp still run at full rate, so it saves the resampling and nothing that
  matters here. Checked so nobody has to check it again.

  Twenty-five seconds rules out the audio thread, which would stop playing,
  and the main thread, which would freeze the page. The only honest build is a
  second engine in a Worker that renders silently to the target and then takes
  over, with progress shown and the seek cancellable when someone clicks
  elsewhere - a second wasm instance, a handover protocol and cancellation, so
  a day rather than an afternoon. Seeking to 0:00 is free, being a reload, and
  the circular arrow beside play already does it.
- **Levelling the volume between tunes.** Tunes vary widely in how loud they
  are, and nothing evens them out. Sketched below, not built.
- **Translations.** Every string is English.

## Levelling the volume, sketched

Tunes differ a great deal in level, and the player does nothing about it. The
files must not be touched, so anything here is measurement at playback and a
gain applied after it. Four ways it could go, with what is wrong with each.

**Remember the peak, use it next time.** Watch the output, record the peak
against the tune's MD5, and apply the compensating gain from the first sample
the next time that tune is played. Exact and almost free, and no help at all
on a first hearing, which is the common case. Worth having underneath one of
the others rather than on its own.

**Adjust while it plays.** Track the peak so far and move the gain to hold a
target. The trouble is that the loudest moment of a SID is often a drum hit
forty seconds in, so the tune is turned down in the middle of a phrase, which
is more annoying than the imbalance being fixed. Giving it attack and release
constants turns it into a compressor, which changes the music rather than its
level.

**Render ahead and measure before anything is heard.** The engine runs at
about eight times realtime, so several seconds of a tune can be rendered,
measured and discarded before a note reaches the speakers, and the gain set
correctly from the first sample. This is the one the architecture already
favours. It costs a short delay at the start of every tune, and a window that
misses a later, louder section guesses wrong.

**Measure loudness, not peak.** Peak is the wrong quantity: a square-wave
lead at half scale sounds far louder than a triangle bass at full scale.
Something in the spirit of EBU R128 integrated loudness over the sampled
window would match what an ear objects to, for a little more arithmetic.

The combination worth building is the third and the first: render a window at
start-up, measure loudness rather than peak, apply the gain at once, and keep
the answer against the MD5 so the delay is paid once per tune and never
again.

Two things need deciding before any of it. Whether the gain may raise quiet
tunes or only lower loud ones, since raising risks clipping when the real
peak arrives after the measured window. And whether it is a preference at
all: someone playing one composer's work in order may well want the levels
that composer chose.

## Licence

AGPL-3.0, matching OpenCloud; the full text is in `LICENSE`. libsidplayfp and reSIDfp are GPL-2.0-or-later;
see `source/public/THIRD-PARTY-NOTICES.txt`, and the build copies their
licence text beside the binary.
