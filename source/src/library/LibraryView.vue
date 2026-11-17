<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useDocumentTitle, useSpacesStore } from '@opencloud-eu/web-pkg'
import PlayerBar from '../components/PlayerBar.vue'
import TreePane from './TreePane.vue'
import TuneTable from './TuneTable.vue'
import DetailPane from './DetailPane.vue'
import ComposerGrid from './ComposerGrid.vue'
import FirstRunPanel from './FirstRunPanel.vue'
import SyncDialog from './SyncDialog.vue'
import { useSession } from '../player/session'
import { useLibrary, type Collection, type ComposerEntry, type LibraryMode } from './useLibrary'
import { COLLECTIONS, collectionOf } from './collections'
import { rowKey, type CatalogRow } from '../hvsc/catalog'
import type { HeaderOnlyFilter } from '../hvsc/search'

/**
 * The standalone library: the collection on the left, its tunes in the
 * middle, one tune's story on the right, and the same player underneath that
 * the Files integration uses - the session is page-wide, so a tune started
 * here keeps playing when you leave for Files, where the dock picks it up.
 */
const session = useSession()
const { config, prefs, player } = session
const spaces = useSpacesStore()

/*
 * One library for the page, not one per mount: a sync or a header pass keeps
 * running while the user is in Files, and coming back finds it where they
 * left it rather than building a second catalogue over the same 61,157 rows.
 */
const library = useLibrary({
  webdav: session.webdav,
  // A getter: the library outlives this mount, and the spaces may not have
  // loaded yet when it is first made.
  space: () => spaces.personalSpace,
  config,
  // Every tune the library plays comes from the list it has just handed over.
  play: (space, resource, options) => session.play(space, resource, { ...options, fromQueue: true }),
  // What the player should treat as the running order: the list as it stands
  // at the moment something in it is played. Only taken here; the library
  // then plays the tune itself, and `playQueue` playing it as well ran every
  // library play twice.
  setQueue: (queue) => session.setQueue(queue)
})

const root = ref<HTMLElement | null>(null)
const searchField = ref<HTMLInputElement | null>(null)
const syncOpen = ref(false)

useDocumentTitle({
  titleSegments: computed(() => [session.title.value, 'SID Library'].filter(Boolean))
})

/** One object for as long as the choices stand, rather than a new one for the detail pane on every render. */
const emulation = computed(() => ({ model: prefs.chipModel, clock: prefs.clock }))

/**
 * The shell's own search, hidden while the library is open.
 *
 * `#files-global-search` in the topbar sits 58 px above ours, centred, and
 * within 12 px of the same width, so the two read as one control duplicated
 * rather than as two different searches - one over your files, one over the
 * collection.
 *
 * This is our CSS reaching outside our own root, which is why it is a
 * stylesheet that exists only while this view is mounted rather than an
 * inline style on an element the shell owns and may re-render. If OpenCloud
 * ever renames that element the rule simply matches nothing and both bars
 * come back, which is where we started; `e2e/library.mjs` checks for it so
 * the day it happens is not a surprise.
 */
const GLOBAL_SEARCH_STYLE = 'sidplayer-hide-global-search'

const hideGlobalSearch = (): void => {
  if (document.getElementById(GLOBAL_SEARCH_STYLE)) return
  const style = document.createElement('style')
  style.id = GLOBAL_SEARCH_STYLE
  style.textContent = '#files-global-search { display: none !important; }'
  document.head.appendChild(style)
}
const restoreGlobalSearch = (): void => {
  document.getElementById(GLOBAL_SEARCH_STYLE)?.remove()
}

onMounted(() => {
  if (root.value) session.registerThemeRoot(root.value)
  /*
   * Only the first time. The library outlives this view now, so a second
   * mount would otherwise re-read the documents and rebuild the catalogue
   * behind a spinner over a library that is already open. A failed one is
   * worth another try, which is also what the "Try again" button does.
   */
  if (library.phase.value === 'starting' || library.phase.value === 'failed') void library.init()
  // Capture, because the shell closes the whole app on Escape and a
  // bubble-phase listener stops the event too late to prevent that.
  document.addEventListener('keydown', onKey, true)
  hideGlobalSearch()
})
onBeforeUnmount(() => {
  if (root.value) session.unregisterThemeRoot(root.value)
  document.removeEventListener('keydown', onKey, true)
  restoreGlobalSearch()
})

