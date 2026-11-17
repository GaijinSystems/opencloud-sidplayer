import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseManifest } from '../src/hvsc/manifest'
import { buildCatalog, buildTree } from '../src/hvsc/catalog'
import { parseStil } from '../src/hvsc/stil'
import { parseMusicians } from '../src/hvsc/musicians'
import { buildSearchIndex } from '../src/hvsc/search'
import { applyHeaders, type HeaderFields } from '../src/hvsc/headers'
import { decodeLatin1 } from '../src/hvsc/text'

/**
 * The same parsers against the real documents, which the small fixtures
 * cannot stand in for: 61,157 manifest entries, 3.6 MB of commentary and
 * 1,833 musicians, with all the irregularity that implies.
 *
 * Skipped unless HVSC_DOCS points at a directory holding Songlengths.md5,
 * STIL.txt and Musicians.txt, since they are 9 MB and not ours to commit.
 * Fetch them with:
 *
 *   mkdir -p /tmp/hvsc-docs && cd /tmp/hvsc-docs
 *   for f in Songlengths.md5 STIL.txt Musicians.txt; do
 *     curl -sSO "https://hvsc.brona.dk/HVSC/C64Music/DOCUMENTS/$f"
 *   done
 *   HVSC_DOCS=/tmp/hvsc-docs npm test
 */

const dir = process.env.HVSC_DOCS
const have = !!dir && ['Songlengths.md5', 'STIL.txt', 'Musicians.txt'].every((f) => existsSync(join(dir, f)))
const read = (name: string): string => decodeLatin1(readFileSync(join(dir as string, name)))

