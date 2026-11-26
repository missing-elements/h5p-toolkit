import { openAsBlob } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { BlobReader, BlobWriter, TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter, configure } from '@zip.js/zip.js'
import { formatBytes, normalizeArchive } from '@missing-elements/h5p-normalize'
// The rule h5p-author checks its packages by and `apps/skills` checks every example with, reached
// by path as build-libraries.mjs reaches the pack's scripts.
import { missingForInstall } from '../../../packages/author/lib/install.mjs'
import { download, hubBundle as cachedBundle } from './lib/hub.mjs'

/**
 * Builds the demo's packages from `demo/content/src/<name>/` into `demo/content/<name>.h5p`, with
 * the hub's libraries; `"stripped": true` is a content-only export. Committed: no hub at deploy.
 */

configure({ useWebWorkers: false })

const rootDir = resolve(import.meta.dirname, '..')
const sourceRoot = resolve(rootDir, 'demo', 'content', 'src')
const outDir = resolve(rootDir, 'demo', 'content')

const args = process.argv.slice(2)
const refresh = args.includes('--refresh')
const only = args.filter((arg) => !arg.startsWith('--'))

const names = (await readdir(sourceRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && (only.length === 0 || only.includes(entry.name)))
  .map((entry) => entry.name)
  .sort()

if (names.length === 0) {
  console.error(`[demo-content] nothing to build under ${relative(rootDir, sourceRoot)}`)
  process.exit(1)
}

// Declared before the loop below, which runs as the module loads.
const LOG = '[demo-content]'

/** The hub's bundle for a content type, from the cache when it is there. */
const hubBundle = (machineName) => cachedBundle(machineName, { refresh, log: LOG })

/** Media by URL, cached the same way, keyed on the file name. */
const fetched = async (url) => readFile(/** @type {string} */ (await download(url, basename(new URL(url).pathname), { refresh, log: LOG })))

const work = await mkdtemp(join(tmpdir(), 'h5p-demo-content-'))

try {
  for (const name of names) await buildPackage(name)
} finally {
  await rm(work, { recursive: true, force: true })
}

/** @param {string} name */
async function buildPackage(name) {
  const sourceDir = join(sourceRoot, name)
  const manifest = JSON.parse(await readFile(join(sourceDir, 'manifest.json'), 'utf8'))
  const content = JSON.parse(await readFile(join(sourceDir, 'content.json'), 'utf8'))

  const bundlePath = await hubBundle(manifest.mainLibrary)
  const bundle = new ZipReader(new BlobReader(await openAsBlob(bundlePath)))
  const entries = (await bundle.getEntries({ filenameValidation: 'tolerant' })).filter((entry) => !entry.directory)

  // The libraries the content needs: the main library's dependency tree and that of each
  // sub-content library the params name. Besides the upload check's (below), nothing else goes in.
  const libraryJsons = new Map()
  for (const entry of entries) {
    const match = /^([^/]+)\/library\.json$/.exec(entry.filename)
    if (match) libraryJsons.set(match[1], JSON.parse(new TextDecoder().decode(await entry.getData(new Uint8ArrayWriter()))))
  }
  // A bundle can carry two minors of a library (QuestionSet's has H5P.Question 1.4 and 1.5): keep
  // the newest, since the zip's last one shipped 1.4 to libraries that require 1.5.
  const version = (library) => [library.majorVersion, library.minorVersion, library.patchVersion ?? 0]
  const newer = (a, b) => {
    const [x, y] = [version(a), version(b)]
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
    return false
  }
  const byMachineName = new Map()
  for (const library of libraryJsons.values()) {
    const current = byMachineName.get(library.machineName)
    if (!current || newer(library, current)) byMachineName.set(library.machineName, library)
  }
  const needed = new Map()
  const visit = (machineName) => {
    if (needed.has(machineName)) return
    const library = byMachineName.get(machineName)
    if (!library) throw new Error(`${name}: ${machineName} is not in the hub bundle for ${manifest.mainLibrary}`)
    needed.set(machineName, library)
    for (const dependency of [...(library.preloadedDependencies ?? []), ...(library.dynamicDependencies ?? [])]) visit(dependency.machineName)
  }
  visit(manifest.mainLibrary)
  for (const used of JSON.stringify(content).matchAll(/"library":\s*"([^" ]+) (\d+)\.(\d+)"/g)) visit(used[1])

  const folderOf = (library) => `${library.machineName}-${Number(library.majorVersion)}.${Number(library.minorVersion)}`
  const folders = new Set([...needed.values()].map(folderOf))

  // The upload check (#146) wants every dependency a carried library names, editor ones too, at its
  // exact major.minor, and theirs in turn: the bundle holds that closure, older minors included.
  /** @type {Set<string>} */
  const install = new Set()
  if (!manifest.stripped) {
    const queue = [...needed.values()]
    while (queue.length > 0) {
      const library = queue.shift()
      for (const dependency of [...(library.preloadedDependencies ?? []), ...(library.dynamicDependencies ?? []), ...(library.editorDependencies ?? [])]) {
        const folder = folderOf(dependency)
        if (folders.has(folder) || install.has(folder)) continue
        const found = libraryJsons.get(folder)
        if (!found) throw new Error(`${name}: ${folder} is not in the hub bundle for ${manifest.mainLibrary}, which ${folderOf(library)} needs to install on an H5P site`)
        install.add(folder)
        queue.push(found)
      }
    }
    // The same rule as h5p-author's check, over what is about to be written.
    const missing = missingForInstall([...needed.values(), ...[...install].map((folder) => libraryJsons.get(folder))])
    if (missing.length > 0) throw new Error(`${name}: an H5P site would refuse it for ${missing.map(({ library, needs }) => `${library} without ${needs}`).join(', ')}`)
  }

  const h5pJson = {
    title: manifest.title,
    language: 'en',
    defaultLanguage: 'en',
    mainLibrary: manifest.mainLibrary,
    embedTypes: ['div'],
    license: manifest.license ?? 'U',
    ...(manifest.licenseVersion ? { licenseVersion: manifest.licenseVersion } : {}),
    ...(manifest.authors ? { authors: manifest.authors } : {}),
    ...(manifest.source ? { source: manifest.source } : {}),
    preloadedDependencies: [...needed.values()]
      .filter((library) => !manifest.stripped || library.machineName === manifest.mainLibrary)
      .map((library) => ({
        machineName: library.machineName,
        majorVersion: String(library.majorVersion),
        minorVersion: String(library.minorVersion)
      }))
  }

  const writer = new ZipWriter(new BlobWriter('application/zip'))
  await writer.add('h5p.json', new TextReader(JSON.stringify(h5pJson)))
  await writer.add('content/content.json', new TextReader(JSON.stringify(content)))

  // Media beside the source, and media a manifest fetches by URL.
  for (const file of await listFiles(sourceDir)) {
    if (file === 'manifest.json' || file === 'content.json') continue
    await writer.add(`content/${file}`, new Uint8ArrayReader(new Uint8Array(await readFile(join(sourceDir, file)))))
  }
  for (const [path, url] of Object.entries(manifest.fetch ?? {})) {
    await writer.add(`content/${path}`, new Uint8ArrayReader(new Uint8Array(await fetched(url))))
  }

  // The libraries that play, then the upload check's, which the normalizer writes last (`last`) so
  // a host that ignores `Range` boots before they arrive.
  let libraryBytes = 0
  let installBytes = 0
  for (const wanted of [folders, install]) {
    for (const entry of entries) {
      const folder = entry.filename.slice(0, entry.filename.indexOf('/'))
      if (manifest.stripped || !wanted.has(folder)) continue
      const bytes = await entry.getData(new Uint8ArrayWriter())
      if (wanted === folders) libraryBytes += bytes.length
      else installBytes += bytes.length
      await writer.add(entry.filename, new Uint8ArrayReader(bytes), { lastModDate: entry.lastModDate })
    }
  }
  await bundle.close()

  const assembled = join(work, `${name}.h5p`)
  await writeFile(assembled, new Uint8Array(await (await writer.close()).arrayBuffer()))

  await mkdir(outDir, { recursive: true })
  const output = join(outDir, `${name}.h5p`)
  const report = await normalizeArchive({ input: assembled, output, last: [...install] })

  console.log(
    `[demo-content] ${name}.h5p ${formatBytes(report.bytesOut ?? 0)}: ${manifest.mainLibrary}, ` +
      (manifest.stripped
        ? 'content only, '
        : `${folders.size} libraries (${formatBytes(libraryBytes)} uncompressed)` +
          (install.size ? ` and ${install.size} more for an H5P site's upload check (${formatBytes(installBytes)}), ` : ', ')) +
      `${report.entries.filter((entry) => entry.target === 'store').length} media entries stored` +
      (report.entries.some((entry) => entry.action === 'faststart') ? ', mp4 index moved to front' : '')
  )
}

async function listFiles(dir, prefix = '') {
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) found.push(...(await listFiles(join(dir, entry.name), name)))
    else found.push(name)
  }
  return found
}

