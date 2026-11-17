import { describe, it, expect } from 'vitest'
import { parseManifest } from '../src/hvsc/manifest'
import { buildCatalog, buildTree, composerName, totalLength, type CatalogRow } from '../src/hvsc/catalog'
import { parseStil, stilFor } from '../src/hvsc/stil'
import { musicianForFolder, parseMusicians } from '../src/hvsc/musicians'
import { best, buildSearchIndex, parseQuery, yearOf } from '../src/hvsc/search'
import { collapsedVariant, decodeLatin1, normalise, titleFromFileName } from '../src/hvsc/text'
import { applyHeaders, type HeaderFields } from '../src/hvsc/headers'

/* Shapes taken verbatim from release 85's documents. */

const MANIFEST = `[Database]
; /MUSICIANS/H/Hubbard_Rob/Commando.sid
9cee7d4077e9def93f24946ef2527021=3:58
; /MUSICIANS/H/Hubbard_Rob/Monty_on_the_Run.sid
793f0300acaca2f4c6ba23910f65c2e6=5:50 0:12 2:44 0:01
; /MUSICIANS/H/Huelsbeck_Chris/Turrican_2.sid
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1=6:12 1:04
; /MUSICIANS/M/Maniacs_of_Noise/Myth.sid
bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2=4:20
; /GAMES/A-F/Commando.sid
9cee7d4077e9def93f24946ef2527021=3:58
; /DEMOS/0-9/12345.sid
ccccccccccccccccccccccccccccccc3=0:56
`

const STIL = `  STIL - the SID Tune Information List
  ------------------------------------

/DEMOS/0-9/12345.sid
  TITLE: 1.2.3.4.5.6.7.8
 ARTIST: Ken Laszlo

/MUSICIANS/H/Hubbard_Rob/Monty_on_the_Run.sid
(#1)
  TITLE: The Devil's Gallop [from the Dick Barton radio show]
 ARTIST: Charles Williams
COMMENT: Heavily inspired by the song Devil's Gallop, which was the title theme
         for the 1940's American detective radio show "Dick Barton".
(#3)
  TITLE: Monty's Theme

/MUSICIANS/M/Maniacs_of_Noise/Myth.sid
COMMENT: Cover of an Amiga tune.
`

const MUSICIANS = `****************************************
Several C64 Musicians and Known Handles
SID Musicians in total ........... 1872
FINLAND .......................... 154
****************************************
Hubbard, Rob - UNITED KINGDOM (ENGLAND)
Huelsbeck, Chris - GERMANY
Agemixer (Yliaho, Ari) / Atlantis / Scallop - FINLAND
Aahz The Demon (Fitches, Dave {Asmodeus}) / Carcass - CANADA
Maniacs of Noise / Bonzai - NETHERLANDS
`

const manifest = parseManifest(MANIFEST)
const catalog = buildCatalog(manifest.entries)
const stil = parseStil(STIL)
const musicians = parseMusicians(MUSICIANS)

describe('text handling', () => {
  it('decodes Latin-1, as HVSC writes its documents', () => {
    // "Orbán" in ISO-8859-1: the á is a single 0xE1 byte, which is not valid UTF-8.
    const bytes = new Uint8Array([0x4f, 0x72, 0x62, 0xe1, 0x6e])
    expect(decodeLatin1(bytes)).toBe('Orbán')
    expect(new TextDecoder().decode(bytes)).not.toBe('Orbán')
  })

  it('spells umlauts the way the collection does', () => {
    expect(normalise('Hülsbeck')).toBe('huelsbeck')
    expect(normalise('Sørensen')).toBe('soerensen')
    expect(normalise('Åke Straße')).toBe('aake strasse')
    expect(normalise('Orbán')).toBe('orban')
  })

  it('breaks HVSC file names into words', () => {
    expect(normalise('Monty_on_the_Run.sid')).toBe('monty on the run sid')
    expect(titleFromFileName('Monty_on_the_Run.sid')).toBe('Monty on the Run')
  })

  it('offers a collapsed spelling so "hulsbeck" also matches', () => {
    expect(collapsedVariant('huelsbeck')).toBe('hulsbeck')
    expect(collapsedVariant('soerensen')).toBe('sorensen')
    expect(collapsedVariant('commando')).toBeNull()
  })
})

