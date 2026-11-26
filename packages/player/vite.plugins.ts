import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import type { Connect, Plugin } from 'vite'
import { build as esbuild } from 'esbuild'

/**
 * The plugins of the player's Vite config, which the demo's (`apps/demo/vite.config.ts`) uses too.
 * Neither worker is a module a host imports, so both are bundled here with esbuild.
 */

const JOBS_VIRTUAL_ID = 'virtual:h5p-jobs-worker'
const RESOLVED_JOBS_VIRTUAL_ID = '\0virtual:h5p-jobs-worker'

const rootDir = import.meta.dirname
const SW_ENTRY = resolve(rootDir, 'src/sw/sw-entry.ts')
const JOBS_ENTRY = resolve(rootDir, 'src/jobs/jobs-worker.ts')

/** A standalone classic script: no imports, no `import.meta`, runnable from a blob or a URL. */
async function bundleWorker(entry: string, minify: boolean): Promise<string> {
  const result = await esbuild({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify,
    legalComments: 'none',
    define: { 'import.meta.env.DEV': String(!minify) }
  })

  return result.outputFiles[0].text
}

/** Supplies the Jobs worker to the element as a string, for `new Worker(blob:)`. */
export function jobsWorkerPlugin(): Plugin {
  return {
    name: 'h5p-jobs-worker',

    resolveId(id) {
      return id === JOBS_VIRTUAL_ID ? RESOLVED_JOBS_VIRTUAL_ID : null
    },

    async load(id) {
      if (id !== RESOLVED_JOBS_VIRTUAL_ID) return null
      const source = await bundleWorker(JOBS_ENTRY, this.environment?.mode === 'build')
      return `export default ${JSON.stringify(source)};`
    },

    // esbuild bundles the worker behind Vite's back: without this, editing a file it imports leaves
    // the old bundle in the module cache and the page runs code that is no longer on disk.
    handleHotUpdate({ file, server }) {
      if (!file.startsWith(resolve(rootDir, 'src'))) return
      const virtualModule = server.moduleGraph.getModuleById(RESOLVED_JOBS_VIRTUAL_ID)
      if (virtualModule) server.moduleGraph.invalidateModule(virtualModule)
    }
  }
}

/**
 * Serves the Service Worker in dev and tests: `new URL('./h5p-sw.js', import.meta.url)` finds
 * `dist/h5p-sw.js` in a built package and `/src/h5p-sw.js` in dev, which is this.
 */
export function devServiceWorkerPlugin(): Plugin {
  // `/versioned/h5p-sw.js` answers as an older release would, reporting the last
  // `/versioned/__version?v=` (unset: the real one): one URL, changing bytes, as an update looks.
  let versionedAs: string | null = null
  let versionedDelay = 0
  // The worker's `VERSION` constant, which a release keeps equal to the package's own.
  const { version } = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8')) as { version: string }

  return {
    name: 'h5p-dev-service-worker',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0]
        if (url === '/versioned/__version') {
          const params = new URL(req.url ?? '', 'http://dev').searchParams
          versionedAs = params.get('v') || null
          versionedDelay = Number(params.get('delay')) || 0
          res.setHeader('cache-control', 'no-store')
          res.end(versionedAs ?? '')
          return
        }
        // The Jobs worker as a file, which the element falls back to under a policy that
        // refuses its `blob:` URL; served the same way so that fallback works in dev too.
        const entry = url?.endsWith('/h5p-sw.js') ? SW_ENTRY : url?.endsWith('/h5p-jobs.js') ? JOBS_ENTRY : null
        if (!entry) return next()

        const as = url === '/versioned/h5p-sw.js' ? versionedAs : null
        const late = url === '/versioned/h5p-sw.js' ? versionedDelay : 0
        void new Promise((resolve) => setTimeout(resolve, late)).then(() => bundleWorker(entry, false)).then(
          (bundled) => {
            // By value, not by name: esbuild renames the constant (`VERSION2`) when names collide.
            const source = as ? bundled.replaceAll(JSON.stringify(version), JSON.stringify(as)) : bundled
            res.setHeader('content-type', 'text/javascript; charset=utf-8')
            // The `h5p/` sub-scope needs no permission, but the header costs nothing and helps a
            // host that places the file somewhere unexpected.
            res.setHeader('service-worker-allowed', '/')
            res.setHeader('cache-control', 'no-store')
            res.end(source)
          },
          (error: unknown) => {
            res.statusCode = 500
            res.end(`// Failed to bundle ${url}\n// ${String(error)}`)
          }
        )
      })
    }
  }
}

