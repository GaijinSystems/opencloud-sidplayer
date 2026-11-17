import { describe, it, expect, vi } from 'vitest'
import {
  buildCgscCatalog,
  buildCgscRows,
  cgscComposerName,
  groupLabel,
  initialOf,
  packLetters
} from '../src/cgsc/catalog'
import { parseIndex, readCgscPaths } from '../src/cgsc/load'
import { fakeSpaceOps } from './helpers/fakes'

/** A handful of paths in the shape the real index file has. */
const PATHS = [
  '00_Documents/MUS_format_B.txt',
  'Dave_Marquis/Four_Seasons/Spring.mus',
  'Dave_Marquis/Four_Seasons/Spring.str',
  'Dave_Marquis/Four_Seasons/Spring.wds',
  'Dave_Marquis/Bolero.mus',
  'Dave_Marquis/Bolero.pic',
  'Misc/Anon/Greensleeves.mus',
  'Sandy_C/Someday_My_Prince_will_Come.mus'
]

describe('the index file', () => {
  it('is read under its earlier name where the new one is not there, and left out either way', async () => {
    const ops = fakeSpaceOps({
      readText: vi.fn(async (path: string) =>
        path === '/.sidplay-index.txt' ? 'A_Brown/Tune.mus\n.sidplay-index.txt\n' : null
      )
    })
    const found = await readCgscPaths(ops)
    expect(found?.source).toBe('index')
    expect(found?.paths).toEqual(['/A_Brown/Tune.mus'])
  })

  it('reads one path a line', () => {
    expect(parseIndex('a/b.mus\nc/d.mus\n')).toEqual(['/a/b.mus', '/c/d.mus'])
  })

  it('takes the shapes find can be talked into printing', () => {
    expect(parseIndex('./a/b.mus\r\n  /c/d.mus  \n\n')).toEqual(['/a/b.mus', '/c/d.mus'])
  })

  it('drops folders, which are listed with a trailing slash', () => {
    expect(parseIndex('a/\na/b.mus\n')).toEqual(['/a/b.mus'])
  })

  it('never lists itself, however the list was made', () => {
    expect(parseIndex('.sidplayer-index.txt\na.mus\n')).toEqual(['/a.mus'])
  })

  /*
   * `find /srv/CGSC -type f`, or `find ./CGSC` from one level up, prints a
   * root in front of every path. Kept, every tune in the collection was
   * filed under a composer called "srv" or "CGSC", and played as a 404.
   */
  it('takes off a root that every line was printed with', () => {
    expect(
      parseIndex(
        '/srv/CGSC/Dave_Marquis/Bolero.mus\n/srv/CGSC/Sandy_C/March.mus\n/srv/CGSC/.sidplayer-index.txt\n'
      )
    ).toEqual(['/Dave_Marquis/Bolero.mus', '/Sandy_C/March.mus'])
    expect(parseIndex('./CGSC/Dave_Marquis/Bolero.mus\n./CGSC/Sandy_C/March.mus\n')).toEqual([
      '/Dave_Marquis/Bolero.mus',
      '/Sandy_C/March.mus'
    ])
  })

  it('keeps the one folder of a collection that has only one composer', () => {
    expect(parseIndex('Dave_Marquis/Bolero.mus\nDave_Marquis/Four_Seasons/Spring.mus\n')).toEqual([
      '/Dave_Marquis/Bolero.mus',
      '/Dave_Marquis/Four_Seasons/Spring.mus'
    ])
  })

  it('reads a doubled slash as one', () => {
    expect(parseIndex('Dave_Marquis//Bolero.mus\n')).toEqual(['/Dave_Marquis/Bolero.mus'])
  })
})

describe('composer names', () => {
  it('turns underscores into spaces', () => {
    expect(cgscComposerName('Dave_Marquis')).toBe('Dave Marquis')
    expect(cgscComposerName('DC_Star_and_Cpr')).toBe('DC Star and Cpr')
  })

  it('brackets a handle written between hyphens', () => {
    expect(cgscComposerName('Andy_Figueroa_-UnixWizard-')).toBe('Andy Figueroa (UnixWizard)')
  })

  it('keeps the hyphens inside a handle that has its own', () => {
    expect(cgscComposerName('Dan_Klepach_-D-Bug-')).toBe('Dan Klepach (D-Bug)')
  })

  it('brackets both handles where there are two', () => {
    expect(cgscComposerName('Jim_-Jim_Brock-_-KCORB-')).toBe('Jim (Jim Brock) (KCORB)')
    expect(cgscComposerName('Robert_S_Shaw_-Bob_Shaw-_-Juky-')).toBe('Robert S Shaw (Bob Shaw) (Juky)')
  })

  it('handles one written in the middle of the name', () => {
    expect(cgscComposerName('Mark_-AD_II-_Dickenson')).toBe('Mark (AD II) Dickenson')
  })

  /*
   * The HVSC rule reverses `Surname_Forename`. Compute's files people under
   * their plain name, so applying it here would produce "Marquis Dave".
   */
  it('does not reverse two-word names the way HVSC folders are reversed', () => {
    expect(cgscComposerName('Dave_Marquis')).not.toBe('Marquis Dave')
  })
})

