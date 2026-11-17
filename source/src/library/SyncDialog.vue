<script setup lang="ts">
import { computed } from 'vue'
import type { SyncState } from './useLibrary'
import { formatBytes } from '../helpers/format'
import { mono as monoText, sectionLabel } from './styles'

/**
 * The sync, as a panel over the library.
 *
 * It shows the plan before anything is written, which is what makes the
 * removals policy work: a stateless MD5 diff cannot tell a tune HVSC
 * withdrew from a file of the user's own that happens to sit under the
 * collection, so the list is shown and the deletions wait for a yes.
 */
const { sync, release, upstream, progressText } = defineProps<{
  sync: SyncState
  release: number | null
  upstream: number | null
  /** What the library is saying about the folder walk, while planning. */
  progressText?: string
}>()

const emit = defineEmits<{
  (e: 'start'): void
  (e: 'pause'): void
  (e: 'cancel'): void
  (e: 'close'): void
  (e: 'removals', choice: 'approved' | 'skip'): void
}>()

const plan = computed(() => sync.plan)
/** Whether Pause and Stop still have something to act on. */
const stoppable = computed(
  () => sync.state === 'running' && !!sync.progress && sync.progress.done < sync.progress.total
)
const progress = computed(() => sync.progress)
const percent = computed(() => {
  const p = progress.value
  if (!p || !p.total) return 0
  return Math.round((p.done / p.total) * 100)
})

/**
 * Seconds left, from the rate so far. Nothing is shown until enough files
 * have gone by for the number to mean anything.
 */
