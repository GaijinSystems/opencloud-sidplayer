import type { CatalogRow } from './catalog'
import type { MusicianDb } from './musicians'
import { musicianForFolder } from './musicians'
import type { StilDb } from './stil'
import { collapsedVariant, normalise, tokenise } from './text'

/**
 * Search over the catalogue, in the browser, over 61,157 tunes.
 *
 * Two indexes rather than one. The main index covers the short fields - file
 * name, composer, and the header's title, author and release line - which is
 * what almost every query is really after; it is a few MB of postings and
 * builds in about a second. STIL's commentary is 3.6 MB of prose, and
 * indexing it costs several times as much memory for a question people ask
 * rarely, so it is built on first use: when a query says `stil:`, or when the
 * main index returns almost nothing and the prose is worth a second look.
 *
 * Ranking is by which field matched, because a person typing "commando" wants
 * the tune called Commando before a tune whose commentary mentions the word.
 */

export interface SearchFilters {
  /** Composer folder or name, matched loosely. */
  composer?: string
  yearFrom?: number
  yearTo?: number
  model?: '6581' | '8580'
  clock?: 'pal' | 'ntsc'
  /** Minimum number of subsongs, for "more than one". */
  minSongs?: number
  hasStil?: boolean
  /** Only paths starting with this, for "search in this folder only". */
  pathPrefix?: string
}

export interface ParsedQuery {
  /** Free terms, normalised. */
  terms: string[]
  /** Terms that must appear in STIL commentary. */
  prose: string[]
  filters: SearchFilters
  /** True when the query has nothing to match on, only filters. */
  empty: boolean
}

export interface SearchHit {
  row: CatalogRow
  score: number
  /** Other rows with the same MD5: the same rip filed elsewhere. */
  duplicates: CatalogRow[]
}

/* ---- query syntax -------------------------------------------------------- */

const FIELD_QUERY = /^([a-z]+):(.*)$/

/**
 * `composer:hubbard year:1985..1988 songs:>1 path:DEMOS/ stil:cover monty`
 *
 * Unknown keys are treated as ordinary text, so a tune whose name contains a
 * colon still finds itself instead of vanishing into a filter.
 */
export function parseQuery(input: string): ParsedQuery {
  const filters: SearchFilters = {}
  const terms: string[] = []
  const prose: string[] = []

  // Quoted runs stay together as a phrase; everything else splits on spaces.
  const pieces = input.match(/"[^"]*"|\S+/g) ?? []
  for (const piece of pieces) {
    if (piece.startsWith('"')) {
      for (const t of tokenise(piece)) terms.push(t)
      continue
    }
    const field = FIELD_QUERY.exec(piece.toLowerCase())
    if (!field) {
      for (const t of tokenise(piece)) terms.push(t)
      continue
    }
    const [, key, rawValue] = field
    const value = rawValue.trim()
    switch (key) {
      case 'composer':
      case 'by':
        filters.composer = normalise(value)
        break
      case 'year': {
        const range = /^(\d{4})?(?:\.\.(\d{4})?)?$/.exec(value)
        if (range) {
          if (range[1]) filters.yearFrom = Number(range[1])
          if (range[2]) filters.yearTo = Number(range[2])
          if (range[1] && !value.includes('..')) filters.yearTo = Number(range[1])
        }
        break
      }
      case 'chip':
      case 'model':
        if (value === '6581' || value === '8580') filters.model = value
        break
      case 'clock':
        if (value === 'pal' || value === 'ntsc') filters.clock = value
        break
      case 'songs':
      case 'subsongs': {
        const gt = /^>(\d+)$/.exec(value)
        if (gt) filters.minSongs = Number(gt[1]) + 1
        else if (/^\d+$/.test(value)) filters.minSongs = Number(value)
        break
      }
      case 'path':
      case 'in':
        filters.pathPrefix = value.replace(/^\/+/, '').toUpperCase()
        break
      case 'stil':
        filters.hasStil = true
        for (const t of tokenise(value)) prose.push(t)
        break
      default:
        for (const t of tokenise(piece)) terms.push(t)
    }
  }
  return { terms, prose, filters, empty: terms.length === 0 && prose.length === 0 }
}

