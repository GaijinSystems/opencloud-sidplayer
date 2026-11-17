import type { Resource, SpaceResource } from '@opencloud-eu/web-client'
import { lookupSonglengths, parseSonglengths, type SonglengthEntry, type SonglengthsDb } from './songlengths'
import { isMissing, parentFolder, statusOf, type WebDav } from './source'

/**
 * Finds a Songlengths.md5 for a tune.
 *
 * Two places are tried, in order:
 *
 * 1. The user's own space, walking up from the tune's folder: `Songlengths.md5`
 *    beside the tune, or `DOCUMENTS/Songlengths.md5` as HVSC lays it out at
 *    the collection root. Someone who uploaded HVSC whole gets lengths with
 *    no configuration at all.
 * 2. `songlengthsUrl` from the app configuration, for an instance-wide copy.
 *
 * The two are raced rather than tried in turn. The walk is up to twelve
 * levels of two probes each, and awaiting them one by one meant a tune six
 * folders down cost a dozen sequential 404s before the configured copy was
 * even asked for - all of it while the tune played on the default length. The
 * space still wins where both answer, because a database sitting beside the
 * collection is the one that describes it.
 *
 * Every database read is cached for the page's lifetime: the full HVSC file
 * is a few megabytes and parses to tens of thousands of entries, which is fine
 * once and wasteful per tune. A file that is not there is cached too, per
 * folder, so a space with no database costs one walk per folder, not one per
 * click. A read that failed is not: it said nothing about the file.
 */

const FILE = 'Songlengths.md5'
const MAX_ASCENT = 12
/** Several times the real file, which is about 5 MB for the whole collection. */
const MAX_BYTES = 32 * 1024 * 1024
/**
 * How much one walk up the tree reads in all. Each level may hold a file by
 * that name, and twelve levels of two at the limit each was most of a
 * gigabyte for one tune; two real databases fit with room to spare.
 */
const ASCENT_BUDGET = 2 * MAX_BYTES

/**
 * What a read found. `missing` is a real answer - no file there - and is
 * remembered; a failure to answer is not, so the next tune asks again.
 */
type Found = { db: SonglengthsDb | null; missing: boolean; bytes: number }

export class SonglengthsSource {
  private readonly byFolder = new Map<string, Promise<SonglengthsDb[]>>()
  private readonly byPath = new Map<string, Promise<Found>>()
  private configured: Promise<SonglengthsDb | null> | null = null

  constructor(
    private readonly webdav: WebDav,
    private readonly configUrl: string | null
  ) {}

  /**
   * The lengths for this tune: from the nearest database in the space that
   * lists it, failing that from the configured one.
   *
   * Lists it - not merely the nearest database. A Songlengths.md5 from an
   * older release, or one put beside a handful of tunes, used to win for
   * every tune below it whether or not it had heard of them, and the tunes it
   * had not played for the default length with a better answer unasked.
   */
  async lookup(space: SpaceResource, resource: Resource, bytes: Uint8Array): Promise<SonglengthEntry | null> {
    // Both at once. `findConfigured` memoises, so starting it here costs
    // nothing on any later call, and the space's answer is still preferred.
    const configured = this.findConfigured()
    const inSpace = await this.findInSpace(space, resource).catch(() => [])
    for (const db of inSpace) {
      const entry = lookupSonglengths(db, bytes)
      if (entry) return entry
    }
    const db = await configured
    return db ? lookupSonglengths(db, bytes) : null
  }

  private findInSpace(space: SpaceResource, resource: Resource): Promise<SonglengthsDb[]> {
    const folder = parentFolder(resource.path ?? '')
    const key = `${space.id}:${folder}`
    let pending = this.byFolder.get(key)
    if (!pending) {
      const walk = this.ascend(space, folder)
      pending = walk.then((found) => found.dbs)
      this.byFolder.set(key, pending)
      // Kept only if every level answered; otherwise the next tune walks again.
      void walk.then(
        (found) => {
          if (!found.complete && this.byFolder.get(key) === pending) this.byFolder.delete(key)
        },
        () => {
          if (this.byFolder.get(key) === pending) this.byFolder.delete(key)
        }
      )
    }
    return pending
  }

