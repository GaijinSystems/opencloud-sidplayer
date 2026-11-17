import { computed, ref, shallowRef, watch } from 'vue'
import type { Resource, SpaceResource } from '@opencloud-eu/web-client'
import type { Router } from 'vue-router'
import { KB, type SidplayConfig } from '../config'
import { useSidPlayer } from '../composables/useSidPlayer'
import { usePreferences } from '../composables/usePreferences'
import { applyThemeTo, canChooseTheme as offersChoice, pickTheme, type ThemeLike } from '../helpers/theme'
import { displayTitle } from '../sid/header'
import { openTune, type OpenedTune } from '../sid/openTune'
import type { WebDav } from '../sid/source'
import { SidPlayerError } from '../sid/types'
import { extensionOf, FILE_TYPES } from '../sid/detect'
import { SonglengthsSource } from '../sid/songlengthsSource'

/** Everything the app can open from the Files list. */
const PLAYABLE_EXTENSIONS = new Set(FILE_TYPES.map((type) => type.extension))

export const isPlayable = (resource: Resource | undefined): boolean =>
  !!resource && !resource.isFolder && PLAYABLE_EXTENSIONS.has(extensionOf(resource.name ?? ''))

export interface SessionDeps {
  webdav: WebDav
  /** The instance's themes, read live: the store may fill in after start-up. */
  themes: () => readonly ThemeLike[]
}

/**
 * What "next tune" and "previous tune" mean, frozen at the moment play was
 * pressed.
 *
 * Frozen on purpose. The list under the player is a computed that changes as
 * soon as anyone types in the search box or opens another folder, and a queue
 * that followed it would turn "next" into a question about where the user
 * happens to be looking rather than about what they put on. So the list is
 * taken as it was, and browsing somewhere else leaves the running order alone
 * until something is played from the new list.
 *
 * It is a cursor, not a copy of the tunes: `playAt` belongs to whoever owns
 * the list and knows how to turn a position into a playable file. That keeps
 * this file ignorant of catalogues and collections, and means the queue for
 * "All tunes" costs one closure rather than 61,157 synthetic resources.
 */
export interface Queue {
  length: number
  index: number
  playAt: (index: number) => Promise<void>
}

export interface CurrentTune {
  space: SpaceResource
  resource: Resource
  /** Null while loading or when opening failed; `error` says why. */
  opened: OpenedTune | null
  /**
   * Real subsong lengths from HVSC, once looked up; null until then or when
   * unknown. An entry in the array may itself be `undefined`, for a subsong
   * whose time the database gave in a shape the parser could not read - the
   * rest of the tune keeps its real lengths and that one falls back.
   */
  lengths: Array<number | undefined> | null
  /** Where `lengths` came from, when it is not HVSC's database. */
  lengthFrom?: 'score'
  /** Where the tune sits in the collection, when the database said. */
  hvscPath?: string
}

/**
 * The one player for the whole page.
 *
 * Created once when the app registers and never torn down, so a tune started
 * from the Files list keeps playing while the user browses, opens the full
 * view, or moves to the library. Moving to another app stops it. The dock and
 * the full view are both views over this object; neither owns the sound.
 */
