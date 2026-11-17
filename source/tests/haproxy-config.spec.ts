import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The browser tests' proxy is a hand copy of the route an operator is told
 * to install, with the upstream swapped for the local mirror. A rule added to
 * one and not the other would leave the tests proving a route nobody runs,
 * so the two are compared here, directive for directive.
 */
const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
const DEPLOY = '../../deploy/haproxy-hvsc.cfg'
const RIG = '../e2e/haproxy.cfg'

/** The directives of one section, without comments, blank lines or indentation. */
function section(text: string, header: string): string[] {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.trim() === header)
  if (start < 0) return []
  const out: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break
    const directive = line.trim()
    if (directive && !directive.startsWith('#')) out.push(directive)
  }
  return out
}

/** Lines only one of the two may have: where it connects, and how. */
const local = (directive: string): boolean =>
  directive.startsWith('server ') ||
  directive.startsWith('http-request set-header Host ') ||
  directive === 'mode http'

describe.runIf(existsSync(fileURLToPath(new URL(DEPLOY, import.meta.url))))('the browser tests’ proxy', () => {
  it('has the deployed backend, rule for rule', () => {
    const deployed = section(read(DEPLOY), 'backend be_hvsc_mirror').filter((d) => !local(d))
    const rig = section(read(RIG), 'backend be_hvsc_mirror').filter((d) => !local(d))
    expect(deployed.length).toBeGreaterThan(10)
    expect(rig).toEqual(deployed)
  })

  it('has the frontend rules the operator is told to add', () => {
    // In the deployed file those are commented out, to be pasted: one `#`
    // and indentation. A second `#` is commentary, or the alternative to
    // the normalisation, which the rig does not use.
    const told = read(DEPLOY)
      .split('\n')
      .filter((line) => /^#\s{2,}[a-z]/.test(line))
      .map((line) => line.replace(/^#\s+/, '').trim())
      .filter((d) => d !== 'expose-experimental-directives')
    const rig = section(read(RIG), 'frontend fe_test').filter(
      (d) => !d.startsWith('bind ') && !d.startsWith('default_backend ')
    )
    expect(told.length).toBeGreaterThan(5)
    expect(rig).toEqual(told)
  })
})