describe('catalogue', () => {
  it('has one row per manifest entry, sorted by path', () => {
    expect(catalog).toHaveLength(6)
    expect(catalog.map((r) => r.path)).toEqual([
      '/DEMOS/0-9/12345.sid',
      '/GAMES/A-F/Commando.sid',
      '/MUSICIANS/H/Hubbard_Rob/Commando.sid',
      '/MUSICIANS/H/Hubbard_Rob/Monty_on_the_Run.sid',
      '/MUSICIANS/H/Huelsbeck_Chris/Turrican_2.sid',
      '/MUSICIANS/M/Maniacs_of_Noise/Myth.sid'
    ])
  })

  it('reads category, folder, composer and lengths from the path and manifest', () => {
    const monty = catalog.find((r) => r.name === 'Monty_on_the_Run.sid') as CatalogRow
    expect(monty.category).toBe('MUSICIANS')
    expect(monty.folder).toBe('/MUSICIANS/H/Hubbard_Rob')
    expect(monty.composerFolder).toBe('Hubbard_Rob')
    expect(monty.composer).toBe('Rob Hubbard')
    expect(monty.stem).toBe('Monty on the Run')
    expect(monty.lengths).toHaveLength(4)
    expect(totalLength(monty)).toBeCloseTo(350 + 12 + 164 + 1)
  })

  it('reads a surname_forename folder as a name but leaves a group alone', () => {
    expect(composerName('Hubbard_Rob')).toBe('Rob Hubbard')
    expect(composerName('Maniacs_of_Noise')).toBe('Maniacs of Noise')
    expect(composerName('Laxity')).toBe('Laxity')
  })

  it('keeps both copies of a rip that is filed twice', () => {
    const same = catalog.filter((r) => r.md5 === '9cee7d4077e9def93f24946ef2527021')
    expect(same.map((r) => r.category)).toEqual(['GAMES', 'MUSICIANS'])
  })

  it('totals the tree upwards', () => {
    const tree = buildTree(catalog)
    const musiciansNode = tree.children.find((c) => c.name === 'MUSICIANS')
    expect(tree.total).toBe(6)
    expect(musiciansNode?.total).toBe(4)
    expect(musiciansNode?.own).toBe(0)
    const hubbard = musiciansNode?.children
      .find((c) => c.name === 'H')
      ?.children.find((c) => c.name === 'Hubbard_Rob')
    expect(hubbard?.own).toBe(2)
    expect(hubbard?.total).toBe(2)
  })
})

describe('STIL', () => {
  it('parses tune-level fields', () => {
    const entry = stil.get('/DEMOS/0-9/12345.sid')
    expect(entry?.tune.title).toBe('1.2.3.4.5.6.7.8')
    expect(entry?.tune.artist).toBe('Ken Laszlo')
  })

  it('scopes fields to a subsong and joins wrapped comments', () => {
    const entry = stil.get('/MUSICIANS/H/Hubbard_Rob/Monty_on_the_Run.sid')
    expect(entry?.subsongs.get(1)?.title).toBe("The Devil's Gallop [from the Dick Barton radio show]")
    expect(entry?.subsongs.get(1)?.comment).toContain('detective radio show "Dick Barton".')
    expect(entry?.subsongs.get(1)?.comment).not.toContain('\n')
    expect(entry?.subsongs.get(3)?.title).toBe("Monty's Theme")
  })

  it('falls back to the tune when a subsong has no entry of its own', () => {
    const entry = stil.get('/MUSICIANS/M/Maniacs_of_Noise/Myth.sid')
    expect(stilFor(entry, 1).comment).toBe('Cover of an Amiga tune.')
    expect(stilFor(undefined, 1)).toEqual({})
  })

  it('ignores the file preamble', () => {
    expect([...stil.keys()].every((k) => k.startsWith('/'))).toBe(true)
    expect(stil.size).toBe(3)
  })
})

