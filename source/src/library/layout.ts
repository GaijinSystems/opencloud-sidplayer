import type { SpaceResource } from '@opencloud-eu/web-client'
import type { WebDav } from '../sid/source'
import { createSpaceOps, inFolderRenamed, withReadFallbacks, type SpaceOps } from '../hvsc/space'
import { LEGACY_PRIVATE_FOLDER, PRIVATE_FOLDER } from '../hvsc/sync'
import { ARCHIVE_FOLDER, resolveCollectionRoot } from '../hvsc/inventory'
import { CGSC_FOLDER } from '../cgsc/catalog'
import type { Collection } from './collections'

/**
 * Where everything is: which space, which folder in it is the app's own,
 * where in that the collections sit, and the operations over each.
 *
 * None of it is fixed when the library is made. The space may not have
 * loaded yet, the collection may be one folder deeper than configured or in
 * a folder of another name altogether, and each of those moves what `ops`
 * and `root` are. So this owns them, and everything else asks for them at
 * the moment of use rather than keeping what they were when it was made.
 */

export interface LayoutDeps {
  webdav: WebDav
  /** The user's space, or how to find it; asked again on every `attach`. */
  space: SpaceResource | undefined | (() => SpaceResource | undefined)
  /** The app's folder as configured. */
  configuredRoot: string
  /** Overridable for tests, which pins the layout: nothing is looked for elsewhere. */
  ops?: SpaceOps
  /** The Compute's Gazette folder, likewise. */
  cgscOps?: SpaceOps
}

export interface Layout {
  /** The space everything reads and writes; settled by `attach`. */
  space(): SpaceResource | undefined
  /** The folder a collection's paths are relative to. */
  root(collection: Collection): string
  /** Operations over a collection's folder. */
  ops(collection: Collection): SpaceOps
  /** Operations over the app's own files: `.sidplayer/`, beside the collections. */
  privateOps(): SpaceOps
  /**
   * Takes up the space as it now is. Throws, in words a person can act on,
   * where there is none yet.
   */
  attach(): void
  /**
   * Finds the collection and settles on where it is. False where there is
   * none, which leaves the layout as configured for `claimArchiveFolder`.
   */
  locate(): Promise<boolean>
  /** Picks the layout a first sync will write: the collection inside `C64Music/`. */
  claimArchiveFolder(): void
}

/**
 * What the app's folder was called before it was renamed to match the name
 * the launcher and the header use.
 *
 * Nobody's collection is going to move itself, so a folder here is looked
 * for whenever the configured one holds nothing. Without that the app would
 * greet an existing collection with the first-run screen and an offer to
 * download 395 MB it already has, into a second folder beside it.
 */
const LEGACY_ROOT = '/SID Player'

