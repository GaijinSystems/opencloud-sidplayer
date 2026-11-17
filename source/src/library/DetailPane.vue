<script setup lang="ts">
import { computed } from 'vue'
import type { CatalogRow } from '../hvsc/catalog'
import { knownLengths, totalLength } from '../hvsc/catalog'
import type { StilDb } from '../hvsc/stil'
import { stilFor } from '../hvsc/stil'
import type { MusicianDb } from '../hvsc/musicians'
import { musicianForFolder } from '../hvsc/musicians'
import { formatAddress, formatTime } from '../helpers/format'
import { mono as monoText, sectionLabel } from './styles'
import { COLLECTIONS, collectionOf } from './collections'
import type { SidHeader } from '../sid/types'
import type { Picture } from '../sid/picture'
import TunePicture from '../components/TunePicture.vue'
import type { ShownMusDetails } from '../cgsc/details'
import type { ChipModel, ClockMode } from '../composables/usePreferences'

/**
 * The right pane: everything the collection knows about one tune.
 *
 * The three sources read differently and are kept apart on purpose. The
 * header is what the file declares about itself. Songlengths is measured.
 * STIL is editorial - what a tune covers, what the composer said - and only
 * only about a third of the tunes have an entry, so its absence is normal and
 * says nothing about the tune.
 *
 * All three are HVSC's. A tune from Compute's Gazette has none of them: no
 * manifest entry, no commentary, no musician list and no MD5. The sections
 * that would speak for them are left out rather than filled with blanks and
 * an attribution to a file that does not mention the tune - "from
 * Songlengths.md5" under a length nothing measured would simply be untrue.
 */
const { row, stil, musicians, starred, subsong, live, emulation, picture, mus } = defineProps<{
  row: CatalogRow | null
  stil: StilDb | null
  musicians: MusicianDb | null
  starred: boolean
  /** Which subsong is playing, for scoping the commentary. */
  subsong: number
  /**
   * The header of the tune actually loaded in the engine, when this row is
   * the one playing, and null otherwise. It is the live article rather than
   * the catalogue's copy: only it carries the second and third SID a tune
   * asks for, and only it is certainly the file being heard.
   */
  live: SidHeader | null
  /** The chip and machine the listener has chosen, or 'auto' to follow the tune. */
  emulation: { model: ChipModel; clock: ClockMode }
  /**
   * True when this row is the tune in the engine and it is sounding, which is
   * what turns the button below into a Pause. Stopping used to be possible
   * only down in the player bar, so the button that started a tune could not
   * stop it - and went on offering to start the thing already playing.
   */
  playing: boolean
  /**
   * The picture that came with the tune in the engine, where it had one.
   *
   * Only ever the playing tune's: a picture arrives as part of opening a
   * file, so showing one for a row merely selected would mean fetching and
   * decoding its companion on every click. The collection that has pictures
   * is Compute's, whose tunes are played from here, so the one that matters
   * is the one already in hand.
   */
  picture: Picture | null
  /**
   * A Compute's tune's own credits and length, read from its file when it
   * was selected; null until then, and always for an HVSC tune, whose row
   * already carries what its header and the collection's documents say.
   */
  mus?: ShownMusDetails | null
}>()

const emit = defineEmits<{
  (e: 'play', row: CatalogRow): void
  (e: 'pause'): void
  (e: 'star', row: CatalogRow): void
  (e: 'open-folder', path: string): void
  (e: 'search', query: string): void
}>()

/**
 * Whether this row comes from a collection HVSC's documents describe.
 *
 * Everything below is keyed on it rather than on each document being absent,
 * because those two are different states: HVSC documents that have not
 * arrived yet will, and a Compute's tune will never be in them.
 */
const documented = computed(() => COLLECTIONS[collectionOf(row)].documented)

/*
 * What the heading and the chips show: the row's own fields, or for a
 * Compute's tune whatever its file has said once it has been read. Until
 * then the title is the file name, which is all the collection gives.
 */
const title = computed(() => mus?.title || row?.title || row?.stem || '')
const author = computed(() => mus?.author || row?.author)
const released = computed(() => mus?.released || row?.released)
const format = computed(() => mus?.format ?? row?.format)
// A Compute's tune has none until its file has been read; HVSC lists every one.
const md5 = computed(() => row?.md5 || mus?.md5)

const entry = computed(() => (row && stil && documented.value ? stil.get(row.path) : undefined))
const notes = computed(() => stilFor(entry.value, subsong))
const musician = computed(() =>
  row?.composerFolder && musicians && documented.value
    ? musicianForFolder(musicians, row.composerFolder)
    : undefined
)

