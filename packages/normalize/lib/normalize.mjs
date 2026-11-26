/**
 * Rewrites a `.h5p` so it streams through the player, the content untouched: only the container
 * changes. Output goes through `StreamingZipWriter`, as zip.js's writer holds a video in memory.
 */
import { createWriteStream, openAsBlob } from 'node:fs'
import { mkdtemp, open, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Writable } from 'node:stream'
import zlib from 'node:zlib'
import { BlobReader, Uint8ArrayWriter, ZipReader, configure } from '@zip.js/zip.js'
import { crc32 } from './crc32.mjs'
import { planFaststart, readPieces } from './mp4-faststart.mjs'
import { StreamingZipWriter } from './zip-writer.mjs'
import { archiveFingerprint } from './fingerprint.mjs'

// The byte formatting the command's report uses, for a caller printing its own.
export { formatBytes } from './format.mjs'
// The player's `context.revision` for an archive on disk, for a publisher's version record.
export { archiveFingerprint } from './fingerprint.mjs'

configure({ useWebWorkers: false })

const STORE = 0
const DEFLATE = 8
const DEFLATE64 = 9

/** Formats that are compressed already. Deflating them again costs more than it saves. */
const MEDIA_EXTENSIONS = new Set([
  'mp4', 'm4v', 'm4a', 'mov', 'webm', 'weba', 'mkv', 'ogg', 'ogv', 'oga', 'opus',
  'mp3', 'aac', 'flac', 'wav',
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif',
  'woff', 'woff2', 'pdf', 'zip'
])

/** ISO base media files, the ones with a `moov` that may need moving. */
const ISO_MEDIA_EXTENSIONS = new Set(['mp4', 'm4v', 'm4a', 'mov'])

/** What the runtime parses whole. Small, and deflate roughly quarters it. */
const COMPRESSIBLE_EXTENSIONS = new Set([
  'js', 'mjs', 'json', 'css', 'html', 'htm', 'txt', 'xml', 'csv', 'vtt', 'srt', 'svg', 'md',
  'ttf', 'otf', 'eot'
])

/** A "text" entry past this is not text; it is copied rather than read into memory. */
const MAX_RECOMPRESS_SIZE = 64 * 1024 * 1024

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

/**
 * @typedef {'store' | 'compress' | 'copy'} TargetForm
 *
 * @typedef {object} EntryResult
 * @property {string} name the name as written
 * @property {number} size uncompressed
 * @property {TargetForm} target
 * @property {'copy' | 'store' | 'deflate' | 'faststart'} action what was done
 * @property {{ method: number, compressedSize: number }} from
 * @property {{ method: number, compressedSize: number }} to
 * @property {string} [detail] the mp4 layout finding, where there was one
 * @property {string} [warning] why an entry was copied although it should have changed
 *
 * @typedef {object} Report
 * @property {EntryResult[]} entries in output order
 * @property {{ directories: number, rejected: Array<{ name: string, reason: string }> }} dropped
 * @property {string[]} warnings about the package as a whole
 * @property {number} payloadIn the sum of the source's compressed sizes
 * @property {number} payloadOut the same for the output
 * @property {number | null} bytesOut the output file's length, `null` for a dry run
 * @property {string} revision what h5p-offline-player will put in `context.revision` for the
 *   output — or, for a dry run, for the input as it stands
 */

/**
 * The form an entry of this name should end up in.
 * @internal
 * @param {string} name
 * @returns {TargetForm}
 */
export function targetFormOf(name) {
  const extension = extensionOf(name)
  if (MEDIA_EXTENSIONS.has(extension)) return 'store'
  if (COMPRESSIBLE_EXTENSIONS.has(extension)) return 'compress'
  return 'copy'
}

