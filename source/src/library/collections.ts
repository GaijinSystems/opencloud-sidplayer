/**
 * The collections the library holds, each described once.
 *
 * There are two, and almost nothing about them is comparable: HVSC is synced
 * from a mirror against a manifest of MD5s, its tunes carry a header and its
 * documents say who wrote what; Compute's Gazette is a folder somebody put
 * there, catalogued from its file names and never written to. What the rest
 * of the library needs to know about that difference is asked of this table
 * - can a missing tune be fetched, is there a header to read - rather than
 * of the collection's name, so each difference is stated in one place and
 * the code that acts on it says which difference it means.
 */

/** Which of the two collections a folder or a row belongs to. */
export type Collection = 'hvsc' | 'cgsc'

export interface CollectionInfo {
  key: Collection
  /** The collection's full name, which heads its block of search results. */
  label: string
  /**
   * What goes in front of a folder in the breadcrumb and over the detail
   * pane's note. Absent where the collection needs no introduction: HVSC's
   * folders are shown bare.
   */
  shortLabel?: string
  /** The heading over the collection's folders in the tree. */
  treeLabel: string
  /**
   * May not be there at all. It is read after the library is up, never
   * before it, so that someone who has only HVSC does not wait on a folder
   * that is not there; and where it turns out to be absent nothing mentions
   * it - no section in the tree, no heading in a search.
   */
  optional: boolean
  /**
   * A mirror serves it. So a tune the catalogue lists and the space has not
   * got can be fetched, which makes "not downloaded" a thing worth saying
   * about a row and a folder worth listing to find out.
   */
  mirrored: boolean
  /** Its tunes begin with a SID header, to read a title, a year and a chip model out of. */
  headers: boolean
  /** HVSC's documents - STIL, Musicians.txt - describe its tunes. */
  documented: boolean
  /**
   * A tune's credits and length are in its own file and nowhere else, so
   * they are read from it when the tune is selected.
   */
  detailsFromFile: boolean
}

export const COLLECTIONS: Record<Collection, CollectionInfo> = {
  hvsc: {
    key: 'hvsc',
    label: 'High Voltage SID Collection',
    treeLabel: 'Collection',
    optional: false,
    mirrored: true,
    headers: true,
    documented: true,
    detailsFromFile: false
  },
  cgsc: {
    key: 'cgsc',
    label: 'Compute’s Gazette SID Collection',
    shortLabel: 'Compute’s Gazette',
    treeLabel: 'Compute’s Gazette MUS',
    optional: true,
    mirrored: false,
    headers: false,
    documented: false,
    detailsFromFile: true
  }
}

/** Both, in the order they are shown: HVSC first, wherever the two appear together. */
export const COLLECTION_KEYS: readonly Collection[] = ['hvsc', 'cgsc']

/**
 * Which collection a row, or a starred tune, belongs to. On the row itself
 * that is `'cgsc'` or nothing at all, nothing meaning HVSC; a missing row is
 * read the same way.
 */
export const collectionOf = (row: { collection?: 'cgsc' } | null | undefined): Collection =>
  row?.collection ?? 'hvsc'
