import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildCgscCatalog } from '../src/cgsc/catalog'
import { CGSC_INDEX_FILE, parseIndex } from '../src/cgsc/load'
import { buildSearchIndex } from '../src/hvsc/search'

/**
 * The catalogue against the real collection, which the eight-path fixture
 * cannot stand in for: 27,414 files, 16,601 of them tunes, in 447 composer
 * folders whose names carry every punctuation habit of a 1980s bulletin
 * board.
 *
 * Skipped unless CGSC points at an unpacked Compute's Gazette SID Collection
 * holding a `.sidplayer-index.txt`, since it is 26 MB and not ours to commit.
 * The index is one command inside the collection:
 *
 *   find . -type f ! -name .sidplayer-index.txt | sed 's|^\./||' \
 *     | LC_ALL=C sort > .sidplayer-index.txt
 *
 *   CGSC=/path/to/CGSC npm test
 */

const dir = process.env.CGSC
const have = !!dir && existsSync(join(dir, CGSC_INDEX_FILE))

/*
 * Read on first use, not when the file loads: `describe.skipIf` still runs
 * the body that registers the tests, so reading at that point would fail the
 * suite for everyone who has not got the collection.
 */
let once: { paths: string[]; catalog: ReturnType<typeof buildCgscCatalog> } | null = null
const collection = () => {
  if (!once) {
    const paths = parseIndex(readFileSync(join(dir as string, CGSC_INDEX_FILE), 'utf8'))
    once = { paths, catalog: buildCgscCatalog(paths) }
  }
  return once
}

describe.skipIf(!have)('the real Compute’s Gazette collection', () => {
  it('reads every line of the index as a path', () => {
    const { paths } = collection()
    expect(paths.length).toBeGreaterThan(27_000)
    expect(paths.every((p) => p.startsWith('/'))).toBe(true)
  })

  it('finds the tunes among them', () => {
    const { paths, catalog } = collection()
    // Release 1.47: 16,601 .mus files. The rest are .str, .wds, pictures,
    // disk images and documents.
    expect(catalog.rows.length).toBeGreaterThan(16_000)
    expect(catalog.rows.length).toBeLessThan(paths.length)
  })

  it('files them under about four hundred and fifty composers', () => {
    const { catalog } = collection()
    expect(catalog.folders).toBeGreaterThan(400)
    expect(catalog.folders).toBeLessThan(500)
  })

  it('divides those into ten groups of roughly equal size', () => {
    const { catalog } = collection()
    const groups = catalog.tree.children
    expect(groups.length).toBe(10)
    const sizes = groups.map((g) => g.children.length)
    // The point of packing rather than a letter apiece: no group is a single
    // folder and none is more than a screenful.
    expect(Math.min(...sizes)).toBeGreaterThan(10)
    expect(Math.max(...sizes)).toBeLessThan(80)
  })

  it('accounts for every tune exactly once in the tree', () => {
    const { catalog } = collection()
    const total = catalog.tree.children.reduce((n, g) => n + g.total, 0)
    expect(total).toBe(catalog.rows.length)
  })

  it('leaves the four document folders out, since they hold no tunes', () => {
    const { catalog } = collection()
    const top = catalog.tree.children.flatMap((g) => g.children.map((c) => c.name))
    for (const name of ['00_Documents', '00_Commodore64', '00_SIDfests', '00_SidNews']) {
      expect(top).not.toContain(name)
    }
  })

  it('never lets a group path look like a folder path', () => {
    const { catalog } = collection()
    const folders = new Set(catalog.rows.map((r) => r.folder))
    for (const group of catalog.tree.children) expect(folders.has(group.path)).toBe(false)
  })

  it('builds a search index over it and answers from it', () => {
    const { catalog } = collection()
    const index = buildSearchIndex(catalog.rows)
    const hits = index.search('greensleeves')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].row.collection).toBe('cgsc')
  })

  /*
   * Rows carry no MD5, and folding duplicates by MD5 once collapsed a whole
   * result set into its first hit. A composer's own folder is the widest
   * search there is here, so it is the one that would show it.
   */
  it('does not fold results together for want of an MD5', () => {
    const { catalog } = collection()
    const index = buildSearchIndex(catalog.rows)
    const hits = index.search('composer:marquis', { limit: 500 })
    expect(hits.length).toBeGreaterThan(100)
    expect(new Set(hits.map((h) => h.row.path)).size).toBe(hits.length)
  })
})