/** The names `headerOnlyFilters` can give, as the query spells them. */
export type HeaderOnlyFilter = 'year' | 'chip' | 'clock' | 'stil'

/**
 * The filters in a query that only a SID header or HVSC's manifest can
 * answer, named as the query spells them.
 *
 * A collection catalogued from path names alone - Compute's Gazette - has no
 * year, no chip, no clock and no commentary to test, so every row in it
 * fails these filters. That is the right answer and the wrong silence: a
 * search for `year:1987` returning nothing from Compute's looks like the
 * collection has nothing from 1987 rather than like the question cannot be
 * put to it. The view says so instead, and this is what it says it about.
 *
 * `songs:` is deliberately absent. A MUS file is one score with no subsongs,
 * so a Compute's row answers it honestly with 1.
 */
export function headerOnlyFilters(query: string): HeaderOnlyFilter[] {
  const { filters } = parseQuery(query)
  const named: HeaderOnlyFilter[] = []
  if (filters.yearFrom !== undefined || filters.yearTo !== undefined) named.push('year')
  if (filters.model) named.push('chip')
  if (filters.clock) named.push('clock')
  if (filters.hasStil) named.push('stil')
  return named
}

/* ---- the index ----------------------------------------------------------- */

/** Field weights. A name beats a composer beats the rest of the path. */
const W_TITLE = 10
const W_STEM = 8
const W_COMPOSER = 6
const W_AUTHOR = 6
const W_RELEASED = 3
const W_PATH = 2
const W_PROSE = 1
/** A term that only starts a word is worth less than one that is the word. */
const PREFIX_FACTOR = 0.55

interface Haystacks {
  title: string
  stem: string
  composer: string
  author: string
  released: string
  path: string
  year: number | null
  /**
   * The collection path, upper case and without its leading slash, which is
   * the shape `path:` and "this folder only" compare against. Computed once
   * here rather than per candidate per search: a scoped search over the whole
   * catalogue used to upper-case 61,157 paths on every keystroke.
   */
  upperPath: string
}

/**
 * How well a term matches one field, without cutting the field up.
 *
 * 3 is the term as a whole word, 2 the start of a word, 1 anywhere at all, 0
 * not present. This used to be `field.split(' ')` followed by `includes` and
 * `some(startsWith)`, which is three passes and one array per field per term
 * per candidate: a single letter typed in the box prefix-expands to nearly
 * every row in the collection, so that was on the order of 370,000 array
 * allocations between one keystroke and the next. Scanning the joined string
 * for the term and looking at the characters on either side answers the same
 * question and allocates nothing.
 */
function matchKind(field: string, term: string): 0 | 1 | 2 | 3 {
  let best: 0 | 1 | 2 | 3 = 0
  let i = field.indexOf(term)
  while (i !== -1) {
    // 32 is the space these haystacks are joined with; `normalise` leaves no
    // other whitespace in them.
    const startsWord = i === 0 || field.charCodeAt(i - 1) === 32
    const end = i + term.length
    const endsWord = end === field.length || field.charCodeAt(end) === 32
    if (startsWord && endsWord) return 3
    if (startsWord) best = 2
    else if (best === 0) best = 1
    i = field.indexOf(term, i + 1)
  }
  return best
}