describe('rows', () => {
  const rows = buildCgscRows(PATHS)

  it('is one row per .mus file and nothing else', () => {
    expect(rows.map((r) => r.path)).toEqual([
      '/Dave_Marquis/Bolero.mus',
      '/Dave_Marquis/Four_Seasons/Spring.mus',
      '/Misc/Anon/Greensleeves.mus',
      '/Sandy_C/Someday_My_Prince_will_Come.mus'
    ])
  })

  it('marks every row as coming from this collection', () => {
    expect(rows.every((r) => r.collection === 'cgsc')).toBe(true)
  })

  it('takes the composer from the first segment, however deep the tune is', () => {
    const deep = rows.find((r) => r.path.includes('Four_Seasons'))
    expect(deep?.composerFolder).toBe('Dave_Marquis')
    expect(deep?.composer).toBe('Dave Marquis')
    expect(deep?.folder).toBe('/Dave_Marquis/Four_Seasons')
  })

  it('reads the title off the file name', () => {
    expect(rows[3].stem).toBe('Someday My Prince will Come')
  })

  it('says one song, which is what a MUS file holds', () => {
    expect(rows.every((r) => r.songs === 1)).toBe(true)
  })

  it('claims no MD5, no lengths and no header fields', () => {
    for (const row of rows) {
      expect(row.md5).toBe('')
      expect(row.lengths).toEqual([])
      expect(row.title).toBeUndefined()
      expect(row.released).toBeUndefined()
      expect(row.model).toBeUndefined()
    }
  })

  it('adds the leading slash a find listing does not have', () => {
    expect(buildCgscRows(['a/b.mus'])[0].path).toBe('/a/b.mus')
    expect(buildCgscRows(['/a/b.mus'])[0].path).toBe('/a/b.mus')
  })

  it('takes .MUS as readily as .mus', () => {
    expect(buildCgscRows(['A/B.MUS'])).toHaveLength(1)
  })
})

describe('letter groups', () => {
  it('leaves a single letter alone when it is already the right size', () => {
    expect(packLetters(new Map([['A', 10]]), 1)).toEqual([['A']])
  })

  it('runs letters together until adding the next would overshoot', () => {
    const counts = new Map([
      ['A', 5],
      ['B', 5],
      ['C', 10],
      ['D', 10]
    ])
    expect(packLetters(counts, 2)).toEqual([['A', 'B', 'C'], ['D']])
  })

  /*
   * The shape of the real collection, which is what the group count was
   * chosen against: 447 folders over 26 letters, very unevenly.
   */
  it('divides the real spread into runs of about the same size', () => {
    const real = new Map(
      Object.entries({
        A: 15,
        B: 27,
        C: 22,
        D: 43,
        E: 13,
        F: 9,
        G: 20,
        H: 12,
        I: 3,
        J: 53,
        K: 20,
        L: 21,
        M: 34,
        N: 5,
        O: 5,
        P: 12,
        Q: 1,
        R: 26,
        S: 49,
        T: 31,
        U: 4,
        V: 7,
        W: 8,
        X: 1,
        Y: 3,
        Z: 3
      })
    )
    const runs = packLetters(real)
    expect(runs.map(groupLabel)).toEqual(['A–B', 'C–D', 'E–G', 'H–J', 'K–L', 'M–O', 'P–R', 'S', 'T–V', 'W–Z'])
    // Every letter lands in exactly one run, in order.
    expect(runs.flat()).toEqual([...real.keys()])
  })

  it('labels a run by its ends, and a lone letter by itself', () => {
    expect(groupLabel(['S'])).toBe('S')
    expect(groupLabel(['A', 'B', 'C'])).toBe('A–C')
    expect(groupLabel(['#'])).toBe('0–9')
  })

  it('files anything that is not a letter under #', () => {
    expect(initialOf('1812_Overture')).toBe('#')
    expect(initialOf('_odd')).toBe('#')
    expect(initialOf('dave')).toBe('D')
  })
})

describe('the catalogue', () => {
  const catalog = buildCgscCatalog(PATHS)

  it('counts the composer folders, not the files', () => {
    expect(catalog.folders).toBe(3)
    expect(catalog.rows).toHaveLength(4)
  })

  it('leaves out top folders that hold no tunes', () => {
    const names = catalog.tree.children.flatMap((g) => g.children.map((c) => c.name))
    expect(names).not.toContain('00_Documents')
    expect(names).toEqual(['Dave_Marquis', 'Misc', 'Sandy_C'])
  })

  it('puts letter groups at the top, each marked as a group', () => {
    expect(catalog.tree.children.every((node) => node.group)).toBe(true)
    expect(catalog.tree.children.map((node) => node.name)).toEqual(['D', 'M', 'S'])
  })

  it('gives a group a path no folder could have', () => {
    for (const group of catalog.tree.children) expect(group.path.startsWith('#')).toBe(true)
  })

  it('totals a group from the folders in it', () => {
    const d = catalog.tree.children[0]
    expect(d.total).toBe(2)
    expect(catalog.tree.children.reduce((n, g) => n + g.total, 0)).toBe(catalog.rows.length)
  })

  it('keeps a composer subfolder as a child of the composer', () => {
    const marquis = catalog.tree.children[0].children[0]
    expect(marquis.name).toBe('Dave_Marquis')
    expect(marquis.own).toBe(1)
    expect(marquis.total).toBe(2)
    expect(marquis.children.map((c) => c.name)).toEqual(['Four_Seasons'])
  })

  it('is empty rather than broken when there is nothing there', () => {
    const empty = buildCgscCatalog([])
    expect(empty.rows).toEqual([])
    expect(empty.tree.children).toEqual([])
    expect(empty.folders).toBe(0)
  })
})
