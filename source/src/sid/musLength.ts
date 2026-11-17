/**
 * How long a Compute!'s Sidplayer tune lasts, read from its own score.
 *
 * MUS carries no length database - the Compute's Gazette collection has
 * nothing like HVSC's `Songlengths.md5` - but it does not need one: a MUS
 * voice is a score, with note durations and a tempo, so the playing time is
 * there to be worked out. That matters because the alternative is treating
 * every tune as `defaultSongLengthSeconds`, and the real range across the
 * collection runs from about twenty seconds to nearly seven minutes.
 *
 * The format is read off `MUS_format_B.txt` by Dick Thornton, which ships in
 * the collection's own documents. The other spec in that folder,
 * `MUS_format_A.txt`, says up front that it was written "without any
 * reference to the book" and its duration masks contradict themselves - hex
 * 20 is listed as both DOTTED and 64TH - so it is not the one to follow.
 * Spec B's rule is what makes the stream walkable at all:
 *
 *   a note pair has 00 in the low two bits of its first byte;
 *   anything else is a command.
 *
 * Checked against all 16,601 tunes in release 1.47: every frequent first
 * byte is either one of spec B's durations or has low bits that mark it a
 * command.
 *
 * This is not a linear sum. 42.5% of the collection repeats sections with
 * HED/TAL and 68.8% calls phrases defined with DEF/END, so the stream has to
 * be interpreted, jumps and all.
 */

/** Quarter notes in one of each note value. */
const VALUES: Record<number, number> = {
  0x00: 1 / 16, // 64th
  0x08: 4, //     whole
  0x0c: 2, //     half
  0x10: 1, //     quarter
  0x14: 1 / 2, //  eighth
  0x18: 1 / 4, //  sixteenth
  0x1c: 1 / 8 //   thirty-second
}

/**
 * The tempo the driver starts at, before any TEM command.
 *
 * Measured, not guessed. Four tunes in the sample set no tempo anywhere in
 * any voice and all four came out short by the same factor, 1.202; 120 times
 * that is 144, so 144 it is - 100 quarter notes a minute. Getting this wrong
 * was the single largest source of error.
 */
const DEFAULT_TEMPO = 0x90

/** Stops a malformed or hostile file from walking forever. */
const MAX_STEPS = 4_000_000
/**
 * How deep HED and DEF nesting may go before the walk stops descending.
 *
 * Sixteen is a recursion guard and not a limit on real music: across all
 * 16,601 tunes in release 1.47, voice one nests at most six deep, and the
 * distribution stops dead there - 9,473 tunes reach depth 1, 533 reach 3,
 * one reaches 6. Exactly two files go deeper, both by a phrase that calls
 * itself: `Coyote/Hush_(BAD).mus`, which also exhausts `MAX_STEPS`, and
 * `Harry_Bratt/HB/Hop1.mus`. So the cut-off is reached only by scores that
 * have no finite length to report in the first place, which is why it goes
 * unreported rather than carrying a flag no caller could act on - see the
 * note on `musLength`.
 */
const MAX_DEPTH = 16

export interface MusLengthOptions {
  /** TEM operand assumed before the voice sets one. */
  tempo?: number
  /**
   * Whether `HED n` means the section plays n times altogether or n times
   * again after the first. Neither spec says. Measured against the engine
   * over 40 tunes, "altogether" wins - median error 1.1% against 2.2% - so
   * that is the default. See `scripts/verify-mus-length.mjs`.
   */
  repeatIsTotal?: boolean
  /**
   * Whether a phrase also sounds where it is defined, or only where it is
   * called. Spec A claims the former; it is the spec that gets other things
   * wrong, so this is measured rather than believed.
   */
  definePlays?: boolean
}

const HLT = 0x4f
const TAL = 0x0f
const END = 0x2f

