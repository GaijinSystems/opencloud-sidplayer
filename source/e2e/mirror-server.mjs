#!/usr/bin/env node
/**
 * Serves the miniature mirror over plain HTTP, in the shape the real one has:
 * everything under `/HVSC/`, with `C64Music/` inside it.
 *
 * Deliberately sends no CORS headers, because the real mirror sends none
 * either - that is the whole reason the app reaches it through a path on its
 * own origin. If a test ever passes because this server was permissive, the
 * test is lying.
 *
 *   node e2e/mirror-server.mjs [dir] [port]
 */
import { createReadStream, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(process.argv[2] ?? join(here, '.mirror'))
const port = Number(process.argv[3] ?? 9400)

const TYPES = {
  '.sid': 'audio/prs.sid',
  '.txt': 'text/plain',
  '.md5': 'text/plain'
}

createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost')
  // A malformed escape - `%zz`, or a lone `%` at the end - makes
  // decodeURIComponent throw, and an exception in this handler killed the
  // process: the test that sent it failed, and so did every test after it,
  // with a connection error that looked nothing like the cause. It is a bad
  // request, not a crash.
  let pathname
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    response.writeHead(400, { 'content-type': 'text/plain' }).end('bad request\n')
    return
  }
  // No traversal: join and then check the result is still inside the root.
  // `join` normalises, so it cannot climb out of an absolute root by itself
  // and this is a second lock rather than the first. The separator matters
  // all the same: a bare `startsWith(root)` also accepts a sibling whose name
  // merely starts with the root's, `.mirror-old` next to `.mirror`.
  const file = join(root, normalize(pathname))
  if (file !== root && !file.startsWith(root + sep)) {
    response.writeHead(403).end()
    return
  }
  let stat
  try {
    stat = statSync(file)
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain' }).end('not found\n')
    return
  }
  if (stat.isDirectory()) {
    response.writeHead(403).end()
    return
  }
  const type = TYPES[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream'

  // Range support, because the app asks for the first 4 kB of HVSC.txt and
  // the real mirror answers such requests with a 206.
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
  if (range) {
    const start = Number(range[1])
    const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1
    if (start > end) {
      response.writeHead(416).end()
      return
    }
    response.writeHead(206, {
      'content-type': type,
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${stat.size}`,
      'accept-ranges': 'bytes'
    })
    createReadStream(file, { start, end }).pipe(response)
    return
  }

  response.writeHead(200, {
    'content-type': type,
    'content-length': String(stat.size),
    'accept-ranges': 'bytes'
  })
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  createReadStream(file).pipe(response)
  // Loopback only, like the proxy in front of it: the rig runs with
  // --network=host, and without a host this listened on every interface.
}).listen(port, '127.0.0.1', () => {
  console.log(`[mirror] serving ${root} on http://127.0.0.1:${port} (no CORS headers, as upstream)`)
})