/** Writes `body` in 64 kB slices at about `bytesPerSecond`, for `?throttle=`. */
async function sendThrottled(res: ServerResponse, body: Buffer, bytesPerSecond: number): Promise<void> {
  const slice = 64 * 1024
  for (let at = 0; at < body.length && !res.destroyed; at += slice) {
    const piece = body.subarray(at, Math.min(at + slice, body.length))
    // A client that went away mid-body closes the response; waiting on `drain` alone would park
    // this loop for ever.
    if (!res.write(piece)) await drainedOrClosed(res)
    await new Promise((resolve) => setTimeout(resolve, (piece.length / bytesPerSecond) * 1000))
  }
  res.end()
}

/** Resolves when the response can take more, or when there is no one left to take it. */
function drainedOrClosed(res: ServerResponse): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      res.off('drain', done)
      res.off('close', done)
      resolve()
    }
    res.once('drain', done)
    res.once('close', done)
  })
}

/** The fixture hosts' answer for an archive none of their directories has. */
function noSuchFixture(res: ServerResponse): void {
  res.statusCode = 404
  res.end('no such fixture')
}

/**
 * A `Range` header against a body of `size` bytes: the inclusive range it asks for, `null` when
 * it asks for none, or `'unsatisfiable'` when it starts past the end.
 */
function parseRangeHeader(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  const range = /^bytes=(\d+)-(\d*)$/.exec(header ?? '')
  if (!range) return null
  const start = Number(range[1])
  if (start >= size) return 'unsatisfiable'
  return { start, end: range[2] ? Math.min(Number(range[2]), size - 1) : size - 1 }
}

/** Where the fixture hosts look for an archive by name, in order. */
const PLAYER_FIXTURES = resolve(rootDir, 'public/fixtures')

/**
 * The first of `dirs` that holds `name`. The player's tests pass only their fixtures; the demo
 * passes its content first and the fixtures second, and the names do not collide.
 */
async function archivePath(dirs: readonly string[], name: string): Promise<string> {
  for (const dir of dirs) {
    const path = resolve(dir, name)
    try {
      await stat(path)
      return path
    } catch {
      // Not in this one; try the next.
    }
  }
  throw new Error(`no such fixture: ${name}`)
}

/** The last path segment of a fixture route, or null for anything that is not a plain name. */
function fixtureName(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null
  const name = pathname.slice(prefix.length)
  return name.includes('/') || name.includes('..') ? null : name
}

/**
 * `/no-range/` serves the demo content and fixtures as a host that ignores `Range` does: 200, whole
 * body. Vite's server honours it, so the chunked adapter, the common case, would go unexercised.
 */
function noRangeHandler(dirs: readonly string[]): Connect.NextHandleFunction {
  const prefix = '/no-range/'

  return (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const name = fixtureName(url.pathname, prefix)
    if (!name) return next()
    // `?throttle=<bytes per second>` paces the body, so a test can watch the player boot from
    // the forward index while the rest of the archive is still on its way.
    const throttle = Number(url.searchParams.get('throttle') ?? 0)

    archivePath(dirs, name).then((path) => readFile(path)).then(
      (body) => {
        res.setHeader('content-type', 'application/zip')
        res.setHeader('content-length', String(body.length))
        res.setHeader('cache-control', 'no-store')
        // Deliberately no `accept-ranges`, and the `range` header on the request is ignored.
        res.statusCode = 200
        if (throttle > 0) void sendThrottled(res, body, throttle)
        else res.end(body)
      },
      () => noSuchFixture(res)
    )
  }
}

