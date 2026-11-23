import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
 * A package the page's build wrote in Chromium, handed to Node as base64 and played by the verifier
 * untrusted, as a site that did not make it plays it: the report's verdict, what it warns of, and
 * what the content check changed.
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

/**
 * A video at a web address of its own, for a build that leaves it there (#263): a server on another
 * origin than the player's, answering for a part of the file and sending no CORS header, as a file
 * store answers a video element. `serveClip` starts it with the bytes and gives the address,
 * `clipAsked` gives the `Range` of each request it got and stops it.
 */
let clip: { server: Server, asked: string[] } | undefined
const serveClip: BrowserCommand<[base64: string]> = async (_context, base64) => {
  const bytes = Buffer.from(base64, 'base64')
  const asked: string[] = []
  const server = createServer((request, response) => {
    asked.push(request.headers.range ?? 'whole')
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
    const head = { 'content-type': 'video/mp4', 'accept-ranges': 'bytes' }
    if (!range) return void response.writeHead(200, { ...head, 'content-length': bytes.length }).end(bytes)
    const start = Number(range[1])
    const end = range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1
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
          // The package's limit, and no test's own (design/testing.md, #255). These tests build
          // packages from the library pack and write every content type's bundle, which a CI
          // runner does two to four times slower than a laptop: on vitest's 5 s a test, three
          // of them failed there in three days, each after the one before it got its own number.
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
          // plays the result in the verifier. Named here because a project takes nothing from
          // the other.
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