/** @param {string} name */
function extensionOf(name) {
  const base = name.slice(name.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

/**
 * The player's own rule: the canonical form of a zip entry name, or `null` if it cannot be a plain
 * relative path under the package root. It is dropped, not repaired, as the player refuses it.
 * @internal
 * @param {string} raw
 */
export function plainRelativeName(raw) {
  if (!raw || CONTROL_CHARS.test(raw)) return null
  const withSlashes = raw.replace(/\\/g, '/')
  if (withSlashes.startsWith('/') || /^[a-zA-Z]:/.test(withSlashes)) return null
  const segments = []
  for (const segment of withSlashes.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') return null
    segments.push(segment)
  }
  return segments.length ? segments.join('/') : null
}

/**
 * The output order: root files, each library folder whole, then `content/` with media last. A
 * folder stays whole, as the player counts it done once the next starts; `last` goes after (#148).
 * @internal
 *
 * @template {{ name: string, target: TargetForm }} T
 * @param {T[]} entries in source order
 * @param {Iterable<string>} [last] top-level folders to write after everything else
 * @returns {T[]}
 */
export function orderEntries(entries, last = []) {
  const trailing = new Set(last)
  trailing.delete('content')
  /** @type {Map<string, number>} */
  const folderRank = new Map()
  /** @type {Map<string, number>} */
  const trailingRank = new Map()
  const keyed = entries.map((entry, index) => {
    const { name, target } = entry
    const slash = name.indexOf('/')
    /** @type {number[]} */
    let key
    if (slash === -1) {
      key = [0, name === 'h5p.json' ? 0 : 1, index]
    } else {
      const folder = name.slice(0, slash)
      if (trailing.has(folder)) {
        if (!trailingRank.has(folder)) trailingRank.set(folder, trailingRank.size)
        key = [4, /** @type {number} */ (trailingRank.get(folder)), index]
      } else if (folder !== 'content') {
        if (!folderRank.has(folder)) folderRank.set(folder, folderRank.size)
        key = [1, /** @type {number} */ (folderRank.get(folder)), index]
      } else if (target === 'store') {
        key = [3, 0, index]
      } else {
        key = [2, name === 'content/content.json' ? 0 : 1, index]
      }
    }
    return { entry, key }
  })
  keyed.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2])
  return keyed.map(({ entry }) => entry)
}

/**
 * Reads `input` and writes the normalized archive to `output`, or with none only reports: the same
 * report, so a dry run still inflates a deflated video into a temp file to look at its end.
 *
 * @param {object} options
 * @param {string} options.input path of the source archive
 * @param {string} [options.output] path to write; omitted for a dry run
 * @param {(result: EntryResult) => void} [options.onEntry] called as each entry is finished
 * @param {readonly string[] | ReadonlySet<string>} [options.last] library folders, by name, written
 *   after everything else, media included: what the package carries and nothing reads as it plays
 * @returns {Promise<Report>}
 */
