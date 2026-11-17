/**
 * The demo's own checks: serves a built site the way GitHub Pages does and
 * drives it in Chromium. Run by build.sh in the pinned Playwright image.
 *
 *   SITE=<built site>  VERSION=<app version>  node checks.mjs
 *
 * Exits non-zero if any check fails or the page logs an error or a warning.
 * report.mjs is the app's source/scripts/checks.mjs, copied beside this by
 * build.sh, so these lines read like the app's own checks.
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { chromium } from 'playwright'
import { check as ok, report } from './report.mjs'

const site = process.env.SITE
const version = process.env.VERSION
if (!site || !version) throw new Error('set SITE to the built site and VERSION to the app version')

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain'
}

// As Pages serves it: names Jekyll leaves out (`_`, `.`) are not there.
const server = createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  if (path.endsWith('/')) path += 'index.html'
  const file = join(site, normalize(path))
  if (!file.startsWith(site) || /\/[_.]/.test(path) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404)
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
  createReadStream(file).pipe(res)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/`

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 860 } })
const logs = []
page.on('console', (m) => {
  if (['error', 'warning'].includes(m.type())) logs.push(`${m.type()}: ${m.text()}`)
})
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`))

const TITLE = '[role="row"] .sidplayer-tune-title'
const titles = () => page.locator(TITLE).allInnerTexts()
const library = () => page.locator('.sidplayer-library').innerText()
/** Loads (or reloads) the page and waits for the first tune. */
const open = async (go) => {
  await go()
  await page.locator(TITLE).first().waitFor({ timeout: 20000 })
}
/** Polls `read` until it returns something truthy, or `ms` pass; returns its last answer. */
const until = async (read, ms = 10000) => {
  const end = Date.now() + ms
  let value = await read()
  while (!value && Date.now() < end) {
    await page.waitForTimeout(100)
    value = await read()
  }
  return value
}

try {
  await open(() => page.goto(url))
  const favourites = await titles()
  ok(
    favourites.length === 10 && favourites[0] === 'Vindicator' && favourites[9] === 'Wizball',
    `favourites in order (${favourites.length})`
  )
  ok((await library()).includes(`v${version}`), `version ${version} under the name`)

  // Each tune has its own length, so the clock shows it only once that tune is
  // playing - the previous one's clock, still running, cannot pass for it.
  const clock = page.locator('text=/\\d:\\d\\d \\/ \\d:\\d\\d/').first()
  /** The clock's position and length, from text like "Author · 1987 · 0:12 / 3:14". */
  const readClock = async () => {
    const m = (await clock.textContent({ timeout: 500 }).catch(() => '')).match(/(\d+:\d\d) \/ (\d+:\d\d)$/)
    return m ? { position: m[1], length: m[2] } : null
  }
  const play = async (name, length) => {
    const row = page.locator('[role="row"]').filter({ hasText: name }).first()
    await row.getByRole('button', { name: /^Play / }).click()
    const a = await until(async () => {
      const now = await readClock()
      return now?.length === length && now
    }, 20000)
    const b =
      a &&
      (await until(async () => {
        const now = await readClock()
        return now?.length === length && now.position !== a.position && now
      }))
    ok(Boolean(a && b), `${name} plays (${a ? `${a.position} -> ${b ? b.position : a.position} / ${length}` : 'not started'})`)
  }

  await play('Vindicator', '3:14')
  await play('Ripleys', '1:55')
  await play('Last Ninja', '4:52')

  await page.getByRole('searchbox').first().click()
  ok(/Search is not part/.test(await page.locator('[role="dialog"]').first().innerText()), 'search says it is not in the demo')
  await page.getByRole('button', { name: 'OK' }).click()
  await page.keyboard.press('/')
  ok((await page.locator('[role="dialog"]').count()) === 1, 'the / key says so too')
  await page.getByRole('button', { name: 'OK' }).click()
  await page.getByRole('button', { name: /Download all/ }).click()
  ok(/Not in this demo/.test(await page.locator('[role="dialog"]').first().innerText()), 'Download all says it is not in the demo')
  await page.getByRole('button', { name: 'OK' }).click()

  await page.getByText('Composers', { exact: true }).first().click()
  ok(await until(async () => /Hubbard/.test(await library())), 'composers view')
  await page.getByText('All tunes', { exact: true }).first().click()
  const all = (await until(async () => {
    const listed = await titles()
    return listed.length === 9 && listed
  })) || (await titles())
  ok(all.length === 9, `all tunes lists the nine HVSC tunes (${all.length})`)
  ok(all.includes('International Karate'), `titles read from the files (${all.slice(0, 3).join(', ')})`)

  await page.getByText('Favourites', { exact: true }).first().click()
  await until(async () => (await titles()).length === 10)
  await page.locator('[role="row"]').filter({ hasText: 'Wizball' }).first().getByRole('button', { name: /Move .* up/ }).click()
  // Saved once the demo's storage has the new order, before the reload.
  await until(() =>
    page.evaluate(() =>
      Object.keys(localStorage).some((key) => {
        const saved = key.endsWith('favourites.json') ? localStorage.getItem(key) : ''
        return saved.includes('Wizball') && saved.indexOf('Wizball') < saved.indexOf('Synth_Sample')
      })
    )
  )
  await open(() => page.reload())
  const after = await titles()
  ok(after[8] === 'Wizball', `a reorder survives a reload (${after.slice(7).join(', ')})`)
} catch (error) {
  ok(false, `the checks stopped: ${error.message}`)
} finally {
  await browser.close()
  server.close()
}

ok(logs.length === 0, logs.length ? `the page logged:\n${logs.join('\n')}` : 'no console errors')
report()
