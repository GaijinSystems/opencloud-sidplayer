#!/usr/bin/env node
/**
 * Post-build: stamp the manifest with the build identity, copy the shipped
 * defaults into it, and drop anything the host does not need.
 *
 * The stamp exists so a bug report can be tied to an exact build without
 * asking the reporter what they installed. A stale deployed copy looks exactly
 * like a bug otherwise.
 */
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { engineFiles } from './engine-files.mjs'

const dist = 'dist'
const manifestPath = join(dist, 'manifest.json')

if (!existsSync(manifestPath)) {
  console.error('[sidplayer] no dist/manifest.json — did vite build run?')
  process.exit(1)
}

// Refuse to prune unless the audio worklet and its engine are present. Without
// this guard a change in how public/ is copied would silently ship a player
// with nothing to play through.
const required = [
  'vendor/sid-engine/sid-processor.js',
  'vendor/sid-engine/engine.js',
  'vendor/sid-engine/engine.json'
]
const missing = required.filter((file) => !existsSync(join(dist, file)))
if (missing.length) {
  console.error(`[sidplayer] refusing to prune, missing ${missing.join(', ')}`)
  process.exit(1)
}

// The binary is built separately (engine/build.sh) and may legitimately be
// absent while working on the UI. A build without it still deploys, and the
// player says exactly what is missing, but it must not go out unnoticed.
const engineManifest = JSON.parse(readFileSync(join(dist, 'vendor/sid-engine/engine.json'), 'utf8'))
const engineMissing = (engineManifest.files ?? []).filter(
  (f) => !existsSync(join(dist, 'vendor/sid-engine', f))
)
if (engineMissing.length) {
  console.warn(`[sidplayer] WARNING: engine file(s) missing, nothing will play: ${engineMissing.join(', ')}`)
  console.warn('[sidplayer]          run engine/build.sh, then npm run build again')
}

/*
 * The wasm in dist is the wasm engine/build.sh produced.
 *
 * Until this check existed, "the file is there" was the whole test: two builds
 * from different Emscripten versions produce different bytes, engine.json
 * carried no version and no hash, and a hand-dropped or half-copied binary was
 * indistinguishable from the right one. build.sh now writes the sha256 of what
 * it linked, plus the libsidplayfp and emsdk versions it used, into
 * engine.json's `build` block, and a mismatch stops the build rather than
 * shipping a binary nobody can account for.
 *
 * An engine.json without the block is a binary built before this existed: say
 * so rather than fail. engine/build.sh now also refuses to produce a binary
 * that differs from a recorded hash, so this check is the second of two.
 */
const wasmPath = join(dist, 'vendor/sid-engine/libsidplayfp.wasm')
const stamp = engineManifest.build
if (existsSync(wasmPath)) {
  if (stamp?.wasmSha256) {
    const actual = createHash('sha256').update(readFileSync(wasmPath)).digest('hex')
    if (actual !== stamp.wasmSha256) {
      console.error('[sidplayer] libsidplayfp.wasm is not the binary engine.json describes')
      console.error(`[sidplayer]   engine.json: ${stamp.wasmSha256}`)
      console.error(`[sidplayer]   dist:        ${actual}`)
      console.error('[sidplayer] rebuild with engine/build.sh, or restore the tracked binary')
      process.exit(1)
    }
    console.log(
      `[sidplayer] engine: libsidplayfp ${stamp.libsidplayfp ?? '?'}, emsdk ${stamp.emsdk ?? '?'}, wasm sha256 verified`
    )
  } else {
    console.warn('[sidplayer] WARNING: engine.json has no build.wasmSha256, so the binary is unverified')
    console.warn('[sidplayer]          rebuild with engine/build.sh to stamp it')
  }
}

/**
 * The commit the build came from, for the manifest's build stamp.
 *
 * `SOURCE_COMMIT` is read first because the build usually runs inside a
 * container that has the working tree mounted but no git identity or,
 * sometimes, no git at all - which is why released builds used to be stamped
 * "unknown". The packaging script passes the real value in.
 */
const commit = (() => {
  if (process.env.SOURCE_COMMIT?.trim()) return process.env.SOURCE_COMMIT.trim()
  const git = (args) =>
    execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  try {
    // Marked when the tree the build read differs from the commit, new files
    // included, as scripts/package.sh marks its own builds: the stamp is the
    // engine files' `?v=`, and an edited worklet under a clean commit's stamp
    // would be passed over for the copy every browser already has cached.
    const dirty = git('status --porcelain -- . ../LICENSE') ? '-dirty' : ''
    return git('rev-parse --short HEAD') + dirty
  } catch {
    return 'unknown'
  }
})()

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.build = { commit, builtAt: new Date().toISOString() }

// Defaults shipped with the app, from the same file the app itself reads, so
// the manifest cannot drift from the code. An administrator overrides these in
// `$OC_BASE_DATA_PATH/config/apps.yaml` (global) or `sidplayer/config.json`
// (this instance only). Merge order is local > global > manifest.
manifest.config = JSON.parse(readFileSync('src/defaults.json', 'utf8'))
manifest.engine = { name: engineManifest.name ?? 'unknown', complete: engineMissing.length === 0 }

