<script setup lang="ts">
import { computed, ref } from 'vue'
import type { PlayerState } from '../composables/useSidPlayer'
import { usePlayerScope } from '../composables/usePlayerScope'
import type { Session } from '../player/session'
import { formatTime } from '../helpers/format'
import { isBusyState, progressOf } from './transport'
import PreferencesPanel from './PreferencesPanel.vue'

/**
 * The player's controls across the bottom of the full view and the library.
 *
 * Bound to the session itself, as the dock is, rather than to a dozen props
 * and events each host wired the same way. That also keeps the position -
 * four updates a second - inside this component: passed down as a prop, it
 * re-rendered the whole of whichever view held the bar.
 */
const props = withDefaults(
  defineProps<{
    session: Session
    /** What to call the tune; the session's own name for it where not given. */
    title?: string
    /** Overrides the player's state; the library shows a loading tune as loading. */
    state?: PlayerState
    /**
     * Whether the host handles the keys these tooltips name. The full view
     * does; the library mounts the same bar with no keydown handler at all,
     * and a tooltip promising Space or (m) there is simply untrue.
     */
    shortcuts?: boolean
    /**
     * Whether to offer the ✕ that stops the tune, as the dock does. The
     * library turns it on while a tune is loaded; the full view has the
     * shell's own close at the top and needs no second one.
     */
    closable?: boolean
  }>(),
  { title: undefined, state: undefined, shortcuts: true, closable: false }
)

const { session } = props
const { player, prefs, config } = session

const shownState = computed(() => props.state ?? player.state.value)
const shownTitle = computed(() => props.title ?? session.title.value)
// The session's own refs, which a template unwraps as it does a prop.
const { subsong, songCount, position, length, mutedVoices } = player
const { canNextTune, canPreviousTune, canChooseTheme } = session
/**
 * Whether there is a tune at all. The library draws this bar from the moment
 * it opens, and with nothing loaded the length falls back to the default, so
 * the bar read `0:00 / 3:00` for a tune that did not exist.
 */
const hasTune = computed(() => !!session.current.value)
const showScope = computed(() => config.analyserEnabled && prefs.analyser)

const canvas = ref<HTMLCanvasElement | null>(null)
const prefsOpen = ref(false)
usePlayerScope(session, canvas, () => showScope.value)

const playing = computed(() => shownState.value === 'playing')
const busy = computed(() => isBusyState(shownState.value))
/** A key hint, or nothing where the key does nothing. */
const key = (hint: string) => (props.shortcuts ? ` (${hint})` : '')
const mainLabel = computed(() => (playing.value ? 'Pause' : 'Play'))
const status = computed(() => {
  switch (shownState.value) {
    case 'loading':
      return 'Loading…'
    case 'resume':
      return 'Tap play to start — the browser needs a gesture before it will make sound'
    case 'failed':
      // The panel above already carries the full message; repeating it here
      // in red read as a second, different failure.
      return 'Not playing'
    default:
      return ''
  }
})
const progress = computed(() => progressOf(position.value, length.value))

/**
 * Muting parks the slider at zero without touching the stored level, so
 * unmuting returns to exactly where it was. Moving the slider is a statement
 * about how loud you want it, which only makes sense unmuted.
 */
const onSlider = (v: number) => {
  if (prefs.muted) session.setMuted(false)
  session.setVolume(v)
}
</script>

