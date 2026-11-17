#!/usr/bin/env node
/**
 * Browser test for the standalone library, against a real OpenCloud behind a
 * real HAProxy with a miniature HVSC mirror behind the same origin.
 *
 * The proxy is not scenery. The browser cannot reach HVSC directly - its
 * version API answers 403 to anything carrying an `Origin` header and the
 * mirror sends no CORS headers - so the whole feature depends on a
 * same-origin path forwarding to the mirror, and `e2e/mirror-server.mjs`
 * deliberately sends no CORS headers either, so a test cannot pass by
 * accident.
 *
 * What it walks through: the first-run screen, a sync that really downloads
 * tunes and writes them into the user's space, the three-pane library over
 * what arrived, search, favourites, the composer view, playback through the
 * same engine the Files integration uses, and finally a second release that
 * adds two tunes and withdraws one, to show the banner, the plan and the
 * removals prompt.
 *
 * Environment:
 *   OC_URL       default https://localhost:9300  (the proxy, not OpenCloud)
 *   OC_USER      default admin
 *   OC_PASSWORD  default admin
 *   OUT          screenshots and dumps, default ./out
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  check,
  dav as davRequest,
  davFetch,
  davUrl,
  dump as dumpPage,
  env,
  finish,
  launch,
  LEGACY_ROOT,
  ROOT,
  signIn,
  until as untilTrue
} from './harness.mjs'

const { BASE, USER, OUT } = env()

const { browser, page, logs } = await launch()

const dump = (name) => dumpPage(page, `lib-${name}`)

/** WebDAV from the runner, answering the status; the only extra this test sends is headers. */
const dav = (method, path, headers = {}) => davRequest(method, path, { headers })

/** Where a first sync puts HVSC: inside the app's folder, not loose in it. */
const COLLECTION = `${ROOT}/C64Music`

/** Rebuilds the mirror at a given release; the server reads from disk. */
const mirrorAt = (release) => {
  const out = execFileSync('node', ['make-mirror.mjs'], {
    env: { ...process.env, RELEASE: String(release) },
    encoding: 'utf8'
  })
  console.log(`  ${out.trim()}`)
}

const library = page.locator('.sidplayer-library')
const search = page.getByRole('searchbox', { name: 'Search the collection' })

/** Waits for a condition, polling, with a clear failure message. */
const until = (what, predicate, timeout = 120000) =>
  untilTrue(page, what, predicate, { timeout, interval: 500 })

