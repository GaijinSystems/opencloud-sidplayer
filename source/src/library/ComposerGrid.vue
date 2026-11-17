<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ComposerEntry } from './useLibrary'

/**
 * Browsing by composer, which the collection's shape justifies: 56,568 of
 * release 85's 61,157 tunes are filed under MUSICIANS, against 3,058 in
 * DEMOS and 1,531 in GAMES. The folder tree buries that under three levels
 * of initial letters; this puts it first.
 *
 * Ordered by tune count by default, because that is the order in which a
 * person recognises names.
 */
const { composers } = defineProps<{ composers: ComposerEntry[] }>()

const emit = defineEmits<{
  (e: 'open', folder: string): void
  (e: 'play-all', entry: ComposerEntry): void
}>()

const letter = ref<string | null>(null)
const order = ref<'count' | 'name'>('count')

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

const shown = computed(() => {
  let list = composers
  if (letter.value) {
    const l = letter.value.toLowerCase()
    list = list.filter((entry) => entry.folder.toLowerCase().startsWith(l))
  }
  if (order.value === 'name') list = [...list].sort((a, b) => (a.name < b.name ? -1 : 1))
  return list.slice(0, 240)
})

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('')

const letterStyle = (active: boolean) => ({
  minWidth: '24px',
  height: '24px',
  padding: '0 4px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: 0,
  borderRadius: '6px',
  background: active ? 'var(--oc-role-primary)' : 'transparent',
  color: active ? 'var(--oc-role-on-primary)' : 'var(--oc-role-on-surface-variant)',
  font: 'inherit',
  fontSize: '12px',
  fontVariantNumeric: 'tabular-nums' as const,
  cursor: 'pointer'
})
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
        flexShrink: 0,
        boxSizing: 'border-box',
        padding: '12px 16px',
        borderBottom: '1px solid var(--oc-role-outline-variant)',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '8px'
      }"
    >
      <span :style="{ fontSize: '13px', color: 'var(--oc-role-on-surface-variant)' }">
        {{ composers.length.toLocaleString() }} composers
      </span>
      <span :style="{ flexGrow: 1 }"></span>
      <label for="composer-order" :style="{ fontSize: '12px', color: 'var(--oc-role-on-surface-variant)' }"
        >Order</label
      >
      <select
        id="composer-order"
        v-model="order"
        :style="{
          height: '28px',
          padding: '0 6px',
          font: 'inherit',
          fontSize: '12px',
          color: 'var(--oc-role-on-surface)',
          background: 'var(--oc-role-surface)',
          border: '1px solid var(--oc-role-outline-variant)',
          borderRadius: '6px'
        }"
      >
        <option value="count">Most tunes</option>
        <option value="name">Name</option>
      </select>
    </div>

    <div
      :style="{
        flexShrink: 0,
        padding: '8px 16px',
        display: 'flex',
        flexWrap: 'wrap',
        gap: '2px',
        borderBottom: '1px solid var(--oc-role-outline-variant)'
      }"
    >
      <button type="button" :style="letterStyle(letter === null)" @click="letter = null">All</button>
      <button
        v-for="l in LETTERS"
        :key="l"
        type="button"
        :style="letterStyle(letter === l)"
        @click="letter = letter === l ? null : l"
      >
        {{ l }}
      </button>
    </div>

    <div
      :style="{
        flexGrow: 1,
        minHeight: 0,
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        boxSizing: 'border-box',
        padding: '16px',
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))',
        gap: '12px',
        alignContent: 'start'
      }"
    >
      <div
        v-for="entry in shown"
        :key="entry.folder"
        :style="{
          boxSizing: 'border-box',
          padding: '14px',
          background: 'var(--oc-role-surface-container)',
          border: '1px solid var(--oc-role-outline-variant)',
          borderRadius: '10px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px'
        }"
      >
        <div :style="{ display: 'flex', alignItems: 'center', gap: '10px' }">
          <span
            :style="{
              width: '40px',
              height: '40px',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '14px',
              fontWeight: 600,
              color: 'var(--oc-role-on-secondary-container)',
              background: 'var(--oc-role-secondary-container)',
              borderRadius: '9px'
            }"
            aria-hidden="true"
          >
            {{ initials(entry.name) }}
          </span>
          <span :style="{ minWidth: 0 }">
            <button
              type="button"
              :style="{
                display: 'block',
                maxWidth: '100%',
                padding: 0,
                background: 'transparent',
                border: 0,
                font: 'inherit',
                fontSize: '14px',
                fontWeight: 600,
                color: 'var(--oc-role-on-surface)',
                textAlign: 'left',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                cursor: 'pointer'
              }"
              @click="emit('open', entry.path)"
            >
              {{ entry.name }}
            </button>
            <span
              :style="{
                display: 'block',
                marginTop: '1px',
                fontSize: '11px',
                color: 'var(--oc-role-on-surface-variant)'
              }"
            >
              {{ entry.count.toLocaleString() }} tune{{ entry.count === 1 ? '' : 's' }}
              <template v-if="entry.country"> &middot; {{ entry.country }}</template>
            </span>
          </span>
        </div>

        <div v-if="entry.realName" :style="{ fontSize: '11px', color: 'var(--oc-role-on-surface-variant)' }">
          {{ entry.realName }}
        </div>

        <div :style="{ display: 'flex', flexDirection: 'column', gap: '3px' }">
          <span
            v-for="example in entry.examples"
            :key="example.path"
            :style="{
              fontSize: '12px',
              color: 'var(--oc-role-on-surface-variant)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }"
          >
            {{ example.title || example.stem }}
          </span>
        </div>

        <oc-button
          appearance="outline"
          size="small"
          :style="{ marginTop: 'auto' }"
          @click="emit('play-all', entry)"
        >
          Play all
        </oc-button>
      </div>

      <p v-if="!shown.length" :style="{ fontSize: '13px', color: 'var(--oc-role-on-surface-variant)' }">
        No composers under that letter.
      </p>
    </div>
  </div>
</template>
