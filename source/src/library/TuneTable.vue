<script setup lang="ts">
import { computed, ref } from 'vue'
import type { CatalogRow } from '../hvsc/catalog'
import { rowKey } from '../hvsc/catalog'
import type { SortColumn, SortOrder } from '../hvsc/sorting'
import { columnHead } from './styles'
import TuneRow from './TuneRow.vue'

/**
 * The middle pane: whatever list is in view, browsing or searching.
 *
 * Rows come straight from the catalogue, so a tune that has not been
 * downloaded yet is here too - search works over the whole release, not just
 * over what is local. Those rows say so and offer to fetch the one file.
 */
const { blocks, selected, playing, sounding, starred, showPath, local, fetching, sort, reorderable } =
  defineProps<{
    /**
     * The rows to draw, divided into headed runs, where they come from more than
     * one place. A search over two collections is the only thing that does
     * this; everywhere else there is one unheaded run.
     */
    blocks: Array<{ key: string; label: string; note?: string; rows: CatalogRow[] }>
    selected: CatalogRow | null
    /** The key (`rowKey`) of the tune the player is on, if any. */
    playing: string | null
    starred: (row: CatalogRow) => boolean
    /** Search results show where each hit lives; a folder listing does not. */
    showPath: boolean
    /**
     * Which tunes are present, by folder, for folders that have been listed. A
     * row whose folder is not a key here is unknown rather than missing, which
     * is the common case in a listing that reaches into subfolders.
     */
    local: Map<string, Set<string>> | null
    /** Paths being fetched from the mirror right now. */
    fetching: Set<string>
    /** Which column the list is ordered by, or null for the natural order. */
    sort: SortOrder | null
    /**
     * Whether rows can be put in a hand-made order. True only in favourites,
     * whose natural order is a human decision rather than a property of the
     * collection.
     */
    reorderable: boolean
    /** Whether the tune at `playing` is sounding now, rather than paused or loading. */
    sounding: boolean
  }>()

const emit = defineEmits<{
  (e: 'select', row: CatalogRow): void
  (e: 'play', row: CatalogRow): void
  /** The playing row's own button: pause, as the player bar's does. */
  (e: 'pause'): void
  (e: 'star', row: CatalogRow): void
  (e: 'sort', column: SortColumn): void
  (e: 'move', payload: { row: CatalogRow; index: number }): void
}>()

/** Windowed rendering: 61,157 rows in one list would not paint. */
const LIMIT = 400

/**
 * What the scrolling area draws, in order: a heading, rows, a line saying
 * how many rows were left out, and on to the next block.
 *
 * Built as one flat list rather than nested loops so that the window applies
 * per block. Taking the first 400 of the two blocks concatenated would have
 * shown the whole of the first collection and none of the second whenever
 * the first had 400 results, which is exactly when someone most wants to see
 * that there is a second.
 */
type Item =
  | { kind: 'heading'; key: string; label: string; note?: string; count: number }
  | { kind: 'row'; key: string; row: CatalogRow }
  | { kind: 'more'; key: string; hidden: number }
  | { kind: 'empty'; key: string }

/**
 * Every row in view, headings aside. The reorder buttons work in terms of a
 * position in the whole list, and favourites - the only mode that reorders -
 * is always a single unheaded block.
 */
const allRows = computed<CatalogRow[]>(() => blocks.flatMap((run) => run.rows))

const items = computed<Item[]>(() => {
  const out: Item[] = []
  const headed = blocks.length > 1 || !!blocks[0].label
  for (const run of blocks) {
    if (headed) {
      out.push({
        kind: 'heading',
        key: `h:${run.key}`,
        label: run.label,
        note: run.note,
        count: run.rows.length
      })
    }
    for (const row of run.rows.slice(0, LIMIT)) out.push({ kind: 'row', key: rowKey(row), row })
    const hidden = Math.max(0, run.rows.length - LIMIT)
    if (hidden) out.push({ kind: 'more', key: `m:${run.key}`, hidden })
    if (!run.rows.length) out.push({ kind: 'empty', key: `e:${run.key}` })
  }
  return out
})

/**
 * The first and last rows drawn, which is what the reorder buttons bound
 * against: the one has no further up to go and the other no further down.
 */
