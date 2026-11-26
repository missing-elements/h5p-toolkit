import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BlobWriter, TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter, configure } from '@zip.js/zip.js'

/**
 * Splits the pack into `parts/<folder>.h5p` and `parts/index.json`, so the player fetches only the
 * parts a package needs; also writes `index.js` and `install.js`, the modules a bundler resolves.
 */

configure({ useWebWorkers: false })

const packageDir = resolve(import.meta.dirname, '..')

/**
 * The `h5p.json` the pack and every part carry. The player refuses an archive without one, and an
 * archive registered to supply libraries is never held to what it declares.
 */
const PART_MANIFEST =JSON.stringify({ title: 'H5P Offline Player library pack', language: 'und', mainLibrary: '', preloadedDependencies: [], embedTypes: ['div'] })

/**
 * Every entry's date, so the bytes change only when a library does. A zip has no zone and zip.js
 * takes local fields, so this uses them (#48, #51), at 02:00 as pack 1.0.0 did.
 */
export const FIXED_DATE = new Date(2000, 0, 1, 2)

/**
 * A bundler inlines an asset under 4 kB (Vite) or 8 kB (webpack) as a `data:` URL, which a page's
 * `connect-src` refuses to fetch, so a smaller part is padded to this with its archive comment.
 */
const MIN_PART_SIZE = 8 * 1024 + 1

/**
 * Writes the pack: `h5p.json`, then each library's files. One whose files `previous` already holds
 * keeps its entries as they were: the hub's file order varies, and rewrote 30 parts once (#116).
 * @param {{ folder: string, files: Map<string, Uint8Array> }[]} libraries each folder's files, by their names in the pack
 * @param {Uint8Array} [previous] the pack this one replaces
 */
export async function writePack(libraries, previous) {
  const reader = previous ? new ZipReader(new Uint8ArrayReader(previous)) : null
  const before = new Map()
  for (const entry of reader ? await reader.getEntries() : []) {
    const slash = entry.filename.indexOf('/')
    if (entry.directory || slash < 0) continue
    const folder = entry.filename.slice(0, slash)
    if (!before.has(folder)) before.set(folder, [])
    before.get(folder).push(entry)
  }

  const writer = new ZipWriter(new BlobWriter('application/zip'), { lastModDate: FIXED_DATE, extendedTimestamp: false })
  await writer.add('h5p.json', new TextReader(PART_MANIFEST))
  for (const { folder, files } of libraries) {
    const kept = before.get(folder)
    if (kept && (await holds(kept, files))) {
      for (const entry of kept) {
        const raw = await entry.getData(new Uint8ArrayWriter(), { passThrough: true })
        await writer.add(entry.filename, new Uint8ArrayReader(raw), { passThrough: true, entry })
      }
    } else {
      for (const [name, bytes] of files) await writer.add(name, new Uint8ArrayReader(bytes))
    }
  }
  await reader?.close()
  return new Uint8Array(await (await writer.close()).arrayBuffer())
}

/** Whether a folder's entries in a pack hold exactly these files, by name and bytes. */
async function holds(entries, files) {
  if (entries.length !== files.size) return false
  for (const entry of entries) {
    const bytes = files.get(entry.filename)
    if (!bytes || bytes.length !== entry.uncompressedSize) return false
    if (Buffer.compare(await entry.getData(new Uint8ArrayWriter()), bytes) !== 0) return false
  }
  return true
}

/**
 * Writes `<outDir>/<folder>.h5p` for every library folder in the pack and `<outDir>/index.json`,
 * replacing whatever `outDir` held. Returns the index's entries.
 * @param {Uint8Array} pack the pack's bytes
 * @param {string} outDir
 */
