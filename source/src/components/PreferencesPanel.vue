<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { ChipModel, ClockMode, Prefs, ThemeMode } from '../composables/usePreferences'

/**
 * The per-device settings, as a small popover. Plain elements only: this is
 * mounted both inside the app's route and in the dock, which is a separate
 * Vue app without the design-system components registered.
 */
const { prefs, canChooseTheme } = defineProps<{
  prefs: Prefs
  /** Whether the instance offers both a light and a dark theme. */
  canChooseTheme: boolean
}>()
const emit = defineEmits<{ (e: 'close'): void }>()

const root = ref<HTMLElement | null>(null)

const THEMES: Array<{ value: ThemeMode; label: string; hint: string }> = [
  { value: 'system', label: 'System', hint: 'Follow OpenCloud' },
  { value: 'light', label: 'Light', hint: '' },
  { value: 'dark', label: 'Dark', hint: '' }
]
const CHIPS: Array<{ value: ChipModel; label: string; hint: string }> = [
  { value: 'auto', label: 'As the tune says', hint: '6581 if unknown' },
  { value: '6581', label: 'MOS 6581', hint: 'the original, warmer filter' },
  { value: '8580', label: 'MOS 8580', hint: 'the later chip' }
]
const CLOCKS: Array<{ value: ClockMode; label: string; hint: string }> = [
  { value: 'auto', label: 'As the tune says', hint: 'PAL if unknown' },
  { value: 'pal', label: 'PAL', hint: '985 kHz' },
  { value: 'ntsc', label: 'NTSC', hint: '1023 kHz' }
]

const onDocumentClick = (event: MouseEvent) => {
  if (root.value && !root.value.contains(event.target as Node)) emit('close')
}
/**
 * Escape closes the panel and must go no further: the shell closes the whole
 * app on Escape, and a user dismissing a popover does not mean to leave. The
 * panel takes focus on open so the key arrives here first, in the capture
 * phase, and is stopped.
 */
const onKey = (event: KeyboardEvent) => {
  if (event.key !== 'Escape') return
  if (root.value && !root.value.contains(event.target as Node)) return
  // Immediately, not just onwards: a handler of the shell's on `document`
  // in the same phase would otherwise still run, as LibraryView found.
  event.stopImmediatePropagation()
  event.preventDefault()
  emit('close')
}
let deferred: ReturnType<typeof setTimeout> | undefined
onMounted(() => {
  // Deferred so the click that opened the panel does not also close it.
  deferred = setTimeout(() => document.addEventListener('mousedown', onDocumentClick), 0)
  document.addEventListener('keydown', onKey, true)
  root.value?.querySelector<HTMLElement>('input, button')?.focus()
})
onBeforeUnmount(() => {
  // Cancel first: a panel closed within the same tick it opened would
  // otherwise remove a listener that has not been added yet, and the timer
  // would then add one that nothing is left to take away.
  clearTimeout(deferred)
  document.removeEventListener('mousedown', onDocumentClick)
  document.removeEventListener('keydown', onKey, true)
})

const radioStyle = (active: boolean) => ({
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '6px 10px',
  borderRadius: '6px',
  cursor: 'pointer',
  fontSize: '13px',
  background: active ? 'var(--oc-role-secondary-container)' : 'transparent',
  color: active ? 'var(--oc-role-on-secondary-container)' : 'var(--oc-role-on-surface)'
})
</script>

