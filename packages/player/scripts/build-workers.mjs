import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { transform } from 'esbuild'
import { buildJobsWorker, buildMountModule, buildPlanModule, buildServiceWorker, playerNotice } from './lib/worker-bundle.mjs'

/**
 * Builds what Vite's library build cannot: the worker and plan files in `dist/`. `h5p-sw.js` is a
 * classic script, as a Service Worker is registered by URL on a site with no build step.
 */

const rootDir = resolve(import.meta.dirname, '..')
const distDir = resolve(rootDir, 'dist')

await buildServiceWorker(resolve(distDir, 'h5p-sw.js'))
await buildMountModule(resolve(distDir, 'h5p-sw-mount.js'))
await buildJobsWorker(resolve(distDir, 'h5p-jobs.js'))
await buildPlanModule(resolve(distDir, 'h5p-plan.js'))

// Vite keeps an ES library's whitespace so `/* @__PURE__ */` survives for tree-shaking; this module
// registers the element on import, so nothing is shaken out and it is minified here, after Vite.
const elementPath = resolve(distDir, 'h5p-player.js')
const element = await readFile(elementPath, 'utf8')
const minified = await transform(element, { minify: true, format: 'esm', target: 'es2022', legalComments: 'none' })
// With the package's notice in front, as the workers have: see `playerNotice`.
await writeFile(elementPath, `${await playerNotice()}\n${minified.code}`)

const sizeOf = async (name) => {
  const contents = await readFile(resolve(distDir, name))
  return `${name} ${(contents.length / 1024).toFixed(1)} kB`
}

// A manifest the troubleshooting guide can point at: "does your h5p-sw.js match your element?"
const packageJson = JSON.parse(await readFile(resolve(rootDir, 'package.json'), 'utf8'))
await writeFile(
  resolve(distDir, 'VERSION'),
  `${packageJson.version}\n`,
  'utf8'
)

// Copied as they are, so the pages around the player (verify's preview, the extension, the demo)
// import `@missing-elements/h5p-offline-player/page.css` and nothing drifts.
for (const name of ['page.css', 'mark.svg']) await copyFile(resolve(rootDir, 'page', name), resolve(distDir, name))

console.log(`[build-workers] ${await sizeOf('h5p-player.js')} (minified after Vite), ${await sizeOf('h5p-sw.js')}, ${await sizeOf('h5p-sw-mount.js')}, ${await sizeOf('h5p-jobs.js')}, ${await sizeOf('h5p-plan.js')}, ${await sizeOf('page.css')}`)