export function createSession(config: SidplayConfig, deps: SessionDeps) {
  const { prefs, destroy: destroyPrefs } = usePreferences()
  const current = shallowRef<CurrentTune | null>(null)
  const player = useSidPlayer(config, {
    // The tune has played through all its subsongs: on to the next file in
    // the running order, at its own first subsong.
    onEnd: () => {
      if (!canNextTune.value) return false
      void nextTune()
      return true
    },
    // Read live: the lookup finishes after playback has started.
    songLength: (_header, subsong) => current.value?.lengths?.[subsong - 1],
    // The same title the bar shows, so the OS media widget never ends up as
    // the one place HVSC's `<?>` placeholder is on display.
    title: () => title.value
  })
  const songlengths = new SonglengthsSource(deps.webdav, config.songlengthsUrl)
  const loading = ref(false)
  const error = shallowRef<SidPlayerError | null>(null)
  const queue = shallowRef<Queue | null>(null)
  const router = shallowRef<Router | null>(null)
  let generation = 0
  /** Whether anyone asking for the tune now loading wants it started as well. */
  let startWhenOpen = false

  player.setVolume(prefs.volume)
  player.setMuted(prefs.muted)

  const header = computed(() => current.value?.opened?.header ?? null)
  const words = computed(() => current.value?.opened?.words ?? [])
  const picture = computed(() => current.value?.opened?.picture ?? null)
  const fileName = computed(() => current.value?.resource.name ?? '')
  /**
   * What to call the tune, and nothing at all when there is not one.
   *
   * `displayTitle` needs a file name to fall back on, and the `tune.sid` it
   * was given leaked: with nothing loaded it strips the extension and returns
   * "tune", so the library - which draws the player bar whether or not
   * anything is playing - opened every time announcing a tune of that name
   * that exists nowhere. The dock hides itself when nothing is loaded and the
   * full view always has a file, which is why it showed up in one place only.
   */
  const title = computed(() => (current.value ? displayTitle(header.value, fileName.value || 'tune.sid') : ''))
  /** Whether the length shown is the collection's or the configured guess. */
  const lengthSource = computed<'hvsc' | 'score' | 'default'>(() => {
    if (current.value?.lengths?.[player.subsong.value - 1] === undefined) return 'default'
    return current.value?.lengthFrom === 'score' ? 'score' : 'hvsc'
  })

  /**
   * Where the user is, by route name, as the two rules below need it: the
   * app's own routes, the Files app's, or somewhere else. The host namespaces
   * an app's extra route names, so the library is `sidplayer-library`, and
   * matching the prefix covers routes added later; every Files route starts
   * `files-`. An unnamed route says nothing, and is null.
   */
  const place = computed<'own' | 'files' | 'elsewhere' | null>(() => {
    const name = router.value?.currentRoute.value.name
    if (typeof name !== 'string') return null
    if (name === 'sidplayer' || name.startsWith('sidplayer-')) return 'own'
    return name.startsWith('files-') ? 'files' : 'elsewhere'
  })
  /**
   * True on any of the app's own routes - the full view and the library -
   * where the dock would be a second set of transport controls for the same
   * sound.
   */
  const dockVisible = computed(() => current.value !== null && place.value !== 'own')

  /**
   * Whether this is the file already loaded.
   *
   * By path before id, because the two places a tune is opened from give it
   * different ids: the Files list hands over the server's own resource, while
   * the library builds a synthetic one whose id is `<collection>:<path>`.
   * Comparing ids alone made the same file opened from the library and then
   * from Files look like two different tunes, so it restarted rather than
   * carrying on.
   */
  const identity = (resource: Resource): string =>
    resource.path || (resource.fileId as string | undefined) || String(resource.id ?? '')
  /**
   * In the same space, where the caller says which: `/Tune.sid` in a share
   * is not the `/Tune.sid` of the personal space that happens to be loaded.
   */
  const isCurrent = (resource: Resource, space?: SpaceResource) =>
    !!current.value &&
    identity(current.value.resource) === identity(resource) &&
    (!space || current.value.space.id === space.id)

  /**
   * Opens a file and starts it. Opening the file that is already loaded just
   * resumes it, so clicking the playing row twice does not restart it.
   */
  async function play(
    space: SpaceResource,
    resource: Resource,
    {
      autoplay = true,
      fromQueue = false,
      lengths,
      hvscPath
    }: {
      autoplay?: boolean
      fromQueue?: boolean
      /**
       * The tune's lengths where the caller already has them - the library's
       * catalogue row does - which spares a lookup that parses the whole of
       * Songlengths.md5 a second time to find what was already in hand.
       */
      lengths?: Array<number | undefined>
      hvscPath?: string
    } = {}
  ) {
    /*
     * A player that has failed does not count as open, whatever the session
     * is holding. The file read fine and `opened` is set, but the engine will
     * not play it, and `player.play()` returns at once in `failed` - so
     * without this the "Try again" button lands here and does nothing at all.
     * Falling through re-reads the file and rebuilds the audio graph, which
     * is what the button offers.
     */
    if (
      isCurrent(resource, space) &&
      current.value?.opened &&
      !error.value &&
      player.state.value !== 'failed'
    ) {
      // The same file under another name for it: started from Files and now
      // asked for by the library, whose list finds the playing row by the
      // id the library gave it. Without taking that id the tune carried on
      // and the row that was just clicked stayed dark.
      if (current.value.resource.id !== resource.id) current.value = { ...current.value, resource }
      if (autoplay && player.state.value !== 'playing') void player.play()
      return
    }
    /*
     * Nor is one still being opened started again. The full view asks for
     * the tune its route names, and when the running order has just moved on
     * that request arrives while the same tune is loading: it read the file
     * a second time and, not being from the list, dropped the list.
     */
    if (isCurrent(resource, space) && loading.value && !error.value) {
      // Its wish to hear it is kept, though: the load it joins may have
      // been asked only to open the tune.
      startWhenOpen ||= autoplay
      return
    }
    // A tune from anywhere but the list is not part of it. Kept, the list's
    // arrows would sit on a tune from Files, and its end would carry on into
    // the library's next one.
    if (!fromQueue) queue.value = null
    const gen = ++generation
    startWhenOpen = autoplay
    loading.value = true
    error.value = null
    current.value = { space, resource, opened: null, lengths: null }
    // Silence the previous tune while this one loads; a tune switching
    // mid-bar with a second of the old one still sounding is confusing.
    player.pause()
    try {
      const opened = await openTune({
        space,
        resource,
        webdav: deps.webdav,
        maxBytes: config.maxFileSizeKb * KB
      })
      if (gen !== generation) return
      /*
       * Always subsong 1, whatever the header names as its start song. A
       * file with several can ask for another, and following it meant a tune
       * started part-way through its own set and, in a running order, never
       * played the subsongs before that one at all. The app used to remember
       * whichever one you last listened to as well, which was worse: a tune
       * could start in the middle of itself days later with nothing saying
       * why. The header's choice is still shown in the details.
       */
      const subsong = 1
      /*
       * A Sidplayer tune's length comes out of its own score, since nothing
       * else has it. One entry, because a MUS is one tune rather than a set
       * of subsongs.
       */
      current.value = opened.scoreLength
        ? { space, resource, opened, lengths: [opened.scoreLength], lengthFrom: 'score' }
        : lengths?.length
          ? { space, resource, opened, lengths, hvscPath }
          : { space, resource, opened, lengths: null }
      loading.value = false
      // Not awaited: the tune starts on the default length and takes the real
      // one when the database answers, which is usually within the second.
      if (!opened.scoreLength && !lengths?.length) {
        void songlengths.lookup(space, opened.source, opened.bytes).then((entry) => {
          if (gen !== generation || !entry || !current.value) return
          current.value = { ...current.value, lengths: entry.lengths, hvscPath: entry.path }
        })
      }
      await player.open(opened.bytes, opened.header, subsong)
      if (gen !== generation) return
      if (startWhenOpen && player.state.value === 'ready') await player.play()
    } catch (e) {
      if (gen !== generation) return
      // The tune before is still in the player, paused; with it there, Play
      // would have played that one under this one's error.
      player.unload()
      error.value =
        e instanceof SidPlayerError ? e : new SidPlayerError('corrupt', 'This file could not be opened.', e)
      // The path as well as the name: when a tune will not open, where it was
      // looked for is the thing worth knowing, and the two can differ from
      // what the row says once a collection has been found somewhere
      // unexpected.
      console.error('[sidplayer] open failed', { name: resource.name, path: resource.path, error: e })
    } finally {
      if (gen === generation) loading.value = false
    }
  }

  /** Stops the sound and hides the dock. The engine stays warm for the next tune. */
  function stop() {
    generation++
    player.unload()
    current.value = null
    error.value = null
    queue.value = null
  }

  /**
   * Where a tune may go on playing: the Files app, and the app's own full
   * view and library. Anywhere else - another app from the menu, the
   * settings, a different viewer opened from Files - is leaving the player,
   * and the sound and the dock go with it rather than following the user
   * somewhere they have nothing to do with.
   */
  watch(place, (where) => {
    if (current.value && where === 'elsewhere') stop()
  })

  /* ---- the running order ------------------------------------------------- */

  /**
   * Takes a list as it stands and starts one of its tunes.
   *
   * Everything about which tune follows which is settled here and then left
   * alone, however far the user wanders afterwards.
   */
  async function playQueue(next: Queue): Promise<void> {
    queue.value = next
    await next.playAt(next.index)
  }

  /** Takes a list whose owner starts the tune itself, as the library does. */
  function setQueue(next: Queue): void {
    queue.value = next
  }

  const canNextTune = computed(() => !!queue.value && queue.value.index + 1 < queue.value.length)
  const canPreviousTune = computed(() => !!queue.value && queue.value.index > 0)

  async function goToTune(index: number): Promise<void> {
    const q = queue.value
    if (!q || index < 0 || index >= q.length) return
    // Moved before the tune is opened so the buttons settle at once rather
    // than after a fetch that may take a moment.
    queue.value = { ...q, index }
    await q.playAt(index)
  }

  const nextTune = (): Promise<void> => goToTune((queue.value?.index ?? -1) + 1)
  const previousTune = (): Promise<void> => goToTune((queue.value?.index ?? 0) - 1)

  /**
   * Navigates to the full view of what is playing. `replace` for following
   * the tune from a full view already open, so Back still leaves the view
   * rather than stepping through every tune the list has played since.
   */
  function openFullView({ replace = false } = {}) {
    const c = current.value
    const r = router.value
    if (!c || !r) return
    void r[replace ? 'replace' : 'push']({
      name: 'sidplayer',
      params: { driveAliasAndItem: c.space.getDriveAliasAndItem(c.resource) },
      query: c.resource.fileId ? { fileId: c.resource.fileId } : {}
    })
  }

  /** A download link for the current file, for the error states. */
  function downloadUrl(): Promise<string | null> {
    const c = current.value
    if (!c) return Promise.resolve(null)
    return deps.webdav.getFileUrl(c.space, c.resource, { disposition: 'attachment' }).catch(() => null)
  }

  /* ---- preferences drive the player ------------------------------------- */
  const applyEmulation = () => player.setEmulation({ model: prefs.chipModel, clock: prefs.clock })
  applyEmulation()
  watch(() => [prefs.chipModel, prefs.clock], applyEmulation)
  watch(
    () => prefs.volume,
    (v) => player.setVolume(v)
  )
  watch(
    () => prefs.muted,
    (m) => player.setMuted(m)
  )
  const setVolume = (v: number) => {
    prefs.volume = v
  }
  const setMuted = (m: boolean) => {
    prefs.muted = m
  }
  /* ---- theme, applied to every registered root the way the shell applies its own ---- */
  const themeRoots = new Map<HTMLElement, string[]>()
  const chosenTheme = () => (prefs.theme === 'system' ? null : (pickTheme(deps.themes(), prefs.theme) ?? null))
  const applyThemes = () => {
    const theme = chosenTheme()
    for (const [el, previous] of themeRoots) themeRoots.set(el, applyThemeTo(el, theme, previous))
  }
  watch(() => prefs.theme, applyThemes)
  // And when the instance's themes arrive or change. The dock registers in
  // `ready()`, which can come before the theme store has filled, and a choice
  // of Light or Dark made against an empty list applied nothing until the
  // preference itself was changed again.
  watch(() => deps.themes(), applyThemes, { deep: true })
  function registerThemeRoot(el: HTMLElement) {
    themeRoots.set(el, applyThemeTo(el, chosenTheme(), []))
  }
  function unregisterThemeRoot(el: HTMLElement) {
    const previous = themeRoots.get(el)
    if (previous) applyThemeTo(el, null, previous)
    themeRoots.delete(el)
  }
  const canChooseTheme = computed(() => offersChoice(deps.themes()))

  return {
    config,
    prefs,
    player,
    queue,
    playQueue,
    setQueue,
    nextTune,
    previousTune,
    canNextTune,
    canPreviousTune,
    /** The library reads and writes the collection through the same client. */
    webdav: deps.webdav,
    current,
    loading,
    error,
    header,
    words,
    picture,
    fileName,
    title,
    lengthSource,
    router,
    dockVisible,
    isCurrent,
    play,
    stop,
    openFullView,
    downloadUrl,
    setVolume,
    setMuted,
    registerThemeRoot,
    unregisterThemeRoot,
    canChooseTheme,
    /** For tests; the shell never unloads an app. */
    destroy() {
      stop()
      player.destroy()
      destroyPrefs()
    }
  }
}

export type Session = ReturnType<typeof createSession>

let session: Session | null = null

export function initSession(config: SidplayConfig, deps: SessionDeps): Session {
  session ??= createSession(config, deps)
  return session
}

export function useSession(): Session {
  if (!session)
    throw new Error('[sidplayer] the session is created when the app registers; nothing should run before that')
  return session
}
