import { readFileSync } from 'node:fs'
import { createApp } from '@missing-elements/h5p-mcp/app'
import mcp from '@missing-elements/h5p-mcp/package.json' with { type: 'json' }

/**
 * The app server (`h5p-mcp-app`, design/mcp.md) as a Worker: its files ride in as modules under
 * `/bundle`. It receives a chat's tool calls and never a file, and stores or logs nothing of one.
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
