#!/usr/bin/env node
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { parseArgs } from 'node:util'

const HELP = `Usage: h5p-mcp-app [--port <number>] [--host <address>] [--site <origin>] [--build <url>] [--title <name>]

The app server of H5P Author MCP by Missing Elements: an MCP server over HTTP for a chat app
that shows a card in its reply. Its endpoint is /mcp. It checks an activity's source and the
card builds and plays the activity in the person's browser. It stores nothing, logs nothing
of a request, and never asks for a file a person attached in the chat.

Options:
  --port <number>   the port to listen on; 8787 by default, or PORT from the environment
  --host <address>  the address to listen on; 127.0.0.1 by default, 0.0.0.0 for every interface
  --site <origin>   the site whose play page the card frames;
                    https://missing-elements.github.io by default
  --build <url>     the build page a chat with no card hands the source to;
                    the site's /h5p/build/ by default
  --title <name>    the name the server gives itself in a chat;
                    H5P Author MCP by Missing Elements by default
  --version
  -h, --help
`

let values
try {
  ;({ values } = parseArgs({
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      site: { type: 'string' },
      build: { type: 'string' },
      title: { type: 'string' },
      version: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }
    }
  }))
} catch (error) {
  console.error(`h5p-mcp-app: ${error instanceof Error ? error.message : error}\n\n${HELP}`)
  process.exit(2)
}
if (values.help) {
  process.stdout.write(HELP)
  process.exit(0)
}
if (values.version) {
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  process.stdout.write(`@missing-elements/h5p-mcp ${version}\n`)
  process.exit(0)
}
const port = Number(values.port ?? process.env.PORT ?? 8787)
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`h5p-mcp-app: ${values.port ?? process.env.PORT} is not a port`)
  process.exit(2)
}
if (values.site !== undefined && !URL.canParse(values.site)) {
  console.error(`h5p-mcp-app: ${values.site} is not an origin, as https://example.org`)
  process.exit(2)
}
if (values.build !== undefined && !URL.canParse(values.build)) {
  console.error(`h5p-mcp-app: ${values.build} is not an address, as https://example.org/h5p/build/`)
  process.exit(2)
}
const host = values.host ?? '127.0.0.1'

// Loaded only now, so that --help and --version answer without loading the pack.
const { createApp } = await import('../lib/app.mjs')
const app = await createApp({ site: values.site, build: values.build, title: values.title })

// One HTTP request, as the web's Request and Response, to the app and back. Nothing of it is
// written anywhere: not its address, not its body, not how it was answered.
const listening = createServer(async (req, res) => {
  try {
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : /** @type {ReadableStream<Uint8Array>} */ (Readable.toWeb(req))
    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
    const request = new Request(new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`), { method: req.method, headers, body, duplex: 'half' })
    const response = await app.fetch(request)
    res.writeHead(response.status, Object.fromEntries(response.headers))
    if (!response.body) return void res.end()
    // A stream that is given up on, by either end, ends the other.
    res.on('close', () => { void response.body?.cancel().catch(() => {}) })
    for await (const chunk of response.body) res.write(chunk)
    res.end()
  } catch {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(res.writableEnded ? undefined : 'The request could not be answered\n')
  }
})
listening.listen(port, host, () => {
  const at = /** @type {import('node:net').AddressInfo} */ (listening.address())
  console.log(`h5p-mcp-app ${app.version} on http://${at.address.includes(':') ? `[${at.address}]` : at.address}:${at.port}/mcp, framing ${values.site ?? 'https://missing-elements.github.io'}`)
})
const stop = () => {
  listening.close()
  void app.close().finally(() => process.exit(0))
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
