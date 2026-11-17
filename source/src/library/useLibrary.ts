import { computed, ref, shallowRef, watch, type ComputedRef, type Ref, type ShallowRef } from 'vue'
import type { Resource, SpaceResource } from '@opencloud-eu/web-client'
import { KB, type SidplayConfig } from '../config'
import { parentFolder, type WebDav } from '../sid/source'
import { spacePath, readLatin1, type SpaceOps } from '../hvsc/space'
import { createMirror, parseRelease, type MirrorOps } from '../hvsc/mirror'
import { parseManifest } from '../hvsc/manifest'
import { buildCatalog, buildTree, composerName, rowKey, type CatalogRow, type TreeNode } from '../hvsc/catalog'
import { parseStil, type StilDb } from '../hvsc/stil'
import { musicianForFolder, parseMusicians, type MusicianDb } from '../hvsc/musicians'
import {
  buildSearchIndex,
  headerOnlyFilters,
  type HeaderOnlyFilter,
  type SearchFilters,
  type SearchHit,
  type SearchIndex
} from '../hvsc/search'
import { buildCgscCatalog, cgscPath } from '../cgsc/catalog'
import { readCgscPaths } from '../cgsc/load'
import { nextSort, sortRows, type SortColumn, type SortOrder } from '../hvsc/sorting'
import { applyHeadersByMd5, fieldsFromBytes, HEADER_BYTES, type HeaderFields } from '../hvsc/headers'
import { createDocumentCache, type CachedDocuments, type DocumentCache } from '../hvsc/store'
import { documentPath, DOCUMENTS } from '../hvsc/sync'
import { md5Hex } from '../sid/md5'
import { extensionOf } from '../sid/detect'
import type { ShownMusDetails } from '../cgsc/details'
import {
  EMPTY_STATUS,
  parseStatus,
  serialiseStatus,
  shouldCheck,
  STATUS_PATH,
  updateAvailable,
  type CollectionStatus
} from '../hvsc/status'
import { favouriteKey, orderedFavourites, type FavouritesFile } from '../hvsc/favourites'
import { COLLECTIONS, COLLECTION_KEYS, collectionOf, type Collection } from './collections'
import { createLayout } from './layout'
import { createFavourites } from './favouritesState'
import { createHeaderFilling, type IndexingState } from './headerFilling'
import { createMusDetails } from './musDetails'
import { createSyncController, type SyncScope, type SyncState } from './syncController'

/**
 * The library: one object holding everything the view needs.
 *
 * The order of work when it opens is the whole design in miniature. Is there
 * a collection at all - one listing. What does the app know about it - one
 * small file. Is that knowledge a day old - if so, and only then, ask the
 * mirror what release it has. Then build the catalogue, from IndexedDB if it
 * is still current and from the collection's own documents otherwise.
 *
 * Nothing is downloaded and nothing is written until a person asks.
 *
 * `createLibrary` puts it together from parts that each own one mechanism:
 * `layout` knows where things are, `favouritesState` keeps the starred list,
 * `headerFilling` reads headers, `musDetails` reads what a Compute's tune
 * says of itself, and `syncController` runs an update. What the two
 * collections do and do not have in common is in `collections`. What is
 * left here is the catalogue, the views over it, and playing.
 */

export type LibraryPhase = 'starting' | 'first-run' | 'loading' | 'ready' | 'failed'
export type LibraryMode = 'folder' | 'search' | 'composers' | 'favourites'

export type { Collection } from './collections'
export type { IndexingState } from './headerFilling'
export type { SyncState } from './syncController'

/**
 * One headed run of rows in the list.
 *
 * There is only ever more than one of these in a search, where results from
 * the two collections are kept apart rather than ranked against each other:
 * their scores are not comparable, since an HVSC row can match on a title, a
 * composer's real name and a line of commentary while a Compute's row has
 * only its file name and its folder to match on, so interleaving them would
 * bury the second collection under the first for reasons that say nothing
 * about which tune anyone wanted.
 */
export interface ListBlock {
  key: Collection | 'only'
  /** Empty for the single unheaded block a folder listing is. */
  label: string
  rows: CatalogRow[]
}

/** What the Compute's Gazette side of the library knows. */
export interface CgscState {
  rows: Ref<CatalogRow[]>
  tree: Ref<TreeNode | null>
  /** How the file list was arrived at, or null while it has not been. */
  source: Ref<'index' | 'walk' | null>
  /** True while the list is being read, which a walk makes worth saying. */
  loading: Ref<boolean>
  /** Composer folders. */
  folders: Ref<number>
}

export interface ComposerEntry {
  folder: string
  /**
   * The composer's folder in the collection, taken from a row rather than
   * rebuilt from the name.
   *
   * HVSC files composers under an initial - `/MUSICIANS/H/Hubbard_Rob` - but
   * files everyone whose name starts with a digit under `0-9`, so building
   * the path from the first character sent `20CC` to `/MUSICIANS/2/20CC`
   * and opened an empty folder. The rows know where they came from.
   */
  path: string
  name: string
  count: number
  realName?: string
  country?: string
  /** Up to three tunes to show on the card. */
  examples: CatalogRow[]
}

export interface LibraryDeps {
  webdav: WebDav
  /**
   * The user's space, or how to find it. A getter is asked again on every
   * `init`: the library is made once and kept, and may be made before the
   * spaces have loaded - by a deep link straight to it - when there is none
   * yet to give.
   */
  space: SpaceResource | undefined | (() => SpaceResource | undefined)
  config: SidplayConfig
  /** Where the player lives, so the library plays through the same engine. */
  play: (
    space: SpaceResource,
    resource: Resource,
    options?: { autoplay?: boolean; lengths?: Array<number | undefined>; hvscPath?: string }
  ) => Promise<void> | void
  /**
   * Hands the player the running order this tune came from. Optional, so a
   * library built in a test need not care about it.
   */
  setQueue?: (queue: { length: number; index: number; playAt: (index: number) => Promise<void> }) => void
  /** Overridable for tests. */
  ops?: SpaceOps
  /** The Compute's Gazette folder, likewise. */
  cgscOps?: SpaceOps
  mirror?: MirrorOps
  /** The browser-side cache; IndexedDB unless a test supplies its own. */
  cache?: DocumentCache
}

export interface Library {
  phase: Ref<LibraryPhase>
  message: Ref<string>
  error: Ref<string | null>
  /**
   * Why the tune last played from here could not be fetched, kept apart from
   * `error` because it is about that play alone: cleared as the next starts.
   */
  playError: Ref<string | null>
  status: Ref<CollectionStatus | null>
  updateAvailable: ComputedRef<boolean>
  release: ComputedRef<number | null>

