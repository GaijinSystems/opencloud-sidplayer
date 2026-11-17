import { describe, it, expect } from 'vitest'
import { buildCatalog, type CatalogRow } from '../src/hvsc/catalog'
import { parseManifest } from '../src/hvsc/manifest'
import { nextSort, sortRows, type SortOrder } from '../src/hvsc/sorting'

/*
 * Six tunes, deliberately awkward: two share a release year, one has a
 * release line with no year in it, two have no header read at all, and two
 * are the same length.
 */
const MANIFEST = `[Database]
; /MUSICIANS/H/Hubbard_Rob/Commando.sid
9cee7d4077e9def93f24946ef2527021=3:58
; /MUSICIANS/H/Hubbard_Rob/Monty_on_the_Run.sid
793f0300acaca2f4c6ba23910f65c2e6=5:50 0:12 2:44 0:01
; /MUSICIANS/H/Huelsbeck_Chris/Turrican_2.sid
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1=6:12 1:04
; /MUSICIANS/M/Maniacs_of_Noise/Myth.sid
bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2=4:20
; /GAMES/A-F/Aztec.sid
ccccccccccccccccccccccccccccccc3=3:58
; /DEMOS/0-9/12345.sid
ddddddddddddddddddddddddddddddd4=0:56
`

const HEADERS: Record<string, Partial<CatalogRow>> = {
  '/MUSICIANS/H/Hubbard_Rob/Commando.sid': { title: 'Commando', released: '1985 Elite', songs: 1 },
  '/MUSICIANS/H/Hubbard_Rob/Monty_on_the_Run.sid': {
    title: 'Monty on the Run',
    released: '1985 Gremlin',
    songs: 4
  },
  '/MUSICIANS/H/Huelsbeck_Chris/Turrican_2.sid': {
    title: 'Turrican II',
    released: '1991 Rainbow Arts',
    songs: 2
  },
  '/MUSICIANS/M/Maniacs_of_Noise/Myth.sid': { title: 'Myth', released: '19?? Unknown', songs: 1 },
  // Aztec and 12345 keep no header at all, as an unindexed row does.
  '/GAMES/A-F/Aztec.sid': {},
  '/DEMOS/0-9/12345.sid': {}
}

const rows = buildCatalog(parseManifest(MANIFEST).entries).map((row) => ({ ...row, ...HEADERS[row.path] }))
const names = (list: CatalogRow[]): string[] => list.map((row) => row.title || row.stem)
const sorted = (order: SortOrder): string[] => names(sortRows(rows, order))

describe('sorting the tune list', () => {
  it('orders by title, ascending and descending, using the file name where no header is read', () => {
    expect(sorted({ column: 'title', direction: 'asc' })).toEqual([
      '12345',
      'Aztec',
      'Commando',
      'Monty on the Run',
      'Myth',
      'Turrican II'
    ])
    expect(sorted({ column: 'title', direction: 'desc' })).toEqual([
      'Turrican II',
      'Myth',
      'Monty on the Run',
      'Commando',
      'Aztec',
      '12345'
    ])
  })

  it('orders by the year in the release line, not the line itself', () => {
    // "1985 Elite" and "1985 Gremlin" are one year, and keep their original
    // order between them; 1991 follows.
    expect(sorted({ column: 'released', direction: 'asc' }).slice(0, 3)).toEqual([
      'Commando',
      'Monty on the Run',
      'Turrican II'
    ])
  })

  it('puts rows with nothing to sort on last, whichever way the column points', () => {
    /*
     * Myth's line is "19?? Unknown" and two rows have no header at all, so
     * none of the three has a year. They go to the end in both directions,
     * keeping the path order they came in with rather than being reversed
     * along with everything else.
     */
    const tail = ['12345', 'Aztec', 'Myth']
    expect(sorted({ column: 'released', direction: 'asc' }).slice(3)).toEqual(tail)
    expect(sorted({ column: 'released', direction: 'desc' }).slice(3)).toEqual(tail)
  })

  it('orders by subsong count, falling back to what the manifest knows', () => {
    // Aztec and 12345 have no header, so their count comes from the
    // manifest's list of lengths: one each.
    expect(sorted({ column: 'songs', direction: 'desc' }).slice(0, 2)).toEqual([
      'Monty on the Run',
      'Turrican II'
    ])
    expect(sorted({ column: 'songs', direction: 'asc' })[0]).toBe('12345')
  })

  it('orders by total playing time across every subsong', () => {
    // Monty is 5:50 + 0:12 + 2:44 + 0:01 = 527 s, which beats Turrican's
    // 6:12 + 1:04 = 436 s even though Turrican's first subsong is longer.
    expect(sorted({ column: 'length', direction: 'desc' }).slice(0, 2)).toEqual([
      'Monty on the Run',
      'Turrican II'
    ])
    expect(sorted({ column: 'length', direction: 'asc' })[0]).toBe('12345')
  })

  it('leaves rows it cannot tell apart in the order they arrived', () => {
    /*
     * Aztec and Commando are both 3:58, and /GAMES/A-F/Aztec.sid comes
     * before /MUSICIANS/H/Hubbard_Rob/Commando.sid in path order. A tie
     * keeps that order in both directions: reversing the sort should not
     * shuffle rows the column cannot tell apart.
     */
    const pair = (direction: 'asc' | 'desc') =>
      names(sortRows(rows, { column: 'length', direction })).filter((n) => n === 'Commando' || n === 'Aztec')
    expect(pair('asc')).toEqual(['Aztec', 'Commando'])
    expect(pair('desc')).toEqual(['Aztec', 'Commando'])
  })

  it('never loses or duplicates a row', () => {
    for (const column of ['title', 'released', 'songs', 'length'] as const) {
      for (const direction of ['asc', 'desc'] as const) {
        const out = sortRows(rows, { column, direction })
        expect(out).toHaveLength(rows.length)
        expect(new Set(out.map((r) => r.path)).size).toBe(rows.length)
      }
    }
  })

  it('does not touch the list it was given', () => {
    const before = names(rows)
    sortRows(rows, { column: 'title', direction: 'desc' })
    expect(names(rows)).toEqual(before)
  })

  describe('cycling a column', () => {
    it('goes unsorted, ascending, descending, unsorted', () => {
      const a = nextSort(null, 'title')
      expect(a).toEqual({ column: 'title', direction: 'asc' })
      const b = nextSort(a, 'title')
      expect(b).toEqual({ column: 'title', direction: 'desc' })
      // Back to the natural order, which is the point: in a search that is
      // relevance, and nothing else would bring it back.
      expect(nextSort(b, 'title')).toBeNull()
    })

    it('starts a different column ascending, wherever the last one had got to', () => {
      expect(nextSort({ column: 'title', direction: 'desc' }, 'length')).toEqual({
        column: 'length',
        direction: 'asc'
      })
    })
  })
})
