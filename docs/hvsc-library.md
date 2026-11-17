# The HVSC library

The standalone app is a front end for the High Voltage SID Collection kept in
the user's own space at `/SID Library/C64Music`, with the app's own folder
beside it rather than inside it. It browses the collection, plays it through
the same engine the Files integration uses, and keeps it up to date with
upstream HVSC.

Everything here runs in the browser. There is no helper process, no cron job
and no stored credential, which took some establishing: this document records
what was measured, because most of it is invisible from the code.

## Why the browser cannot talk to HVSC directly

- `https://www.hvsc.c64.org/api/v1/version/7z` returns the current release and
  its download URLs, and answers **403 to any request carrying an `Origin`
  header**. It is deliberately closed to browsers.
- The distribution mirror, `hvsc.brona.dk`, sends **no
  `Access-Control-Allow-Origin`** on anything.
- No other mirror does either (`hvsc.de` redirects, `prg.dtu.dk` is gone,
  `deepsid.chordian.net` serves its own copy without CORS), and there is no
  maintained mirror on a CORS-permissive host such as raw.githubusercontent.com.
- `mode: 'no-cors'` is no use: an opaque response cannot be read, and the bytes
  are exactly what is needed.

So a same-origin path is required. `deploy/haproxy-hvsc.cfg` forwards
`/hvsc-mirror/*` to the mirror, read-only, and `hvscMirrorPath` in the app
configuration points at it. Nothing else about the deployment changes.

## Why no archive is downloaded

Recent HVSC releases ship as `.7z` and `.rar` only; the `.zip` variants stop
at older releases, and `HVSC_85-all-of-them.zip` is a 404. The OpenCloud
container is Alpine with `curl`, `wget`, `tar`, `gzip`, `bzip2` and `unzip`,
but no `7z`, `unrar` or `xz`, so an archive could not be unpacked there
without adding a package to a production image.

It does not need to be. Three facts make a file-by-file sync exact and cheap:

- The mirror serves the collection **unpacked**:
  `/hvsc-mirror/C64Music/MUSICIANS/H/Hubbard_Rob/Commando.sid` is a 200 with
  `Content-Type: audio/prs.sid`.
- `C64Music/DOCUMENTS/Songlengths.md5` is a **complete manifest**: 61,157
  entries for release 85, each a path comment followed by that file's
  whole-file MD5. The player already parses this format for song lengths.
- OpenCloud returns each file's MD5 in a PROPFIND:
  `<oc:checksum>SHA1:… MD5:… ADLER32:…</oc:checksum>`.

The manifest and the space's own checksums are therefore directly comparable.
A sync is "fetch the manifest, walk what is local, download what differs",
which needs no state of its own, resumes after any interruption, and repairs
a collection that was edited or half-copied. The `.hvs` update scripts in
HVSC's update packages, with their `MOVE`/`DELETE`/`REPLACE` records, do not
have to be parsed at all.

The release number comes from `DOCUMENTS/HVSC.txt`, whose banner carries a
line reading `Release 85`; it is found by scanning the first 4 kB rather than
by counting lines. The closed version API is not needed either. Both copies
are read this way: the mirror's, to see what is on offer, and the
collection's own, so that a collection unpacked from HVSC's archive knows
what release it is without having been synced by this app.

## Measured numbers

| What | Measured |
|---|---|
| Collection, release 85 | 61,157 SID files, average 6.5 kB, about 395 MB |
| Manifest | `Songlengths.md5`, 5.2 MB; `STIL.txt`, 3.8 MB |
| Complete archive, for reference | 84.8 MB `.7z` |
| Update package, for reference | 3.5 MB `.7z`, requires the previous release |
| Mirror throughput | ~13 files/s at 6 concurrent requests |
| Upload into OpenCloud | ~9 files/s sequential, ~14 files/s at 8 concurrent |
| First sync | ~1.5–2.5 h, resumable |
| A release update | a few hundred files, under a minute |

`Depth: infinity` PROPFIND is refused (`400 Invalid Depth header value`), so
taking inventory walks folders at `Depth: 1`.

## What the manifest does not say

`Songlengths.md5` lists tunes and nothing else - not `STIL.txt`, not
`Musicians.txt`, not itself. Zero of release 85's 61,157 entries is under
`DOCUMENTS/`. A sync driven purely by the manifest therefore downloads the
whole collection and none of its documentation, and the library comes up with
no song lengths, no commentary and no composer names. The four documents are
fetched by name instead, and compared by their own MD5 like everything else.
This was found by the browser test, not by reading.

Two other things the first run through taught, both now fixed in the code:

- Making sure a file's folder exists before writing it costs one MKCOL per
  ancestor per file unless the answers are remembered. Over release 85 that
  is about a quarter of a million requests; remembering makes it one per
  folder, about 3,500.
