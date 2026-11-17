import { buildTree, type CatalogRow, type TreeNode } from '../hvsc/catalog'
import { titleFromFileName } from '../hvsc/text'
import { rooted } from '../sid/source'

/**
 * The Compute's Gazette SID Collection, built from nothing but file names.
 *
 * This collection is the opposite of HVSC in the one way that matters here.
 * HVSC ships `Songlengths.md5`, a 5 MB document listing all 61,157 tunes with
 * their MD5s and their playing times, so its catalogue is a parse. Compute's
 * ships no index of any kind: 16,601 `.mus` files in 447 composer folders and
 * not one document that names them. Everything below is therefore derived
 * from paths - the composer from the first segment, the title from the file
 * name - and the fields HVSC fills from a manifest or a header are simply
 * absent. A row from here has no MD5, no release line, no chip model and no
 * song lengths, because nothing in the collection says what they are.
 *
 * What it does have is exactly one tune per file: MUS is a score for three
 * voices, not a program with selectable subsongs, so `songs` is 1 and that is
 * a fact rather than a guess.
 */

/** The folder the collection lives in, beside `C64Music`. */
export const CGSC_FOLDER = 'CGSC'

/** Tunes. `.str`, `.wds` and the pictures are companions, not entries. */
const TUNE = /\.mus$/i

/**
 * `Dave_Marquis` -> `Dave Marquis`, `Dan_Klepach_-D-Bug-` -> `Dan Klepach
 * (D-Bug)`.
 *
 * Underscores are spaces, as everywhere in both collections. The other rule
 * is this collection's own: a handle is written between hyphens after the
 * name, sometimes twice - `Robert_S_Shaw_-Bob_Shaw-_-Juky-` - and reads far
 * better in brackets. All 29 folders that use it are of that shape, and one,
 * `Mark_-AD_II-_Dickenson`, puts the handle in the middle, which is why the
 * match ends at an underscore or the end of the name rather than assuming
 * the name ends there.
 *
 * Note that the HVSC rule must not be applied: HVSC files people under
 * `Surname_Forename` and this collection under their plain name, so
 * `composerName('Dave_Marquis')` would give "Marquis Dave".
 */
export function cgscComposerName(folder: string): string {
  return folder
    .replace(/(^|_)-(.+?)-(?=_|$)/g, '$1($2)')
    .replace(/_/g, ' ')
    .trim()
}

/**
 * A path as the index file or a walk gives it, with or without a leading
 * slash, as a collection path: with one, as everywhere else in the app.
 */
export const cgscPath = rooted

/**
 * One row per tune, sorted by path.
 *
 * Paths arrive as the index file or a walk gives them, with or without a
 * leading slash; they leave with one, because that is what a collection path
 * is everywhere else in the app.
 */
export function buildCgscRows(paths: Iterable<string>): CatalogRow[] {
  const rows: CatalogRow[] = []
  for (const raw of paths) {
    const path = cgscPath(raw)
    if (!TUNE.test(path)) continue
    const slash = path.lastIndexOf('/')
    const folder = path.slice(0, slash) || '/'
    const name = path.slice(slash + 1)
    const composerFolder = folder.split('/').filter(Boolean)[0]
    rows.push({
      path,
      collection: 'cgsc',
      md5: '',
      lengths: [],
      category: CGSC_FOLDER,
      folder,
      name,
      stem: titleFromFileName(name),
      ...(composerFolder ? { composerFolder, composer: cgscComposerName(composerFolder) } : {}),
      // A MUS file is one score. Not a guess and not a placeholder: there is
      // no such thing as a second subsong in this format.
      songs: 1
    })
  }
  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return rows
}

/* ---- the letter groups --------------------------------------------------- */

/**
 * How many groups the composer folders are divided into.
 *
 * Ten is a tree you can take in at a glance that still opens onto a list you
 * can read: 447 folders makes about 45 to a group. A letter apiece would be
 * 26 rows, most of them holding three or four folders and two of them (J and
 * S) holding fifty.
 */
const GROUPS = 10

/** Where a folder files: its first letter, or `#` for anything else. */
export function initialOf(name: string): string {
  const first = name.charAt(0).toUpperCase()
  return first >= 'A' && first <= 'Z' ? first : '#'
}