export async function splitPack(pack, outDir) {
  const reader = new ZipReader(new Uint8ArrayReader(pack))
  const folders = new Map()
  for (const entry of await reader.getEntries()) {
    if (entry.directory) continue
    const slash = entry.filename.indexOf('/')
    if (slash < 0) continue
    const folder = entry.filename.slice(0, slash)
    if (!folders.has(folder)) folders.set(folder, [])
    folders.get(folder).push(entry)
  }

  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  // Every folder's `library.json` first: whether a library is carried for an H5P site's upload
  // check only is decided against the pack as a whole (`installOnly`).
  const read = []
  for (const [folder, entries] of [...folders].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!/^[A-Za-z0-9._-]+-\d+\.\d+$/.test(folder)) throw new Error(`${folder} is not a versioned library folder`)
    const libraryEntry = entries.find((entry) => entry.filename === `${folder}/library.json`)
    if (!libraryEntry) throw new Error(`${folder} has no library.json`)
    const library = JSON.parse(new TextDecoder().decode(await libraryEntry.getData(new Uint8ArrayWriter())))
    if (folder !== `${library.machineName}-${library.majorVersion}.${library.minorVersion}`) {
      throw new Error(`${folder}/library.json names ${library.machineName} ${library.majorVersion}.${library.minorVersion}`)
    }
    read.push({ folder, entries, library })
  }
  const newestMinor = new Map()
  for (const { library } of read) {
    const key = `${library.machineName}-${library.majorVersion}`
    newestMinor.set(key, Math.max(newestMinor.get(key) ?? -1, Number(library.minorVersion)))
  }

  const index = []
  for (const { folder, entries, library } of read) {
    const write = async (comment) => {
      const writer = new ZipWriter(new BlobWriter('application/zip'), { lastModDate: FIXED_DATE, extendedTimestamp: false })
      await writer.add('h5p.json', new TextReader(PART_MANIFEST))
      for (const entry of entries) {
        const raw = await entry.getData(new Uint8ArrayWriter(), { passThrough: true })
        await writer.add(entry.filename, new Uint8ArrayReader(raw), { passThrough: true, entry })
      }
      return new Uint8Array(await (await writer.close(comment)).arrayBuffer())
    }
    let bytes = await write()
    if (bytes.length < MIN_PART_SIZE) bytes = await write(padding(MIN_PART_SIZE - bytes.length))
    await writeFile(join(outDir, `${folder}.h5p`), bytes)

    const preloaded = dependenciesOf(library.preloadedDependencies)
    const dynamic = dependenciesOf(library.dynamicDependencies)
    const editor = dependenciesOf(library.editorDependencies)
    index.push({
      folder,
      machineName: library.machineName,
      majorVersion: Number(library.majorVersion),
      minorVersion: Number(library.minorVersion),
      patchVersion: Number(library.patchVersion ?? 0),
      ...(preloaded.length ? { preloadedDependencies: preloaded } : {}),
      ...(dynamic.length ? { dynamicDependencies: dynamic } : {}),
      ...(editor.length ? { editorDependencies: editor } : {}),
      ...(library.addTo ? { addTo: library.addTo } : {}),
      ...(installOnly(library, newestMinor.get(`${library.machineName}-${library.majorVersion}`)) ? { installOnly: true } : {}),
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex')
    })
  }
  await reader.close()

  await checkParts(outDir, index)
  // One library a line, so a refresh's diff reads as the libraries it changed.
  await writeFile(join(outDir, 'index.json'), `{"libraries": [\n${index.map((entry) => `  ${JSON.stringify(entry)}`).join(',\n')}\n]}\n`)
  return index
}

/**
 * Whether a library is carried only for an H5P site's upload check, never played: an editor
 * library or an older minor the player replaces. The validator wants exact dependencies (#146).
 * @param {{ machineName: string, minorVersion: number | string }} library its `library.json`
 * @param {number} newestMinor the pack's newest minor of the library's major
 */
export function installOnly(library, newestMinor) {
  return library.machineName.startsWith('H5PEditor.') || Number(library.minorVersion) < newestMinor
}

/** A `library.json` dependency list, each entry's version as numbers. */
function dependenciesOf(list) {
  return (Array.isArray(list) ? list : []).map(({ machineName, majorVersion, minorVersion }) => ({
    machineName,
    majorVersion: Number(majorVersion),
    minorVersion: Number(minorVersion)
  }))
}

/** An archive comment of `length` bytes, ASCII, saying what it is for. */
function padding(length) {
  const text = 'Padding, so that a bundler does not inline this part as a data: URL. '
  return new TextEncoder().encode(text.repeat(Math.ceil(length / text.length)).slice(0, length))
}

/** Reads every part back, each entry's bytes checked against its CRC-32, so a bad copy stops the build. */
async function checkParts(outDir, index) {
  for (const { folder } of index) {
    const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(await readFile(join(outDir, `${folder}.h5p`)))))
    for (const entry of await reader.getEntries()) {
      if (!entry.directory) await entry.getData(new Uint8ArrayWriter(), { checkSignature: true })
    }
    await reader.close()
  }
}