  rows: Ref<CatalogRow[]>
  tree: Ref<TreeNode | null>
  /** The row key of a tune the player has, or null where it is no row's. */
  keyOfPlaying: (resource: Resource, space?: { id?: unknown }) => string | null
  /** Whether a search stopped at its limit, so there are more matches than it shows. */
  searchCapped: ComputedRef<boolean>
  stil: Ref<StilDb | null>
  musicians: Ref<MusicianDb | null>
  composers: ComputedRef<ComposerEntry[]>

  mode: Ref<LibraryMode>
  folder: Ref<string>
  /** Which collection `folder` is a path in. */
  collection: Ref<Collection>
  cgsc: CgscState
  /**
   * Filters in the current query that only a header or HVSC's manifest can
   * answer, so the view can say why the second collection has nothing to
   * show rather than implying it has nothing from 1987.
   */
  unanswerable: ComputedRef<HeaderOnlyFilter[]>
  /** The list as headed blocks; `visible` is these flattened. */
  blocks: ComputedRef<ListBlock[]>
  query: Ref<string>
  scopeToFolder: Ref<boolean>
  /** Which column the list is sorted by, or null for the natural order. */
  sort: Ref<SortOrder | null>
  visible: ComputedRef<CatalogRow[]>
  hits: ComputedRef<SearchHit[]>

  selected: Ref<CatalogRow | null>
  /** The selected Compute's tune's own credits and length, once read. */
  selectedMus: ComputedRef<ShownMusDetails | null>
  favourites: Ref<FavouritesFile>
  isStarred: (row: CatalogRow) => boolean

  /**
   * Which tunes are present, by folder, for the folders that have been
   * listed. A row whose folder is absent from this map is simply unknown -
   * which matters once a listing reaches into subfolders nobody has opened.
   */
  localBy: ComputedRef<Map<string, Set<string>> | null>
  /** True when the folder listing includes rows from below it. */
  listingIsDeep: ComputedRef<boolean>
  /** Tunes being fetched from the mirror right now. */
  fetching: Ref<Set<string>>
  /** Progress of a whole-collection header pass. */
  indexing: Ref<IndexingState>
  /** One line describing whatever the library is doing, for the top bar. */
  activity: ComputedRef<Activity | null>
  /** The mirror this library uses, so the first-run screen can probe it. */
  mirror: MirrorOps

  sync: Ref<SyncState>

  init(): Promise<void>
  openFolder(path: string, collection?: Collection): void
  search(text: string): void
  /** Cycles a column: unsorted, ascending, descending, unsorted. */
  toggleSort(column: SortColumn): void
  select(row: CatalogRow | null): void
  play(row: CatalogRow): Promise<void>
  toggleStar(row: CatalogRow): Promise<void>
  /** Moves a starred tune to a position in the hand-made favourites order. */
  moveFavourite(row: CatalogRow, index: number): Promise<void>
  planUpdate(scope?: SyncScope): Promise<boolean>
  /** Starts an online collection: the documents now, each tune when it is first played. */
  startOnline(): Promise<void>
  /** Whether the collection is online: only what has been played is in the space. */
  online: ComputedRef<boolean>
  startUpdate(): Promise<void>
  pauseUpdate(): void
  cancelUpdate(): void
  /** Reads every tune's header, so titles and the chip filters are complete. */
  indexAll(): Promise<void>
  stopIndexing(): void
}

/**
 * What the library is busy with, for a status line that is always visible.
 *
 * Every one of these can take long enough to look like nothing happening: a
 * release check is a network round trip, planning walks about 1,951 folders
 * on a real collection, a sync is thousands of files, and indexing is 61,157
 * header reads. Only the sync had any indicator, and only while its dialog
 * was open.
 */
export interface Activity {
  kind: 'checking' | 'planning' | 'syncing' | 'paused' | 'indexing' | 'reading'
  text: string
  /** 0..100 where it is known. */
  percent?: number
  /** Whether clicking should open the sync panel. */
  opensSync: boolean
}

/** What the library holds of one collection. */
interface Held {
  rows: ShallowRef<CatalogRow[]>
  tree: ShallowRef<TreeNode | null>
  /** The folder its paths are relative to, wherever that now is. */
  root: () => string
  /** Operations over that folder. */
  ops: () => SpaceOps
  /** The search index as last built, or null where the rows have changed since. */
  built: SearchIndex | null
  /** The search index, built now if it has not been; null where there is nothing to search. */
  index: () => SearchIndex | null
}

