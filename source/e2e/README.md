# Browser smoke test

`smoke.mjs` drives a real headless Chromium against a running OpenCloud with
the built app mounted, and checks the whole chain: sign-in, left-click
routing to the app, header display, the position readout advancing (which
only happens when the audio worklet is rendering WebAssembly-synthesised
sound), subsong navigation, pause and resume, a reload starting at the first subsong, and the
two error paths. Screenshots and page dumps land in `out/`.

Everything runs in containers; nothing needs to be installed on the host
except podman (or docker). Where a step below runs `node` or `openssl`, run
it in the same Node image as the build if you have neither.

## 1. Build the app

```
cd source
podman run --rm --userns=keep-id -v "$PWD":/app:z -w /app docker.io/library/node:22-bookworm@sha256:0e5f906573693feaa1e21057ebdcfdb5bd5021f050b2dc7c9deceb629c7da2a8 \
  sh -c 'npm ci --legacy-peer-deps && npm run fixtures && npm run build'
```

This is a build to test, from `source/` alone; it warns that it cannot find
`LICENSE`. A build to install comes from `scripts/package.sh`, which mounts
the whole repository so the app carries its licence.

(`engine/build-in-container.sh` must have produced
`public/vendor/sid-engine/libsidplayfp.wasm` first, which is not in git; see
`engine/README.md`. It runs `build.sh` inside `docker.io/emscripten/emsdk:3.1.74`,
the version `EMSDK_VERSION` in `build.sh` pins and the build refuses to differ
from without being told.)

Two things about the built app that are easy to meet for the first time here:

- **Everything under `dist/` is served to browsers without authentication.**
  The rig proves it: `smoke.mjs` fetches
  `/assets/apps/sidplayer/vendor/sid-engine/kernal.bin` with no session at all.
  The C64 ROM images in `public/vendor/sid-engine/` are therefore a public
  download from every instance deployed with them.
  `scripts/package.sh --no-roms` builds a tarball without them.
  `prune-dist.mjs` drops anything in that directory `engine.json` does not
  name, so ROM copies under other names never ship at all.
- **The engine files are versioned, the rest of `dist/` is hashed.**
  `sid-processor.js`, `engine.js`, `engine.json` and the wasm keep fixed names
  across an upgrade, so a browser can hold a cached worklet and fetch a new
  wasm. `prune-dist.mjs` stamps `<version>-<commit>` into the manifest config
  and the engine URLs carry it as `?v=`; see the upgrade section of
  `docs/engine-contract.md`. When testing an upgrade by hand, check that the
  `?v=` in the network panel changed - the `ended` / `endOnSilence` protocol is
  exactly the kind of change an old cached processor ignores, and the symptom
  is a Sidplayer tune that plays for ever rather than an error.

## 2. Start OpenCloud with the app mounted

```
cd source
mkdir -p e2e/.oc-config
printf 'sidplayer:\n  config:\n    defaultSongLengthSeconds: 20\n' > e2e/.oc-config/apps.yaml
cp dev/docker/opencloud/csp.yaml e2e/.oc-config/csp.yaml
podman run -d --name oc-sidplayer --userns=keep-id -p 127.0.0.1:9200:9200 \
  -e OC_URL=https://localhost:9200 -e OC_INSECURE=true -e OC_LOG_LEVEL=error \
  -e IDM_ADMIN_PASSWORD=admin -e PROXY_TLS=true -e PROXY_ENABLE_BASIC_AUTH=true \
  -e WEB_ASSET_APPS_PATH=/web/apps \
  -e PROXY_CSP_CONFIG_FILE_LOCATION=/etc/opencloud/csp.yaml \
  -v "$PWD/e2e/.oc-config/apps.yaml":/etc/opencloud/apps.yaml:z \
  -v "$PWD/e2e/.oc-config/csp.yaml":/etc/opencloud/csp.yaml:z \
  -v "$PWD/dist":/web/apps/sidplayer:z \
  --entrypoint /bin/sh docker.io/opencloudeu/opencloud-rolling@sha256:12ca1a695fee78001901ebc2fb85680f6a8eabb3e064d18e11a1d28e18cbd657 \
  -c 'opencloud init || true; opencloud server'
```

The short song length makes end-of-song behaviour observable; basic auth is
only for the uploads below. Wait until `curl -sk https://localhost:9200/`
answers, then upload the fixtures into the admin's space:

