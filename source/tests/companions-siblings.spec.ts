import { describe, it, expect, vi } from 'vitest'
import type { Resource, SpaceResource } from '@opencloud-eu/web-client'
import { findCompanions } from '../src/sid/companions'
import type { WebDav } from '../src/sid/source'
import { resourceAt } from './helpers/fakes'

/**
 * The folder listing behind a Sidplayer tune's family. These files have been
 * through enough filesystems to have lost their case and to have arrived with
 * a picture from the separate add-on merged in beside them, which is why the
 * matching is on the lower-cased base name and why more than one picture
 * extension can turn up for the same tune.
 */

const file = (path: string, id = path): Resource => resourceAt(path, { id, type: 'file' })

const folder = (path: string): Resource => resourceAt(path, { type: 'folder' })

function fakeWebdav(children: Resource[] | Error) {
  const listFiles = vi.fn(async (_space: SpaceResource, options: { path: string }) => {
    void options
    if (children instanceof Error) throw children
    return { children }
  })
  return { webdav: { listFiles } as unknown as WebDav, listFiles }
}

const space = {} as SpaceResource

describe('findCompanions', () => {
  it('lists the tune’s own folder once and matches on the base name, whatever the case', async () => {
    const { webdav, listFiles } = fakeWebdav([
      file('/Music/Ode/TUNE.STR'),
      file('/Music/Ode/tune.wds'),
      file('/Music/Ode/Other.str'),
      folder('/Music/Ode/tune')
    ])
    const found = await findCompanions(webdav, space, file('/Music/Ode/Tune.mus'))
    expect(listFiles).toHaveBeenCalledTimes(1)
    expect(listFiles.mock.calls[0][1]).toEqual({ path: '/Music/Ode' })
    expect(found.str?.name).toBe('TUNE.STR')
    expect(found.wds?.name).toBe('tune.wds')
    expect(found.mus).toBeUndefined()
  })

  it('finds the .mus behind a .str, and never returns the clicked file itself', async () => {
    const clicked = file('/Music/Tune.str', 'clicked')
    const { webdav } = fakeWebdav([file('/Music/Tune.mus'), clicked])
    const found = await findCompanions(webdav, space, clicked)
    expect(found.mus?.name).toBe('Tune.mus')
    expect(found.str).toBeUndefined()
  })

  it('prefers the whole .pic over a packed .pgg, whichever comes first', async () => {
    const both = [file('/Music/Tune.pgg'), file('/Music/Tune.pic')]
    for (const children of [both, [...both].reverse()]) {
      const { webdav } = fakeWebdav(children)
      const found = await findCompanions(webdav, space, file('/Music/Tune.mus'))
      // Unpacking is work that need not be done when the whole bitmap is there.
      expect(found.picture?.name).toBe('Tune.pic')
    }
  })

  it('takes a .pjj when that is the only picture', async () => {
    const { webdav } = fakeWebdav([file('/Music/Tune.pjj'), file('/Music/Tune.ani')])
    const found = await findCompanions(webdav, space, file('/Music/Tune.mus'))
    expect(found.picture?.name).toBe('Tune.pjj')
  })

  it('yields no companions when the folder cannot be listed', async () => {
    // A public link without listing rights, say: the clicked file alone may
    // still be playable, so this is not an error the user is shown.
    const { webdav } = fakeWebdav(new Error('403'))
    await expect(findCompanions(webdav, space, file('/Music/Tune.mus'))).resolves.toEqual({})
  })

  it('does not list anything for a file with no name', async () => {
    const { webdav, listFiles } = fakeWebdav([file('/Music/Tune.mus')])
    expect(await findCompanions(webdav, space, {} as Resource)).toEqual({})
    expect(listFiles).not.toHaveBeenCalled()
  })

  it('looks in the root for a file that sits there', async () => {
    const { webdav, listFiles } = fakeWebdav([file('/Tune.str')])
    const found = await findCompanions(webdav, space, file('/Tune.mus'))
    expect(listFiles.mock.calls[0][1]).toEqual({ path: '/' })
    expect(found.str?.name).toBe('Tune.str')
  })
})
