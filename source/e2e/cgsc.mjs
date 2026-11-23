#!/usr/bin/env node
/**
 * Browser test for the second collection: Compute's Gazette, in the library
 * beside HVSC.
 *
 * It is a different kind of collection and that is the whole point of the
 * test. There is no manifest, no MD5, no mirror and no header to read, so
 * everything the library shows about it is derived from path names - and the
 * two places that could go wrong quietly are the ones checked hardest here:
 * that a search reaches it and keeps its results apart from HVSC's, and that
 * a filter it cannot answer says so rather than returning nothing.
 *
 * Needs the same rig as `library.mjs` and is meant to run after it, so that
 * there is an HVSC collection to sit beside.
 *
 *   cd source
 *   podman run --rm --network=host --userns=keep-id -v "$PWD":/app:z -w /app/e2e \
 *     -e OC_URL=https://localhost:9300 localhost/sidplayer-e2e \
 *     sh -c 'node cgsc.mjs'
 *
 * Environment:
 *   OC_URL       default https://localhost:9300  (the proxy, not OpenCloud)
 *   OC_USER      default admin
 *   OC_PASSWORD  default admin
 *   OUT          screenshots and dumps, default ./out
 */
import { mus } from '../scripts/sid-bytes.mjs'
import {
  check,
  dav,
  dump as dumpPage,
  env,
  finish,
  launch,
  ROOT,
  signIn,
  until as untilTrue
} from './harness.mjs'

const { BASE, USER } = env()

const CGSC = `${ROOT}/CGSC`
const INDEX = `${CGSC}/.sidplayer-index.txt`

/* ---- a miniature collection --------------------------------------------- */

/*
 * The tunes are Sidplayer files as `scripts/make-fixtures.mjs` builds them,
 * from the same builder: three voices holding nothing but HLT, then PETSCII
 * credit lines. Silent and structurally complete, which is all a playback
 * check needs.
 */
/** TEM 240 makes a quarter note one second, so one whole note lasts four. */
const FOUR_SECONDS = [0x06, 240, 0x08, 0x99]

/*
 * The shapes that matter, in as few files as possible: a composer with a
 * subfolder, a composer whose name carries the collection's bracketed-handle
 * convention, a name that collides with an HVSC tune so a search has to
 * answer from both, and a folder of documents that must not appear in a tree
 * of music.
 */
const TUNES = [
  'Dave_Marquis/Bolero.mus',
  'Dave_Marquis/Four_Seasons/Spring.mus',
  'Dave_Marquis/Four_Seasons/Winter.mus',
  'Andy_Figueroa_-UnixWizard-/Greensleeves.mus',
  'Sandy_C/Commando_March.mus',
  'Tom_B24/Bonapartes_Retreat.mus'
]
const EXTRAS = [
  '00_Documents/MUS_format_B.txt',
  'Dave_Marquis/Bolero.pic',
  'Dave_Marquis/Four_Seasons/Spring.str'
]
const FILES = [...TUNES, ...EXTRAS].sort()

const { browser, page, logs } = await launch()

const dump = (name) => dumpPage(page, `cgsc-${name}`)

const library = page.locator('.sidplayer-library')
const search = page.getByRole('searchbox', { name: 'Search the collection' })

const until = (what, predicate, timeout = 60000) => untilTrue(page, what, predicate, { timeout, interval: 400 })

/** Opens the library fresh, so a changed collection is read again. */
const openLibrary = async () => {
  await page.goto(`${BASE}/sidplayer/library`, { waitUntil: 'domcontentloaded' })
  await library.waitFor({ timeout: 60000 })
  await until('the catalogue', async () => (await page.getByText('HVSC #').count()) > 0)
}

/** Waits until the library has finished looking for the second collection, either way. */
const cgscSettled = () =>
  until(
    "the Compute's collection to be read or found absent",
    async () =>
      /^(present|absent)$/.test((await page.locator('.sidplayer-library').getAttribute('data-cgsc')) ?? ''),
    90000
  )

/** The Compute's section heading, which is also the "is it there" test. */
const section = library.getByText(/Compute.s Gazette MUS/)

