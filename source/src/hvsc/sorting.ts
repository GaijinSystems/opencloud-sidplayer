import { totalLength, type CatalogRow } from './catalog'
import { yearOf } from './search'

/**
 * Sorting the tune list by one of its columns.
 *
 * Two things make this less trivial than it looks.
 *
 * The table renders at most 400 rows, so sorting has to happen over the
 * whole result set before that window is taken - sorting what is on screen
 * would reorder 400 arbitrary rows out of 56,568 and call it a sort.
 *
 * And the keys are computed once per row rather than inside the comparator,
 * which runs O(n log n) times. Over the real collection that is the
 * difference between 182 ms and 64 ms; a single composer's folder is 2 ms
 * either way, but "All tunes" is 61,157 rows and someone will click it.
 */

export type SortColumn = 'title' | 'released' | 'songs' | 'length'
export type SortDirection = 'asc' | 'desc'

export interface SortOrder {
  column: SortColumn
  direction: SortDirection
}

/**
 * The next state of a header that was clicked: unsorted, ascending,
 * descending, unsorted again. Clearing matters more here than in most
 * tables, because the order it returns to is not arbitrary - it is path
 * order in a folder and relevance in a search.
 */
export function nextSort(current: SortOrder | null, column: SortColumn): SortOrder | null {
  if (!current || current.column !== column) return { column, direction: 'asc' }
  if (current.direction === 'asc') return { column, direction: 'desc' }
  return null
}

/**
 * Sorts by key, with ties falling back to the order the rows arrived in, so
 * a sort never scrambles what it cannot distinguish.
 *
 * A null key is "not known yet" - a release line before its header has been
 * read - and sorts last whichever way the column points, rather than
 * bunching at whichever end the direction happens to send it.
 */
function by<T extends string | number>(
  rows: CatalogRow[],
  key: (row: CatalogRow) => T | null,
  sign: number
): CatalogRow[] {
  const keyed = rows.map((row, i) => ({ row, i, k: key(row) }))
  keyed.sort((a, b) => {
    if (a.k === null) return b.k === null ? a.i - b.i : 1
    if (b.k === null) return -1
    if (a.k < b.k) return -sign
    if (a.k > b.k) return sign
    return a.i - b.i
  })
  return keyed.map((entry) => entry.row)
}

export function sortRows(rows: CatalogRow[], order: SortOrder): CatalogRow[] {
  const sign = order.direction === 'asc' ? 1 : -1
  switch (order.column) {
    case 'title':
      // Never unknown: a row whose header has not been read still has the
      // file name the list is showing in that column.
      return by(rows, (row) => (row.title || row.stem).toLowerCase(), sign)
    case 'released':
      // The year, not the line: "1985 Elite" and "1985 Hewson" belong
      // together, and "19?? Unknown" has no year to sort on at all.
      return by(rows, yearOf, sign)
    case 'songs':
      return by(rows, (row) => row.songs ?? row.lengths.length, sign)
    case 'length':
      return by(rows, totalLength, sign)
  }
}