describe('musicians', () => {
  it('skips the tally block and headings', () => {
    expect(musicians.size).toBe(5)
    expect([...musicians.keys()]).not.toContain('FINLAND')
  })

  it('reads real names in reading order, aliases, groups and country', () => {
    const agemixer = musicians.get('Agemixer')
    expect(agemixer?.realName).toBe('Ari Yliaho')
    expect(agemixer?.groups).toEqual(['Atlantis', 'Scallop'])
    expect(agemixer?.country).toBe('FINLAND')
    expect(musicians.get('Aahz The Demon')?.aliases).toEqual(['Asmodeus'])
  })

  it('finds the entry for a collection folder name', () => {
    expect(musicianForFolder(musicians, 'Hubbard_Rob')?.name).toBe('Hubbard, Rob')
    expect(musicianForFolder(musicians, 'Maniacs_of_Noise')?.country).toBe('NETHERLANDS')
    expect(musicianForFolder(musicians, 'Nobody_At_All')).toBeUndefined()
  })
})

describe('query syntax', () => {
  it('separates filters from free text', () => {
    const q = parseQuery('composer:hubbard year:1985..1988 songs:>1 path:/DEMOS/ monty run')
    expect(q.terms).toEqual(['monty', 'run'])
    expect(q.filters).toMatchObject({
      composer: 'hubbard',
      yearFrom: 1985,
      yearTo: 1988,
      minSongs: 2,
      pathPrefix: 'DEMOS/'
    })
  })

  it('treats a bare year as that year alone, and stil: as a prose term', () => {
    expect(parseQuery('year:1987').filters).toMatchObject({ yearFrom: 1987, yearTo: 1987 })
    const q = parseQuery('stil:cover')
    expect(q.prose).toEqual(['cover'])
    expect(q.filters.hasStil).toBe(true)
  })

  it('keeps an unknown key as text rather than swallowing it', () => {
    expect(parseQuery('nonsense:thing').terms).toEqual(['nonsense', 'thing'])
  })

  it('reads a year out of a header release line', () => {
    expect(yearOf({ released: '1985 Elite' } as CatalogRow)).toBe(1985)
    expect(yearOf({ released: '19?? Unknown' } as CatalogRow)).toBeNull()
    expect(yearOf({} as CatalogRow)).toBeNull()
  })
})