```
for f in tone.sid tone-rsid.sid tone3.sid Songlengths.md5 tune.mus tune.str tune.wds tune.pic; do
  curl -sk -u admin:admin -T tests/fixtures/$f https://localhost:9200/remote.php/dav/files/admin/$f
done
curl -sk -u admin:admin -T tests/fixtures/not-a-sid.bin https://localhost:9200/remote.php/dav/files/admin/broken.sid
```

All eight are needed: the test reads a subsong length out of `Songlengths.md5`
sitting beside the tune, and opens the Sidplayer trio from its `.str`. Leaving
them out fails the run at "subsong length comes from Songlengths.md5".

## 3. Run the test

Build the Chromium image once (it layers on the Node image the app builds
with, so it costs about 1.2 GB on top of it):

```
podman build -t sidplayer-e2e -f e2e/Containerfile e2e
```

The drivers run from `e2e/` with the whole of `source/` mounted, not `e2e/`
alone: `harness.mjs`, which they all share, reads the app's folder name out
of `src/defaults.json`, and the tune builders they use live in `scripts/`.

Then:

```
cd source
podman run --rm --network=host --userns=keep-id -v "$PWD":/app:z -w /app/e2e \
  -e OC_URL=https://localhost:9200 localhost/sidplayer-e2e \
  sh -c 'npm ci --no-audit --no-fund && node smoke.mjs'
```

## After every `npm run build`

```
podman restart oc-sidplayer
```

OpenCloud reads `manifest.json` at startup and remembers the entrypoint. A
rebuild that changes the JavaScript changes the chunk hash, and the shell then
tries to load a file that no longer exists: "failed to load external
application sidplayer". A rebuild that only changes files under `vendor/` gets
away without the restart, which is exactly what makes this easy to forget.

## The library test

`library.mjs` covers the standalone library, and needs a different rig: a
front proxy, because the library reads HVSC through a path on its own origin,
and a mirror to read.

The second OpenCloud below exists only so the rig can be built from nothing
without disturbing the instance the other test uses. A real deployment already
has a proxy in front of one OpenCloud and only needs the `/hvsc-mirror/` route
added to it. Three pieces, all local:

```
cd source
# a miniature HVSC in e2e/.mirror
podman run --rm --userns=keep-id -v "$PWD":/app:z -w /app \
  docker.io/library/node:22-bookworm@sha256:0e5f906573693feaa1e21057ebdcfdb5bd5021f050b2dc7c9deceb629c7da2a8 \
  node e2e/make-mirror.mjs
podman run -d --rm --name sid-mirror --network=host --userns=keep-id \
  -v "$PWD":/app:z -w /app docker.io/library/node:22-bookworm@sha256:0e5f906573693feaa1e21057ebdcfdb5bd5021f050b2dc7c9deceb629c7da2a8 \
  node e2e/mirror-server.mjs e2e/.mirror 9400

mkdir -p e2e/.certs && openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout e2e/.certs/key.pem -out e2e/.certs/cert.pem -days 365 \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
cat e2e/.certs/cert.pem e2e/.certs/key.pem > e2e/.certs/test.pem

# OpenCloud must believe it is served from the proxy, or the browser blocks
# its own config, theme and app bundles as cross-origin. It listens on
# loopback because haproxy in front of it does too, and nothing outside this
# machine has any business reaching an instance whose admin password is
# "admin"; --network=host is what lets the two find each other.
podman run -d --name oc-proxied --network=host --userns=keep-id \
  -e OC_URL=https://localhost:9300 -e OC_INSECURE=true -e OC_LOG_LEVEL=error \
  -e PROXY_HTTP_ADDR=127.0.0.1:9201 -e PROXY_TLS=false \
  -e IDM_ADMIN_PASSWORD=admin -e PROXY_ENABLE_BASIC_AUTH=true \
  -e WEB_ASSET_APPS_PATH=/web/apps \
  -e PROXY_CSP_CONFIG_FILE_LOCATION=/etc/opencloud/csp.yaml \
  -v "$PWD/e2e/.oc-config/apps.yaml":/etc/opencloud/apps.yaml:z \
  -v "$PWD/e2e/.oc-config/csp.yaml":/etc/opencloud/csp.yaml:z \
  -v "$PWD/dist":/web/apps/sidplayer:z \
  --entrypoint /bin/sh docker.io/opencloudeu/opencloud-rolling@sha256:12ca1a695fee78001901ebc2fb85680f6a8eabb3e064d18e11a1d28e18cbd657 \
  -c 'opencloud init || true; opencloud server'

podman run -d --rm --name sid-haproxy --network=host \
  -v "$PWD/e2e/haproxy.cfg":/usr/local/etc/haproxy/haproxy.cfg:z \
  -v "$PWD/e2e/.certs":/certs:z docker.io/haproxy:lts
```

