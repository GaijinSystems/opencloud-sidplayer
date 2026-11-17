/**
 * Resolves URLs for the files we ship in `public/`.
 *
 * The app is built with `base: './'` and loaded through Module Federation from
 * an arbitrary mount point (`/assets/apps/sidplayer/`), so nothing may assume a
 * site-root path. The entry chunk lands in `dist/js/` while `public/` is
 * copied to `dist/`, which is why the default resolution walks one level up
 * from the module URL.
 *
 * An admin can override the base outright when a deployment serves app assets
 * from somewhere unusual, e.g. a CDN.
 */

let baseOverride: string | null = null
let buildTag: string | null = null

/** Set from the app config at startup; empty values are ignored. */
export function setAssetBaseUrl(base: string | null | undefined) {
  baseOverride = base && base.trim() ? base.trim() : null
}

/**
 * The version stamp put on the engine URLs, from the packaged build's
 * manifest. Empty values are ignored, which is the state outside a packaged
 * build, where the files are being edited anyway.
 */
export function setBuildTag(tag: string | null | undefined) {
  buildTag = tag && tag.trim() ? tag.trim() : null
}

function currentModuleUrl(): string | null {
  try {
    return import.meta.url || null
  } catch {
    return null
  }
}

/**
 * An override as an absolute URL. Admins write paths on their own server as
 * often as full URLs, and `new URL` refuses a path with no base to resolve
 * it against: the page's own address is that base.
 */
const absolute = (value: string): string => {
  const dir = value.endsWith('/') ? value : `${value}/`
  return typeof document !== 'undefined' ? new URL(dir, document.baseURI).href : dir
}

/** Base URL of the app's `dist/` directory, with a trailing slash. */
export function appAssetBase(): string {
  if (baseOverride) return absolute(baseOverride)
  const moduleUrl = currentModuleUrl()
  if (moduleUrl) {
    // `…/sidplayer/js/sidplayer-abc123.mjs` → `…/sidplayer/`
    return new URL('../', moduleUrl).href
  }
  if (typeof document !== 'undefined') {
    return new URL('./', document.baseURI).href
  }
  return '/'
}

/** Absolute URL for a file shipped under `public/vendor/`. */
export function resolveVendorAssetUrl(relativePath: string): string {
  const cleaned = relativePath.replace(/^\/+/, '')
  return new URL(`vendor/${cleaned}`, appAssetBase()).href
}

/**
 * Where the audio worklet and its engine live. The processor statically
 * imports `./engine.js`, so both files must sit in the same directory and
 * an override names that directory, not either file.
 *
 * The build tag goes on as `?v=`, because these files keep fixed names and
 * are overwritten in place on an upgrade while the app's own chunk is
 * content-hashed: without it a browser holding a cached `sid-processor.js`
 * can pair it with a freshly fetched wasm, and an old processor never
 * reports the end of a MUS tune. The processor's own `import './engine.js'`
 * is resolved by the browser against the processor's URL and carries no
 * query of its own, so that one pair still rides on the processor's entry.
 */
export function resolveEngineUrl(engineBaseUrl: string | null, file: string): string {
  const href = engineBaseUrl
    ? new URL(file, absolute(engineBaseUrl)).href
    : resolveVendorAssetUrl(`sid-engine/${file}`)
  if (!buildTag) return href
  const stamped = new URL(href)
  stamped.searchParams.set('v', buildTag)
  return stamped.href
}