/*
 * A token for the app to hang on the engine URLs.
 *
 * The entry chunk is content-hashed; sid-processor.js, engine.js, engine.json
 * and libsidplayfp.wasm are not. They keep fixed names and are overwritten
 * where they stand by an upgrade, and the worklet is added by bare URL, so a
 * browser holding a cached processor can pair it with a freshly fetched wasm.
 * The `ended` / `endOnSilence` protocol is exactly that hazard: an old cached
 * processor never sends `ended`, and a Sidplayer tune then plays for ever.
 *
 * The shell merges `manifest.config` into the app's `applicationConfig`, which
 * is the one channel that reaches the running app without new plumbing, so the
 * tag travels there. `helpers/assetUrl.ts` appends it as `?v=` in
 * `resolveEngineUrl`; see docs/engine-contract.md.
 */
// `-` rather than `+`, so the tag survives a URL query without escaping.
const buildTag = `${manifest.version}-${commit}`
manifest.config.buildTag = buildTag
/*
 * And the bare version, for the library to show under its own name. Split out
 * rather than sliced off `buildTag` by the reader: the commit can carry a
 * `-dirty` suffix and a version could one day carry a `-rc1`, so where the
 * one ends and the other begins is the build's business, not the app's.
 */
manifest.config.version = manifest.version

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

/*
 * The one engine URL the app does not build: sid-processor.js imports
 * `./engine.js` statically, because an AudioWorkletGlobalScope has no dynamic
 * import, and a relative specifier resolved against `sid-processor.js?v=<tag>`
 * drops the query. Without this the processor would be revalidated on an
 * upgrade and the adapter beside it would not, which is half a fix. Rewritten
 * in dist only; the file under public/ keeps a plain specifier so that
 * scripts/verify-engine.mjs and the dev server can load it from disk.
 */
const processorPath = join(dist, 'vendor/sid-engine/sid-processor.js')
const processor = readFileSync(processorPath, 'utf8')
const versioned = processor.replace(
  /from '\.\/engine\.js'/,
  `from './engine.js?v=${encodeURIComponent(buildTag)}'`
)
if (versioned === processor) {
  // A failure, like the other guards here: a build that only warned would
  // ship, and bring back exactly the stale engine this stamping exists for.
  console.error("[sidplayer] sid-processor.js has no `from './engine.js'` to version")
  console.error('[sidplayer] an upgrade would leave a cached engine.js beside a new wasm; refusing')
  process.exit(1)
}
writeFileSync(processorPath, versioned)

/*
 * The licence text travels with the artefact.
 *
 * This is an AGPL-3.0 project - package.json, README and
 * THIRD-PARTY-NOTICES.txt all say so - and dist/ is what people install, so
 * the text has to be in it. Section 13 in particular applies to software
 * reached over a network, which is the only way this app is ever used. It is
 * copied from the repository root rather than kept in public/ so that there is
 * exactly one copy and the usual places (git hosting, `ls`) find it; the cost
 * is that the build has to see one directory above source/.
 */
const licence = join('..', 'LICENSE')
if (existsSync(licence)) {
  copyFileSync(licence, join(dist, 'LICENSE'))
} else {
  console.warn('[sidplayer] WARNING: ../LICENSE not found; this build ships without its licence text')
}

// Nothing but the manifest, the entry graph, styles and the vendored worklet
// ships. The entrypoint is whatever the manifest names it: module federation
// emits remoteEntry into `js/` in some versions and into the dist root in
// others, so the keep-list is derived rather than hardcoded.
const keep = new Set([
  'manifest.json',
  'js',
  'assets',
  'vendor',
  'THIRD-PARTY-NOTICES.txt',
  'LICENSE',
  manifest.entrypoint.split('/')[0]
])

for (const entry of readdirSync(dist)) {
  if (keep.has(entry)) continue
  rmSync(join(dist, entry), { recursive: true, force: true })
}

/*
 * Nothing ships beside the engine that the engine does not ask for.
 *
 * public/vendor/sid-engine/ is a working directory: ROM images land in it
 * under whatever name they arrived with, and everything in dist/ is served to
 * anyone who can reach the instance - unauthenticated, as e2e/smoke.mjs
 * demonstrates by fetching one. The 1.0.0 tarball carried
 * kernal.901227-03.bin, basic.901226-01.bin and characters.901225-01.bin
 * alongside the three names engine.json actually uses: three further copies of
 * copyrighted ROMs that nothing ever fetches, published for no reason.
 * engine.json is the authority. If the engine does not name a file, it does
 * not go out.
 */
const engineDir = join(dist, 'vendor/sid-engine')
const engineKeep = new Set(engineFiles(engineManifest))
if (existsSync(engineDir)) {
  for (const entry of readdirSync(engineDir)) {
    if (engineKeep.has(entry)) continue
    console.log(`[sidplayer] dropping vendor/sid-engine/${entry}: engine.json does not name it`)
    rmSync(join(engineDir, entry), { recursive: true, force: true })
  }
}

const size = (dir) =>
  readdirSync(dir, { withFileTypes: true }).reduce((total, e) => {
    const p = join(dir, e.name)
    return total + (e.isDirectory() ? size(p) : statSync(p).size)
  }, 0)

console.log(
  `[sidplayer] ${manifest.name} ${manifest.version} (${commit}) — ${(size(dist) / 1024).toFixed(0)} kB`
)
