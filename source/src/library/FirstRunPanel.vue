<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { MirrorOps } from '../hvsc/mirror'
import { mono as monoText, sectionLabel } from './styles'

/**
 * What the library shows when there is no collection yet.
 *
 * The figures here are rounded on purpose. They were measured against
 * release 85 - 61,157 files and 395 MB - and a panel shown before anything
 * has been fetched cannot know what the next release weighs, so an exact
 * number would go quietly stale while looking authoritative. The release
 * itself is the one figure that is known, from the mirror.
 *
 * Originally: release 85 is 61,157 files
 * averaging 6.5 kB, the mirror serves about 13 files a second at six
 * concurrent requests, and OpenCloud accepts about 14 a second. Saying "about
 * two hours" is therefore honest, and saying it before anything starts
 * matters more than making it sound quick.
 */
const { mirror, hvscPath, mirrorPath } = defineProps<{
  mirror: MirrorOps
  hvscPath: string
  mirrorPath: string
}>()

const emit = defineEmits<{ (e: 'start'): void; (e: 'online'): void }>()

const reachable = ref<boolean | null>(null)
const upstream = ref<number | null>(null)
const checking = ref(true)

onMounted(async () => {
  reachable.value = await mirror.reachable()
  if (reachable.value) upstream.value = await mirror.release()
  checking.value = false
})

const ready = computed(() => reachable.value === true && upstream.value !== null)

const label = sectionLabel()
const mono = monoText('12px')
</script>