const drawn = computed(() => items.value.filter((item) => item.kind === 'row'))
const firstKey = computed(() => drawn.value[0]?.key ?? null)
const lastKey = computed(() => drawn.value[drawn.value.length - 1]?.key ?? null)

/**
 * A column heading that sorts.
 *
 * No `aria-sort`: that belongs on a `columnheader` inside a `table` or
 * `grid`, and this list is neither - the rows carry `role="row"` for the
 * tests and nothing else. A button whose name says what clicking it will do,
 * and what the column is doing now, tells a screen reader the same thing
 * without pretending to a structure that is not here.
 */
const HEADINGS: Array<{ column: SortColumn; label: string; width?: string; right?: boolean; grow?: boolean }> =
  [
    { column: 'title', label: 'Title', grow: true },
    { column: 'released', label: 'Released', width: '150px' },
    { column: 'songs', label: 'Songs', width: '56px', right: true },
    { column: 'length', label: 'Length', width: '56px', right: true }
  ]

const arrow = (column: SortColumn): string =>
  sort?.column !== column ? '' : sort.direction === 'asc' ? ' \u2191' : ' \u2193'

const sortLabel = (column: SortColumn, label: string): string => {
  if (sort?.column !== column) return `Sort by ${label.toLowerCase()}`
  return sort.direction === 'asc'
    ? `Sorted by ${label.toLowerCase()}, ascending. Click for descending`
    : `Sorted by ${label.toLowerCase()}, descending. Click to return to the original order`
}

const headingStyle = (heading: (typeof HEADINGS)[number]) => ({
  ...(heading.grow ? { flexGrow: 1 } : { width: heading.width }),
  minWidth: 0,
  padding: 0,
  border: 0,
  background: 'transparent',
  font: 'inherit',
  ...columnHead,
  color: sort?.column === heading.column ? 'var(--oc-role-on-surface)' : columnHead.color,
  textAlign: (heading.right ? 'right' : 'left') as 'right' | 'left',
  cursor: 'pointer',
  whiteSpace: 'nowrap' as const
})

/*
 * Reordering by hand is off while a column sort is on: the two mean
 * different things by "the order", and dragging a row into a place the sort
 * would immediately take it out of is a promise the list cannot keep.
 */
const canReorder = computed(() => reorderable && !sort)
/*
 * The row being dragged, not its path. Favourites can now hold tunes from
 * both collections, and a path only identifies one of them by the accident
 * that the two archives name their top level differently.
 */
const dragging = ref<CatalogRow | null>(null)
/** The key (`rowKey`) of the row a drag is over, for the same reason. */
const over = ref<string | null>(null)
/** The same tune: what `rowKey` compares, without building two strings per row. */
const same = (a: CatalogRow, b: CatalogRow): boolean =>
  a === b || (a.path === b.path && (a.collection ?? 'hvsc') === (b.collection ?? 'hvsc'))

/*
 * What a row reports, handled here. Named functions rather than arrows in
 * the template, so that each row is handed the same listeners on every
 * render and only its own flags can make it draw again.
 */
const onDragStart = (row: CatalogRow): void => {
  dragging.value = row
}

const onDragEnd = (): void => {
  dragging.value = null
  over.value = null
}

const onDragOver = (row: CatalogRow): void => {
  if (canReorder.value) over.value = rowKey(row)
}

const onDragLeave = (row: CatalogRow): void => {
  if (over.value === rowKey(row)) over.value = null
}

const onDrop = (row: CatalogRow): void => {
  const from = dragging.value
  dragging.value = null
  over.value = null
  if (!from || same(from, row)) return
  emit('move', { row: from, index: allRows.value.findIndex((r) => same(r, row)) })
}

const move = (row: CatalogRow, delta: -1 | 1): void => {
  const index = allRows.value.findIndex((r) => same(r, row))
  if (index < 0) return
  emit('move', { row, index: index + delta })
}

const onSelect = (row: CatalogRow): void => emit('select', row)
const onPlay = (row: CatalogRow): void => emit('play', row)
const onPause = (): void => emit('pause')
const onStar = (row: CatalogRow): void => emit('star', row)

