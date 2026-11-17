#!/usr/bin/env node
/**
 * Browser smoke test against a running OpenCloud with the built app mounted.
 *
 * Signs in and exercises the whole chain in a real Chromium: the dock that
 * appears when a tune is left-clicked in Files, playback surviving
 * navigation, the full view reached from the dock and from the context menu,
 * subsong navigation, preferences and theme, and the
 * error states. The position readout only moves when the audio worklet is
 * rendering, so "0:03 / 0:20" is proof that module federation, the CSP,
 * WebAssembly and the audio thread all worked.
 *
 * Environment:
 *   OC_URL       default https://localhost:9200
 *   OC_USER      default admin
 *   OC_PASSWORD  default admin
 *   OUT          directory for screenshots and dumps, default ./out
 *
 * Expects the fixtures in the user's root; see README.md.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, dump as dumpPage, env, launch, report, signIn } from './harness.mjs'

// OpenCloud itself rather than the proxy, and nothing here speaks to it from
// Node, so the certificate checks of the runner are left alone.
const { BASE, USER, OUT } = env({ url: 'https://localhost:9200', insecureTls: false })

const { browser, page, logs } = await launch({
  viewport: { width: 1280, height: 800 },
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--ignore-certificate-errors'
  ]
})

const dump = (name) => dumpPage(page, name)

const dock = page.locator('.sidplayer-dock')
const full = page.locator('.sidplayer')
const timeText = (scope) => scope.locator('text=/\\d:\\d\\d \\/ \\d:\\d\\d/').first()
/** Waits until the position readout in `scope` has moved past a couple of seconds. */
async function advances(scope, label) {
  const status = timeText(scope)
  await status.waitFor({ timeout: 30000 })
  const first = (await status.textContent())?.trim()
  const started = Date.now()
  while (Date.now() - started < 20000) {
    await page.waitForTimeout(500)
    const now = (await status.textContent())?.trim()
    if (now && now !== first && /0:0[2-9]|0:1\d/.test(now)) {
      check(true, `${label}: position advances "${first}" → "${now}"`)
      return now
    }
  }
  check(false, `${label}: position did not advance from "${first}"`)
  return first
}
const seconds = (t) => {
  const m = /(\d+):(\d\d)/.exec(t ?? '')
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0
}
/**
 * Back to the Files list WITHOUT a full page load: a `page.goto` would reload
 * the shell and with it the session, which is the thing under test. History
 * navigation stays inside the single-page app.
 */
const filesList = async () => {
  const onPersonal = () => /\/files\/spaces\/personal/.test(page.url())
  if (/\/sidplayer\//.test(page.url()))
    await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => undefined)
  if (!onPersonal()) await page.getByRole('link', { name: 'Personal' }).first().click()
  await page.getByText('tone.sid', { exact: true }).first().waitFor({ timeout: 60000 })
}
/** The resource context menu, opened the way a user opens it: right-click. */
const rowMenu = async (name) => {
  await page.getByText(name, { exact: true }).first().click({ button: 'right' })
}

