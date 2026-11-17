#!/usr/bin/env node
/**
 * What the library does with a real-sized collection, in a real browser.
 *
 * The trick that makes this cheap: the catalogue, the tree and the search
 * index are all built from the collection's documents, not from the tunes. So
 * uploading the genuine `Songlengths.md5` (5.0 MB, 61,157 entries), `STIL.txt`
 * (3.6 MB) and `Musicians.txt` gives the library exactly the workload it would
 * face against a full 395 MB collection, without moving 395 MB anywhere.
 *
 * What that leaves untested is the sync itself at scale, and that is said
 * plainly rather than implied: every tune here is "not downloaded", which is
 * itself worth seeing, since it is what a collection mid-download looks like.
 *
 * Environment:
 *   HVSC_DOCS    directory holding the three documents (required)
 *   OC_URL       default https://localhost:9300
 *   OC_USER/OC_PASSWORD  default admin/admin
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FLAGS_PAL_8580, sidFile } from '../scripts/sid-bytes.mjs'
import { check, dav, env, finish, launch, LEGACY_ROOT, ROOT, signIn } from './harness.mjs'

const DOCS = process.env.HVSC_DOCS
const { BASE, OUT } = env()

const NAMES = ['Songlengths.md5', 'STIL.txt', 'Musicians.txt']

/**
 * A minimal but genuine PSID v2 file, built here rather than mounted from
 * `tests/fixtures`, so this script needs nothing but the documents. Only the
 * first 128 bytes are ever read from these, and what is read is the header.
 *
 * Sixteen bytes of nothing stand in for the tune, and the text fields are
 * cut at 31 characters so each keeps its terminating NUL.
 */
const psid = (name, author, released) =>
  sidFile({
    name,
    author,
    released,
    playAddress: 0x1006,
    flags: FLAGS_PAL_8580,
    textLimit: 31,
    data: new Uint8Array(16)
  })
const TUNE_TITLE = 'Scale Test Tone'
if (!DOCS || !NAMES.every((n) => existsSync(join(DOCS, n)))) {
  console.error(`set HVSC_DOCS to a directory holding ${NAMES.join(', ')}`)
  process.exit(2)
}

console.log('\npreparing a real-sized collection')
await dav('DELETE', ROOT)
await dav('DELETE', LEGACY_ROOT)
await dav('MKCOL', ROOT)
await dav('MKCOL', `${ROOT}/DOCUMENTS`)
for (const name of NAMES) {
  const bytes = readFileSync(join(DOCS, name))
  const status = await dav('PUT', `${ROOT}/DOCUMENTS/${name}`, { body: bytes })
  check(
    status >= 200 && status < 300,
    `uploaded ${name} (${(bytes.length / 1048576).toFixed(1)} MB, ${status})`
  )
}

/*
 * A folder's worth of real tune files, at paths the manifest lists.
 *
 * Without them nothing is downloaded, every header read 404s, and the step
 * that used to freeze the page - folding newly read headers into the search
 * index - never runs. Forty files under one composer is enough to make it
 * run, and the MD5s need not match: only the first 128 bytes are read.
 */
const manifest = readFileSync(join(DOCS, 'Songlengths.md5'), 'latin1')
const FOLDER = '/MUSICIANS/H/Hubbard_Rob'
const paths = [...manifest.matchAll(/^; (\/MUSICIANS\/H\/Hubbard_Rob\/[^\r\n]+\.sid)$/gim)]
  .map((m) => m[1])
  .slice(0, 40)
check(paths.length === 40, `found ${paths.length} manifest paths under ${FOLDER} to populate`)
// PUT into a collection that is not there answers 409, so build the path.
for (const folder of ['/MUSICIANS', '/MUSICIANS/H', FOLDER]) await dav('MKCOL', `${ROOT}${folder}`)
const tuneBytes = psid(TUNE_TITLE, 'Rob Hubbard', '1985 Elite')
let uploaded = 0
for (const path of paths) {
  const status = await dav('PUT', `${ROOT}${path}`, { body: tuneBytes })
  if (status >= 200 && status < 300) uploaded++
}
check(uploaded === paths.length, `uploaded ${uploaded} tunes into ${FOLDER}`)

const { browser, page } = await launch({ args: ['--ignore-certificate-errors'] })
const library = page.locator('.sidplayer-library')

