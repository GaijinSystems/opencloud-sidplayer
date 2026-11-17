<template>
  <div
    ref="root"
    class="sidplayer"
    tabindex="-1"
    :style="{
      display: 'flex',
      flexDirection: 'column',
      width: '100%',
      height: '100%',
      outline: 'none',
      background: 'var(--oc-role-surface)',
      color: 'var(--oc-role-on-surface)'
    }"
    @keydown="onKeydown"
  >
    <div
      v-if="loading"
      :style="{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '16px',
        flex: 1
      }"
    >
      <oc-spinner aria-label="Opening tune" size="xlarge" />
    </div>

    <player-error
      v-else-if="openError"
      :error="openError"
      :file-name="fileName"
      :download-url="downloadUrl"
      @retry="load"
    />

    <template v-else-if="header">
      <!-- The engine failing is as much a dead end as the file failing, so it
           gets the same full-size explanation, with the bar kept underneath so
           the failure is legible as "this tune, this state". -->
      <player-error
        v-if="player.state.value === 'failed' && player.error.value"
        :style="{ flex: 1, minHeight: 0 }"
        :error="player.error.value"
        :file-name="fileName"
        :download-url="downloadUrl"
        @retry="load"
      />
      <!-- min-height: 0 is load-bearing: a flex item defaults to min-height
           auto and could not otherwise shrink below its content, pushing the
           bar off the bottom on a short window. -->
      <song-info
        v-else
        :style="{ flex: 1, minHeight: 0 }"
        :header="header"
        :subsong="player.subsong.value"
        :title="title"
        :words="words"
        :picture="picture"
        :details="prefs.details"
        :length-source="session.lengthSource.value"
        :hvsc-path="isMine ? session.current.value?.hvscPath : undefined"
        @toggle-details="prefs.details = !prefs.details"
      />

      <player-bar :session="session" :title="title" />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Resource, SpaceResource } from '@opencloud-eu/web-client'
import { useDocumentTitle, type AppWrapperSlotProps } from '@opencloud-eu/web-pkg'

import PlayerBar from './components/PlayerBar.vue'
import PlayerError from './components/PlayerError.vue'
import SongInfo from './components/SongInfo.vue'
import { useSession } from './player/session'

/**
 * The full view: a window onto the page-wide session, which owns the sound.
 * Opening this route with a tune already playing in the dock attaches to it
 * without a restart; leaving the route leaves the music running and hands
 * the controls back to the dock.
 *
 * Only the props this component genuinely uses are declared, and that is
 * load-bearing: AppWrapper inspects the wrapped component's props to decide
 * what to fetch. Declaring `currentContent` or `url` would make it GET the
 * file before we run.
 */
const { space, resource } = defineProps<Pick<AppWrapperSlotProps, 'space' | 'resource'>>()

const session = useSession()
const { config, prefs, player } = session

const root = ref<HTMLElement | null>(null)

/** The type allows a nameless resource; a viewer never gets one, but the fallback costs nothing. */
const fileName = computed(() => (resource as Resource).name ?? 'tune.sid')
/** This view is about the routed file; the session may briefly hold another while switching. */
const isMine = computed(() => session.isCurrent(resource as Resource, space as SpaceResource))
const loading = computed(() => !isMine.value || session.loading.value)
const openError = computed(() => (isMine.value ? session.error.value : null))
const header = computed(() => (isMine.value ? session.header.value : null))
const words = computed(() => (isMine.value ? session.words.value : []))
const picture = computed(() => (isMine.value ? session.picture.value : null))
const title = computed(() => (isMine.value ? session.title.value : fileName.value))
const playerFailed = computed(
  () => isMine.value && player.state.value === 'failed' && Boolean(player.error.value)
)

/* ---- a download link, resolved only while a failure is on screen ------- */
/*
 * The installed web client's `getFileUrl` is not a link builder: it fetches
 * the whole file again as a blob and hands back an object URL. Resolving it
 * after every successful open was therefore a second full GET per tune and a
 * blob left behind on each one, since the next open overwrote the ref without
 * revoking it. Nothing but the two error panels ever reads this.
 */
const downloadUrl = ref<string | null>(null)
let urlGeneration = 0
const releaseDownloadUrl = () => {
  if (downloadUrl.value) session.webdav.revokeUrl(downloadUrl.value)
  downloadUrl.value = null
}
watch(
  () => Boolean(openError.value) || playerFailed.value,
  (failed) => {
    const gen = ++urlGeneration
    releaseDownloadUrl()
    if (!failed) return
    void session.downloadUrl().then((url) => {
      // Something newer owns the panel now, so this blob would never be
      // reached again; let go of it rather than of the one on screen.
      if (gen !== urlGeneration) {
        if (url) session.webdav.revokeUrl(url)
        return
      }
      downloadUrl.value = url
    })
  },
  { immediate: true }
)

// Browser tab title, so a tune open in a background tab is identifiable.
useDocumentTitle({
  titleSegments: computed(() => [title.value, 'SID Player'].filter(Boolean))
})

async function load() {
  await session.play(space as SpaceResource, resource as Resource, { autoplay: config.autoPlay })
}

// Reopening on a different file happens when the user picks another tune
// without leaving the app.
watch(
  () => (resource as Resource)?.id,
  () => void load()
)

/*
 * And the other way round: the session moving on to another tune while this
 * view is open - the next in a list, at the end of one or by the keys - takes
 * the view with it. This view is about the routed file, and with the session
 * holding a different one it waited for that file for ever, a spinner over a
 * tune that was playing.
 */
watch(
  () => session.current.value?.resource,
  (now) => {
    if (now && !session.isCurrent(resource as Resource, space as SpaceResource))
      session.openFullView({ replace: true })
  }
)

/** Toolbar controls handle their own keys; the player must not eat them. */
function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest('button, input, select, a, [role="dialog"]'))
}

function onKeydown(event: KeyboardEvent) {
  // Leave browser and OS shortcuts alone.
  if (event.ctrlKey || event.metaKey || event.altKey) return
  if (event.key === ' ' && isInteractiveTarget(event.target)) return
  if (event.target instanceof HTMLInputElement) return

  switch (event.key) {
    case ' ':
      event.preventDefault()
      player.toggle()
      break
    case 'ArrowRight':
      event.preventDefault()
      player.next()
      break
    case 'ArrowLeft':
      event.preventDefault()
      player.previous()
      break
    case 'Home':
      event.preventDefault()
      void player.restart()
      break
    // Along the list this tune was played from, rather than within the file.
    case 'PageDown':
      event.preventDefault()
      void session.nextTune()
      break
    case 'PageUp':
      event.preventDefault()
      void session.previousTune()
      break
    case 'ArrowUp':
      event.preventDefault()
      session.setVolume(Math.min(1, prefs.volume + 0.05))
      break
    case 'ArrowDown':
      event.preventDefault()
      session.setVolume(Math.max(0, prefs.volume - 0.05))
      break
    case 'm':
      session.setMuted(!prefs.muted)
      break
    case 's':
      prefs.analyser = !prefs.analyser
      break
    case 'i':
      prefs.details = !prefs.details
      break
    case '1':
    case '2':
    case '3':
      player.toggleVoice(Number(event.key) - 1)
      break
  }
}

onMounted(async () => {
  if (root.value) session.registerThemeRoot(root.value)
  // Keyboard control only works if the player holds focus on open.
  root.value?.focus()
  await load()
})

onBeforeUnmount(() => {
  if (root.value) session.unregisterThemeRoot(root.value)
  urlGeneration++
  releaseDownloadUrl()
  // The session keeps playing; the dock takes over.
})
</script>
