<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watchEffect } from 'vue'
import type { Session } from '../player/session'
import { usePlayerScope } from '../composables/usePlayerScope'
import { formatTime } from '../helpers/format'
import { isBusyState, progressOf } from '../components/transport'
import PreferencesPanel from '../components/PreferencesPanel.vue'

/**
 * The player as a bar across the bottom of the shell, shown while a tune is
 * loaded and the full view is not open.
 *
 * This runs as its own Vue app mounted outside the route tree, so nothing
 * here may rely on components the shell registers globally (oc-button,
 * oc-icon): plain elements and inline SVG throughout. Layout is inline
 * style, as everywhere in this app, because the shell ships no utility CSS
 * an app can count on. Colours are the shell's design tokens, which also
 * lets the session re-theme this root on its own.
 */
const { session } = defineProps<{ session: Session }>()

const root = ref<HTMLElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const prefsOpen = ref(false)

const { prefs, player } = session
const visible = computed(() => session.dockVisible.value)
const showScope = computed(() => prefs.analyser && session.config.analyserEnabled)
const playing = computed(() => player.state.value === 'playing')
const busy = computed(() => session.loading.value || isBusyState(player.state.value))
const status = computed(() => {
  if (session.error.value) return session.error.value.message
  if (session.loading.value) return 'Loading…'
  switch (player.state.value) {
    case 'resume':
      return 'Tap play to start'
    case 'failed':
      return player.error.value?.message ?? 'The tune could not be played.'
    default:
      return ''
  }
})
const detail = computed(() => {
  const h = session.header.value
  if (!h) return ''
  return [h.author, h.released].filter(Boolean).join(' · ')
})
const progress = computed(() => progressOf(player.position.value, player.length.value))
const HEIGHT_BAR = 64
const HEIGHT_SCOPE = 44
const height = computed(() => HEIGHT_BAR + (showScope.value ? HEIGHT_SCOPE : 0))

/* ---- spectrum -------------------------------------------------------------- */
usePlayerScope(session, canvas, () => showScope.value && visible.value)

/* ---- make room: the shell's root is 100dvh; shorten it by the dock's height ---- */
const web = () => document.getElementById('web')
let warned = false
watchEffect(() => {
  const el = web()
  if (!el) {
    /*
     * A shell without the root this expects - renamed in an upgrade, say -
     * would leave the dock silently covering the bottom of every page. Room
     * is made on the body instead, which lets the page scroll clear of it,
     * and the reason is said once so it is not a mystery.
     */
    if (visible.value && !warned) {
      warned = true
      console.warn('[sidplayer] the shell has no #web root to shorten; making room on the page body instead')
    }
    document.body.style.paddingBottom = visible.value ? `${height.value}px` : ''
    return
  }
  if (visible.value) {
    el.style.height = `calc(100dvh - ${height.value}px)`
    el.style.maxHeight = el.style.height
  } else {
    el.style.removeProperty('height')
    el.style.removeProperty('max-height')
  }
})

onMounted(() => {
  if (root.value) session.registerThemeRoot(root.value)
})
onBeforeUnmount(() => {
  if (root.value) session.unregisterThemeRoot(root.value)
  const el = web()
  el?.style.removeProperty('height')
  el?.style.removeProperty('max-height')
  document.body.style.removeProperty('padding-bottom')
})

const onSlider = (v: number) => {
  if (prefs.muted) session.setMuted(false)
  session.setVolume(v)
}

const btn = (active = true) => ({
  width: '36px',
  height: '36px',
  border: 0,
  borderRadius: '6px',
  background: 'transparent',
  color: active ? 'var(--oc-role-on-surface)' : 'var(--oc-role-on-surface-variant)',
  display: 'grid',
  placeItems: 'center',
  cursor: 'pointer',
  padding: 0
})
</script>