Then, against the proxy rather than OpenCloud:

```
cd source
podman run --rm --network=host --userns=keep-id -v "$PWD":/app:z -w /app/e2e \
  -e OC_URL=https://localhost:9300 localhost/sidplayer-e2e \
  sh -c 'npm ci --no-audit --no-fund && node library.mjs'
```

The test resets its own state: it deletes `/SID Library` and rebuilds the mirror at
release 85 before starting, and rebuilds it at release 86 partway through, so
the update banner, the plan and the removals prompt all have something real to
show. The mirror server deliberately sends **no** CORS headers, exactly like
the real one, so a test cannot pass by accident if the proxy route breaks.

## The Compute's Gazette test

`cgsc.mjs` needs the same rig as `library.mjs` and is meant to run after it,
so that there is an HVSC collection for the second one to sit beside. It
writes its own miniature collection into `/SID Library/CGSC` over WebDAV —
six tunes in four composer folders, one of them with a subfolder, plus a
`00_Documents/` that must not appear in a tree of music — and removes it
again at the end.

```
cd source
podman run --rm --network=host --userns=keep-id -v "$PWD":/app:z -w /app/e2e \
  -e OC_URL=https://localhost:9300 localhost/sidplayer-e2e \
  sh -c 'node cgsc.mjs'
```

It runs three times over: with the path index in place, with it deleted so
the collection has to be walked folder by folder, and with the whole folder
gone so that the section disappears. The middle one is the fallback that a
collection someone has just unpacked will actually take.

## The online test

`online.mjs` needs the same rig as `library.mjs` and resets the space the same
way, so run it on its own or before `library.mjs`. It starts a collection
online from the first-run screen, checks that only the documents were
written, plays one tune and checks that exactly that file arrived, then
presses "Download all…", checks that nothing is written before Start, and
lets the run finish.

```
cd source
podman run --rm --network=host --userns=keep-id -v "$PWD":/app:z -w /app/e2e \
  -e OC_URL=https://localhost:9300 localhost/sidplayer-e2e \
  sh -c 'node online.mjs'
```

## The switching test

`switching.mjs` needs the same rig as `library.mjs` and covers the second
click, which nothing else did: one tune after another in a folder, a tune left
part-way through its subsongs and returned to, two clicks in quick succession,
and playing out of three different searches.

```
cd source
podman run --rm --network=host --userns=keep-id -v "$PWD":/app:z -w /app/e2e \
  -e OC_URL=https://localhost:9300 localhost/sidplayer-e2e \
  sh -c 'node switching.mjs'
```

It reads the player bar element by element rather than from `textContent`: the
title, the subsong count and the clock are adjacent nodes with no whitespace
between them, so "subsong 1 of 3" and "0:00 / 5:50" run together into
"...of 30:00 / 5:50" and a regex over the lot reads the song count as part of
the position. It also waits for a clock to be showing at all before believing
a position, since the bar names the file being opened before the engine has
it — reading too early gives the new tune's name over the old tune's time.

Run it after `library.mjs`, which leaves a synced collection behind.

## The real-scale test

`scale.mjs` needs almost no tunes: the catalogue, tree and search index are
built from the collection's documents, so uploading the genuine
`Songlengths.md5`, `STIL.txt` and `Musicians.txt` gives the library its full
61,157-entry workload for 9 MB. It then writes forty tiny PSID files, which it
builds itself, at forty paths the manifest lists under one composer — enough
for a folder's header reads to succeed, so the step that folds them into the
search index actually runs and can be timed. Fetch the documents once:

```
mkdir -p /tmp/hvsc-docs && cd /tmp/hvsc-docs
for f in Songlengths.md5 STIL.txt Musicians.txt; do
  curl -sSO "https://hvsc.brona.dk/HVSC/C64Music/DOCUMENTS/$f"
done
```