/** Keys the library adds; the player's own keys stay with the player bar. */
const onKey = (event: KeyboardEvent): void => {
  const target = event.target as HTMLElement | null
  const typing =
    target &&
    (target.tagName === 'INPUT' ||
      target.tagName === 'SELECT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable)
  if (event.key === '/' && !typing && !syncOpen.value) {
    event.preventDefault()
    searchField.value?.focus()
    return
  }
  if (event.key === 'Escape' && typing && target === searchField.value) {
    /*
     * Escape in the search field returns to the folder rather than closing
     * the whole app, which is what the shell would otherwise do. Stopped
     * immediately as well as generally: the shell's own handler is on
     * `document` too, and plain `stopPropagation` from a listener on the
     * same node does not keep it from running.
     */
    event.stopImmediatePropagation()
    event.stopPropagation()
    event.preventDefault()
    leaveSearch()
    searchField.value?.blur()
  }
}

/** Tunes whose header has not been read yet, which is what indexing is for. */
const unindexed = computed(() =>
  library.rows.value.reduce((n, row) => (row.title === undefined ? n + 1 : n), 0)
)

const counts = computed(() => ({
  total: library.rows.value.length,
  favourites: library.favourites.value.items.length
}))

/** Both collections, which is what the search box searches. */
const searchable = computed(() => library.rows.value.length + library.cgsc.rows.value.length)

/**
 * Why the second collection has nothing to show for a filter.
 *
 * A search for `year:1987` matches no Compute's tune, and the reason is not
 * that there are none: the collection is catalogued from file names, and a
 * file name does not say what year anything is from. Saying so is the
 * difference between an answer and a silence that reads like one.
 */
const FILTER_REASONS: Record<HeaderOnlyFilter, string> = {
  year: 'a year',
  chip: 'a chip model',
  clock: 'a clock speed',
  stil: 'any commentary'
}

const cgscNote = computed<string | undefined>(() => {
  const missing = library.unanswerable.value.map((name) => FILTER_REASONS[name])
  if (!missing.length) return undefined
  const list =
    missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(', ')} or ${missing[missing.length - 1]}`
  return `Nothing here records ${list}, so this search cannot reach it.`
})

/** The library's blocks, with that note attached to the one it is about. */
const listBlocks = computed(() =>
  library.blocks.value.map((block) =>
    block.key !== 'only' && !COLLECTIONS[block.key].headers ? { ...block, note: cgscNote.value } : block
  )
)

/** Which subsong the commentary should describe. */
const subsong = computed(() => player.subsong.value || 1)

/**
 * The header of the tune in the engine, but only when the row on the right is
 * that tune. Anything the "Playing on" section says is about the file
 * actually loaded, so attaching it to some other selected row would be a
 * plain untruth.
 */
/**
 * Anything gone wrong that a person should be told about, from either half of
 * the app.
 *
 * The library's own troubles are one source; the other is the player, and
 * until now the library showed none of it. `session.error` and
 * `player.error` were rendered only by the full view, so a tune that would
 * not open here - a read refused, an engine that gave up - failed in perfect
 * silence: the row highlighted, the detail pane filled in from the catalogue,
 * and nothing ever said why no sound followed.
 */
const trouble = computed<string | null>(() => {
  if (library.error.value) return library.error.value
  // Before the player's: when a fetch failed, the 404 the play then met is
  // the less useful half of the story.
  if (library.playError.value) return library.playError.value
  if (session.error.value) return session.error.value.message
  if (player.state.value === 'failed' && player.error.value) return player.error.value.message
  return null
})

/**
 * Whether the reader has waved the current message away. Until it changes:
 * matched by its text instead, a dismissed message stayed hidden every time
 * the same thing went wrong again, however much later.
 */
const dismissed = ref(false)
watch(trouble, () => {
  dismissed.value = false
})
const showTrouble = computed(() => (trouble.value && !dismissed.value ? trouble.value : null))

const selectedIsCurrent = computed(() => {
  const selected = library.selected.value
  return !!selected && playingRow.value === rowKey(selected)
})

const liveHeader = computed(() => (selectedIsCurrent.value ? player.header.value : null))

/** Whether the tune on the right is the one sounding, which makes its button a Pause. */
const selectedIsPlaying = computed(() => selectedIsCurrent.value && player.state.value === 'playing')

/**
 * Which row is sounding, taken from the player rather than from the library.
 *
 * The library only knows what it last asked to play, so the highlight stayed
 * on a tune stopped from the dock and reset every time this view was
 * remounted while the sound carried on. The player's current resource is the
 * truth. A tune played from the library carries its row's key as its id; one
 * started from Files is found by its path, so it is highlighted too.
 */
const playingRow = computed(() => {
  const now = session.current.value
  return now ? library.keyOfPlaying(now.resource, now.space) : null
})

/**
 * Where the second collection stands, on the root as `data-cgsc`: a signal a
 * browser test can wait on, rather than guessing how long a read will take.
 */
const cgscState = computed(() => {
  if (library.phase.value !== 'ready') return 'waiting'
  if (library.cgsc.loading.value) return 'loading'
  return library.cgsc.rows.value.length ? 'present' : 'absent'
})

const onMode = (mode: LibraryMode): void => {
  library.mode.value = mode
  if (mode !== 'search') library.query.value = ''
}

const onOpen = (path: string, which: Collection = 'hvsc'): void => library.openFolder(path, which)

/** The detail pane's folder link belongs to whichever collection its row does. */
const onOpenRowFolder = (path: string): void => onOpen(path, collectionOf(library.selected.value))

const onPlayAll = async (entry: ComposerEntry): Promise<void> => {
  /*
   * The folder first, then the tune: what plays takes the list in front of
   * it as the running order, and played from the composer grid that list was
   * empty, so "Play all" played one tune and stopped. The entry carries its
   * own folder, because HVSC files composers whose name starts with a digit
   * under `0-9` rather than under that digit - and the folder rather than an
   * example's, which may be a subfolder of it.
   */
  library.openFolder(entry.path)
  const first = library.visible.value[0]
  if (first) await library.play(first)
}

/** Opens the sync panel over whatever the library is about to plan or run. */
const withPanel = (action: () => Promise<unknown>) => async (): Promise<void> => {
  syncOpen.value = true
  await action()
}
const startUpdate = withPanel(() => library.planUpdate())
/** The whole release, from the first-run screen or an online collection: always asked for by name. */
const downloadAll = withPanel(() => library.planUpdate('all'))
/** An online collection: the documents now, the panel showing them arrive. */
const startOnline = withPanel(() => library.startOnline())

watch(
  () => library.sync.value.state,
  (state) => {
    if (state === 'running' || state === 'planning') syncOpen.value = true
  }
)

/*
 * The results row reads the same way in every mode: where you are on the
 * left, how many on the right. The count used to be the tail of the search
 * breadcrumb, where it scanned as part of a path and moved about depending
 * on how long the query was; on the right it lands in the same place
 * whatever you are looking at.
 */
const breadcrumb = computed(() => {
  if (library.mode.value === 'search') return `Search · ${library.query.value}`
  if (library.mode.value === 'favourites') return 'Favourites'
  if (library.mode.value === 'composers') return 'Composers'
  const where = library.folder.value === '/' ? 'All tunes' : library.folder.value.replace(/^\//, '')
  // Which archive, since the two have folders of their own and a bare
  // composer name would not say which one you were looking at.
  const archive = COLLECTIONS[library.collection.value].shortLabel
  return archive ? `${archive} · ${where}` : where
})

const plural = (n: number, noun: string) => `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`

/** The right-hand half of that row. Composers is empty: the grid says it. */
const tally = computed(() => {
  // Both collections: `visible` is every block flattened.
  if (library.mode.value === 'search') {
    const shown = plural(library.visible.value.length, 'result')
    // Said, or the limit reads as the number of matches there are.
    return library.searchCapped.value ? `the best ${shown}; narrow the search for the rest` : shown
  }
  if (library.mode.value === 'composers') return ''
  if (library.mode.value === 'favourites') return plural(library.visible.value.length, 'favourite')
  return (
    plural(library.visible.value.length, 'tune') + (library.listingIsDeep.value ? ', including subfolders' : '')
  )
})

/*
 * What is in the box, which runs a little ahead of what is being searched
 * for. A search of the whole collection on every keystroke meant a one-letter
 * query - which matches most of 61,157 tunes - was scored, sorted and had its
 * first two hundred headers asked for, on the way to typing the word that
 * was actually wanted. So the box takes each letter at once and the search
 * waits for a pause in them. Emptying the box does not wait: that is leaving
 * the search, and should look like it.
 */
const SEARCH_PAUSE_MS = 150
const typed = ref(library.query.value)
let searchTimer: ReturnType<typeof setTimeout> | undefined
// The library's own changes to the query - a folder opened, a search cleared
// - show in the box as they always did. Going anywhere also calls off a
// search still waiting on its pause, whether or not the query itself moved:
// from an empty query to an empty query it does not, and the search then
// arrived a moment after the folder that was clicked instead.
watch([library.query, library.mode, library.folder, library.collection], () => {
  clearTimeout(searchTimer)
  typed.value = library.query.value
})
function onType(text: string): void {
  typed.value = text
  clearTimeout(searchTimer)
  if (!text.trim()) {
    library.search(text)
    return
  }
  searchTimer = setTimeout(() => library.search(text), SEARCH_PAUSE_MS)
}
onBeforeUnmount(() => clearTimeout(searchTimer))
/** Empties the box and the search with it, including one still waiting on its pause. */
function leaveSearch(): void {
  clearTimeout(searchTimer)
  typed.value = ''
  library.search('')
}

function onClearSearch(): void {
  leaveSearch()
  searchField.value?.focus()
}

const clearButton = {
  width: '24px',
  height: '24px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  font: 'inherit',
  fontSize: '15px',
  lineHeight: 1,
  color: 'var(--oc-role-on-surface-variant)',
  background: 'var(--oc-role-surface-container)',
  border: '1px solid var(--oc-role-outline-variant)',
  borderRadius: '999px',
  cursor: 'pointer'
}

const bar = {
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  flexShrink: 0,
  boxSizing: 'border-box' as const,
  padding: '0 16px',
  height: '52px',
  background: 'var(--oc-role-surface)',
  borderBottom: '1px solid var(--oc-role-outline-variant)'
}
</script>

<template>
  <div
    ref="root"
    class="sidplayer-library"
    :data-cgsc="cgscState"
    :style="{
      position: 'relative',
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      minHeight: 0,
      background: 'var(--oc-role-surface-container)',
      color: 'var(--oc-role-on-surface)',
      overflow: 'hidden'
    }"
  >
    <!--
      Top bar, in three columns rather than a row of siblings.

      The search field used to sit in the one flexible child, centred in
      whatever space the others left it, so anything that changed width on
      the right moved it: while indexing, the activity pill grows from
      "Reading headers - 8 of 61,157" to "- 61,157 of 61,157", varying by
      24 px, and the field slid by half of that, 12 px, several times a
      second. Giving both sides `flex: 1 1 0` pins the centre to the middle
      of the bar whatever they contain.
    -->
    <div :style="bar">
      <div :style="{ flex: '1 1 0', minWidth: 0, display: 'flex', alignItems: 'center', gap: '12px' }">
        <!--
        The name and the version as one block, so the pair centres against the
        release pill beside it rather than the name alone sitting high with
        the version hanging below the middle. The full build tag, commit and
        all, is on hover: it is what identifies a build when something needs
        reporting, and it has no business taking up room until then.
      -->
        <div
          :style="{ display: 'flex', flexDirection: 'column', justifyContent: 'center', lineHeight: 1.1 }"
          :title="config.buildTag ?? undefined"
        >
          <span :style="{ fontSize: '15px', fontWeight: 600, whiteSpace: 'nowrap' }">SID Library</span>
          <span
            v-if="config.version"
            :style="{
              fontSize: '10px',
              fontVariantNumeric: 'tabular-nums',
              color: 'var(--oc-role-on-surface-variant)',
              whiteSpace: 'nowrap'
            }"
            >v{{ config.version }}</span
          >
        </div>
        <span
          v-if="library.release.value"
          :style="{
            fontFamily: 'monospace',
            fontSize: '11px',
            color: 'var(--oc-role-on-secondary-container)',
            background: 'var(--oc-role-secondary-container)',
            borderRadius: '999px',
            padding: '2px 8px'
          }"
        >
          HVSC #{{ library.release.value }}
        </span>
      </div>

      <!--
        Clearing a search is a way back to the folder you came from as much
        as it is emptying a box, so it sits on the left of the field where a
        back action belongs. It used to be a "Clear" at the right end of the
        results row, four pixels above the column of stars, where it read as
        an offer to unstar everything.

        Its slot is held open whether or not there is anything to clear, or
        the field would change width as you typed the first character.
      -->
      <div :style="{ flex: '0 1 528px', minWidth: 0, display: 'flex', alignItems: 'center', gap: '6px' }">
        <span :style="{ width: '28px', flexShrink: 0, display: 'flex', justifyContent: 'center' }">
          <button
            v-if="typed"
            type="button"
            aria-label="Clear the search"
            title="Clear the search and return to the folder"
            :style="clearButton"
            @click="onClearSearch"
          >
            &#215;
          </button>
        </span>
        <input
          ref="searchField"
          class="sidplayer-search"
          type="search"
          aria-label="Search the collection"
          :value="typed"
          :placeholder="
            searchable
              ? `Search ${searchable.toLocaleString()} tunes — composer:hubbard, year:1985..1988, songs:>1`
              : 'Search the collection'
          "
          :style="{
            flex: '1 1 auto',
            minWidth: 0,
            boxSizing: 'border-box',
            height: '32px',
            padding: '0 10px',
            font: 'inherit',
            fontSize: '13px',
            color: 'var(--oc-role-on-surface)',
            background: 'var(--oc-role-surface-container)',
            border: '1px solid var(--oc-role-outline-variant)',
            borderRadius: '8px'
          }"
          @input="onType(($event.target as HTMLInputElement).value)"
        />
        <!--
          The clear control's opposite number, empty and the same width, so
          the field itself stays in the middle of the bar rather than being
          shouldered 17 px to the right of it.
        -->
        <span :style="{ width: '28px', flexShrink: 0 }"></span>
      </div>

      <div
        :style="{
          flex: '1 1 0',
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: '12px'
        }"
      >
        <label
          v-if="library.mode.value === 'search'"
          :style="{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '12px',
            color: 'var(--oc-role-on-surface-variant)'
          }"
        >
          <input v-model="library.scopeToFolder.value" type="checkbox" />
          This folder only
        </label>

        <!--
        The rest of an online collection, in bulk. Only ever on a press: it is
        hundreds of megabytes into someone's space, and the panel it opens
        shows the plan and waits for Start like any other.
      -->
        <oc-button
          v-if="library.phase.value === 'ready' && library.online.value && !library.activity.value"
          appearance="raw"
          size="small"
          title="Fetch every tune in the release into your space, rather than each one as it is played"
          @click="downloadAll"
        >
          Download all…
        </oc-button>

        <!--
        Indexing the whole collection: a sync reads every header for free,
        but a collection unpacked from an archive arrives without them, and
        filling them folder by folder takes as long as someone takes to
        browse. This does the lot - about 8 MB for release 85 - and can be
        stopped without losing what it has read.
      -->
        <oc-button
          v-if="
            library.phase.value === 'ready' && !library.online.value && !library.activity.value && unindexed > 0
          "
          appearance="raw"
          size="small"
          :title="`Read the header of every tune (${unindexed.toLocaleString()} left, about ${Math.ceil((unindexed * 128) / 1024 / 1024)} MB)`"
          @click="library.indexAll()"
        >
          Index all tunes
        </oc-button>

        <!--
        One status area for everything that takes time: the release check,
        the folder walk behind a plan, a running or paused sync, and the
        header pass. Every one of them can look like nothing happening -
        planning walks about 1,951 folders on a real collection - and a sync
        used to become invisible the moment its panel was closed.
      -->
        <button
          v-if="library.activity.value"
          type="button"
          :disabled="!library.activity.value.opensSync"
          :title="library.activity.value.opensSync ? 'Show the update panel' : library.activity.value.text"
          :style="{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            maxWidth: '380px',
            padding: '4px 10px',
            font: 'inherit',
            fontSize: '12px',
            color: 'var(--oc-role-on-secondary-container)',
            background: 'var(--oc-role-secondary-container)',
            border: 0,
            borderRadius: '999px',
            cursor: library.activity.value.opensSync ? 'pointer' : 'default'
          }"
          @click="library.activity.value.opensSync && (syncOpen = true)"
        >
          <oc-spinner size="xsmall" :aria-label="library.activity.value.text" />
          <!-- tabular figures: otherwise each digit that changes re-flows the
             text beside it, which reads as a shimmer even when the pill as a
             whole holds still. -->
          <span
            :style="{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontVariantNumeric: 'tabular-nums'
            }"
            >{{ library.activity.value.text }}</span
          >
          <span
            v-if="library.activity.value.percent !== undefined"
            :style="{
              width: '46px',
              height: '4px',
              flexShrink: 0,
              background: 'var(--oc-role-surface)',
              borderRadius: '2px',
              overflow: 'hidden'
            }"
            aria-hidden="true"
          >
            <span
              :style="{
                display: 'block',
                width: `${library.activity.value.percent}%`,
                height: '100%',
                background: 'var(--oc-role-primary)'
              }"
            ></span>
          </span>
        </button>
        <oc-button
          v-if="library.indexing.value.running"
          appearance="raw"
          size="small"
          @click="library.stopIndexing()"
        >
          Stop
        </oc-button>

        <span
          v-if="!library.activity.value"
          :style="{ fontSize: '12px', whiteSpace: 'nowrap', color: 'var(--oc-role-on-surface-variant)' }"
        >
          <template v-if="library.phase.value === 'loading'">{{ library.message.value }}</template>
          <template v-else-if="library.updateAvailable.value">Update available</template>
          <template v-else-if="library.status.value?.checkedAt">
            Up to date{{ library.online.value ? ' · online' : '' }}
          </template>
        </span>
      </div>
    </div>

    <!--
      Anything that went wrong while the library is open, from the library
      itself or from the player underneath it.

      The library's own `error` was only ever rendered inside the "could not
      be opened" panel, which needs `phase === 'failed'`, so every message
      set once the library was up went into a ref nothing displayed. The
      player's was worse: it had no place here at all, and was shown only by
      the full view - so a tune that would not open from the library failed
      without a word, which is exactly the report that led here.
    -->
    <div
      v-if="showTrouble && library.phase.value === 'ready'"
      role="alert"
      :style="{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        flexShrink: 0,
        boxSizing: 'border-box',
        padding: '10px 16px',
        fontSize: '13px',
        background: 'var(--oc-role-error-container, var(--oc-role-secondary-container))',
        color: 'var(--oc-role-on-error-container, var(--oc-role-on-secondary-container))',
        borderBottom: '1px solid var(--oc-role-outline-variant)'
      }"
    >
      <span :style="{ flexGrow: 1 }">{{ showTrouble }}</span>
      <oc-button appearance="raw" size="small" aria-label="Dismiss this message" @click="dismissed = true">
        Dismiss
      </oc-button>
    </div>

    <!-- update banner -->
    <div
      v-if="
        library.updateAvailable.value &&
        library.phase.value === 'ready' &&
        library.sync.value.state !== 'paused'
      "
      :style="{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        flexShrink: 0,
        boxSizing: 'border-box',
        padding: '10px 16px',
        background: 'var(--oc-role-tertiary-container, var(--oc-role-secondary-container))',
        color: 'var(--oc-role-on-tertiary-container, var(--oc-role-on-secondary-container))',
        borderBottom: '1px solid var(--oc-role-outline-variant)'
      }"
    >
      <span :style="{ flexGrow: 1, fontSize: '13px' }">
        <strong>HVSC #{{ library.status.value?.upstream }} is available.</strong>
        You have #{{ library.release.value ?? 'nothing' }}.
      </span>
      <oc-button size="small" appearance="filled" @click="startUpdate">Update…</oc-button>
    </div>

    <!-- body -->
    <first-run-panel
      v-if="library.phase.value === 'first-run'"
      :mirror="library.mirror"
      :hvsc-path="config.hvscPath"
      :mirror-path="config.hvscMirrorPath"
      @start="downloadAll"
      @online="startOnline"
    />

    <div
      v-else-if="library.phase.value === 'failed'"
      :style="{ flexGrow: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '32px' }"
    >
      <div :style="{ maxWidth: '460px', textAlign: 'center' }">
        <h1 :style="{ margin: 0, fontSize: '18px', fontWeight: 600 }">The library could not be opened</h1>
        <p :style="{ margin: '8px 0 16px', fontSize: '13px', color: 'var(--oc-role-on-surface-variant)' }">
          {{ library.error.value }}
        </p>
        <oc-button appearance="filled" size="small" @click="library.init()">Try again</oc-button>
      </div>
    </div>

    <div
      v-else-if="library.phase.value !== 'ready'"
      :style="{ flexGrow: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px' }"
    >
      <oc-spinner aria-label="Opening the library" size="large" />
      <span :style="{ fontSize: '13px', color: 'var(--oc-role-on-surface-variant)' }">{{
        library.message.value
      }}</span>
    </div>

    <div v-else :style="{ flexGrow: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }">
      <tree-pane
        :tree="library.tree.value"
        :cgsc-tree="library.cgsc.tree.value"
        :folder="library.folder.value"
        :collection="library.collection.value"
        :mode="library.mode.value"
        :counts="counts"
        @open="onOpen"
        @mode="onMode"
      />

      <!--
        minHeight: 0 is load-bearing twice over. A flex item defaults to
        min-height auto, so with more rows than fit this column grew past the
        body instead of letting the table scroll: the list painted straight
        over the player bar and there was no scrollbar to drag.
      -->
      <div :style="{ flexGrow: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }">
        <div
          :style="{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            flexShrink: 0,
            boxSizing: 'border-box',
            height: '40px',
            padding: '0 16px',
            background: 'var(--oc-role-surface)',
            borderBottom: '1px solid var(--oc-role-outline-variant)'
          }"
        >
          <span
            :style="{ fontFamily: 'monospace', fontSize: '12px', color: 'var(--oc-role-on-surface-variant)' }"
          >
            {{ breadcrumb }}
          </span>
          <span :style="{ flexGrow: 1 }"></span>
          <span
            v-if="tally"
            class="sidplayer-results-tally"
            :style="{ fontSize: '12px', color: 'var(--oc-role-on-surface-variant)', whiteSpace: 'nowrap' }"
            >{{ tally }}</span
          >
        </div>

        <composer-grid
          v-if="library.mode.value === 'composers'"
          :composers="library.composers.value"
          @open="library.openFolder"
          @play-all="onPlayAll"
        />
        <tune-table
          v-else
          :blocks="listBlocks"
          :selected="library.selected.value"
          :playing="playingRow"
          :sounding="player.state.value === 'playing'"
          :starred="library.isStarred"
          :show-path="library.mode.value !== 'folder' || library.listingIsDeep.value"
          :local="library.localBy.value"
          :fetching="library.fetching.value"
          :sort="library.sort.value"
          :reorderable="library.mode.value === 'favourites'"
          @select="library.select"
          @play="(row: CatalogRow) => library.play(row)"
          @pause="player.pause"
          @star="(row: CatalogRow) => library.toggleStar(row)"
          @sort="library.toggleSort"
          @move="({ row, index }) => library.moveFavourite(row, index)"
        />
      </div>

      <detail-pane
        :row="library.selected.value"
        :mus="library.selectedMus.value"
        :stil="library.stil.value"
        :musicians="library.musicians.value"
        :starred="library.selected.value ? library.isStarred(library.selected.value) : false"
        :subsong="subsong"
        :live="liveHeader"
        :emulation="emulation"
        :playing="selectedIsPlaying"
        :picture="selectedIsCurrent ? session.picture.value : null"
        @play="(row: CatalogRow) => library.play(row)"
        @pause="player.pause"
        @star="(row: CatalogRow) => library.toggleStar(row)"
        @open-folder="onOpenRowFolder"
        @search="library.search"
      />
    </div>

    <!-- the player, the same one the dock and the full view use -->
    <!--
      `session.loading` counts as loading here, as it does in the dock: the
      bar takes its title from the file being opened and its clock and subsong
      count from the engine, so during the fetch it showed the new tune's name
      over the old tune's position and "subsong 2 of 3". The full view hides
      the whole bar behind a spinner instead; the library keeps it in place
      and says what it is doing.
    -->
    <player-bar
      :session="session"
      :state="session.loading.value ? 'loading' : player.state.value"
      :shortcuts="false"
      :closable="!!session.current.value"
    />

    <sync-dialog
      v-if="syncOpen"
      :sync="library.sync.value"
      :release="library.release.value"
      :upstream="library.status.value?.upstream ?? null"
      :progress-text="library.message.value"
      @start="library.startUpdate"
      @pause="library.pauseUpdate"
      @cancel="library.cancelUpdate"
      @close="syncOpen = false"
      @removals="(choice) => (library.sync.value.removals = choice)"
    />
  </div>
</template>

<style scoped>
/*
 * Chromium puts its own clear button inside the right edge of a
 * `type="search"` field and Firefox puts none there at all, so relying on
 * it would leave half the browsers without one and the other half with two.
 * Ours is to the left, and is the only one.
 */
.sidplayer-search::-webkit-search-cancel-button {
  display: none;
}
</style>