<template>
  <div
    v-show="visible"
    ref="root"
    class="sidplayer-dock"
    role="region"
    aria-label="Now playing"
    :style="{
      position: 'fixed',
      left: 0,
      right: 0,
      bottom: 0,
      height: `${height}px`,
      zIndex: 30,
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--oc-role-surface-container)',
      color: 'var(--oc-role-on-surface)',
      borderTop: '1px solid var(--oc-role-outline-variant)',
      boxShadow: '0 -8px 24px rgba(0, 0, 0, 0.10)',
      fontFamily: 'inherit',
      fontSize: '14px'
    }"
  >
    <div
      v-if="showScope"
      :style="{
        height: `${HEIGHT_SCOPE}px`,
        padding: '6px 18px 0',
        borderBottom: '1px solid var(--oc-role-outline-variant)'
      }"
    >
      <canvas
        ref="canvas"
        aria-hidden="true"
        :style="{ display: 'block', width: '100%', height: `${HEIGHT_SCOPE - 8}px` }"
      />
    </div>

    <div
      role="progressbar"
      :aria-valuenow="Math.round(progress * 100)"
      aria-valuemin="0"
      aria-valuemax="100"
      :style="{ height: '3px', background: 'var(--oc-role-surface-container-highest)', flex: 'none' }"
    >
      <div
        :style="{
          height: '100%',
          width: `${progress * 100}%`,
          background: 'var(--oc-role-primary)',
          transition: 'width 0.25s linear'
        }"
      />
    </div>

    <div
      :style="{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', gap: '12px', padding: '0 18px' }"
    >
      <div :style="{ display: 'flex', alignItems: 'center', gap: '2px' }">
        <!--
          The tunes either side of this one in the list it came from, outside
          the subsong arrows, which is the order the full view uses: the file
          in the middle, its subsongs either side, the list at both ends. Two
          triangles against the bar rather than one, because these are the
          buttons that leave the file. Absent rather than disabled when the
          tune was started from the file browser, which has no running order
          behind it.
        -->
        <button
          v-if="session.canNextTune.value || session.canPreviousTune.value"
          type="button"
          aria-label="Previous tune in the list"
          title="Previous tune in the list"
          :disabled="busy || !session.canPreviousTune.value"
          :style="{ ...btn(session.canPreviousTune.value), opacity: session.canPreviousTune.value ? 1 : 0.45 }"
          @click="session.previousTune"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M3 5h2v14H3z" />
            <path d="M13 5 6.5 12 13 19z" />
            <path d="M21 5 14.5 12 21 19z" />
          </svg>
        </button>
        <button
          type="button"
          aria-label="Previous subsong"
          title="Previous subsong"
          :disabled="busy || !player.canPrevious.value"
          :style="{ ...btn(player.canPrevious.value), opacity: player.canPrevious.value ? 1 : 0.45 }"
          @click="player.previous"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M6 5h2v14H6z" />
            <path d="M19 5 8.5 12 19 19z" />
          </svg>
        </button>
        <button
          type="button"
          :aria-label="playing ? 'Pause' : 'Play'"
          :title="playing ? 'Pause' : 'Play'"
          :disabled="busy"
          :style="{
            width: '40px',
            height: '40px',
            borderRadius: '50%',
            border: 0,
            flex: 'none',
            display: 'grid',
            placeItems: 'center',
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.5 : 1,
            background: 'var(--oc-role-primary)',
            color: 'var(--oc-role-on-primary)',
            padding: 0
          }"
          @click="player.toggle"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <template v-if="playing">
              <path d="M6 5h4v14H6z" />
              <path d="M14 5h4v14h-4z" />
            </template>
            <path v-else d="M8 5.2v13.6L19 12z" />
          </svg>
        </button>
        <button
          type="button"
          aria-label="Next subsong"
          title="Next subsong"
          :disabled="busy || !player.canNext.value"
          :style="{ ...btn(player.canNext.value), opacity: player.canNext.value ? 1 : 0.45 }"
          @click="player.next"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M16 5h2v14h-2z" />
            <path d="M5 5l10.5 7L5 19z" />
          </svg>
        </button>
        <button
          v-if="session.canNextTune.value || session.canPreviousTune.value"
          type="button"
          aria-label="Next tune in the list"
          title="Next tune in the list"
          :disabled="busy || !session.canNextTune.value"
          :style="{ ...btn(session.canNextTune.value), opacity: session.canNextTune.value ? 1 : 0.45 }"
          @click="session.nextTune"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M19 5h2v14h-2z" />
            <path d="M3 5l6.5 7L3 19z" />
            <path d="M11 5l6.5 7L11 19z" />
          </svg>
        </button>
      </div>

      <div :style="{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: '0 1 420px' }">
        <div :style="{ display: 'flex', alignItems: 'baseline', gap: '8px', minWidth: 0 }">
          <b :style="{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }">{{
            session.title.value
          }}</b>
          <span
            v-if="player.songCount.value > 1"
            :style="{ fontSize: '12px', color: 'var(--oc-role-on-surface-variant)', whiteSpace: 'nowrap' }"
          >
            subsong {{ player.subsong.value }} of {{ player.songCount.value }}
          </span>
        </div>
        <div
          :style="{
            fontSize: '12px',
            color:
              status && (session.error.value || player.state.value === 'failed')
                ? 'var(--oc-role-error)'
                : 'var(--oc-role-on-surface-variant)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            fontVariantNumeric: 'tabular-nums'
          }"
        >
          <template v-if="status">{{ status }}</template>
          <template v-else
            >{{ detail ? `${detail} · ` : '' }}{{ formatTime(player.position.value) }} /
            {{ formatTime(player.length.value) }}</template
          >
        </div>
      </div>

      <div :style="{ flex: 1 }" />

      <div :style="{ display: 'flex', alignItems: 'center', gap: '4px', position: 'relative' }">
        <button
          type="button"
          :aria-label="prefs.analyser ? 'Hide spectrum' : 'Show spectrum'"
          :title="prefs.analyser ? 'Hide spectrum' : 'Show spectrum'"
          :aria-pressed="prefs.analyser"
          :style="{
            ...btn(prefs.analyser),
            color: prefs.analyser ? 'var(--oc-role-primary)' : 'var(--oc-role-on-surface-variant)'
          }"
          @click="prefs.analyser = !prefs.analyser"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="3" y="12" width="3" height="8" rx="1" />
            <rect x="8.5" y="6" width="3" height="14" rx="1" />
            <rect x="14" y="9" width="3" height="11" rx="1" />
            <rect x="19.5" y="14" width="2" height="6" rx="1" />
          </svg>
        </button>
        <button
          type="button"
          :aria-label="prefs.muted ? 'Unmute' : 'Mute'"
          :title="prefs.muted ? 'Unmute' : 'Mute'"
          :style="btn()"
          @click="session.setMuted(!prefs.muted)"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M4 9h3.5L12 5v14l-4.5-4H4z" />
            <path v-if="!prefs.muted" d="M15 9.2a4 4 0 010 5.6l1.4 1.4a6 6 0 000-8.4z" />
            <path v-else d="m16 9 5 5m0-5-5 5" stroke="currentColor" stroke-width="2" fill="none" />
          </svg>
        </button>
        <input
          type="range"
          min="0"
          max="100"
          :value="Math.round((prefs.muted ? 0 : prefs.volume) * 100)"
          aria-label="Volume"
          :style="{ width: '88px', accentColor: 'var(--oc-role-primary)' }"
          @input="onSlider(Number(($event.target as HTMLInputElement).value) / 100)"
        />

        <span
          :style="{
            width: '1px',
            height: '24px',
            background: 'var(--oc-role-outline-variant)',
            margin: '0 6px'
          }"
        />

        <button
          type="button"
          aria-label="Open in SID Player"
          title="Open in SID Player"
          :style="btn()"
          @click="session.openFullView()"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M15 3h6v6" />
            <path d="m21 3-7 7" />
            <path d="M9 21H3v-6" />
            <path d="m3 21 7-7" />
          </svg>
        </button>
        <button
          type="button"
          aria-label="Preferences"
          title="Preferences"
          :aria-expanded="prefsOpen"
          :style="btn()"
          @mousedown.stop
          @click="prefsOpen = !prefsOpen"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3" />
            <path
              d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"
            />
          </svg>
        </button>
        <button
          type="button"
          aria-label="Stop and close"
          title="Stop and close"
          :style="btn(false)"
          @click="session.stop"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>

        <div v-if="prefsOpen" :style="{ position: 'absolute', right: 0, bottom: '44px' }">
          <preferences-panel
            :prefs="prefs"
            :can-choose-theme="session.canChooseTheme.value"
            @close="prefsOpen = false"
          />
        </div>
      </div>
    </div>
  </div>
</template>
