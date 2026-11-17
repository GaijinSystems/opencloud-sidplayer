import { describe, it, expect } from 'vitest'
import { createMirror, MIRROR_MAX_BYTES, MIRROR_TUNE_MAX_BYTES } from '../src/hvsc/mirror'

/**
 * What the mirror client will take back. The route reaches a third party's
 * server through a proxy, so what arrives is not trusted to be the size of
 * any file the collection could hold.
 */
describe('reading from the mirror', () => {
  const answering = (response: () => Response) =>
    createMirror('/hvsc-mirror', (async () => response()) as typeof fetch)

  it('takes a file of a sensible size', async () => {
    const mirror = answering(() => new Response(new Uint8Array(4096)))
    expect((await mirror.tune('/MUSICIANS/A/B/C.sid')).byteLength).toBe(4096)
  })

  it('refuses a body that says it is larger than any file in the collection', async () => {
    const mirror = answering(
      () => new Response('small', { headers: { 'content-length': String(MIRROR_MAX_BYTES + 1) } })
    )
    await expect(mirror.tune('/MUSICIANS/A/B/C.sid')).rejects.toThrow(/larger than any file/)
  })

  /* A tune is held to far less than a document is; both come by the same call. */
  it("holds a tune to a tune's size, and lets a document through at a document's", async () => {
    const mirror = answering(() => new Response(new Uint8Array(MIRROR_TUNE_MAX_BYTES + 1)))
    await expect(mirror.tune('/MUSICIANS/A/B/C.sid')).rejects.toThrow(/larger than any file/)
    expect((await mirror.tune('/DOCUMENTS/STIL.txt')).byteLength).toBe(MIRROR_TUNE_MAX_BYTES + 1)
  })

  it('does not follow the mirror anywhere else', async () => {
    const asked: RequestInit[] = []
    const mirror = createMirror('/hvsc-mirror', (async (_url: string, init: RequestInit) => {
      asked.push(init)
      return new Response('x')
    }) as typeof fetch)
    await mirror.tune('/MUSICIANS/A/B/C.sid')
    expect(asked[0].redirect).toBe('error')
  })

  /*
   * And one that does not say: read as it arrives and stopped at the limit,
   * not held in memory to the end of an upstream that may have none.
   */
  it('stops reading a body with no length once it passes the limit', async () => {
    let sent = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1024 * 1024
        controller.enqueue(new Uint8Array(1024 * 1024))
      }
    })
    const mirror = answering(() => new Response(endless))
    await expect(mirror.document('Songlengths.md5')).rejects.toThrow(/larger than any file/)
    expect(sent).toBeLessThanOrEqual(MIRROR_MAX_BYTES + 2 * 1024 * 1024)
  })
})
