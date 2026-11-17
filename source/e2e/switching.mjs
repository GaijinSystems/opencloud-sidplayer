#!/usr/bin/env node
/**
 * Switching tunes: one after another in a folder, and out of search results.
 *
 * Every earlier test played exactly one tune, so nothing covered the second
 * click. What goes wrong here is a race by nature - an open that finishes
 * after the user has moved on - so each step waits for the player to settle
 * and then asserts what the bar says, rather than sampling it once.
 */
import { join } from 'node:path'
import { check, dump, env, launch, report, signIn } from './harness.mjs'

const { OUT } = env()

const { browser, page, logs } = await launch()

const library = page.locator('.sidplayer-library')

/**
 * What the player bar is saying, read element by element.
 *
 * Not from textContent: the title, the subsong count and the clock are
 * adjacent nodes with no whitespace between them, so "subsong 1 of 3" and
 * "0:00 / 5:50" concatenate into "...of 30:00 / 5:50" and a regex over the
 * lot reads the song count as part of the position.
 */
const barState = () =>
  page.evaluate(() => {
    const root = document.querySelector('.sidplayer-library')
    if (!root) return null
    const title = [...root.querySelectorAll('b')].pop()
    if (!title) return null
    const line = title.parentElement
    const block = line.parentElement
    const subsongText = line.querySelector('span')?.textContent?.trim() ?? ''
    const clock = block.children[1]?.textContent?.trim() ?? ''
    const sub = /subsong (\d+) of (\d+)/.exec(subsongText)
    const time = /^(\d+:\d\d) \/ (\d+:\d\d)$/.exec(clock)
    const main = root.querySelector('[aria-label="Pause"], [aria-label="Play"], [aria-label*="Resume"]')
    return {
      title: title.textContent?.trim() ?? '',
      button: main?.getAttribute('aria-label') ?? null,
      position: time ? time[1] : null,
      length: time ? time[2] : null,
      /** Whatever is where the clock goes, so a message shows up in failures. */
      clock,
      subsong: sub ? Number(sub[1]) : 1,
      songs: sub ? Number(sub[2]) : 1
    }
  })

const seconds = (mmss) => {
  if (!mmss) return -1
  const [m, s] = mmss.split(':').map(Number)
  return m * 60 + s
}

/*
 * Not the harness's `until`: that one waits for a yes or a no, and this one
 * reads the bar on every turn, hands the predicate what it read, and answers
 * with the last reading - which is what the checks below go on to quote.
 */
const until = async (what, predicate, timeout = 25000) => {
  const deadline = Date.now() + timeout
  let last = null
  while (Date.now() < deadline) {
    last = await barState()
    if (last && (await predicate(last))) return last
    await page.waitForTimeout(250)
  }
  check(false, `${what} — last saw ${JSON.stringify(last)}`)
  return last
}

/**
 * Plays a row by its title and waits until that tune is really running.
 *
 * `position !== null` is the load: the bar shows "Loading…" where the clock
 * goes until the engine has the tune, so waiting for a clock at all rules
 * out reading the previous tune's position under the new tune's name.
 */
const playRow = async (title) => {
  await library
    .getByRole('row')
    .filter({ hasText: title })
    .first()
    .getByRole('button', { name: /^Play / })
    .click()
  return until(
    `"${title}" starts playing`,
    (s) => s.title.includes(title) && s.position !== null && seconds(s.position) >= 1
  )
}

