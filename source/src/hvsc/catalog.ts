import type { HeaderFields } from './headers'
import type { ManifestEntry } from './manifest'
import { titleFromFileName } from './text'

/**
 * The catalogue: one row per tune in the collection.
 *
 * Rows come from `DOCUMENTS/Songlengths.md5`, which is the only file that
 * lists the whole collection - 61,157 entries in release 85, each a path and
 * the MD5 of the file, with one playing length per subsong. That gives every
 * field below except the header fields, which come from the file header: it
 * lives in the first 128 bytes of each tune and in no document at all
 * (`headers.ts` fills those in).
 *
 * The MD5 is what the sync compares against the copy in the user's space. It
 * also identifies a rip filed in two places, though release 85 has none:
 * 61,157 entries and 61,157 distinct MD5s, since HVSC eliminates repeats as
 * it finds them.
 *
 * The header fields it extends are absent until the header has been read;
 * `songs` there is the header's subsong count, where `lengths.length` is
 * the manifest's view.
 */
export interface CatalogRow extends HeaderFields {
  /** Collection path, leading slash, as the manifest writes it. */
  path: string
  /**
   * Which collection the row belongs to. Absent means HVSC, which is what
   * everything here builds; `cgsc` rows are made in `src/cgsc/catalog.ts`
   * from path names alone and carry no MD5, no song lengths and no header
   * fields, because nothing in that collection records them.
   */
  collection?: 'cgsc'
  /** Whole-file MD5, lower case. */
  md5: string
  /**
   * Seconds per subsong, index 0 = subsong 1, `undefined` for a subsong whose
   * time the manifest gave in a shape this app could not read. Kept in place
   * rather than dropped, so index still means subsong number.
   */
  lengths: Array<number | undefined>
  /** `DEMOS`, `GAMES`, `MUSICIANS`, `DOCUMENTS`, ... */
  category: string
  /** Containing folder, no trailing slash. */
  folder: string
  /** File name with extension. */
  name: string
  /** File name as a title, underscores turned back into spaces. */
  stem: string
  /** Composer folder under MUSICIANS, as written: `Hubbard_Rob`. */
  composerFolder?: string
  /** Composer folder as a name: `Rob Hubbard` where the folder is `Surname_First`. */
  composer?: string
}

/**
 * `Hubbard_Rob` -> `Rob Hubbard`, `Maniacs_of_Noise` -> `Maniacs of Noise`.
 *
 * HVSC files a person under `Surname_Forename` and a group under its plain
 * name, with no marker to say which. The rule used here is the one the
 * collection's own layout implies: exactly two words, both capitalised, and
 * the second not a known particle, reads as a surname followed by a forename.
 * It is wrong for a two-word group name now and then, which costs a slightly
 * odd display name and nothing else - the folder itself stays searchable.
 */
const PARTICLES = new Set(['of', 'the', 'and', 'de', 'van', 'von', 'da', 'di', 'le', 'la'])

/**
 * What identifies a tune across both collections: `<collection>:<path>`.
 *
 * The collection as well as the path, because a path alone is only unique by
 * the accident that HVSC starts its at `/DEMOS`, `/GAMES` or `/MUSICIANS`
 * while Compute's starts its at a composer's name. That is two archives'
 * naming habits, not a guarantee. The one spelling of it: a star, the id of
 * the resource handed to the player, and the row a list highlights are all
 * this string, so that each can be compared with the others.
 */
export const rowKey = (row: { path: string; collection?: 'cgsc' }): string =>
  `${row.collection ?? 'hvsc'}:${row.path}`

export function composerName(folder: string): string {
  const words = folder.split('_').filter(Boolean)
  if (
    words.length === 2 &&
    !PARTICLES.has(words[1].toLowerCase()) &&
    /^[A-Z]/.test(words[0]) &&
    /^[A-Z]/.test(words[1])
  ) {
    return `${words[1]} ${words[0]}`
  }
  return words.join(' ')
}

/**
 * Total playing time of a tune's subsongs, in seconds. Subsongs whose length
 * the manifest did not give count as nothing, which makes the total a
 * lower bound rather than a guess; `knownLengths` says whether it is the
 * whole story.
 */
export const totalLength = (row: CatalogRow): number => row.lengths.reduce<number>((a, b) => a + (b ?? 0), 0)

/** How many of a tune's subsongs have a length at all. */
export const knownLengths = (row: CatalogRow): number =>
  row.lengths.reduce<number>((n, length) => (length === undefined ? n : n + 1), 0)

/** Turns manifest entries into catalogue rows, sorted by path. */
export function buildCatalog(entries: ManifestEntry[]): CatalogRow[] {
  const rows: CatalogRow[] = []
  for (const entry of entries) {
    const { path, md5 } = entry
    const slash = path.lastIndexOf('/')
    const folder = path.slice(0, slash) || '/'
    const name = path.slice(slash + 1)
    const segments = folder.split('/').filter(Boolean)
    const category = segments[0] ?? ''
    const row: CatalogRow = {
      path,
      md5,
      lengths: entry.lengths,
      category,
      folder,
      name,
      stem: titleFromFileName(name)
    }
    // Under MUSICIANS the collection is /MUSICIANS/<initial>/<composer>/...,
    // and anything deeper is that composer's own subfolder.
    if (category === 'MUSICIANS' && segments.length >= 3) {
      row.composerFolder = segments[2]
      row.composer = composerName(segments[2])
    }
    rows.push(row)
  }
  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return rows
}

export interface TreeNode {
  /** Full path of the folder. */
  path: string
  /** Last segment. */
  name: string
  children: TreeNode[]
  /** Tunes directly in this folder. */
  own: number
  /** Tunes in this folder and everything under it. */
  total: number
  /**
   * True for a node that is a heading rather than a folder - the letter
   * groups the Compute's Gazette tree is divided into. Such a node can be
   * expanded but not opened: it stands for several folders, so there is no
   * one path a listing could show.
   */
  group?: boolean
}

/**
 * The folder tree, built from the paths alone.
 *
 * Counts are totalled upwards so the sidebar can show "MUSICIANS 43,161"
 * beside "Hubbard_Rob 247" without a second pass over the rows.
 */
export function buildTree(rows: CatalogRow[]): TreeNode {
  const root: TreeNode = { path: '', name: '/', children: [], own: 0, total: 0 }
  const index = new Map<string, TreeNode>([['', root]])

  for (const row of rows) {
    let parent = root
    let prefix = ''
    // Every folder on the way down holds this tune, so each total goes up
    // as it is passed.
    root.total++
    for (const segment of row.folder.split('/').filter(Boolean)) {
      prefix += `/${segment}`
      let node = index.get(prefix)
      if (!node) {
        node = { path: prefix, name: segment, children: [], own: 0, total: 0 }
        index.set(prefix, node)
        parent.children.push(node)
      }
      node.total++
      parent = node
    }
    parent.own++
  }

  const sort = (node: TreeNode): void => {
    node.children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    node.children.forEach(sort)
  }
  sort(root)
  return root
}
