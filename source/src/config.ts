import defaults from './defaults.json'
import { rooted } from './sid/source'

export interface SidplayConfig {
  /** Take over left-click for SID extensions at all. Off: only "Open with" and the context menu. */
  registerAsDefault: boolean
  /**
   * What a left-click does when this app is the default: true plays the tune
   * in the dock and keeps the Files list; false opens the full view, as a
   * viewer app would. "Open in SID Player" is in the context menu either way.
   */
  clickPlaysInPlace: boolean
  /** A SID is at most 64 kB of C64 memory plus a header; anything much bigger is not one. */
  maxFileSizeKb: number
  /**
   * How long to play a subsong that has no known length. SID tunes loop
   * forever, so without this a tune never advances. HVSC's Songlengths.md5
   * is the eventual source of real values; see docs/engine-contract.md.
   */
  defaultSongLengthSeconds: number
  /** Start playing as soon as the file opens. Browsers may still demand a tap. */
  autoPlay: boolean
  /** Spectrum display. */
  analyserEnabled: boolean
  /**
   * URL of HVSC's Songlengths.md5, for real subsong lengths. Optional: a
   * copy found in the user's space (beside the tune, or in DOCUMENTS/ up the
   * tree, as HVSC lays it out) is used first.
   */
  songlengthsUrl: string | null
  /**
   * Folder in the user's space that the app works out of. The library
   * creates it on a first sync.
   *
   * The default is `/SID Library`, one folder holding everything rather than
   * a collection dropped at the root of the space. HVSC goes in `C64Music/`
   * inside it, which is the folder HVSC's own archives unpack into, so
   * extracting `HVSC_<n>-all-of-them.7z` here needs nothing moved
   * afterwards; other collections, such as Compute's Gazette, sit beside it
   * in folders of their own.
   *
   * A collection put straight in this folder, without the `C64Music/` level,
   * is found just the same - see `resolveCollectionRoot`.
   */
  hvscPath: string
  /**
   * Same-origin path that forwards to an HVSC mirror, for the library's
   * update checks and downloads. The browser cannot reach HVSC directly:
   * its version API refuses requests carrying an `Origin` header and the
   * mirror sends no CORS headers, so a path on this instance is the only way
   * in. See `deploy/haproxy-hvsc.cfg`.
   */
  hvscMirrorPath: string
  /** Override for where `public/` assets are served from. */
  assetBaseUrl: string | null
  /**
   * Directory holding `sid-processor.js` and `engine.js`, for hosting the
   * engine elsewhere. Falls back to `vendor/sid-engine/` inside the app.
   */
  engineBaseUrl: string | null
  /**
   * Version stamp appended to the engine URLs as `?v=`, written into the
   * manifest by the build.
   *
   * The engine files keep fixed names and are overwritten in place on an
   * upgrade, while the app's own chunk is content-hashed - so a browser
   * holding a cached `sid-processor.js` could pair it with a freshly fetched
   * wasm. That is not theoretical: the `ended` message the Sidplayer work
   * added means an old cached processor never reports the end of a tune and
   * a MUS file plays for ever. Null outside a packaged build, where the
   * files are being edited anyway.
   */
  buildTag: string | null
  /**
   * The app's own version, written into the manifest by the build and shown
   * under the library's name. Null outside a packaged build, where there is
   * no release to name.
   */
  version: string | null
}

/**
 * One source of truth, shared with `scripts/prune-dist.mjs`, which stamps the
 * same block into the manifest.
 */
const DEFAULTS = defaults as SidplayConfig

const num = (v: unknown, min: number, max: number, fallback: number): number => {
  // A number, or one written as text. `Number(null)` and `Number('')` are
  // both 0, which is finite, so "not set" used to become the minimum.
  if (typeof v !== 'number' && (typeof v !== 'string' || !v.trim())) return fallback
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback
}
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)
/**
 * A tab, a newline or any other control character. A URL parser drops tabs
 * and newlines before it reads anything, so `/<tab>/host` passes a check for
 * a leading `//` and is then fetched as `//host`; nothing an admin means to
 * write has one in it.
 */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/

/**
 * A path within the space or the origin, normalised to no trailing slash.
 * Anything with a scheme is refused: both of these are joined onto other
 * paths, and an absolute URL there would send requests somewhere else
 * entirely, which is not an admin's likely intent in a typo.
 */
const path = (v: unknown, fallback: string): string => {
  if (typeof v !== 'string' || !v.trim()) return fallback
  const p = v.trim()
  // No backslash at all: a browser reads `/\host` as `//host`, another host,
  // and no folder or route this app uses has one.
  if (CONTROL.test(p) || p.includes('\\')) return fallback
  // A scheme, or a leading `//` - which a browser reads as another host, so
  // `//mirror` would have sent every request to a machine called "mirror".
  if (/^[a-z][a-z0-9+.-]*:/i.test(p) || /^[/\\]{2}/.test(p)) return fallback
  // From the root, always: `hvsc-mirror` alone would be fetched relative to
  // whatever page the app happens to be on.
  return rooted(p).replace(/\/+$/, '') || fallback
}
/**
 * Somewhere to fetch from: an http(s) URL, or a path on this server. Any
 * other scheme - `javascript:`, `data:` - is refused rather than handed to
 * the worklet loader, and so is `//host`, which names another host while
 * looking like a path.
 */
const url = (v: unknown): string | null => {
  if (typeof v !== 'string' || !v.trim()) return null
  const u = v.trim()
  if (CONTROL.test(u)) return null
  if (/^[/\\]{2}/.test(u)) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(u) && !/^https?:\/\//i.test(u)) return null
  return u
}

/**
 * A short line of text to show: the build's version and stamp. Not a URL, so
 * not judged as one; only kept to something a label can hold.
 */
const text = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t && t.length <= 200 && !CONTROL.test(t) ? t : null
}

/**
 * Reads admin configuration, clamping every value into a sane range.
 *
 * Config comes from `apps.yaml` or a `config.json` an admin edits by hand, so
 * it is treated as untrusted input: a typo should degrade to a default rather
 * than produce a player that behaves strangely.
 */
export const readConfig = (raw: Record<string, unknown> | undefined | null = {}): SidplayConfig => {
  const c = raw ?? {}
  return {
    registerAsDefault: bool(c.registerAsDefault, DEFAULTS.registerAsDefault),
    clickPlaysInPlace: bool(c.clickPlaysInPlace, DEFAULTS.clickPlaysInPlace),
    maxFileSizeKb: num(c.maxFileSizeKb, 8, 65536, DEFAULTS.maxFileSizeKb),
    defaultSongLengthSeconds: num(c.defaultSongLengthSeconds, 5, 3600, DEFAULTS.defaultSongLengthSeconds),
    autoPlay: bool(c.autoPlay, DEFAULTS.autoPlay),
    analyserEnabled: bool(c.analyserEnabled, DEFAULTS.analyserEnabled),
    songlengthsUrl: url(c.songlengthsUrl),
    hvscPath: path(c.hvscPath, DEFAULTS.hvscPath),
    hvscMirrorPath: path(c.hvscMirrorPath, DEFAULTS.hvscMirrorPath),
    assetBaseUrl: url(c.assetBaseUrl),
    engineBaseUrl: url(c.engineBaseUrl),
    buildTag: text(c.buildTag),
    version: text(c.version)
  }
}

export const KB = 1024
