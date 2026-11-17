import { reactive, watch } from 'vue'

export type ThemeMode = 'light' | 'dark' | 'system'
/** 'auto' follows the tune's header; the others override it. */
export type ChipModel = 'auto' | '6581' | '8580'
export type ClockMode = 'auto' | 'pal' | 'ntsc'

export interface Prefs {
  volume: number
  muted: boolean
  analyser: boolean
  theme: ThemeMode
  /** Show the header's technical fields (addresses, clock, chip model). */
  details: boolean
  chipModel: ChipModel
  clock: ClockMode
}

const KEY = 'sidplayer.prefs'
/** Where they were kept under the app's earlier name, read once if the new key has nothing. */
const LEGACY_KEY = 'sidplay.prefs'

const defaults = (): Prefs => ({
  volume: 0.8,
  muted: false,
  analyser: true,
  theme: 'system',
  details: false,
  chipModel: 'auto',
  clock: 'auto'
})

const CHIPS: readonly ChipModel[] = ['auto', '6581', '8580']
const CLOCKS: readonly ClockMode[] = ['auto', 'pal', 'ntsc']

const THEMES: readonly ThemeMode[] = ['light', 'dark', 'system']

/**
 * Per-device preferences in local storage. Nothing from storage is trusted
 * as-is: enums are checked, numbers are clamped, and keys this version does
 * not know are dropped. A stored 0 volume is a choice and survives;
 * `|| default` would turn it back into 0.8 on every reload.
 */
export const usePreferences = () => {
  const prefs = reactive<Prefs>(defaults())

  const load = () => {
    try {
      const raw = localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY)
      if (!raw) return
      const stored = JSON.parse(raw) as Partial<Prefs>
      const d = defaults()
      const v = Number(stored.volume)
      prefs.volume = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d.volume
      prefs.muted = stored.muted === true
      prefs.analyser = typeof stored.analyser === 'boolean' ? stored.analyser : d.analyser
      prefs.theme = THEMES.includes(stored.theme as ThemeMode) ? (stored.theme as ThemeMode) : d.theme
      prefs.details = typeof stored.details === 'boolean' ? stored.details : d.details
      prefs.chipModel = CHIPS.includes(stored.chipModel as ChipModel)
        ? (stored.chipModel as ChipModel)
        : d.chipModel
      prefs.clock = CLOCKS.includes(stored.clock as ClockMode) ? (stored.clock as ClockMode) : d.clock
    } catch (e) {
      console.warn('[sidplayer] stored preferences could not be read; using defaults', e)
    }
  }

  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs))
    } catch (e) {
      console.warn('[sidplayer] preferences could not be saved on this device', e)
    }
  }

  load()

  // The volume slider changes prefs dozens of times a second and localStorage
  // writes are synchronous. Coalesce, and flush on leave.
  let pending: ReturnType<typeof setTimeout> | undefined
  const saveSoon = () => {
    clearTimeout(pending)
    pending = setTimeout(save, 300)
  }
  watch(prefs, saveSoon, { deep: true })
  const flush = () => {
    clearTimeout(pending)
    save()
  }
  if (typeof window !== 'undefined') window.addEventListener('pagehide', flush)
  const destroy = () => {
    flush()
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', flush)
  }

  return { prefs, save: flush, destroy }
}