- In HAProxy an ACL is evaluated where it is used, not where it is written.
  Rewriting the path in the frontend before `use_backend` leaves
  `path_beg /hvsc-mirror/` false, and every mirror request goes to OpenCloud
  instead. The rewrite belongs in the backend.

## What a real collection holds

An unpacked HVSC is more than its tunes, and the sync has to know what is not
its business. Beside `DEMOS/`, `GAMES/` and `MUSICIANS/` a working copy has
`readme.1st`, half a dozen `.d64`/`.d71`/`.d81` disk images of the
anniversary releases, an `update/` folder if an update package has been
applied, and a `DOCUMENTS/` folder full of faqs, `hv_sids.txt` and
`Update_Announcements/`.

The manifest describes none of that: all 61,157 entries in release 85 are
`.sid` files, and all of them under those three folders. So a sync may only
ever propose deleting a `.sid` file under `DEMOS`, `GAMES` or `MUSICIANS`
that the release no longer lists, and the inventory walk starts at those
three plus `DOCUMENTS` rather than at the collection root. An earlier version
of this rule would have offered to delete every file in `DOCUMENTS/` on the
first sync of a real collection.

## How updating works

No polling and nothing scheduled. The app looks when it is opened:

1. Read `/SID Library/.sidplayer/status.json`. If it is missing, or its
   `checkedAt` is more than 24 hours old, fetch `DOCUMENTS/HVSC.txt` through
   the mirror path, compare its release number with the collection's own, and
   write the file back. Nothing is written on the first-run screen, where
   there is no collection yet and the folder would have to be created to hold
   the answer.
2. If upstream is ahead, the library says so. Nothing is downloaded until the
   user asks.

   An **online** collection - `"mode": "online"` in the status file, chosen
   on the first-run screen - holds the documents and whatever has been
   played. Its update plans with the scope `present`: tunes already in the
   space are compared and refreshed, the documents are fetched, removals are
   offered as usual, and nothing the space does not have is added; those
   stay on the mirror and are fetched one at a time as they are played.
   "Download all…" plans with the scope `all`, and only a run of that plan
   that finishes completely takes `mode` out of the status - or an update
   that finds nothing left on the mirror, since every tune is then here. A run stopped
   short leaves the collection online, with what it fetched kept.
3. On confirmation the app fetches the manifest, diffs it against the space,
   and syncs the difference, reporting as it goes. The library belongs to the
   page rather than to the view, so leaving for Files does not stop it;
   closing the tab does. Pausing and resuming carries on from the file it
   stopped at; after a reload, the next run recomputes what is left from the
   checksums, so it resumes rather than restarting. Only one run happens at
   a time, and the documents a run fetches are checked before they are
   written - `HVSC.txt` must name a release, `Songlengths.md5` must list at
   least half the tunes the plan did - with a run whose documents did not
   all arrive left unfinished rather than claiming the release.

Several things guard that sequence, because each of them once went wrong in a
way that looked like an answer:

- A manifest that parses to nothing, or to less than half the catalogue, is a
  failed fetch rather than a release in which the tunes were withdrawn, and a
  plan is refused. A misrouted mirror path lands on OpenCloud's own
  single-page fallback, which answers 200 with HTML. One listing more tunes
  than any release could hold is refused the same way.
- A manifest naming paths the app will not act on proposes no removals at
  all: the tunes behind those paths would otherwise look withdrawn.
- Approved removals are carried out only by a run in which every fetch
  succeeded. A release that moves a tune is one addition and one removal, and
  removing the old copy when the new one failed to arrive loses the tune. The
  next plan lists them again, to be approved again.
- An inventory with unreadable folders in it is refused for the same reason.
  The walk is about 1,951 listings over some three minutes, which is long
  enough for an access token to expire halfway.
- Every file fetched is hashed and compared with the manifest before it is
  written, and a run with any failure in it does not stamp the collection
  with the release it was reaching for.

The sync runs on the main thread rather than in a Worker. It is almost all
waiting on the network, the audio already has a thread of its own in the
AudioWorklet, and a Worker inside a module-federated remote is a bundling
problem worth avoiding for work that does not need it. Building the catalogue
is the one piece of real computation, about 1.6 s once per release, and the
IndexedDB cache means most openings skip it.

`status.json` and `favourites.json` are written by the app, under the user's
own identity, with no additional rights. Favourites are merged with whatever
the space holds before being written, and are not written at all if that read
fails: a list that could not be seen must not be replaced by this device's
copy of it.

## Running it behind a proxy

A deployment that already runs a proxy in front of OpenCloud needs one change
and no new services: the `/hvsc-mirror/` route from `deploy/haproxy-hvsc.cfg`,
added to the frontend it already has. Everything else is as it was.

