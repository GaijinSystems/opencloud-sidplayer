import { markRaw, ref, type Ref } from 'vue'
import type { SpaceOps } from '../hvsc/space'
import { parseRelease, type MirrorOps } from '../hvsc/mirror'
import { parseManifest } from '../hvsc/manifest'
import { fieldsFromBytes, HEADER_BYTES, type HeaderFields } from '../hvsc/headers'
import type { CachedDocuments, DocumentCache, HeaderRecord } from '../hvsc/store'
import { walkSpace } from '../hvsc/inventory'
import {
  DOCUMENT_FILES,
  DOCUMENTS,
  documentPath,
  planSync,
  runSync,
  syncDocuments,
  type LocalIndex,
  type SyncPlan,
  type SyncProgress
} from '../hvsc/sync'
import { md5Hex } from '../sid/md5'
import { decodeLatin1 } from '../hvsc/text'
import { EMPTY_STATUS, type CollectionStatus } from '../hvsc/status'
import type { LibraryPhase } from './useLibrary'
import { throttle } from '../helpers/async'

/**
 * Bringing the collection in the space up to the mirror's release: the plan,
 * the run, and what is remembered between the two.
 *
 * A plan is made looking at the mirror's manifest and at everything the
 * space holds; a run carries it out, can be paused and picked up, and ends
 * by fetching the documents, stamping the release and having the catalogue
 * built again from what arrived. This owns the state of all that, and every
 * check on whether what the mirror sent is what it claims to be.
 */

export interface SyncState {
  state: 'idle' | 'planning' | 'running' | 'paused' | 'done'
  plan: SyncPlan | null
  progress: SyncProgress | null
  /** What to do about files the release no longer has. */
  removals: 'ask' | 'approved' | 'skip'
  startedAt: number | null
  error: string | null
  /**
   * What the plan covers. `all` is the whole release; `present` is what the
   * space already holds, which is how an online collection is updated -
   * the tunes it has are refreshed and the rest stay where they are until
   * they are played.
   */
  scope: SyncScope
  /** Something the plan warned about that did not stop it: said beside the plan and its outcome, never as a failure. */
  notice: string | null
}

export type SyncScope = 'all' | 'present'

/**
 * More tunes than a release could hold: four times what HVSC has gathered in
 * thirty years. A manifest is the mirror's word for how much to fetch, and
 * this is the limit on taking it.
 */
const MOST_TUNES = 250_000

export interface SyncDeps {
  mirror: MirrorOps
  /** The collection's folder, wherever it now is. */
  ops: () => SpaceOps
  cache: DocumentCache
  phase: Ref<LibraryPhase>
  message: Ref<string>
  error: Ref<string | null>
  status: Ref<CollectionStatus | null>
  /** How many tunes the catalogue now has, for judging a manifest against. */
  known: () => number
  /** What the server says each file on disk is, which a plan's walk adds to. */
  diskMd5: () => Map<string, string>
  /** Drops what was learned from folder listings; a run has written to them. */
  forgetListings: () => void
  /** True when the status reached the space, not only memory. */
  writeStatus: (next: CollectionStatus) => Promise<boolean>
  /** Reads the documents; `have` is any already in hand as text, by file name. */
  fetchDocuments: (release: number, have?: Map<string, string>) => Promise<CachedDocuments>
  /** Builds the catalogue from documents, with headers read since the cache was written. */
  build: (documents: CachedDocuments, fresh?: Map<string, HeaderFields>) => Promise<void>
  fillVisibleHeaders: () => Promise<void>
  /** Puts headers read by a run on the rows already on screen, by MD5. */
  showHeaders: (headers: Map<string, HeaderFields>) => void
}

export interface SyncController {
  sync: Ref<SyncState>
  /** True when a plan was made, whatever it warns about; false when planning failed or was not started. */
  planUpdate(scope?: SyncScope): Promise<boolean>
  startUpdate(): Promise<void>
  pauseUpdate(): void
  cancelUpdate(): void
  /**
   * Starts an online collection from nothing: the documents only, so the
   * whole release can be browsed and searched, with each tune fetched the
   * first time it is played.
   */
  startOnline(): Promise<void>
}

