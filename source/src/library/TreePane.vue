<script setup lang="ts">
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type { TreeNode } from '../hvsc/catalog'
import type { LibraryMode } from './useLibrary'
import { COLLECTIONS, COLLECTION_KEYS, type Collection } from './collections'
import { sectionLabel as heading } from './styles'

/**
 * The collection tree, on the left.
 *
 * The real shape of HVSC decides how this behaves: MUSICIANS holds 56,568 of
 * the 61,157 tunes in release 85, DEMOS 3,058 and GAMES 1,531. So MUSICIANS
 * opens by default and is the branch worth being fast, and "expanded" is
 * kept here rather than in the node data, which is shared and read-only.
 *
 * Below it, when there is one, comes the Compute's Gazette collection. Its
 * 447 composer folders are too many to list flat and too few to want a
 * letter apiece, so they arrive already divided into ten groups; a group is
 * a heading that expands and nothing else, since it stands for several
 * folders and there is no one listing that would be its contents.
 */
const { tree, cgscTree, folder, collection, mode, counts } = defineProps<{
  tree: TreeNode | null
  /** The second collection, or null where there is none. */
  cgscTree: TreeNode | null
  folder: string
  /** Which collection `folder` is a path in. */
  collection: Collection
  mode: LibraryMode
  /** Favourites and total, for the top section. */
  counts: { total: number; favourites: number }
}>()

const emit = defineEmits<{
  (e: 'open', path: string, collection: Collection): void
  (e: 'mode', mode: LibraryMode): void
}>()

/*
 * One set per tree. The two collections have no path in common today -
 * HVSC's top level is DEMOS, GAMES, MUSICIANS and DOCUMENTS - but they are
 * separate namespaces, and sharing a set would silently tie a folder in one
 * to a folder of the same name in the other.
 */
const expanded: Record<Collection, Ref<Set<string>>> = {
  hvsc: ref(new Set<string>(['/MUSICIANS'])),
  cgsc: ref(new Set<string>())
}

// Named rather than passed, because a template unwraps a ref before it can
// be handed to anything.
const toggle = (which: Collection, path: string): void => {
  const set = expanded[which]
  const next = new Set(set.value)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  set.value = next
}

/**
 * Rows to draw: a depth-first walk that stops at anything not expanded.
 *
 * A node that is a letter group is drawn as a heading, not a folder: it
 * stands for forty-odd composers and there is no listing that would be its
 * contents. So the whole row expands, and only real folders open.
 */
interface Line {
  node: TreeNode
  depth: number
  open: boolean
  hasChildren: boolean
}
const walkTree = (root: TreeNode | null, open: Set<string>): Line[] => {
  const out: Line[] = []
  const walk = (node: TreeNode, depth: number): void => {
    for (const child of node.children) {
      const isOpen = open.has(child.path)
      out.push({ node: child, depth, open: isOpen, hasChildren: child.children.length > 0 })
      if (isOpen) walk(child, depth + 1)
    }
  }
  if (root) walk(root, 0)
  return out
}

const lines: Record<Collection, ComputedRef<Line[]>> = {
  hvsc: computed(() => walkTree(tree, expanded.hvsc.value)),
  cgsc: computed(() => walkTree(cgscTree, expanded.cgsc.value))
}

/**
 * One section of the pane per collection, in the table's order.
 *
 * The second collection sits at twice the gap the first one sits below the
 * Library section. These are two different archives with two different
 * histories, not two branches of one, and the extra air is what says so
 * before the heading has been read.
 *
 * An optional collection has no section until there is something in it.
 */
interface Section {
  key: Collection
  label: string
  gap: string
  shown: boolean
  lines: Line[]
}
const sections = computed<Section[]>(() => {
  const roots: Record<Collection, TreeNode | null> = { hvsc: tree, cgsc: cgscTree }
  return COLLECTION_KEYS.map((key, at) => ({
    key,
    label: COLLECTIONS[key].treeLabel,
    gap: at === 0 ? '16px' : '32px',
    shown: !COLLECTIONS[key].optional || Boolean(roots[key]?.total),
    lines: lines[key].value
  }))
})

const number = (n: number): string => n.toLocaleString()

const sectionLabel = heading({ padding: '0 8px 6px' })
const rowStyle = (active: boolean) => ({
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  width: '100%',
  height: '30px',
  padding: '0 8px',
  border: 0,
  borderRadius: '7px',
  background: active ? 'var(--oc-role-secondary-container)' : 'transparent',
  color: active ? 'var(--oc-role-on-secondary-container)' : 'var(--oc-role-on-surface)',
  font: 'inherit',
  fontSize: '13px',
  fontWeight: active ? 600 : 400,
  textAlign: 'left' as const,
  cursor: 'pointer'
})
const chevron = (depth: number) => ({
  width: '20px',
  height: '30px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  marginLeft: `${depth * 12}px`,
  background: 'transparent',
  border: 0,
  cursor: 'pointer',
  color: 'var(--oc-role-on-surface-variant)'
})
const countStyle = { fontSize: '11px', opacity: 0.7, fontVariantNumeric: 'tabular-nums' as const }
const nameStyle = {
  flexGrow: 1,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
}

