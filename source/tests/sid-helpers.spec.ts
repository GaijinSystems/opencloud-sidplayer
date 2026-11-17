import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  appAssetBase,
  resolveEngineUrl,
  resolveVendorAssetUrl,
  setAssetBaseUrl,
  setBuildTag
} from '../src/helpers/assetUrl'
import { TimeoutError, withTimeout } from '../src/helpers/async'
import { applyThemeTo, canChooseTheme, kebab, pickTheme, themeVars, type ThemeLike } from '../src/helpers/theme'

describe('asset URLs', () => {
  afterEach(() => {
    setAssetBaseUrl(null)
    setBuildTag(null)
  })

  it('uses an administrator’s base outright, with or without its trailing slash', () => {
    setAssetBaseUrl('https://cdn.example.invalid/sidplayer')
    expect(appAssetBase()).toBe('https://cdn.example.invalid/sidplayer/')
    expect(resolveVendorAssetUrl('sid-engine/engine.js')).toBe(
      'https://cdn.example.invalid/sidplayer/vendor/sid-engine/engine.js'
    )
  })

  it('ignores an empty or blank override, since that is not a base', () => {
    const fromModule = appAssetBase()
    setAssetBaseUrl('   ')
    expect(appAssetBase()).toBe(fromModule)
    setAssetBaseUrl(undefined)
    expect(appAssetBase()).toBe(fromModule)
  })

  it('never lets a leading slash in a vendor path reach the site root', () => {
    setAssetBaseUrl('https://host.invalid/apps/sidplayer/')
    expect(resolveVendorAssetUrl('/sid-engine/engine.json')).toBe(
      'https://host.invalid/apps/sidplayer/vendor/sid-engine/engine.json'
    )
  })

  it('names a directory for the engine, not either file in it', () => {
    // The processor statically imports ./engine.js, so both files must come
    // from the same directory whatever the override says.
    expect(resolveEngineUrl('https://host.invalid/engine', 'engine.json')).toBe(
      'https://host.invalid/engine/engine.json'
    )
    setAssetBaseUrl('https://host.invalid/apps/sidplayer/')
    expect(resolveEngineUrl(null, 'sid-processor.js')).toBe(
      'https://host.invalid/apps/sidplayer/vendor/sid-engine/sid-processor.js'
    )
  })

  /*
   * A path on this server is a reasonable thing for an admin to write, and
   * `new URL` refuses one without a base: the tune failed with "could not be
   * loaded" and nothing about why. Both are taken against the page instead.
   */
  it('takes a path on this server for either override', () => {
    const page = document.baseURI
    expect(resolveEngineUrl('/static/sid', 'engine.json')).toBe(new URL('/static/sid/engine.json', page).href)
    setAssetBaseUrl('/apps/sidplayer')
    expect(resolveVendorAssetUrl('sid-engine/engine.json')).toBe(
      new URL('/apps/sidplayer/vendor/sid-engine/engine.json', page).href
    )
  })

  /*
   * The engine files keep fixed names and are overwritten in place on an
   * upgrade, while the app's own chunk is content-hashed. Without a stamp a
   * browser can pair a cached processor with a freshly fetched wasm, and an
   * old processor never reports the end of a MUS tune.
   */
  it('stamps the engine URLs with the build tag, and nothing else', () => {
    setAssetBaseUrl('https://host.invalid/apps/sidplayer/')
    setBuildTag('1.1.0')
    expect(resolveEngineUrl(null, 'engine.json')).toBe(
      'https://host.invalid/apps/sidplayer/vendor/sid-engine/engine.json?v=1.1.0'
    )
    expect(resolveEngineUrl('https://cdn.invalid/e/', 'engine.wasm')).toBe(
      'https://cdn.invalid/e/engine.wasm?v=1.1.0'
    )
    expect(resolveVendorAssetUrl('sid-engine/engine.json')).toBe(
      'https://host.invalid/apps/sidplayer/vendor/sid-engine/engine.json'
    )
  })

  it('leaves the URLs alone outside a packaged build, where there is no tag', () => {
    setAssetBaseUrl('https://host.invalid/apps/sidplayer/')
    setBuildTag('   ')
    expect(resolveEngineUrl(null, 'engine.json')).toBe(
      'https://host.invalid/apps/sidplayer/vendor/sid-engine/engine.json'
    )
  })
})