/** A note pair's duration in quarter notes, or null when it takes no time. */
export function durationInQuarters(byte1: number): number | null {
  if ((byte1 & 3) !== 0) return null // a command, not a note
  if (byte1 === 0x00) return null // absolute pitch: sets pitch, takes no time
  // Spec B decodes downward, stopping at the first line marked `>`, so these
  // three special forms are tested before the ordinary durations.
  if ((byte1 & 0xbf) === 0xa0) return (1 / 16) * (2 / 3) // triplet 64th
  if ((byte1 & 0x3f) === 0x24) return null // utility voice
  if ((byte1 & 0x3f) === 0x04) return null // utility duration
  // Every value `byte1 & 0x1c` can take here is in the table: the low three
  // bits are 000 by now, which leaves the seven note values and 0x04, and
  // both forms of 0x04 are the utility commands returned above.
  const value = VALUES[byte1 & 0x1c]
  // A 64th is reached before the dot flags, so dots do not apply to it.
  if ((byte1 & 0x1c) === 0x00) return value
  const shape = byte1 & 0xa0
  if (shape === 0x20) return value * 1.5 // dotted
  if (shape === 0xa0) return value * 1.75 // double dotted
  if (shape === 0x80) return value * (2 / 3) // triplet
  return value
}

/**
 * Pairs every HED with its TAL and every DEF with its END, in one pass, so
 * the walk below knows where a section ends before it starts replaying it.
 */
function findSections(voice: Uint8Array): {
  tails: Map<number, number>
  bodies: Map<number, number>
  phrases: Map<number, { start: number; end: number }>
} {
  const tails = new Map<number, number>()
  const bodies = new Map<number, number>()
  const phrases = new Map<number, { start: number; end: number }>()
  const heads: number[] = []
  const defs: Array<{ at: number; id: number }> = []
  let id: number | null
  for (let i = 0; i + 1 < voice.length; i += 2) {
    const b1 = voice[i]
    const b2 = voice[i + 1]
    if (b1 === 0x36) {
      heads.push(i)
    } else if (b1 === 0x01 && b2 === TAL) {
      const head = heads.pop()
      if (head !== undefined) tails.set(head, i)
    } else if (b1 === 0x01 && (id = defineId(b2)) !== null) {
      defs.push({ at: i, id })
    } else if (b1 === 0x01 && b2 === END) {
      const def = defs.pop()
      if (def !== undefined) {
        bodies.set(def.at, i)
        phrases.set(def.id, { start: def.at + 2, end: i })
      }
    }
  }
  return { tails, bodies, phrases }
}

/** The phrase a DEF command defines, or null if this is not one. */
function defineId(byte2: number): number | null {
  if ((byte2 & 0x0f) === 0x06) return byte2 >> 4
  // The 16-23 range is encoded eight less than its true value, with bit 7 set.
  if ((byte2 & 0x0f) === 0x03 && (byte2 & 0x80) !== 0) return (byte2 >> 4) - 8 + 16
  return null
}

/** The phrase a CAL command plays, or null if this is not one. */
function callId(byte2: number): number | null {
  if ((byte2 & 0x0f) === 0x02) return byte2 >> 4
  if ((byte2 & 0x0f) === 0x0b && (byte2 & 0x80) !== 0) return (byte2 >> 4) - 8 + 16
  return null
}

/**
 * Plays one voice on paper and returns how many seconds it takes.
 *
 * Sections are re-walked rather than measured once and multiplied, because a
 * repeated section may change the tempo inside itself: the second time
 * through starts from a different tempo than the first, and the elapsed time
 * differs with it.
 */