describe.skipIf(!have)('the real HVSC documents', () => {
  it('parses the whole manifest, one entry per file', () => {
    const { entries, skipped } = parseManifest(read('Songlengths.md5'))
    expect(skipped).toBe(0)
    // Release 85 has 61,157; a later release has more, never fewer.
    expect(entries.length).toBeGreaterThanOrEqual(61157)
    expect(entries.every((e) => e.path.startsWith('/') && e.lengths.length > 0)).toBe(true)
    expect(new Set(entries.map((e) => e.path)).size).toBe(entries.length)
    console.log(
      `  manifest: ${entries.length} entries, ${new Set(entries.map((e) => e.md5)).size} distinct MD5s`
    )
  })

  it('builds a catalogue and a tree over the whole collection', () => {
    const rows = buildCatalog(parseManifest(read('Songlengths.md5')).entries)
    const tree = buildTree(rows)
    const categories = tree.children.map((c) => `${c.name} ${c.total}`)
    expect(tree.children.map((c) => c.name)).toEqual(expect.arrayContaining(['DEMOS', 'GAMES', 'MUSICIANS']))
    expect(tree.total).toBe(rows.length)
    const musicians = tree.children.find((c) => c.name === 'MUSICIANS')
    expect(musicians && musicians.total).toBeGreaterThan(40000)
    // Every row under MUSICIANS gets a composer, which the detail pane needs.
    const under = rows.filter((r) => r.category === 'MUSICIANS')
    expect(under.every((r) => !!r.composerFolder)).toBe(true)
    console.log(`  tree: ${categories.join(', ')}`)
  })

  it('parses STIL without losing entries or leaking its preamble', () => {
    const stil = parseStil(read('STIL.txt'))
    // Release 85 documents 18,898 of the 61,157 tunes.
    expect(stil.size).toBeGreaterThan(15000)
    expect([...stil.keys()].every((k) => k.startsWith('/'))).toBe(true)
    const monty = stil.get('/MUSICIANS/H/Hubbard_Rob/Monty_on_the_Run.sid')
    expect(monty?.subsongs.get(1)?.title).toContain("Devil's Gallop")
    const withSubsongs = [...stil.values()].filter((e) => e.subsongs.size > 0).length
    console.log(`  STIL: ${stil.size} entries, ${withSubsongs} with per-subsong notes`)
  })

  it('parses the musician list and nothing around it', () => {
    const db = parseMusicians(read('Musicians.txt'))
    expect(db.size).toBeGreaterThan(1500)
    expect(db.get('Hubbard, Rob')?.country).toContain('UNITED KINGDOM')
    expect(db.get('Agemixer')?.realName).toBe('Ari Yliaho')
    // The group list at the end of the file must not have come through.
    expect(db.has('20th Century Composers (20CC)')).toBe(false)
    expect(db.has('C64 Music Groups :')).toBe(false)
    /*
     * A handle in capitals is still a musician. Skipping every line without a
     * lowercase letter took these five out with the headings, and the " - "
     * before a country is what tells the two apart.
     */
    for (const handle of ['C.L.S.', 'CMP', 'NM156', 'PM', 'TN']) {
      expect(db.has(handle), `${handle} should be in the list`).toBe(true)
    }
    // `TN / ICE - FINLAND` is one of them: the group after the slash is read
    // as a group, which is what the line means.
    expect(db.get('TN')?.groups).toContain('ICE')
    const withReal = [...db.values()].filter((m) => m.realName).length
    console.log(`  musicians: ${db.size} entries, ${withReal} with a real name`)
  })

  it('indexes the collection quickly enough to search while typing', () => {
    const rows = buildCatalog(parseManifest(read('Songlengths.md5')).entries)
    const stil = parseStil(read('STIL.txt'))
    const musicians = parseMusicians(read('Musicians.txt'))

    const t0 = performance.now()
    const index = buildSearchIndex(rows, { stil, musicians })
    const built = performance.now() - t0
    const stats = index.stats()

    const queries = ['commando', 'monty run', 'hubbard', 'hulsbeck', 'galway wizball', 'delta', 'turrican']
    const t1 = performance.now()
    const counts = queries.map((q) => index.search(q).length)
    const queried = (performance.now() - t1) / queries.length

    console.log(
      `  index: ${stats.rows} rows, ${stats.tokens} tokens, built in ${built.toFixed(0)} ms; ` +
        `${queried.toFixed(1)} ms per query (${counts.join(', ')} hits)`
    )
    expect(counts.every((c) => c > 0)).toBe(true)
    // Generous bounds: this runs in a worker, but a second would be felt.
    expect(built).toBeLessThan(8000)
    expect(queried).toBeLessThan(150)

    // The queries a person actually types must land on the right tune. Which
    // rip of it comes first is the tie-break question below.
    expect(index.search('monty on the run')[0].row.name).toBe('Monty_on_the_Run.sid')
    expect(index.search('wizball')[0].row.path).toContain('Wizball')

    /*
     * Five files are called Commando.sid: Rob Hubbard's and four covers, none
     * of them mentioned in STIL. Two are called Monty_on_the_Run.sid. With no
     * header fields there is nothing to rank same-named rips by, so ties fall
     * back to the path, which puts Bakewell_Dwayne's Monty before Hubbard's -
     * not wrong, just uninformed. Once the years are known the earliest wins,
     * which is the only ordering the collection's own data supports.
     */
    const commandos = index.search('commando').filter((h) => h.row.name === 'Commando.sid')
    expect(commandos).toHaveLength(5)
    expect(commandos.slice(0, 3).some((h) => h.row.composerFolder === 'Hubbard_Rob')).toBe(true)

    const YEARS: Record<string, string> = {
      '/MUSICIANS/H/Hubbard_Rob/Commando.sid': '1985 Elite',
      '/MUSICIANS/C/Cadaver/Commando.sid': '1998',
      '/MUSICIANS/I/Isildur/Commando.sid': '2003',
      '/MUSICIANS/P/Patfield_Kent/Commando.sid': '1992',
      '/MUSICIANS/B/Blues_Muz/Gallefoss_Glenn/Commando.sid': '2004'
    }
    const dated = buildSearchIndex(
      rows.map((r) => (YEARS[r.path] ? { ...r, released: YEARS[r.path] } : r)),
      { stil, musicians }
    )
    expect(dated.search('commando')[0].row.path).toBe('/MUSICIANS/H/Hubbard_Rob/Commando.sid')

    const prose = index.search('stil:amiga')
    console.log(`  prose index: ${index.stats().proseTokens} tokens, "amiga" in ${prose.length} entries`)
    expect(prose.length).toBeGreaterThan(50)
  })

  /*
   * Filling a folder's headers used to rebuild the whole index, and over a
   * real collection that is 1.5 seconds with the main thread stopped -
   * spent on every folder opened and every search, in the middle of
   * whatever was playing. This is the measurement that has to hold.
   */
  it('folds newly read headers in without rebuilding the index', () => {
    const rows = buildCatalog(parseManifest(read('Songlengths.md5')).entries)
    const stil = parseStil(read('STIL.txt'))
    const musicians = parseMusicians(read('Musicians.txt'))

    let started = performance.now()
    const index = buildSearchIndex(rows, { stil, musicians })
    const rebuild = performance.now() - started

    // A folder's worth of headers, as `fillVisibleHeaders` delivers them.
    const fields = new Map<string, HeaderFields>()
    for (const row of rows.slice(0, 200)) {
      fields.set(row.path, { title: 'Zorblattica', author: 'Anon', released: '1985 Somebody' })
    }
    const applied = applyHeaders(rows, fields)
    started = performance.now()
    expect(index.update(applied)).toBe(true)
    const incremental = performance.now() - started
    console.log(
      `  rebuild ${rebuild.toFixed(0)} ms vs update ${incremental.toFixed(1)} ms for 200 changed rows`
    )
    expect(incremental).toBeLessThan(rebuild / 10)

    // The new fields are searchable, each row once: a posting list that
    // named a document twice would show the tune as its own duplicate.
    const hits = index.search('zorblattica', { limit: 500 })
    expect(hits.length).toBe(200)
    expect(new Set(hits.map((h) => h.row.path)).size).toBe(200)
    expect(hits.every((h) => h.duplicates.length === 0)).toBe(true)
    expect(index.rows).toBe(applied)

    // And an untouched query answers exactly as a rebuild would, scores too.
    const fresh = buildSearchIndex(applied, { stil, musicians }).search('monty on the run', { limit: 20 })
    const updated = index.search('monty on the run', { limit: 20 })
    expect(updated.map((h) => h.row.path)).toEqual(fresh.map((h) => h.row.path))
    expect(updated.map((h) => h.score)).toEqual(fresh.map((h) => h.score))
  }, 120000)

  it('reads the documents as Latin-1, as the collection writes them', () => {
    const size = statSync(join(dir as string, 'Musicians.txt')).size
    const text = read('Musicians.txt')
    expect(size).toBeGreaterThan(0)
    expect(text).not.toContain('�')
  })
})