export interface SearchIndex {
  readonly rows: CatalogRow[]
  search(query: string, options?: { limit?: number; filters?: SearchFilters }): SearchHit[]
  /**
   * Swaps in rows that differ only in header fields, keeping everything the
   * index already knows about the rows that did not change.
   *
   * This is what makes filling headers affordable. Reading a folder's headers
   * yields at most a couple of hundred changed rows, and rebuilding from
   * scratch for them costs 1.4 seconds of blocked main thread over release
   * 85 - every folder opened and every search paid it, and the page froze
   * mid-tune each time. `applyHeaders` returns the same array in the same
   * order with the untouched rows still by reference, so identity says which
   * rows to redo.
   *
   * Returns false when the rows are a different collection altogether, which
   * only a rebuild can answer.
   */
  update(rows: CatalogRow[]): boolean
  /**
   * How many rows and tokens the index holds, and whether the prose index
   * has been built.
   *
   * Kept although no screen shows it: `proseTokens` being null is the only
   * way to observe from outside that STIL's 3.6 MB of commentary has not
   * been indexed, which is a property worth a test rather than a comment.
   */
  stats(): { rows: number; tokens: number; proseTokens: number | null }
}

export function buildSearchIndex(
  rows: CatalogRow[],
  deps: { stil?: StilDb; musicians?: MusicianDb } = {}
): SearchIndex {
  const { stil, musicians } = deps
  /** The rows in play, which `update` replaces. */
  let docs = rows

  /**
   * A field's searchable text, with a collapsed spelling appended for any
   * word that carries a transliterated vowel. Both spellings then match at
   * the field's own weight, which is what makes "hulsbeck", "huelsbeck" and
   * "hülsbeck" equally good ways to find `Huelsbeck_Chris`. Appending to the
   * field rather than keeping a separate alias haystack matters: scoring
   * looks at the field a term matched, and an alias is the same field.
   */
  const withAliases = (text: string): string => {
    if (!text) return ''
    const extra: string[] = []
    for (const word of text.split(' ')) {
      const collapsed = collapsedVariant(word)
      if (collapsed) extra.push(collapsed)
    }
    return extra.length ? `${text} ${extra.join(' ')}` : text
  }

  /**
   * A folder's haystack, worked out once per folder rather than once per
   * tune in it: a composer's folder holds dozens, and the strings are shared.
   */
  const folders = new Map<string, string>()
  const folderHaystack = (folder: string): string => {
    let text = folders.get(folder)
    if (text === undefined) {
      text = withAliases(normalise(folder))
      folders.set(folder, text)
    }
    return text
  }

  const haystackFor = (row: CatalogRow): Haystacks => {
    const musician =
      musicians && row.composerFolder ? musicianForFolder(musicians, row.composerFolder) : undefined
    // The composer haystack carries the folder, the reading-order name, the
    // real name and any other handles, so all four spellings find the tune.
    const composerParts = [row.composerFolder ?? '', row.composer ?? '']
    if (musician) {
      composerParts.push(musician.realName ?? '', ...musician.aliases, ...musician.groups)
    }
    return {
      title: withAliases(normalise(row.title ?? '')),
      stem: withAliases(normalise(row.stem)),
      composer: withAliases(normalise(composerParts.join(' '))),
      author: withAliases(normalise(row.author ?? '')),
      released: withAliases(normalise(row.released ?? '')),
      path: folderHaystack(row.folder),
      year: yearOf(row),
      upperPath: row.path.slice(1).toUpperCase()
    }
  }

  const haystacks: Haystacks[] = rows.map(haystackFor)

  /** Every token one row contributes, each once. */
  const tokensOf = (hay: Haystacks): Set<string> => {
    const out = new Set<string>()
    for (const field of [hay.title, hay.stem, hay.composer, hay.author, hay.released, hay.path]) {
      if (!field) continue
      // No `collapsedVariant` here: `withAliases` has already appended the
      // collapsed spelling of every word to each of these fields, so doing
      // it again per token was the same work twice over 61,157 rows.
      for (const token of field.split(' ')) {
        if (token) out.add(token)
      }
    }
    return out
  }

  const postings = new Map<string, number[]>()
  haystacks.forEach((hay, doc) => {
    for (const token of tokensOf(hay)) {
      const list = postings.get(token)
      if (list) list.push(doc)
      else postings.set(token, [doc])
    }
  })
  /** The token list, sorted, for prefix lookups. */
  let tokens = [...postings.keys()].sort()

  /** Merges newly created tokens into the sorted list in one pass. */
  const mergeTokens = (fresh: string[]): void => {
    fresh.sort()
    const out: string[] = new Array(tokens.length + fresh.length)
    let i = 0
    let j = 0
    let k = 0
    while (i < tokens.length && j < fresh.length) {
      out[k++] = tokens[i] <= fresh[j] ? tokens[i++] : fresh[j++]
    }
    while (i < tokens.length) out[k++] = tokens[i++]
    while (j < fresh.length) out[k++] = fresh[j++]
    tokens = out
  }

  /* Prose, built on demand. */
  let proseIndex: Map<string, number[]> | null = null
  let proseTokens: string[] = []
  const buildProse = (): void => {
    if (proseIndex || !stil) return
    proseIndex = new Map()
    docs.forEach((row, doc) => {
      const entry = stil.get(row.path)
      if (!entry) return
      for (const token of new Set(tokenise(entry.text))) {
        const list = proseIndex!.get(token)
        if (list) list.push(doc)
        else proseIndex!.set(token, [doc])
      }
    })
    proseTokens = [...proseIndex.keys()].sort()
  }

  /** Docs for a token, plus docs for every token that it prefixes. */
  const lookup = (index: Map<string, number[]>, sorted: string[], token: string, prefix: boolean): number[] => {
    const exact = index.get(token)
    if (!prefix) return exact ?? []
    const out = new Set<number>(exact ?? [])
    // Binary search for the first token with this prefix, then walk.
    let lo = 0
    let hi = sorted.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (sorted[mid] < token) lo = mid + 1
      else hi = mid
    }
    for (let i = lo; i < sorted.length && sorted[i].startsWith(token); i++) {
      for (const doc of index.get(sorted[i]) ?? []) out.add(doc)
    }
    return [...out]
  }

  const passesFilters = (doc: number, f: SearchFilters): boolean => {
    const row = docs[doc]
    const hay = haystacks[doc]
    if (f.pathPrefix && !hay.upperPath.startsWith(f.pathPrefix)) return false
    if (f.composer && !hay.composer.includes(f.composer)) return false
    if (f.minSongs !== undefined) {
      const songs = row.songs ?? row.lengths.length
      if (songs < f.minSongs) return false
    }
    if (f.model && row.model !== f.model) return false
    if (f.clock && row.clock !== f.clock) return false
    if (f.hasStil && !(stil && stil.has(row.path))) return false
    if (f.yearFrom !== undefined || f.yearTo !== undefined) {
      if (hay.year === null) return false
      if (f.yearFrom !== undefined && hay.year < f.yearFrom) return false
      if (f.yearTo !== undefined && hay.year > f.yearTo) return false
    }
    return true
  }

  /** What one field is worth for one term: all of its weight for a whole word, less for a part of one. */
  const fieldScore = (field: string, term: string, last: boolean, weight: number): number => {
    if (!field) return 0
    const kind = matchKind(field, term)
    if (kind === 3) return weight
    if (kind === 2 && last) return weight * PREFIX_FACTOR
    return kind >= 1 ? weight * 0.3 : 0
  }

  const scoreDoc = (doc: number, terms: string[], proseTerms: string[]): number => {
    const hay = haystacks[doc]
    const row = docs[doc]
    let score = 0
    for (let i = 0; i < terms.length; i++) {
      const term = terms[i]
      const last = i === terms.length - 1
      // Written out rather than looped over a list of pairs: the list was
      // seven allocations for every term of every candidate, and a one-letter
      // query has most of the collection as candidates.
      const best = Math.max(
        fieldScore(hay.title, term, last, W_TITLE),
        fieldScore(hay.stem, term, last, W_STEM),
        fieldScore(hay.composer, term, last, W_COMPOSER),
        fieldScore(hay.author, term, last, W_AUTHOR),
        fieldScore(hay.released, term, last, W_RELEASED),
        fieldScore(hay.path, term, last, W_PATH)
      )
      if (best === 0 && proseTerms.length === 0) return 0
      score += best
    }
    // Prose terms are already known to match, from the postings, so each is
    // worth its weight and there is nothing to test.
    score += proseTerms.length * W_PROSE
    // An exact whole-name match should beat a long name that merely contains
    // the words: "Delta" over "Delta_Remix_Part_2".
    const joined = terms.join(' ')
    if (joined && (hay.title === joined || hay.stem === joined)) score += 12
    if (row.category === 'MUSICIANS') score += 2
    score -= Math.max(0, row.path.split('/').length - 4) * 0.4
    /*
     * Prefer the earliest release among tunes of the same name.
     *
     * HVSC has five files called Commando.sid - Rob Hubbard's from 1985 and
     * four later covers - and not one of them has a STIL entry, so nothing in
     * the collection says which is the original. The release year does, once
     * the header index has filled it in: a cover cannot predate what it
     * covers. Worth at most 1.5, so it decides ties without ever outweighing
     * a better field match, and worth nothing at all while the year is
     * unknown, which is honest about a ranking that cannot yet know.
     */
    if (hay.year !== null) score += Math.max(0, Math.min(1.5, (1995 - hay.year) / 8))
    return score
  }

  return {
    get rows() {
      return docs
    },
    update(next) {
      if (next.length !== docs.length) return false
      const fresh: string[] = []
      for (let doc = 0; doc < next.length; doc++) {
        // Untouched rows are the very same objects `applyHeaders` was given.
        if (next[doc] === docs[doc]) continue
        /*
         * A row that changed must still be the same tune. Only header fields
         * are ever folded in this way, so a different path at the same index
         * means a different catalogue of coincidentally equal length, and the
         * prose index - which is keyed by position - would then point at the
         * wrong rows. A rebuild is the only honest answer.
         */
        if (next[doc].path !== docs[doc].path) return false
        const before = tokensOf(haystacks[doc])
        const hay = haystackFor(next[doc])
        haystacks[doc] = hay
        for (const token of tokensOf(hay)) {
          // Only tokens the row did not already contribute, so no posting
          // list ends up naming the same document twice.
          if (before.has(token)) continue
          const list = postings.get(token)
          if (list) list.push(doc)
          else {
            postings.set(token, [doc])
            fresh.push(token)
          }
        }
      }
      docs = next
      if (fresh.length) mergeTokens(fresh)
      /*
       * A token the row no longer contributes keeps its posting, which costs
       * nothing: scoring reads the haystacks, so such a document scores zero
       * and is dropped. Filter-only queries do not read the postings at all.
       */
      return true
    },
    search(query, options = {}) {
      const limit = options.limit ?? 200
      const parsed = parseQuery(query)
      const filters = { ...parsed.filters, ...options.filters }

      let candidates: number[] | null = null
      const intersect = (next: number[]): void => {
        if (candidates === null) {
          candidates = next
          return
        }
        const set = new Set(next)
        candidates = candidates.filter((doc) => set.has(doc))
      }

      parsed.terms.forEach((term, i) => {
        const last = i === parsed.terms.length - 1
        intersect(lookup(postings, tokens, term, last))
      })

      if (parsed.prose.length) {
        buildProse()
        if (proseIndex) {
          for (const term of parsed.prose) intersect(lookup(proseIndex, proseTokens, term, true))
        }
      }

      // Filters alone, with no terms: every row is a candidate.
      if (candidates === null) candidates = docs.map((_, i) => i)

      const hits: SearchHit[] = []
      const seenMd5 = new Map<string, SearchHit>()
      /** How many hits a ranked list gives once duplicates are folded. */
      const foldedCount = (list: Array<{ doc: number }>): number => {
        const seen = new Set<string>()
        let count = 0
        for (const { doc } of list) {
          const md5 = docs[doc].md5
          if (md5 && seen.has(md5)) continue
          if (md5) seen.add(md5)
          count++
        }
        return count
      }
      const scored: Array<{ doc: number; score: number }> = []
      for (const doc of candidates as number[]) {
        if (!passesFilters(doc, filters)) continue
        const score = parsed.empty ? 1 : scoreDoc(doc, parsed.terms, parsed.prose)
        if (score > 0) scored.push({ doc, score })
      }
      const order = (a: { doc: number; score: number }, b: { doc: number; score: number }): number =>
        b.score - a.score ||
        (docs[a.doc].path < docs[b.doc].path ? -1 : docs[a.doc].path > docs[b.doc].path ? 1 : 0)
      /*
       * Only the front of the list is wanted. A one-letter query scores most
       * of the collection, and sorting all of it to keep five hundred was
       * the larger part of the search. Twice the limit leaves room for the
       * duplicates folded below; a search with more of them than that sorts
       * the lot, as it always did.
       */
      const room = limit * 2
      let ranked = scored.length > room ? best(scored, room, order) : scored.sort(order)
      if (ranked !== scored && foldedCount(ranked) < limit) ranked = scored.sort(order)

      for (const { doc, score } of ranked) {
        const row = docs[doc]
        /*
         * Folding duplicates needs an MD5 to fold on. Compute's Gazette rows
         * have none - nothing in that collection records one - and an empty
         * string is not a shared identity: without this guard every hit
         * after the first became a "duplicate" of it and one result came
         * back for the whole search.
         */
        const already = row.md5 ? seenMd5.get(row.md5) : undefined
        if (already) {
          already.duplicates.push(row)
          continue
        }
        const hit: SearchHit = { row, score, duplicates: [] }
        if (row.md5) seenMd5.set(row.md5, hit)
        hits.push(hit)
        if (hits.length >= limit) break
      }
      return hits
    },
    stats() {
      return { rows: docs.length, tokens: postings.size, proseTokens: proseIndex ? proseIndex.size : null }
    }
  }
}