try {
  /* ---- a known starting point ------------------------------------------ */
  console.log('\nreset')
  mirrorAt(85)
  const removed = await dav('DELETE', ROOT)
  const removedLegacy = await dav('DELETE', LEGACY_ROOT)
  check(
    (removed === 204 || removed === 404) && (removedLegacy === 204 || removedLegacy === 404),
    `the space starts without a collection under either name (${removed}, ${removedLegacy})`
  )

  /* ---- sign in and open the library from the application menu ---------- */
  console.log('\nsign in')
  await signIn(page)
  check(true, `signed in as ${USER} through the proxy`)

  console.log('\napplication menu')
  await page.getByRole('button', { name: 'Application Switcher' }).click()
  // By href, not by name: the entry's accessible name carries its icon too.
  const entry = page.locator('a[href="/sidplayer/library"]').first()
  await entry.waitFor({ timeout: 15000 })
  check(true, 'SID Library is in the application menu')
  await entry.click()
  await page.waitForURL(/\/sidplayer\/library/, { timeout: 30000 })
  await library.waitFor({ timeout: 30000 })
  check(true, 'the library route opens')

  /*
   * The shell's own search, hidden while we are here.
   *
   * Two centred search fields 58 px apart, within 12 px of the same width,
   * read as one control duplicated. Hiding the shell's means a rule of ours
   * matching an element the shell owns, so this is the check that notices
   * the day OpenCloud renames it: the failure is cosmetic and would
   * otherwise go unseen until someone looked at the page.
   */
  const globalSearch = await page.evaluate(() => {
    const el = document.querySelector('#files-global-search')
    return { present: !!el, hidden: el ? getComputedStyle(el).display === 'none' : null }
  })
  check(globalSearch.present, "the shell's global search is still the element we expect to hide")
  check(globalSearch.hidden, 'and it is hidden while the library is open')

  await dump('01-first-run')

  /* ---- first run --------------------------------------------------------- */
  console.log('\nfirst run')
  await page.getByText('Set up your SID library').waitFor({ timeout: 30000 })
  check(true, `first-run screen, since ${ROOT} does not exist yet`)
  const reachable = page.getByText(/Mirror is reachable, offering release 85/)
  await reachable.waitFor({ timeout: 30000 })
  check(true, 'the mirror is reachable through the same origin and offers release 85')

  const download = page.getByRole('button', { name: /Download release 85/ })
  await download.waitFor({ timeout: 10000 })
  check(await download.isEnabled(), 'the download button is enabled once the checks pass')
  await download.click()

  /* ---- the sync ---------------------------------------------------------- */
  console.log('\nsync')
  const dialog = page.getByRole('dialog', { name: 'Updating the collection' })
  await dialog.waitFor({ timeout: 30000 })
  check(true, 'the sync panel opens')
  await until('a plan', async () => (await dialog.getByText('to download').count()) > 0)
  check(true, 'a plan is shown before anything is written')
  await dump('02-plan')

  await dialog.getByRole('button', { name: 'Start' }).click()
  /*
   * The status line in the top bar is the only sign of a sync once its panel
   * is closed, which is exactly when someone wonders whether anything is
   * happening. It has to be there while the sync runs.
   */
  const running = await until(
    'the status line to report the sync',
    async () => (await page.getByText(/Updating \d+%/).count()) > 0,
    60000
  )
  check(running, 'the top bar reports the sync while it runs')
  await until('the sync to finish', async () => (await dialog.getByText('Up to date').count()) > 0, 180000)
  check(true, 'the sync finishes')

  /*
   * And it went into `C64Music/` rather than straight into the app's
   * folder, which is what leaves room beside it for other collections and
   * keeps the app's own folder out of the tree a sync writes to.
   */
  const landed = await dav('PROPFIND', `${COLLECTION}/MUSICIANS`, { depth: '0' })
  check(landed === 207, `the sync wrote the collection into ${COLLECTION} (${landed})`)
  const notLoose = await dav('PROPFIND', `${ROOT}/MUSICIANS`, { depth: '0' })
  check(notLoose === 404, `and not loose in ${ROOT} (${notLoose})`)

  await dump('03-synced')
  await dialog.getByRole('button', { name: 'Done' }).click()

  /* ---- the library over what arrived ------------------------------------- */
  console.log('\nbrowsing')
  await until('the catalogue', async () => (await page.getByText('HVSC #85').count()) > 0)
  check(true, 'the release badge says #85')

  /*
   * The app names its own version under its name, and the two sit as one
   * block against the release pill beside them rather than the name alone
   * riding high with the version hanging below the middle.
   */
  const version = library.getByText(/^v\d+\.\d+\.\d+$/).first()
  check((await version.count()) > 0, `the library shows its version (${await version.innerText()})`)
  const nameBox = await library.getByText('SID Library', { exact: true }).first().boundingBox()
  const verBox = await version.boundingBox()
  const pillBox = await library
    .getByText(/HVSC #/)
    .first()
    .boundingBox()
  if (nameBox && verBox && pillBox) {
    const block = (nameBox.y + verBox.y + verBox.height) / 2
    const pill = pillBox.y + pillBox.height / 2
    check(
      Math.abs(block - pill) <= 2,
      `and sits level with the release beside it (${Math.abs(block - pill).toFixed(1)}px out)`
    )
  } else {
    check(false, 'could not measure the version against the release pill')
  }

  const musicians = library.locator('button', { hasText: 'MUSICIANS' }).first()
  await musicians.waitFor({ timeout: 30000 })
  check(true, 'the tree lists MUSICIANS')
  // Nothing is starred yet, so it opens on the composers rather than on a
  // listing of most of the collection.
  await until('the composer grid', async () => (await page.getByText(/\d+ composers/).count()) > 0, 30000)
  check(true, 'with nothing starred, the library opens on the composers')

  /*
   * And the player bar is not claiming to hold anything. `displayTitle` needs
   * a file name to fall back on, and the literal `tune.sid` it was given got
   * stripped to "tune" whenever nothing was loaded - so the library, which
   * draws the bar whether or not anything is playing, opened every time
   * announcing a tune of that name that exists nowhere at all.
   */
  const opened = await library.innerText()
  check(/Nothing playing/.test(opened), 'the player bar says nothing is playing before anything does')
  check((await library.getByRole('button', { name: 'Stop and close' }).count()) === 0, 'and has no ✕ for it')
  // A line that is the name and nothing else, which is how the bar drew it:
  // the composer grid the library now opens on says "1 tune" honestly.
  check(!opened.split('\n').some((l) => l.trim() === 'tune'), 'and names no phantom tune anywhere on the page')

  /*
   * Up and down walk the column rather than scrolling it. The rows are
   * buttons in a scrollable pane, so the browser's own answer to an arrow key
   * was to move the scrollbar and leave the selection where it was.
   */
  await musicians.click()
  const focusedRow = () => page.evaluate(() => document.activeElement?.textContent?.trim().split('\n')[0] ?? '')
  const paneScroll = () =>
    page.evaluate(() => document.querySelector('.sidplayer-library')?.querySelector('div')?.scrollTop ?? -1)
  const scrolledTo = await paneScroll()
  const from = await focusedRow()
  await page.keyboard.press('ArrowDown')
  await until('the next row to take focus', async () => (await focusedRow()) !== from, 10000)
  const to = await focusedRow()
  check(true, `an arrow moves to the next row (${from} -> ${to})`)
  await page.keyboard.press('ArrowUp')
  await until('it to come back', async () => (await focusedRow()) === from, 10000)
  check(true, 'and back again')
  check((await paneScroll()) === scrolledTo, 'without scrolling the pane instead')

  // A folder that holds only subfolders must still list what is under it:
  // MUSICIANS has no files of its own anywhere in HVSC.
  await musicians.click()
  await until('the recursive listing', async () => (await page.getByText(/including subfolders/).count()) > 0)
  check(
    (await library.locator('[role="row"]').count()) > 0,
    'clicking a folder of folders lists what is beneath it'
  )

  // MUSICIANS opens by default because it holds most of the collection; the
  // initial-letter folder under it still has to be expanded, as a user would.
  await page.getByRole('button', { name: 'Expand H' }).click()
  await page
    .getByRole('button', { name: /^Hubbard_Rob/ })
    .first()
    .click()
  await until('the folder listing', async () => (await page.getByText('Monty on the Run').count()) > 0)
  check(true, 'opening a composer folder lists their tunes')
  await dump('04-folder')

  // The header fields are read from the files themselves, 128 bytes at a time.
  await until('header fields', async () => (await page.getByText('1985 Gremlin Graphics').count()) > 0)
  check(true, 'the release line comes from the file header, not the manifest')

  /* ---- detail pane ------------------------------------------------------- */
  console.log('\ndetail')
  await page.getByText('Monty on the Run').first().click()
  const detail = library.locator('h2', { hasText: 'Monty on the Run' })
  await detail.waitFor({ timeout: 15000 })
  check(true, 'the detail pane shows the selected tune')
  check((await page.getByText(/3 subsongs/).count()) > 0, 'subsong count from the header')
  check((await page.getByText(/Devil's Gallop/).count()) > 0, 'STIL commentary for subsong 1')
  check((await page.getByText(/from Songlengths.md5/).count()) > 0, 'lengths attributed to the manifest')
  await dump('05-detail')

  /* ---- sorting ------------------------------------------------------------ */
  console.log('\nsorting')
  const titles = async () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.sidplayer-library [role="row"]')].map((r) =>
        (r.querySelector('.sidplayer-tune-title')?.textContent || '').replace(/ · .*$/, '').trim()
      )
    )
  const natural = await titles()
  const titleHeader = library.getByRole('button', { name: /^Sort(ed)? by title/ })
  await titleHeader.click()
  const asc = await titles()
  check(
    asc.length === natural.length && asc.join('|') === [...asc].sort((a, b) => a.localeCompare(b)).join('|'),
    `clicking Title sorts the list: ${asc.join(', ')}`
  )
  await titleHeader.click()
  const desc = await titles()
  check(desc.join('|') === [...asc].reverse().join('|'), 'clicking it again reverses it')
  await titleHeader.click()
  check((await titles()).join('|') === natural.join('|'), 'and a third click restores the original order')

  /*
   * The sort has to reach rows the table is not showing, or it would only
   * reorder the first 400 of however many there are. Here the folder is
   * small, so the check is the one that can be made: every row moved, not
   * just the ones on screen, and the count did not change.
   */
  await library.getByRole('button', { name: /^Sort by length/ }).click()
  const byLength = await titles()
  check(byLength.length === natural.length, `sorting keeps every row (${byLength.length})`)
  check(new Set(byLength).size === byLength.length, 'and does not duplicate any')
  await library.getByRole('button', { name: /^Sorted by length/ }).click()
  await library.getByRole('button', { name: /^Sorted by length/ }).click()

  /* ---- playback through the shared engine -------------------------------- */
  console.log('\nplayback')
  await library.getByRole('button', { name: 'Play' }).first().click()
  const time = library.locator('text=/\\d:\\d\\d \\/ \\d:\\d\\d/').first()
  await time.waitFor({ timeout: 30000 })
  const first = (await time.textContent())?.trim()
  await until(
    'the position to advance',
    async () => {
      const now = (await time.textContent())?.trim()
      return !!now && now !== first && /0:0[2-9]|0:1\d/.test(now)
    },
    40000
  )
  check(true, `the tune plays: "${first}" → "${(await time.textContent())?.trim()}"`)

  /*
   * The playing row's own button pauses, as the bar's does, and once paused
   * it is the same Play as every other row - which carries on from where the
   * tune stopped rather than starting it again.
   */
  const playingTitle = (
    (await library
      .locator('[role="row"]')
      .filter({ has: page.getByRole('button', { name: /^Pause / }) })
      .locator('.sidplayer-tune-title')
      .first()
      .textContent()) || ''
  ).trim()
  const rowPause = library.getByRole('button', { name: `Pause ${playingTitle}` })
  check((await rowPause.count()) === 1, `the playing row offers Pause (${playingTitle})`)
  await rowPause.click()
  const rowPlay = library.getByRole('button', { name: `Play ${playingTitle}` })
  await rowPlay.waitFor({ timeout: 10000 })
  const pausedAt = (await time.textContent())?.trim()
  await page.waitForTimeout(1500)
  check((await time.textContent())?.trim() === pausedAt, `and pausing there holds the clock (${pausedAt})`)
  await rowPlay.click()
  await until('the row to offer Pause again', async () => (await rowPause.count()) === 1, 10000)
  await until('the clock to move on', async () => (await time.textContent())?.trim() !== pausedAt, 10000)
  const resumedAt = (await time.textContent())?.trim()
  const clock = (t) => {
    const m = /(\d+):(\d\d)\s*\//.exec(t ?? '')
    return m ? Number(m[1]) * 60 + Number(m[2]) : -1
  }
  check(
    clock(pausedAt) > 0 && clock(resumedAt) >= clock(pausedAt),
    `and its Play carries on rather than starting again (${pausedAt} → ${resumedAt})`
  )

  /*
   * The button that started it can stop it. Pausing used to be possible only
   * down in the player bar, so the big button in the detail pane went on
   * offering to play the tune that was already playing.
   */
  const bigButton = library.getByRole('button', { name: /^(Play|Pause)$/ }).first()
  await until(
    'the detail pane button to offer Pause',
    async () => (await bigButton.innerText()).trim() === 'Pause',
    20000
  )
  check(true, 'the detail pane button reads Pause while its tune plays')
  await bigButton.click()
  await until('it to offer Play again', async () => (await bigButton.innerText()).trim() === 'Play', 20000)
  const held = (await time.textContent())?.trim()
  await page.waitForTimeout(1500)
  check((await time.textContent())?.trim() === held, `and pauses it there (${held})`)
  await bigButton.click()
  await until('the position to move again', async () => (await time.textContent())?.trim() !== held, 20000)
  check(true, 'and starts it again from where it stopped')

  /*
   * What it is actually being played on, which is not always what it asks
   * for: the chip and machine can be overridden, and a tune that expresses no
   * preference gets the engine's default. The heading is uppercased by CSS,
   * which is how innerText reports it.
   */
  const paneText = async () => await library.innerText()
  check(/PLAYING ON/i.test(await paneText()), 'the detail pane says what the tune is playing on')
  check(
    /MOS 6581[\s\S]{0,40}as the tune asks/i.test(await paneText()),
    "naming the chip and that it is the tune's own choice"
  )
  check(/985,248\.6 Hz/.test(await paneText()), 'and the PAL processor clock to the tenth of a hertz')

  await library.getByRole('button', { name: 'Preferences' }).first().click()
  await page.getByText('MOS 8580', { exact: true }).last().click()
  await page.getByText('NTSC', { exact: true }).last().click()
  await page.keyboard.press('Escape')
  await until('the override to reach the panel', async () => /your choice/.test(await paneText()), 20000)
  check(
    /MOS 8580[\s\S]{0,60}the tune asks for MOS 6581/i.test(await paneText()),
    'an override is shown as yours, beside what the tune wanted'
  )
  check(/1,022,727\.3 Hz/.test(await paneText()), 'and the clock follows the machine actually in use')

  // back to following the tune, so nothing later inherits the override
  await library.getByRole('button', { name: 'Preferences' }).first().click()
  await page.getByText('As the tune says', { exact: true }).first().click()
  await page.getByText('As the tune says', { exact: true }).last().click()
  await page.keyboard.press('Escape')
  await until('the override to be lifted', async () => /as the tune asks/.test(await paneText()), 20000)
  check(true, 'and goes back to following the tune when the override is lifted')
  await dump('06-playing')

  /*
   * The ✕ at the right of the bar, the same one the dock in Files has. The
   * library's bar stays put when it stops, so stopping is all it does: back
   * to "Nothing playing", with no ✕ left to offer.
   */
  const close = library.getByRole('button', { name: 'Stop and close' })
  check((await close.count()) === 1, 'the player bar offers a ✕ while a tune is loaded')
  await close.click()
  await until(
    'the bar to say nothing is playing',
    async () => /Nothing playing/.test(await library.innerText()),
    10000
  )
  const stoppedAt = (await library.innerText()).match(/\d:\d\d \/ \d:\d\d/)?.[0]
  await page.waitForTimeout(1500)
  check((await library.innerText()).match(/\d:\d\d \/ \d:\d\d/)?.[0] === stoppedAt, 'and the ✕ stops the tune')
  check((await close.count()) === 0, 'leaving no ✕ behind it')
  check((await bigButton.innerText()).trim() === 'Play', 'and the detail pane offers to play it again')

  /* ---- search ------------------------------------------------------------ */
  console.log('\nsearch')
  await search.fill('hubbard')
  await until('search results', async () => (await page.getByText(/Search · hubbard/).count()) > 0)
  const rows = library.locator('[role="row"]')
  check((await rows.count()) >= 3, `searching a composer finds their tunes (${await rows.count()} rows)`)

  await search.fill('huelsbeck')
  await until('the umlaut spelling', async () => (await page.getByText('Turrican 2').count()) > 0)
  check(true, '"huelsbeck" finds Huelsbeck_Chris')
  await search.fill('hulsbeck')
  await until('the collapsed spelling', async () => (await page.getByText('Turrican 2').count()) > 0)
  check(true, '"hulsbeck", without the e, finds it too')

  await search.fill('songs:>1')
  await until('a filter query', async () => (await page.getByText(/Search · songs:>1/).count()) > 0)
  const multi = await library.locator('[role="row"]').count()
  check(multi >= 1, `songs:>1 filters to multi-subsong tunes (${multi})`)
  await dump('07-search')

  /*
   * Where you are on the left, how many on the right - the same shape in
   * every mode. The count used to be the tail of the breadcrumb, and the
   * right-hand end of this row used to hold a "Clear" sitting directly
   * above the column of stars.
   */
  const tally = library.locator('.sidplayer-results-tally')
  check(
    /^\d+ results?$/.test(((await tally.textContent()) || '').trim()),
    `the count sits on the right, on its own: "${((await tally.textContent()) || '').trim()}"`
  )
  check(
    !/result/.test(
      (await page
        .getByText(/^Search · /)
        .first()
        .textContent()) || ''
    ),
    'and no longer trails the query on the left'
  )
  check(
    // `name` is a substring match unless told otherwise, and the new
    // control is called "Clear the search".
    (await library.getByRole('button', { name: 'Clear', exact: true }).count()) === 0,
    'nothing called "Clear" is left above the stars'
  )

  // The clear control now lives beside the field it clears, on its left.
  const clear = page.getByRole('button', { name: 'Clear the search' })
  const boxes = await page.evaluate(() => {
    const b = document.querySelector('.sidplayer-search')?.getBoundingClientRect()
    const c = [...document.querySelectorAll('button')]
      .find((el) => el.getAttribute('aria-label') === 'Clear the search')
      ?.getBoundingClientRect()
    return b && c ? { field: Math.round(b.left), clear: Math.round(c.right) } : null
  })
  check(
    !!boxes && boxes.clear <= boxes.field,
    `the clear control is left of the search field (${boxes?.clear} ≤ ${boxes?.field})`
  )
  // The three-column bar exists to keep the field in the middle whatever
  // the sides contain; the clear control must not shoulder it aside either.
  const centred = await page.evaluate(() => {
    const f = document.querySelector('.sidplayer-search')?.getBoundingClientRect()
    const bar = document
      .querySelector('.sidplayer-search')
      ?.closest('div')
      ?.parentElement?.getBoundingClientRect()
    return f && bar ? Math.round(Math.abs((f.left + f.right) / 2 - (bar.left + bar.right) / 2)) : -1
  })
  check(centred >= 0 && centred <= 2, `the search field stays centred in the bar (off by ${centred}px)`)

  const widthWithClear = await page.evaluate(() =>
    Math.round(document.querySelector('.sidplayer-search')?.getBoundingClientRect().width ?? -1)
  )
  await clear.click()
  await until('the folder again', async () => (await page.getByText(/Search ·/).count()) === 0)
  check(true, 'clicking it returns to the folder')
  check(
    (await page.evaluate(() =>
      Math.round(document.querySelector('.sidplayer-search')?.getBoundingClientRect().width ?? -1)
    )) === widthWithClear,
    `and the field does not change width when it goes away (${widthWithClear}px)`
  )

  /* ---- favourites -------------------------------------------------------- */
  console.log('\nfavourites')
  await page
    .getByRole('button', { name: /^Add .* to favourites/ })
    .first()
    .click()
  await until(
    'the star to stick',
    async () => (await page.getByRole('button', { name: /^Remove .* from favourites/ }).count()) > 0
  )
  check(true, 'starring a tune marks it')
  await page.getByRole('button', { name: 'Favourites' }).first().click()
  await until('the favourites view', async () => (await library.locator('[role="row"]').count()) === 1)
  check(true, 'the favourites view lists exactly the starred tune')

  /*
   * A hand-made order, which is what favourites have instead of a natural
   * one. It lives in the same space file as the stars, with its own
   * timestamp, so it follows the account rather than the browser - which
   * the reload below is the real test of.
   */
  await page
    .getByRole('button', { name: /^MUSICIANS/ })
    .first()
    .click()
  await until('the folder again', async () => (await library.locator('[role="row"]').count()) > 1)
  for (const name of [/^Add Delta to favourites/, /^Add Monty on the Run to favourites/]) {
    const add = page.getByRole('button', { name }).first()
    if (await add.count()) await add.click()
  }
  await page.getByRole('button', { name: 'Favourites' }).first().click()
  await until('three favourites', async () => (await library.locator('[role="row"]').count()) === 3)

  const listed = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.sidplayer-library [role="row"]')].map((r) =>
        (r.querySelector('.sidplayer-tune-title')?.textContent || '').replace(/ · .*$/, '').trim()
      )
    )
  const starting = await listed()
  check(starting.length === 3, `three tunes starred: ${starting.join(', ')}`)
  check(
    ((await library.locator('.sidplayer-results-tally').textContent()) || '').trim() === '3 favourites',
    'and the row counts them on the right, the same as a folder does'
  )

  // The last one to the top, by button: a drag handle cannot be driven
  // honestly from a test, and cannot be reached from a keyboard either.
  const last = starting[2]
  await library.getByRole('button', { name: `Move ${last} up` }).click()
  await until('the move to take', async () => (await listed())[1] === last)
  await library.getByRole('button', { name: `Move ${last} up` }).click()
  await until('and again', async () => (await listed())[0] === last)
  const reordered = await listed()
  check(reordered[0] === last, `moving a tune up puts it first: ${reordered.join(', ')}`)
  check(reordered.length === 3, 'and keeps the rest of the list')
  check(
    await library.getByRole('button', { name: `Move ${last} up` }).isDisabled(),
    'the first row cannot be moved up any further'
  )

  // The order is in the space, not the browser: prove it by reloading - once
  // the space has it. A reload while the last write is still on its way
  // abandons that write, which is the browser's doing and not the test's.
  const stem = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  await until(
    'the order to reach the space',
    async () => {
      const file = await davFetch('GET', `${ROOT}/.sidplayer/favourites.json`).then((r) => r.json())
      const byRank = file.items
        .filter((i) => typeof i.rank === 'number')
        .sort((a, b) => a.rank - b.rank)
        .map((i) =>
          stem(
            i.path
              .split('/')
              .pop()
              .replace(/\.sid$/i, '')
          )
        )
      return byRank.join('|') === reordered.map(stem).join('|')
    },
    20000
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await library.waitFor({ timeout: 60000 })
  await until('the library again', async () => (await page.getByText('HVSC #').count()) > 0)
  // With stars to show, that is where it opens - no click needed.
  await until('the favourites again', async () => (await library.locator('[role="row"]').count()) === 3)
  check(
    ((await library.locator('.sidplayer-results-tally').textContent()) || '').trim() === '3 favourites',
    'with something starred, the library opens on the favourites'
  )
  check((await listed()).join('|') === reordered.join('|'), 'and the order survives a reload')

  const saved = await davFetch('GET', `${ROOT}/.sidplayer/favourites.json`).then((r) => r.json())
  check(
    saved.items.filter((i) => typeof i.rank === 'number' && i.rankedAt).length === 3,
    'every favourite carries a rank and the stamp it was set at, in the space file'
  )

  /*
   * And the drag, which is the way most people will do it. Playwright
   * drives the browser's own HTML5 drag events here, not a synthetic
   * mousedown-move-up, so this exercises the same path a hand does.
   */
  const beforeDrag = await listed()
  await page.dragAndDrop(
    '.sidplayer-library [role="row"]:last-child [draggable="true"]',
    '.sidplayer-library [role="row"]:first-child'
  )
  await until('the drag to land', async () => (await listed())[0] === beforeDrag[2])
  const afterDrag = await listed()
  check(
    afterDrag.join('|') === [beforeDrag[2], beforeDrag[0], beforeDrag[1]].join('|'),
    `dragging the last tune to the top reorders it: ${afterDrag.join(', ')}`
  )

  /*
   * A sort overrides the hand-made order and hides the handles, because a
   * row dragged into a place the sort would immediately take it out of is
   * a promise the list cannot keep. The column it left behind stays
   * reserved: rows sliding sideways when a heading is clicked is the same
   * complaint as a search field that jiggles while it counts.
   */
  const titleX = async () =>
    page.evaluate(() =>
      Math.round(
        document.querySelector('.sidplayer-library [role="row"] .sidplayer-tune-title')?.getBoundingClientRect()
          .left ?? -1
      )
    )
  const restX = await titleX()
  await titleHeader.click()
  await until('the sort to take', async () => (await listed())[0] !== afterDrag[0])
  check(
    (await library.getByRole('button', { name: /^Move .* up/ }).count()) === 0,
    'sorting a column puts the reorder handles away'
  )
  check((await titleX()) === restX, `and nothing slides sideways when it does (${restX}px)`)
  await titleHeader.click()
  await titleHeader.click()
  await until('the sort to clear', async () => (await listed())[0] === afterDrag[0])
  check((await listed()).join('|') === afterDrag.join('|'), 'and clearing it gives the hand-made order back')

  await dump('08-favourites')

  /* ---- composers --------------------------------------------------------- */
  console.log('\ncomposers')
  await page.getByRole('button', { name: 'Composers' }).first().click()
  await until('the composer grid', async () => (await page.getByText(/\d+ composers/).count()) > 0)
  check(
    (await page.getByRole('button', { name: 'Rob Hubbard' }).count()) > 0,
    'Hubbard_Rob reads as "Rob Hubbard"'
  )
  check((await page.getByText('Chris Huelsbeck').count()) > 0, 'the composer list includes Huelsbeck')
  await dump('09-composers')

  /*
   * "Play all" on a composer plays their folder as a list. It used to take
   * the list in front of it - the composer grid's, which is empty - and so
   * played one tune and stopped, with no next to go to.
   */
  const hubbardCard = page
    .getByRole('button', { name: 'Rob Hubbard' })
    .locator('xpath=ancestor::div[.//button[normalize-space()="Play all"]][1]')
  await hubbardCard.getByRole('button', { name: 'Play all' }).click()
  const nextInList = library.getByRole('button', { name: 'Next tune in the list' })
  await nextInList.waitFor({ timeout: 30000 })
  await until('the list to offer a next tune', async () => !(await nextInList.isDisabled()), 30000)
  check(true, '"Play all" plays the composer\'s folder as a list, with somewhere to go next')

  /*
   * And the full view follows the list. Opened on one tune and left to move
   * along, it waited for the tune it was opened on and showed a spinner over
   * the next one, which was playing.
   */
  await page.evaluate(() => {
    history.pushState(history.state, '', '/files/spaces/personal/admin')
    dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
  })
  const dock = page.locator('.sidplayer-dock')
  await dock.getByRole('button', { name: 'Open in SID Player' }).waitFor({ timeout: 30000 })
  await dock.getByRole('button', { name: 'Open in SID Player' }).click()
  await page.waitForURL(/\/sidplayer\//, { timeout: 30000 })
  const full = page.locator('.sidplayer')
  await until('the full view on the first tune', async () => /Commando/.test(await full.innerText()), 30000)
  const firstUrl = page.url()
  await page.keyboard.press('PageDown')
  await until('the full view to follow the list', async () => /Delta/.test(await full.innerText()), 30000)
  check(
    page.url() !== firstUrl,
    'the full view follows the list to the next tune rather than waiting on the first'
  )
  // Back through Files, as the library was first reached, so that leaving
  // it later goes back to Files rather than to this full view.
  await page.goto(`${BASE}/files/spaces/personal/admin`, { waitUntil: 'domcontentloaded' })
  await page.goto(`${BASE}/sidplayer/library`, { waitUntil: 'domcontentloaded' })
  await library.waitFor({ timeout: 60000 })

  /* ---- a new release ----------------------------------------------------- */
  console.log('\nrelease 86')
  // The mirror now serves 86: two tunes added, one withdrawn. The app only
  // asks once a day, so the recorded answer is cleared to make it ask again -
  // the same effect as a day passing.
  mirrorAt(86)
  const cleared = await dav('DELETE', `${ROOT}/.sidplayer/status.json`)
  check(cleared === 204 || cleared === 404, `the recorded check is cleared (${cleared})`)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await library.waitFor({ timeout: 60000 })
  await until(
    'the update banner',
    async () => (await page.getByText(/HVSC #86 is available/).count()) > 0,
    90000
  )
  check(true, 'the banner appears when the mirror is ahead')
  await dump('10-update-available')

  await page.getByRole('button', { name: 'Update…' }).click()
  const dialog2 = page.getByRole('dialog', { name: 'Updating the collection' })
  await dialog2.waitFor({ timeout: 30000 })
  await until('the update plan', async () => (await dialog2.getByText('no longer in HVSC').count()) > 0, 90000)
  check(true, 'the plan separates downloads from removals')
  check(
    (await dialog2.getByText('/DEMOS/0-9/12345.sid').count()) > 0,
    'the withdrawn tune is named, not deleted silently'
  )
  check(
    (await dialog2.getByRole('button', { name: 'Delete these too' }).count()) > 0,
    'deleting withdrawn files needs an explicit choice'
  )
  await dump('11-update-plan')

  await dialog2.getByRole('button', { name: 'Start' }).click()
  await until('the update to finish', async () => (await dialog2.getByText('Up to date').count()) > 0, 180000)
  check(true, 'the update finishes')
  await dialog2.getByRole('button', { name: 'Done' }).click()

  await until('the new release', async () => (await page.getByText('HVSC #86').count()) > 0, 60000)
  check(true, 'the badge now says #86')
  await search.fill('sanxion')
  await until('a tune from the new release', async () => (await page.getByText('Sanxion').count()) > 0)
  check(true, 'a tune added by release 86 is in the library')
  await dump('12-updated')

  /* ---- the withdrawn tune was kept, because nobody approved deleting it -- */
  const kept = await dav('HEAD', `${COLLECTION}/DEMOS/0-9/12345.sid`)
  check(kept === 200, `a withdrawn tune is left alone unless deletion was approved (HEAD ${kept})`)

  /* ---- a collection with no C64Music level ------------------------------- */
  console.log('\nflat layout')
  /*
   * The other way round from what the sync writes: a collection sitting
   * straight in the app's folder, with no `C64Music/` level. That is what
   * older installs have, and what anyone gets who points the app at a
   * folder they have already filled, so it has to read as readily as the
   * nested one. Moving what is there is the cheapest way to produce it.
   */
  for (const folder of ['DOCUMENTS', 'MUSICIANS', 'DEMOS', 'GAMES']) {
    const moved = await dav('MOVE', `${COLLECTION}/${folder}`, { destination: davUrl(`${ROOT}/${folder}`) })
    if (moved >= 400 && moved !== 404) check(false, `could not move ${folder} (${moved})`)
  }
  await dav('DELETE', COLLECTION)
  check(true, 'collection flattened into the app folder, with no C64Music level')

  await page.reload({ waitUntil: 'domcontentloaded' })
  await library.waitFor({ timeout: 60000 })
  await until(
    'the library over the archive layout',
    async () => (await page.getByText('HVSC #').count()) > 0,
    90000
  )
  check(
    (await page.getByText('Set up your SID library').count()) === 0,
    'the flat layout is recognised rather than offered a first sync'
  )
  await search.fill('commando')
  await until('a search over it', async () => (await page.getByText('Commando').count()) > 0)
  check(true, 'tunes with no C64Music level are catalogued and searchable')
  await library.getByRole('button', { name: 'Play' }).first().click()
  const t2 = library.locator('text=/\\d:\\d\\d \\/ \\d:\\d\\d/').first()
  await t2.waitFor({ timeout: 30000 })
  const before2 = (await t2.textContent())?.trim()
  await until(
    'playback from the archive layout',
    async () => {
      const now = (await t2.textContent())?.trim()
      return !!now && now !== before2 && /0:0[2-9]|0:1\d/.test(now)
    },
    40000
  )
  check(true, 'a tune in the flat layout plays')

  /*
   * And the app's own folder never moved with it. Favourites belong to the
   * user, not to the release, so they have no business inside a tree that a
   * re-extracted archive or a sync's removals pass could disturb - which is
   * why it hangs off the configured folder rather than the collection.
   */
  const stillThere = await dav('HEAD', `${ROOT}/.sidplayer/favourites.json`)
  check(stillThere === 200, `the app's folder sits beside the collection, not inside it (${stillThere})`)
  await page.getByRole('button', { name: 'Favourites' }).first().click()
  await until(
    'the favourites over the flat layout',
    async () => (await library.locator('[role="row"]').count()) === 3
  )
  check(true, 'the starred tunes survive the collection moving under them')

  await dump('13-flat-layout')

  /* ---- a tune that will not open says so ---------------------------------
   *
   * The shape this is built from was a real report: a tune sitting on disk
   * whose whole-file GET failed while its 128-byte header read fine, so the
   * row highlighted, the detail pane filled in from the catalogue, and
   * nothing at all said why no sound followed. The player's errors were
   * rendered only by the full view.
   */
  console.log('\na tune that will not open')
  await page.route('**/dav/**', (route) => {
    const r = route.request()
    // The whole file, not the 128-byte header read (`bytes=0-127`). A read
    // of the whole tune asks for a range too now, capped at the size limit.
    const header = r.headers()['range'] === 'bytes=0-127'
    if (r.method() === 'GET' && !header && /\.sid$/.test(decodeURIComponent(r.url()))) {
      return route.fulfill({ status: 500, body: 'decomposedfs: root has no parent' })
    }
    return route.continue()
  })
  await page.getByRole('button', { name: 'Favourites' }).first().click()
  await library.getByRole('button', { name: 'Play' }).first().click()
  await until(
    'the failure to be reported',
    async () => /could not be fetched/.test(await library.innerText()),
    30000
  )
  check(true, 'a tune whose bytes cannot be read says so, with the status')
  check(
    logs.some((l) => /open failed[\s\S]*path/.test(l)),
    'and the console names the path it was looked for at'
  )
  await dump('14-unreadable')
  await page.unroute('**/dav/**')

  /* Leaving must hand the shell its search back, the way a user leaves. */
  await page.goBack({ waitUntil: 'domcontentloaded' })
  await page.waitForURL(/\/files\//, { timeout: 30000 })
  await until('the shell has its search back', async () =>
    page.evaluate(() => {
      const el = document.querySelector('#files-global-search')
      return (
        !!el &&
        getComputedStyle(el).display !== 'none' &&
        !document.getElementById('sidplayer-hide-global-search')
      )
    })
  )
  check(true, 'leaving the library gives the shell its search back')
} catch (error) {
  check(false, `threw: ${error.message}`)
  await dump('99-error')
} finally {
  const interesting = logs.filter((l) => /sidplayer|error|warn/i.test(l)).slice(-12)
  if (interesting.length) {
    console.log('\nbrowser console (filtered):')
    for (const line of interesting) console.log(`    ${line.slice(0, 200)}`)
  }
  writeFileSync(join(OUT, 'lib-console.log'), logs.join('\n'))
  await finish(browser)
}