const isOpenFolder = (which: Collection, path: string): boolean =>
  mode === 'folder' && collection === which && folder === path

/* ---- walking the list with the arrow keys ------------------------------- */

const pane = ref<HTMLElement | null>(null)

/**
 * Up and down move between rows rather than scrolling the column.
 *
 * Read off the DOM rather than rebuilt from each collection's `lines`, because
 * what the arrows should walk is exactly what is on screen: two trees, the
 * three entries above them, whatever is expanded at that moment, and in that
 * order. Reconstructing that from the model would be a second description of
 * the same thing, free to disagree with the first.
 *
 * A letter group takes focus but is not activated in passing. It is a heading
 * that expands, and expanding every one on the way past would rearrange the
 * list under the very keys being used to walk it; Enter or Space still opens
 * it, as on any button.
 */
const onKey = (event: KeyboardEvent): void => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  const rows = [...(pane.value?.querySelectorAll<HTMLButtonElement>('button[data-row]') ?? [])]
  const here = rows.indexOf(document.activeElement as HTMLButtonElement)
  // Focus is not on a row, so the column scrolls as it always did.
  if (here < 0) return
  const next = rows[here + (event.key === 'ArrowDown' ? 1 : -1)]
  if (!next) return
  event.preventDefault()
  next.focus()
  next.scrollIntoView({ block: 'nearest' })
  if (next.dataset.heading === undefined) next.click()
}
</script>

<template>
  <div
    ref="pane"
    :style="{
      width: '264px',
      flexShrink: 0,
      boxSizing: 'border-box',
      padding: '14px 10px',
      overflowY: 'auto',
      background: 'var(--oc-role-surface)',
      borderRight: '1px solid var(--oc-role-outline-variant)'
    }"
    @keydown="onKey"
  >
    <div :style="sectionLabel">Library</div>
    <button
      type="button"
      data-row
      :style="rowStyle(isOpenFolder('hvsc', '/'))"
      @click="emit('open', '/', 'hvsc')"
    >
      <span :style="{ flexGrow: 1 }">All tunes</span>
      <span :style="{ fontSize: '11px', opacity: 0.7 }">{{ number(counts.total) }}</span>
    </button>
    <button type="button" data-row :style="rowStyle(mode === 'favourites')" @click="emit('mode', 'favourites')">
      <span :style="{ flexGrow: 1 }">Favourites</span>
      <span :style="{ fontSize: '11px', opacity: 0.7 }">{{ number(counts.favourites) }}</span>
    </button>
    <button type="button" data-row :style="rowStyle(mode === 'composers')" @click="emit('mode', 'composers')">
      <span :style="{ flexGrow: 1 }">Composers</span>
    </button>

    <template v-for="section in sections" :key="section.key">
      <template v-if="section.shown">
        <div :style="{ ...sectionLabel, paddingTop: section.gap }">{{ section.label }}</div>
        <div v-for="line in section.lines" :key="line.node.path">
          <div :style="{ display: 'flex', alignItems: 'center' }">
            <button
              v-if="line.hasChildren"
              type="button"
              :aria-label="`${line.open ? 'Collapse' : 'Expand'} ${line.node.name}`"
              :aria-expanded="line.open"
              :style="chevron(line.depth)"
              @click="toggle(section.key, line.node.path)"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
                :style="{ transform: line.open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }"
              >
                <path d="M9 6l6 6-6 6"></path>
              </svg>
            </button>
            <span v-else :style="{ width: '20px', marginLeft: `${line.depth * 12}px` }"></span>
            <button
              v-if="line.node.group"
              type="button"
              data-row
              data-heading
              class="sidplayer-letter-group"
              :aria-expanded="line.open"
              :style="{ ...rowStyle(false), color: 'var(--oc-role-on-surface-variant)' }"
              @click="toggle(section.key, line.node.path)"
            >
              <span :style="nameStyle">{{ line.node.name }}</span>
              <span :style="countStyle">{{ number(line.node.total) }}</span>
            </button>
            <button
              v-else
              type="button"
              data-row
              :style="rowStyle(isOpenFolder(section.key, line.node.path))"
              @click="emit('open', line.node.path, section.key)"
            >
              <span :style="nameStyle" :title="line.node.name">{{ line.node.name }}</span>
              <span :style="countStyle">{{ number(line.node.total) }}</span>
            </button>
          </div>
        </div>
      </template>
    </template>
  </div>
</template>