/**
 * Serves as GitHub Pages does: `Range` honoured, CORS open, the archive gzipped for a client that
 * accepts it, so it has two lengths and the probe takes no size from a plain `GET` (`source.ts`).
 */
function compressingHostHandler(dirs: readonly string[]): Connect.NextHandleFunction {
  const prefix = '/compressing/'
  const gzipped = new Map<string, Buffer>()

  const representation = async (name: string, gzip: boolean): Promise<Buffer> => {
    const path = await archivePath(dirs, name)
    const body = await readFile(path)
    if (!gzip) return body
    const key = `${path}@${(await stat(path)).mtimeMs}`
    let copy = gzipped.get(key)
    if (!copy) {
      copy = gzipSync(body)
      gzipped.set(key, copy)
    }
    return copy
  }

  return (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const name = fixtureName(url.pathname, prefix)
    if (!name) return next()

    const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '')
    representation(name, gzip).then(
      (body) => {
        res.setHeader('content-type', 'application/octet-stream')
        res.setHeader('cache-control', 'no-store')
        res.setHeader('accept-ranges', 'bytes')
        res.setHeader('access-control-allow-origin', '*')
        res.setHeader('vary', 'Accept-Encoding')
        if (gzip) res.setHeader('content-encoding', 'gzip')

        answerRange(req.headers.range, res, body)
      },
      () => noSuchFixture(res)
    )
  }
}

/** Answers `rangeHeader` from `body` as a host that honours `Range` does: 200, 206 or 416. */
function answerRange(rangeHeader: string | undefined, res: ServerResponse, body: Buffer): void {
  const range = parseRangeHeader(rangeHeader, body.length)
  if (range === null) {
    res.setHeader('content-length', String(body.length))
    res.statusCode = 200
    return void res.end(body)
  }
  if (range === 'unsatisfiable') {
    res.setHeader('content-range', `bytes */${body.length}`)
    res.statusCode = 416
    return void res.end()
  }
  const piece = body.subarray(range.start, range.end + 1)
  res.setHeader('content-length', String(piece.length))
  res.setHeader('content-range', `bytes ${range.start}-${range.end}/${body.length}`)
  res.statusCode = 206
  res.end(piece)
}

/**
 * A host that honours `Range` and logs each request's `Range` header per `?log=<id>`, read at
 * `/counted/__log?log=<id>`, so a test counts a load's cost. `&etag=1` adds an `ETag` (#136).
 */
function countingHostHandler(dirs: readonly string[]): Connect.NextHandleFunction {
  const prefix = '/counted/'
  const logs = new Map<string, string[]>()

  return (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const id = url.searchParams.get('log') ?? ''
    if (url.pathname === `${prefix}__log`) {
      res.setHeader('content-type', 'application/json')
      res.setHeader('cache-control', 'no-store')
      return void res.end(JSON.stringify(logs.get(id) ?? []))
    }
    const name = fixtureName(url.pathname, prefix)
    if (!name) return next()

    const log = logs.get(id) ?? []
    logs.set(id, log)
    log.push(req.headers.range ?? '')
    archivePath(dirs, name).then((path) => readFile(path)).then(
      (body) => {
        res.setHeader('content-type', 'application/octet-stream')
        res.setHeader('cache-control', 'no-store')
        res.setHeader('accept-ranges', 'bytes')
        if (url.searchParams.get('etag')) res.setHeader('etag', `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`)
        answerRange(req.headers.range, res, body)
      },
      () => noSuchFixture(res)
    )
  }
}

/**
 * A host with an outage switch (`/stalling/__outage?ms=<n>&mode=<m>`) for tests that cut the link
 * mid-transfer: `silent` stalls, `reset` drops and answers 503. `&host=<name>` scopes it per file.
 */