try {
  await signIn(page)

  console.log('\nopening the library over 61,157 tunes')
  const started = Date.now()
  await page.goto(`${BASE}/sidplayer/library`, { waitUntil: 'domcontentloaded' })
  await library.waitFor({ timeout: 60000 })
  // "ready" is when the tree has counts in it.
  await page.getByRole('button', { name: /^MUSICIANS/ }).waitFor({ timeout: 120000 })
  const ready = Date.now() - started
  console.log(`  opened in ${(ready / 1000).toFixed(1)} s, including sign-in redirect and 9 MB of documents`)
  check(ready < 60000, `the library opens in reasonable time (${(ready / 1000).toFixed(1)} s)`)

  const total = await page.getByPlaceholder(/Search 61,157 tunes/).count()
  check(total > 0, 'the search field reports all 61,157 tunes')

  console.log('\nsearching')
  for (const query of ['commando', 'monty on the run', 'hubbard', 'hulsbeck', 'songs:>1 galway']) {
    const t0 = Date.now()
    await page.getByRole('searchbox', { name: 'Search the collection' }).fill(query)
    await page
      .getByText(/Search ·/)
      .first()
      .waitFor({ timeout: 30000 })
    const rows = library.locator('[role="row"]')
    await rows
      .first()
      .waitFor({ timeout: 30000 })
      .catch(() => undefined)
    const took = Date.now() - t0
    const count = await rows.count()
    console.log(`  "${query}" -> ${count} rows shown in ${took} ms (typing, searching and painting)`)
    check(count > 0 && took < 4000, `"${query}" answers quickly`)
  }

  console.log('\nbrowsing the real tree')
  await page.getByRole('searchbox', { name: 'Search the collection' }).fill('')
  await page.getByRole('button', { name: 'Expand H' }).click()
  const hubbard = page.getByRole('button', { name: /^Hubbard_Rob/ })
  await hubbard.waitFor({ timeout: 30000 })
  check(true, 'the tree opens to a composer in a 1,951-folder collection')
  await hubbard.click()
  await page
    .getByText(/tunes$/)
    .first()
    .waitFor({ timeout: 30000 })
  const listed = await library.locator('[role="row"]').count()
  // 96 in release 85 - counted from the manifest, not guessed. The largest
  // composer folder is Bayliss_Richard with 1,298, which the list windows.
  check(listed === 96, `Hubbard_Rob lists all ${listed} of its tunes`)

  /*
   * Nothing was downloaded here, so every row in a folder must say so - this
   * is what a collection looks like mid-sync, and what on-demand play is
   * for. Only in a folder: across search results, spanning folders nobody
   * has opened, the library does not know and says nothing.
   */
  await page
    .getByText(/not downloaded/)
    .first()
    .waitFor({ timeout: 30000 })
  check(true, 'tunes absent from the space are marked in a folder listing')

  /*
   * The folders that matter in HVSC hold only subfolders - MUSICIANS has
   * 56,568 tunes beneath it and none of its own - so clicking one has to
   * list what is underneath, matching the count the tree prints.
   */
  const musicians = page.getByRole('button', { name: /^MUSICIANS/ })
  await musicians.click()
  await page.getByText(/including subfolders/).waitFor({ timeout: 30000 })
  const beneath = await library.locator('[role="row"]').count()
  check(beneath === 400, `MUSICIANS lists what is beneath it, windowed to ${beneath} rows`)
  await page.getByText(/more not shown/).waitFor({ timeout: 15000 })
  check(true, 'and says how many more there are')

  /*
   * With more rows than fit, the list has to scroll inside its own pane and
   * stop short of the player bar. Without min-height: 0 on the flex column
   * it did neither: the column grew past the body, so the rows painted over
   * the transport controls and there was nothing to scroll.
   */
  const geometry = await page.evaluate(() => {
    const scroller = [...document.querySelectorAll('.sidplayer-library div')].find(
      (el) => el.scrollHeight > el.clientHeight + 40 && getComputedStyle(el).overflowY === 'auto'
    )
    if (!scroller) return null
    const before = scroller.scrollTop
    scroller.scrollTop = 600
    const after = scroller.scrollTop
    const range = document.querySelector('input[type="range"]')
    const bar = range ? range.closest('div[style*="border-top"]') : null
    return {
      scrolled: after > before,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      listBottom: Math.round(scroller.getBoundingClientRect().bottom),
      barTop: bar ? Math.round(bar.getBoundingClientRect().top) : null,
      viewport: window.innerHeight
    }
  })
  check(!!geometry, 'the list has a scrolling pane of its own')
  if (geometry) {
    console.log(
      `  scroller: ${geometry.clientHeight}px tall over ${geometry.scrollHeight}px of rows; ` +
        `list ends at ${geometry.listBottom}, player bar starts at ${geometry.barTop}, viewport ${geometry.viewport}`
    )
    check(geometry.scrolled, 'scrolling the list works')
    check(
      geometry.barTop !== null && geometry.listBottom <= geometry.barTop + 1,
      'the list stops where the player bar starts, rather than running under it'
    )
    check(geometry.listBottom <= geometry.viewport, 'and stays inside the viewport')
  }

  /*
   * Opening a folder reads its headers, and folding those into the search
   * index used to rebuild the whole thing: 1.4 seconds with the main thread
   * stopped, on every folder opened and every search, in the middle of
   * whatever was playing. The clock froze, the spectrum froze, clicks
   * queued up. This watches the frame clock across the whole operation, so
   * a return to rebuilding shows up as a gap nobody could miss.
   */
  console.log('\nfolding newly read headers into the index')
  await page.getByRole('button', { name: /^MUSICIANS/ }).click()
  await page.evaluate(() => {
    const gaps = []
    let last = performance.now()
    const tick = () => {
      const now = performance.now()
      gaps.push(now - last)
      last = now
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    window.__gaps = gaps
  })
  await page.getByRole('button', { name: /^Hubbard_Rob/ }).click()
  // Wait for the fill to have landed: a title only a header read can know.
  await page
    .getByText(TUNE_TITLE)
    .first()
    .waitFor({ timeout: 60000 })
    .catch(() => undefined)
  await page.waitForTimeout(1500)
  const worst = await page.evaluate(() => {
    const gaps = window.__gaps || []
    window.__gaps = []
    return { frames: gaps.length, worst: Math.round(Math.max(0, ...gaps)) }
  })
  console.log(`  worst frame gap while headers landed: ${worst.worst} ms over ${worst.frames} frames`)
  check(worst.frames > 10, 'the frame clock was running to measure with')
  check(worst.worst < 400, `the page never froze folding headers in (worst gap ${worst.worst} ms)`)
  check(
    (await page.getByText(TUNE_TITLE).count()) > 0,
    'and the headers really were read, so there was work to fold in'
  )

  await page.getByRole('button', { name: /^All tunes/ }).click()
  await page.getByText(/including subfolders/).waitFor({ timeout: 30000 })
  check(
    (await library.locator('[role="row"]').count()) === 400,
    'All tunes lists the whole collection, windowed'
  )

  await page.getByRole('searchbox', { name: 'Search the collection' }).fill('path:MUSICIANS/B/Bayliss_Richard')
  await page
    .getByText(/Search ·/)
    .first()
    .waitFor({ timeout: 30000 })
  const windowed = await library.locator('[role="row"]').count()
  check(windowed > 300 && windowed <= 400, `the largest folder, 1,298 tunes, is windowed to ${windowed} rows`)
  await page.getByText(/more not shown/).waitFor({ timeout: 15000 })
  check(true, 'and says how many it is not showing')
  check(
    (await page.getByText(/not downloaded/).count()) === 0,
    'and claims nothing about what is local, since search spans folders'
  )

  /*
   * The search field must not move while something is counting beside it.
   *
   * It used to sit in the bar's one flexible child, centred in whatever
   * space the rest left it, so the activity pill growing from "8 of 61,157"
   * to "61,157 of 61,157" - 24 px - slid the field by half of that, several
   * times a second, for as long as indexing ran.
   */
  /*
   * Sorting the whole collection, which is the case that could hurt: the
   * table shows 400 rows but the sort has to order all 61,157 before the
   * window is taken, or it would reorder an arbitrary 400 and call it a
   * sort. Keys are built once per row rather than inside the comparator,
   * which is the difference between 182 ms and 64 ms over this many rows.
   */
  console.log('\nsorting the whole collection')
  await page.getByRole('button', { name: /^All tunes/ }).click()
  await page.getByText(/including subfolders/).waitFor({ timeout: 30000 })
  await page.evaluate(() => {
    const gaps = []
    let last = performance.now()
    const tick = () => {
      const now = performance.now()
      gaps.push(now - last)
      last = now
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    window.__sortGaps = gaps
  })
  const t0 = Date.now()
  await page.getByRole('button', { name: /^Sort by length/ }).click()
  await page.getByRole('button', { name: /^Sorted by length, ascending/ }).waitFor({ timeout: 30000 })
  const sortMs = Date.now() - t0
  await page.waitForTimeout(600)
  const sortGap = await page.evaluate(() => Math.round(Math.max(0, ...(window.__sortGaps || []))))
  console.log(`  sorting 61,157 rows took ${sortMs} ms, worst frame gap ${sortGap} ms`)
  check(sortGap < 400, `sorting the whole collection does not freeze the page (worst gap ${sortGap} ms)`)

  /**
   * The Length column of every rendered row, as seconds. `formatTime` writes
   * `h:mm:ss` past the hour, and the longest tunes in HVSC are well past it.
   */
  const lengths = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.sidplayer-library [role="row"]')].map((r) => {
        const parts = (r.children[4]?.textContent || '').trim().split(':')
        if (parts.length < 2 || parts.some((p) => !/^\d+$/.test(p))) return NaN
        return parts.reduce((total, p) => total * 60 + Number(p), 0)
      })
    )
  const up = await lengths()
  check(up.length === 400 && up.every(Number.isFinite), `the window still holds ${up.length} rows`)
  check(
    up.every((v, i) => i === 0 || up[i - 1] <= v),
    `shortest first: ${up[0]}s .. ${up[up.length - 1]}s`
  )
  await page.getByRole('button', { name: /^Sorted by length, ascending/ }).click()
  const down = await lengths()
  check(
    down.every((v, i) => i === 0 || down[i - 1] >= v),
    `and longest first when reversed: ${down[0]}s .. ${down[down.length - 1]}s`
  )
  /*
   * The window must come from the whole collection, not from the 400 rows
   * that happened to be at the front: the longest tune in HVSC is hours
   * long, and nothing near it sits at the top of the path order.
   */
  check(down[0] > 3600, `the top row is the longest tune in all 61,157, not in the first 400 (${down[0]}s)`)
  await page.getByRole('button', { name: /^Sorted by length, descending/ }).click()

  console.log('\nthe bar while something is counting')
  await page.getByRole('searchbox', { name: 'Search the collection' }).fill('')
  const indexAll = page.getByRole('button', { name: /Index all tunes/ })
  check((await indexAll.count()) > 0, 'there are headers left to read, so indexing has something to do')
  if (await indexAll.count()) {
    await indexAll.click()
    const positions = []
    const widths = []
    for (let i = 0; i < 24; i++) {
      const s = await page.evaluate(() => {
        const input = document.querySelector('.sidplayer-library input[aria-label="Search the collection"]')
        const pill = [...document.querySelectorAll('.sidplayer-library button')].find((b) =>
          /Reading headers/.test(b.textContent || '')
        )
        return {
          x: input ? +input.getBoundingClientRect().x.toFixed(1) : null,
          pill: pill ? +pill.getBoundingClientRect().width.toFixed(1) : null
        }
      })
      if (s.x !== null) positions.push(s.x)
      if (s.pill !== null) widths.push(s.pill)
      await page.waitForTimeout(150)
    }
    const spread = (a) => (a.length ? +(Math.max(...a) - Math.min(...a)).toFixed(1) : -1)
    console.log(
      `  search field moved ${spread(positions)} px over ${positions.length} samples, ` +
        `while the activity pill varied by ${spread(widths)} px`
    )
    check(widths.length > 5, `the pill was really counting (${widths.length} samples of it)`)
    check(spread(positions) < 1, `and the search field did not move (${spread(positions)} px)`)
    const stop = page.getByRole('button', { name: 'Stop' })
    if (await stop.count()) await stop.click()
  }

  console.log('\nwhat the page is holding')
  const memory = await page.evaluate(() => {
    const m = performance.memory
    return m
      ? { used: Math.round(m.usedJSHeapSize / 1048576), limit: Math.round(m.jsHeapSizeLimit / 1048576) }
      : null
  })
  if (memory) {
    console.log(`  JS heap in use: ${memory.used} MB of a ${memory.limit} MB limit`)
    check(memory.used < 900, `heap use is sane for 61,157 rows (${memory.used} MB)`)
  }

  await page.screenshot({ path: join(OUT, 'scale-61k.png') })
} catch (error) {
  check(false, `threw: ${error.message}`)
  await page.screenshot({ path: join(OUT, 'scale-error.png') }).catch(() => undefined)
} finally {
  await finish(browser)
}