/*
 * Worked out here, once per row, and handed down as booleans: a row that is
 * told only whether it is the selected one is left alone when the selection
 * moves between two others.
 */
const selectedKey = computed(() => (selected ? rowKey(selected) : null))
const draggingKey = computed(() => (dragging.value ? rowKey(dragging.value) : null))
const missing = (row: CatalogRow): boolean => local?.get(row.folder)?.has(row.path) === false
const busy = (row: CatalogRow): boolean => fetching.has(row.path)
</script>

<template>
  <div
    :style="{
      flexGrow: 1,
      minWidth: 0,
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--oc-role-surface)'
    }"
  >
    <div
      :style="{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        height: '30px',
        flexShrink: 0,
        padding: '0 16px',
        borderBottom: '1px solid var(--oc-role-outline-variant)',
        ...columnHead
      }"
    >
      <span v-if="reorderable" :style="{ width: '58px' }"></span>
      <span :style="{ width: '20px' }"></span>
      <button
        v-for="heading in HEADINGS"
        :key="heading.column"
        type="button"
        :aria-label="sortLabel(heading.column, heading.label)"
        :style="headingStyle(heading)"
        @click="emit('sort', heading.column)"
      >
        {{ heading.label }}{{ arrow(heading.column) }}
      </button>
      <span :style="{ width: '28px' }"></span>
    </div>

    <div :style="{ flexGrow: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }">
      <template v-for="item in items" :key="item.key">
        <!--
        Where a search has looked in two collections, each one's results get
        a heading of their own. Kept even when a collection found nothing,
        because the note underneath is often the answer: a collection that
        records no years has nothing to say to `year:1987`, and an empty list
        with no heading would read as "no such tunes".
      -->
        <div
          v-if="item.kind === 'heading'"
          :style="{
            display: 'flex',
            alignItems: 'baseline',
            gap: '8px',
            padding: '14px 16px 6px',
            background: 'var(--oc-role-surface)',
            borderBottom: '1px solid var(--oc-role-outline-variant)'
          }"
        >
          <span :style="{ ...columnHead, fontSize: '11px', color: 'var(--oc-role-on-surface)' }">{{
            item.label
          }}</span>
          <span
            :style="{
              fontSize: '11px',
              color: 'var(--oc-role-on-surface-variant)',
              fontVariantNumeric: 'tabular-nums'
            }"
          >
            {{ item.count.toLocaleString() }}
          </span>
          <span
            v-if="item.note"
            :style="{
              flexGrow: 1,
              textAlign: 'right',
              fontSize: '11px',
              color: 'var(--oc-role-on-surface-variant)'
            }"
            >{{ item.note }}</span
          >
        </div>

        <!--
        One row, drawn by a component of its own so that a change to one row
        - selected, playing, dragged over - redraws that row and not the list.
      -->
        <tune-row
          v-if="item.kind === 'row'"
          :row="item.row"
          :selected="selectedKey === item.key"
          :playing="playing === item.key"
          :sounding="sounding && playing === item.key"
          :starred="starred(item.row)"
          :missing="missing(item.row)"
          :busy="busy(item.row)"
          :show-path="showPath"
          :reorderable="reorderable"
          :can-reorder="canReorder"
          :first="firstKey === item.key"
          :last="lastKey === item.key"
          :drop-target="over === item.key"
          :dragged="draggingKey === item.key"
          @select="onSelect"
          @play="onPlay"
          @pause="onPause"
          @star="onStar"
          @step="move"
          @drag-start="onDragStart"
          @drag-end="onDragEnd"
          @drag-over="onDragOver"
          @drag-leave="onDragLeave"
          @drop="onDrop"
        />

        <div
          v-if="item.kind === 'more'"
          :style="{ padding: '12px 16px', fontSize: '12px', color: 'var(--oc-role-on-surface-variant)' }"
        >
          {{ item.hidden.toLocaleString() }} more not shown. Narrow the search or open a folder.
        </div>
        <div
          v-if="item.kind === 'empty'"
          :style="{ padding: '28px 16px', fontSize: '13px', color: 'var(--oc-role-on-surface-variant)' }"
        >
          Nothing here.
        </div>
      </template>
    </div>
  </div>
</template>
