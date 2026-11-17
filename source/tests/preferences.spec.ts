import { describe, it, expect, beforeEach } from 'vitest'
import { usePreferences } from '../src/composables/usePreferences'

describe('usePreferences', () => {
  beforeEach(() => localStorage.clear())

  it('starts from defaults when nothing is stored', () => {
    const { prefs } = usePreferences()
    expect(prefs.volume).toBe(0.8)
    expect(prefs.theme).toBe('system')
    expect(prefs.chipModel).toBe('auto')
  })

  // Kept under the app's earlier name until the first change saves them under the new one.
  it('reads preferences saved under the earlier name', () => {
    localStorage.setItem('sidplay.prefs', JSON.stringify({ volume: 0.3, theme: 'dark' }))
    const { prefs } = usePreferences()
    expect(prefs.volume).toBe(0.3)
    expect(prefs.theme).toBe('dark')
  })

  it('validates what it reads back', () => {
    localStorage.setItem(
      'sidplayer.prefs',
      JSON.stringify({ volume: 7, muted: 'yes', clock: 'sideways', theme: 'dark', details: true, bogus: 1 })
    )
    const { prefs } = usePreferences()
    expect(prefs.volume).toBe(1)
    expect(prefs.muted).toBe(false)
    expect(prefs.clock).toBe('auto')
    expect(prefs.theme).toBe('dark')
    expect(prefs.details).toBe(true)
    expect('bogus' in prefs).toBe(false)
  })

  it('keeps a deliberate zero volume', () => {
    localStorage.setItem('sidplayer.prefs', JSON.stringify({ volume: 0 }))
    expect(usePreferences().prefs.volume).toBe(0)
  })

  it('persists on flush', () => {
    const { prefs, save } = usePreferences()
    prefs.volume = 0.25
    prefs.chipModel = '8580'
    save()
    const stored = JSON.parse(localStorage.getItem('sidplayer.prefs') ?? '{}')
    expect(stored.volume).toBe(0.25)
    expect(stored.chipModel).toBe('8580')
  })

  /*
   * The repeat setting was removed along with the loop modes; a stored one
   * from an older version must not reappear as a property nothing reads.
   */
  it('drops a repeat setting left behind by an older version', () => {
    localStorage.setItem('sidplayer.prefs', JSON.stringify({ volume: 0.5, loop: 'all' }))
    expect('loop' in usePreferences().prefs).toBe(false)
  })
})