export function createLibrary(deps: LibraryDeps): Library {
  /** Where everything is. It moves while the library opens, so it is asked, never kept. */
  const layout = createLayout({
    webdav: deps.webdav,
    space: deps.space,
    configuredRoot: deps.config.hvscPath,
    ops: deps.ops,
    cgscOps: deps.cgscOps
  })
  const mirror = deps.mirror ?? createMirror(deps.config.hvscMirrorPath)
  const cache = deps.cache ?? createDocumentCache()

  const phase = ref<LibraryPhase>('starting')
  const message = ref('')
  const error = ref<string | null>(null)
  const playError = ref<string | null>(null)
  const status = ref<CollectionStatus | null>(null)

  const stil = shallowRef<StilDb | null>(null)
  const musicians = shallowRef<MusicianDb | null>(null)
  /**
   * Counts changes to each collection's index, for the searches over it to
   * run again. One per collection: a header batch for HVSC re-ran the
   * Compute's search as well, and reading that collection re-ran HVSC's.
   */
  const indexGeneration: Record<Collection, Ref<number>> = { hvsc: ref(0), cgsc: ref(0) }

  /*
   * The search indexes, built when wanted rather than when the library opens.
   *
   * Building the larger one is 1.4 seconds of main thread over release 85,
   * and it used to be the last thing between the catalogue and the screen on
   * every page load - for a view, favourites or composers, that does not
   * search. Now the library is up first; the indexes follow in the page's
   * first idle moment, and a search that arrives before that builds what it
   * needs there and then, which costs that one search what every load used
   * to cost.
   */
  const hvscIndex = (): SearchIndex =>
    (held.hvsc.built ??= buildSearchIndex(held.hvsc.rows.value, {
      stil: stil.value ?? undefined,
      musicians: musicians.value ?? undefined
    }))
  const cgscSearchIndex = (): SearchIndex | null =>
    held.cgsc.rows.value.length ? (held.cgsc.built ??= buildSearchIndex(held.cgsc.rows.value)) : null

  const holding = (key: Collection, index: () => SearchIndex | null): Held => ({
    rows: shallowRef<CatalogRow[]>([]),
    tree: shallowRef<TreeNode | null>(null),
    root: () => layout.root(key),
    ops: () => layout.ops(key),
    built: null,
    index
  })
  /*
   * Each collection's rows, tree and search index, under its key.
   *
   * Shallow, the rows and the tree, and that is not a micro-optimisation.
   *
   * A deep `ref` over 61,157 immutable rows wraps every one of them in a
   * reactive proxy on first access, and the proxy is not the object: the
   * search index holds the raw rows it was built from, so comparing them by
   * identity - which is how an incremental update knows what changed - found
   * every row changed and did the full 1.5-second rebuild anyway. Nothing
   * mutates a row or a tree node in place; both are replaced wholesale.
   */
  const held: Record<Collection, Held> = {
    hvsc: holding('hvsc', hvscIndex),
    /*
     * The second collection, which sits beside the first rather than inside
     * it: `/SID Library/CGSC` against `/SID Library/C64Music`. Its own rows, its
     * own tree and its own search index, kept apart from HVSC's because almost
     * nothing about them is comparable - a Compute's row has no MD5 for the
     * sync to check, no header for the indexer to read and no manifest entry
     * for the update planner to miss. Mixing them into HVSC's rows would put
     * 16,601 files that no mirror serves in front of every one of those.
     */
    cgsc: holding('cgsc', cgscSearchIndex)
  }
  /** HVSC's, which the sync, the header reads and the composers are about. */
  const { rows, tree } = held.hvsc
  /** Operations over HVSC's folder, wherever that now is. */
  const ops = (): SpaceOps => held.hvsc.ops()

  /** The collection's `.str` files, lower-cased, for spotting one beside a tune. */
  let cgscStrs = new Set<string>()
  /** The server's MD5 for each tune, where the collection was walked rather than read from its index. */
  let cgscChecksums = new Map<string, string>()
  const cgscSource = ref<'index' | 'walk' | null>(null)
  const cgscLoading = ref(false)
  const cgscProgress = ref('')
  const cgscFolders = ref(0)

  const mode = ref<LibraryMode>('folder')
  const folder = ref('/MUSICIANS')
  const collection = ref<Collection>('hvsc')
  const query = ref('')
  const scopeToFolder = ref(false)
  const sort = ref<SortOrder | null>(null)
  const selected = shallowRef<CatalogRow | null>(null)

  const stars = createFavourites({
    ops: layout.privateOps,
    error,
    visible: () => visible.value
  })
  const { favourites, starredKeys } = stars

  const mus = createMusDetails({
    cache,
    ops: held.cgsc.ops,
    maxBytes: () => deps.config.maxFileSizeKb * KB,
    selected,
    strs: () => cgscStrs,
    checksums: () => cgscChecksums
  })

  /*
   * Which tunes are actually in the space, by folder.
   *
   * The catalogue covers the whole release, so it lists tunes a partly
   * synced - or freshly unpacked and not yet complete - collection does not
   * have. One listing per folder visited says which, cheaply, and is what
   * lets a row say "not downloaded" rather than failing silently when played.
   * Search results span folders nobody has opened, so there the answer is
   * honestly unknown and no row claims anything.
   */
  const listed = shallowRef(new Map<string, Set<string>>())
  const fetching = shallowRef(new Set<string>())
  /** True while the mirror is being asked which release it has. */
  const checking = ref(false)
  const online = computed(() => status.value?.mode === 'online')

  /* ---- reading the collection ------------------------------------------ */

  /**
   * What the server says the collection's three documents are, as one
   * string of their checksums, or null where it does not say for the
   * manifest - no file, no checksum, a listing that failed. One listing of
   * one small folder. All three, because the cache holds all three: a STIL
   * or Musicians.txt replaced under an unchanged manifest would otherwise be
   * served stale for as long as the manifest stood.
   */
  const documentsChecksum = async (): Promise<string | null> => {
    try {
      const { files } = await ops().list(parentFolder(documentPath(DOCUMENTS.manifest)))
      const sum = (name: string): string | null =>
        files.find((file) => file.path === documentPath(name))?.md5?.toLowerCase() ?? null
      const manifest = sum(DOCUMENTS.manifest)
      if (!manifest) return null
      return [manifest, sum(DOCUMENTS.stil) ?? '-', sum(DOCUMENTS.musicians) ?? '-'].join(' ')
    } catch {
      return null
    }
  }

  /**
   * `known` is the documents' checksums where the caller has just listed
   * them, which spares listing the folder a second time on the way in.
   */
  const fetchDocuments = async (
    release: number,
    have?: Map<string, string>,
    known?: string | null
  ): Promise<CachedDocuments> => {
    /*
     * The collection's own copies first: they are what the local files match.
     * Falling back to the mirror matters for a collection that someone copied
     * in by hand without `DOCUMENTS/`, and for the moments before a first
     * sync has written them; without lengths and commentary the library still
     * works, but it is much less useful than it should be.
     *
     * Read as Latin-1 from both places. These are HVSC's own documents, which
     * are ISO-8859-1, and the space read used to go through `readText` and so
     * through the browser's UTF-8 decoder: every accented name in STIL and
     * Musicians.txt arrived with U+FFFD in it and was then cached and indexed
     * that way, so "Orbán" could not be found by typing it. The mirror path
     * always decoded correctly, which is why this only showed up once a
     * collection had documents of its own - that is, on nearly every open.
     */
    const readBoth = async (name: string): Promise<string | null> => {
      const inHand = have?.get(name)
      if (inHand) return inHand
      const mine = await readLatin1(ops(), documentPath(name))
      if (mine) return mine
      return mirror.document(name).catch(() => null)
    }
    // Together: three reads of about nine megabytes that wait on nothing but
    // the server.
    message.value = 'Reading the collection index and the commentary'
    // Before the file it describes, not beside it: replaced in between, the
    // old text would be kept under the new checksum and trusted from then
    // on. This way round the worst is one more read than was needed.
    const checksums = known === undefined ? await documentsChecksum() : known
    const [manifest, stilText, musiciansText] = await Promise.all([
      readBoth(DOCUMENTS.manifest),
      readBoth(DOCUMENTS.stil),
      readBoth(DOCUMENTS.musicians)
    ])
    return {
      release,
      songlengths: manifest ?? '',
      ...(checksums ? { checksums } : {}),
      stil: stilText,
      musicians: musiciansText
    }
  }

  /**
   * Counts catalogues built. A header pass that started over one catalogue
   * and finished after a sync had built the next would otherwise apply, and
   * cache, what it read under the newer rows' MD5s.
   */
  let catalogueGeneration = 0
  /**
   * What the server says each file on disk is, from folder listings and an
   * update's walk. A header read from the disk copy is cached under the
   * catalogue's MD5, which is right only when the two agree; where they are
   * known to differ - a sync that did not finish, a collection older than
   * its own documents - what was read belongs to another file, and caching
   * it would put the wrong title on the right one for good.
   */
  let diskMd5 = new Map<string, string>()
  /**
   * The catalogue as last built, before any header was applied: the same
   * rows in the same order as `rows`, which only ever has headers folded in
   * place. Not reactive; `tree`, set beside it, is what says it changed.
   */
  let builtRows: CatalogRow[] = []

  /**
   * `fresh` is headers read since the cache was last written to - a sync's -
   * which go on top of it, so they count even in a browser that will not
   * keep a database, and without waiting for one that will.
   */
  const build = async (documents: CachedDocuments, fresh?: Map<string, HeaderFields>): Promise<void> => {
    catalogueGeneration++
    message.value = 'Building the catalogue'
    const manifest = parseManifest(documents.songlengths)
    let catalog = buildCatalog(manifest.entries)

    stil.value = documents.stil ? parseStil(documents.stil) : null
    musicians.value = documents.musicians ? parseMusicians(documents.musicians) : null

    const cached = await cache.loadHeaders()
    for (const [md5, fields] of fresh ?? []) cached.set(md5, fields)
    if (cached.size) {
      message.value = 'Applying what is already known about each tune'
      catalog = applyHeadersByMd5(catalog, cached)
    }

    builtRows = catalog
    rows.value = catalog
    tree.value = buildTree(catalog)
    // The old index is of the old rows; the new one is built when it is
    // first wanted or the page first has a moment, whichever comes first.
    held.hvsc.built = null
    indexGeneration.hvsc.value++
    warmIndexes()
  }

  /**
   * Builds whichever indexes are not built, one per idle moment. HVSC's
   * takes over a second; the Compute's after it in the same task made that
   * task longer still, and a later moment costs nothing.
   */
  let warming = false
  const warmIndexes = (): void => {
    if (warming) return
    warming = true
    const later = (build: () => void): void => {
      if (typeof requestIdleCallback === 'function') requestIdleCallback(build, { timeout: 3000 })
      else setTimeout(build, 200)
    }
    const next = (): void => {
      const key = COLLECTION_KEYS.find((which) => !held[which].built && held[which].rows.value.length)
      if (!key) {
        warming = false
        return
      }
      held[key].index()
      later(next)
    }
    later(next)
  }

  /**
   * Reads the Compute's Gazette folder, if there is one.
   *
   * After the main library is up, never before it: this is a second
   * collection, and someone who has only HVSC should not wait on a folder
   * that is not there. Failure is silence, not an error - the section simply
   * does not appear - because the library is entirely usable without it.
   */
  async function loadCgsc(): Promise<void> {
    if (cgscLoading.value || held.cgsc.rows.value.length) return
    cgscLoading.value = true
    try {
      const found = await readCgscPaths(held.cgsc.ops(), {
        onProgress: (files, folders) => {
          cgscProgress.value = `Reading Compute's Gazette \u2014 ${files.toLocaleString()} files in ${folders.toLocaleString()} folders`
        }
      })
      if (!found) return
      const catalog = buildCgscCatalog(found.paths)
      // Only what a selection will ask about, rather than every file kept
      // for the life of the page.
      cgscStrs = new Set(
        found.paths.filter((path) => /\.str$/i.test(path)).map((path) => cgscPath(path).toLowerCase())
      )
      cgscChecksums = new Map()
      for (const [path, md5] of found.checksums ?? [])
        if (md5 && /\.mus$/i.test(path)) cgscChecksums.set(cgscPath(path), md5)
      held.cgsc.rows.value = catalog.rows
      held.cgsc.tree.value = catalog.tree
      cgscFolders.value = catalog.folders
      cgscSource.value = found.source
      held.cgsc.built = null
      indexGeneration.cgsc.value++
      warmIndexes()
    } catch (e) {
      console.info('[sidplayer] the Compute\u2019s Gazette folder could not be read', e)
    } finally {
      cgscLoading.value = false
      cgscProgress.value = ''
    }
  }

  /* ---- opening --------------------------------------------------------- */

  /**
   * Where the library opens: on the favourites when there are any, and on
   * the composers when there are not. It used to open on MUSICIANS, which
   * holds most of the collection and so is a listing of 56,568 tunes that
   * nobody came to scroll through.
   *
   * Only stars that will actually be listed count, so a file holding nothing
   * but tunes a later release withdrew does not open on an empty list. A
   * Compute's star is taken on trust, because that collection is read a
   * moment after this and cannot be checked yet - which is what `optional`
   * says of it.
   *
   * Chosen once, the first time the library is ready, by whichever road it
   * got there - opening an existing collection, or the end of a first sync.
   * Watching the phase rather than calling this from each road means a road
   * added later cannot forget it. "Try again", a later update and its
   * rebuild all reach ready again, and none of them should move the user off
   * what they are looking at, so the watch stops after the first.
   *
   * Synchronous, so the view is chosen before anything renders the ready
   * library on the wrong one.
   */
  const stopChoosing = watch(
    phase,
    (now) => {
      if (now !== 'ready') return
      stopChoosing()
      const catalogued = new Set(rows.value.map((row) => row.path))
      const anyListed = favourites.value.items.some(
        (item) => COLLECTIONS[collectionOf(item)].optional || catalogued.has(item.path)
      )
      mode.value = anyListed ? 'favourites' : 'composers'
    },
    { flush: 'sync' }
  )

  /**
   * One at a time. The view starts the library when it mounts, and mounted
   * twice in quick succession - there and back before the first had found
   * the collection - the two ran through each other: the catalogue was built
   * twice and the second moved the root a second time.
   */
  let starting: Promise<void> | null = null
  function init(): Promise<void> {
    if (starting) return starting
    // The run itself is handed back, not a promise chained on it, so the
    // caller carries on as soon as it ends and not a tick or two later.
    const run = start()
    starting = run
    const clear = (): void => {
      if (starting === run) starting = null
    }
    void run.then(clear, clear)
    return run
  }

  async function start(): Promise<void> {
    phase.value = 'starting'
    error.value = null
    try {
      layout.attach()
      message.value = 'Looking for the collection'
      if (!(await layout.locate())) {
        // The stars too: a Compute's tune can be starred before HVSC is
        // synced, and the app's folder may be there from an earlier one.
        const [read] = await Promise.all([readStatus(), stars.load()])
        status.value = read
        layout.claimArchiveFolder()
        phase.value = 'first-run'
        void checkUpstream()
        void loadCgsc()
        return
      }

      phase.value = 'loading'
      // Four reads that wait on nothing but the server, so together.
      const [read, , cached, onDisk] = await Promise.all([
        readStatus(),
        stars.load(),
        cache.loadDocuments(),
        documentsChecksum()
      ])
      status.value = read ?? { ...EMPTY_STATUS }
      if (status.value.release === null && !status.value.unfinished) {
        const own = await readCollectionRelease()
        // Left in memory rather than written now: the next check writes it
        // along with everything else, and opening the library should not.
        if (own !== null) status.value = { ...status.value, release: own }
      }

      const release = status.value.release ?? cached?.release ?? 0
      // The cached copy is used when it is of the file now in the space.
      // Where the server names no checksum there is only the release number
      // to go by, as there always was.
      const current = !onDisk || cached?.checksums === onDisk
      if (cached && cached.release === release && cached.songlengths && current) {
        await build(cached)
      } else {
        const documents = await fetchDocuments(release, undefined, onDisk)
        await build(documents)
        void cache.saveDocuments(documents)
      }

      // How many tunes the documents just read describe, where no sync has said.
      if (status.value.release === null && rows.value.length) {
        status.value = { ...status.value, files: rows.value.length }
      }
      phase.value = 'ready'
      void checkUpstream()
      void fillVisibleHeaders()
      void loadCgsc()
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      phase.value = 'failed'
    }
  }

  /**
   * Folds newly read header fields into the search index.
   *
   * Incrementally, because a full rebuild over release 85 is 1.4 seconds of
   * blocked main thread: paid on every folder opened and every search, it
   * froze the page - clock, spectrum and clicks - in the middle of whatever
   * was playing. A rebuild is still the answer when the catalogue itself
   * changed, which `update` reports by returning false.
   */
  const refreshIndex = (): void => {
    // An index not built yet has nothing to fold into: it will be built
    // from these rows when it is.
    if (held.hvsc.built && !held.hvsc.built.update(rows.value)) {
      held.hvsc.built = null
      warmIndexes()
    }
    indexGeneration.hvsc.value++
  }

  const readStatus = async (): Promise<CollectionStatus | null> =>
    parseStatus((await layout.privateOps().readText(STATUS_PATH)) ?? '')

  /** Kept in memory either way; true when the space has it too. */
  const writeStatus = async (next: CollectionStatus): Promise<boolean> => {
    status.value = next
    return layout
      .privateOps()
      .writeText(STATUS_PATH, serialiseStatus(next))
      .then(
        () => true,
        () => false
      )
  }

  /**
   * What release the collection in the space says it is, from its own
   * `DOCUMENTS/HVSC.txt`.
   *
   * Without this the release was only ever known after a sync this app ran,
   * so a collection unpacked from HVSC's own archive had none for ever: the
   * banner offered release 85 to a release-85 collection and said "you have
   * nothing", and the update check could never be satisfied.
   */
  const readCollectionRelease = async (): Promise<number | null> => {
    const text = await readLatin1(ops(), documentPath(DOCUMENTS.release)).catch(() => null)
    return text ? parseRelease(text) : null
  }

  /**
   * Asks the mirror which release it has, but only when what we know is
   * missing or a day old. This is the whole of the update checking: no timer,
   * no background task, no service to install.
   */
  async function checkUpstream(): Promise<void> {
    if (!shouldCheck(status.value)) return
    checking.value = true
    try {
      const upstream = await mirror.release()
      if (upstream === null) return
      const next: CollectionStatus = {
        ...(status.value ?? EMPTY_STATUS),
        upstream,
        checkedAt: new Date().toISOString(),
        app: 'sidplayer'
      }
      /*
       * Recorded in the space only once there is a collection to record it
       * about. On the first-run screen the app's folder does not exist yet,
       * and creating it to file an answer nobody asked for would write to
       * someone's space before they had decided to use the library at all -
       * which the paragraph at the top of this file promises not to do.
       */
      if (phase.value === 'first-run') status.value = next
      else await writeStatus(next)
    } finally {
      checking.value = false
    }
  }

  /* ---- what the panes show --------------------------------------------- */

  /*
   * "This folder only" scopes to a folder in one collection, so it is also a
   * statement about which collection to search: a Compute's path prefix
   * matches no HVSC row and the other way about, and returning nothing from
   * the other side is the honest reading of the box rather than an accident
   * of the prefix.
   */
  const scopedTo = (which: Collection): SearchFilters | null => {
    const scoped: SearchFilters = {}
    if (!scopeToFolder.value || !folder.value) return scoped
    if (collection.value !== which) return null
    // With the slash, or `Blues` would take in `Blues_Muz` beside it.
    // The root is no scope at all.
    const within = folder.value.replace(/^\/+|\/+$/g, '').toUpperCase()
    if (within) scoped.pathPrefix = `${within}/`
    return scoped
  }

  /** A folder's rows and those of every folder beneath it; all of them for the root. */
  const rowsUnder = (all: CatalogRow[], path: string): CatalogRow[] => {
    if (path === '/' || !path) return all
    const prefix = `${path}/`
    return all.filter((row) => row.folder === path || row.folder.startsWith(prefix))
  }

  /**
   * How many hits a search keeps from each collection: the best of them.
   * Enough for any query that means something, and a one-letter query that
   * matches most of the release does not then draw 61,157 rows.
   */
  const SEARCH_LIMIT = 500
  /**
   * What a search finds in one collection: nothing outside a search, or
   * where the scope is the other's. One more hit than is shown is asked
   * for, which is how a search with exactly the limit's worth of matches is
   * told from one that has more.
   */
  const searchIn = (which: Collection) =>
    computed(() => {
      void indexGeneration[which].value
      const scoped = mode.value === 'search' ? scopedTo(which) : null
      const asked =
        (scoped && held[which].index()?.search(query.value, { filters: scoped, limit: SEARCH_LIMIT + 1 })) || []
      const hits = asked.slice(0, SEARCH_LIMIT)
      return { hits, rows: hits.map((hit) => hit.row), capped: asked.length > SEARCH_LIMIT }
    })
  const searched = Object.fromEntries(COLLECTION_KEYS.map((key) => [key, searchIn(key)])) as Record<
    Collection,
    ReturnType<typeof searchIn>
  >
  /** Whether a search stopped at the limit somewhere, so there are more matches than it shows. */
  const searchCapped = computed(() => COLLECTION_KEYS.some((key) => searched[key].value.capped))
  const hits = computed(() => searched.hvsc.value.hits)

  /** Whether a collection is there to speak for: always, unless it is optional and has not been read. */
  const present = (key: Collection): boolean => !COLLECTIONS[key].optional || held[key].rows.value.length > 0

  const unanswerable = computed<HeaderOnlyFilter[]>(() =>
    mode.value === 'search' && COLLECTION_KEYS.some((key) => !COLLECTIONS[key].headers && present(key))
      ? headerOnlyFilters(query.value)
      : []
  )

  /**
   * The rows this view is about, in their natural order: path order in a
   * folder, relevance in a search. Kept separate from `visible` so that
   * re-sorting only happens when the sort or the set itself changes, not
   * every time something else in the library does.
   */
  const unsorted = computed<CatalogRow[]>(() => {
    if (mode.value === 'search') return searched.hvsc.value.rows
    if (mode.value === 'favourites') {
      /*
       * In the order the user put them in, not the order the catalogue
       * happens to hold them: this is the one view whose natural order is
       * a human decision. One pass over the rows, the same as the filter
       * it replaces, because the starred set is small and the catalogue is
       * not.
       */
      const starred = starredKeys.value
      const starredRows = new Map<string, CatalogRow>()
      // Both catalogues. Looking only in HVSC's meant a Compute's star was
      // written correctly and then never appeared in the list that exists to
      // show it, which is worse than not offering the star at all. A row's
      // path is checked before its key is built: a handful of stars against
      // 77,000 rows should not cost 77,000 strings.
      const starredPaths = new Set(favourites.value.items.map((item) => item.path))
      for (const key of COLLECTION_KEYS) {
        for (const row of held[key].rows.value) {
          if (!starredPaths.has(row.path)) continue
          const rowStar = favouriteKey(row)
          if (starred.has(rowStar)) starredRows.set(rowStar, row)
        }
      }
      return orderedFavourites(favourites.value)
        .map((item) => starredRows.get(favouriteKey(item)))
        .filter((row): row is CatalogRow => row !== undefined)
    }
    if (mode.value === 'composers') return []
    /*
     * Everything under the folder, not just its own files.
     *
     * An exact match left `MUSICIANS` - and "All tunes" - showing nothing at
     * all, because in HVSC those hold only subfolders. The tree already
     * reports the recursive total beside each name, so the list has to be
     * the set that total describes, or the two contradict each other. The
     * table windows to 400 rows and says how many it is not showing, which
     * is what makes "All tunes" a reasonable thing to click.
     */
    return rowsUnder(held[collection.value].rows.value, folder.value)
  })

  /**
   * The list as headed blocks.
   *
   * One unheaded block everywhere but a search, and in a search one per
   * collection as soon as there is a second collection to speak for. The
   * Compute's block is kept even when it is empty, because an empty block
   * under a heading that says why is the whole point of separating them:
   * `year:1987` returning nothing from a collection that records no years
   * should say so rather than look like an answer.
   */
  const blocks = computed<ListBlock[]>(() => {
    const plain: ListBlock[] = [{ key: 'only', label: '', rows: unsorted.value }]
    if (mode.value !== 'search') return plain
    const here = COLLECTION_KEYS.filter(present)
    if (here.length < 2) return plain
    /*
     * "This folder only" is a statement about one collection, so the other
     * gets no heading at all rather than an empty one: a heading reading
     * "High Voltage SID Collection 0" over a search scoped to a Compute's
     * folder describes the scope, not the collection.
     */
    if (scopeToFolder.value && folder.value) {
      return [{ key: 'only', label: '', rows: searched[collection.value].value.rows }]
    }
    const beside = here.filter((key) => COLLECTIONS[key].optional)
    if (!beside.some((key) => searched[key].value.hits.length) && !unanswerable.value.length) return plain
    return here.map((key) => ({ key, label: COLLECTIONS[key].label, rows: searched[key].value.rows }))
  })

  /*
   * Sorted before the table takes its window, or the sort would only
   * reorder whatever rows happened to be at the front. Null is the common
   * case and costs nothing. Each block sorts within itself: the two are
   * separate lists that happen to be drawn one above the other.
   */
  const sortedBlocks = computed<ListBlock[]>(() =>
    sort.value
      ? blocks.value.map((block) => ({ ...block, rows: sortRows(block.rows, sort.value as SortOrder) }))
      : blocks.value
  )

  const visible = computed<CatalogRow[]>(() =>
    sortedBlocks.value.length === 1 ? sortedBlocks.value[0].rows : sortedBlocks.value.flatMap((b) => b.rows)
  )

  /**
   * True when the listing reaches past the folder itself, in which case rows
   * need to say where they came from.
   */
  const listingIsDeep = computed(
    () => mode.value === 'folder' && visible.value.some((row) => row.folder !== folder.value)
  )

  /*
   * The composers, in two steps. Who they are and how many tunes each has
   * depends only on the catalogue, which changes when one is built; the rows
   * themselves are replaced every time headers arrive, and grouping all
   * 61,157 of them again for that was the larger part of every header fill
   * while this view was open. Headers are applied in place, so a row's index
   * survives them, and the examples are looked up by it.
   */
  const composerGroups = computed(() => {
    void tree.value
    const byFolder = new Map<string, { entry: Omit<ComposerEntry, 'examples'>; examples: number[] }>()
    builtRows.forEach((row, index) => {
      if (!row.composerFolder) return
      let group = byFolder.get(row.composerFolder)
      if (!group) {
        const musician = musicians.value ? musicianForFolder(musicians.value, row.composerFolder) : undefined
        group = {
          entry: {
            folder: row.composerFolder,
            // `/MUSICIANS/<initial>/<composer>`: the first three segments of
            // any row filed under this composer.
            path: `/${row.folder.split('/').filter(Boolean).slice(0, 3).join('/')}`,
            name: row.composer ?? composerName(row.composerFolder),
            count: 0,
            realName: musician?.realName,
            country: musician?.country
          },
          examples: []
        }
        byFolder.set(row.composerFolder, group)
      }
      group.entry.count++
      if (group.examples.length < 3) group.examples.push(index)
    })
    return [...byFolder.values()].sort(
      (a, b) => b.entry.count - a.entry.count || (a.entry.name < b.entry.name ? -1 : 1)
    )
  })
  const composers = computed<ComposerEntry[]>(() => {
    const all = rows.value
    return composerGroups.value.map(({ entry, examples }) => ({
      ...entry,
      examples: examples.map((index) => all[index]).filter(Boolean)
    }))
  })

  /**
   * The one line the top bar shows. Ordered by what a person most needs to
   * know: work that writes to their space first, then work that only reads.
   */
  const activity = computed<Activity | null>(() => {
    const s = sync.value
    if (s.state === 'running') {
      const p = s.progress
      const percent = p && p.total ? Math.round((p.done / p.total) * 100) : 0
      return {
        kind: 'syncing',
        percent,
        opensSync: true,
        // A run with no tunes in it is the documents alone, and a count of
        // nought files would say nothing about them.
        text:
          p && p.total
            ? `Updating ${percent}% — ${p.done.toLocaleString()} of ${p.total.toLocaleString()} files`
            : p
              ? message.value || 'Fetching the collection documents'
              : 'Updating'
      }
    }
    if (s.state === 'paused') {
      return { kind: 'paused', opensSync: true, text: 'Update paused' }
    }
    if (s.state === 'planning') {
      return { kind: 'planning', opensSync: true, text: message.value || 'Working out what is needed' }
    }
    if (indexing.value.running) {
      const { done, total } = indexing.value
      return {
        kind: 'indexing',
        percent: total ? Math.round((done / total) * 100) : 0,
        opensSync: false,
        text: `Reading headers — ${done.toLocaleString()} of ${total.toLocaleString()}`
      }
    }
    if (checking.value) {
      return { kind: 'checking', opensSync: false, text: 'Checking for a new release' }
    }
    /*
     * Only ever seen where there is no index file to read: one GET is over
     * before anything could be said about it, and a walk of 500 folders is
     * the better part of a minute.
     */
    if (cgscProgress.value) {
      return { kind: 'reading', opensSync: false, text: cgscProgress.value }
    }
    return null
  })

  /* ---- actions --------------------------------------------------------- */

  /**
   * Drops every folder listing, to be listed again when next needed, and
   * lists the one on screen now. For after a sync has written: a listing
   * from before it would go on calling its new tunes missing, and playing
   * one would fetch it again over the copy just written.
   */
  function forgetListings(): void {
    listed.value = new Map()
    diskMd5 = new Map()
    headers.forgetUnread()
    if (mode.value === 'folder' && COLLECTIONS[collection.value].mirrored) void noteFolderContents(folder.value)
  }

  /** Notes which of a folder's tunes are present, once per folder. */
  async function noteFolderContents(path: string): Promise<void> {
    if (listed.value.has(path)) return
    try {
      const { files } = await ops().list(path)
      const next = new Map(listed.value)
      next.set(path, new Set(files.map((file) => file.path)))
      listed.value = next
      for (const file of files) if (file.md5) diskMd5.set(file.path, file.md5.toLowerCase())
      // Headers wait on a listing where they are not assumed; this is it.
      void fillVisibleHeaders()
    } catch {
      /* unreadable: leave it unknown rather than claim absence */
    }
  }

  function openFolder(path: string, which: Collection = 'hvsc'): void {
    folder.value = path
    collection.value = which
    mode.value = 'folder'
    query.value = ''
    /*
     * Neither of these applies to Compute's. There is no mirror serving it,
     * so a tune the index lists and the server has not got cannot be fetched
     * on demand and marking it "not downloaded" would promise something the
     * library cannot do; and a MUS file has no 128-byte header to read a
     * title, a year or a chip model out of.
     */
    if (COLLECTIONS[which].mirrored) void noteFolderContents(path)
    if (COLLECTIONS[which].headers) void fillVisibleHeaders()
  }

  function search(text: string): void {
    query.value = text
    mode.value = text.trim() ? 'search' : 'folder'
    void fillVisibleHeaders()
  }

  function select(row: CatalogRow | null): void {
    selected.value = row
    if (row) void mus.read(row)
  }

  /**
   * A sort outlives the folder it was set in, the way a file manager's does;
   * clearing it is the third click on the same column.
   */
  function toggleSort(column: SortColumn): void {
    sort.value = nextSort(sort.value, column)
  }

  /**
   * A catalogue row is a path, and the player wants a Resource. The synthetic
   * one carries a stable id so playing the same tune twice is recognised as
   * the same tune, and no size, so the player's own size guard reads zero and
   * lets a file it is about to fetch through.
   *
   * Uses the resolved root, so a C64Music layout plays as readily as a flat one.
   */
  const resourceFor = (row: CatalogRow): Resource =>
    ({
      id: rowKey(row),
      fileId: undefined,
      name: row.name,
      path: spacePath(held[collectionOf(row)].root(), row.path),
      extension: extensionOf(row.name),
      type: 'file',
      isFolder: false,
      mimeType: 'audio/prs.sid'
    }) as unknown as Resource

  /**
   * The row key of a tune the player has, or null where it is no row's.
   *
   * A tune played from here carries its row's key as its id. One opened
   * from Files carries the server's id instead, and is matched by where it
   * is: the same space, inside one collection's folder.
   */
  const keyOfPlaying = (resource: Resource, space?: { id?: unknown }): string | null => {
    const id = resource.id
    if (typeof id === 'string' && COLLECTION_KEYS.some((key) => id.startsWith(`${key}:/`))) return id
    const mine = layout.space()
    if (!mine || (space && space.id !== mine.id) || typeof resource.path !== 'string') return null
    // The deepest folder first: a collection kept loose in the app's folder
    // has the Compute's folder inside its own.
    const roots = COLLECTION_KEYS.map((key) => ({ key, root: held[key].root().replace(/\/+$/, '') })).sort(
      (a, b) => b.root.length - a.root.length
    )
    const path = resource.path
    const home = roots.find(({ root }) => path.startsWith(`${root}/`))
    return home ? `${home.key}:${path.slice(home.root.length)}` : null
  }

  /**
   * The list as it stood when play was last pressed.
   *
   * Kept apart from `visible`, which changes the instant anyone searches or
   * opens another folder. What follows the tune you put on is a question
   * about the list you put it on from, not about wherever you have wandered
   * since, so this is taken once and left alone.
   *
   * The rows themselves are not copied - these are the same objects the
   * catalogue holds - so freezing all 61,157 of "All tunes" costs one array
   * of pointers.
   */
  let running: CatalogRow[] = []

  /** Plays a tune from the frozen list without disturbing the running order. */
  async function playRunning(index: number): Promise<void> {
    const row = running[index]
    if (row) await playRow(row)
  }

  async function play(row: CatalogRow): Promise<void> {
    running = visible.value.slice()
    // By identity first, since the list holds the catalogue's own rows; by
    // path and collection where it does not, with no string built per row.
    let index = running.indexOf(row)
    if (index < 0) {
      index = running.findIndex((other) => other.path === row.path && other.collection === row.collection)
    }
    if (index < 0) {
      // Played from somewhere the list does not cover - the detail pane of a
      // tune that has since been searched away from, say. It is a list of one.
      running = [row]
    }
    deps.setQueue?.({
      length: running.length,
      index: Math.max(0, index),
      playAt: playRunning
    })
    await playRow(row)
  }

  /** Counts plays started here, so one overtaken during its awaits can stand down. */
  let playToken = 0

  /**
   * Plays a tune, fetching it first if the space does not have it.
   *
   * The catalogue describes the release, not the download, so a tune can be
   * in the list and not on disk - during a first sync, or in a collection
   * unpacked from an older archive. Rather than fail, the one file is
   * fetched through the mirror path and written where it belongs, which also
   * means the sync has that much less to do later.
   */
  async function playRow(row: CatalogRow): Promise<void> {
    const token = ++playToken
    /** Whether a later play has started since this one did. */
    const overtaken = (): boolean => token !== playToken
    playError.value = null
    select(row)
    /*
     * A Compute's tune is played or it is not. Nothing mirrors that
     * collection, so there is no fetching a missing file and no point
     * listing the folder to find out that one is missing; the player says
     * so if the file is not there, which is the same thing one listing
     * later.
     */
    if (!COLLECTIONS[collectionOf(row)].mirrored) {
      await deps.play(layout.space() as SpaceResource, resourceFor(row), { autoplay: true })
      return
    }
    await noteFolderContents(row.folder)
    if (overtaken()) return
    const here = listed.value.get(row.folder)
    /** Why an on-demand fetch failed, for the message if playback then does. */
    let fetchFailure: string | null = null

    if (here && !here.has(row.path)) {
      const next = new Set(fetching.value)
      next.add(row.path)
      fetching.value = next
      try {
        const bytes = await mirror.tune(row.path)
        // Checked before it is written, as a sync checks it: a proxy that
        // answers 200 with an error page would otherwise put that page into
        // the collection as this tune, listed as present from then on.
        if (row.md5 && md5Hex(bytes) !== row.md5) {
          throw new Error('what arrived is not the tune this release describes')
        }
        await ops().write(row.path, bytes)
        // The header as well, while the bytes are here to read it from.
        const fields = row.title === undefined ? fieldsFromBytes(bytes.subarray(0, HEADER_BYTES)) : null
        if (fields) headers.takeHeaders(new Map([[row.path, fields]]))
        const seen = new Map(listed.value)
        seen.set(row.folder, new Set([...(seen.get(row.folder) ?? []), row.path]))
        listed.value = seen
      } catch (e) {
        /*
         * Not fatal, and not a reason to stop.
         *
         * "The file is missing" is a conclusion drawn from one folder
         * listing, and a listing that came back short - or empty, or from a
         * server having a bad minute - looks exactly like a folder that has
         * nothing in it. Giving up here meant a tune sitting on disk would
         * not play because the copy we tried to put beside it was refused.
         *
         * So the fetch is best-effort and the tune is played anyway. But the
         * reason it failed is kept: the listing did succeed, and it said the
         * file is not there, so the play about to happen will almost
         * certainly fail with a bare 404 - and "could not be fetched, because
         * the mirror said 404" is a far better answer than that.
         */
        fetchFailure = `${row.title || row.stem} is not in your collection, and fetching it failed: ${
          e instanceof Error ? e.message : String(e)
        }`
        console.info('[sidplayer] could not fetch a tune the listing says is missing', {
          path: row.path,
          error: e
        })
      } finally {
        const done = new Set(fetching.value)
        done.delete(row.path)
        fetching.value = done
      }
    }

    // A tune chosen since has the player now. What was fetched is kept - it
    // is the collection's either way - but this one is not played over it.
    if (overtaken()) return
    // The catalogue row has the lengths already, from the same document the
    // player would otherwise read and parse again to find them.
    await deps.play(layout.space() as SpaceResource, resourceFor(row), {
      autoplay: true,
      ...(row.lengths.length ? { lengths: row.lengths, hvscPath: row.path } : {})
    })
    /*
     * Said after the attempt, not before, so it never appears over a tune
     * that turned out to play. `here` is only set when the listing actually
     * succeeded, so a failure here means the file really is absent.
     */
    if (fetchFailure && !overtaken()) playError.value = fetchFailure
  }

  /* ---- reading headers ------------------------------------------------- */

  const headers = createHeaderFilling({
    ready: () => phase.value === 'ready',
    rows,
    visible: () => visible.value,
    /*
     * Where its folder has been listed, the listing says; a header read for
     * a tune it does not show can only answer 404. Where it has not - a
     * search spans folders nobody has listed - a whole collection is assumed
     * to have the tune and an online one, where most tunes are not in the
     * space, is not.
     */
    mayHave: (row) => listed.value.get(row.folder)?.has(row.path) ?? !online.value,
    ops,
    cache,
    generation: () => catalogueGeneration,
    diskMd5: () => diskMd5,
    refreshIndex
  })
  const { indexing, fillVisibleHeaders } = headers

  /* ---- syncing --------------------------------------------------------- */

  const updates = createSyncController({
    mirror,
    ops,
    cache,
    phase,
    message,
    error,
    status,
    known: () => rows.value.length,
    diskMd5: () => diskMd5,
    forgetListings,
    writeStatus,
    fetchDocuments,
    build,
    fillVisibleHeaders,
    showHeaders: (fresh) => {
      if (!rows.value.length) return
      rows.value = applyHeadersByMd5(rows.value, fresh)
      refreshIndex()
    }
  })
  const { sync } = updates

  return {
    phase,
    message,
    error,
    playError,
    status,
    updateAvailable: computed(() => updateAvailable(status.value)),
    release: computed(() => status.value?.release ?? null),

    rows,
    tree,
    keyOfPlaying,
    searchCapped,
    stil,
    musicians,
    composers,

    mode,
    folder,
    collection,
    cgsc: {
      rows: held.cgsc.rows,
      tree: held.cgsc.tree,
      source: cgscSource,
      loading: cgscLoading,
      folders: cgscFolders
    },
    unanswerable,
    blocks: sortedBlocks,
    query,
    scopeToFolder,
    sort,
    visible,
    hits,

    selected,
    selectedMus: mus.selectedMus,
    favourites,
    isStarred: stars.isStarred,
    localBy: computed(() =>
      mode.value === 'folder' && COLLECTIONS[collection.value].mirrored ? listed.value : null
    ),
    listingIsDeep,
    fetching,
    indexing,
    activity,
    mirror,

    sync,

    init,
    openFolder,
    search,
    toggleSort,
    select,
    play,
    toggleStar: stars.toggleStar,
    moveFavourite: stars.moveFavourite,
    planUpdate: updates.planUpdate,
    startOnline: updates.startOnline,
    online,
    startUpdate: updates.startUpdate,
    pauseUpdate: updates.pauseUpdate,
    cancelUpdate: updates.cancelUpdate,
    indexAll: headers.indexAll,
    stopIndexing: headers.stopIndexing
  }
}

/**
 * The one library for the page, in the same spirit as the one player.
 *
 * `createLibrary` stays exported for the tests, which want a fresh one each
 * time, but the view goes through this. A library per mount meant that
 * leaving for Files and coming back built a second catalogue and a second
 * search index over 61,157 rows, left the first one's sync running with no
 * indicator and no way to stop it, and allowed a second sync to be started
 * against the same folders. The panel told people "leaving this page stops
 * the run", which route changes did not do and this makes unnecessary: the
 * run carries on and the indicator is there when they come back.
 */
let shared: Library | null = null

export function useLibrary(deps: LibraryDeps): Library {
  shared ??= createLibrary(deps)
  return shared
}