/**
 * Packs letters into runs of roughly equal weight, in alphabetical order.
 *
 * Greedy, and it closes a run when taking the next letter would leave it
 * further from the target size than stopping does. That is what turns an
 * even spread of 447 folders into A-B, C-D, E-G, H-J, K-L, M-O, P-R, S, T-V,
 * W-Z rather than into ten runs whose sizes range from 1 to 68: S alone is
 * 49 folders and deserves its own row, while W through Z together are 15.
 *
 * The count driving this is folders, not tunes. A group is a list you open,
 * so its length is what wants to be even; balancing tunes instead would put
 * D on its own - Dave Marquis and the two DC Star folders are 1,949 tunes
 * between them - and leave fourteen letters sharing one row.
 */
export function packLetters(counts: Map<string, number>, groups = GROUPS): string[][] {
  const letters = [...counts.keys()].sort()
  let total = 0
  for (const n of counts.values()) total += n
  const target = Math.max(1, Math.round(total / groups))

  const out: string[][] = []
  let run: string[] = []
  let weight = 0
  for (const letter of letters) {
    const n = counts.get(letter) ?? 0
    if (run.length && Math.abs(weight + n - target) > Math.abs(weight - target)) {
      out.push(run)
      run = []
      weight = 0
    }
    run.push(letter)
    weight += n
  }
  if (run.length) out.push(run)
  return out
}

/** `['A']` -> `A`, `['A','B']` -> `A–B`, `['#']` -> `0–9`. */
export function groupLabel(letters: string[]): string {
  const show = (letter: string): string => (letter === '#' ? '0–9' : letter)
  const first = letters[0] ?? ''
  const last = letters[letters.length - 1] ?? ''
  return first === last ? show(first) : `${show(first)}–${show(last)}`
}

export interface CgscCatalog {
  /** One row per `.mus` file, sorted by path. */
  rows: CatalogRow[]
  /**
   * The tree: a root whose children are the letter groups, each holding the
   * composer folders that fall in it, each holding whatever subfolders that
   * composer filed their tunes under.
   */
  tree: TreeNode
  /** Composer folders, which is not the same as the number of people. */
  folders: number
}

/**
 * The whole catalogue from a list of paths.
 *
 * Folders holding no tunes drop out on their own, which is what should
 * happen to the four at the top of the collection - `00_Documents`,
 * `00_Commodore64`, `00_SIDfests`, `00_SidNews` - that hold manuals, disk
 * images and newsletters. They are worth having on the server and are not
 * worth a row in a tree of music.
 */
export function buildCgscCatalog(paths: Iterable<string>): CgscCatalog {
  const rows = buildCgscRows(paths)
  const flat = buildTree(rows)

  // Composer folders by initial, in the order `buildTree` sorted them.
  const byInitial = new Map<string, TreeNode[]>()
  for (const child of flat.children) {
    const letter = initialOf(child.name)
    const list = byInitial.get(letter)
    if (list) list.push(child)
    else byInitial.set(letter, [child])
  }

  /*
   * Anything that is not a letter keeps its own group rather than being
   * packed with A. There is nothing in release 1.47 that lands here, since
   * every composer folder starts with a letter, but a group labelled
   * "0-9–B" is not a thing to leave waiting for the day one does.
   */
  const other = byInitial.get('#')
  const letters = new Map<string, number>()
  for (const [letter, folders] of byInitial) {
    if (letter === '#') continue
    letters.set(letter, folders.length)
  }

  const runs = packLetters(letters)
  if (other) runs.unshift(['#'])

  const tree: TreeNode = {
    path: '',
    name: '/',
    children: [],
    own: 0,
    total: flat.total
  }
  for (const run of runs) {
    const children = run.flatMap((letter) => byInitial.get(letter) ?? [])
    if (!children.length) continue
    const label = groupLabel(run)
    tree.children.push({
      // Not a path: no listing can show a group, because it stands for
      // several folders. The `#` keeps it from ever colliding with one.
      path: `#${label}`,
      name: label,
      children,
      own: 0,
      total: children.reduce((n, child) => n + child.total, 0),
      group: true
    })
  }

  return { rows, tree, folders: flat.children.length }
}
