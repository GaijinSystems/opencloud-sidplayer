/**
 * The user's space, for a site with no server: the files the build put
 * beside the page, listed in `space.json`, plus whatever the app writes
 * (favourites, its status), kept in this browser's local storage.
 *
 * It answers the calls the app makes on OpenCloud's WebDAV client, in the
 * shapes the client gives - which is all the app ever sees of a server.
 */

interface Listed {
  /** Path in the space. */
  path: string
  /** Where the bytes are, relative to the page; absent for text given inline. */
  url?: string
  text?: string
  size: number
  md5?: string
}

const STORE = 'sidplayer-demo:'
const notThere = () => Object.assign(new Error('404 not found'), { statusCode: 404 })

export const demoSpace = {
  id: 'demo-space',
  driveType: 'personal',
  driveAlias: 'personal/demo',
  name: 'Demo',
  webDavPath: '/spaces/demo-space',
  getDriveAliasAndItem: (resource: { path?: string }) => `personal/demo${resource.path ?? ''}`
} as const

let files = new Map<string, Listed>()
const folders = new Set<string>(['/'])
const fetched = new Map<string, Promise<Uint8Array>>()

const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/'))) || '/'
const clean = (path: string): string => ('/' + path).replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1')

function addFolders(path: string): void {
  for (let p = parentOf(path); !folders.has(p); p = parentOf(p)) folders.add(p)
}

/** Reads the build's list of files, and whatever this browser has written over them. */
export async function loadDemoSpace(): Promise<void> {
  const listing = (await (await fetch(new URL('space.json', document.baseURI))).json()) as Listed[]
  files = new Map(listing.map((entry) => [clean(entry.path), { ...entry, path: clean(entry.path) }]))
  for (const path of files.keys()) addFolders(path)
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key?.startsWith(STORE)) continue
    const path = key.slice(STORE.length)
    const text = localStorage.getItem(key) ?? ''
    files.set(path, { path, text, size: text.length })
    addFolders(path)
  }
}

async function bytesOf(path: string): Promise<Uint8Array> {
  const entry = files.get(clean(path))
  if (!entry) throw notThere()
  if (entry.text !== undefined) return new TextEncoder().encode(entry.text)
  let pending = fetched.get(entry.path)
  if (!pending) {
    pending = fetch(new URL(entry.url as string, document.baseURI)).then(async (response) => {
      if (!response.ok) throw Object.assign(new Error(`${response.status}`), { statusCode: response.status })
      return new Uint8Array(await response.arrayBuffer())
    })
    fetched.set(entry.path, pending)
    pending.catch(() => fetched.delete(entry.path))
  }
  return pending
}

function resourceFor(path: string) {
  const isFolder = folders.has(path) && !files.has(path)
  const entry = files.get(path)
  const name = path.split('/').pop() ?? ''
  return {
    id: path,
    fileId: path,
    path,
    name,
    type: isFolder ? 'folder' : 'file',
    isFolder,
    extension: isFolder ? '' : (name.match(/\.([^.]+)$/)?.[1] ?? '').toLowerCase(),
    size: entry?.size ?? 0,
    extraProps: entry?.md5 ? { 'oc:checksums': `MD5:${entry.md5}` } : {}
  }
}

/** The calls the app makes on OpenCloud's WebDAV client. */
export const demoWebdav = {
  async listFiles(_space: unknown, { path = '/' }: { path?: string }, options: { depth?: number } = {}) {
    const at = clean(path)
    if (!folders.has(at) && !files.has(at)) throw notThere()
    const resource = resourceFor(at)
    if (options.depth === 0 || !folders.has(at)) return { resource, children: [] }
    const children = [...new Set([...folders, ...files.keys()])]
      .filter((p) => p !== at && parentOf(p) === at)
      .sort()
      .map(resourceFor)
    return { resource, children }
  },

  async getFileInfo(_space: unknown, { path = '/' }: { path?: string }) {
    const at = clean(path)
    if (!folders.has(at) && !files.has(at)) throw notThere()
    return resourceFor(at)
  },

  async getFileContents(
    _space: unknown,
    { path = '' }: { path?: string; fileId?: string },
    options: { responseType?: string; headers?: Record<string, string> } = {}
  ) {
    let bytes = await bytesOf(path)
    const range = /bytes=(\d+)-(\d*)/.exec(options.headers?.Range ?? '')
    if (range) bytes = bytes.subarray(Number(range[1]), range[2] ? Number(range[2]) + 1 : undefined)
    if (options.responseType === 'text') return { body: new TextDecoder().decode(bytes) }
    return { body: bytes.slice().buffer }
  },

  async putFileContents(_space: unknown, { path, content }: { path: string; content: string | ArrayBuffer }) {
    const at = clean(path)
    const text = typeof content === 'string' ? content : new TextDecoder().decode(content)
    localStorage.setItem(STORE + at, text)
    files.set(at, { path: at, text, size: text.length })
    addFolders(at)
  },

  async deleteFile(_space: unknown, { path }: { path: string }) {
    const at = clean(path)
    localStorage.removeItem(STORE + at)
    files.delete(at)
  },

  async createFolder(_space: unknown, { path }: { path: string }) {
    const at = clean(path)
    if (folders.has(at)) throw Object.assign(new Error('405'), { statusCode: 405 })
    folders.add(at)
    addFolders(at)
  },

  async getFileUrl(_space: unknown, resource: { path?: string }) {
    const entry = files.get(clean(resource.path ?? ''))
    if (!entry) throw notThere()
    if (entry.url) return new URL(entry.url, document.baseURI).href
    return URL.createObjectURL(new Blob([entry.text ?? '']))
  },

  revokeUrl(url: string) {
    if (url.startsWith('blob:')) URL.revokeObjectURL(url)
  }
}
