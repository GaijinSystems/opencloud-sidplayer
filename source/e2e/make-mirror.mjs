#!/usr/bin/env node
/**
 * Builds a miniature HVSC mirror for the browser test.
 *
 * The real mirror is 61,157 files and 395 MB, and the tests must not touch a
 * volunteer's server anyway. This makes the same shape - `C64Music/` with
 * `DOCUMENTS/` beside `MUSICIANS/`, `GAMES/` and `DEMOS/` - out of a handful
 * of generated tunes, with a `Songlengths.md5` whose MD5s are the real MD5s
 * of the files written, since that is exactly what the sync compares.
 *
 *   node e2e/make-mirror.mjs [outdir]     default: e2e/.mirror/HVSC/C64Music
 *
 * A second release can be produced with RELEASE=86, which adds two tunes and
 * withdraws one, so the update banner and the removals prompt have something
 * real to show.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FLAGS_PAL_6581, lda, sidFile, sta } from '../scripts/sid-bytes.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(process.argv[2] ?? join(here, '.mirror', 'HVSC', 'C64Music'))
const release = Number(process.env.RELEASE ?? 85)

/* ---- a playable tune, as in scripts/make-fixtures.mjs -------------------- */

/** One voice, triangle, gated, at the frequency given by `hi`. */
const code = (hi) => {
  const out = [...lda(0x0f), ...sta(0xd418)]
  out.push(
    ...lda(0x00),
    ...sta(0xd400),
    ...lda(hi),
    ...sta(0xd401),
    ...lda(0x09),
    ...sta(0xd405),
    ...lda(0xf0),
    ...sta(0xd406),
    ...lda(0x11),
    ...sta(0xd404)
  )
  out.push(0x60)
  return out
}

/*
 * A PSID v2 around that code: PAL, 6581, and text fields cut at 31 characters
 * so each keeps its terminating NUL. The play address is the second RTS,
 * straight after the code.
 */
const tune = ({ name, author, released, hi, songs = 1 }) => {
  const body = code(hi)
  return sidFile({
    name,
    author,
    released,
    songs,
    playAddress: 0x1000 + body.length,
    flags: FLAGS_PAL_6581,
    textLimit: 31,
    data: [...body, 0x60]
  })
}

/* ---- the collection ------------------------------------------------------ */

/** Path -> tune. Paths are collection paths, as the manifest writes them. */
const TUNES = {
  '/MUSICIANS/H/Hubbard_Rob/Commando.sid': tune({
    name: 'Commando',
    author: 'Rob Hubbard',
    released: '1985 Elite',
    hi: 0x20
  }),
  '/MUSICIANS/H/Hubbard_Rob/Monty_on_the_Run.sid': tune({
    name: 'Monty on the Run',
    author: 'Rob Hubbard',
    released: '1985 Gremlin Graphics',
    hi: 0x28,
    songs: 3
  }),
  '/MUSICIANS/H/Hubbard_Rob/Delta.sid': tune({
    name: 'Delta',
    author: 'Rob Hubbard',
    released: '1987 Thalamus',
    hi: 0x30
  }),
  '/MUSICIANS/G/Galway_Martin/Wizball.sid': tune({
    name: 'Wizball',
    author: 'Martin Galway',
    released: '1987 Ocean',
    hi: 0x35
  }),
  '/MUSICIANS/H/Huelsbeck_Chris/Turrican_2.sid': tune({
    name: 'Turrican 2',
    author: 'Chris Huelsbeck',
    released: '1991 Rainbow Arts',
    hi: 0x3a
  }),
  '/GAMES/A-F/Commando.sid': tune({
    name: 'Commando',
    author: 'Rob Hubbard',
    released: '1985 Elite',
    hi: 0x21
  }),
  '/DEMOS/0-9/12345.sid': tune({ name: '12345', author: 'Unknown', released: '1988', hi: 0x4b })
}