describe('withTimeout', () => {
  afterEach(() => vi.useRealTimers())

  it('passes a value through and leaves no timer behind', async () => {
    vi.useFakeTimers()
    await expect(withTimeout(Promise.resolve(7), 1000, 'the engine')).resolves.toBe(7)
    // The timer is cleared, so a resolved call cannot hold the process open.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('passes a rejection through as it is', async () => {
    await expect(withTimeout(Promise.reject(new Error('worklet died')), 1000, 'x')).rejects.toThrowError(
      /worklet died/
    )
  })

  /*
   * The case this exists for: a dead worklet does not reject, it simply never
   * settles, and without a budget the UI sits on a spinner with nothing in the
   * console. A CSP without 'wasm-unsafe-eval' produces exactly that.
   */
  it('rejects with the label and the budget when nothing settles', async () => {
    vi.useFakeTimers()
    const pending = withTimeout(new Promise<number>(() => {}), 250, 'the engine')
    const caught: Promise<unknown> = pending.catch((e) => e)
    await vi.advanceTimersByTimeAsync(250)
    const failure = await caught
    expect(failure).toBeInstanceOf(TimeoutError)
    expect((failure as TimeoutError).ms).toBe(250)
    expect((failure as TimeoutError).message).toBe('the engine did not respond within 250ms')
  })
})

describe('themes', () => {
  const theme = (roles: Record<string, string>, isDark = false): ThemeLike => ({
    isDark,
    designTokens: { roles }
  })

  it('writes each role as the custom property the shell would', () => {
    expect(kebab('onSurfaceVariant')).toBe('on-surface-variant')
    expect(themeVars(theme({ onSurfaceVariant: '#123456' }))).toEqual({
      '--oc-role-on-surface-variant': '#123456'
    })
  })

  it('fills chrome from the surface container, as the shell does', () => {
    const vars = themeVars(theme({ surfaceContainer: '#eee', onSurface: '#111' }))
    expect(vars['--oc-role-chrome']).toBe('#eee')
    expect(vars['--oc-role-on-chrome']).toBe('#111')
  })

  it('fills the page colours too, because this goes below :root', () => {
    // An omitted role one level below :root would inherit the other theme's
    // value, which is how a light app on a dark shell used to show black text
    // on black.
    const vars = themeVars(theme({ surface: '#fff', onSurface: '#000' }))
    expect(vars['--oc-role-background']).toBe('#fff')
    expect(vars['--oc-role-on-background']).toBe('#000')
  })

  it('leaves a named role alone rather than deriving over it', () => {
    const vars = themeVars(
      theme({ chrome: '#abc', surfaceContainer: '#eee', background: '#fff', surface: '#f0f0f0' })
    )
    expect(vars['--oc-role-chrome']).toBe('#abc')
    expect(vars['--oc-role-background']).toBe('#fff')
  })

  it('offers a choice only when there is one of each', () => {
    const light = theme({}, false)
    const dark = theme({}, true)
    expect(canChooseTheme([light, dark])).toBe(true)
    expect(canChooseTheme([light, light])).toBe(false)
    expect(pickTheme([light, dark], 'dark')).toBe(dark)
    expect(pickTheme([light], 'dark')).toBeUndefined()
  })

  it('clears only the properties it set last time', () => {
    const el = document.createElement('div')
    el.style.setProperty('--oc-role-surface', 'someone else’s')
    const first = applyThemeTo(el, theme({ surface: '#fff' }))
    expect(el.style.getPropertyValue('--oc-role-surface')).toBe('#fff')

    const second = applyThemeTo(el, theme({ chrome: '#000' }), first)
    expect(second).toEqual(['--oc-role-chrome'])
    expect(el.style.getPropertyValue('--oc-role-surface')).toBe('')
    expect(el.style.getPropertyValue('--oc-role-chrome')).toBe('#000')

    // Null means follow the shell: everything this put there comes off.
    expect(applyThemeTo(el, null, second)).toEqual([])
    expect(el.style.getPropertyValue('--oc-role-chrome')).toBe('')
    expect(el.style.length).toBe(0)
  })
})
