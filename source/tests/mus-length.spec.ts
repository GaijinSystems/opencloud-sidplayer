import { describe, it, expect } from 'vitest'
import { durationInQuarters, musLength, musVoiceSeconds, voiceSeconds } from '../src/sid/musLength'

/**
 * Durations are quarter notes; one quarter note lasts `tempo / 240` seconds,
 * so a TEM operand of 240 makes a quarter note exactly one second and the
 * arithmetic below readable.
 */
const SECOND = 240
const TEM = (operand: number) => [0x06, operand]
const HLT = [0x01, 0x4f]
const TAL = [0x01, 0x0f]
const END = [0x01, 0x2f]
const HED = (times: number) => [0x36, times]
const DEF = (id: number) => [0x01, (id << 4) | 0x06]
const CAL = (id: number) => [0x01, (id << 4) | 0x02]
/** A note of the given duration byte; the pitch byte is a middle C. */
const NOTE = (duration: number) => [duration, 0x99]

const QUARTER = 0x10
const WHOLE = 0x08
const EIGHTH = 0x14

const bytes = (...parts: number[][]) => parts.flat()
const voice = (...parts: number[][]) => Uint8Array.from(parts.flat())

/** A whole MUS file from three voices, with no credits. */
function file(v1: number[], v2: number[] = [...HLT], v3: number[] = [...HLT]): Uint8Array {
  const head = [
    0x00,
    0x09,
    v1.length & 0xff,
    v1.length >> 8,
    v2.length & 0xff,
    v2.length >> 8,
    v3.length & 0xff,
    v3.length >> 8
  ]
  return Uint8Array.from([...head, ...v1, ...v2, ...v3, 0x00])
}

describe('note durations', () => {
  it('reads the seven note values as quarter notes', () => {
    expect(durationInQuarters(0x08)).toBe(4) // whole
    expect(durationInQuarters(0x0c)).toBe(2) // half
    expect(durationInQuarters(0x10)).toBe(1) // quarter
    expect(durationInQuarters(0x14)).toBe(1 / 2)
    expect(durationInQuarters(0x18)).toBe(1 / 4)
    expect(durationInQuarters(0x1c)).toBe(1 / 8)
  })

  it('needs a bit above the value to say 64th, since hex 00 is absolute pitch', () => {
    // Spec B spells a 64th `...0 0000`, and plain 0x00 is taken by Absolute
    // Pitch on the line above it, so the shortest note always carries a tie
    // or a dot bit as well.
    expect(durationInQuarters(0x00)).toBeNull()
    expect(durationInQuarters(0x20)).toBe(1 / 16)
    expect(durationInQuarters(0x40)).toBe(1 / 16)
  })

  it('lengthens a dotted note by half and a double-dotted one by three quarters', () => {
    expect(durationInQuarters(0x10 | 0x20)).toBe(1.5)
    expect(durationInQuarters(0x10 | 0xa0)).toBe(1.75)
  })

  it('shortens a triplet to two thirds', () => {
    expect(durationInQuarters(0x10 | 0x80)).toBeCloseTo(2 / 3, 10)
  })

  it('has a separate encoding for a triplet 64th', () => {
    expect(durationInQuarters(0xa0)).toBeCloseTo((1 / 16) * (2 / 3), 10)
  })

  it('does not lengthen a 64th for a dot bit, which the 64th line precedes', () => {
    expect(durationInQuarters(0x20)).toBe(1 / 16)
    expect(durationInQuarters(0xa0)).not.toBe((1 / 16) * 1.75)
  })

  it('counts a tied note for its full duration', () => {
    // A tie joins it to the next note; the time still passes.
    expect(durationInQuarters(0x10 | 0x40)).toBe(1)
  })

  it('gives no duration to anything that is not a note', () => {
    expect(durationInQuarters(0x01)).toBeNull() // command
    expect(durationInQuarters(0x36)).toBeNull() // command
    expect(durationInQuarters(0x00)).toBeNull() // absolute pitch
    expect(durationInQuarters(0x04)).toBeNull() // utility duration
    expect(durationInQuarters(0x24)).toBeNull() // utility voice
  })
})

describe('tempo', () => {
  it('makes a quarter note the operand divided by 240 seconds', () => {
    expect(voiceSeconds(voice(TEM(SECOND), NOTE(QUARTER), HLT))).toBeCloseTo(1, 6)
    expect(voiceSeconds(voice(TEM(120), NOTE(QUARTER), HLT))).toBeCloseTo(0.5, 6)
  })

  it('reads an operand of zero as 256', () => {
    expect(voiceSeconds(voice(TEM(0), NOTE(QUARTER), HLT))).toBeCloseTo(256 / 240, 6)
  })

  it('applies a change from where it appears, not to the whole voice', () => {
    const v = voice(TEM(SECOND), NOTE(QUARTER), TEM(SECOND / 2), NOTE(QUARTER), HLT)
    expect(voiceSeconds(v)).toBeCloseTo(1.5, 6)
  })

  it('uses the assumed tempo until the voice sets one', () => {
    expect(voiceSeconds(voice(NOTE(QUARTER), HLT), { tempo: SECOND })).toBeCloseTo(1, 6)
  })
})

