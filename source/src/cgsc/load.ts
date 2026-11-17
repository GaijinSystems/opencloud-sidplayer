import { walkSpace } from '../hvsc/inventory'
import type { SpaceOps } from '../hvsc/space'

/**
 * Finding out what is in the Compute's Gazette collection.
 *
 * There is no manifest to read, so the answer has to come from the server
 * one way or another, and the two ways are very different jobs. A walk is
 * about 500 PROPFINDs - 447 composer folders plus their subfolders - at
 * roughly ten a second, which is the better part of a minute before a single
 * row appears. An index file is one GET of about a megabyte.
 *
 * So the index is what is used, and the walk is the fallback for a
 * collection that has not got one. The index is a plain list of paths, which
 * is what `find` prints, and nothing about it is specific to this app:
 *
 *   cd "/path/to/CGSC" && find . -type f ! -name .sidplayer-index.txt \
 *     | sed 's|^\./||' | LC_ALL=C sort > .sidplayer-index.txt
 *
 * It is read rather than trusted: paths that name no `.mus` file are ignored
 * by the catalogue, and a tune the index lists but the server does not have
 * fails when it is played, the same as any other missing file. The cost of a
 * stale index is a row that does not play, not a broken library, which is
 * why it does not need a checksum or a date.
 */

/** The path list, relative to the collection folder. */
export const CGSC_INDEX_FILE = '.sidplayer-index.txt'
/** The same file under the app's earlier name, read where the new one is not there. */
export const LEGACY_CGSC_INDEX_FILE = '.sidplay-index.txt'
const INDEX_FILES: readonly string[] = [CGSC_INDEX_FILE, LEGACY_CGSC_INDEX_FILE]

export interface CgscSource {
  /** Collection paths, with a leading slash. */
  paths: string[]
  /** Which of the two ways the list was arrived at. */
  source: 'index' | 'walk'
  /**
   * The server's MD5 for each file, where a walk listed it. The index file
   * names paths and nothing else, so there is none of this when it is used.
   */
  checksums?: Map<string, string | null>
}

/**
 * Paths out of an index file.
 *
 * Tolerant about the shapes `find` can be talked into printing: a leading
 * `./` or `/`, CRLF from a list made on Windows, trailing spaces, blank
 * lines. A folder listed with a trailing slash is dropped, since the
 * catalogue is built from files.
 */
export function parseIndex(text: string): string[] {
  const lines: string[][] = []
  for (const line of text.split('\n')) {
    const trimmed = line.replace(/\r$/, '').trim()
    if (!trimmed || trimmed.endsWith('/')) continue
    // Empty segments go: `A//B.mus` is `A/B.mus`, not a folder called "".
    const segments = trimmed
      .replace(/^\.?\/+/, '')
      .split('/')
      .filter(Boolean)
    if (!segments.length) continue
    /*
     * A path that climbs out of the collection is dropped rather than
     * resolved. Nothing here writes, so this is not the hole it is in the
     * HVSC manifest, but a row whose path is `../../Documents/thesis.docx`
     * would put a file from elsewhere in the user's space into a list of
     * tunes and try to play it, and the file is only a `find` away from
     * being generated on a machine this app knows nothing about.
     */
    if (segments.some((segment) => segment === '..' || segment === '.')) continue
    // The index never lists itself, wherever it was made from.
    if (INDEX_FILES.includes(segments[segments.length - 1])) continue
    lines.push(segments)
  }

  /*
   * A root every line was printed with - `find /srv/CGSC -type f`, or
   * `find ./CGSC` from the folder above - is taken off. Kept, it made every
   * tune in the collection the work of a composer called "srv" or "CGSC",
   * and every one of them a 404. A real collection has hundreds of folders
   * at the top, so a folder every line shares is that root; it stops while
   * every path still has a folder and a file left, so a collection of one
   * composer keeps its one folder.
   */
  let root = 0
  for (;;) {
    const first = lines[0]?.[root]
    if (first === undefined) break
    if (!lines.every((segments) => segments.length - root > 2 && segments[root] === first)) break
    root++
  }

  return lines.map((segments) => `/${segments.slice(root).join('/')}`)
}

export interface ReadOptions {
  /** Called as a walk goes, since a walk is slow enough to need saying. */
  onProgress?: (files: number, folders: number) => void
  shouldStop?: () => boolean
}

/**
 * What the collection holds, by whichever means is available.
 *
 * Returns null when the folder is not there at all - which is the normal
 * case for someone who only has HVSC - so that the caller can leave the
 * second section out of the tree rather than show an empty one.
 */
export async function readCgscPaths(ops: SpaceOps, options: ReadOptions = {}): Promise<CgscSource | null> {
  /*
   * Not caught. `readText` answers a missing file with null, so anything
   * thrown here is the server failing to answer, and the sensible response
   * to that is not to follow it with five hundred more requests that will
   * fail the same way. The caller treats a failure as "no second
   * collection", which is what it looks like either way.
   */
  // Both names at once, the new one preferred: someone who made theirs under
  // the old name keeps it, since nothing here writes it.
  // Taken in order, so the old name failing cannot spoil a new one that answered.
  let text: string | null = null
  for (const answer of await Promise.allSettled(INDEX_FILES.map((name) => ops.readText(`/${name}`)))) {
    if (answer.status === 'rejected') throw answer.reason
    if (answer.value !== null) {
      text = answer.value
      break
    }
  }
  if (text) {
    const paths = parseIndex(text)
    if (paths.length) return { paths, source: 'index' }
  }

  // A missing folder lists as empty, so this is also the "is it there" test.
  const top = await ops.list('/')
  if (!top.folders.length && !top.files.length) return null

  const found = await walkSpace(ops, {
    from: ['/'],
    concurrency: 6,
    shouldStop: options.shouldStop,
    onProgress: (p) => options.onProgress?.(p.files, p.folders)
  })
  if (found.failed.length) {
    // Worth saying but not worth failing over: this collection has nothing to
    // sync and nothing to delete, so an incomplete walk costs rows in a list
    // rather than a wrong decision about somebody's files.
    console.info('[sidplayer] some Compute’s Gazette folders could not be listed', found.failed.length)
  }
  return { paths: [...found.index.keys()], source: 'walk', checksums: found.index }
}
