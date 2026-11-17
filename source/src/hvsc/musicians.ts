/**
 * HVSC's Musicians.txt: who the handles belong to.
 *
 *   Agemixer (Yliaho, Ari) / Atlantis / Scallop - FINLAND
 *   Abbott, Chris - UNITED KINGDOM (ENGLAND)
 *   Aahz The Demon (Fitches, Dave {Asmodeus}) / Carcass - CANADA
 *
 * One line per musician: the name HVSC files them under, an optional real
 * name in parentheses (with other handles in braces inside it), any groups
 * after slashes, and the country last. The file opens with a country
 * tally, which looks like data but is not, and it is ISO-8859-1.
 *
 * This is what lets a search for "Ari Yliaho" find `Agemixer`, and the
 * library show a real name beside a handle.
 */

export interface Musician {
  /** The name as HVSC writes it, which is also the folder name with spaces. */
  name: string
  /** Real name, reordered to reading order: "Ari Yliaho". */
  realName?: string
  /** Other handles the entry mentions, from the braces. */
  aliases: string[]
  groups: string[]
  country?: string
}

export type MusicianDb = Map<string, Musician>

/** `Yliaho, Ari` -> `Ari Yliaho`; anything without a comma is left alone. */
const readingOrder = (name: string): string => {
  const comma = name.indexOf(',')
  if (comma < 0) return name.trim()
  const surname = name.slice(0, comma).trim()
  const rest = name.slice(comma + 1).trim()
  return rest ? `${rest} ${surname}` : surname
}

/**
 * The tally block is `NAME .......... 42`, and a real entry never has a run
 * of dots.
 */
const TALLY = /\.{4,}/

/**
 * The musicians are one block of the file among several, each fenced by a row
 * of asterisks: a preamble, a per-country tally, the musicians themselves,
 * and a list of group names at the end. Shape alone cannot tell a group name
 * in that last block from a musician filed under a group name, and the
 * preamble's prose lines look like entries too.
 *
 * What does distinguish the list is its size: in release 85 it is 1,871 lines
 * between two fences, where no other block reaches 60. So the largest fenced
 * block is the list, which needs no knowledge of how many blocks there are or
 * what order they come in.
 */
function listRegion(lines: string[]): [number, number] {
  const fences: number[] = [-1]
  lines.forEach((line, i) => {
    if (/^\*{4,}\s*$/.test(line.trim())) fences.push(i)
  })
  fences.push(lines.length)

  // Starts empty, so the first real gap wins; with no fences at all the
  // sentinels make that gap the whole file.
  let start = 0
  let end = 0
  for (let i = 1; i < fences.length; i++) {
    if (fences[i] - fences[i - 1] > end - start) {
      start = fences[i - 1] + 1
      end = fences[i]
    }
  }
  return [start, end]
}

export function parseMusicians(input: string): MusicianDb {
  const db: MusicianDb = new Map()
  const lines = input.split(/\r?\n/)
  const [from, to] = listRegion(lines)

  for (const raw of lines.slice(from, to)) {
    const line = raw.trim()
    if (!line || line.startsWith('*') || line.startsWith('http') || TALLY.test(line)) continue
    /*
     * All-caps lines are headings - except that a handle can be all caps
     * too, and `MSK - GERMANY` is an entry rather than a heading. The " - "
     * that separates a name from its country is what tells them apart, so a
     * line carrying one is kept whatever its case.
     */
    if (!/[a-z]/.test(line) && !line.includes(' - ')) continue

    // Country is after the last " - ", which no handle contains.
    let rest = line
    let country: string | undefined
    const dash = rest.lastIndexOf(' - ')
    if (dash > 0) {
      country = rest.slice(dash + 3).trim()
      rest = rest.slice(0, dash)
    }

    const groups: string[] = []
    const parts = rest.split(' / ')
    rest = parts.shift() ?? ''
    for (const part of parts) groups.push(part.trim())

    const aliases: string[] = []
    let realName: string | undefined
    const open = rest.indexOf('(')
    if (open > 0 && rest.endsWith(')')) {
      const inner = rest.slice(open + 1, -1)
      rest = rest.slice(0, open).trim()
      // Braces inside the parentheses hold further handles.
      const braced = inner.match(/\{([^}]*)\}/g) ?? []
      for (const brace of braced) {
        // Split and trim rather than split on /\s*\/\s*/, which rescans a run
        // of spaces from every position in it when no slash follows.
        for (const alias of brace.slice(1, -1).split('/')) {
          const handle = alias.trim()
          if (handle) aliases.push(handle)
        }
      }
      const withoutBraces = inner.replace(/\{[^}]*\}/g, '').trim()
      if (withoutBraces) realName = readingOrder(withoutBraces)
    }

    const name = rest.trim()
    if (!name) continue
    db.set(name, { name, realName, aliases, groups, country })
  }
  return db
}

/**
 * Looks a composer up by the folder name the collection uses. HVSC's folders
 * replace spaces with underscores and nothing else, so `Hubbard_Rob` is the
 * entry `Hubbard, Rob`; a handle with no real name is its own folder name.
 */
export function musicianForFolder(db: MusicianDb, folder: string): Musician | undefined {
  const spaced = folder.replace(/_/g, ' ')
  return db.get(spaced) ?? db.get(spaced.replace(/ /g, ', ')) ?? findByPrefix(db, spaced)
}

/**
 * `Hubbard_Rob` is filed as `Hubbard, Rob`, so the spaced form differs from
 * the entry by one comma whose position is not knowable in advance. Trying
 * each split point is cheap and exact.
 */
function findByPrefix(db: MusicianDb, spaced: string): Musician | undefined {
  const words = spaced.split(' ')
  for (let i = 1; i < words.length; i++) {
    const candidate = `${words.slice(0, i).join(' ')}, ${words.slice(i).join(' ')}`
    const hit = db.get(candidate)
    if (hit) return hit
  }
  return undefined
}
