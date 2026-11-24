import { readFileSync } from 'node:fs'
import { createApp } from '@missing-elements/h5p-mcp/app'
import mcp from '@missing-elements/h5p-mcp/package.json' with { type: 'json' }

/**
 * The app server (`h5p-mcp-app`, design/mcp.md) as a Cloudflare Worker: the same handler, in a
 * runtime with no package folders. What the server reads as it runs rides in the Worker and
 * shows in its file system under `/bundle` (`wrangler.jsonc`, `scripts/stage.mjs`): the library
 * pack's parts, the author package's type files and brief, and the card.
 *
 * It receives a chat's tool calls, an activity's source among them, and never a file. The server
 * stores and logs nothing of a call, this file adds nothing, and the Worker's own logs are off
 * in its config.
 */

/** Where a Worker's modules are files. */
const CARRIED = '/bundle'

/** @type {ReturnType<typeof createApp> | undefined} */
let app

export default {
  /**
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  async fetch(request) {
    let server
    try {
      // Started by the first call and kept while the Worker lives. One that failed to start is
      // started again by the next call.
      app ??= createApp({
        version: mcp.version,
        card: readFileSync(`${CARRIED}/card.html`, 'utf8'),
        libraries: `${CARRIED}/parts`,
        references: `${CARRIED}/references`
      })
      server = await app
    } catch {
      app = undefined
      // Said plainly and with nothing of the failure in it: it is the Worker's, not the caller's.
      return new Response('The server could not start\n', { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } })
    }
    return server.fetch(request)
  }
}