export function createSyncController(deps: SyncDeps): SyncController {
  const { mirror, cache, phase, message, error, status } = deps

  const sync = ref<SyncState>({
    state: 'idle',
    plan: null,
    progress: null,
    removals: 'ask',
    startedAt: null,
    error: null,
    scope: 'all',
    notice: null
  })
  let stopRequest: 'paused' | 'cancelled' | false = false

  /**
   * Whether a plan is being made or carried out. One at a time: the panel can
   * be closed mid-run and the update offered again, and a second run beside
   * the first fetched and wrote everything twice, then lost track of both.
   */
  const syncBusy = (): boolean => sync.value.state === 'planning' || sync.value.state === 'running'

  /** The release the plan in hand is for; null when there is no plan to finish. */
  let plannedRelease: number | null = null
  /**
   * Whether the plan in hand is for an online collection, decided when it
   * was made: a `present` plan always is, and an `all` plan is when an open
   * online collection asked for it. A status read on the first-run screen
   * describes a collection that is not there, so it decides nothing.
   */
  let planOnline = false
  /** What the space held when the plan was made, for the document compare. */
  let lastInventory: LocalIndex = new Map()
  /** How many tunes the plan's manifest listed, for judging the one that arrives at the end. */
  let plannedTunes = 0
  /**
   * The MD5 of the release index the plan was made from: which release the
   * tunes it fetched belong to, whatever number anything says.
   */
  let plannedIndex = ''
  /**
   * What runs of the current plan have finished, so a paused one resumes
   * where it stopped. A paused run used to start again from the first file:
   * a first sync paused at 50,000 of 61,157 fetched all 50,000 again.
   */
  let finishedInPlan = new Set<string>()
  /** The headers those runs read, by MD5, for the catalogue the plan ends by building. */
  let headersInPlan = new Map<string, HeaderFields>()

  /**
   * What identifies a release index: the MD5 of its text, as the mirror
   * client decodes it at planning and as the same decoder reads the bytes
   * fetched at the end. Compared in one form on both sides, so it does not
   * matter that the decoder is windows-1252 rather than Latin-1, whose upper
   * control range does not survive a round trip back to bytes.
   */
  const indexKey = (text: string): string => md5Hex(new TextEncoder().encode(text))

  /** Lets go of everything the plan in hand had gathered: it is over, or there is a new one. */
  const forgetPlan = (): void => {
    plannedRelease = null
    finishedInPlan = new Set()
    headersInPlan = new Map()
    lastInventory = new Map()
  }

  /**
   * `scope` defaults to what the collection is: an online one is updated in
   * place, a whole one brought up to the whole release. Downloading all of
   * an online collection is asking for `all` by name.
   */
  async function planUpdate(
    scope: SyncScope = status.value?.mode === 'online' ? 'present' : 'all'
  ): Promise<boolean> {
    if (syncBusy()) return false
    // Approving deletions is a decision about one plan, made looking at it.
    // Carried over, a later plan's thousands opened already approved.
    sync.value = {
      ...sync.value,
      state: 'planning',
      error: null,
      notice: null,
      progress: null,
      removals: 'ask'
    }
    try {
      const target = status.value?.upstream ?? status.value?.release ?? null
      message.value = 'Reading the release index'
      const manifestText = await mirror.document(DOCUMENTS.manifest)
      const manifest = parseManifest(manifestText)
      const indexMd5 = indexKey(manifestText)
      /*
       * Is this a manifest at all?
       *
       * Getting the proxy rule wrong sends mirror requests to OpenCloud,
       * whose single-page fallback answers 200 with HTML: that parses to no
       * entries, and a plan built on it would propose deleting the whole
       * collection. `planSync` refuses removals on an empty manifest come
       * what may; this is the check that can also see a manifest that is
       * merely far too short to be the release it claims to be.
       */
      const known = deps.known()
      if (
        !manifest.entries.length ||
        (known > 0 && manifest.entries.length < known / 2) ||
        manifest.entries.length > MOST_TUNES
      ) {
        throw new Error(
          `The release index came back with ${manifest.entries.length.toLocaleString()} tunes in it, which is not a collection. Check that the mirror path reaches an HVSC mirror.`
        )
      }
      message.value = 'Taking stock of what you already have'
      const say = throttle((files: number, folders: number) => {
        message.value = `Checked ${files.toLocaleString()} files in ${folders.toLocaleString()} folders`
      }, 100)
      const walk = await walkSpace(deps.ops(), {
        concurrency: 6,
        onProgress: (p) => say(p.files, p.folders)
      })
      say.flush()
      /*
       * An inventory with holes in it is worse than none. Every folder that
       * could not be listed looks empty, so its tunes are planned as
       * downloads and, if removals were approved, nothing protects them
       * either. An access token expiring partway through the three minutes
       * this takes is enough to cause it.
       */
      if (walk.failed.length) {
        throw new Error(
          `${walk.failed.length.toLocaleString()} folders could not be read, so this is not a complete picture of what you have. Try again.`
        )
      }
      const plan = planSync(manifest.entries, walk.index)
      /*
       * A manifest naming paths this app will not act on is one it does not
       * wholly understand, and the tunes behind those paths look, to the
       * plan, like tunes the release no longer has. Nothing is proposed for
       * removal on the strength of that.
       */
      // Nor on an index with entries it could not place, whose tunes would
      // look withdrawn just the same.
      if (manifest.rejected || manifest.skipped) plan.remove = []
      forgetPlan()
      lastInventory = walk.index
      const diskMd5 = deps.diskMd5()
      for (const [path, md5] of walk.index) if (md5) diskMd5.set(path, md5.toLowerCase())
      plannedTunes = manifest.entries.length
      plannedIndex = indexMd5
      // Raw: up to 61,157 entries that are only ever read, and a deep ref
      // would wrap every one of them in a proxy as the run walks the plan.
      sync.value = {
        ...sync.value,
        state: 'idle',
        plan: markRaw(plan),
        // Set with the plan, never before it: a plan that failed would
        // otherwise leave the previous plan in place under this one's scope.
        scope,
        // Said, since the plan that follows is otherwise silent about it.
        notice: manifest.rejected
          ? `${manifest.rejected.toLocaleString()} entries in the release index name paths this app will not write to. They are skipped, and nothing is proposed for removal.`
          : manifest.skipped
            ? `${manifest.skipped.toLocaleString()} entries in the release index have no path. They are skipped, and nothing is proposed for removal.`
            : null
      }
      message.value = ''
      // The catalogue is built again, from the release this plan is for,
      // once the sync finishes.
      plannedRelease = target ?? 0
      planOnline = scope === 'present' || (phase.value === 'ready' && status.value?.mode === 'online')
      return true
    } catch (e) {
      // No plan at all, rather than the last one under a new question: a
      // paused download left on offer here would run, and be labelled, as
      // whatever was asked for since.
      forgetPlan()
      sync.value = {
        ...sync.value,
        state: 'idle',
        plan: null,
        error: e instanceof Error ? e.message : String(e)
      }
      return false
    }
  }

  /**
   * Whether a collection document is what it says it is. The manifest gives
   * these no MD5, so this is all that stands between a proxy's error page
   * and the collection's own Songlengths.md5.
   */
  const acceptDocument = (path: string, bytes: Uint8Array): boolean => {
    const text = decodeLatin1(bytes)
    if (!text.trim() || /^\s*</.test(text)) return false
    if (path === documentPath(DOCUMENTS.release)) return parseRelease(text) !== null
    if (path === documentPath(DOCUMENTS.manifest)) {
      return parseManifest(text).entries.length >= Math.max(1, Math.floor(plannedTunes / 2))
    }
    return true
  }

  async function startUpdate(): Promise<void> {
    if (syncBusy()) return
    if (!sync.value.plan) await planUpdate()
    const whole = sync.value.plan
    if (!whole || syncBusy()) return
    stopRequest = false
    sync.value = { ...sync.value, state: 'running', startedAt: Date.now(), error: null }
    // What is left of it: everything the plan asks for, less what earlier
    // runs of the same plan already did. A `present` plan's additions are
    // what it leaves on the mirror, and are counted rather than fetched.
    const plan: SyncPlan = {
      ...whole,
      add: sync.value.scope === 'present' ? [] : whole.add.filter((e) => !finishedInPlan.has(e.path)),
      replace: whole.replace.filter((e) => !finishedInPlan.has(e.path)),
      remove: whole.remove.filter((path) => !finishedInPlan.has(path))
    }

    /*
     * Each tune's header, read out of the bytes as they pass through on
     * their way to the space and kept under the tune's MD5, which is where
     * the catalogue built at the end looks for them. Without this a first
     * sync ended with 61,157 tunes and not one title, and the offer to read
     * them all back out of the space, one request each.
     */
    let headersRead: HeaderRecord[] = []
    const keepHeaders = (): void => {
      if (headersRead.length) void cache.saveHeaders(headersRead)
      headersRead = []
    }

    /*
     * A count from the start, before any file has finished: what the run is
     * going to do, so the panel can say so - and say nothing about stopping
     * a run that has nothing to stop, which a run of documents alone is.
     */
    const removing = sync.value.removals === 'approved' ? plan.remove.length : 0
    sync.value = {
      ...sync.value,
      progress: {
        done: 0,
        total: plan.add.length + plan.replace.length + removing,
        bytes: 0,
        added: 0,
        replaced: 0,
        removed: 0,
        failed: 0,
        mismatched: 0,
        recent: []
      }
    }
    // A few times a second, not once per file: each write re-renders the panel.
    const showProgress = throttle((p: SyncProgress) => {
      sync.value = { ...sync.value, progress: { ...p, recent: [...p.recent] } }
    }, 100)
    const progress = await runSync(plan, {
      mirror,
      space: deps.ops(),
      concurrency: 6,
      applyRemovals: sync.value.removals === 'approved',
      // What arrives is checked against what the release says it should be,
      // so an error page from a proxy never lands in the collection wearing
      // a `.sid` extension.
      md5Of: md5Hex,
      shouldStop: () => stopRequest,
      onDone: (path) => finishedInPlan.add(path),
      onBytes: (entry, bytes) => {
        const fields = fieldsFromBytes(bytes.subarray(0, HEADER_BYTES))
        if (!fields) return
        headersRead.push({ md5: entry.md5, ...fields })
        headersInPlan.set(entry.md5, fields)
        // In batches, so a run stopped halfway keeps what it read.
        if (headersRead.length >= 500) keepHeaders()
      },
      onProgress: showProgress
    })
    showProgress.flush()

    keepHeaders()
    // Whatever folders were listed before the run, it has written to them.
    deps.forgetListings()
    // A run that stops short builds no catalogue, so what it read goes on
    // the rows there are: the tunes it fetched otherwise stayed untitled
    // until the next full build.
    if (progress.stopped && headersInPlan.size) deps.showHeaders(headersInPlan)
    if (progress.stopped === 'paused') {
      sync.value = { ...sync.value, state: 'paused', progress }
      return
    }
    if (progress.stopped === 'cancelled') {
      forgetPlan()
      sync.value = { ...sync.value, state: 'idle', progress, plan: null }
      return
    }

    /*
     * The documents, which the manifest does not list and so the plan never
     * mentions. Without this the collection arrives with no song lengths, no
     * STIL commentary and no composer names.
     */
    message.value = 'Fetching the collection documents'
    const documents = await syncDocuments(mirror, deps.ops(), lastInventory, md5Hex, DOCUMENT_FILES, {
      accept: acceptDocument
    })
    message.value = ''
    const fileName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)
    const missingDocuments = documents.failed.map(fileName).join(', ')

    /*
     * The collection claims the release it was synced to only if the sync
     * actually finished the job.
     *
     * A run where the mirror died after five thousand files used to be
     * stamped complete anyway, which left the collection claiming release
     * N+1 with thousands of tunes missing and `updateAvailable` false - so
     * nothing ever suggested finishing it, and only someone pressing
     * "update" by hand would have found out. The plan is rebuilt from the
     * MD5s each time, so simply not claiming the release is enough to make
     * the next run pick up exactly what is left.
     */
    // The documents too: the catalogue is built from Songlengths.md5, so a
    // run whose copy of it did not arrive has not brought the collection to
    // the release, and claiming it would hide the banner that finishes it.
    const finished = progress.failed === 0 && documents.failed.length === 0
    // The release the plan was made for, not whatever the mirror has said
    // since: a check that saw a newer one while this ran would otherwise be
    // claimed for files that are the older release's.
    //
    // Where the plan had no release to go by - the mirror's answer had not
    // come, or did not - the release document just fetched says which it
    // is, but only if the index fetched beside it is the one the plan was
    // made from. A release published while the run was paused would
    // otherwise be claimed for the previous one's tunes, and no update would
    // ever be offered for the difference. Then no release is claimed, and
    // the next update finds what is left. (A mirror caught between replacing
    // HVSC.txt and Songlengths.md5 could still pass this; that window is a
    // mirror's update, and nothing here can see into it.)
    const fetchedIndex = documents.arrived.get(documentPath(DOCUMENTS.manifest))
    const fetchedRelease = documents.arrived.get(documentPath(DOCUMENTS.release))
    const sameIndex = !!fetchedIndex && indexKey(decodeLatin1(fetchedIndex)) === plannedIndex
    const fromDocuments = sameIndex && fetchedRelease ? (parseRelease(decodeLatin1(fetchedRelease)) ?? 0) : 0
    const planned = plannedRelease || fromDocuments
    const release = finished ? planned || null : (status.value?.release ?? null)
    // An online collection that has now fetched the whole release is a
    // whole one; one stopped short stays online, with what it fetched kept.
    const { mode: _mode, unfinished: _unfinished, ...rest } = status.value ?? EMPTY_STATUS
    // A run that only refreshes what is here never makes a whole collection.
    const scope = sync.value.scope
    // Whole, too, when nothing was left on the mirror: every tune is here.
    const stillOnline = planOnline && !(finished && (scope === 'all' || whole.add.length === 0))
    const again =
      planOnline && scope === 'all' ? 'Press Download all… again to finish.' : 'Run the update again to finish.'
    const recorded = await deps.writeStatus({
      ...rest,
      release,
      syncedAt: new Date().toISOString(),
      // What the release holds, once this is the release; otherwise the
      // count is unknown and saying nothing beats saying a number that is
      // the catalogue's size plus whatever happened to be fetched.
      // Online, the space holds what has been played, which no plan counts.
      files: finished && !stillOnline ? plannedTunes : status.value?.files,
      ...(stillOnline ? { mode: 'online' as const } : {}),
      // Nothing claimed, so the documents just written must not be taken at
      // their word when the library next opens.
      ...(release === null ? { unfinished: true as const } : {})
    })
    // Taken before the plan is let go of: the catalogue below is built with them.
    const headers = headersInPlan
    forgetPlan()
    sync.value = {
      ...sync.value,
      state: 'done',
      progress,
      plan: null,
      error: finished
        ? null
        : progress.failed
          ? `${progress.failed.toLocaleString()} files could not be fetched${
              progress.mismatched
                ? `, ${progress.mismatched.toLocaleString()} of them because what arrived was not what the release describes`
                : ''
            }${missingDocuments ? `, and neither could ${missingDocuments}` : ''}.${
              progress.removalsHeld
                ? ' Nothing was removed, since a tune that could not be fetched may be one that only moved; choose to delete them again when you run it.'
                : ''
            } ${again}`
          : `Could not fetch ${missingDocuments}. ${again}`
    }
    // The files are in the space either way; what it is - its release, and
    // whether it is online - is only in this tab until the status is saved.
    if (!recorded && !sync.value.error) {
      sync.value = {
        ...sync.value,
        error:
          'Everything arrived, but the collection’s status could not be saved, so another visit will not know which release it is or whether it is online. Run the update again to save it.'
      }
    }

    // Rebuild from the release just fetched: new tunes, new documents - the
    // ones in hand, rather than reading back what was just written. Only
    // what is in the space is in hand, so nothing is built, and cached
    // under the space's checksum, from a document whose write failed.
    try {
      const have = new Map([...documents.arrived].map(([path, bytes]) => [fileName(path), decodeLatin1(bytes)]))
      const rebuilt = await deps.fetchDocuments(release ?? planned, have)
      await deps.build(rebuilt, headers)
      void cache.saveDocuments(rebuilt)
    } catch (e) {
      /*
       * The files arrived and the catalogue could not be read back. Said,
       * rather than thrown at nobody: this used to leave the panel reading
       * "done" over a first-run screen that never went away.
       */
      const why = e instanceof Error ? e.message : String(e)
      sync.value = {
        ...sync.value,
        error: `The update finished, but the catalogue could not be read afterwards (${why}). Reload to try again.`
      }
      // An update keeps the catalogue it had; a first sync has none.
      if (phase.value !== 'ready') {
        error.value = `The collection could not be read (${why}).`
        phase.value = 'failed'
      }
      return
    }
    phase.value = 'ready'
    void deps.fillVisibleHeaders()
  }

  function pauseUpdate(): void {
    stopRequest = 'paused'
  }

  function cancelUpdate(): void {
    stopRequest = 'cancelled'
  }

  async function startOnline(): Promise<void> {
    // The mode reaches the status when the run writes it, as everything
    // else does: a `present` plan is an online one. Started on a plan
    // whatever it warns about; only a failure to plan stops it.
    if (await planUpdate('present')) await startUpdate()
  }

  return { sync, planUpdate, startUpdate, pauseUpdate, cancelUpdate, startOnline }
}