export function voiceSeconds(voice: Uint8Array, options: MusLengthOptions = {}): number {
  const { tails, bodies, phrases } = findSections(voice)
  const repeats = options.repeatIsTotal ?? true
  const definePlays = options.definePlays ?? true
  let tempo = options.tempo ?? DEFAULT_TEMPO
  let seconds = 0
  let steps = 0
  let halted = false

  /** One quarter note, in seconds: the TEM operand divided by 240. */
  const quarter = (): number => tempo / 240

  const run = (from: number, to: number, depth: number): void => {
    // Every call counts, before anything else: a repeat of nothing, or one
    // past the depth limit, walks no commands and so would otherwise cost
    // nothing however many times it is made.
    if (++steps > MAX_STEPS || depth > MAX_DEPTH) return
    for (let i = from; i + 1 < to; i += 2) {
      if (halted || ++steps > MAX_STEPS) return
      const b1 = voice[i]
      const b2 = voice[i + 1]

      if (b1 === 0x01) {
        if (b2 === HLT) {
          halted = true
          return
        }
        if (b2 === END || b2 === TAL) continue
        const call = callId(b2)
        if (call !== null) {
          const phrase = phrases.get(call)
          if (phrase) run(phrase.start, phrase.end, depth + 1)
          continue
        }
        const define = defineId(b2)
        if (define !== null) {
          // A phrase plays where it is defined as well as where it is called.
          const end = bodies.get(i)
          if (end !== undefined) {
            if (definePlays) run(i + 2, end, depth + 1)
            i = end
          }
        }
        continue
      }

      if (b1 === 0x06) {
        tempo = b2 === 0 ? 256 : b2
        continue
      }

      if (b1 === 0x36) {
        const tail = tails.get(i)
        if (tail === undefined) continue
        const times = repeats ? Math.max(1, b2) : b2 + 1
        for (let n = 0; n < times && !halted; n++) run(i + 2, tail, depth + 1)
        i = tail
        continue
      }

      const quarters = durationInQuarters(b1)
      if (quarters !== null) seconds += quarters * quarter()
    }
  }

  run(0, voice.length, 0)
  return seconds
}

/**
 * The voice-length table: where each of the three voices sits, relative to
 * `offset`, or null where the lengths it declares run past the end of the
 * file. The lengths are two unsigned bytes each, so they cannot be negative;
 * that they fit is the whole test. The one reading of the table, for the
 * detector in `mus.ts` and the estimate here; it lives here because this
 * file imports nothing, which is what lets `verify-mus-length.mjs` load it
 * with Node's type stripping alone.
 */
export function musVoiceTable(bytes: Uint8Array, offset = 0): Array<{ at: number; length: number }> | null {
  const len = bytes.length - offset
  if (len < 8) return null
  const le16 = (at: number) => bytes[offset + at] | (bytes[offset + at + 1] << 8)
  const voices: Array<{ at: number; length: number }> = []
  let at = 8
  for (const field of [2, 4, 6]) {
    const length = le16(field)
    voices.push({ at, length })
    at += length
  }
  return at > len ? null : voices
}

/**
 * Each of the three voices, in seconds, in file order.
 *
 * Returns null for anything that is not a MUS file. `musLength` does not use
 * this: it needs voice one only, and interpreting the other two costs up to
 * `MAX_STEPS` each for a file that never plays.
 */
export function musVoiceSeconds(bytes: Uint8Array, options: MusLengthOptions = {}): number[] | null {
  const voices = musVoiceTable(bytes)
  return voices ? voices.map((v) => voiceSeconds(bytes.subarray(v.at, v.at + v.length), options)) : null
}

/**
 * How long the tune plays, in seconds, or null if this is not a MUS file.
 *
 * Voice one, not the longest of the three: it is the lead, and the other two
 * are often padded with rests past the end of it. Measured against the
 * engine, voice one is the better predictor - median error 1.1% over the 40
 * tunes the constants were fitted on, 3.7% over a fresh sixteen.
 *
 * **This is an estimate and is for showing people, not for stopping on.**
 * Three of those fresh sixteen were out by more than 15% and one by more
 * than half, in both directions, so a player that stopped here would clip
 * tunes. `useSidPlayer` ends a Sidplayer tune when the output falls silent
 * and uses this only for the figure on the clock.
 *
 * Because it is a figure on a clock, the walk's two budgets are allowed to
 * cut it short without saying so: a score that exhausts `MAX_STEPS` or
 * `MAX_DEPTH` comes back short rather than not at all. The measurement
 * behind `MAX_DEPTH` says which files those are - two in 16,601, both
 * recursive and neither with a real length - and a run away with the step
 * budget is already not a length anyone should trust. Only voice one is
 * interpreted, so the worst case is one budget rather than three.
 */
export function musLength(bytes: Uint8Array, options: MusLengthOptions = {}): number | null {
  const voices = musVoiceTable(bytes)
  if (!voices) return null
  const lead = voices[0]
  return voiceSeconds(bytes.subarray(lead.at, lead.at + lead.length), options)
}
