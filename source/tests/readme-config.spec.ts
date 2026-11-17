import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The README's configuration table is the operator's reference, and the
 * defaults it gives are the ones `defaults.json` holds. Written twice, they
 * are compared here: every setting has a row, and the row's default is the
 * real one.
 */
// Through a function, not `new URL('literal', import.meta.url)`: Vite rewrites
// that pattern into a served asset URL, which is not a file to read.
const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url))
const README = here('../../README.md')
const defaults = JSON.parse(readFileSync(here('../src/defaults.json'), 'utf8')) as Record<string, unknown>

describe.runIf(existsSync(README))('the README’s configuration table', () => {
  const rows = readFileSync(README, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('| `'))
    .map((line) => line.split('|').map((cell) => cell.trim()))

  it('has a row for every setting, with its default', () => {
    for (const [key, value] of Object.entries(defaults)) {
      const row = rows.find((cells) => cells[1].split(', ').includes(`\`${key}\``))
      expect(row, key).toBeDefined()
      const shown = row![2]
      if (shown === 'written by the build') continue
      expect(shown, key).toBe(`\`${value === null ? 'null' : String(value)}\``)
    }
  })
})
