import { Readable } from 'node:stream'

/**
 * Vercel's static files honour `Range`, so this stands in for a host that ignores it: `200`, the
 * whole body. Demo content only; dev and preview have it in the player's `vite.plugins.ts`.
 */

export const config = { supportsResponseStreaming: true }

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 */
export default async function handler(request, response) {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const name = url.searchParams.get('name') ?? ''
  if (!/^[\w.-]+\.h5p$/.test(name)) {
    response.statusCode = 400
    response.end('bad fixture name')
    return
  }

  const origin = deploymentOrigin(request)
  /** @type {Record<string, string>} */
  const headers = {}
  // A protected preview answers an anonymous fetch with its login page, so the bypass secret goes
  // along, only to Vercel's own hosts, whatever the origin turned out to be.
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET
  if (secret && new URL(origin).hostname.endsWith('.vercel.app')) {
    headers['x-vercel-protection-bypass'] = secret
  }

  const upstream = await fetch(`${origin}/demo/content/${name}`, { headers })
  if (!upstream.ok || !upstream.body) {
    response.statusCode = 404
    response.end('no such fixture')
    return
  }

  response.statusCode = 200
  response.setHeader('content-type', 'application/zip')
  response.setHeader('cache-control', 'no-store')
  // `fetch` has already undone any transfer encoding, so the upstream length only holds when
  // there was none.
  const length = upstream.headers.get('content-length')
  if (length && !upstream.headers.get('content-encoding')) response.setHeader('content-length', length)

  Readable.fromWeb(/** @type {any} */ (upstream.body)).pipe(response)
}

/**
 * Where this deployment's static files are, from Vercel's environment, not the request: the
 * production domain, or a preview's own URL. `Host` is the fallback for `vercel dev`.
 *
 * @param {import('node:http').IncomingMessage} request
 */
function deploymentOrigin(request) {
  const { VERCEL_ENV, VERCEL_PROJECT_PRODUCTION_URL, VERCEL_URL } = process.env
  if (VERCEL_ENV === 'production' && VERCEL_PROJECT_PRODUCTION_URL) return `https://${VERCEL_PROJECT_PRODUCTION_URL}`
  if (VERCEL_URL) return `https://${VERCEL_URL}`
  return `http://${String(request.headers.host ?? 'localhost')}`
}