function stallingHostHandler(dirs: readonly string[]): Connect.NextHandleFunction {
  const prefix = '/stalling/'
  const inFlight = new Map<ServerResponse, string>()
  const outages = new Map<string, { until: number; mode: 'silent' | 'reset' }>()

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const outageOf = (host: string) => outages.get(host) ?? { until: 0, mode: 'silent' as const }
  const inOutage = (host: string) => Date.now() < outageOf(host).until
  const waitOut = async (host: string) => {
    while (inOutage(host)) await sleep(50)
  }
  const drained = drainedOrClosed

  const serve = async (req: Connect.IncomingMessage, res: ServerResponse, name: string, rate: number, host: string) => {
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('cache-control', 'no-store')
    if (inOutage(host) && outageOf(host).mode === 'reset') {
      res.statusCode = 503
      return res.end('outage')
    }
    await waitOut(host)

    let body: Buffer
    try {
      body = await readFile(await archivePath(dirs, name))
    } catch {
      return noSuchFixture(res)
    }

    res.setHeader('content-type', 'application/octet-stream')
    res.setHeader('accept-ranges', 'bytes')
    let piece = body
    res.statusCode = 200
    const range = parseRangeHeader(req.headers.range, body.length)
    if (range === 'unsatisfiable') {
      res.setHeader('content-range', `bytes */${body.length}`)
      res.statusCode = 416
      return res.end()
    }
    if (range) {
      piece = body.subarray(range.start, range.end + 1)
      res.setHeader('content-range', `bytes ${range.start}-${range.end}/${body.length}`)
      res.statusCode = 206
    }
    res.setHeader('content-length', String(piece.length))
    if (req.method === 'HEAD') return res.end()

    inFlight.set(res, host)
    try {
      const slice = 64 * 1024
      for (let at = 0; at < piece.length && !res.destroyed; at += slice) {
        if (inOutage(host)) {
          if (outageOf(host).mode === 'reset') {
            res.destroy()
            break
          }
          await waitOut(host)
        }
        const chunk = piece.subarray(at, Math.min(at + slice, piece.length))
        if (!res.write(chunk)) await drained(res)
        if (rate > 0) await sleep((chunk.length / rate) * 1000)
      }
      if (!res.destroyed) res.end()
    } finally {
      inFlight.delete(res)
    }
  }

  return (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const host = url.searchParams.get('host') ?? ''
    if (url.pathname === `${prefix}__outage`) {
      const mode = url.searchParams.get('mode') === 'reset' ? 'reset' : 'silent'
      outages.set(host, { until: Date.now() + Number(url.searchParams.get('ms') ?? 0), mode })
      if (mode === 'reset') {
        for (const [pending, of] of inFlight) if (of === host) pending.destroy()
      }
      res.setHeader('cache-control', 'no-store')
      res.statusCode = 204
      return res.end()
    }
    const name = fixtureName(url.pathname, prefix)
    if (!name) return next()
    void serve(req, res, name, Number(url.searchParams.get('rate') ?? 0), host)
  }
}

/** `dirs` defaults to the player's generated fixtures, which is all the browser tests need. */
export function noRangeFixturesPlugin(dirs: readonly string[] = [PLAYER_FIXTURES]): Plugin {
  return {
    name: 'h5p-no-range-fixtures',
    configureServer: mount,
    // `vite preview` of the demo build as well, so the built site can be checked end to end
    // before it is deployed — the deployment gets the route from `vercel.json` instead.
    configurePreviewServer: mount
  }

  function mount(server: { middlewares: Connect.Server }): void {
    server.middlewares.use(noRangeHandler(dirs))
    server.middlewares.use(compressingHostHandler(dirs))
    server.middlewares.use(stallingHostHandler(dirs))
    server.middlewares.use(countingHostHandler(dirs))
  }
}

export { PLAYER_FIXTURES }
