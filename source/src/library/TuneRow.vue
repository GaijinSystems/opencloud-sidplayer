<script setup lang="ts">
import { computed } from 'vue'
import type { CatalogRow } from '../hvsc/catalog'
import { knownLengths, totalLength } from '../hvsc/catalog'
import { formatTime } from '../helpers/format'

/**
 * One row of the tune table.
 *
 * A component of its own so that what changes about one row redraws one row.
 * While the rows were markup inside `TuneTable`, the selection, the playing
 * tune, the drag target and the rest were all read by the table's one render
 * function, and a click or each row crossed during a drag rebuilt every row
 * in view - up to 400 a block. Everything here that varies arrives as a
 * boolean the table has already worked out for this row, so Vue can compare
 * the props and skip the rows where none of them moved.
 *
 * It owns no state. What the user does is emitted, with the row, and the
 * table decides what it means - the drag in particular, which is a matter
 * between two rows and so cannot live in either.
 */
const {
  row,
  selected,
  playing,
  sounding,
  starred,
  missing,
  busy,
  showPath,
  reorderable,
  canReorder,
  first,
  last,
  dropTarget,
  dragged
} = defineProps<{
  row: CatalogRow
  selected: boolean
  /** Whether this is the tune the player is on. */
  playing: boolean
  /** Whether this row's tune is sounding now, rather than paused or loading. */
  sounding: boolean
  starred: boolean
  /** Known not to be downloaded, which is not the same as not known to be. */
  missing: boolean
  /** Being fetched from the mirror right now. */
  busy: boolean
  /** Search results show where each hit lives; a folder listing does not. */
  showPath: boolean
  /** Whether the list is one that can be ordered by hand: the column is kept. */
  reorderable: boolean
  /** Whether it can be ordered by hand right now: the controls are offered. */
  canReorder: boolean
  /** The first and last rows drawn, which have nowhere further to go. */
  first: boolean
  last: boolean
  /** A dragged row is over this one. */
  dropTarget: boolean
  /** This is the row being dragged. */
  dragged: boolean
}>()

const emit = defineEmits<{
  (e: 'select', row: CatalogRow): void
  (e: 'play', row: CatalogRow): void
  /** The playing row's own button: pause, as the player bar's does. */
  (e: 'pause'): void
  (e: 'star', row: CatalogRow): void
  (e: 'step', row: CatalogRow, delta: -1 | 1): void
  (e: 'dragStart', row: CatalogRow): void
  (e: 'dragEnd'): void
  (e: 'dragOver', row: CatalogRow): void
  (e: 'dragLeave', row: CatalogRow): void
  (e: 'drop', row: CatalogRow): void
}>()

/*
 * Styles that no state reaches, made once for every row rather than once per
 * row per render. The ones with two states are a pair of constants, not a
 * spread at the point of use, for the same reason.
 */