<template>
  <div
    ref="root"
    role="dialog"
    aria-label="Player preferences"
    class="sidplayer-prefs"
    :style="{
      width: '280px',
      maxHeight: '80vh',
      overflowY: 'auto',
      padding: '12px',
      borderRadius: '10px',
      background: 'var(--oc-role-surface)',
      color: 'var(--oc-role-on-surface)',
      border: '1px solid var(--oc-role-outline-variant)',
      boxShadow: '0 12px 32px rgba(0, 0, 0, 0.18)',
      display: 'flex',
      flexDirection: 'column',
      gap: '14px',
      textAlign: 'left'
    }"
  >
    <fieldset :style="{ border: 0, padding: 0, margin: 0 }">
      <legend
        :style="{
          fontSize: '11px',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          opacity: 0.7,
          padding: 0,
          marginBottom: '6px'
        }"
      >
        Appearance
      </legend>
      <div v-if="canChooseTheme" :style="{ display: 'flex', flexDirection: 'column', gap: '2px' }">
        <label v-for="t in THEMES" :key="t.value" :style="radioStyle(prefs.theme === t.value)">
          <input
            type="radio"
            name="sidplayer-theme"
            :value="t.value"
            :checked="prefs.theme === t.value"
            :style="{ margin: 0, accentColor: 'var(--oc-role-primary)' }"
            @change="prefs.theme = t.value"
          />
          <span :style="{ flex: 1 }">{{ t.label }}</span>
          <span v-if="t.hint" :style="{ fontSize: '11px', opacity: 0.7 }">{{ t.hint }}</span>
        </label>
      </div>
      <p v-else :style="{ margin: 0, fontSize: '12px', opacity: 0.75 }">
        This instance offers one theme, so the player follows it.
      </p>
    </fieldset>

    <fieldset :style="{ border: 0, padding: 0, margin: 0 }">
      <legend
        :style="{
          fontSize: '11px',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          opacity: 0.7,
          padding: 0,
          marginBottom: '6px'
        }"
      >
        Playback
      </legend>
      <label :style="radioStyle(false)">
        <input
          type="checkbox"
          :checked="prefs.analyser"
          :style="{ margin: 0, accentColor: 'var(--oc-role-primary)' }"
          @change="prefs.analyser = ($event.target as HTMLInputElement).checked"
        />
        <span :style="{ flex: 1 }">Spectrum display</span>
      </label>
    </fieldset>

    <fieldset :style="{ border: 0, padding: 0, margin: 0 }">
      <legend
        :style="{
          fontSize: '11px',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          opacity: 0.7,
          padding: 0,
          marginBottom: '6px'
        }"
      >
        Emulation
      </legend>
      <div :style="{ fontSize: '12px', opacity: 0.7, padding: '0 10px 2px' }">SID chip</div>
      <div :style="{ display: 'flex', flexDirection: 'column', gap: '2px' }">
        <label v-for="c in CHIPS" :key="c.value" :style="radioStyle(prefs.chipModel === c.value)">
          <input
            type="radio"
            name="sidplayer-chip"
            :value="c.value"
            :checked="prefs.chipModel === c.value"
            :style="{ margin: 0, accentColor: 'var(--oc-role-primary)' }"
            @change="prefs.chipModel = c.value"
          />
          <span :style="{ flex: 1 }">{{ c.label }}</span>
          <span :style="{ fontSize: '11px', opacity: 0.7 }">{{ c.hint }}</span>
        </label>
      </div>
      <div :style="{ fontSize: '12px', opacity: 0.7, padding: '8px 10px 2px' }">Machine</div>
      <div :style="{ display: 'flex', flexDirection: 'column', gap: '2px' }">
        <label v-for="c in CLOCKS" :key="c.value" :style="radioStyle(prefs.clock === c.value)">
          <input
            type="radio"
            name="sidplayer-clock"
            :value="c.value"
            :checked="prefs.clock === c.value"
            :style="{ margin: 0, accentColor: 'var(--oc-role-primary)' }"
            @change="prefs.clock = c.value"
          />
          <span :style="{ flex: 1 }">{{ c.label }}</span>
          <span :style="{ fontSize: '11px', opacity: 0.7 }">{{ c.hint }}</span>
        </label>
      </div>
      <p :style="{ margin: '6px 10px 0', fontSize: '11px', opacity: 0.6 }">Changing these restarts the tune.</p>
    </fieldset>

    <p :style="{ margin: 0, fontSize: '11px', opacity: 0.6 }">Saved on this device.</p>
  </div>
</template>
