/**
 * What every browser driver in this directory does before and after the part
 * that is its own: read the environment, start a Chromium that will play
 * audio and accept the rig's certificates, sign in, reach the space over
 * WebDAV, wait for things, and finish with a count and an exit code.
 *
 * Five scripts each carried a copy. Where the copies differed - the port, the
 * viewport, the Chromium flags, how long to wait and how often to look - the
 * difference is a parameter here and each script passes its own.
 *
 * Two files outside this directory are read: `../src/defaults.json`, for the
 * folder the app works out of, and `../scripts/checks.mjs`, for the counter
 * the verify scripts print with too. So the drivers run with `source/`
 * mounted, not `e2e/` alone; see README.md.
 *
 * Importing this does nothing but read that one JSON file. Nothing is
 * launched, written or fetched until a script asks.
 */
import { chromium } from 'playwright'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { check, failureCount, report } from '../scripts/checks.mjs'

export { check, failureCount, report }

/**
 * The folder the app works out of, which is also the point of the `/SID
 * Library` default: one place holding `C64Music/` for HVSC and room beside
 * it for other collections. The space in the name is deliberate - it is
 * what an admin would actually type, and it has to survive every URL this
 * rig builds. Read from the app's own defaults, so the two cannot disagree.
 */
export const ROOT = JSON.parse(readFileSync(new URL('../src/defaults.json', import.meta.url), 'utf8')).hvscPath
/*
 * What the app's folder was called before the rename. The app falls back to
 * it when the configured one is empty, so a run that left something here
 * would otherwise be found instead of the clean state a test sets up.
 */
export const LEGACY_ROOT = '/SID Player'

/* ---- environment --------------------------------------------------------- */

let settings = null

/**
 * Reads the environment, creates the output directory and returns
 * `{ BASE, USER, PASSWORD, OUT }`. Call it once, first: everything below
 * that talks to the instance uses what it read.
 *
 *   OC_URL       default `url`: the proxy on 9300, or OpenCloud itself on 9200
 *   OC_USER      default admin
 *   OC_PASSWORD  default admin
 *   OUT          screenshots and dumps, default ./out
 *
 * `insecureTls` is for the scripts that speak WebDAV from Node: the rig has
 * self-signed certificates all round, on the proxy and behind it.
 */
export function env({ url = 'https://localhost:9300', insecureTls = true } = {}) {
  if (insecureTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  settings = {
    BASE: (process.env.OC_URL || url).replace(/\/$/, ''),
    USER: process.env.OC_USER || 'admin',
    PASSWORD: process.env.OC_PASSWORD || 'admin',
    OUT: process.env.OUT || './out'
  }
  mkdirSync(settings.OUT, { recursive: true })
  return settings
}

/* ---- the browser --------------------------------------------------------- */

/**
 * A Chromium, one page in it, and everything that page says on its console.
 *
 * The AudioContext runs headless only with the autoplay flag, and the rig's
 * certificate is self-signed; a script that needs other flags passes its own
 * list whole.
 */
export async function launch({
  viewport = { width: 1440, height: 900 },
  args = ['--autoplay-policy=no-user-gesture-required', '--ignore-certificate-errors']
} = {}) {
  const browser = await chromium.launch({ args })
  // A locale is required: with none, OpenCloud's file sort throws in Intl.Collator and the list renders empty.
  const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US', viewport })
  const page = await context.newPage()
  const logs = []
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
  return { browser, context, page, logs }
}

/** Signs in through the login form and waits for Files, where OpenCloud lands. */
export async function signIn(page) {
  const { BASE, USER, PASSWORD } = settings
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  const password = page.locator('input[type="password"]').first()
  await password.waitFor({ timeout: 60000 })
  await page
    .locator('input:not([type="password"]):not([type="hidden"]):not([type="checkbox"])')
    .first()
    .fill(USER)
  await password.fill(PASSWORD)
  await password.press('Enter')
  await page.waitForURL(/\/files\//, { timeout: 90000 })
}

/** A screenshot and the page's HTML, as `<name>.png` and `<name>.html` in OUT. */
export async function dump(page, name) {
  await page.screenshot({ path: join(settings.OUT, `${name}.png`) }).catch(() => undefined)
  writeFileSync(join(settings.OUT, `${name}.html`), await page.content().catch(() => ''))
}

/**
 * Waits for a condition, polling, with a clear failure message. Returns
 * whether it came true; running out of time is a failed check, not a throw,
 * so the run goes on to say what else is wrong.
 */
export async function until(page, what, predicate, { timeout = 120000, interval = 500 } = {}) {
  const started = Date.now()
  for (;;) {
    if (await predicate().catch(() => false)) return true
    if (Date.now() - started > timeout) {
      check(false, `timed out waiting for ${what}`)
      return false
    }
    await page.waitForTimeout(interval)
  }
}

/* ---- WebDAV -------------------------------------------------------------- */

export const davUrl = (path) =>
  `${settings.BASE}/remote.php/dav/files/${settings.USER}${path.split('/').map(encodeURIComponent).join('/')}`

/**
 * WebDAV straight from the runner, with basic auth. Used to put the instance
 * into a known state, which the browser cannot be asked to do: the point of
 * a test is what the app does to the space as it finds it, so the space has
 * to start the same however the last run left it.
 */
export const davFetch = (method, path, { headers = {}, body } = {}) =>
  fetch(davUrl(path), {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`${settings.USER}:${settings.PASSWORD}`).toString('base64')}`,
      ...headers
    },
    body
  })

/** The same, for when the status is the whole answer. */
export const dav = async (method, path, options) => (await davFetch(method, path, options)).status

/* ---- the end ------------------------------------------------------------- */

/** Closes the browser, prints the count and exits: 1 if any check failed. */
export async function finish(browser, hint) {
  await browser.close()
  report(hint)
}