/* ---- what the tune asks for, and what it is getting --------------------- */

/**
 * The two are not always the same, and until now only the first was shown.
 *
 * libsidplayfp decides it like this (`player.cpp`, `getSidModel` and its
 * clock twin): if the listener has forced a choice, or the tune expresses
 * none, the configured default is used; otherwise the tune's own choice
 * stands. Our defaults are MOS 6581 and PAL, set in `shim.cpp`. That rule is
 * reproduced here rather than read back from the engine, which exposes no
 * getter for it - so if the engine's defaults ever move, these must too.
 */
const ENGINE_DEFAULT_CHIP = '6581'
const ENGINE_DEFAULT_MACHINE = 'pal'

/**
 * The processor clock each machine runs at, as libsidplayfp computes it:
 * the colour burst times four, over the divider that makes the two-phase
 * system clock. PAL-B is 4,433,618.75 x 4 / 18 and NTSC-M 3,579,545.455 x 4
 * / 14, which is where the familiar 985 kHz and 1.02 MHz come from.
 */
const CPU_HZ: Record<'pal' | 'ntsc', number> = { pal: 985248.61, ntsc: 1022727.27 }

/** What the tune asks for, or null where it does not mind. */
const asksChip = computed<'6581' | '8580' | null>(() =>
  live?.sidModel === 'MOS6581' ? '6581' : live?.sidModel === 'MOS8580' ? '8580' : null
)
const asksMachine = computed<'pal' | 'ntsc' | null>(() =>
  live?.clock === 'PAL' ? 'pal' : live?.clock === 'NTSC' ? 'ntsc' : null
)

const chipInUse = computed<'6581' | '8580'>(() =>
  emulation.model !== 'auto' ? emulation.model : (asksChip.value ?? ENGINE_DEFAULT_CHIP)
)
const machineInUse = computed<'pal' | 'ntsc'>(() =>
  emulation.clock !== 'auto' ? emulation.clock : (asksMachine.value ?? ENGINE_DEFAULT_MACHINE)
)

/**
 * Why it is what it is, in the fewest words that are still true. One rule
 * for the chip and the machine: a choice of yours, said against what the
 * tune asks where the two differ; otherwise the tune's, or the default.
 */
const why = (chosen: string, asks: string | null, inUse: string, name: (value: string) => string): string => {
  if (chosen !== 'auto')
    return asks && asks !== inUse ? `your choice; the tune asks for ${name(asks)}` : 'your choice'
  return asks ? 'as the tune asks' : 'the tune does not say, so the default'
}
const chipWhy = computed(() => why(emulation.model, asksChip.value, chipInUse.value, (chip) => `MOS ${chip}`))
const machineWhy = computed(() =>
  why(emulation.clock, asksMachine.value, machineInUse.value, (machine) => machine.toUpperCase())
)

/**
 * The SID chips the tune is written for. A second and third are a v3/v4
 * header field, and the address is how the tune reaches them.
 */
const chips = computed(() => {
  if (!live) return []
  const out = [{ model: live.sidModel, at: '$D400' }]
  if (live.secondSidAddress) out.push({ model: live.secondSidModel, at: formatAddress(live.secondSidAddress) })
  if (live.thirdSidAddress) out.push({ model: live.thirdSidModel, at: formatAddress(live.thirdSidAddress) })
  return out
})

const factRow = { display: 'flex', gap: '8px', fontSize: '12px', alignItems: 'baseline' }
const factName = { width: '62px', flexShrink: 0, color: 'var(--oc-role-on-surface-variant)' }
const factNote = { color: 'var(--oc-role-on-surface-variant)', fontSize: '11px' }

const label = sectionLabel({ marginBottom: '6px' })
const chip = {
  fontSize: '11px',
  color: 'var(--oc-role-on-surface-variant)',
  background: 'var(--oc-role-surface-container)',
  border: '1px solid var(--oc-role-outline-variant)',
  borderRadius: '6px',
  padding: '3px 8px'
}
const mono = monoText('10px', true)
</script>

