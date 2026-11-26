import { BlobReader, BlobWriter, ZipWriter } from '@zip.js/zip.js'
import { crc32 } from '@missing-elements/h5p-normalize/crc32'
import { faststartPlan } from '@missing-elements/h5p-normalize/mp4'
import { packLibrariesIn } from '@missing-elements/h5p-offline-player/plan'
import { composePackage, sourceOf, typeNames, writePackage } from './build.mjs'
import { MediaStore } from './media.mjs'
import { Pack } from './pack.mjs'
import { SourceError } from './source-error.mjs'

export * from './core.mjs'

/**
 * @missing-elements/h5p-author/browser: Node's build in a page or Tauri window, with a pack it can
 * reach, files as `File`s or `Blob`s, a `Blob` out. Needs a secure context: `crypto.subtle`, `crypto.randomUUID`.
 */

/**
 * @typedef {{ libraries: import('./pack.mjs').IndexEntry[] }} PackIndex
 *   the bundler-emitted `pack` export of `@missing-elements/h5p-libraries`: the index, parts by URL
 * @typedef {{
 *   blob: Blob, source: import('./build.mjs').Source, builtWith: string, manifest: Record<string, unknown>, content: Record<string, unknown>, libraries: string[], install: string[],
 *   coreApi: import('./install.mjs').CoreApi, translations: import('./translate.mjs').TranslationReport[], notes: import('./build.mjs').Problem[], media: string[], lengths: import('./media.mjs').MediaLength[], linked: string[], outline: string
 * }} BuildResult the package and what is worth telling about it, as Node's, with a `blob`; with
 *   `linked` files it is a preview, not one to keep, since an address may stop answering
 * @typedef {{ libraries: Pack | PackIndex | string | URL, files?: Map<string, Blob> | Record<string, Blob>, linked?: Map<string, string> | Record<string, string>, fetch?: typeof fetch }} BuildOptions
 *   `libraries`: a pack or what opens one; `files`, by name; `linked`, at an address (#263); `fetch`, for media named by web address
 */

/** What a page's build takes from the browser, which it has in a secure context only. */
function secure() {
  if (!globalThis.crypto?.subtle || typeof globalThis.crypto.randomUUID !== 'function') {
    throw new Error('A page builds packages in a secure context only, https, localhost or a Tauri window: it needs crypto.subtle and crypto.randomUUID, which a page has nowhere else')
  }
}

/**
 * The pack a page's build reads: the `pack` export of `@missing-elements/h5p-libraries`, or the
 * address of a copy of its `parts/`; parts come whole, SHA-256 checked. Close it: `buildPackage` leaves it open.
 * @param {PackIndex | string | URL} pack
 * @param {{ fetch?: typeof fetch }} [options] `fetch`, for the index and the parts
 */
export async function openPack(pack, { fetch: fetchImpl = globalThis.fetch } = {}) {
  secure()
  /** @type {import('./pack.mjs').IndexEntry[]} */
  let libraries
  if (typeof pack === 'string' || pack instanceof URL) {
    const written = String(pack)
    const base = new URL(written.endsWith('/') ? written : `${written}/`, globalThis.location?.href)
    if (base.protocol !== 'https:' && base.protocol !== 'http:') {
      throw new Error(`${base.href} is not an http(s) address: a copy of the pack's parts/ folder is read over http(s), as the player reads one; give the pack export instead`)
    }
    const url = new URL('index.json', base).href
    let index
    try {
      const response = await fetchImpl(url)
      if (!response.ok) throw new Error(`it answered ${response.status}`)
      index = await response.json()
    } catch (error) {
      throw new Error(`${url} is not a library pack's index: ${error instanceof Error ? error.message : error}`, { cause: error })
    }
    libraries = packLibrariesIn((Array.isArray(index?.libraries) ? index.libraries : []).map((/** @type {any} */ entry) => (
      entry && typeof entry === 'object' && typeof entry.folder === 'string' ? { ...entry, url: new URL(`${entry.folder}.h5p`, base).href } : null
    )))
    if (!libraries.length) throw new Error(`${url} is not a library pack's index: it lists no library as the pack's index does`)
  } else if (Array.isArray(pack?.libraries) && pack.libraries.every((entry) => typeof entry?.url === 'string')) {
    libraries = pack.libraries.map((entry) => ({ ...entry, url: new URL(entry.url, globalThis.location?.href).href }))
  } else {
    throw new TypeError('Name the library pack: the pack export of @missing-elements/h5p-libraries, or the address of a copy of its parts/ folder')
  }
  return new Pack(libraries, async (entry) => {
    let response
    try {
      response = await fetchImpl(entry.url)
    } catch (error) {
      throw new Error(`Cannot fetch the library part ${entry.folder} from ${entry.url}`, { cause: error })
    }
    if (!response.ok) throw new Error(`Cannot fetch the library part ${entry.folder}: ${entry.url} answered ${response.status}`)
    return new Uint8Array(await response.arrayBuffer())
  }, 'serve the parts of the pack this index belongs to')
}

