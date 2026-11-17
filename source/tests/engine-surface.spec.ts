import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The engine's surface is written down in three places: the C functions in
 * `shim.cpp`, which `build.sh` reads its export list from, the calls
 * `engine.js` makes, and the defaults `DetailPane.vue` reports. The binary
 * reports none of this at run time, so they are held to each other here.
 */
const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
const shim = read('../engine/shim.cpp')
const build = read('../engine/build.sh')
const glue = read('../public/vendor/sid-engine/engine.js')
const pane = read('../src/library/DetailPane.vue')

// What build.sh exports: every `sid_*` function shim.cpp defines at the start
// of a line, found the way its grep finds them.
const defined = new Set([...shim.matchAll(/^[A-Za-z_][A-Za-z0-9_ *]*[ *](sid_[a-z_]+)\(/gm)].map((m) => m[1]))
const called = new Set([...glue.matchAll(/\b(sid_\w+)\(/g)].map((m) => m[1]))

describe('the engine surface', () => {
  it('exports every function the glue calls', () => {
    expect(build).toMatch(/SHIM_FUNCTIONS=.*shim\.cpp/)
    expect(called.size).toBeGreaterThan(5)
    for (const name of called) expect(defined, name).toContain(name)
  })

  it('reports the defaults the shim actually sets', () => {
    const chip = /defaultSidModel = SidConfig::MOS(\d{4});/.exec(shim)?.[1]
    const machine = /defaultC64Model = SidConfig::(PAL|NTSC);/.exec(shim)?.[1]
    expect(pane).toContain(`const ENGINE_DEFAULT_CHIP = '${chip}'`)
    expect(pane).toContain(`const ENGINE_DEFAULT_MACHINE = '${machine?.toLowerCase()}'`)
  })
})