try {
  await signIn(page)
  await page.getByRole('button', { name: 'Application Switcher' }).click()
  await page.locator('a[href="/sidplayer/library"]').first().click()
  await page.waitForURL(/\/sidplayer\/library/, { timeout: 30000 })
  await library.waitFor({ timeout: 60000 })
  await page.getByRole('button', { name: /^MUSICIANS/ }).waitFor({ timeout: 60000 })

  console.log('\none tune after another, in a folder')
  await page.getByRole('button', { name: 'Expand H' }).click()
  await page.getByRole('button', { name: /^Hubbard_Rob/ }).click()
  await page.getByRole('row').first().waitFor({ timeout: 30000 })

  const a = await playRow('Commando')
  check(!!a && a.position !== null, `Commando plays (${a?.position} / ${a?.length}, songs ${a?.songs})`)

  const b = await playRow('Monty on the Run')
  check(!!b && b.position !== null, `Monty on the Run takes over (${b?.position} / ${b?.length})`)
  check(b?.songs === 3, `and the bar reports its 3 subsongs (saw ${b?.songs})`)
  check(b?.subsong === 1, `starting at subsong 1 (saw ${b?.subsong})`)

  // Back to a one-subsong tune: nothing of the previous tune should linger.
  const c = await playRow('Delta')
  check(!!c && c.position !== null, `Delta takes over (${c?.position} / ${c?.length})`)
  check(c?.songs === 1, `the subsong count follows the new tune (saw ${c?.songs})`)

  console.log('\nadvancing a subsong, then switching away')
  await playRow('Monty on the Run')
  await library.getByRole('button', { name: 'Next subsong' }).click()
  const onTwo = await until('subsong 2 starts', (s) => s.subsong === 2 && seconds(s.position) >= 1)
  check(onTwo?.subsong === 2, `Monty is on subsong 2 (${onTwo?.position})`)
  const back = await playRow('Commando')
  check(back?.subsong === 1, `switching to a single-subsong tune resets to 1 (saw ${back?.subsong})`)
  check(seconds(back?.position) < 20, `and the clock restarts (saw ${back?.position})`)

  console.log('\nthe clock keeps moving after each switch')
  const moved = await until(
    'position advances on the tune switched to',
    async (s) => {
      const first = seconds(s.position)
      await page.waitForTimeout(1500)
      const now = await barState()
      return seconds(now.position) > first
    },
    15000
  )
  check(!!moved, 'the tune switched to is really rendering')

  console.log('\nswitching twice in quick succession')
  const rowPlay = (title) =>
    library
      .getByRole('row')
      .filter({ hasText: title })
      .first()
      .getByRole('button', { name: /^Play / })
      .click()
  await rowPlay('Delta')
  await page.waitForTimeout(120)
  await rowPlay('Commando')
  const raced = await until(
    'the second click wins',
    async (s) => s.title.includes('Commando') && seconds(s.position) >= 1
  )
  check(raced?.title.includes('Commando'), `the tune clicked second is the one playing (saw "${raced?.title}")`)
  check(raced?.button === 'Pause', `and it is playing, not stuck (button says ${raced?.button})`)

  console.log('\nplaying out of search results')
  const search = page.getByRole('searchbox', { name: 'Search the collection' })
  await search.fill('hubbard')
  await page
    .getByText(/Search ·/)
    .first()
    .waitFor({ timeout: 30000 })
  const s1 = await playRow('Delta')
  check(!!s1 && s1.position !== null, `a search result plays (${s1?.position} / ${s1?.length})`)

  await search.fill('galway')
  await page
    .getByText(/Search ·/)
    .first()
    .waitFor({ timeout: 30000 })
  const s2 = await playRow('Wizball')
  check(!!s2 && s2.position !== null, `a second search, a second tune (${s2?.position} / ${s2?.length})`)
  check(s2?.title.includes('Wizball'), `the bar names it (saw "${s2?.title}")`)

  await search.fill('turrican')
  await page
    .getByText(/Search ·/)
    .first()
    .waitFor({ timeout: 30000 })
  const s3 = await playRow('Turrican 2')
  check(!!s3 && s3.position !== null, `and a third (${s3?.position} / ${s3?.length})`)

  const errors = logs.filter((l) => /^\[pageerror\]/.test(l))
  check(errors.length === 0, `no uncaught errors in the page (${errors.length})`)

  await page.screenshot({ path: join(OUT, 'switch-end.png') })
} catch (error) {
  check(false, `threw: ${error.message}`)
  await dump(page, 'switch-error')
} finally {
  await browser.close()
  const interesting = logs.filter((l) => /sidplayer|error|warn/i.test(l)).slice(-20)
  if (interesting.length) console.log(`\nbrowser console (filtered):\n    ${interesting.join('\n    ')}`)
  report()
}