try {
  /* ---- sign in ------------------------------------------------------------ */
  console.log('\nsign in')
  await signIn(page)
  check(true, `signed in as ${USER}`)
  await filesList()
  check((await dock.count()) === 0 || !(await dock.isVisible()), 'no dock before anything plays')
  await dump('01-files')

  /* ---- left-click plays in the dock -------------------------------------- */
  console.log('\nleft-click on tone.sid')
  await page.getByText('tone.sid', { exact: true }).first().click()
  await dock.waitFor({ state: 'visible', timeout: 30000 })
  check(/\/files\//.test(page.url()), `stays in Files: ${page.url().replace(BASE, '')}`)
  await dock.locator('b', { hasText: 'Test Tone' }).waitFor({ timeout: 30000 })
  check(true, 'dock shows the title once the header is parsed')
  check(await dock.getByText('subsong 1 of 3').isVisible(), 'dock shows the subsong count')
  await advances(dock, 'dock')
  // Songlengths.md5 sits in the same folder and names this tune: 0:45 for
  // subsong 1, where the instance default would read 0:20.
  await dock.locator('text=/\\/ 0:45/').first().waitFor({ timeout: 10000 })
  check(true, 'subsong length comes from Songlengths.md5 beside the tune (0:45, not the 0:20 default)')
  check(await dock.locator('canvas').isVisible(), 'spectrum strip is on by default')
  const webHeight = await page.evaluate(() => document.getElementById('web')?.style.height ?? '')
  check(/100dvh/.test(webHeight) && /\d+px/.test(webHeight), `shell root shortened to make room: ${webHeight}`)
  await dump('02-dock')

  console.log('\ndock controls')
  await dock.getByRole('button', { name: 'Next subsong' }).click()
  await dock.getByText('subsong 2 of 3').waitFor({ timeout: 10000 })
  check(true, 'next subsong from the dock')
  await dock.getByRole('button', { name: 'Hide spectrum' }).click()
  await page.waitForTimeout(300)
  check((await dock.locator('canvas').count()) === 0, 'spectrum toggles off')
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('sidplayer.prefs') ?? '{}'))
  check(stored.analyser === false, 'spectrum choice is saved in browser storage')
  await dock.getByRole('button', { name: 'Show spectrum' }).click()
  await dock.locator('canvas').waitFor({ timeout: 5000 })
  check(true, 'spectrum toggles back on')

  console.log('\nplayback survives navigation')
  await page
    .getByRole('link', { name: 'Favorites' })
    .first()
    .click()
    .catch(() => page.goto(`${BASE}/files/favorites`))
  await page.waitForTimeout(1500)
  check(await dock.isVisible(), 'dock stays while browsing elsewhere')
  const before = seconds(await timeText(dock).textContent())
  await page.waitForTimeout(2000)
  check(seconds(await timeText(dock).textContent()) > before, 'still playing on another page')

  /* ---- full view from the dock, without restart ---------------------------- */
  console.log('\nfull view from the dock')
  const posBefore = seconds(await timeText(dock).textContent())
  await dock.getByRole('button', { name: 'Open in SID Player' }).click()
  await page.waitForURL(/\/sidplayer\//, { timeout: 30000 })
  await full.waitFor({ timeout: 30000 })
  await page.getByText('subsong 2 of 3').first().waitFor({ timeout: 30000 })
  check(true, 'full view opens on the same subsong')
  await page.waitForTimeout(600)
  const posAfter = seconds(await timeText(full).textContent())
  check(posAfter >= posBefore, `playback continued into the full view (${posBefore}s → ${posAfter}s)`)
  check(!(await dock.isVisible()), 'dock hides on the full view')
  await dump('03-full')

  console.log('\npreferences and theme')
  await full.getByRole('button', { name: 'Preferences' }).click()
  const panel = page.getByRole('dialog', { name: 'Player preferences' })
  await panel.waitFor({ timeout: 5000 })
  const themeChoice = panel.getByLabel('Dark')
  const canTheme = (await themeChoice.count()) > 0
  if (canTheme) {
    await themeChoice.check()
    await page.waitForTimeout(300)
    const bg = await full.evaluate((el) => getComputedStyle(el).getPropertyValue('--oc-role-surface').trim())
    const shellBg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--oc-role-surface').trim()
    )
    check(bg !== shellBg && bg !== '', `dark theme applied to the player root only (${bg} vs shell ${shellBg})`)
    check(
      JSON.parse(await page.evaluate(() => localStorage.getItem('sidplayer.prefs'))).theme === 'dark',
      'theme choice saved'
    )
    await dump('04-dark')
    await panel.getByLabel('System').check()
  } else {
    check(true, 'instance offers one theme; theme choice hidden (nothing to test)')
  }
  // Emulation override: forcing the 8580 restarts the tune and it keeps playing.
  await panel.getByRole('radio', { name: /MOS 8580/ }).check()
  await page.waitForTimeout(800)
  check(
    JSON.parse(await page.evaluate(() => localStorage.getItem('sidplayer.prefs'))).chipModel === '8580',
    'chip choice saved'
  )
  await panel
    .getByRole('radio', { name: /As the tune says/ })
    .first()
    .check()
  // Escape inside the panel must close the panel and nothing else: the shell
  // itself closes the whole app on Escape, which is what the panel guards.
  await panel.locator('input').first().focus()
  await page.keyboard.press('Escape')
  await panel.waitFor({ state: 'hidden', timeout: 5000 })
  check(/\/sidplayer\//.test(page.url()), 'Escape closes the preferences without closing the app')

  console.log('\nvoices')
  const voice1 = full.getByRole('button', { name: /^Voice 1/ })
  await voice1.click()
  check((await voice1.getAttribute('aria-pressed')) === 'true', 'voice 1 mute toggles on')
  await full.focus()
  await page.keyboard.press('1')
  check((await voice1.getAttribute('aria-pressed')) === 'false', 'key 1 toggles it back off')

  console.log('\nsubsongs and keyboard in the full view')
  await full.focus()
  await page.keyboard.press('ArrowRight')
  await page.getByText('subsong 3 of 3').first().waitFor({ timeout: 10000 })
  check(true, 'next subsong via the keyboard')
  await page.keyboard.press(' ')
  await full.getByRole('button', { name: 'Play', exact: true }).waitFor({ timeout: 5000 })
  const pausedAt = await timeText(full).textContent()
  await page.waitForTimeout(1500)
  check(
    (await timeText(full).textContent()) === pausedAt,
    `space pauses and position holds (${pausedAt?.trim()})`
  )
  await page.keyboard.press(' ')
  await full.getByRole('button', { name: 'Pause', exact: true }).waitFor({ timeout: 5000 })
  check(true, 'space resumes')
  /*
   * A reload starts the tune at its own first subsong. The app used to
   * remember whichever one you last listened to and reopen on it, which
   * meant a tune could start in the middle of itself days later with nothing
   * saying why; that was dropped along with the repeat modes.
   */
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByText('subsong 1 of 3').first().waitFor({ timeout: 60000 })
  check(true, 'a reload starts at the first subsong rather than the last one played')

  /* ---- context menu: Open in SID Player is the full view ------------------- */
  console.log('\ncontext menu')
  await filesList()
  check(await dock.isVisible(), 'dock is back after leaving the full view')
  // OpenCloud's menu puts the default action first as "Open" and every
  // app-specific action under "Open with…". So: right-click, Open with…,
  // Open in SID Player. The Play entry sits in the same submenu.
  await rowMenu('tone.sid')
  const openWith = page.getByText('Open with...', { exact: true }).first()
  await openWith.waitFor({ timeout: 10000 })
  await openWith.hover()
  await openWith.click()
  // hasText matches text content, so the dock's icon-only button with the
  // same aria-label does not qualify here.
  const openItem = page.locator('button, a, li', { hasText: 'Open in SID Player' }).first()
  await openItem.waitFor({ timeout: 10000 })
  check(true, 'Open with… offers Open in SID Player')
  check(
    await page
      .locator('button, a, li', { hasText: /^\s*Play\s*$/ })
      .first()
      .isVisible()
      .catch(() => false),
    'Open with… offers Play as well'
  )
  await dump('05-menu')
  await openItem.click()
  await page.waitForURL(/\/sidplayer\//, { timeout: 30000 })
  check(true, 'Open in SID Player routes to the full view')

  /* ---- Sidplayer trio and error paths, through the dock -------------------- */
  console.log('\nSidplayer (tune.str clicked)')
  await filesList()
  await page.getByText('tune.str', { exact: true }).first().click()
  await dock.getByText('TEST MUS').first().waitFor({ timeout: 30000 })
  check(true, 'clicking the .str plays the .mus in the dock')
  check(await dock.getByText('SIDPLAYER FIXTURES').first().isVisible(), 'composer from the credits')
  await advances(dock, 'Sidplayer')
  await dock.getByRole('button', { name: 'Open in SID Player' }).click()
  await page.getByText('Sidplayer MUS+STR').first().waitFor({ timeout: 30000 })
  check(await page.getByText('2 SIDs').first().isVisible(), 'stereo pair gives a second SID')
  check(await page.getByText('LA LA LA').first().isVisible(), 'words from the .wds are shown')

  /*
   * The picture beside the tune. tune.pic is a packed Koala carrying the
   * extension of a whole one, so getting the right pixels out proves the
   * unpacker, the decoder and the canvas together. Red where the colour
   * RAM says so, blue - the background - everywhere else.
   */
  const painted = await page.evaluate(() => {
    const canvas = document.querySelector('canvas[role="img"]')
    if (!canvas) return null
    const ctx = canvas.getContext('2d')
    const at = (x, y) => [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3).join(',')
    return { width: canvas.width, height: canvas.height, corner: at(0, 0), middle: at(160, 100) }
  })
  check(
    painted?.width === 320 && painted?.height === 200,
    `the picture is drawn at 320x200 (${painted?.width}x${painted?.height})`
  )
  check(painted?.corner === '104,55,43', `its top-left corner is the colour RAM's red (${painted?.corner})`)
  check(painted?.middle === '53,40,121', `and the rest is the background blue (${painted?.middle})`)
  await dump('06-sidplayer')

  console.log('\nerror paths')
  await filesList()
  await page.getByText('broken.sid', { exact: true }).first().click()
  await dock
    .getByText(/not a PSID or RSID/)
    .first()
    .waitFor({ timeout: 30000 })
  check(true, 'a non-SID file reports itself in the dock')
  await dock.getByRole('button', { name: 'Open in SID Player' }).click()
  await page.getByText('This is not a SID tune').waitFor({ timeout: 30000 })
  // The download URL is resolved after the error is rendered, deliberately:
  // the error states offer a download whatever went wrong, so the link
  // appears a beat later and has to be waited for rather than sampled.
  const download = page.getByRole('link', { name: /Download file/ })
  await download.waitFor({ timeout: 15000 })
  check(await download.isVisible(), 'full view shows the error with a download link')
  await dump('07-broken')

  const kernal = await page.request
    .get(`${BASE}/assets/apps/sidplayer/vendor/sid-engine/kernal.bin`)
    .catch(() => null)
  const hasKernal = !!kernal && kernal.ok() && (await kernal.body()).length === 8192
  console.log(`\ntone-rsid.sid (kernal.bin ${hasKernal ? 'deployed' : 'absent'})`)
  await filesList()
  await page.getByText('tone-rsid.sid', { exact: true }).first().click()
  if (hasKernal) {
    await advances(dock, 'RSID on the real kernal')
  } else {
    await dock
      .getByText(/kernal/i)
      .first()
      .waitFor({ timeout: 30000 })
    check(true, 'RSID without a kernal names the missing ROM')
  }

  console.log('\nstop')
  await dock.getByRole('button', { name: 'Stop and close' }).click()
  await dock.waitFor({ state: 'hidden', timeout: 5000 })
  check(true, 'stop hides the dock')
  const restored = await page.evaluate(() => document.getElementById('web')?.style.height ?? '')
  check(restored === '', 'shell root height restored')

  /*
   * Leaving for another app stops the tune and closes the dock, rather than
   * the sound following the user into somewhere it has nothing to do with.
   * The move has to stay inside the single-page app - a `page.goto` reloads
   * the shell and would stop the tune whatever the app did - so the router is
   * sent there through history, the way it follows the back button.
   */
  console.log('\nleaving for another app')
  await filesList()
  await page.getByText('tone.sid', { exact: true }).first().click()
  await advances(dock, 'playing before leaving')
  await page.evaluate(() => {
    history.pushState(history.state, '', '/account')
    dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
  })
  await page.waitForURL(/\/account/, { timeout: 15000 })
  await dock.waitFor({ state: 'hidden', timeout: 5000 })
  check(true, 'another app stops the tune and hides the dock')
  check(
    (await page.evaluate(() => document.getElementById('web')?.style.height ?? '')) === '',
    'and gives the shell its height back'
  )
  await page.goBack({ waitUntil: 'domcontentloaded' })
  await page.getByText('tone.sid', { exact: true }).first().waitFor({ timeout: 60000 })
  await page.waitForTimeout(1500)
  check(!(await dock.isVisible()), 'coming back to Files does not bring it back')
} catch (e) {
  check(false, e.message.split('\n')[0])
  await dump('99-failure')
} finally {
  await browser.close()
}

const interesting = logs.filter((l) => /sidplayer|CSP|Content Security|wasm|worklet|pageerror/i.test(l))
if (interesting.length) {
  console.log('\nbrowser console (filtered):')
  for (const l of interesting.slice(0, 40)) console.log('   ', l.slice(0, 300))
}
writeFileSync(join(OUT, 'console.log'), logs.join('\n'))

report(` — see ${OUT}/`)
