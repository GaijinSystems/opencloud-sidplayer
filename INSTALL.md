# Installing OpenCloud SID Player

The release tarball is the built app. There is nothing to compile.

```
release/opencloud-sidplayer-<version>.tar.gz          the app
release/opencloud-sidplayer-<version>.tar.gz.sha256   checks the tarball and the two files below, from release/
release/opencloud-sidplayer-<version>.SHA256SUMS      checks an installed copy, from $WEB_ASSET_APPS_PATH
release/deploy/csp.yaml                               required, step 2
release/deploy/haproxy-hvsc.cfg                       only for the library, step 4
```

**Nothing has to be configured to enable the app.** The web service composes
its list of apps from the folder itself, so unpacking and restarting is the
whole installation — verified with no `apps.yaml` present at all: the app
appears and runs on the defaults in its own manifest. The two files under
`deploy/` are not about enabling it; one is a policy fragment the emulator
needs, the other is optional and only for the library. They sit beside the
tarball rather than inside it because everything inside the app folder is
served to browsers, and those two are for the server.

Build one with `scripts/package.sh`; see [Building a tarball](#building-a-tarball)
at the end.

## 1. Check and unpack

```
cd release
sha256sum -c opencloud-sidplayer-<version>.tar.gz.sha256

tar -xzf opencloud-sidplayer-<version>.tar.gz -C "$WEB_ASSET_APPS_PATH"
```

The tarball's one top-level directory is `sidplayer/`, so this lands as
`$WEB_ASSET_APPS_PATH/sidplayer/manifest.json` — exactly where the web service
looks. `WEB_ASSET_APPS_PATH` defaults to `$OC_BASE_DATA_PATH/web/assets/apps`,
commonly `/var/lib/opencloud/web/assets/apps`; under opencloud-compose the
host path is `config/opencloud/apps/`, because the apps mount shadows the data
directory.

The files must be readable by the user OpenCloud runs as, usually uid 1000.
The app never writes to its own folder — a read-only mount is fine, and is how
the packaged build is tested.

To verify an installed copy later — note this one runs in the apps folder,
because its paths start at `sidplayer/`, while the `.tar.gz.sha256` above runs
in `release/`:

```
cd "$WEB_ASSET_APPS_PATH" && sha256sum -c /path/to/opencloud-sidplayer-<version>.SHA256SUMS
```

**There is no apps list to edit.** The app registers the `sid`, `psid`,
`rsid`, `mus`, `str` and `wds` extensions itself, and adds its own entry to
the application menu.

## 2. Allow WebAssembly

The emulator is WebAssembly, so `script-src` needs `'wasm-unsafe-eval'`.
This comes from OpenCloud's own **proxy service**, not from your reverse
proxy, and `deploy/csp.yaml` holds only that one directive because the file
is deep-merged with the built-in default — everything your identity provider
and other apps rely on stays as it is.

```
PROXY_CSP_CONFIG_FILE_LOCATION=/etc/opencloud/csp.yaml
```

**If you already point that variable at a file, add to it instead.** The
variable takes one path, so a second app cannot have its own: the radio app,
for instance, needs `media-src https:` for its stations. One file serves
both, verified to produce both directives at once:

```yaml
directives:
  script-src:
    - "'wasm-unsafe-eval'"   # sidplayer: compile the emulator
  media-src:
    - "'self'"
    - 'https:'               # radio: play third-party stations
```

Without the script-src entry the app opens a tune and reports that the engine
could not start. Restart the proxy service, then check in a private window —
the old policy is cached with the document:

```
curl -sI https://your-host/ | grep -io "script-src[^;]*"
# -> script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'
```

## 3. Restart the web service

OpenCloud reads `manifest.json` at startup and remembers the entrypoint file
name, which changes with every build. **Restart after installing or
upgrading**, or the shell tries to load a file that no longer exists and says
"failed to load external application sidplayer".

At this point the Files app plays SID tunes: left-click starts one in a dock
at the bottom of the list, right-click offers the full view.

## 4. Optional: the library

"SID Library" in the application menu browses the whole High Voltage SID
Collection, kept in the user's own space at `/SID Library/C64Music` — named after the
folder HVSC's own archives unpack into, so unpacking one into `/SID Library`
is all the installation the collection needs. The library then syncs
only the difference, verified by MD5, rather than fetching 395 MB again. Or
each user can start **online**: about 9 MB of documents up front, and each
tune fetched into their space the first time they play it. It needs one route on
whatever proxy already sits in front of OpenCloud, because the browser cannot
reach HVSC directly: HVSC's version API answers 403 to any request carrying an
`Origin` header, and no mirror sends CORS headers.

`deploy/haproxy-hvsc.cfg` is the configuration: a few lines for the frontend
you already have, and one new backend. **Copy them from that file rather than
retyping them from here.** An earlier copy of them in this guide drifted from
the file and was missing every one of the protections below, so this guide no
longer repeats them. What the lines do, so you know what you are adding:

- **Read-only and confined.** Only GET and HEAD reach the mirror, and the
  path is normalised before the ACL sees it and then held to the characters
  the app itself sends, so `..` - literal, or written with an encoded dot,
  slash or backslash - cannot walk out of `/HVSC/` on the mirror host.
- **Nothing of yours goes to the mirror.** Cookies, `Authorization`, the
  Referer, the `Origin` and the forwarding headers (`X-Forwarded-*`,
  `Forwarded`, `X-Real-IP`, `Via` and the client-address headers the common
  CDNs add, including one an `option forwardfor` in your `defaults` would
  add) are removed before the request leaves, and so is what describes the
  browser - its languages, client hints, fetch metadata and privacy
  signals - with its `User-Agent` replaced by the app's name. A proxy in front of yours that
  puts the user's address in a header of its own needs a line of its own.
- **Nothing of the mirror's runs as you.** Its responses are served on your
  origin but bypass OpenCloud's own policy, so the backend strips
  `Set-Cookie` and the headers that set policy for an origin
  or prompt on it (`Clear-Site-Data`, `Strict-Transport-Security`, `Refresh`,
  `Service-Worker-Allowed`, `NEL`, `Report-To`, `Reporting-Endpoints`,
  `Alt-Svc`, `Accept-CH`, `WWW-Authenticate`), and adds `X-Content-Type-Options: nosniff` and
  a sandboxing `Content-Security-Policy`.
- **Gentle on a volunteer's server.** No health checks, and at most six
  connections to it at a time from your whole instance, queued rather than
  refused, which is what a sync uses anyway - up to 256 waiting, beyond which
  a request is answered 503 at once. The route answers anyone who can
  reach your proxy - the app sends nothing a proxy could check - and this cap
  is what keeps that from costing the mirror more.

The path rewrite belongs in the **backend**: HAProxy evaluates an ACL where it
is used, so rewriting before `use_backend` leaves `path_beg /hvsc-mirror/`
false and sends every mirror request to OpenCloud instead. The normalising
lines need `expose-experimental-directives` in your global section; the file
gives a version-independent alternative if you would rather not.

Check it before opening the app:

```
curl -s https://your-host/hvsc-mirror/C64Music/DOCUMENTS/HVSC.txt | grep -m1 Release
# -> "                                  Release 85"
```

No new services, no credentials, nothing scheduled. Without this route the
library still opens and plays whatever is already in `/SID Library`; it simply cannot
check for updates or download anything, and says so.

## 5. The C64 ROMs

RSID tunes, and PSID tunes that use BASIC, need the real C64 kernal and BASIC
ROMs. The standard tarball includes them: `kernal.bin`, `basic.bin` and
`chargen.bin` in `sidplayer/vendor/sid-engine/`. They are Commodore's, copyright
its successors, and not under this project's licence.

A tarball built with `scripts/package.sh --no-roms` leaves them out (see
[Building a tarball](#building-a-tarball)); the player then plays PSID tunes
and names the file it needs for the rest. To add them to such an install later,
drop the three files (8192, 8192 and 4096 bytes) into
`sidplayer/vendor/sid-engine/` and restart; `engine.json` already lists them as
optional.

**Be aware of what that publishes.** Everything in the app folder is served to
browsers without authentication, so with the ROMs installed
`https://your-host/assets/apps/sidplayer/vendor/sid-engine/kernal.bin` is a
plain download for anyone who can reach the instance. Build a `--no-roms`
tarball, or delete the three files after unpacking, if that is not what you
want.

> **Put nothing into OpenCloud's storage directory by hand.** Collections
> belong in the user's space, uploaded through OpenCloud, not written into the
> data directory on the server. Its storage holds names, parents and ids as
> metadata beside the bytes, so a folder renamed with `mv` keeps its old name
> in every listing and a file copied in is not seen at all — and the writes
> that follow fail with `decomposedfs: root has no parent`. If a collection is
> already in that state, move it out and upload it properly; there is nothing
> this app can do about it from the browser.

## Configuration — optional

**Nothing has to be created.** The defaults ship inside `manifest.json` and
the app runs as it is. If you do want to change something there are two
places, and the merge order is **`config.json` > `apps.yaml` > the
manifest**:

**For this deployment**, in a `config.json` you create beside the manifest at
`$WEB_ASSET_APPS_PATH/sidplayer/config.json` — the same file the radio app uses
for its `directoryEnabled` switch:

```json
{
  "config": {
    "hvscPath": "/Music/SID Library",
    "clickPlaysInPlace": false
  }
}
```

**Globally**, in `$OC_BASE_DATA_PATH/config/apps.yaml`:

```yaml
sidplayer:
  config:
    defaultSongLengthSeconds: 240
    hvscMirrorPath: /hvsc-mirror
```

Both were checked against a running instance: the served app config came back
with the overridden values and every other key still at its default. Every
value is clamped, so a typo degrades to the default rather than breaking the
app. The full table is in [README.md](README.md#configuration); the two the
library adds are `hvscPath` (default `/SID Library`, and a collection left in
the old `/SID Player` is found there and used where it is) and
`hvscMirrorPath` (default
`/hvsc-mirror`).

## Upgrading

```
find "$WEB_ASSET_APPS_PATH/sidplayer/js" "$WEB_ASSET_APPS_PATH/sidplayer/assets" -type f -delete
tar -xzf opencloud-sidplayer-<version>.tar.gz -C "$WEB_ASSET_APPS_PATH"
# restart the web service
```

Unpacking over the top is enough on its own, but the file names in `js/` and
`assets/` carry a content hash, so every upgrade would otherwise leave the
previous version's chunks behind for ever. Clearing those two directories
first keeps the folder honest; the manifest points only at the current ones.

Anything you added survives either way, `config.json` included, because the
tarball only replaces the paths it contains. That cuts both ways for the ROMs:
the release carries `kernal.bin`, `basic.bin` and `chargen.bin`, so an upgrade
puts back any you deleted and replaces any you dropped in under those names.
To keep them out, build with `scripts/package.sh --no-roms` (section 5) or
delete them again after unpacking.

**Upgrading from a version installed as `sidplay/`** (before 1.2.0, when the
app was renamed `sidplayer`): unpack into `sidplayer/` as for a new install,
move any `config.json` across from `sidplay/`, then delete
`$WEB_ASSET_APPS_PATH/sidplay/` - left in place, both copies claim `.sid`
files - and rename a `sidplay:` key in `apps.yaml` to `sidplayer:`. Nothing in
users' spaces needs moving; see the 1.2.0 notes in `CHANGELOG.md`.

The engine files under `vendor/sid-engine/` keep the same names from one
release to the next, so a browser could otherwise pair a cached worklet with
a newly fetched `.wasm`. The build stamps a version onto those URLs as `?v=`,
which is why upgrading needs no cache-clearing ritual beyond the two
directories above.
Verified: after the sequence above, `js/` held only the nine current files,
`config.json` still applied, the ROM images were still there, and the app
re-registered on restart. The collection in `/SID Library` is untouched, and
per-device preferences live in the browser.

## Removing it

Delete `$WEB_ASSET_APPS_PATH/sidplayer/` and restart. The collection stays: it
is the user's own data, in their own space.

## Building a tarball

```
scripts/package.sh                 # build, then package, ROMs included
scripts/package.sh --no-roms       # the same without the ROMs
scripts/package.sh --skip-build    # package source/dist as it stands
```

The build runs inside `docker.io/library/node:22-bookworm` when podman or
docker is available, so nothing needs installing on the host. The emulator
itself is not in the repository: when `libsidplayfp.wasm` is missing, the
script builds it first in the pinned Emscripten image, which needs network
access to fetch libsidplayfp, and the result must match the sha256 recorded in
`engine.json` — see [`source/engine/README.md`](source/engine/README.md).

The ROMs are included by default, as they are in the repository and the
published release; `--no-roms` builds a tarball without them, named
`opencloud-sidplayer-<version>-no-roms.tar.gz`.