/**
 * A source's files in a page: the `File`s or `Blob`s it was given, by the names the source gives
 * them; downloads kept as `Blob`s.
 * @param {Map<string, Blob> | Record<string, Blob>} files
 * @param {Map<string, string> | Record<string, string>} linked the files left at an address, by name
 * @returns {import('./media.mjs').MediaAccess<Blob>}
 */
function pageMedia(files, linked) {
  const named = files instanceof Map ? files : new Map(Object.entries(files))
  const addresses = linked instanceof Map ? linked : new Map(Object.entries(linked))
  return {
    // A file given goes before an address for it: the bytes make a package to keep.
    linked: (source) => (named.has(source) ? undefined : addresses.get(source)),
    what: 'the name of a file given',
    name: (source) => source.slice(source.lastIndexOf('/') + 1),
    async local(source) {
      const file = named.get(source)
      if (file instanceof Blob) return { file }
      if (file !== undefined) return { missing: 'is not a File or a Blob' }
      const names = [...named.keys()]
      return { missing: `no such file among those given (${names.length ? `${names.slice(0, 10).join(', ')}${names.length > 10 ? ', …' : ''}` : 'none'})` }
    },
    keep: (body) => new Response(body).blob(),
    async open(file) {
      return {
        size: file.size,
        read: async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
        close: async () => {}
      }
    }
  }
}

/**
 * A stored video or recording laid out to stream, its `moov` index first, by the normalizer's own
 * plan (`faststartPlan`, #218): file slices and the new index; no media copied, no extension list.
 * @param {Blob} blob
 * @returns {Promise<Blob>}
 */
async function laidOut(blob) {
  const read = async (/** @type {number} */ offset, /** @type {number} */ length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer())
  const plan = await faststartPlan(read, blob.size)
  if (plan.status !== 'moved') return blob
  // The rewritten index is a copy of its own, over an ArrayBuffer, as a Blob takes it.
  const parts = plan.pieces.map((piece) => ('bytes' in piece ? /** @type {Uint8Array<ArrayBuffer>} */ (piece.bytes) : blob.slice(piece.start, piece.end)))
  return new Blob(parts, { type: blob.type })
}

/**
 * A `Blob`'s CRC-32, read as a stream.
 * @param {Blob} blob
 */
async function crcOf(blob) {
  const reader = blob.stream().getReader()
  let crc = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return crc
    crc = crc32(value, crc)
  }
}

/**
 * The page's own `fetch` for media named by web address, saying what a failure most likely is: a
 * page reads another site's file only where that site allows it (CORS), and most do not.
 * @type {typeof fetch}
 */
const pageFetch = (input, init) => globalThis.fetch(input, init).catch((error) => {
  if (init?.signal?.aborted || !(error instanceof TypeError)) throw error
  throw new Error(`${error.message}; a page reads a file from another site only where that site allows it (CORS), so give the file itself instead`, { cause: error })
})

/**
 * Builds a package from a source in a page, and returns it as a `Blob`.
 * @param {unknown} input the source: `{ type, title, language, license, authors, params }`, or a quiz in the published quiz format
 * @param {BuildOptions} options
 * @returns {Promise<BuildResult>}
 */
export async function buildPackage(input, options) {
  secure()
  const { libraries, files = {}, linked = {}, fetch: fetchImpl = pageFetch } = options ?? {}
  if (!libraries) throw new TypeError('Name the library pack: a pack openPack opened, the pack export of @missing-elements/h5p-libraries, or the address of a copy of its parts/ folder')
  const pack = libraries instanceof Pack ? libraries : await openPack(libraries)
  try {
    // With the pack's names, as the command's build reads a source (#174).
    const read = sourceOf(input, typeNames(pack))
    if (!read.typed) throw new SourceError(read.problems)
    const media = new MediaStore(pageMedia(files, linked), { fetch: fetchImpl })
    const built = await composePackage(read.source, pack, media, read.problems)
    const writer = new ZipWriter(new BlobWriter('application/zip'), { useWebWorkers: false })
    await writePackage(writer, built, pack, async () => {
      for (const item of media.files) {
        // Stored, its size and CRC in its local header: written into a stream, zip.js would put them in a descriptor after it.
        const file = await laidOut(item.from)
        await writer.add(`content/${item.name}`, new BlobReader(file), { passThrough: true, compressionMethod: 0, uncompressedSize: file.size, crc32: await crcOf(file) })
      }
    })
    return {
      blob: await writer.close(),
      source: built.source,
      builtWith: built.builtWith,
      manifest: built.manifest,
      content: built.content,
      libraries: [...built.selected.keys()],
      install: [...built.install.keys()],
      coreApi: built.coreApi,
      translations: built.translations,
      notes: built.notes,
      media: media.files.map((item) => item.name),
      lengths: built.lengths,
      linked: [...media.linked],
      get outline() { return built.outline }
    }
  } finally {
    if (pack !== libraries) await pack.close()
  }
}