describe('the shape of a voice', () => {
  it('stops at HLT and ignores whatever follows', () => {
    const v = voice(TEM(SECOND), NOTE(QUARTER), HLT, NOTE(WHOLE), NOTE(WHOLE))
    expect(voiceSeconds(v)).toBeCloseTo(1, 6)
  })

  it('is zero for a voice that is nothing but HLT', () => {
    expect(voiceSeconds(voice(HLT))).toBe(0)
  })

  it('ignores commands that take no time', () => {
    const v = voice(TEM(SECOND), [0x01, 0x1b], [0x16, 0x40], NOTE(QUARTER), HLT)
    expect(voiceSeconds(v)).toBeCloseTo(1, 6)
  })
})

describe('repeats', () => {
  const section = voice(TEM(SECOND), HED(3), NOTE(QUARTER), TAL, HLT)

  it('plays the section the count of times, which is what measuring said', () => {
    expect(voiceSeconds(section)).toBeCloseTo(3, 6)
  })

  it('can be told the count means that many times again instead', () => {
    expect(voiceSeconds(section, { repeatIsTotal: false })).toBeCloseTo(4, 6)
  })

  it('re-walks the section rather than multiplying it', () => {
    /*
     * The tempo halves inside the loop, so the second pass is quicker than
     * the first: 1 + 0.5, not 1 + 1 or 0.5 + 0.5.
     */
    const v = voice(TEM(SECOND), HED(2), NOTE(QUARTER), TEM(SECOND / 2), TAL, HLT)
    expect(voiceSeconds(v)).toBeCloseTo(1.5, 6)
  })

  it('ignores a HED with no TAL after it', () => {
    const v = voice(TEM(SECOND), HED(9), NOTE(QUARTER), HLT)
    expect(voiceSeconds(v)).toBeCloseTo(1, 6)
  })
})

describe('phrases', () => {
  it('plays a phrase where it is defined', () => {
    const v = voice(TEM(SECOND), DEF(0), NOTE(QUARTER), END, HLT)
    expect(voiceSeconds(v)).toBeCloseTo(1, 6)
  })

  it('plays it again wherever it is called', () => {
    const v = voice(TEM(SECOND), DEF(0), NOTE(QUARTER), END, CAL(0), CAL(0), HLT)
    expect(voiceSeconds(v)).toBeCloseTo(3, 6)
  })

  it('keeps phrases apart by number', () => {
    const v = voice(TEM(SECOND), DEF(0), NOTE(QUARTER), END, DEF(1), NOTE(WHOLE), END, CAL(1), HLT)
    expect(voiceSeconds(v)).toBeCloseTo(1 + 4 + 4, 6)
  })

  it('takes no time for a call to a phrase that was never defined', () => {
    const v = voice(TEM(SECOND), CAL(7), NOTE(QUARTER), HLT)
    expect(voiceSeconds(v)).toBeCloseTo(1, 6)
  })

  it('reads the 16-to-23 range, which is encoded eight less with bit 7 set', () => {
    const def16 = [0x01, ((16 - 16 + 8) << 4) | 0x03]
    const cal16 = [0x01, ((16 - 16 + 8) << 4) | 0x0b]
    const v = voice(TEM(SECOND), def16, NOTE(QUARTER), END, cal16, HLT)
    expect(voiceSeconds(v)).toBeCloseTo(2, 6)
  })

  it('does not run away on a phrase that calls itself', () => {
    const v = voice(TEM(SECOND), DEF(0), NOTE(QUARTER), CAL(0), END, HLT)
    const seconds = voiceSeconds(v)
    expect(Number.isFinite(seconds)).toBe(true)
    expect(seconds).toBeLessThan(60)
  })
})

describe('a whole file', () => {
  const tune = file(
    bytes(TEM(SECOND), NOTE(QUARTER), HLT),
    bytes(TEM(SECOND), NOTE(WHOLE), HLT),
    bytes(TEM(SECOND), NOTE(EIGHTH), HLT)
  )

  it('reports each voice separately', () => {
    expect(musVoiceSeconds(tune)?.map((n) => Math.round(n * 100) / 100)).toEqual([1, 4, 0.5])
  })

  /*
   * Voice one is the lead and is the better predictor of when the sound
   * stops; the other two are often padded with rests past the end of it.
   * Measured over 40 tunes against the engine: 1.1% median error against
   * 3.0% for the longest voice.
   */
  it('is as long as its first voice', () => {
    expect(musLength(tune)).toBeCloseTo(1, 6)
  })

  it('refuses anything too short to hold a header', () => {
    expect(musLength(new Uint8Array([0, 9, 2, 0]))).toBeNull()
    expect(musLength(new Uint8Array(0))).toBeNull()
  })

  /*
   * The step limit has to count calls, not just the commands walked. A
   * repeat of nothing costs no command at all, so eighteen nested `HED 255`
   * with nothing at the bottom made a quarter of a billion calls under a
   * limit that saw a few million - seconds of a frozen tab, from a file of
   * eighty bytes, on merely selecting it in the library.
   */
  it('gives up quickly on repeats nested around nothing', () => {
    const nest = 18
    const v1 = bytes(
      ...Array.from({ length: nest }, () => HED(255)),
      ...Array.from({ length: nest }, () => TAL),
      HLT
    )
    const started = performance.now()
    musLength(file(v1))
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('refuses a file whose voice lengths run past its end', () => {
    const bytes = Uint8Array.from([0x00, 0x09, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x01, 0x4f])
    expect(musLength(bytes)).toBeNull()
  })
})
