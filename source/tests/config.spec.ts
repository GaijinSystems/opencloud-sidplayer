import { describe, it, expect } from 'vitest'
import { readConfig } from '../src/config'
import defaults from '../src/defaults.json'

describe('readConfig', () => {
  it('returns the shipped defaults for no input', () => {
    expect(readConfig()).toEqual(defaults)
    expect(readConfig(null)).toEqual(defaults)
  })

  it('clamps numbers and ignores garbage', () => {
    const c = readConfig({ maxFileSizeKb: 1, defaultSongLengthSeconds: 'soon', autoPlay: 'yes' })
    expect(c.maxFileSizeKb).toBe(8)
    expect(c.defaultSongLengthSeconds).toBe(defaults.defaultSongLengthSeconds)
    expect(c.autoPlay).toBe(defaults.autoPlay)
  })

  it('accepts overrides in range', () => {
    const c = readConfig({
      defaultSongLengthSeconds: 240,
      registerAsDefault: false,
      engineBaseUrl: ' https://cdn.example/sid/ '
    })
    expect(c.defaultSongLengthSeconds).toBe(240)
    expect(c.registerAsDefault).toBe(false)
    expect(c.engineBaseUrl).toBe('https://cdn.example/sid/')
  })

  /*
   * A path that starts `//` is a host, not a path: `//mirror` in
   * hvscMirrorPath would have sent every mirror request to a machine called
   * "mirror". And a URL setting is somewhere to fetch from, so a scheme that
   * is not one - `javascript:`, `data:` - is refused rather than handed to
   * the worklet loader.
   */
  it('refuses a path that names a host, and a URL that is not one to fetch from', () => {
    expect(readConfig({ hvscMirrorPath: '//mirror' }).hvscMirrorPath).toBe(defaults.hvscMirrorPath)
    expect(readConfig({ hvscPath: '//elsewhere/SID' }).hvscPath).toBe(defaults.hvscPath)
    expect(readConfig({ engineBaseUrl: 'javascript:alert(1)' }).engineBaseUrl).toBeNull()
    expect(readConfig({ engineBaseUrl: 'data:text/javascript,1' }).engineBaseUrl).toBeNull()
    expect(readConfig({ assetBaseUrl: '//cdn.example/' }).assetBaseUrl).toBeNull()
    // What is meant still gets through.
    expect(readConfig({ engineBaseUrl: '/static/sid/' }).engineBaseUrl).toBe('/static/sid/')
    expect(readConfig({ songlengthsUrl: 'http://hvsc.local/Songlengths.md5' }).songlengthsUrl).toBe(
      'http://hvsc.local/Songlengths.md5'
    )
  })

  // A URL parser drops tabs and newlines before reading anything, so these
  // pass a check on the string as written and are then fetched as `//host`
  // and `javascript:`.
  it('refuses a path or URL with a control character in it', () => {
    expect(readConfig({ hvscMirrorPath: '/\t/mirror' }).hvscMirrorPath).toBe(defaults.hvscMirrorPath)
    // Relative, it would be fetched against whichever page the app is on.
    expect(readConfig({ hvscMirrorPath: 'mirror/' }).hvscMirrorPath).toBe('/mirror')
    expect(readConfig({ hvscPath: 'SID' }).hvscPath).toBe('/SID')
    // `/\host` is `//host` to a browser.
    expect(readConfig({ hvscMirrorPath: '\\evil.example' }).hvscMirrorPath).toBe(defaults.hvscMirrorPath)
    expect(readConfig({ assetBaseUrl: '/\n/cdn.example/' }).assetBaseUrl).toBeNull()
    expect(readConfig({ engineBaseUrl: 'java\tscript:alert(1)' }).engineBaseUrl).toBeNull()
  })

  it('treats empty URL overrides as absent', () => {
    expect(readConfig({ assetBaseUrl: '' }).assetBaseUrl).toBeNull()
    expect(readConfig({ engineBaseUrl: 42 }).engineBaseUrl).toBeNull()
  })
})