  /** Every database up the tree, nearest first, and whether every level answered. */
  private async ascend(
    space: SpaceResource,
    folder: string
  ): Promise<{ dbs: SonglengthsDb[]; complete: boolean }> {
    const dbs: SonglengthsDb[] = []
    let complete = true
    let dir = folder
    let read = 0
    for (let i = 0; i < MAX_ASCENT && read < ASCENT_BUDGET; i++) {
      /*
       * Both candidates of a level together. They are two different files and
       * neither tells us anything about the other, so there is no reason to
       * wait for the first 404 before asking for the second; beside-the-tune
       * still comes first where both exist.
       */
      const found = await Promise.all(
        [`${dir}/${FILE}`, `${dir}/DOCUMENTS/${FILE}`].map((candidate) =>
          this.readPath(space, candidate.replace(/\/{2,}/g, '/'))
        )
      )
      for (const { db, missing, bytes } of found) {
        read += bytes
        if (db) dbs.push(db)
        else if (!missing) complete = false
      }
      if (dir === '/' || dir === '') break
      dir = parentFolder(dir)
    }
    return { dbs, complete }
  }

  private readPath(space: SpaceResource, path: string): Promise<Found> {
    const key = `${space.id}:${path}`
    let pending = this.byPath.get(key)
    if (!pending) {
      pending = this.webdav
        /*
         * Its size first, and the file only if it could be a database. The
         * file is found by its name alone, in a folder that may be somebody's
         * share, and a Range header bounds what is sent only where the server
         * honours it; one that ignores it sent the whole of a file of several
         * hundred megabytes. A missing file costs the same one request as
         * before; one that is there costs one more.
         */
        .getFileInfo(space, { path })
        .then(async (info): Promise<Found> => {
          // A folder by that name is no database, and not one to ask again.
          if (info.type === 'folder' || info.isFolder) return { db: null, missing: true, bytes: 0 }
          if ((Number(info.size) || 0) > MAX_BYTES) {
            console.warn('[sidplayer] a Songlengths.md5 too large to be one was skipped', { path })
            return { db: null, missing: true, bytes: 0 }
          }
          // Asked for as text explicitly rather than relying on the client's
          // default, which is `text` today: were that to change, the database
          // would parse to nothing and the player would quietly run on the
          // configured length with no sign that anything had gone wrong. The
          // Range stays, for a file that grew between the two requests.
          const response = await this.webdav.getFileContents(
            space,
            { path },
            { responseType: 'text', headers: { Range: `bytes=0-${MAX_BYTES}` } }
          )
          if (typeof response.body !== 'string') {
            console.warn('[sidplayer] Songlengths.md5 came back in an unexpected shape', { path })
            return { db: null, missing: true, bytes: 0 }
          }
          const bytes = response.body.length
          if (bytes > MAX_BYTES) {
            console.warn('[sidplayer] a Songlengths.md5 too large to be one was skipped', { path })
            return { db: null, missing: true, bytes }
          }
          const db = parseSonglengths(response.body)
          if (db.size) console.info('[sidplayer] song lengths from', { path, entries: db.size })
          return { db: db.size ? db : null, missing: true, bytes }
        })
        .catch((e): Found => {
          /*
           * Only "not there" is an answer worth keeping. Anything else - an
           * expired token, a server having a bad minute - said nothing about
           * the file, and kept as "no database" it left every tune on the
           * default length until the page was reloaded.
           */
          const status = statusOf(e)
          // 416 is an empty file, which has no first byte to give.
          if (isMissing(e) || status === 416) return { db: null, missing: true, bytes: 0 }
          this.byPath.delete(key)
          return { db: null, missing: false, bytes: 0 }
        })
      this.byPath.set(key, pending)
    }
    return pending
  }

  private findConfigured(): Promise<SonglengthsDb | null> {
    if (!this.configUrl) return Promise.resolve(null)
    this.configured ??= fetch(this.configUrl)
      .then(async (response) => {
        if (response.status === 404) return null
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const db = parseSonglengths(await response.text())
        console.info('[sidplayer] song lengths from', { url: this.configUrl, entries: db.size })
        return db.size ? db : null
      })
      .catch((e) => {
        // Not kept: the next tune asks again, rather than every tune for the
        // rest of the page going without because of one bad minute.
        console.warn('[sidplayer] the configured Songlengths.md5 could not be read', {
          url: this.configUrl,
          error: e
        })
        this.configured = null
        return null
      })
    return this.configured
  }
}
