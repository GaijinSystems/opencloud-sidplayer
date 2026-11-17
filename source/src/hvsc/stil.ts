/**
 * HVSC's STIL.txt: the SID Tune Information List, the collection's
 * commentary. What a tune is a cover of, who wrote the original, what the
 * composer said about it, which subsong is which.
 *
 * The format is plain text meant for human eyes, and its shape matters:
 *
 *   /MUSICIANS/H/Hubbard_Rob/Monty_on_the_Run.sid
 *   (#1)
 *     TITLE: The Devil's Gallop [from the Dick Barton radio show]
 *    ARTIST: Charles Williams
 *   COMMENT: Heavily inspired by the song Devil's Gallop, which was the title
 *            theme for the 1940's American detective radio show.
 *
 * Blocks are separated by blank lines and begin with a collection path. Field
 * keys are right-aligned to a fixed column, so a continuation line is simply
 * one indented past the colon. A `(#n)` line on its own scopes the fields
 * that follow to that subsong; fields before any such line belong to the tune
 * as a whole. The file is ISO-8859-1 (see `text.ts`).
 */

export interface StilFields {
  title?: string
  artist?: string
  author?: string
  comment?: string
  /** Any other key STIL uses, verbatim, so nothing is silently dropped. */
  other?: Record<string, string>
}

export interface StilEntry {
  /** Fields that apply to the whole tune. */
  tune: StilFields
  /** Fields for one subsong, keyed by its 1-based number. */
  subsongs: Map<number, StilFields>
  /** Everything above as one string, for full-text search. */
  text: string
}

export type StilDb = Map<string, StilEntry>

/*
 * A field line, and only for a key STIL actually uses.
 *
 * It used to admit any run of capitals followed by a colon, which reads a
 * continuation line of a COMMENT beginning "NOTE: ..." as the start of a new
 * field: the comment is truncated there and a spurious key appears beside it.
 * The keys are a closed set - this is a file with a documented format, not
 * free text - so naming them is both safer and more honest than a shape.
 */
const KEYS = ['NAME', 'TITLE', 'ARTIST', 'AUTHOR', 'COMMENT'] as const
const FIELD = new RegExp(`^\\s{0,12}(${KEYS.join('|')}):\\s?(.*)$`)
const SUBSONG = /^\s*\(#(\d{1,3})\)\s*$/

const assign = (fields: StilFields, key: string, value: string): void => {
  const text = value.trim()
  if (!text) return
  switch (key) {
    case 'TITLE':
      fields.title = text
      break
    case 'ARTIST':
      fields.artist = text
      break
    case 'AUTHOR':
      fields.author = text
      break
    case 'COMMENT':
      fields.comment = text
      break
    default:
      fields.other = { ...fields.other, [key]: text }
  }
}

/**
 * Parses the whole file. About 3.6 MB in release 85, which takes a few tens
 * of milliseconds, so the library does it once per release and caches the
 * result rather than streaming it.
 */
export function parseStil(input: string): StilDb {
  const db: StilDb = new Map()
  let path: string | null = null
  let fields: StilFields = {}
  let subsongs = new Map<number, StilFields>()
  let lines: string[] = []
  let key: string | null = null
  let buffer: string[] = []
  let subsong = 0

  const flushField = (): void => {
    if (!key) return
    const value = buffer.join(' ').replace(/\s+/g, ' ')
    assign(subsong ? ensure(subsongs, subsong) : fields, key, value)
    key = null
    buffer = []
  }

  const flushEntry = (): void => {
    flushField()
    if (path && (Object.keys(fields).length || subsongs.size)) {
      db.set(path, { tune: fields, subsongs, text: lines.join('\n') })
    }
    path = null
    fields = {}
    subsongs = new Map()
    lines = []
    subsong = 0
  }

  for (const raw of input.split(/\r?\n/)) {
    // Not `/\s+$/`: on a long run of spaces with something after it that is
    // quadratic, and this document comes through a proxy from a mirror.
    const line = raw.trimEnd()

    if (!line.trim()) {
      flushEntry()
      continue
    }
    // A path line starts a block. STIL's own preamble is separated by blank
    // lines too, so anything before the first path is dropped by flushEntry.
    if (line.startsWith('/')) {
      flushEntry()
      path = line.trim()
      continue
    }
    if (!path) continue

    const marker = SUBSONG.exec(line)
    if (marker) {
      flushField()
      subsong = Number(marker[1])
      lines.push(line.trim())
      continue
    }

    const field = FIELD.exec(line)
    if (field) {
      flushField()
      key = field[1].trim()
      buffer = [field[2]]
      lines.push(`${key}: ${field[2].trim()}`)
      continue
    }
    if (key) {
      buffer.push(line.trim())
      lines.push(line.trim())
    }
  }
  flushEntry()
  return db
}

const ensure = (map: Map<number, StilFields>, song: number): StilFields => {
  let fields = map.get(song)
  if (!fields) {
    fields = {}
    map.set(song, fields)
  }
  return fields
}

/** The commentary for one subsong, falling back to the tune's own fields. */
export const stilFor = (entry: StilEntry | undefined, subsong: number): StilFields => {
  if (!entry) return {}
  const own = entry.subsongs.get(subsong)
  if (!own) return entry.tune
  return { ...entry.tune, ...own }
}
