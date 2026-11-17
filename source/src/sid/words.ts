import { readPetsciiLine } from './petscii'

/**
 * Sidplayer "words" (.wds): lyrics shown by the Enhanced Sidplayer in time
 * with the music.
 *
 * Best effort, and labelled as such in the UI. The timing side of the format
 * is not documented anywhere this app's authors could find, and libsidplayfp
 * does not read these files at all, so this extracts the text and nothing
 * else: a two-byte load address is skipped, lines end at NUL or return,
 * PETSCII is converted the way MUS credits are, and control bytes and the
 * blank runs between pages are dropped. Enough to read along; not enough to
 * follow the bouncing ball.
 */

const MAX_LINES = 500

export function parseWords(bytes: Uint8Array): string[] {
  if (bytes.length <= 2) return []
  const lines: string[] = []
  let i = 2
  while (i < bytes.length && lines.length < MAX_LINES) {
    // `readPetsciiLine` always advances past at least one byte while there is
    // one to read, so this cannot stand still.
    const { text, next } = readPetsciiLine(bytes, i, 80)
    i = next
    const trimmed = text.trim()
    if (trimmed) lines.push(trimmed)
    else if (lines.length && lines[lines.length - 1] !== '') lines.push('')
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines
}
