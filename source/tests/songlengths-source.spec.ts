import { describe, it, expect, vi, afterEach } from 'vitest'
import type { Resource, SpaceResource } from '@opencloud-eu/web-client'
import { md5Hex } from '../src/sid/md5'
import { SonglengthsSource } from '../src/sid/songlengthsSource'
import type { WebDav } from '../src/sid/source'

/**
 * Where a tune's lengths come from: the nearest Songlengths.md5 in the space
 * that lists it, then the instance-wide one - and a read that failed is not
 * taken as there being no database at all.
 */
const space = { id: 's' } as SpaceResource
const tune = new Uint8Array([1, 2, 3, 4])
const other = new Uint8Array([9, 9, 9])
const resource = { path: '/C64Music/MUSICIANS/A/Tune.sid', name: 'Tune.sid' } as Resource
const listing = (bytes: Uint8Array, length: string) =>
  `[Database]\n; /MUSICIANS/A/Tune.sid\n${md5Hex(bytes)}=${length}\n`

/** A space holding these files; anything else is a 404, unless `fail` says otherwise. */
function spaceWith(files: Record<string, string>, fail: (path: string) => unknown = () => null) {
  const getFileContents = vi.fn(async (_space: SpaceResource, { path }: { path: string }) => {
    const thrown = fail(path)
    if (thrown) throw thrown
    if (path in files) return { body: files[path] }
    throw { statusCode: 404 }
  })
  const getFileInfo = vi.fn(async (_space: SpaceResource, { path }: { path: string }) => {
    const thrown = fail(path)
    if (thrown) throw thrown
    if (path in files) return { path, size: files[path].length }
    throw { statusCode: 404 }
  })
  return { webdav: { getFileContents, getFileInfo } as unknown as WebDav, getFileContents, getFileInfo }
}

afterEach(() => vi.unstubAllGlobals())

describe('looking up a tune', () => {
  it('passes over a nearer database that does not list the tune', async () => {
    const { webdav } = spaceWith({
      '/C64Music/MUSICIANS/A/Songlengths.md5': listing(other, '1:00'),
      '/C64Music/DOCUMENTS/Songlengths.md5': listing(tune, '3:30')
    })
    const entry = await new SonglengthsSource(webdav, null).lookup(space, resource, tune)
    expect(entry?.lengths).toEqual([210])
  })

  it('goes on to the configured database when nothing in the space lists the tune', async () => {
    vi.stubGlobal('fetch', async () => new Response(listing(tune, '2:00')))
    const { webdav } = spaceWith({ '/C64Music/DOCUMENTS/Songlengths.md5': listing(other, '1:00') })
    const entry = await new SonglengthsSource(webdav, '/songlengths.md5').lookup(space, resource, tune)
    expect(entry?.lengths).toEqual([120])
  })

  /*
   * One bad minute - an expired token, a 503 - used to be kept as "no
   * database here" for the rest of the page, and every tune played for the
   * default length until a reload.
   */
  it('asks again after a read that failed, rather than remembering it as nothing', async () => {
    let down = true
    const { webdav } = spaceWith({ '/C64Music/DOCUMENTS/Songlengths.md5': listing(tune, '3:30') }, () =>
      down ? { statusCode: 503 } : null
    )
    const source = new SonglengthsSource(webdav, null)
    expect(await source.lookup(space, resource, tune)).toBeNull()
    down = false
    expect((await source.lookup(space, resource, tune))?.lengths).toEqual([210])
  })

  /*
   * A server that ignores Range sent a file by that name whole, whatever its
   * size, and each level up the tree may have one.
   */
  it('does not fetch a file too large to be a database', async () => {
    const huge = `${listing(tune, '9:99')}${' '.repeat(33 * 1024 * 1024)}`
    const deep = { path: '/A/B/C/D/E/F/Tune.sid', name: 'Tune.sid' } as Resource
    const files: Record<string, string> = {}
    for (const dir of ['/A/B/C/D/E/F', '/A/B/C/D/E', '/A/B/C/D', '/A/B/C', '/A/B', '/A']) {
      files[`${dir}/Songlengths.md5`] = huge
    }
    const { webdav, getFileContents } = spaceWith(files)
    expect(await new SonglengthsSource(webdav, null).lookup(space, deep, tune)).toBeNull()
    expect(getFileContents).not.toHaveBeenCalled()
  })

  it('remembers a file that is not there, and does not ask for it again', async () => {
    const { webdav, getFileInfo } = spaceWith({})
    const source = new SonglengthsSource(webdav, null)
    await source.lookup(space, resource, tune)
    const asked = getFileInfo.mock.calls.length
    expect(asked).toBeGreaterThan(0)
    await source.lookup(space, resource, tune)
    expect(getFileInfo.mock.calls.length).toBe(asked)
  })
})