export async function normalizeArchive({ input, output, onEntry, last }) {
  // A string is iterable, and would be read as one folder per letter.
  if (typeof last === 'string') throw new TypeError('`last` takes a list of folder names, not one name')
  // Before the source is opened: a folder that is not there failed mid-write, as an entry's
  // fault (#290).
  if (output) {
    const folder = await stat(dirname(resolve(output))).catch((error) => {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null
      throw new Error(`${dirname(output)} cannot be read: ${error?.message ?? error}`, { cause: error })
    })
    if (!folder) throw new Error(`No such folder: ${dirname(output)}. Create it, or name an output in a folder that exists.`)
    if (!folder.isDirectory()) throw new Error(`${dirname(output)} is a file, not a folder. Name an output in a folder that exists.`)
  }
  const source = await open(input, 'r')
  /** @type {string | null} */
  let tempDir = null
  /** @type {ZipReader<unknown> | null} */
  let zipReader = null

  try {
    tempDir = await mkdtemp(join(tmpdir(), 'h5p-normalize-'))
    // `checkSignature` is in the reader's options, as `configure` does not reach it: with it every
    // decoding read checks the CRC; else damaged bytes that still inflated were written as intact.
    zipReader = new ZipReader(new BlobReader(await openAsBlob(input)), { checkSignature: true })
    // Tolerant, as the player is: zip.js's default refuses the whole archive over one hostile
    // name, and the point is to drop that entry and keep the rest.
    const all = await zipReader.getEntries({ filenameValidation: 'tolerant' })

    /** @type {Report['dropped']} */
    const dropped = { directories: 0, rejected: [] }
    /** @type {Array<{ entry: import('@zip.js/zip.js').FileEntry, name: string, target: TargetForm }>} */
    const planned = []
    const seen = new Set()
    for (const entry of all) {
      if (entry.directory) {
        dropped.directories++
        continue
      }
      const name = plainRelativeName(entry.filename)
      if (name === null) {
        dropped.rejected.push({ name: entry.filename, reason: 'not a plain relative path' })
        continue
      }
      if (seen.has(name)) {
        dropped.rejected.push({ name: entry.filename, reason: `duplicate of ${name}` })
        continue
      }
      seen.add(name)
      planned.push({ entry, name, target: targetFormOf(name) })
    }

    const warnings = []
    if (!seen.has('h5p.json')) warnings.push('no h5p.json at the root: this is not a content package')

    const writer = output
      ? new StreamingZipWriter(Writable.toWeb(createWriteStream(output)))
      : null

    /** @type {EntryResult[]} */
    const results = []
    let index = 0
    for (const item of orderEntries(planned, last)) {
      let result
      try {
        result = await processEntry(item, { source, tempDir, writer, index: index++ })
      } catch (error) {
        // The output is released here, not left to the collector: the command removes the
        // `.part` file next, which a still-open descriptor refuses on Windows.
        await writer?.abort(error)
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`${item.name}: ${reason}`, { cause: error })
      }
      results.push(result)
      onEntry?.(result)
    }
    await writer?.close()

    let bytesOut = null
    if (output) {
      const verified = await verifyArchive(output)
      if (verified.count !== results.length) {
        throw new Error(`The output lists ${verified.count} entries but ${results.length} were written`)
      }
      bytesOut = verified.size
    }
    const revision = await archiveFingerprint(output ?? input)

    return {
      entries: results,
      dropped,
      warnings,
      payloadIn: results.reduce((sum, result) => sum + result.from.compressedSize, 0),
      payloadOut: results.reduce((sum, result) => sum + result.to.compressedSize, 0),
      bytesOut,
      revision
    }
  } finally {
    await zipReader?.close()
    await source.close()
    if (tempDir) await rm(tempDir, { recursive: true, force: true })
  }
}

/**
 * @param {{ entry: import('@zip.js/zip.js').FileEntry, name: string, target: TargetForm }} item
 * @param {{ source: import('node:fs/promises').FileHandle, tempDir: string, writer: StreamingZipWriter | null, index: number }} context
 * @returns {Promise<EntryResult>}
 */