const cell = { fontSize: '13px', whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' }
const numeric = { fontVariantNumeric: 'tabular-nums' as const, fontSize: '12px', textAlign: 'right' as const }

const REORDER = { width: '58px', display: 'flex', alignItems: 'center', gap: '2px', flexShrink: 0 }
const HANDLE = {
  width: '16px',
  display: 'flex',
  justifyContent: 'center',
  color: 'var(--oc-role-on-surface-variant)',
  cursor: 'grab',
  lineHeight: 1
}
const stepStyle = {
  width: '18px',
  height: '16px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  background: 'transparent',
  border: 0,
  color: 'var(--oc-role-on-surface-variant)',
  fontSize: '10px',
  lineHeight: 1,
  cursor: 'pointer'
}
const STEP = { ...stepStyle, opacity: 1 }
const STEP_DISABLED = { ...stepStyle, opacity: 0.3 }

const PLAY_CELL = { width: '20px', display: 'flex', justifyContent: 'center' }
const PLAY_BUTTON = {
  width: '20px',
  height: '20px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  background: 'transparent',
  border: 0,
  color: 'var(--oc-role-on-surface-variant)',
  cursor: 'pointer'
}

const TITLE_CELL = { flexGrow: 1, minWidth: 0 }
const TITLE = { ...cell, display: 'block', fontWeight: 400 }
const TITLE_PLAYING = { ...cell, display: 'block', fontWeight: 600 }
const STATE_NOTE = { fontSize: '11px', opacity: 0.8 }
const PATH = {
  display: 'block',
  marginTop: '2px',
  fontSize: '10px',
  fontFamily: 'monospace',
  opacity: 0.75,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap' as const
}
const AUTHOR = { display: 'block', marginTop: '1px', fontSize: '11px', opacity: 0.7 }

const RELEASED = { width: '150px', ...cell, opacity: 0.85 }
const NUMBER = { width: '56px', ...numeric, opacity: 0.85 }

const STAR_CELL = { width: '28px', display: 'flex', justifyContent: 'flex-end' }
const starStyle = {
  width: '24px',
  height: '24px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  background: 'transparent',
  border: 0
}
const STAR = { ...starStyle, color: 'var(--oc-role-on-surface-variant)', cursor: 'pointer' }
const STAR_ON = { ...starStyle, color: 'var(--oc-role-primary)', cursor: 'pointer' }

/** What the row is called, in its title cell and in every button's name. */
const name = computed(() => row.title || row.stem)

const rowStyle = computed(() => ({
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  minHeight: showPath ? '50px' : '36px',
  padding: '0 16px',
  borderBottom: dropTarget ? '1px solid var(--oc-role-primary)' : '1px solid var(--oc-role-outline-variant)',
  borderTop: dropTarget ? '1px solid var(--oc-role-primary)' : '1px solid transparent',
  background: playing
    ? 'var(--oc-role-secondary-container)'
    : selected
      ? 'var(--oc-role-surface-container)'
      : 'transparent',
  color: playing ? 'var(--oc-role-on-secondary-container)' : 'var(--oc-role-on-surface)',
  cursor: 'pointer',
  opacity: dragged ? 0.45 : missing ? 0.65 : 1
}))
</script>

<template>
  <div
    role="row"
    :style="rowStyle"
    @click="emit('select', row)"
    @dblclick="emit('play', row)"
    @dragover.prevent="emit('dragOver', row)"
    @dragleave="emit('dragLeave', row)"
    @drop.prevent="emit('drop', row)"
  >
    <!--
      Drag for speed, buttons for everything else: a drag handle cannot
      be reached from a keyboard, and it is the buttons a browser test
      can drive honestly.
    -->
    <span v-if="reorderable" :style="REORDER">
      <template v-if="canReorder">
        <span
          draggable="true"
          :aria-hidden="true"
          :title="`Drag to move ${name}`"
          :style="HANDLE"
          @dragstart="emit('dragStart', row)"
          @dragend="emit('dragEnd')"
          @click.stop
          >⠿</span
        >
        <button
          type="button"
          :aria-label="`Move ${name} up`"
          :disabled="first"
          :style="first ? STEP_DISABLED : STEP"
          @click.stop="emit('step', row, -1)"
        >
          &#9650;
        </button>
        <button
          type="button"
          :aria-label="`Move ${name} down`"
          :disabled="last"
          :style="last ? STEP_DISABLED : STEP"
          @click.stop="emit('step', row, 1)"
        >
          &#9660;
        </button>
      </template>
    </span>

    <!--
      Play, or on the row that is sounding, pause - the same pair the
      player bar has, at the size of the arrows beside it. A paused tune
      shows Play like any other row, and playing it carries on from where
      it stopped. The playing row once had a little equalizer here, and
      then nothing; this says what the button does as well as which row.
    -->
    <span :style="PLAY_CELL">
      <button
        type="button"
        :aria-label="`${sounding ? 'Pause' : 'Play'} ${name}`"
        :style="PLAY_BUTTON"
        @click.stop="sounding ? emit('pause') : emit('play', row)"
        @dblclick.stop
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <template v-if="sounding">
            <path d="M6 5h4v14H6z"></path>
            <path d="M14 5h4v14h-4z"></path>
          </template>
          <path v-else d="M8 5l11 7-11 7z"></path>
        </svg>
      </button>
    </span>

    <span :style="TITLE_CELL">
      <!-- a stable hook: the cells before this one come and go with the
           view, so counting them is not a way to find the title -->
      <span class="sidplayer-tune-title" :style="playing ? TITLE_PLAYING : TITLE">
        {{ name }}
        <span v-if="busy" :style="STATE_NOTE">&middot; fetching&hellip;</span>
        <span v-else-if="missing" :style="STATE_NOTE">&middot; not downloaded, plays on demand</span>
      </span>
      <span v-if="showPath" :style="PATH">
        {{ row.path.replace(/^\//, '') }}
      </span>
      <span v-else-if="row.composer" :style="AUTHOR">
        {{ row.author || row.composer }}
      </span>
    </span>

    <span :style="RELEASED">{{ row.released || '—' }}</span>
    <span :style="NUMBER">{{ row.songs ?? row.lengths.length }}</span>
    <!-- A dash, not 0:00: nothing measured a Compute's tune, and a
         zero would read as a length rather than as its absence. -->
    <span :style="NUMBER">
      {{ knownLengths(row) ? formatTime(totalLength(row)) : '—' }}
    </span>
    <span :style="STAR_CELL">
      <button
        type="button"
        :aria-label="starred ? `Remove ${name} from favourites` : `Add ${name} to favourites`"
        :aria-pressed="starred"
        :style="starred ? STAR_ON : STAR"
        @click.stop="emit('star', row)"
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          :fill="starred ? 'currentColor' : 'none'"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6-5.4-2.9-5.4 2.9 1-6L3.2 9.5l6.1-.9z"></path>
        </svg>
      </button>
    </span>
  </div>
</template>
