<template>
  <div
    :style="{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '24px',
      width: '100%',
      height: '100%',
      padding: '32px 16px',
      textAlign: 'center',
      overflow: 'auto'
    }"
  >
    <div
      :style="{
        width: '96px',
        height: '96px',
        borderRadius: '16px',
        display: 'grid',
        placeItems: 'center',
        background: 'var(--oc-role-primary-container)',
        color: 'var(--oc-role-on-primary-container)'
      }"
    >
      <oc-icon name="music-2" size-class="size-12" color="currentColor" />
    </div>

    <div :style="{ maxWidth: '60ch' }">
      <!-- Explicit colour: the shell's stylesheet colours headings itself, and
           that rule would win over the re-themed root's inherited colour. -->
      <h2
        :style="{
          fontSize: '22px',
          fontWeight: 600,
          margin: 0,
          lineHeight: 1.3,
          color: 'var(--oc-role-on-surface)'
        }"
        v-text="title"
      />
      <p
        v-if="header.author"
        :style="{ margin: '4px 0 0', fontSize: '16px', color: 'var(--oc-role-on-surface-variant)' }"
        v-text="header.author"
      />
      <p
        v-if="header.released"
        :style="{ margin: '2px 0 0', fontSize: '14px', color: 'var(--oc-role-on-surface-variant)' }"
        v-text="header.released"
      />
    </div>

    <!-- A MUS file's credits often run to five or six lines; the first three
         are already shown as title, author and released. -->
    <div
      v-if="extraCredits.length"
      :style="{ fontSize: '13px', color: 'var(--oc-role-on-surface-variant)', maxWidth: '60ch' }"
    >
      <div v-for="(line, i) in extraCredits" :key="i" v-text="line" />
    </div>

    <tune-picture v-if="picture" :picture="picture" max-width="420px" />

    <div
      :style="{
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'center',
        gap: '8px',
        fontSize: '12px'
      }"
    >
      <span v-for="chip in chips" :key="chip" class="chip" v-text="chip" />
    </div>

    <!-- Sidplayer words. Text only: the format's timing is undocumented, so
         these are lyrics to read along with, not a display synced to the music. -->
    <section
      v-if="words.length"
      aria-label="Words"
      :style="{
        maxWidth: '60ch',
        maxHeight: '40vh',
        overflow: 'auto',
        padding: '12px 16px',
        borderRadius: '8px',
        textAlign: 'left',
        fontSize: '14px',
        lineHeight: 1.5,
        background: 'var(--oc-role-surface-container)',
        color: 'var(--oc-role-on-surface)'
      }"
    >
      <div
        :style="{
          fontSize: '11px',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          opacity: 0.7,
          marginBottom: '6px'
        }"
      >
        Words
      </div>
      <div
        v-for="(line, i) in words"
        :key="i"
        :style="{ minHeight: line ? undefined : '0.75em' }"
        v-text="line"
      />
    </section>

    <oc-button appearance="raw" size="small" @click="$emit('toggle-details')">
      <oc-icon :name="details ? 'arrow-up-s' : 'arrow-down-s'" />
      {{ details ? 'Hide details' : 'Show details' }}
    </oc-button>

    <!--
      A definition list rather than a table: the pairs are independent facts,
      and screen readers announce a dl as name/value without column context.
    -->
    <dl
      v-if="details"
      :style="{
        display: 'grid',
        gridTemplateColumns: 'auto auto',
        columnGap: '24px',
        rowGap: '4px',
        margin: 0,
        fontSize: '13px',
        textAlign: 'left'
      }"
    >
      <template v-for="[label, value] in rows" :key="label">
        <dt :style="{ color: 'var(--oc-role-on-surface-variant)' }" v-text="label" />
        <dd :style="{ margin: 0, fontVariantNumeric: 'tabular-nums' }" v-text="value" />
      </template>
    </dl>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { Picture } from '../sid/picture'
import TunePicture from './TunePicture.vue'
import type { SidHeader } from '../sid/types'
import { speedOf } from '../sid/header'
import { formatAddress, formatBytes } from '../helpers/format'

const { header, subsong, title, details, words, picture, lengthSource, hvscPath } = defineProps<{
  header: SidHeader
  subsong: number
  title: string
  details: boolean
  /** Lines from a Sidplayer .wds file; empty when there is none. */
  words: string[]
  /** A decoded `.pic`, `.pgg` or `.pjj` from beside the tune, or null. */
  picture: Picture | null
  /** Whether the subsong length came from HVSC or the configured default. */
  lengthSource: 'hvsc' | 'score' | 'default'
  hvscPath?: string
}>()

defineEmits<{ (e: 'toggle-details'): void }>()

const isSidplayer = computed(() => header.format === 'MUS' || header.format === 'MUS+STR')

const chips = computed(() => {
  const out = [isSidplayer.value ? `Sidplayer ${header.format}` : `${header.format} v${header.version}`]
  if (header.clock !== 'unknown') out.push(header.clock)
  if (header.sidModel !== 'unknown') out.push(header.sidModel)
  if (header.secondSidAddress) out.push('2 SIDs')
  if (header.thirdSidAddress) out.push('3 SIDs')
  if (header.songs > 1) out.push(`${header.songs} subsongs`)
  return out
})

/** Credit lines beyond the three shown as title, author and released. */
const extraCredits = computed(() => (header.comments ?? []).slice(3).filter((line) => line.trim()))

const rows = computed<Array<[string, string]>>(() => {
  const out: Array<[string, string]> = isSidplayer.value
    ? [
        ['Player', "Compute!'s Sidplayer, supplied by libsidplayfp"],
        ['Data address', formatAddress(header.loadAddress)],
        ['Data', formatBytes(header.dataLength)],
        ['Speed', 'CIA']
      ]
    : [
        ['Load address', formatAddress(header.loadAddress)],
        ['Init address', formatAddress(header.initAddress)],
        ['Play address', header.playAddress ? formatAddress(header.playAddress) : 'installed by init'],
        ['Data', formatBytes(header.dataLength)],
        ['Speed', speedOf(header, subsong)],
        ['Default subsong', String(header.startSong)]
      ]
  if (header.secondSidAddress) {
    out.push(['Second SID', `${formatAddress(header.secondSidAddress)} · ${header.secondSidModel}`])
  }
  if (header.thirdSidAddress) {
    out.push(['Third SID', `${formatAddress(header.thirdSidAddress)} · ${header.thirdSidModel}`])
  }
  if (header.playSidSpecific) {
    out.push([header.format === 'RSID' ? 'C64 BASIC' : 'PlaySID specific', 'yes'])
  }
  out.push([
    'Length',
    lengthSource === 'hvsc'
      ? 'from HVSC Songlengths.md5'
      : lengthSource === 'score'
        ? "worked out from the Sidplayer score's own tempo and durations"
        : 'default, no Songlengths.md5 found'
  ])
  if (hvscPath) out.push(['HVSC path', hvscPath])
  return out
})
</script>

<style scoped>
.chip {
  padding: 2px 10px;
  border-radius: 999px;
  background: var(--oc-role-surface-container-highest);
  color: var(--oc-role-on-surface-variant);
}
</style>
