#!/usr/bin/env node
/**
 * Browser test for an online collection: started with the documents only,
 * each tune fetched into the space the first time it is played, and the
 * rest downloaded in bulk only when asked.
 *
 * Needs the same rig as library.mjs, and resets the space the same way, so
 * run it on its own or before library.mjs.
 *
 * Environment: as library.mjs.
 */
import { execFileSync } from 'node:child_process'
import {
  check,
  dav as davRequest,
  davFetch,
  dump as dumpPage,
  env,
  finish,
  launch,
  LEGACY_ROOT,
  ROOT,
  signIn,
  until as untilTrue
} from './harness.mjs'

const { BASE } = env()
const { browser, page } = await launch()
const dump = (name) => dumpPage(page, `online-${name}`)
const dav = (method, path, headers = {}) => davRequest(method, path, { headers })
const until = (what, predicate, timeout = 120000) =>
  untilTrue(page, what, predicate, { timeout, interval: 500 })

const COLLECTION = `${ROOT}/C64Music`
const library = page.locator('.sidplayer-library')
const dialog = page.getByRole('dialog', { name: 'Updating the collection' })
const exists = async (path) => (await dav('PROPFIND', path, { depth: '0' })) === 207

try {
  console.log('\nreset')
  execFileSync('node', ['make-mirror.mjs'], { env: { ...process.env, RELEASE: '85' }, encoding: 'utf8' })
  const removed = await dav('DELETE', ROOT)
  const removedLegacy = await dav('DELETE', LEGACY_ROOT)
  check(
    [204, 404].includes(removed) && [204, 404].includes(removedLegacy),
    `the space starts empty (${removed}, ${removedLegacy})`
  )

  await signIn(page)
  await page.goto(`${BASE}/sidplayer/library`, { waitUntil: 'domcontentloaded' })
  await library.waitFor({ timeout: 60000 })

  /* ---- starting online --------------------------------------------------- */
  console.log('\nstarting online')
  await page.getByText(/Mirror is reachable, offering release 85/).waitFor({ timeout: 60000 })
  const online = page.getByRole('button', { name: 'Start online' })
  check(await online.isEnabled(), 'the first-run screen offers to start online')
  check(await page.getByRole('button', { name: /Download release 85/ }).isEnabled(), 'beside the full download')
  await online.click()
  await dialog.waitFor({ timeout: 30000 })
  await until(
    'the documents to arrive',
    async () => (await dialog.getByRole('button', { name: 'Done' }).count()) > 0
  )
  check(
    (await dialog.getByText('Up to date').count()) > 0,
    `the panel says it finished: "${(await dialog.innerText()).slice(0, 120).replace(/\s+/g, ' ')}"`
  )
  await dump('01-started')
  await dialog.getByRole('button', { name: 'Done' }).click()

  check(await exists(`${COLLECTION}/DOCUMENTS/Songlengths.md5`), 'the documents are in the space')
  check(!(await exists(`${COLLECTION}/MUSICIANS`)), 'and not one tune')
  const status = await davFetch('GET', `${ROOT}/.sidplayer/status.json`).then((r) => r.json())
  check(
    status.mode === 'online' && status.release === 85,
    `the status says online, release 85 (${JSON.stringify({ mode: status.mode, release: status.release })})`
  )
  await until('the catalogue', async () => (await page.getByText('HVSC #85').count()) > 0)
  check(true, 'the whole release is catalogued')

  /* ---- a tune, fetched as it is played ------------------------------------ */
  console.log('\nplaying')
  await page.getByRole('searchbox', { name: 'Search the collection' }).fill('wizball')
  await until('the search', async () => (await page.getByText(/Search · wizball/).count()) > 0)
  const row = library.locator('[role="row"]').filter({ hasText: 'Wizball' }).first()
  await row.getByRole('button', { name: /^Play / }).click()
  const time = library.locator('text=/\\d:\\d\\d \\/ \\d:\\d\\d/').first()
  await time.waitFor({ timeout: 30000 })
  const first = (await time.textContent())?.trim()
  await until('the position to advance', async () => (await time.textContent())?.trim() !== first, 40000)
  check(true, 'a tune not in the space plays')
  check(await exists(`${COLLECTION}/MUSICIANS/G/Galway_Martin/Wizball.sid`), 'and is now kept in the space')
  check(!(await exists(`${COLLECTION}/MUSICIANS/H`)), 'and nothing else came with it')
  await page
    .getByRole('button', { name: 'Stop and close' })
    .click()
    .catch(() => undefined)

  /* ---- the rest, only when asked ------------------------------------------ */
  console.log('\ndownloading the rest')
  const all = library.getByRole('button', { name: 'Download all…' })
  await all.waitFor({ timeout: 15000 })
  check(true, 'an online collection offers to download everything')
  await all.click()
  await dialog.waitFor({ timeout: 30000 })
  await until('a plan', async () => (await dialog.getByText('to download').count()) > 0)
  check(!(await exists(`${COLLECTION}/MUSICIANS/H`)), 'nothing is fetched until Start is pressed')
  await dump('02-plan')
  await dialog.getByRole('button', { name: 'Start' }).click()
  await until('the download', async () => (await dialog.getByText('Up to date').count()) > 0, 180000)
  check(await exists(`${COLLECTION}/MUSICIANS/H/Hubbard_Rob/Commando.sid`), 'every tune arrives')
  const after = await davFetch('GET', `${ROOT}/.sidplayer/status.json`).then((r) => r.json())
  check(after.mode === undefined, 'and the collection is whole from then on')
  await dialog.getByRole('button', { name: 'Done' }).click()
  await until('the button to go', async () => (await all.count()) === 0, 15000)
  check(true, 'with no offer to download what it already has')
} catch (e) {
  check(false, `threw: ${e.message}`)
  await dump('99-error')
} finally {
  await finish(browser)
}