The rest of this section is about building such an arrangement from nothing,
which is what the test rig does; it is not advice for an instance that already
works. The mirror path only helps if the browser and the mirror share an
origin, so OpenCloud has to believe it is served from the proxy: `OC_URL` set
to the proxy's own origin, `PROXY_TLS=false` where TLS ends at the proxy, and
`X-Forwarded-Proto` set on the way through. Without the forwarded header the
OIDC callback comes back 401; without the right `OC_URL` the shell fetches its
config, theme and app bundles from OpenCloud's own port and the browser blocks
every one of them as cross-origin under the instance's own policy. An instance
already reachable through a proxy satisfies all three by definition.
`source/e2e/haproxy.cfg` is a working example of the whole arrangement.

## Tunes that are not there yet

The catalogue describes the release, so it lists tunes the space may not have:
during a first sync, or in a collection unpacked from an older archive. One
listing per folder visited says which of that folder's tunes are present,
which is what lets a row say "not downloaded" instead of failing when played.
Playing such a tune fetches that one file through the mirror path and writes
it where it belongs. Search results span folders nobody has opened, so there
the answer is honestly unknown and no row claims anything either way.

## Header fields, all at once

A sync reads every header for free, because it has the bytes. A collection
that arrived as an unpacked archive has none, and filling them folder by
folder takes as long as someone takes to browse. `indexAll` reads the lot in
slices of 500, applying and caching each slice as it finishes so stopping
halfway keeps what was read: about 8 MB of transfer for release 85, against
395 MB for the files themselves.

Folding those fields in is where this got expensive, and the fix is worth
writing down because two separate things had to be right.

Rebuilding the search index over 61,157 rows takes 1.4 seconds with the main
thread stopped, and it was paid every time a folder was opened and every time
a search ran — in the middle of whatever was playing, so the clock froze, the
spectrum froze, and clicks queued up behind it. `SearchIndex.update` instead
redoes only the rows that changed, which `applyHeaders` identifies for free:
it returns the same array in the same order with the untouched rows still by
reference, so object identity says which ones to redo. Two hundred changed
rows cost about 25 ms against 1,420 ms for a rebuild, and answer identically
— same hits, same scores.

That only works on raw rows. A deep `ref` over 61,157 immutable objects wraps
each of them in a reactive proxy, and a proxy is not the object it wraps: the
comparison found every row changed and rebuilt anyway. `rows` and `tree` are
`shallowRef`s, which is correct as well as faster, since nothing mutates a row
or a tree node in place — both are replaced wholesale.

A fill asked for while one is running is also remembered rather than dropped.
Dropping it meant that opening a folder while the previous folder's 200 reads
were still in flight left the folder actually being looked at with no titles
at all.

## Measured in a browser, at full size

The catalogue, the tree and the index are built from the documents, not from
the tunes, so a real-sized test needs only the real documents: `e2e/scale.mjs`
uploads them and drives the library over all 61,157 entries. It adds forty
tiny PSID files at paths the manifest lists under one composer, which is the
smallest thing that makes a folder's header reads succeed — without them
nothing is ever folded into the index and the step that used to freeze the
page never runs.

| What | Measured in Chromium |
|---|---|
| Library open, including 9 MB of documents | 1.6–2.4 s |
| A query, from keystroke to painted rows | 0.3–0.8 s for the first, which builds the index; 20–100 ms after |
| JS heap with the whole catalogue loaded | 117–125 MB |
| Largest folder (Bayliss_Richard, 1,298 tunes) | windowed to 400 rows, with a count of the rest |
| Worst frame gap while a folder's headers land | 90–110 ms, against 1,565 ms when the index was rebuilt |

What that deliberately does not cover is the sync at scale: 61,157 downloads
and about 1,951 folder listings have only been exercised against a handful of
files.

## Saying what it is doing

Four things the library does take long enough to look like a hang: asking the
mirror for its release (a round trip), planning an update (about 1,951 folder
listings, because `Depth: infinity` is refused), the sync itself (thousands of
files), and reading every header (61,157 range requests). `activity` reduces
all four to one line for the top bar, with a percentage where one is known and
a flag for whether clicking should reopen the sync panel — which matters
because closing that panel used to leave a running sync with no indicator
anywhere.

## The catalogue

The library view builds its index in the browser from the collection's own
documents — `Songlengths.md5` for paths and lengths, `STIL.txt` for the
per-tune commentary, `DOCUMENTS/Musicians.txt` for composer names — and caches
the result in IndexedDB keyed by the release number and, where the server
gives them, its checksums of all three files. There is no generated
index file to drift out of step with the files, and a collection that someone
has edited by hand still reads correctly.

## The second collection