async function processEntry({ entry, name, target }, { source, tempDir, writer, index }) {
  const method = entry.compressionMethod
  const size = entry.uncompressedSize
  const from = { method, compressedSize: entry.compressedSize }
  const stored = { method: STORE, compressedSize: size }
  const dosDateTime = typeof entry.rawLastModDate === 'number' ? entry.rawLastModDate : undefined
  const base = { name, size, target, from }

  /** The header of this entry stored as it is, byte for byte: the source's own size and CRC. */
  const storedMeta = { name, method: STORE, crc32: entry.signature ?? 0, compressedSize: size, uncompressedSize: size, dosDateTime }

  /** @param {string} [warning] */
  const copyRaw = async (warning) => {
    await writer?.add(
      {
        name,
        method,
        crc32: entry.signature ?? 0,
        compressedSize: entry.compressedSize,
        uncompressedSize: size,
        dosDateTime
      },
      (sink) => entry.getData(sink, { passThrough: true })
    )
    return { ...base, action: /** @type {const} */ ('copy'), to: from, warning }
  }

  // Refused, not copied: this writer cannot copy one faithfully (an AES entry loses its 0x9901 extra
  // field, a classic one with a data descriptor has a time-derived check byte), and the player cannot play one.
  if (entry.encrypted) throw new Error('the entry is encrypted, which H5P does not use and the player cannot play')
  if (method !== STORE && method !== DEFLATE && method !== DEFLATE64) {
    return copyRaw(target === 'copy' ? undefined : `compression method ${method} cannot be read here; copied as it was`)
  }
  if (target === 'copy') return copyRaw()

  if (target === 'compress') {
    if (method !== STORE || size > MAX_RECOMPRESS_SIZE) return copyRaw()
    const bytes = await entry.getData(new Uint8ArrayWriter())
    const deflated = zlib.deflateRawSync(bytes, { level: 9 })
    if (deflated.length >= bytes.length) return copyRaw()
    await writer?.add(
      { name, method: DEFLATE, crc32: entry.signature ?? crc32(bytes), compressedSize: deflated.length, uncompressedSize: size, dosDateTime },
      (sink) => pump([deflated], sink)
    )
    return { ...base, action: 'deflate', to: { method: DEFLATE, compressedSize: deflated.length } }
  }

  // target === 'store'
  if (!ISO_MEDIA_EXTENSIONS.has(extensionOf(name))) {
    if (method === STORE) return copyRaw()
    // Inflated straight into the output: the size and CRC are the source's own, and zip.js
    // compares the inflated bytes with that CRC as it goes (`checkSignature` above).
    await writer?.add(
      storedMeta,
      (sink) => entry.getData(sink)
    )
    return { ...base, action: 'store', to: stored }
  }

  // An mp4's `moov`, which decides the layout, is usually at the end. A stored entry is read in
  // place; a deflated one goes to a temp file first, as a deflate stream cannot be seeked.
  let file = source
  let offset = 0
  let temp = null
  if (method === STORE) {
    offset = await dataOffsetOf(source, entry)
  } else {
    temp = join(tempDir, `${index}.bin`)
    await entry.getData(Writable.toWeb(createWriteStream(temp)))
    file = await open(temp, 'r')
  }

  try {
    const plan = await planFaststart(file, offset, size)
    if (plan.status !== 'moved') {
      if (method === STORE) return { ...(await copyRaw()), detail: plan.detail }
      await writer?.add(storedMeta, (sink) => pump(readPieces(file, plan.pieces), sink))
      return { ...base, action: 'store', to: stored, detail: plan.detail }
    }

    // The CRC is measured over the new layout, in one pass before the write. A stored source is
    // read in place and checked against its recorded CRC first: a new CRC would vouch for damage.
    if (writer && method === STORE && typeof entry.signature === 'number') {
      let original = 0
      for await (const chunk of readPieces(file, [{ start: offset, end: offset + size }])) original = crc32(chunk, original)
      if (original >>> 0 !== entry.signature >>> 0) throw new Error('the stored bytes do not match the CRC the archive recorded')
    }
    let crc = 0
    if (writer) {
      for await (const chunk of readPieces(file, plan.pieces)) crc = crc32(chunk, crc)
    }
    await writer?.add(
      { name, method: STORE, crc32: crc, compressedSize: size, uncompressedSize: size, dosDateTime },
      (sink) => pump(readPieces(file, plan.pieces), sink)
    )
    return { ...base, action: 'faststart', to: stored, detail: plan.detail }
  } finally {
    if (temp) {
      await file.close()
      await rm(temp, { force: true })
    }
  }
}

/**
 * Where a stored entry's bytes begin: past its local header, whose name and extra field
 * lengths only the header itself knows.
 * @param {import('node:fs/promises').FileHandle} file
 * @param {import('@zip.js/zip.js').Entry} entry
 */
async function dataOffsetOf(file, entry) {
  const header = Buffer.alloc(30)
  const { bytesRead } = await file.read(header, 0, 30, entry.offset)
  if (bytesRead !== 30 || header.readUInt32LE(0) !== 0x04034b50) {
    throw new Error(`${entry.filename}: no local header at ${entry.offset}`)
  }
  return entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
}

/**
 * @param {Iterable<Uint8Array> | AsyncIterable<Uint8Array>} chunks
 * @param {WritableStream<Uint8Array>} sink
 */
async function pump(chunks, sink) {
  const out = sink.getWriter()
  try {
    for await (const chunk of chunks) await out.write(chunk)
    await out.close()
  } catch (error) {
    // The failure is the write's own, rethrown below; a sink that will not abort adds nothing.
    await out.abort(error).catch(() => {})
    throw error
  }
}

/**
 * Opens the finished archive the way any reader would, and counts what it lists.
 * @param {string} path
 */
async function verifyArchive(path) {
  const blob = await openAsBlob(path)
  const reader = new ZipReader(new BlobReader(blob))
  try {
    const entries = await reader.getEntries()
    return { count: entries.length, size: blob.size }
  } finally {
    await reader.close()
  }
}