// Release 86: two new tunes, and one that release 85 had is withdrawn.
const ADDED = {
  '/MUSICIANS/H/Hubbard_Rob/Sanxion.sid': tune({
    name: 'Sanxion',
    author: 'Rob Hubbard',
    released: '1986 Thalamus',
    hi: 0x40,
    songs: 2
  }),
  '/MUSICIANS/L/Laxity/New_Tune.sid': tune({
    name: 'New Tune',
    author: 'Laxity',
    released: '2026',
    hi: 0x45
  })
}
const WITHDRAWN = '/DEMOS/0-9/12345.sid'

const files = { ...TUNES }
if (release >= 86) {
  Object.assign(files, ADDED)
  delete files[WITHDRAWN]
}

const LENGTHS = {
  '/MUSICIANS/H/Hubbard_Rob/Monty_on_the_Run.sid': '5:50 0:12 2:44',
  '/MUSICIANS/H/Huelsbeck_Chris/Turrican_2.sid': '6:12',
  '/MUSICIANS/H/Hubbard_Rob/Sanxion.sid': '5:26 1:02'
}

rmSync(out, { recursive: true, force: true })
for (const [path, bytes] of Object.entries(files)) {
  const full = join(out, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, bytes)
}

const docs = join(out, 'DOCUMENTS')
mkdirSync(docs, { recursive: true })

/* HVSC.txt: the banner the release number is read from. */
writeFileSync(
  join(docs, 'HVSC.txt'),
  [
    '-----------------------------------------------------------------------------',
    '                        T H E   H I G H   V O L T A G E',
    '                          S I D   C O L L E C T I O N',
    '',
    `                                  Release ${release}`,
    '',
    '                                June 28, 2026',
    '-----------------------------------------------------------------------------',
    ''
  ].join('\r\n')
)

/* Songlengths.md5: the manifest, keyed by the real MD5 of each file. */
const manifest = ['[Database]']
for (const [path, bytes] of Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))) {
  manifest.push(`; ${path}`)
  manifest.push(`${createHash('md5').update(bytes).digest('hex')}=${LENGTHS[path] ?? '3:58'}`)
}
writeFileSync(join(docs, 'Songlengths.md5'), `${manifest.join('\r\n')}\r\n`)

/* STIL.txt, including a per-subsong entry and a Latin-1 character. */
writeFileSync(
  join(docs, 'STIL.txt'),
  Buffer.from(
    [
      '  STIL - the SID Tune Information List',
      '  ------------------------------------',
      '',
      '/MUSICIANS/H/Hubbard_Rob/Monty_on_the_Run.sid',
      '(#1)',
      "  TITLE: The Devil's Gallop [from the Dick Barton radio show]",
      ' ARTIST: Charles Williams',
      "COMMENT: Heavily inspired by the song Devil's Gallop, which was the title",
      '         theme for a 1940s detective radio show.',
      '',
      '/MUSICIANS/H/Huelsbeck_Chris/Turrican_2.sid',
      'COMMENT: Composed by Chris Hülsbeck.',
      ''
    ].join('\r\n'),
    'latin1'
  )
)

/* Musicians.txt, fenced exactly as the real file is. */
writeFileSync(
  join(docs, 'Musicians.txt'),
  Buffer.from(
    [
      '****************************************',
      'Several C64 Musicians and Known Handles',
      '',
      '****************************************',
      '',
      'SID Musicians in total ........... 4',
      'GERMANY .......................... 1',
      '****************************************',
      'Hubbard, Rob - UNITED KINGDOM (ENGLAND)',
      'Galway, Martin - UNITED KINGDOM (NORTHERN IRELAND)',
      'Huelsbeck, Chris (Hülsbeck) - GERMANY',
      'Laxity (Jensen, Thomas) / Vibrants - DENMARK',
      '****************************************',
      '',
      'C64 Music Groups :',
      '',
      'Vibrants',
      ''
    ].join('\r\n'),
    'latin1'
  )
)

console.log(
  `[mirror] release ${release}: ${Object.keys(files).length} tunes + 4 documents -> ${out}` +
    (release >= 86 ? ` (added ${Object.keys(ADDED).length}, withdrew ${WITHDRAWN})` : '')
)