The Compute's Gazette SID Collection sits at `/SID Library/CGSC`, beside
`C64Music/`, and the library reads it as a second collection rather than
folding it into the first. The reason is not tidiness. Almost nothing the
HVSC machinery does has an answer here:

| | HVSC | Compute's Gazette |
|---|---|---|
| What lists the tunes | `Songlengths.md5`, 61,157 entries | nothing; the file names are the catalogue |
| Per-tune MD5 | yes, and the sync compares against it | none |
| Song lengths | measured, in the manifest | none; worked out from the score as it plays |
| Title, author, year, chip | a 128-byte header on every file | a MUS file has no header |
| Commentary | STIL, 18,898 entries | none |
| A mirror to fetch from | yes | none |

So `cgsc/catalog.ts` builds its own rows, its own tree and its own search
index, and `useLibrary` keeps them in their own refs. Merging them into
`rows` would have put 16,601 files that no mirror serves in front of the sync
planner, the update checker and the header indexer, each of which would then
need to know to skip them.

### Reading it

A folder-by-folder walk is about 500 PROPFINDs at roughly ten a second — the
better part of a minute before the first row appears. So the app looks for a
path index at `CGSC/.sidplayer-index.txt` first, which is one GET of about a
megabyte, and walks only when there is none. The index is nothing but the
output of `find`, one path a line, and is read rather than trusted: lines
naming no `.mus` file are ignored and a tune it lists that the server has not
got fails when played, the same as any other missing file. That is why it
needs no checksum and no date.

Neither path is cached. Reading the whole collection — parsing the index,
building 16,601 rows, the tree and the search index — measures at about half
a second, and it happens after the library is already open, so there is
nothing for a cache to save that would be worth a copy that can go stale.

What is cached is narrower: what a tune's own file says, once it has been
selected. Selecting a tune reads its `.mus` for the credits, the length its
score works out to and its MD5, and keeps them in IndexedDB under the tune's
path, so the same tune selected after a reload is not fetched again. A path
says nothing about whether the file has changed, so where the collection was
walked the server's MD5 from the listing is compared with the stored one and
a mismatch reads the file again; from the index there is nothing to compare,
and the copy is believed, this being an archive that does not change.

### Letter groups

447 composer folders is too many to list flat and too few to want a row per
letter: eleven letters have fewer than ten folders and two have about fifty.
`packLetters` walks the alphabet greedily and closes a run when taking the
next letter would leave it further from the target size than stopping does,
which on release 1.47 gives A-B, C-D, E-G, H-J, K-L, M-O, P-R, S, T-V, W-Z.
The weight is folders, not tunes: a group is a list you open, so its length
is what wants to be even. Balancing tunes instead would put D on its own —
Dave Marquis and the two DC Star folders are 1,949 tunes between them — and
leave fourteen letters sharing one row.

A group is a heading that expands. It stands for forty-odd folders, so there
is no one listing that would be its contents, and its `path` starts with `#`
so that it can never be mistaken for one.

### Searching both

Results are kept in separate blocks under a heading each, never interleaved.
Their scores are not comparable: an HVSC row can match on its title, its
author, its composer's real name, three spellings of that name and a line of
commentary, while a Compute's row has a file name and a folder. Ranking them
against each other would bury the second collection for reasons that say
nothing about which tune anyone wanted.

The blocks also give the filters somewhere to explain themselves.
`headerOnlyFilters` names the ones only a header or a manifest can answer —
`year:`, `chip:`, `clock:`, `stil:` — and the empty Compute's block says so
under its heading, because silence there reads as "no such tunes" rather than
as "that question cannot be put to this collection". `songs:` is deliberately
not among them: a MUS file is one score with no subsongs, so a row there
answers with 1 and means it.

One thing had to change in the shared index for any of this to work. Search
folds duplicates by MD5 — the same rip filed in two places — and a Compute's
row has none. Keying on an empty string made every hit after the first a
duplicate of it, so one result came back for the whole search. Folding now
needs an MD5 to fold on.

### What it deliberately does not do

- **Stars by path alone.** An HVSC favourite is stored as a path *and* an
  MD5, and the MD5 is what survives a tune moving between releases. This
  collection publishes none, so its stars keep the path only, and one is lost
  if the collection's folders are ever reorganised.
- **No "not downloaded, plays on demand".** Nothing mirrors this collection,
  so a missing file cannot be fetched and marking one would promise something
  the library cannot do. It claims nothing about what is present, which also
  saves a listing per folder.
- **No header pass.** There is no header to read.
- **Nothing in the detail pane it cannot source.** The STIL and composer
  sections are left out rather than shown empty. The length shown is worked
  out from the score rather than taken from Songlengths.md5, and the MD5 is
  the file's own: "from Songlengths.md5" under a length that never came from
  it would be a small lie told with a straight face.