/**
 * The `k` items that sort first under `order`, in that order, without sorting
 * the rest: a heap of the best so far, whose worst is the one to beat.
 */
export function best<T>(items: T[], k: number, order: (a: T, b: T) => number): T[] {
  if (k <= 0) return []
  // A max-heap under `order`: the root is the worst of those kept.
  const heap: T[] = []
  const worse = (i: number, j: number): boolean => order(heap[i], heap[j]) > 0
  const swap = (i: number, j: number): void => {
    const t = heap[i]
    heap[i] = heap[j]
    heap[j] = t
  }
  const down = (from: number): void => {
    let i = from
    for (;;) {
      const l = 2 * i + 1
      const r = l + 1
      let top = i
      if (l < heap.length && worse(l, top)) top = l
      if (r < heap.length && worse(r, top)) top = r
      if (top === i) return
      swap(i, top)
      i = top
    }
  }
  for (const item of items) {
    if (heap.length < k) {
      heap.push(item)
      let i = heap.length - 1
      while (i > 0) {
        const parent = (i - 1) >> 1
        if (!worse(i, parent)) break
        swap(i, parent)
        i = parent
      }
    } else if (order(item, heap[0]) < 0) {
      heap[0] = item
      down(0)
    }
  }
  return heap.sort(order)
}

/**
 * The year out of a header's release line. HVSC writes "1985 Elite",
 * sometimes "19?? Unknown" or "1985-1987", so the first four digits with a
 * plausible leading pair are what can be trusted.
 */
export function yearOf(row: CatalogRow): number | null {
  const m = /\b(19[7-9]\d|20[0-4]\d)\b/.exec(row.released ?? '')
  return m ? Number(m[1]) : null
}
