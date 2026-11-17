import type { Resource, SpaceResource } from '@opencloud-eu/web-client'
import { extensionOf, stripExtension } from './names'
import { PICTURE_EXTENSIONS } from './picture'
import { parentFolder, type WebDav } from './source'

/**
 * Sidplayer tunes come as up to three files sharing a base name: `Tune.mus`,
 * `Tune.str`, `Tune.wds`. Whichever the user clicks, the others are looked
 * for in the same folder, case-insensitively, since these files have been
 * through enough filesystems to have lost their case somewhere.
 *
 * A picture may sit beside them as well. The collection ships those in a
 * separate download whose folders mirror the music's, so they are only here
 * if someone has merged the two - which is the arrangement this looks for.
 */

export interface Companions {
  mus?: Resource
  str?: Resource
  wds?: Resource
  /** A `.pic`, `.pgg` or `.pjj` for this tune, whole preferred over packed. */
  picture?: Resource
}

const baseNameOf = (name: string): string => stripExtension(name).toLowerCase()

/**
 * Folder listings, kept a short while per client. Playing through a folder
 * of MUS tunes listed that folder again for every one of them; half a minute
 * covers a run of plays and is short enough that a file added beside a tune
 * is seen on the next play but one. A listing that failed is not kept.
 */
const LISTING_TTL_MS = 30_000
const LISTINGS_KEPT = 32
const listings = new WeakMap<object, Map<string, { at: number; children: Promise<Resource[]> }>>()

function listFolder(webdav: WebDav, space: SpaceResource, path: string): Promise<Resource[]> {
  const mine = listings.get(webdav) ?? new Map<string, { at: number; children: Promise<Resource[]> }>()
  listings.set(webdav, mine)
  const key = `${space.id}:${path}`
  const now = Date.now()
  const kept = mine.get(key)
  if (kept && now - kept.at < LISTING_TTL_MS) return kept.children
  const children = webdav.listFiles(space, { path }).then(({ children = [] }) => children as Resource[])
  const entry = { at: now, children }
  mine.delete(key)
  mine.set(key, entry)
  // Oldest first in a Map's order, so the first key is the one to let go.
  if (mine.size > LISTINGS_KEPT) mine.delete(mine.keys().next().value as string)
  const forget = (): void => {
    if (mine.get(key) === entry) mine.delete(key)
  }
  children.catch(forget)
  return children
}

/**
 * Lists the folder once and picks out the siblings. Any failure, a public
 * link without listing rights for instance, yields no companions rather than
 * an error: the clicked file alone may still be playable.
 */
export async function findCompanions(
  webdav: WebDav,
  space: SpaceResource,
  resource: Resource
): Promise<Companions> {
  const parent = parentFolder(resource.path ?? '')
  const base = baseNameOf(resource.name ?? '')
  if (!base) return {}
  try {
    const children = await listFolder(webdav, space, parent)
    const out: Companions = {}
    for (const child of children) {
      if (child.type === 'folder' || !child.name || child.id === resource.id) continue
      if (baseNameOf(child.name) !== base) continue
      const ext = extensionOf(child.name)
      if (ext === 'mus' && !out.mus) out.mus = child
      else if (ext === 'str' && !out.str) out.str = child
      else if (ext === 'wds' && !out.wds) out.wds = child
      // `.pic` holds a whole bitmap and the other two hold a packed one;
      // where a tune has both, unpacking is work that need not be done.
      else if (ext === 'pic') out.picture = child
      else if (PICTURE_EXTENSIONS.has(ext) && !out.picture) out.picture = child
    }
    return out
  } catch (e) {
    console.info('[sidplayer] the folder could not be listed for companion files', { parent, error: e })
    return {}
  }
}