<template>
  <!-- `sidplayer-detail` is a hook for the browser suite, as the others are -->
  <div
    class="sidplayer-detail"
    :style="{
      width: '330px',
      flexShrink: 0,
      boxSizing: 'border-box',
      padding: '18px',
      overflowY: 'auto',
      background: 'var(--oc-role-surface)',
      borderLeft: '1px solid var(--oc-role-outline-variant)',
      display: 'flex',
      flexDirection: 'column',
      gap: '16px'
    }"
  >
    <p v-if="!row" :style="{ margin: 0, fontSize: '13px', color: 'var(--oc-role-on-surface-variant)' }">
      Select a tune to see what the collection knows about it.
    </p>

    <template v-else>
      <div>
        <h2
          :style="{
            margin: 0,
            fontSize: '19px',
            fontWeight: 600,
            lineHeight: 1.25,
            color: 'var(--oc-role-on-surface)'
          }"
        >
          {{ title }}
        </h2>
        <p :style="{ margin: '4px 0 0', fontSize: '13px', color: 'var(--oc-role-on-surface-variant)' }">
          <button
            v-if="row.composerFolder"
            type="button"
            :style="{
              background: 'transparent',
              border: 0,
              padding: 0,
              font: 'inherit',
              color: 'var(--oc-role-primary)',
              cursor: 'pointer'
            }"
            @click="emit('open-folder', row.folder)"
          >
            {{ author || row.composer }}
          </button>
          <span v-else>{{ author || '—' }}</span>
          <span v-if="released"> &middot; {{ released }}</span>
        </p>
        <p :style="{ margin: '8px 0 0', ...mono, color: 'var(--oc-role-on-surface-variant)' }">
          {{ row.path }}
        </p>
      </div>

      <div :style="{ display: 'flex', flexWrap: 'wrap', gap: '6px' }">
        <span v-if="format" :style="chip">{{ format }}</span>
        <span v-if="row.model && row.model !== 'unknown'" :style="chip"
          >MOS {{ row.model === 'both' ? '6581/8580' : row.model }}</span
        >
        <span v-if="row.clock && row.clock !== 'unknown'" :style="chip">{{
          row.clock === 'both' ? 'PAL/NTSC' : row.clock.toUpperCase()
        }}</span>
        <span :style="chip"
          >{{ row.songs ?? row.lengths.length }} subsong{{
            (row.songs ?? row.lengths.length) === 1 ? '' : 's'
          }}</span
        >
      </div>

      <div :style="{ display: 'flex', gap: '8px' }">
        <oc-button
          appearance="filled"
          size="small"
          :style="{ flexGrow: 1 }"
          @click="playing ? emit('pause') : emit('play', row)"
        >
          {{ playing ? 'Pause' : 'Play' }}
        </oc-button>
        <!--
          Starring is the app's own idea, not HVSC's, so it is offered for a
          Compute's tune too. It keeps only the path, that collection having
          no MD5 anywhere to be robust with.
        -->
        <oc-button
          appearance="outline"
          size="small"
          :aria-pressed="starred"
          :aria-label="starred ? 'Remove from favourites' : 'Add to favourites'"
          @click="emit('star', row)"
        >
          {{ starred ? 'Starred' : 'Star' }}
        </oc-button>
      </div>

      <tune-picture v-if="picture" :picture="picture" />

      <!--
        What the tune is actually being played on, which is not always what it
        asks for: the chip and machine can be overridden in the preferences,
        and a tune that expresses no preference gets the engine's default
        rather than nothing. Only shown for the tune in the engine right now,
        because that is the only one these words are true of.
      -->
      <div v-if="live">
        <div :style="label">Playing on</div>
        <div :style="{ display: 'flex', flexDirection: 'column', gap: '4px' }">
          <div :style="factRow">
            <span :style="factName">Chip</span>
            <span>MOS {{ chipInUse }}</span>
            <span :style="factNote">{{ chipWhy }}</span>
          </div>
          <div :style="factRow">
            <span :style="factName">Machine</span>
            <span>{{ machineInUse.toUpperCase() }}</span>
            <span :style="factNote">{{ machineWhy }}</span>
          </div>
          <div :style="factRow">
            <span :style="factName">Clock</span>
            <span :style="{ fontVariantNumeric: 'tabular-nums' }">
              {{
                CPU_HZ[machineInUse].toLocaleString(undefined, {
                  minimumFractionDigits: 1,
                  maximumFractionDigits: 1
                })
              }}
              Hz
            </span>
            <span :style="factNote">processor</span>
          </div>
          <div v-if="chips.length > 1" :style="factRow">
            <span :style="factName">SIDs</span>
            <span>{{ chips.length }}</span>
            <span :style="factNote">
              <!-- A tune written for more than one chip names where it
                   expects to find them. -->
              {{ chips.map((c) => c.at).join(', ') }}
            </span>
          </div>
        </div>
      </div>

      <div v-if="row.lengths.length">
        <div :style="label">Song length</div>
        <div :style="{ display: 'flex', flexWrap: 'wrap', gap: '6px 12px', fontSize: '13px' }">
          <span v-for="(length, i) in row.lengths" :key="i" :style="{ fontVariantNumeric: 'tabular-nums' }">
            <span
              v-if="row.lengths.length > 1"
              :style="{ color: 'var(--oc-role-on-surface-variant)', fontSize: '11px' }"
            >
              {{ i + 1 }}.
            </span>
            {{ length === undefined ? '—' : formatTime(length) }}
          </span>
        </div>
        <div
          v-if="row.lengths.length > 1"
          :style="{ marginTop: '4px', fontSize: '11px', color: 'var(--oc-role-on-surface-variant)' }"
        >
          <!--
            "at least" where a subsong's time was unreadable, since the total
            is then a sum with a hole in it rather than the playing time.
          -->
          {{ knownLengths(row) < row.lengths.length ? 'at least ' : '' }}{{ formatTime(totalLength(row)) }} in
          total, from Songlengths.md5
        </div>
        <div v-else :style="{ marginTop: '4px', fontSize: '11px', color: 'var(--oc-role-on-surface-variant)' }">
          from Songlengths.md5
        </div>
      </div>
      <div v-else-if="mus && mus.length !== null">
        <div :style="label">Song length</div>
        <div :style="{ fontSize: '13px', fontVariantNumeric: 'tabular-nums' }">
          {{ formatTime(mus.length) }}
        </div>
        <div :style="{ marginTop: '4px', fontSize: '11px', color: 'var(--oc-role-on-surface-variant)' }">
          worked out from its own score
        </div>
      </div>

      <div v-if="notes.title || notes.artist || notes.comment || notes.author">
        <div :style="label">STIL</div>
        <p v-if="notes.title" :style="{ margin: '0 0 4px', fontSize: '13px' }">{{ notes.title }}</p>
        <p
          v-if="notes.artist || notes.author"
          :style="{ margin: '0 0 6px', fontSize: '12px', color: 'var(--oc-role-on-surface-variant)' }"
        >
          {{ notes.artist || notes.author }}
        </p>
        <p
          v-if="notes.comment"
          :style="{ margin: 0, fontSize: '12px', lineHeight: 1.6, color: 'var(--oc-role-on-surface-variant)' }"
        >
          {{ notes.comment }}
        </p>
        <p
          v-if="entry && entry.subsongs.size > 1"
          :style="{ margin: '6px 0 0', fontSize: '11px', color: 'var(--oc-role-on-surface-variant)' }"
        >
          Commentary shown is for subsong {{ subsong }}; {{ entry.subsongs.size }} subsongs have their own.
        </p>
      </div>
      <div v-else-if="documented">
        <div :style="label">STIL</div>
        <p :style="{ margin: 0, fontSize: '12px', color: 'var(--oc-role-on-surface-variant)' }">
          <!-- Counted from what was actually loaded, not from release 85. -->
          No entry for this tune. The commentary covers {{ (stil?.size ?? 0).toLocaleString() }} of them.
        </p>
      </div>

      <!--
        What can be said about a tune the collection documents nowhere: where
        it came from, and that the rest is not missing but absent.
      -->
      <div v-if="!documented">
        <div :style="label">{{ COLLECTIONS[collectionOf(row)].shortLabel }}</div>
        <p
          :style="{ margin: 0, fontSize: '12px', lineHeight: 1.6, color: 'var(--oc-role-on-surface-variant)' }"
        >
          This collection ships no index. The title, credits and length here are read from the tune&rsquo;s own
          file when you select it. A Compute&rsquo;s Gazette MUS file does not record which SID chip or machine
          it was written for, so neither is shown.
        </p>
      </div>

      <div v-if="musician">
        <div :style="label">Composer</div>
        <p :style="{ margin: 0, fontSize: '13px' }">{{ musician.name }}</p>
        <p
          v-if="musician.realName"
          :style="{ margin: '2px 0 0', fontSize: '12px', color: 'var(--oc-role-on-surface-variant)' }"
        >
          {{ musician.realName }}
        </p>
        <p
          v-if="musician.groups.length"
          :style="{ margin: '2px 0 0', fontSize: '12px', color: 'var(--oc-role-on-surface-variant)' }"
        >
          {{ musician.groups.join(', ') }}
        </p>
        <p
          v-if="musician.country"
          :style="{ margin: '2px 0 0', fontSize: '12px', color: 'var(--oc-role-on-surface-variant)' }"
        >
          {{ musician.country }}
        </p>
      </div>

      <div v-if="md5">
        <div :style="label">File</div>
        <p :style="{ margin: 0, ...mono, color: 'var(--oc-role-on-surface-variant)' }">md5 {{ md5 }}</p>
      </div>
    </template>
  </div>
</template>