/**
 * Writes into `dir` the modules a bundler resolves: `index.js`, the `pack` of the libraries played,
 * and `install.js`, with the `installOnly` ones too, each part a static `new URL`; and `.d.ts`s.
 * @param {Array<object>} index
 * @param {string} dir the package directory
 * @param {string} name the package's name, for the pre-bundling fix below
 */
export async function writePackModule(index, dir = packageDir, name = '@missing-elements/h5p-libraries') {
  const url = (folder) => `unbundled(new URL(${JSON.stringify(`./parts/${folder}.h5p`)}, import.meta.url).href)`
  const list = (entries) => entries.map((entry) => `    { ...${JSON.stringify(entry)}, url: ${url(entry.folder)} }`).join(',\n')
  const header = `// Written by scripts/parts.mjs. Do not edit; run \`pnpm parts\` in packages/libraries.

// Vite's dev server pre-bundles dependencies into \`node_modules/.vite/deps/\`, where these URLs
// point at files never put there: one that landed in it is pointed back at the real path.
const VITE_DEPS = '/node_modules/.vite/deps/'
const PACKAGE_DIR = ${JSON.stringify(`/node_modules/${name}/`)}

function unbundled(href) {
  const url = new URL(href)
  const at = url.pathname.indexOf(VITE_DEPS)
  if (at < 0) return href
  url.pathname = url.pathname.slice(0, at) + PACKAGE_DIR + url.pathname.slice(at + VITE_DEPS.length)
  url.search = ''
  return url.href
}
`
  const played = index.filter((entry) => !entry.installOnly)
  const carried = index.filter((entry) => entry.installOnly)
  const module = `${header}
/**
 * The library pack, for \`<h5p-player>\`'s \`pack\` property: each library the player serves and its
 * part's URL (a static \`new URL\`, so a bundler emits it). The rest are in \`install.js\`.
 */
export const pack = {
  libraries: [
${list(played)}
  ]
}
`
  const install = `${header}
import { pack as played } from './index.js'

/**
 * The whole pack, for a page that writes packages with \`@missing-elements/h5p-author/browser\`:
 * plus the \`installOnly\` ones, about ${Math.round(carried.reduce((sum, { size }) => sum + size, 0) / 1e5) / 10} MB more than \`index.js\`, which a player page imports.
 */
export const pack = {
  libraries: [
    ...played.libraries,
${list(carried)}
  ]
}
`
  const types = `// Written by scripts/parts.mjs. Do not edit; run \`pnpm parts\` in packages/libraries.

export interface PackDependency {
  machineName: string
  majorVersion: number
  minorVersion: number
}

/** One library of the pack, as \`parts/index.json\` describes it, and where its part is. */
export interface PackLibrary {
  /** \`<machineName>-<major>.<minor>\`, the folder the part holds. */
  folder: string
  machineName: string
  majorVersion: number
  minorVersion: number
  patchVersion: number
  /** The dependencies its \`library.json\` declares. */
  preloadedDependencies?: PackDependency[]
  dynamicDependencies?: PackDependency[]
  editorDependencies?: PackDependency[]
  /** For an addon, the content it is added to, as its \`library.json\` says. */
  addTo?: unknown
  /**
   * Carried for an H5P site's upload check only (it wants a carried library's dependencies at
   * their exact major.minor): an editor library or an older minor. Only \`install.js\` has these.
   */
  installOnly?: true
  /** The part's size in bytes. */
  size: number
  /** The part's SHA-256, in hex. */
  sha256: string
  url: string
}

/** For \`<h5p-player>\`'s \`pack\` property. */
export declare const pack: { libraries: PackLibrary[] }
`
  const installTypes = `// Written by scripts/parts.mjs. Do not edit; run \`pnpm parts\` in packages/libraries.

import type { PackLibrary } from './index.js'

/** The whole pack, \`installOnly\` libraries included, for a page that writes packages. */
export declare const pack: { libraries: PackLibrary[] }
`
  await writeFile(join(dir, 'index.js'), module)
  await writeFile(join(dir, 'index.d.ts'), types)
  await writeFile(join(dir, 'install.js'), install)
  await writeFile(join(dir, 'install.d.ts'), installTypes)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = await splitPack(new Uint8Array(await readFile(join(packageDir, 'libraries.h5p'))), join(packageDir, 'parts'))
  await writePackModule(index)
  const total = index.reduce((sum, { size }) => sum + size, 0)
  console.log(`[parts] ${index.length} parts, ${(total / 1e6).toFixed(2)} MB -> packages/libraries/parts/`)
}