describe('search', () => {
  /* Header fields are only known for some rows, as they would be mid-index. */
  const withHeaders = catalog.map((row) =>
    row.name === 'Commando.sid' && row.category === 'MUSICIANS'
      ? {
          ...row,
          title: 'Commando',
          author: 'Rob Hubbard',
          released: '1985 Elite',
          model: '6581' as const,
          songs: 1
        }
      : row
  )
  const index = buildSearchIndex(withHeaders, { stil, musicians })

  it('finds a tune by its file name', () => {
    const hits = index.search('monty run')
    expect(hits[0].row.name).toBe('Monty_on_the_Run.sid')
  })

  it('matches the last word as a prefix, so results appear while typing', () => {
    expect(index.search('mont').length).toBeGreaterThan(0)
    expect(index.search('monty ru')[0].row.name).toBe('Monty_on_the_Run.sid')
  })

  it('ranks an exact name above a longer one that contains it', () => {
    const hits = index.search('commando')
    expect(hits[0].row.path).toBe('/MUSICIANS/H/Hubbard_Rob/Commando.sid')
  })

  it('collapses the same rip filed in two places into one hit', () => {
    const hits = index.search('commando')
    expect(hits.filter((h) => h.row.name === 'Commando.sid')).toHaveLength(1)
    expect(hits[0].duplicates.map((d) => d.category)).toEqual(['GAMES'])
  })

  it('finds a composer by folder, by name, by real name and by handle spelling', () => {
    expect(index.search('hubbard').length).toBe(2)
    expect(index.search('rob hubbard').length).toBe(2)
    expect(index.search('ari yliaho')).toHaveLength(0) // no tunes in this fixture
    expect(index.search('huelsbeck')[0].row.composerFolder).toBe('Huelsbeck_Chris')
    expect(index.search('hülsbeck')[0].row.composerFolder).toBe('Huelsbeck_Chris')
    expect(index.search('hulsbeck')[0].row.composerFolder).toBe('Huelsbeck_Chris')
  })

  it('applies filters, including ones that need header fields', () => {
    expect(index.search('commando composer:hubbard')).toHaveLength(1)
    expect(index.search('songs:>1').map((h) => h.row.name)).toEqual(['Monty_on_the_Run.sid', 'Turrican_2.sid'])
    expect(index.search('chip:6581').map((h) => h.row.name)).toEqual(['Commando.sid'])
    expect(index.search('chip:8580')).toHaveLength(0)
    expect(index.search('year:1985')).toHaveLength(1)
    expect(index.search('year:1990..')).toHaveLength(0)
  })

  it('scopes to a folder', () => {
    expect(index.search('commando', { filters: { pathPrefix: 'GAMES' } })).toHaveLength(1)
    expect(index.search('commando', { filters: { pathPrefix: 'GAMES' } })[0].row.category).toBe('GAMES')
  })

  it('searches STIL commentary only when asked, and builds that index lazily', () => {
    const fresh = buildSearchIndex(withHeaders, { stil, musicians })
    expect(fresh.stats().proseTokens).toBeNull()
    const hits = fresh.search('stil:amiga')
    expect(hits.map((h) => h.row.name)).toEqual(['Myth.sid'])
    expect(fresh.stats().proseTokens).toBeGreaterThan(0)
  })

  it('finds nothing for a word that is in no field', () => {
    expect(index.search('zzzznothing')).toHaveLength(0)
  })

  it('reports what it holds', () => {
    expect(index.stats().rows).toBe(6)
    expect(index.stats().tokens).toBeGreaterThan(10)
  })

  /*
   * Headers arrive after the index is built - a folder at a time as someone
   * browses - and folding them in has to cost only the rows that changed.
   * `applyHeaders` returns the untouched rows by reference, which is how
   * `update` knows which ones to redo.
   */
  describe('folding in headers that arrive later', () => {
    const later = new Map<string, HeaderFields>([
      [
        '/MUSICIANS/H/Huelsbeck_Chris/Turrican_2.sid',
        {
          title: 'Turrican II',
          author: 'Chris Huelsbeck',
          released: '1991 Rainbow Arts',
          model: '8580',
          songs: 4
        }
      ]
    ])

    it('makes the new fields searchable and filterable', () => {
      const fresh = buildSearchIndex(withHeaders, { stil, musicians })
      expect(fresh.search('turrican ii')).toHaveLength(0)
      expect(fresh.search('chip:8580')).toHaveLength(0)

      const applied = applyHeaders(withHeaders, later)
      expect(fresh.update(applied)).toBe(true)
      expect(fresh.rows).toBe(applied)
      expect(fresh.search('turrican ii')[0].row.name).toBe('Turrican_2.sid')
      expect(fresh.search('chip:8580').map((h) => h.row.name)).toEqual(['Turrican_2.sid'])
      expect(fresh.search('year:1991').map((h) => h.row.name)).toEqual(['Turrican_2.sid'])
    })

    it('answers exactly as a rebuild would, scores included', () => {
      const applied = applyHeaders(withHeaders, later)
      const updated = buildSearchIndex(withHeaders, { stil, musicians })
      updated.update(applied)
      const rebuilt = buildSearchIndex(applied, { stil, musicians })
      for (const query of ['commando', 'monty run', 'turrican', 'huelsbeck', 'hubbard', 'songs:>1']) {
        expect(updated.search(query).map((h) => [h.row.path, h.score])).toEqual(
          rebuilt.search(query).map((h) => [h.row.path, h.score])
        )
      }
    })

    it('never names a row twice in a posting, however often headers land', () => {
      const fresh = buildSearchIndex(withHeaders, { stil, musicians })
      // Same fields three times over, which a naive posting push would
      // record three times - showing the tune as a duplicate of itself.
      let applied = withHeaders
      for (let i = 0; i < 3; i++) {
        applied = applyHeaders(applied, later)
        fresh.update(applied)
      }
      const hits = fresh.search('turrican')
      expect(hits).toHaveLength(1)
      expect(hits[0].duplicates).toHaveLength(0)
    })

    it('reports a different catalogue rather than pretending to patch it', () => {
      const fresh = buildSearchIndex(withHeaders, { stil, musicians })
      expect(fresh.update(withHeaders.slice(0, 3))).toBe(false)
    })
  })
})

describe('the front of a ranked list', () => {
  it('is what sorting the whole list would put there', () => {
    const items = Array.from({ length: 2000 }, (_, i) => (i * 7919) % 2003)
    const order = (a: number, b: number) => a - b
    expect(best(items, 50, order)).toEqual([...items].sort(order).slice(0, 50))
    expect(best(items, 5000, order)).toEqual([...items].sort(order))
    expect(best(items, 0, order)).toEqual([])
  })
})