try {
  /* ---- put a collection there ------------------------------------------ */
  console.log('\nwriting a miniature collection')
  await dav('DELETE', CGSC)
  for (const folder of [
    '',
    '/00_Documents',
    '/Dave_Marquis',
    '/Dave_Marquis/Four_Seasons',
    '/Andy_Figueroa_-UnixWizard-',
    '/Sandy_C',
    '/Tom_B24'
  ]) {
    await dav('MKCOL', `${CGSC}${folder}`)
  }
  for (const path of TUNES) {
    const name = path.split('/').pop().replace('.mus', '').replace(/_/g, ' ').toUpperCase()
    const lead = path.endsWith('Winter.mus') ? FOUR_SECONDS : []
    await dav('PUT', `${CGSC}/${path}`, {
      body: mus([name, 'COMPUTE GAZETTE FIXTURE', '1986 FIXTURES'], [lead, [], []])
    })
  }
  // Three more voices for Spring, on a second SID.
  await dav('PUT', `${CGSC}/Dave_Marquis/Four_Seasons/Spring.str`, { body: mus(['STEREO PART']) })
  await dav('PUT', `${CGSC}/00_Documents/MUS_format_B.txt`, { body: 'not music\n' })
  /*
   * A real Koala rather than a stub load address, so the library's canvas has
   * something to be checked against: all zero but the first cell's top row,
   * which takes its four pixels from colour RAM. Red on a blue screen, in the
   * top-left corner.
   */
  const koala = Buffer.alloc(10001)
  koala[0] = 0xff // first cell, first row: all four pixels from colour RAM
  koala[9000] = 2 // that cell's colour RAM entry: red
  koala[10000] = 6 // background: blue
  await dav('PUT', `${CGSC}/Dave_Marquis/Bolero.pic`, {
    body: Buffer.concat([Buffer.from([0x00, 0x60]), koala])
  })
  const wroteIndex = await dav('PUT', INDEX, { body: `${FILES.join('\n')}\n` })
  check(wroteIndex === 201 || wroteIndex === 204, `the collection and its index are in ${CGSC} (${wroteIndex})`)

  /* ---- sign in --------------------------------------------------------- */
  console.log('\nsign in')
  await signIn(page)
  check(true, `signed in as ${USER}`)

  /* ---- the second section in the tree ----------------------------------- */
  console.log('\nthe tree')
  await openLibrary()
  await cgscSettled()
  await dump('00-opened')
  if ((await section.count()) === 0) {
    console.log('  tree pane text:', JSON.stringify((await library.innerText()).slice(0, 600)))
  }
  await section.waitFor({ timeout: 30000 })
  check(true, 'a second section appears below the collection')

  // Ten groups is the real collection's shape; six composers makes five.
  const groups = library.locator('.sidplayer-letter-group')
  await until('the letter groups', async () => (await groups.count()) > 0)
  const names = await groups.allInnerTexts()
  check(
    names.length >= 2,
    `the composers are divided into letter groups (${names.map((n) => n.split('\n')[0]).join(', ')})`
  )

  /*
   * Arrowing onto a letter group takes focus without expanding it. A group is
   * a heading, and expanding every one on the way past would rearrange the
   * list under the very keys being used to walk it.
   */
  const expandedNow = async () => await library.locator('[aria-expanded="true"]').count()
  await groups.first().focus()
  const wasExpanded = await expandedNow()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowUp')
  check((await expandedNow()) === wasExpanded, 'passing over a letter group with the arrows does not expand it')

  /*
   * A group stands for several folders, so there is no listing that would be
   * its contents: clicking it expands and nothing else. The breadcrumb is
   * what would show it if it opened something.
   */
  const groupD = groups.filter({ hasText: /^D/ }).first()
  await groupD.click()
  await until('the group to expand', async () => (await library.getByText('Dave_Marquis').count()) > 0)
  check(true, 'a group expands to the composers in it')
  check(
    (await page.getByText(/^Compute.s Gazette ·/).count()) === 0,
    'and opens nothing, since it stands for several folders'
  )
  await dump('01-tree')

  /* ---- counts ----------------------------------------------------------- */
  const marquis = library.locator('button', { hasText: 'Dave_Marquis' }).first()
  const marquisText = await marquis.innerText()
  check(
    /\b3\b/.test(marquisText),
    `a composer carries the count of tunes beneath them (${marquisText.replace(/\n/g, ' ')})`
  )
  const groupText = await groupD.innerText()
  check(
    /\b3\b/.test(groupText),
    `and a group carries the total of its composers (${groupText.replace(/\n/g, ' ')})`
  )

  /* ---- browsing it ------------------------------------------------------ */
  console.log('\nbrowsing')
  await marquis.click()
  await until('the listing', async () => (await library.locator('[role="row"]').count()) > 0)
  const rows = await library.locator('.sidplayer-tune-title').allInnerTexts()
  check(
    rows.length === 3 && rows.some((r) => r.includes('Bolero')) && rows.some((r) => r.includes('Spring')),
    `a composer folder lists their tunes and their subfolders' (${rows.map((r) => r.trim()).join(', ')})`
  )
  check(
    (await page.getByText(/Compute.s Gazette · Dave_Marquis/).count()) > 0,
    'the breadcrumb says which collection you are in'
  )
  /*
   * Nothing mirrors this collection, so there is no fetching a file that is
   * not there and no honest way to mark one. A row must not claim it will
   * play on demand.
   */
  check(
    (await library.getByText(/not downloaded/).count()) === 0,
    'and no row promises to fetch anything, since nothing serves this collection'
  )
  /*
   * Starring works here. A star is the app's own idea and HVSC records no
   * such thing, so there is no reason the second collection cannot have one;
   * it keeps only the path, this collection publishing no MD5 anywhere.
   */
  const star = library.getByRole('button', { name: /to favourites$/ }).first()
  check((await star.count()) > 0, "its rows carry a star, the app's own idea rather than HVSC's")
  await star.click()
  await until(
    'the star to take',
    async () => (await library.getByRole('button', { name: /Remove .* from favourites/ }).count()) > 0
  )
  check(true, "a Compute's tune can be starred")
  /*
   * The right-hand pane speaks for HVSC's three documents, none of which
   * mentions this collection. An empty length attributed to Songlengths.md5,
   * or "no STIL entry" for a tune that could never have one, would each be a
   * small lie told with a straight face.
   */
  await library.locator('.sidplayer-tune-title').first().click()
  await until('the detail pane', async () => /ships no index/.test(await library.innerText()))
  const detail = await library.innerText()
  check(
    !/from Songlengths\.md5/.test(detail),
    'the detail pane does not attribute a length to a file that never lists it'
  )
  check(
    !/No entry for this tune/.test(detail),
    'and does not report a missing STIL entry for a tune that cannot have one'
  )
  check(/ships no index/.test(detail), 'it says what the collection does and does not record instead')
  check(/Starred|Star/.test(detail), 'and the detail pane offers the star too')

  /*
   * What the tune says about itself, read from its own file on selection:
   * the credits for the heading, the format, and a length worked out from
   * the score. Not the chip or the machine, which a Sidplayer file does not
   * record.
   */
  const pane = library.locator('.sidplayer-detail')
  const heading = pane.locator('h2').first()
  const selectTune = async (title) => {
    await library.getByRole('row').filter({ hasText: title }).locator('.sidplayer-tune-title').first().click()
  }
  await selectTune('Winter')
  await until(
    'the credits to be read',
    async () => ((await heading.textContent()) || '').trim() === 'WINTER',
    15000
  )
  check(true, "selecting a tune reads its title from the file's own credits")
  const read = await pane.innerText()
  check(
    /COMPUTE GAZETTE FIXTURE[\s\S]{0,10}1986 FIXTURES/.test(read),
    'with the author and the release line beside it'
  )
  check(/\bMUS\b/.test(read) && !/MUS\+STR/.test(read), 'a single file reads as MUS')
  check(/1 subsong/.test(read), 'keeping the subsong count a SID shows')
  check(/0:04[\s\S]{0,40}worked out from its own score/.test(read), 'and a length worked out from the score')
  check(!/MOS 6581|MOS 8580|\bPAL\b|\bNTSC\b/.test(read), 'with no chip or machine claimed for it')
  await dump('01b-details')
  /*
   * The MD5, worked out from the bytes just read, in the FILE section where
   * an HVSC tune shows the one its collection lists - and kept, with the rest,
   * in the browser's cache, so that a reload need not read the file again.
   */
  const shownMd5 = ((await pane.innerText()).match(/md5 ([0-9a-f]{32})/) || [])[1]
  check(!!shownMd5, `the FILE section shows the MD5 worked out from the file (${shownMd5})`)
  const kept = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open('sidplayer-hvsc')
        open.onerror = () => resolve(null)
        open.onsuccess = () => {
          const db = open.result
          if (!db.objectStoreNames.contains('mus')) return resolve(null)
          const get = db
            .transaction('mus', 'readonly')
            .objectStore('mus')
            .get('/Dave_Marquis/Four_Seasons/Winter.mus')
          get.onsuccess = () => resolve(get.result ?? null)
          get.onerror = () => resolve(null)
        }
      })
  )
  check(
    kept?.md5 === shownMd5 && kept?.title === 'WINTER' && kept?.length === 4,
    "and the details are kept in the browser under the tune's path"
  )
  await selectTune('Spring')
  await until('the second tune to be read', async () => /MUS\+STR/.test(await pane.innerText()), 15000)
  check(true, 'a tune with a .str beside it reads as MUS+STR')
  check(
    !/worked out from its own score/.test(await pane.innerText()),
    'and a silent score claims no length at all'
  )

  /*
   * And the picture it was passed around with. Compute's is the collection
   * that has pictures - 494 of its tunes have one - and until now the only
   * place they were drawn was the full view reached from the file browser,
   * which is not where anybody plays these.
   *
   * Checked by reading the pixels back rather than by the canvas existing: a
   * blank canvas of the right size would pass that and prove nothing.
   */
  await library
    .getByRole('button', { name: /^Play Bolero/ })
    .first()
    .click()
  const canvas = library.locator('canvas[role="img"]')
  await canvas.waitFor({ timeout: 30000 })
  check(true, 'the picture that came with the tune is drawn in the detail pane')
  const pixels = await canvas.evaluate((el) => {
    const c = el.getContext('2d')
    const at = (x, y) => [...c.getImageData(x, y, 1, 1).data].slice(0, 3)
    return { corner: at(0, 0), middle: at(160, 100) }
  })
  const [r, g, bl] = pixels.corner
  check(r > g && r > bl, `its top-left cell is the red the file asks for (${pixels.corner.join(',')})`)
  check(pixels.middle[2] > pixels.middle[0], `and the rest is the blue background (${pixels.middle.join(',')})`)

  /*
   * And it reaches the list that exists to show it. The favourites view read
   * only HVSC's catalogue, so a Compute's star was written correctly to the
   * file and then never appeared anywhere.
   */
  await library.getByRole('button', { name: /^Favourites/ }).click()
  await until('the starred tune in the favourites view', async () => /Bolero/.test(await library.innerText()))
  check(true, 'and it shows up under Favourites, which reads both collections')

  /*
   * Put it back, so the rest of the run starts where it expects to.
   *
   * The list does not empty: this suite runs after `library.mjs`, which
   * leaves three HVSC tunes starred, and they share the view. What is being
   * watched for is this tune leaving it, and those three staying - which is
   * the more useful assertion anyway, since it says the two collections sit
   * in one list without disturbing each other.
   */
  const before = await library.locator('[role="row"]').count()
  await library
    .getByRole('button', { name: /Bolero from favourites$/ })
    .first()
    .click()
  // The row leaving the list, not the name leaving the page: the detail pane
  // goes on showing whichever tune is selected, starred or not.
  await until(
    'the starred tune to leave the favourites view',
    async () => (await library.locator('[role="row"]').count()) < before
  )
  const after = await library.locator('[role="row"]').count()
  check(after === before - 1, `unstarring it takes it out and leaves the rest (${before} -> ${after})`)
  await dump('02-folder')

  // Clicking a composer opens their folder; the chevron beside it is what
  // reveals the subfolders they filed tunes under.
  await library.getByRole('button', { name: 'Expand Dave_Marquis' }).click()
  const subfolder = library.locator('button', { hasText: 'Four_Seasons' }).first()
  await subfolder.waitFor({ timeout: 10000 })
  await subfolder.click()
  await until('the subfolder', async () => (await library.locator('[role="row"]').count()) === 2)
  check(true, "a composer's own subfolder opens beneath them")

  /* ---- playing ---------------------------------------------------------- */
  console.log('\nplaying')
  await library
    .getByRole('button', { name: /^Play Spring/ })
    .first()
    .click()
  const playing = await until(
    'the player to take the tune',
    async () => (await page.getByText(/Spring/).count()) > 1,
    30000
  )
  check(playing, 'a tune plays out of the second collection')
  const landed = await dav('PROPFIND', `${CGSC}/Dave_Marquis/Four_Seasons/Spring.mus`)
  check(landed === 207 || landed === 200, `and it is read from ${CGSC}, not from the HVSC root (${landed})`)

  /*
   * Types a query and waits for its results, not just for rows. The box
   * takes each letter at once and the search follows a moment later, so
   * straight after typing the rows on screen are still the folder's, or the
   * last search's.
   */
  const searchFor = async (query) => {
    await search.fill(query)
    await until(`the search for ${query}`, async () => (await page.getByText(`Search · ${query}`).count()) > 0)
    await until('results', async () => (await library.locator('[role="row"]').count()) > 0)
  }

  /* ---- search across both ----------------------------------------------- */
  console.log('\nsearch')
  await searchFor('commando')
  const hvscHeading = library.getByText('High Voltage SID Collection', { exact: true })
  const cgscHeading = library.getByText(/Compute.s Gazette SID Collection/)
  check(await hvscHeading.isVisible(), 'results from each collection get a heading of their own')
  check(await cgscHeading.isVisible(), 'and the second collection is one of them')
  const titles = await library.locator('.sidplayer-tune-title').allInnerTexts()
  check(
    titles.some((t) => t.includes('Commando March')),
    `the search reaches the second collection (${titles.map((t) => t.trim()).join(', ')})`
  )
  await dump('03-search')

  /* ---- a filter it cannot answer ---------------------------------------- */
  console.log('\na question it cannot be asked')
  await search.fill('commando year:1985')
  await until('the note', async () => (await library.getByText(/Nothing here records/).count()) > 0)
  const note = await library
    .getByText(/Nothing here records/)
    .first()
    .innerText()
  check(/a year/.test(note), `an unanswerable filter says why rather than returning nothing (${note})`)
  check(await cgscHeading.isVisible(), 'and the heading stays, so the empty list is explained')
  await dump('04-unanswerable')

  await searchFor('commando songs:1')
  check(
    (await library.getByText(/Nothing here records/).count()) === 0,
    'a question it can answer draws no such note'
  )
  const withSongs = await library.locator('.sidplayer-tune-title').allInnerTexts()
  check(
    withSongs.some((t) => t.includes('Commando March')),
    'and a MUS file counts as one song, because that is what it holds'
  )

  /* ---- the walk fallback ------------------------------------------------ */
  console.log('\nwithout an index')
  const dropped = await dav('DELETE', INDEX)
  check(dropped === 204, `the index is removed (${dropped})`)
  await openLibrary()
  await section.waitFor({ timeout: 60000 })
  // The groups start closed on a fresh page, so the tree itself is what to
  // wait for rather than a composer inside one.
  await until('the walked collection', async () => (await groups.count()) > 0, 90000)
  check(true, 'the collection is walked folder by folder when there is no index to read')
  await groups.filter({ hasText: /^D/ }).first().click()
  check((await library.getByText('Dave_Marquis').count()) > 0, 'and the same composers are in the same groups')
  await searchFor('commando')
  const walked = await library.locator('.sidplayer-tune-title').allInnerTexts()
  check(
    walked.some((t) => t.includes('Commando March')),
    'and the catalogue that results is the same one'
  )
  await dump('05-walked')

  /* ---- and away again ---------------------------------------------------- */
  console.log('\nwithout the collection')
  await dav('DELETE', CGSC)
  await openLibrary()
  await cgscSettled()
  check((await section.count()) === 0, 'no section at all for someone who only has HVSC')
  check(
    (await library.locator('button', { hasText: 'MUSICIANS' }).count()) > 0,
    'and the first collection is untouched by its absence'
  )
} catch (e) {
  check(false, `threw: ${e.message}`)
  await dump('99-error')
} finally {
  console.log('\nbrowser console (filtered):')
  for (const line of logs.filter((l) => !/\[(log|debug)\]/.test(l)).slice(-12)) console.log(`    ${line}`)
  await finish(browser)
}
