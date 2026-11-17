import { describe, it, expect, vi } from 'vitest'
import type { Resource, SpaceResource } from '@opencloud-eu/web-client'
import { parentFolder, readResourceBytes, type WebDav } from '../src/sid/source'
import { SidPlayerError } from '../src/sid/types'
import { resourceAt } from './helpers/fakes'

/**
 * Reading a file through the shell's own WebDAV client. SID files are a few
 * kilobytes; the care taken here is over size, over the shapes a client can
 * hand back a body in, and over saying which of them failed.
 */

const space = {} as SpaceResource
const resource = (over: Record<string, unknown> = {}): Resource =>
  resourceAt('/M/Tune.sid', { id: 'x', size: 100, ...over })

function fakeWebdav(answer: unknown | (() => never)) {
  const getFileContents = vi.fn(async (_space: SpaceResource, ref: unknown, _options?: unknown) => {
    void ref
    if (typeof answer === 'function') (answer as () => never)()
    return { body: answer }
  })
  return { webdav: { getFileContents } as unknown as WebDav, getFileContents }
}

describe('readResourceBytes', () => {
  it('takes an ArrayBuffer body, and asks by path when the resource has one', async () => {
    const { webdav, getFileContents } = fakeWebdav(Uint8Array.from([1, 2, 3]).buffer)
    expect([...(await readResourceBytes(webdav, space, resource(), 1000))]).toEqual([1, 2, 3])
    expect(getFileContents.mock.calls[0][1]).toEqual({ path: '/M/Tune.sid' })
  })

  it('asks by file id when there is no path, as the Files list gives it', async () => {
    const { webdav, getFileContents } = fakeWebdav(new ArrayBuffer(0))
    await readResourceBytes(webdav, space, resource({ path: undefined, fileId: 'abc' }), 1000)
    expect(getFileContents.mock.calls[0][1]).toEqual({ fileId: 'abc' })
  })

  it('takes a Uint8Array or a binary string body, which clients differ over', async () => {
    const asBytes = fakeWebdav(Uint8Array.from([9, 8]))
    expect([...(await readResourceBytes(asBytes.webdav, space, resource(), 1000))]).toEqual([9, 8])
    const asString = fakeWebdav(String.fromCharCode(1, 255))
    expect([...(await readResourceBytes(asString.webdav, space, resource(), 1000))]).toEqual([1, 255])
  })

  it('refuses a file the server says is too big without fetching it', async () => {
    const { webdav, getFileContents } = fakeWebdav(new ArrayBuffer(0))
    await expect(readResourceBytes(webdav, space, resource({ size: 2000 }), 1000)).rejects.toMatchObject({
      code: 'too-large'
    })
    expect(getFileContents).not.toHaveBeenCalled()
  })

  /*
   * A resource the library builds from a catalogue row carries no size, so
   * the check above never fired and the whole body was downloaded before it
   * could be refused. Asking for one byte more than the limit settles it
   * either way with no more than that on the wire.
   */
  it('asks for no more than the limit when the size is not known', async () => {
    const { webdav, getFileContents } = fakeWebdav(new ArrayBuffer(10))
    await readResourceBytes(webdav, space, resource({ size: undefined }), 1000)
    expect(getFileContents.mock.calls[0][2]).toMatchObject({ headers: { Range: 'bytes=0-1000' } })
  })

  it('reads an empty file as empty, where a range cannot be satisfied', async () => {
    const { webdav } = fakeWebdav(() => {
      throw { statusCode: 416 }
    })
    expect((await readResourceBytes(webdav, space, resource({ size: undefined }), 1000)).byteLength).toBe(0)
  })

  it('refuses a body that arrives too big anyway', async () => {
    // A server that omits Content-Length still must not exhaust memory.
    const { webdav } = fakeWebdav(new ArrayBuffer(2000))
    await expect(readResourceBytes(webdav, space, resource({ size: 0 }), 1000)).rejects.toMatchObject({
      code: 'too-large'
    })
  })

  it('reports the HTTP status when the fetch fails, from either place it sits', async () => {
    const withStatusCode = fakeWebdav(() => {
      throw Object.assign(new Error('nope'), { statusCode: 404 })
    })
    await expect(readResourceBytes(withStatusCode.webdav, space, resource(), 1000)).rejects.toThrowError(
      /HTTP 404/
    )

    const withResponse = fakeWebdav(() => {
      throw { response: { status: 503 } }
    })
    await expect(readResourceBytes(withResponse.webdav, space, resource(), 1000)).rejects.toThrowError(
      /HTTP 503/
    )

    const bare = fakeWebdav(() => {
      throw new Error('offline')
    })
    const failure: unknown = await readResourceBytes(bare.webdav, space, resource(), 1000).catch((e) => e)
    expect(failure).toBeInstanceOf(SidPlayerError)
    expect((failure as SidPlayerError).code).toBe('network')
    expect((failure as SidPlayerError).message).toBe('The file could not be fetched.')
  })

  it('says so when the body is a shape it cannot read', async () => {
    const { webdav } = fakeWebdav({ unexpected: true })
    await expect(readResourceBytes(webdav, space, resource(), 1000)).rejects.toThrowError(/cannot read/)
  })
})

describe('parentFolder', () => {
  it('gives the folder a path sits in, and the root for anything at the top', () => {
    expect(parentFolder('/MUSICIANS/H/Hubbard_Rob/Commando.sid')).toBe('/MUSICIANS/H/Hubbard_Rob')
    expect(parentFolder('/Tune.mus')).toBe('/')
    expect(parentFolder('Tune.mus')).toBe('/')
    expect(parentFolder('')).toBe('/')
  })
})