const remaining = computed(() => {
  const p = progress.value
  if (!p || !sync.startedAt || p.done < 20) return null
  const elapsed = (Date.now() - sync.startedAt) / 1000
  const rate = p.done / elapsed
  if (!Number.isFinite(rate) || rate <= 0) return null
  const seconds = Math.round((p.total - p.done) / rate)
  if (seconds < 90) return `${seconds} s`
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`
  return `${(seconds / 3600).toFixed(1)} h`
})

const label = sectionLabel()
const stat = {
  boxSizing: 'border-box' as const,
  padding: '9px 10px',
  background: 'var(--oc-role-surface-container)',
  borderRadius: '8px'
}
const number = {
  fontSize: '16px',
  fontVariantNumeric: 'tabular-nums' as const,
  color: 'var(--oc-role-on-surface)'
}
const caption = { marginTop: '2px', fontSize: '11px', color: 'var(--oc-role-on-surface-variant)' }
const mono = monoText('11px')

const sign = { add: '+', replace: '~', remove: '−', fail: '!' } as const
</script>

<template>
  <div
    :style="{
      position: 'absolute',
      inset: 0,
      background: 'rgba(0, 0, 0, 0.42)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px',
      zIndex: 10
    }"
  >
    <div
      role="dialog"
      aria-label="Updating the collection"
      :style="{
        width: '100%',
        maxWidth: '620px',
        maxHeight: '100%',
        overflowY: 'auto',
        boxSizing: 'border-box',
        padding: '22px',
        background: 'var(--oc-role-surface)',
        borderRadius: '12px',
        boxShadow: '0 24px 64px rgba(0, 0, 0, 0.28)',
        display: 'flex',
        flexDirection: 'column',
        gap: '16px'
      }"
    >
      <div :style="{ display: 'flex', alignItems: 'flex-start', gap: '12px' }">
        <div :style="{ flexGrow: 1 }">
          <h2 :style="{ margin: 0, fontSize: '17px', fontWeight: 600, color: 'var(--oc-role-on-surface)' }">
            <template v-if="sync.state === 'planning'">Working out what is needed</template>
            <template v-else-if="sync.state === 'running' && release === null && upstream !== null">
              Fetching release {{ upstream }}
            </template>
            <template v-else-if="sync.state === 'running'"
              >Updating to release {{ upstream ?? release }}</template
            >
            <template v-else-if="sync.state === 'paused'">Paused</template>
            <template v-else-if="sync.state === 'done'">{{
              sync.error ? 'Not finished' : 'Up to date'
            }}</template>
            <template v-else>Update the collection</template>
          </h2>
          <p :style="{ margin: '4px 0 0', fontSize: '12px', color: 'var(--oc-role-on-surface-variant)' }">
            Comparing the release manifest against your copy, file by file, by MD5.
          </p>
        </div>
        <oc-button appearance="raw" size="small" aria-label="Hide this panel" @click="emit('close')">
          Close
        </oc-button>
      </div>

      <p v-if="sync.error" :style="{ margin: 0, fontSize: '13px', color: 'var(--oc-role-error)' }">
        {{ sync.error }}
      </p>
      <p
        v-else-if="sync.notice"
        :style="{ margin: 0, fontSize: '13px', color: 'var(--oc-role-on-surface-variant)' }"
      >
        {{ sync.notice }}
      </p>

      <!--
        Planning is not instant on a real collection: `Depth: infinity` is
        refused, so taking stock means listing about 1,951 folders. Saying so,
        with the running count, is the difference between working and hung.
      -->
      <div
        v-if="sync.state === 'planning'"
        :style="{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          fontSize: '13px',
          color: 'var(--oc-role-on-surface-variant)'
        }"
      >
        <oc-spinner size="small" aria-label="Working out what is needed" />
        <span>{{ progressText || 'Listing what you already have, folder by folder' }}</span>
      </div>

      <!-- the plan, before anything is written -->
      <template v-if="plan && sync.state === 'idle'">
        <div
          :style="{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: '8px' }"
        >
          <div v-if="sync.scope === 'present'" :style="stat">
            <div :style="number">{{ plan.add.length.toLocaleString() }}</div>
            <div :style="caption">fetched when played</div>
          </div>
          <div v-else :style="stat">
            <div :style="number">{{ plan.add.length.toLocaleString() }}</div>
            <div :style="caption">to download</div>
          </div>
          <div :style="stat">
            <div :style="number">{{ plan.replace.length.toLocaleString() }}</div>
            <div :style="caption">to replace</div>
          </div>
          <div :style="stat">
            <div :style="number">{{ plan.remove.length.toLocaleString() }}</div>
            <div :style="caption">no longer in HVSC</div>
          </div>
          <div :style="stat">
            <div :style="number">{{ plan.unchanged.toLocaleString() }}</div>
            <div :style="caption">already correct</div>
          </div>
        </div>

        <div v-if="plan.remove.length">
          <div :style="label">Files the release no longer has</div>
          <div
            :style="{
              marginTop: '6px',
              maxHeight: '140px',
              overflowY: 'auto',
              padding: '8px 10px',
              background: 'var(--oc-role-surface-container)',
              borderRadius: '8px',
              ...mono,
              lineHeight: 1.7,
              color: 'var(--oc-role-on-surface-variant)'
            }"
          >
            <div v-for="path in plan.remove.slice(0, 200)" :key="path">{{ path }}</div>
            <div v-if="plan.remove.length > 200">
              …and {{ (plan.remove.length - 200).toLocaleString() }} more
            </div>
          </div>
          <div
            :style="{ marginTop: '8px', display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }"
          >
            <oc-button
              size="small"
              :appearance="sync.removals === 'approved' ? 'filled' : 'outline'"
              @click="emit('removals', 'approved')"
            >
              Delete these too
            </oc-button>
            <oc-button
              size="small"
              :appearance="sync.removals === 'skip' ? 'filled' : 'outline'"
              @click="emit('removals', 'skip')"
            >
              Keep them
            </oc-button>
            <span :style="{ fontSize: '11px', color: 'var(--oc-role-on-surface-variant)' }">
              Deletions go to your trash, and are skipped unless you choose.
            </span>
          </div>
        </div>

        <p
          v-if="plan.unverified.length"
          :style="{ margin: 0, fontSize: '12px', color: 'var(--oc-role-on-surface-variant)' }"
        >
          {{ plan.unverified.length.toLocaleString() }} files report no checksum, so they are assumed correct
          rather than downloaded again.
        </p>
      </template>

      <!--
        A run with no tunes in it - an online collection's start, or an update
        with nothing to refresh - is only the documents: a count of nought
        files says nothing, so this says what is happening instead.
      -->
      <div
        v-if="sync.state === 'running' && progress && !progress.total"
        :style="{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          fontSize: '13px',
          color: 'var(--oc-role-on-surface-variant)'
        }"
      >
        <oc-spinner size="small" aria-label="Fetching the collection documents" />
        <span>{{ progressText || 'Fetching the collection documents' }}</span>
      </div>
      <p
        v-if="sync.state === 'done' && !sync.error && sync.scope === 'present'"
        :style="{ margin: 0, fontSize: '13px', color: 'var(--oc-role-on-surface-variant)', lineHeight: 1.6 }"
      >
        The whole release can be browsed and searched. Each tune is fetched into your space the first time you
        play it, and <strong>Download all…</strong> fetches the rest whenever you choose.
      </p>

      <!-- progress, while it runs -->
      <template v-if="progress && progress.total && sync.state !== 'idle'">
        <div>
          <div :style="{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }">
            <span
              :style="{
                fontSize: '24px',
                fontVariantNumeric: 'tabular-nums',
                color: 'var(--oc-role-on-surface)'
              }"
            >
              {{ percent }}%
            </span>
            <span :style="{ fontSize: '12px', color: 'var(--oc-role-on-surface-variant)' }">
              {{ progress.done.toLocaleString() }} of {{ progress.total.toLocaleString() }} files &middot;
              {{ formatBytes(progress.bytes) }}
              <template v-if="remaining"> &middot; about {{ remaining }} left</template>
            </span>
          </div>
          <div
            :style="{
              marginTop: '8px',
              height: '8px',
              background: 'var(--oc-role-surface-container)',
              borderRadius: '4px',
              overflow: 'hidden'
            }"
          >
            <div :style="{ width: `${percent}%`, height: '100%', background: 'var(--oc-role-primary)' }"></div>
          </div>
        </div>

        <div
          :style="{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))', gap: '8px' }"
        >
          <div :style="stat">
            <div :style="number">{{ progress.added.toLocaleString() }}</div>
            <div :style="caption">added</div>
          </div>
          <div :style="stat">
            <div :style="number">{{ progress.replaced.toLocaleString() }}</div>
            <div :style="caption">replaced</div>
          </div>
          <div :style="stat">
            <div :style="number">{{ progress.removed.toLocaleString() }}</div>
            <div :style="caption">removed</div>
          </div>
          <div :style="stat">
            <div :style="number">{{ progress.failed.toLocaleString() }}</div>
            <div :style="caption">failed</div>
          </div>
        </div>

        <div v-if="progress.recent.length">
          <div :style="label">Latest</div>
          <div
            :style="{
              marginTop: '6px',
              padding: '8px 10px',
              background: 'var(--oc-role-surface-container)',
              borderRadius: '8px',
              ...mono,
              lineHeight: 1.8,
              color: 'var(--oc-role-on-surface-variant)'
            }"
          >
            <div v-for="(item, i) in progress.recent" :key="`${item.path}-${i}`">
              <span :style="{ color: 'var(--oc-role-on-surface)' }">{{ sign[item.action] }}</span>
              {{ item.path.replace(/^\//, '') }}
            </div>
          </div>
        </div>
      </template>

      <div :style="{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }">
        <span :style="{ flexGrow: 1, fontSize: '12px', color: 'var(--oc-role-on-surface-variant)' }">
          <!--
            It used to say leaving the page stopped the run, which was never
            true of moving to Files and is no longer true of anything: the
            library belongs to the page, so the run carries on and the bar at
            the top keeps count. Closing the tab is what stops it.
          -->
          <template v-if="sync.state === 'running'">
            This keeps running while you use the rest of the app. Closing the tab stops it, and the next run
            works out what is left from the checksums.
          </template>
          <template v-else-if="sync.state === 'paused'">
            Nothing is lost: resuming carries on from where it stopped.
          </template>
        </span>
        <!--
          Only while tunes are being fetched: once they are, the documents
          follow in a second or two and a press would have nothing to stop.
        -->
        <oc-button v-if="stoppable" size="small" appearance="outline" @click="emit('pause')"> Pause </oc-button>
        <oc-button v-if="stoppable" size="small" appearance="outline" @click="emit('cancel')"> Stop </oc-button>
        <oc-button
          v-if="sync.state === 'idle' || sync.state === 'paused'"
          appearance="filled"
          size="small"
          :disabled="sync.state === 'idle' && !plan"
          @click="emit('start')"
        >
          {{ sync.state === 'paused' ? 'Resume' : 'Start' }}
        </oc-button>
        <oc-button v-if="sync.state === 'done'" appearance="filled" size="small" @click="emit('close')">
          Done
        </oc-button>
      </div>
    </div>
  </div>
</template>