<template>
  <div
    :style="{
      flex: 'none',
      borderTop: '1px solid var(--oc-role-outline-variant)',
      background: 'var(--oc-role-surface-container)'
    }"
  >
    <div
      v-if="showScope"
      :style="{
        height: '72px',
        padding: '10px 18px 0',
        borderBottom: '1px solid var(--oc-role-outline-variant)'
      }"
    >
      <canvas ref="canvas" aria-hidden="true" :style="{ display: 'block', width: '100%', height: '62px' }" />
    </div>

    <!-- Position bar. Not seekable: a SID is emulated forward from init, so
         seeking means re-rendering from the start. Left as a later feature. -->
    <!-- With no tune there is no position to report: the track stays, so the
         bar does not jump when one loads, but says and fills nothing. -->
    <div
      :role="hasTune ? 'progressbar' : undefined"
      :aria-valuenow="hasTune ? Math.round(progress * 100) : undefined"
      :aria-valuemin="hasTune ? 0 : undefined"
      :aria-valuemax="hasTune ? 100 : undefined"
      :aria-valuetext="hasTune ? `${formatTime(position)} of ${formatTime(length)}` : undefined"
      :aria-hidden="hasTune ? undefined : 'true'"
      :style="{ height: '3px', background: 'var(--oc-role-surface-container-highest)' }"
    >
      <div
        v-if="hasTune"
        :style="{
          height: '100%',
          width: `${progress * 100}%`,
          background: 'var(--oc-role-primary)',
          transition: 'width 0.25s linear'
        }"
      />
    </div>

    <div
      :style="{
        minHeight: '60px',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '8px 18px',
        flexWrap: 'wrap'
      }"
    >
      <div :style="{ display: 'flex', alignItems: 'center', gap: '4px' }">
        <!--
          Six controls, reading outward from the middle: the file you are on
          in the centre, the subsongs inside it either side of that, and the
          list it came from at both ends.

          One family of glyphs for all four arrows, each a bar with triangles
          against it, and the count says how far the button moves: one
          triangle steps within the file, two step off it to the next. That is
          the transport idiom every other player uses, and with the pairs
          placed symmetrically nothing else has to be drawn between them.

          They are absent, not merely disabled, when a tune was started from
          somewhere with no list behind it - the Files browser - because there
          is then no running order to move along.
        -->
        <oc-button
          v-if="canNextTune || canPreviousTune"
          appearance="raw"
          aria-label="Previous tune in the list"
          :title="`Previous tune in the list${key('Page up')}`"
          :disabled="busy || !canPreviousTune"
          @click="session.previousTune()"
        >
          <oc-icon name="rewind-start" />
        </oc-button>

        <oc-button
          appearance="raw"
          aria-label="Previous subsong"
          :title="`Previous subsong${key('Left arrow')}`"
          :disabled="busy || subsong <= 1"
          @click="player.previous()"
        >
          <oc-icon name="skip-back" />
        </oc-button>

        <!--
          Start again, on a circular arrow. It is not a navigation control:
          it takes the subsong you are on back to nought, and any arrow at
          all would read as a move to somewhere else.
        -->
        <oc-button
          appearance="raw"
          aria-label="Start this subsong again"
          :title="`Start this subsong again${key('Home')}`"
          :disabled="busy"
          @click="player.restart()"
        >
          <oc-icon name="restart" />
        </oc-button>

        <button
          type="button"
          :aria-label="mainLabel"
          :title="`${mainLabel}${key('Space')}`"
          :disabled="busy"
          :style="{
            width: '40px',
            height: '40px',
            borderRadius: '50%',
            flex: 'none',
            display: 'grid',
            placeItems: 'center',
            border: 0,
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.5 : 1,
            background: 'var(--oc-role-primary)',
            color: 'var(--oc-role-on-primary)'
          }"
          @click="player.toggle()"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <template v-if="playing">
              <path d="M6 5h4v14H6z" />
              <path d="M14 5h4v14h-4z" />
            </template>
            <path v-else d="M8 5.2v13.6L19 12z" />
          </svg>
        </button>

        <oc-button
          appearance="raw"
          aria-label="Next subsong"
          :title="`Next subsong${key('Right arrow')}`"
          :disabled="busy || subsong >= songCount"
          @click="player.next()"
        >
          <oc-icon name="skip-forward" />
        </oc-button>

        <oc-button
          v-if="canNextTune || canPreviousTune"
          appearance="raw"
          aria-label="Next tune in the list"
          :title="`Next tune in the list${key('Page down')}`"
          :disabled="busy || !canNextTune"
          @click="session.nextTune()"
        >
          <oc-icon name="forward-end" />
        </oc-button>
      </div>

      <div :style="{ flex: 1, minWidth: '160px' }">
        <div :style="{ display: 'flex', alignItems: 'baseline', gap: '8px', minWidth: 0 }">
          <!--
            Empty means nothing is loaded, which the library's copy of this bar
            sits in until someone presses play. Saying so beats a bold blank.
          -->
          <b
            v-if="shownTitle"
            :style="{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }"
            v-text="shownTitle"
          />
          <span v-else :style="{ color: 'var(--oc-role-on-surface-variant)', whiteSpace: 'nowrap' }"
            >Nothing playing</span
          >
          <span
            v-if="songCount > 1"
            :style="{ fontSize: '12px', color: 'var(--oc-role-on-surface-variant)', whiteSpace: 'nowrap' }"
          >
            subsong {{ subsong }} of {{ songCount }}
          </span>
        </div>
        <div
          :style="{
            fontSize: '12px',
            color: shownState === 'failed' ? 'var(--oc-role-error)' : 'var(--oc-role-on-surface-variant)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontVariantNumeric: 'tabular-nums'
          }"
        >
          {{ status || (hasTune ? `${formatTime(position)} / ${formatTime(length)}` : '') }}
        </div>
      </div>

      <div
        :style="{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          color: 'var(--oc-role-on-surface-variant)',
          position: 'relative'
        }"
      >
        <!-- Per-voice mute: hear one voice alone. Session state, so it is
             not in the preferences panel. -->
        <div role="group" aria-label="Voices" :style="{ display: 'flex', gap: '2px', marginRight: '4px' }">
          <button
            v-for="voice in [0, 1, 2]"
            :key="voice"
            type="button"
            :aria-label="`Voice ${voice + 1}: ${mutedVoices[voice] ? 'muted, click to unmute' : 'playing, click to mute'}`"
            :title="`Voice ${voice + 1}: mute or unmute${key(String(voice + 1))}`"
            :aria-pressed="mutedVoices[voice]"
            :style="{
              width: '26px',
              height: '26px',
              borderRadius: '6px',
              border: '1px solid var(--oc-role-outline-variant)',
              background: mutedVoices[voice] ? 'transparent' : 'var(--oc-role-secondary-container)',
              color: mutedVoices[voice]
                ? 'var(--oc-role-on-surface-variant)'
                : 'var(--oc-role-on-secondary-container)',
              textDecoration: mutedVoices[voice] ? 'line-through' : 'none',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
              padding: 0
            }"
            @click="player.toggleVoice(voice)"
          >
            {{ voice + 1 }}
          </button>
        </div>
        <oc-button
          appearance="raw"
          :aria-label="prefs.analyser ? 'Hide spectrum' : 'Show spectrum'"
          :title="`${prefs.analyser ? 'Hide spectrum' : 'Show spectrum'}${key('s')}`"
          :aria-pressed="prefs.analyser"
          @click="prefs.analyser = !prefs.analyser"
        >
          <oc-icon
            name="equalizer-2"
            :color="prefs.analyser ? 'var(--oc-role-primary)' : 'var(--oc-role-on-surface-variant)'"
          />
        </oc-button>
        <oc-button
          appearance="raw"
          :aria-label="prefs.muted ? 'Unmute' : 'Mute'"
          :title="`${prefs.muted ? 'Unmute' : 'Mute'}${key('m')}`"
          @click="session.setMuted(!prefs.muted)"
        >
          <oc-icon :name="prefs.muted ? 'volume-mute' : 'volume-up'" />
        </oc-button>
        <input
          type="range"
          min="0"
          max="100"
          :value="Math.round((prefs.muted ? 0 : prefs.volume) * 100)"
          aria-label="Volume"
          :style="{ width: '88px', accentColor: 'var(--oc-role-primary)' }"
          @input="onSlider(Number(($event.target as HTMLInputElement).value) / 100)"
        />
        <oc-button
          appearance="raw"
          aria-label="Preferences"
          title="Preferences"
          :aria-expanded="prefsOpen"
          @mousedown.stop
          @click="prefsOpen = !prefsOpen"
        >
          <oc-icon name="settings-3" />
        </oc-button>
        <oc-button
          v-if="closable"
          appearance="raw"
          aria-label="Stop and close"
          title="Stop and close"
          @click="session.stop()"
        >
          <oc-icon name="close" />
        </oc-button>
        <div v-if="prefsOpen" :style="{ position: 'absolute', right: 0, bottom: '44px', zIndex: 5 }">
          <preferences-panel :prefs="prefs" :can-choose-theme="canChooseTheme" @close="prefsOpen = false" />
        </div>
      </div>
    </div>
  </div>
</template>
