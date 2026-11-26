import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { verifyPackage } from '@missing-elements/h5p-verify'
import { playwright } from '@vitest/browser-playwright'
import { configDefaults, defineConfig } from 'vitest/config'
import type { BrowserCommand } from 'vitest/node'

// The pack the build pins, which the verifier plays an untrusted package against, as a site with it does.
const parts = resolve(import.meta.dirname, '../libraries/parts')

/**
 * A package the page's build wrote in Chromium, given to Node as base64 and played untrusted by the
 * verifier: its verdict, warnings and what the content check changed.
 */
const playUntrusted: BrowserCommand<[name: string, base64: string]> = async (_context, name, base64) => {
  const dir = await mkdtemp(join(tmpdir(), 'h5p-author-page-'))
  try {
    const file = join(dir, name)
    await writeFile(file, Buffer.from(base64, 'base64'))
    const { verdict, reasons, warnings, errors, state, untrusted, contentCheck } = await verifyPackage({ file, untrusted: true, libraries: parts, settle: 500 })
    return { verdict, reasons, warnings, errors, state, untrusted, contentCheck }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** The demo's video, a real one: the verifier warns of one that does not play. */
const clipFile = resolve(import.meta.dirname, '../../apps/demo/demo/content/src/video/videos/big-buck-bunny.mp4')

/**
 * A video at a web address of its own (#263): a server on another origin, answering for part of the
 * file with no CORS header. `serveClip` starts it, `clipAsked` gives each `Range` and stops it.
 */
let clip: { server: Server, asked: string[] } | undefined
const serveClip: BrowserCommand<[]> = async () => {
  const bytes = await readFile(clipFile)
  const asked: string[] = []
  const server = createServer((request, response) => {
    asked.push(request.headers.range ?? 'whole')
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
    const head = { 'content-type': 'video/mp4', 'accept-ranges': 'bytes' }
    if (!range) return void response.writeHead(200, { ...head, 'content-length': bytes.length }).end(bytes)
    const start = Number(range[1])
    const end = range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1
    if (start > end) return void response.writeHead(416, { 'content-range': `bytes */${bytes.length}` }).end()
    response.writeHead(206, { ...head, 'content-range': `bytes ${start}-${end}/${bytes.length}`, 'content-length': end - start + 1 }).end(bytes.subarray(start, end + 1))
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  clip = { server, asked }
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/clip.mp4?sig=abc`
}
const clipAsked: BrowserCommand<[]> = async () => {
  const asked = clip?.asked ?? []
  clip?.server.close()
  clip = undefined
  return asked
}

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          exclude: [...configDefaults.exclude, 'tests/browser/**'],
          setupFiles: ['tests/helpers/oembed.ts'],
          // The package's limit, no test's own (design/testing.md, #255): these build from the
          // pack, 2 to 4 times slower on CI than a laptop; three failed on vitest's 5 s.
          testTimeout: 120_000,
          hookTimeout: 120_000
        }
      },
      {
        // Served from its own folder, so that each part's URL, a `new URL` beside the pack's index,
        // is a file there rather than in Vite's bundle of dependencies.
        optimizeDeps: { exclude: ['@missing-elements/h5p-libraries'] },
        test: {
          name: 'browser',
          include: ['tests/browser/**/*.test.ts'],
          // This project's limit, longer than the Node one: a test here builds in Chromium and
          // plays the result in the verifier. A project takes nothing from the other.
          testTimeout: 180_000,
          hookTimeout: 180_000,
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
            commands: { playUntrusted, serveClip, clipAsked }
          }
        }
      }
    ]
  }
})