<template>
  <div
    :style="{
      flexGrow: 1,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      boxSizing: 'border-box',
      padding: '32px',
      overflowY: 'auto'
    }"
  >
    <div
      :style="{
        width: '100%',
        maxWidth: '720px',
        boxSizing: 'border-box',
        padding: '30px 34px',
        background: 'var(--oc-role-surface)',
        border: '1px solid var(--oc-role-outline-variant)',
        borderRadius: '14px'
      }"
    >
      <h1 :style="{ margin: 0, fontSize: '22px', fontWeight: 600, color: 'var(--oc-role-on-surface)' }">
        Set up your SID library
      </h1>
      <p :style="{ margin: '6px 0 0', fontSize: '13px', color: 'var(--oc-role-on-surface-variant)' }">
        There is no collection at <span :style="mono">{{ hvscPath }}</span> yet.
      </p>

      <div :style="{ marginTop: '22px', display: 'flex', flexDirection: 'column', gap: '10px' }">
        <div :style="{ display: 'flex', alignItems: 'flex-start', gap: '10px' }">
          <span
            :style="{
              marginTop: '2px',
              width: '16px',
              flexShrink: 0,
              color: checking
                ? 'var(--oc-role-on-surface-variant)'
                : reachable
                  ? 'var(--oc-role-primary)'
                  : 'var(--oc-role-error)'
            }"
            aria-hidden="true"
          >
            <svg
              v-if="reachable"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M20 6L9 17l-5-5"></path>
            </svg>
            <svg
              v-else-if="checking"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
            >
              <circle cx="12" cy="12" r="9"></circle>
            </svg>
            <svg
              v-else
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
            >
              <path d="M6 6l12 12M18 6L6 18"></path>
            </svg>
          </span>
          <div>
            <div :style="{ fontSize: '13px', fontWeight: 500, color: 'var(--oc-role-on-surface)' }">
              <template v-if="checking">Checking the mirror</template>
              <template v-else-if="ready">Mirror is reachable, offering release {{ upstream }}</template>
              <template v-else-if="reachable">Mirror answers but its release number could not be read</template>
              <template v-else>Mirror is not reachable</template>
            </div>
            <div
              :style="{
                marginTop: '2px',
                ...mono,
                fontSize: '11px',
                color: 'var(--oc-role-on-surface-variant)'
              }"
            >
              {{ mirrorPath }}
            </div>
            <p
              v-if="reachable === false"
              :style="{
                margin: '6px 0 0',
                fontSize: '12px',
                color: 'var(--oc-role-on-surface-variant)',
                lineHeight: 1.6
              }"
            >
              This path has to forward to an HVSC mirror on this instance's own origin; the browser cannot reach
              HVSC directly, because its version API refuses requests carrying an
              <span :style="mono">Origin</span> header and the mirror sends no CORS headers.
              <span :style="mono">deploy/haproxy-hvsc.cfg</span> is the snippet to add.
            </p>
          </div>
        </div>

        <div :style="{ display: 'flex', alignItems: 'flex-start', gap: '10px' }">
          <span
            :style="{ marginTop: '2px', width: '16px', flexShrink: 0, color: 'var(--oc-role-primary)' }"
            aria-hidden="true"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M20 6L9 17l-5-5"></path>
            </svg>
          </span>
          <div>
            <div :style="{ fontSize: '13px', fontWeight: 500, color: 'var(--oc-role-on-surface)' }">
              The collection stays yours
            </div>
            <div
              :style="{
                marginTop: '2px',
                fontSize: '12px',
                color: 'var(--oc-role-on-surface-variant)',
                lineHeight: 1.6
              }"
            >
              It is written to <span :style="mono">{{ hvscPath }}</span> in your own space, so it is browsable
              in Files, shareable, and syncable to a desktop client like anything else you own.
            </div>
          </div>
        </div>
      </div>

      <div
        :style="{
          marginTop: '22px',
          boxSizing: 'border-box',
          padding: '16px 18px',
          background: 'var(--oc-role-surface-container)',
          borderRadius: '10px'
        }"
      >
        <div :style="label">Two ways to start</div>
        <p
          :style="{
            margin: '10px 0 0',
            fontSize: '12px',
            lineHeight: 1.6,
            color: 'var(--oc-role-on-surface-variant)'
          }"
        >
          <strong :style="{ color: 'var(--oc-role-on-surface)' }">Online</strong> fetches only the collection's
          documents, about 9 MB: the whole release can be browsed and searched at once, and each tune is fetched
          and kept the first time you play it. A tune's title, year and chip are known once it has been played.
          You can download the rest at any time.
        </p>
        <p
          :style="{
            margin: '8px 0 0',
            fontSize: '12px',
            lineHeight: 1.6,
            color: 'var(--oc-role-on-surface-variant)'
          }"
        >
          <strong :style="{ color: 'var(--oc-role-on-surface)' }">Download everything</strong> fetches the whole
          release now:
        </p>
        <div
          :style="{
            marginTop: '10px',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
            gap: '12px'
          }"
        >
          <div>
            <div
              :style="{
                fontSize: '18px',
                fontVariantNumeric: 'tabular-nums',
                color: 'var(--oc-role-on-surface)'
              }"
            >
              ~61,000
            </div>
            <div :style="{ fontSize: '11px', color: 'var(--oc-role-on-surface-variant)' }">
              tunes in release {{ upstream ?? 85 }}
            </div>
          </div>
          <div>
            <div
              :style="{
                fontSize: '18px',
                fontVariantNumeric: 'tabular-nums',
                color: 'var(--oc-role-on-surface)'
              }"
            >
              ~400 MB
            </div>
            <div :style="{ fontSize: '11px', color: 'var(--oc-role-on-surface-variant)' }">
              including the documents
            </div>
          </div>
          <div>
            <div
              :style="{
                fontSize: '18px',
                fontVariantNumeric: 'tabular-nums',
                color: 'var(--oc-role-on-surface)'
              }"
            >
              ~2 hours
            </div>
            <div :style="{ fontSize: '11px', color: 'var(--oc-role-on-surface-variant)' }">
              resumable, in this tab
            </div>
          </div>
        </div>
        <p
          :style="{
            margin: '12px 0 0',
            fontSize: '12px',
            lineHeight: 1.6,
            color: 'var(--oc-role-on-surface-variant)'
          }"
        >
          Every file is checked against the collection's own MD5 manifest, so an interrupted download repairs
          itself next time rather than starting again. You can browse and search the whole release while it
          runs; tunes that have not arrived yet are fetched on demand when you play them.
        </p>
      </div>

      <div :style="{ marginTop: '20px', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }">
        <oc-button appearance="filled" :disabled="!ready" @click="emit('online')"> Start online </oc-button>
        <oc-button appearance="outline" :disabled="!ready" @click="emit('start')">
          Download release {{ upstream ?? '' }}
        </oc-button>
        <span :style="{ fontSize: '12px', color: 'var(--oc-role-on-surface-variant)' }">
          Already have a copy? Put it at <span :style="mono">{{ hvscPath }}</span> and reopen this page.
        </span>
      </div>
    </div>
  </div>
</template>