Then, against the same proxied rig as `library.mjs`:

```
cd source
podman run --rm --network=host --userns=keep-id -v "$PWD":/app:z \
  -v /tmp/hvsc-docs:/docs:z -w /app/e2e \
  -e OC_URL=https://localhost:9300 -e HVSC_DOCS=/docs localhost/sidplayer-e2e \
  sh -c 'node scale.mjs'
```

It replaces whatever is in `/SID Library`, so run it **before** `library.mjs`.
Running it after leaves the browser holding a cached catalogue of the real
61,157-entry manifest, which `library.mjs` does not clear, and two or three of
its checks then fail against the miniature release.

## Things learned making it work

- **The proxy's ACL is evaluated where it is used.** Rewriting the path in
  the frontend before `use_backend` leaves `path_beg /hvsc-mirror/` false, and
  every mirror request goes to OpenCloud instead — a 200 full of HTML where a
  `.sid` was expected. The rewrite belongs in the backend.
- **`path_beg` does not confine the route; `normalize-uri` does.** HAProxy
  does not collapse `..` unless told to. A browser, and curl without
  `--path-as-is`, normalise before sending, which is why
  `/hvsc-mirror/../../etc/passwd` looked contained the first time it was
  tried. Sent raw, the ACL still matches and the rewrite hands the upstream
  `/HVSC/../../etc/passwd`. `haproxy.cfg` normalises before the ACL, as
  `deploy/haproxy-hvsc.cfg` tells an operator to, and that needs
  `expose-experimental-directives` in `global`: on 3.4.4 the directive is
  still experimental and the config will not parse without it.
- **The mirror route strips what the browser attaches.** To the browser
  `/hvsc-mirror/` is the instance's own origin, so it sends whatever it
  would send to OpenCloud - cookies, `Authorization`, the Referer - and the
  backend forwards to a volunteer's server. The rig runs the same
  header-stripping rules as the deployed config, held to it rule for rule by
  `tests/haproxy-config.spec.ts`, so the test exercises what an operator
  actually runs.
- **The rig binds loopback only.** `haproxy.cfg` binds `127.0.0.1:9300` and
  the containers run `--network=host`, so everything still reaches everything.
  The OpenCloud behind it has `IDM_ADMIN_PASSWORD=admin`, which is not
  something to publish on whatever network the test machine happens to be on.
- **A reverse-proxied OpenCloud needs `X-Forwarded-Proto`** and an `OC_URL`
  that matches the proxy's origin. Without the header the OIDC callback comes
  back 401; without the URL the shell fetches everything from OpenCloud's own
  port and the browser blocks it as cross-origin.
- **Never `page.goto` mid-test.** A full navigation reloads the shell and
  with it the app's session, which is the thing under test; in-flight
  engine fetches die with "Failed to fetch". Navigate the way a user does:
  history back and the shell's own links.
- **Escape closes the whole app** on the shell's side. Anything of ours that
  wants Escape for itself must take focus and stop the event in the capture
  phase, which the preferences panel does.
- **The context menu is "Open", "Open with…", then the standard items.**
  "Open" is whatever the default action resolved to, so with
  `clickPlaysInPlace` it plays; the app's own entries sit in the submenu.
- **Headless Chromium's default view was tiles**, so anything that assumed a
  table row broke. Right-click on the file name works in both views.

- **Headless Chromium has no locale unless told.** OpenCloud sorts the file
  list with `Intl.Collator`, which throws on an empty locale, and the list
  renders as "No files found" with a console error. The script sets
  `locale: 'en-US'` on the browser context.
- **The AudioContext runs in headless Chromium** with
  `--autoplay-policy=no-user-gesture-required`; no fake output device flag
  was actually needed for rendering, but the fake media device flags are
  harmless and kept.
- **`PROXY_CSP_CONFIG_FILE_LOCATION` deep-merges.** The response header
  read back as `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'`, which
  confirms the radio project's account over the comic reader's older one.
- **Apps mounted at `WEB_ASSET_APPS_PATH` are discovered at startup.** The
  manifest is served at `/assets/apps/sidplayer/manifest.json` and the route
  the shell builds is `/sidplayer/personal/admin/<file>`.
