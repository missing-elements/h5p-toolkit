import { createHash } from 'node:crypto'
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { build as viteBuild } from 'vite'
import { buildJobsWorker, buildServiceWorker, bundleHostWorker } from '../../../packages/player/scripts/lib/worker-bundle.mjs'
import { DIST_DIR as RUNTIME_DIST } from '../../../packages/runtime/scripts/build.mjs'
import { PAGES } from './lib/pages.mjs'

const RESIZER = resolve(import.meta.dirname, '../../../packages/embed/site/resizer.js')

/**
 * Builds the hosted demo into `dist-demo/`: the pages, workers, demo content, and the runtime in
 * `frame-assets/`, where the element looks by default. `sync:assets` runs first, to build it.
 */

const rootDir = resolve(import.meta.dirname, '..')
const outDir = resolve(rootDir, 'dist-demo')

// The origin the pages' absolute URLs use: given, or Vercel's production URL, or the preview.
const siteUrl = (
  process.env.SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : 'http://localhost:4173')
).replace(/\/$/, '')
process.env.SITE_URL = siteUrl

await viteBuild({ configFile: resolve(rootDir, 'vite.config.ts') })

await buildServiceWorker(resolve(outDir, 'h5p-sw.js'))
await buildJobsWorker(resolve(outDir, 'h5p-jobs.js'))

await rm(resolve(outDir, 'frame-assets'), { recursive: true, force: true })
await cp(RUNTIME_DIST, resolve(outDir, 'frame-assets'), { recursive: true })

// The demo content only, not the player's `public/fixtures/`: those are test stubs.
const contentDir = resolve(rootDir, 'demo', 'content')
const packages = (await readdir(contentDir)).filter((name) => name.endsWith('.h5p'))
await mkdir(resolve(outDir, 'demo', 'content'), { recursive: true })
for (const name of packages) {
  await cp(resolve(contentDir, name), resolve(outDir, 'demo', 'content', name))
}

// The installable app, `/app/`. Its manifest, icons and screenshots are copied as they are: the
// page links the manifest with `vite-ignore`, and the manifest names the rest relative to itself.
await cp(resolve(rootDir, 'app', 'manifest.webmanifest'), resolve(outDir, 'app', 'manifest.webmanifest'))
await cp(resolve(rootDir, 'app', 'icons'), resolve(outDir, 'app', 'icons'), { recursive: true })
await cp(resolve(rootDir, 'app', 'screenshots'), resolve(outDir, 'app', 'screenshots'), { recursive: true })
// The pack's archives are not copied here: the page imports the pack, so Vite emits them under
// `assets/` and the precache below picks them up from the manifest.

/**
 * What the app needs offline: its page and what Vite's manifest lists (the real hashed names),
 * `frame-assets/`, manifest and icons. Their hash is the version, so the worker updates with them.
 */
async function appPrecache() {
  const manifestPath = resolve(outDir, '.vite', 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  await rm(resolve(outDir, '.vite'), { recursive: true, force: true })

  const files = new Set()
  const walk = (key) => {
    const chunk = manifest[key]
    if (!chunk || files.has(chunk.file)) return
    files.add(chunk.file)
    for (const name of [...(chunk.css ?? []), ...(chunk.assets ?? [])]) files.add(name)
    for (const next of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]) walk(next)
  }
  walk('app/index.html')

  const page = await readFile(resolve(outDir, 'app', 'index.html'), 'utf8')
  // Only what the page loads — its stylesheets, icon and scripts — not where its links lead.
  for (const [, url] of page.matchAll(/<(?:link|script)\b[^>]*?\b(?:src|href)="\/([^"]+)"/g)) files.add(url)

  const under = async (dir) => (await readdir(resolve(outDir, dir), { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(outDir, resolve(entry.parentPath, entry.name)).split(sep).join('/'))
  for (const name of [...(await under('frame-assets')), ...(await under('app'))]) files.add(name)
  // The app's page is English, so its frame never asks for the runtime's translations.
  files.delete('frame-assets/l10n.js')
  // The manifest's screenshots are for the install dialog, which shows them before there is an app.
  for (const name of files) if (name.startsWith('app/screenshots/')) files.delete(name)

  // The page is cached under its directory URL, the one the app is opened at.
  files.delete('app/index.html')
  const paths = ['app/index.html', ...[...files].sort()]
  const hash = createHash('sha256')
  for (const path of paths) hash.update(path).update(await readFile(resolve(outDir, path)))
  return { version: hash.digest('hex').slice(0, 12), urls: ['/app/', ...[...files].sort().map((name) => `/${name}`)] }
}

// theme.js and stars.js run before the first paint, so pages link them as classic scripts (Vite
// bundles modules only). Copied before the precache is read: the app page links them too.
for (const name of ['theme.js', 'stars.js']) await cp(resolve(rootDir, 'demo', name), resolve(outDir, 'demo', name))
// The resizer protocol's page-side script for sites that frame /embed, at the site root where the
// embed snippets name it, so an embedding page sends nothing to h5p.org. The embed package's copy.
await cp(RESIZER, resolve(outDir, 'resizer.js'))

const precache = await appPrecache()
await writeFile(
  resolve(outDir, 'app', 'sw.js'),
  await bundleHostWorker(resolve(rootDir, 'app', 'sw.js'), { define: { __APP_PRECACHE__: JSON.stringify(precache) } })
)

// What crawlers and link previews ask for. `/embed` is left out: it carries `noindex`.
await cp(resolve(rootDir, 'demo', 'og-image.png'), resolve(outDir, 'demo', 'og-image.png'))
// The course structure the cmi5 page offers for importing into an LMS, zipped as LMSs want it.
await cp(resolve(rootDir, 'demo', 'cmi5-course.zip'), resolve(outDir, 'demo', 'cmi5-course.zip'))
const pages = PAGES.filter((page) => page.indexed !== false).map((page) => page.path)
const today = new Date().toISOString().slice(0, 10)
await writeFile(
  resolve(outDir, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages
    .map((page) => `  <url><loc>${siteUrl}${page}</loc><lastmod>${today}</lastmod></url>`)
    .join('\n')}\n</urlset>\n`
)
await writeFile(resolve(outDir, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}/sitemap.xml\n`)

const sizeOf = async (name) => `${name} ${((await readFile(resolve(outDir, name))).length / 1024).toFixed(1)} kB`
console.log(`[build-demo] ${await sizeOf('h5p-player.js')}, ${await sizeOf('h5p-sw.js')}, ${packages.length} content packages, frame assets -> dist-demo/ (site URL ${siteUrl})`)
console.log(`[build-demo] ${await sizeOf('app/sw.js')}, precaching ${precache.urls.length} files, version ${precache.version}`)