export function createLayout(deps: LayoutDeps): Layout {
  const { configuredRoot } = deps

  /** The app's own folder, which the collection and `.sidplayer/` sit inside. */
  let base = configuredRoot
  /*
   * The collection may sit one folder deeper than configured, because HVSC's
   * own archives unpack into `C64Music/`. `locate` looks, and rebuilds `ops`
   * against whatever it finds, so everything downstream - the sync, the
   * header reads, the status file - keeps using plain collection paths.
   */
  let root = configuredRoot
  const currentSpace = (): SpaceResource | undefined =>
    typeof deps.space === 'function' ? deps.space() : deps.space
  /** The space everything below reads and writes; settled by `attach`. */
  let space = currentSpace()
  /** Operations over a folder of the space as it now is: the one thing that differs is where. */
  const opsAt = (at: string): SpaceOps =>
    createSpaceOps({ webdav: deps.webdav, space: space as SpaceResource, root: at })
  let ops = deps.ops ?? opsAt(root)
  /*
   * The app's own folder hangs off the configured base, not off the
   * collection inside it: `/SID Library/.sidplayer/`, beside `C64Music/`
   * rather than within it. Favourites are the user's, not the release's,
   * and have no business living in a tree that re-extracting an archive or
   * a sync's removals pass could disturb.
   *
   * It used to live inside the collection, and before that the app was
   * `sidplay` and the folder `.sidplay/`. Anyone who moves an old folder into
   * the new home brings it along, so reads fall back to each old place in
   * turn; writes always go to the new one, which moves a file on first change.
   */
  const oldName = inFolderRenamed(PRIVATE_FOLDER, LEGACY_PRIVATE_FOLDER)
  /** The app's files in `home`, read from their old name there too, and from `collection` where they once lived. */
  const privateIn = (home: SpaceOps, collection?: SpaceOps): SpaceOps =>
    withReadFallbacks(home, [
      { ops: home, path: oldName },
      // Inside the collection the folder only ever had its old name.
      ...(collection ? [{ ops: collection, path: oldName }] : [])
    ])
  let privateOps = privateIn(ops)

  /*
   * The second collection, which sits beside the first rather than inside
   * it: `/SID Library/CGSC` against `/SID Library/C64Music`.
   *
   * Resolved rather than fixed, because `base` can still move: a collection
   * found in the folder's old name takes its Compute's folder with it.
   */
  let cgscRoot = `${configuredRoot}/${CGSC_FOLDER}`
  let cgscOpsCache: SpaceOps | null = deps.cgscOps ?? null
  const cgscOpsFor = (): SpaceOps => {
    cgscOpsCache ??= opsAt(cgscRoot)
    return cgscOpsCache
  }

  /**
   * Moves the collection's root into a folder of the app's own, leaving the
   * app's private files readable where they were before as well.
   */
  const descend = (into: string): void => {
    // Over the app's folder by name, not over whatever `ops` is at the
    // moment: asked twice, that was already the folder being moved into.
    const baseOps = opsAt(base)
    root = `${base}${into}`
    ops = opsAt(root)
    privateOps = privateIn(baseOps, ops)
  }

  function attach(): void {
    /*
     * Asked again each time. Operations built over no space - the library
     * opened before the spaces loaded - are built again over the one that
     * has arrived since, or "Try again" would never get anywhere.
     */
    const now = currentSpace()
    if (now && now !== space) {
      space = now
      cgscOpsCache = deps.cgscOps ?? null
      if (!deps.ops) {
        base = configuredRoot
        root = configuredRoot
        ops = opsAt(root)
        privateOps = privateIn(ops)
      }
    }
    /*
     * The spaces store may not have populated when this route is reached
     * by a deep link, and every WebDAV call below would then fail with
     * something opaque about a missing drive. Saying so plainly costs one
     * check, and "Try again" is a working answer once the store fills in.
     */
    if (!space) {
      throw new Error('Your personal space is not available yet. Try again in a moment.')
    }
  }

  async function locate(): Promise<boolean> {
    let within = await resolveCollectionRoot(ops)

    /*
     * Nothing under the configured name, so look where the folder used to
     * be called something else before it was renamed to match the launcher.
     *
     * Only ever a fallback, and only when the configured folder is empty,
     * so it costs one listing on a first run and nothing at all to anyone
     * already using the new name. The collection is then worked out of
     * where it actually is rather than moved, because moving several
     * hundred megabytes of somebody's files to suit a rename is not a
     * thing to do behind their back.
     */
    if (within === null && !deps.ops && base === configuredRoot && configuredRoot !== LEGACY_ROOT) {
      const legacyOps = opsAt(LEGACY_ROOT)
      const legacyWithin = await resolveCollectionRoot(legacyOps)
      if (legacyWithin !== null) {
        console.info(`[sidplayer] the collection is in ${LEGACY_ROOT}; working out of there`)
        base = LEGACY_ROOT
        root = LEGACY_ROOT
        ops = legacyOps
        // The app's own files with it. Left on the configured folder, a
        // collection kept loose under the old name opened with no stars
        // and no status, and the first new star began a second file.
        privateOps = privateIn(legacyOps)
        cgscRoot = `${LEGACY_ROOT}/${CGSC_FOLDER}`
        within = legacyWithin
      }
    }

    if (within === null) return false
    if (within && !deps.ops) {
      // An unpacked archive: the collection is under C64Music/, so that is
      // the root everything else works relative to. The app's own folder
      // stays one level up, where `base` points.
      descend(within)
    }
    return true
  }

  function claimArchiveFolder(): void {
    /*
     * Nothing there yet, so a first sync gets to pick the layout, and it
     * picks the one HVSC's own archives use: the collection inside
     * `C64Music/` rather than loose in the app's folder. That leaves
     * room beside it for other collections - Compute's Gazette, say -
     * and keeps `.sidplayer/` out of the tree a sync writes to.
     *
     * Guarded on the root being untouched so that running this twice,
     * which the "Try again" button and a rebuild both do, cannot nest a
     * second C64Music inside the first.
     */
    if (!deps.ops && root === base) descend(`/${ARCHIVE_FOLDER}`)
  }

  const roots: Record<Collection, () => string> = { hvsc: () => root, cgsc: () => cgscRoot }
  const opsOf: Record<Collection, () => SpaceOps> = { hvsc: () => ops, cgsc: cgscOpsFor }

  return {
    space: () => space,
    root: (collection) => roots[collection](),
    ops: (collection) => opsOf[collection](),
    privateOps: () => privateOps,
    attach,
    locate,
    claimArchiveFolder
  }
}
