/**
 * Lays out what the demo page serves beside itself, in `generated/`:
 * the engine and ROMs from the app, the icons it draws, the demo's tunes and
 * the excerpts of HVSC's documents as a space, and the list of that space.
 *
 *   APP_SOURCE=<app's source/>  DEMO_LIBRARY=<demo's "SID Library">  node prepare.mjs
 *
 * Nothing it writes may start with `_` or `.`: GitHub Pages builds the branch
 * with Jekyll, which leaves such names out of the site.
 */
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const app = process.env.APP_SOURCE
const library = process.env.DEMO_LIBRARY
if (!app || !library) throw new Error('set APP_SOURCE and DEMO_LIBRARY')
const out = join(here, 'generated')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

/* The engine, as the app's own build keeps it: what engine.json names, and the processor and adapter. */
const engineFrom = join(app, 'public/vendor/sid-engine')
const engineTo = join(out, 'vendor/sid-engine')
mkdirSync(engineTo, { recursive: true })
const manifest = JSON.parse(readFileSync(join(engineFrom, 'engine.json'), 'utf8'))
for (const name of ['sid-processor.js', 'engine.js', 'engine.json', 'LICENSE-libsidplayfp.txt', ...manifest.files, ...(manifest.optional ?? [])]) {
  if (existsSync(join(engineFrom, name))) cpSync(join(engineFrom, name), join(engineTo, name))
}

/* The icons the app and its components draw, in both of the forms they are asked for. */
const ICONS = ['close', 'download', 'equalizer-2', 'forward-end', 'music-2', 'refresh', 'restart', 'rewind-start', 'settings-3', 'skip-back', 'skip-forward', 'arrow-up-s', 'arrow-down-s', 'volume-mute', 'volume-up', 'scales-3', 'cloud-off', 'cpu', 'file-damage', 'play', 'pause', 'star', 'search', 'information']
const iconsFrom = join(app, 'node_modules/@opencloud-eu/design-system/dist/icons')
mkdirSync(join(out, 'icons'), { recursive: true })
for (const icon of ICONS) {
  for (const form of ['fill', 'line']) {
    const file = `${icon}-${form}.svg`
    if (existsSync(join(iconsFrom, file))) cpSync(join(iconsFrom, file), join(out, 'icons', file))
  }
}

/* The space: the demo's tunes, HVSC's documents for them, and the app's own two files. */
const RELEASE = 'Release 85'
const hvscTxt = `High Voltage SID Collection\n\n                                  ${RELEASE}\n\nThe demo's copy says only which release its tunes are from.\n`
const listing = []
const md5 = (bytes) => createHash('md5').update(bytes).digest('hex')
function addFile(spacePath, bytes, servedAs) {
  mkdirSync(dirname(join(out, servedAs)), { recursive: true })
  writeFileSync(join(out, servedAs), bytes)
  listing.push({ path: spacePath, url: servedAs, size: bytes.length, md5: md5(bytes) })
}
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}
for (const file of walk(library)) {
  const rel = relative(library, file).split('\\').join('/')
  const bytes = readFileSync(file)
  if (rel.startsWith('.sidplayer/')) {
    // Text, given inline: a folder called `.sidplayer` would not survive Jekyll.
    listing.push({ path: `/SID Library/${rel}`, text: bytes.toString('utf8'), size: bytes.length })
  } else {
    addFile(`/SID Library/${rel}`, bytes, `space/${rel}`)
  }
}
for (const name of ['Songlengths.md5', 'STIL.txt', 'Musicians.txt']) {
  addFile(`/SID Library/C64Music/DOCUMENTS/${name}`, readFileSync(join(here, 'data', name)), `space/C64Music/DOCUMENTS/${name}`)
}
addFile('/SID Library/C64Music/DOCUMENTS/HVSC.txt', Buffer.from(hvscTxt, 'latin1'), 'space/C64Music/DOCUMENTS/HVSC.txt')
writeFileSync(join(out, 'space.json'), JSON.stringify(listing, null, 1))

/* The mirror route, for the release check alone. */
mkdirSync(join(out, 'hvsc-mirror/C64Music/DOCUMENTS'), { recursive: true })
writeFileSync(join(out, 'hvsc-mirror/C64Music/DOCUMENTS/HVSC.txt'), hvscTxt)

/* What the site is made of, and under which licences. */
cpSync(join(app, '../LICENSE'), join(out, 'LICENSE'))
cpSync(join(here, 'NOTICES.txt'), join(out, 'NOTICES.txt'))

console.log(`generated: ${listing.length} files in the space, engine, ${readdirSync(join(out, 'icons')).length} icons`)
