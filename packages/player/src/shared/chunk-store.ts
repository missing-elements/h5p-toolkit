import { ARCHIVE_ENTRY, CACHE_PREFIX, CHUNK_KEY_ORIGIN, CHUNK_SIZE } from './constants.js'
import type { ByteRange } from './range.js'
import { sliceStream } from './stream-utils.js'
import { busyPackages } from './locks.js'
import type { ForwardIndexSnapshot } from './forward-index.js'
import type { ErrorCode } from './protocol.js'

/**
 * The chunk store: one Cache API cache per package. Small entries whole, archives and media in
 * fixed chunks, so nothing over one chunk is resident. A quota error evicts the coldest idle one.
 */

/** What is known about a chunked entry while and after it is written. */
export interface ChunkMeta {
  /** Total size once known. `null` while a download of unknown length is in flight. */
  size: number | null
  /** Bytes written so far, always a prefix of the entry: chunks are written in order. */
  available: number
  complete: boolean
  /**
   * Set when the last attempt to produce the entry failed, so the virtual server answers with the
   * failure at once, not after a stall, and retests the entry once the failure is old enough.
   */
  error?: EntryFailure
  /**
   * For a library pack part, the SHA-256 its bytes matched. Complete is not enough: a worker
   * stopped between the last write and the check leaves a whole, unchecked library part (#58).
   */
  checked?: string
}

export interface EntryFailure {
  code: ErrorCode
  message: string
  /** When it happened, `Date.now()`. */
  at: number
}

const META_MARKER = '/__meta__'
const FORWARD_INDEX_MARKER = '/__forward__'

/**
 * The name a forward index is announced under on the watermark channel, so a request waiting for
 * an entry that has not arrived wakes when the index grows, as one waiting for bytes does.
 */
export const FORWARD_INDEX_ENTRY = '__forward_index__'

/** How many evictions one write may trigger before it gives up. */
const MAX_EVICTIONS_PER_WRITE = 32

function encodeEntry(entry: string): string {
  return entry.split('/').map(encodeURIComponent).join('/')
}

export function cacheNameFor(pkgId: string): string {
  return `${CACHE_PREFIX}${pkgId}`
}

function wholeKey(pkgId: string, entry: string): string {
  return `${CHUNK_KEY_ORIGIN}${pkgId}/whole/${encodeEntry(entry)}`
}

function chunkKey(pkgId: string, entry: string, index: number): string {
  return `${CHUNK_KEY_ORIGIN}${pkgId}/chunk/${encodeEntry(entry)}/${index}`
}

function metaKey(pkgId: string, entry: string): string {
  return `${CHUNK_KEY_ORIGIN}${pkgId}/chunk/${encodeEntry(entry)}${META_MARKER}`
}

function forwardIndexKey(pkgId: string): string {
  return `${CHUNK_KEY_ORIGIN}${pkgId}/chunk/${encodeEntry(ARCHIVE_ENTRY)}${FORWARD_INDEX_MARKER}`
}

/** Beside the package's entries, not among them: the blocks are pieces of the archive, not of an entry. */
function indexBlocksKey(pkgId: string): string {
  return `${CHUNK_KEY_ORIGIN}${pkgId}/index-blocks`
}

/**
 * The blocks an archive's index was read from over HTTP, kept with the package (#136) under the
 * host's validator and the archive's size; a new worker reuses them only when both still match.
 */
export interface IndexBlocks {
  validator: string
  size: number
  blocks: Array<{ index: number; bytes: Uint8Array }>
}

/** One body: four bytes giving the length of a JSON head, the head, then each block's bytes in turn. */
function encodeIndexBlocks({ validator, size, blocks }: IndexBlocks): Uint8Array<ArrayBuffer> {
  const head = new TextEncoder().encode(
    JSON.stringify({ validator, size, blocks: blocks.map(({ index, bytes }) => ({ index, length: bytes.length })) })
  )
  const body = new Uint8Array(4 + head.length + blocks.reduce((sum, { bytes }) => sum + bytes.length, 0))
  new DataView(body.buffer).setUint32(0, head.length)
  body.set(head, 4)
  let at = 4 + head.length
  for (const { bytes } of blocks) {
    body.set(bytes, at)
    at += bytes.length
  }
  return body
}

/** `undefined` for a body that is not what `encodeIndexBlocks` writes, whole. */
function decodeIndexBlocks(body: Uint8Array): IndexBlocks | undefined {
  if (body.length < 4) return undefined
  const length = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0)
  if (4 + length > body.length) return undefined
  const head = JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + length))) as {
    validator?: unknown
    size?: unknown
    blocks?: Array<{ index?: unknown; length?: unknown }>
  }
  if (typeof head.validator !== 'string' || typeof head.size !== 'number' || !Array.isArray(head.blocks)) return undefined
  const blocks: IndexBlocks['blocks'] = []
  let at = 4 + length
  for (const { index, length: bytes } of head.blocks) {
    if (typeof index !== 'number' || typeof bytes !== 'number' || at + bytes > body.length) return undefined
    blocks.push({ index, bytes: body.slice(at, at + bytes) })
    at += bytes
  }
  return at === body.length ? { validator: head.validator, size: head.size, blocks } : undefined
}

/** A write the browser refused for lack of space, in either spelling. */
export function isQuotaError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED')
  )
}

export class QuotaError extends Error {
  constructor(message = 'Not enough storage to cache this package') {
    super(message)
    this.name = 'QuotaError'
  }
}

/** Chunk indices covering an inclusive byte range. */
export function chunksForRange(range: ByteRange): { first: number; last: number } {
  return {
    first: Math.floor(range.start / CHUNK_SIZE),
    last: Math.floor(range.end / CHUNK_SIZE)
  }
}

/** The slice of chunk `index` that contributes to `range`, as offsets within the chunk. */
export function sliceWithinChunk(index: number, range: ByteRange): { from: number; to: number } {
  const chunkStart = index * CHUNK_SIZE
  return {
    from: Math.max(0, range.start - chunkStart),
    to: Math.min(CHUNK_SIZE, range.end - chunkStart + 1)
  }
}

export class ChunkStore {
  readonly pkgId: string
  private cachePromise: Promise<Cache> | null = null

  constructor(pkgId: string) {
    this.pkgId = pkgId
  }

  private cache(): Promise<Cache> {
    this.cachePromise ??= caches.open(cacheNameFor(this.pkgId))
    return this.cachePromise
  }

  /* ---------------------------------------------------------------- whole entries */

  async getWhole(entry: string): Promise<Response | undefined> {
    const cache = await this.cache()
    return cache.match(wholeKey(this.pkgId, entry))
  }

  /**
   * Stores an entry in one piece. `body` builds the payload, usually a fresh inflate stream, so the
   * entry streams into storage; it is called again only if a quota retry needs another.
   */
  async putWhole(
    entry: string,
    body: () => BodyInit,
    contentType: string,
    size?: number
  ): Promise<void> {
    const headers = new Headers({ 'content-type': contentType })
    if (size !== undefined) headers.set('content-length', String(size))
    await this.write(wholeKey(this.pkgId, entry), () => new Response(body(), { headers }))
  }

  /* ---------------------------------------------------------------- chunked entries */

  async getMeta(entry: string): Promise<ChunkMeta | undefined> {
    const cache = await this.cache()
    const response = await cache.match(metaKey(this.pkgId, entry))
    if (!response) return undefined
    try {
      return (await response.json()) as ChunkMeta
    } catch {
      // A record that is not JSON is read as none: the next write replaces it, and nothing it
      // could have said is worth failing the read for.
      return undefined
    }
  }

  async setMeta(entry: string, meta: ChunkMeta): Promise<void> {
    // The watermark must never be the write that fails on quota, or a complete entry would look
    // partial forever. Tiny is not exempt (a full origin refuses 100 bytes): it evicts like chunks.
    await this.write(
      metaKey(this.pkgId, entry),
      () => new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } })
    )
    announceWatermark({ pkgId: this.pkgId, entry, meta })
  }

  /**
   * Drops the chunks of an entry and keeps its meta, as a failed extraction leaves it: a deflate
   * stream cannot resume, so the partial chunks only hold space the package may need.
   */
  async discardChunks(entry: string): Promise<void> {
    const cache = await this.cache()
    const prefix = `${CHUNK_KEY_ORIGIN}${this.pkgId}/chunk/${encodeEntry(entry)}/`
    const chunks = (await cache.keys()).filter(
      (request) => request.url.startsWith(prefix) && /^\d+$/.test(request.url.slice(prefix.length))
    )
    await Promise.all(chunks.map((request) => cache.delete(request)))
  }

  async putChunk(entry: string, index: number, bytes: Uint8Array): Promise<void> {
    // A fresh copy: `bytes` may be a view into a larger buffer the caller keeps writing into. One
    // copy serves every attempt, since a `Response` takes its own copy of a buffer body.
    const copy = bytes.slice()
    await this.write(
      chunkKey(this.pkgId, entry, index),
      () =>
        new Response(copy.buffer as ArrayBuffer, {
          headers: { 'content-type': 'application/octet-stream' }
        })
    )
  }

  async getChunk(entry: string, index: number): Promise<Uint8Array | undefined> {
    const cache = await this.cache()
    const response = await cache.match(chunkKey(this.pkgId, entry, index))
    if (!response) return undefined
    return new Uint8Array(await response.arrayBuffer())
  }

  /**
   * Streams an inclusive byte range a chunk at a time, so a 64 kB media probe does not materialise
   * 8 MB. `waitFor(byte)` runs it ahead of the extraction: true once that exists, false to end.
   */
  readRange(
    entry: string,
    range: ByteRange,
    waitFor?: (bytes: number) => Promise<boolean>
  ): ReadableStream<Uint8Array> {
    const { first, last } = chunksForRange(range)
    let index = first
    let current: ReadableStreamDefaultReader<Uint8Array> | null = null
    const store = this

    return new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          for (;;) {
            if (current) {
              const { done, value } = await current.read()
              if (!done) {
                controller.enqueue(value)
                return
              }
              current = null
              index += 1
            }

            if (index > last) {
              controller.close()
              return
            }

            if (waitFor) {
              const reaches = Math.min((index + 1) * CHUNK_SIZE, range.end + 1)
              // The extraction is gone: end the body short, not errored. A media element takes an
              // errored body as fatal and never asks again, but follows a short one with a request.
              if (!(await waitFor(reaches))) {
                controller.close()
                return
              }
            }

            const body = await store.chunkBody(entry, index)
            if (!body) {
              controller.error(new Error(`Missing chunk ${index} of ${entry}`))
              return
            }

            const { from, to } = sliceWithinChunk(index, range)
            const whole = from === 0 && to >= CHUNK_SIZE
            current = (whole ? body : sliceStream(body, { start: from, end: to - 1 })).getReader()
          }
        },
        async cancel(reason) {
          await current?.cancel(reason)
        }
      },
      // Nothing is pulled, and nothing waited for, until the response body is actually read.
      { highWaterMark: 0 }
    )
  }

  /** The stored body of one chunk, streaming, or `undefined` when it is not there. */
  private async chunkBody(entry: string, index: number): Promise<ReadableStream<Uint8Array> | undefined> {
    const cache = await this.cache()
    const response = await cache.match(chunkKey(this.pkgId, entry, index))
    return response?.body ?? undefined
  }

  /** Reads an inclusive range into memory. Only used for archive reads, which are bounded. */
  async readRangeBytes(entry: string, range: ByteRange): Promise<Uint8Array> {
    const out = new Uint8Array(range.end - range.start + 1)
    const { first, last } = chunksForRange(range)
    let offset = 0

    for (let index = first; index <= last; index += 1) {
      const chunk = await this.getChunk(entry, index)
      if (!chunk) throw new Error(`Missing chunk ${index} of ${entry}`)
      const { from, to } = sliceWithinChunk(index, range)
      const slice = chunk.subarray(from, Math.min(to, chunk.length))
      out.set(slice, offset)
      offset += slice.length
    }

    return offset === out.length ? out : out.subarray(0, offset)
  }

  /* ---------------------------------------------------------------- archive helpers */

  getArchiveMeta(): Promise<ChunkMeta | undefined> {
    return this.getMeta(ARCHIVE_ENTRY)
  }

  /**
   * The entries of a downloading archive already readable from its local headers, published by the
   * Jobs worker; the Service Worker serves from them until the central directory is present.
   */
  async getForwardIndex(): Promise<ForwardIndexSnapshot | undefined> {
    const cache = await this.cache()
    const response = await cache.match(forwardIndexKey(this.pkgId))
    if (!response) return undefined
    try {
      return (await response.json()) as ForwardIndexSnapshot
    } catch {
      // As for a chunk's meta: not JSON, so none, and the next snapshot replaces it.
      return undefined
    }
  }

  async setForwardIndex(snapshot: ForwardIndexSnapshot): Promise<void> {
    await this.write(
      forwardIndexKey(this.pkgId),
      () => new Response(JSON.stringify(snapshot), { headers: { 'content-type': 'application/json' } })
    )
    announceWatermark({
      pkgId: this.pkgId,
      entry: FORWARD_INDEX_ENTRY,
      meta: { size: null, available: snapshot.parsedTo, complete: snapshot.done }
    })
  }

  /**
   * The blocks the archive's index was read from over HTTP, as a worker kept them (#136):
   * `undefined` when none were kept, or what was kept does not read back whole.
   */
  async getIndexBlocks(): Promise<IndexBlocks | undefined> {
    const cache = await this.cache()
    const response = await cache.match(indexBlocksKey(this.pkgId))
    if (!response) return undefined
    try {
      return decodeIndexBlocks(new Uint8Array(await response.arrayBuffer()))
    } catch {
      return undefined
    }
  }

  async setIndexBlocks(kept: IndexBlocks): Promise<void> {
    const body = encodeIndexBlocks(kept)
    await this.write(indexBlocksKey(this.pkgId), () => new Response(body, { headers: { 'content-type': 'application/octet-stream' } }))
  }

  /* ---------------------------------------------------------------- writing and eviction */

  /**
   * A cache write that survives a full disk: a quota error drops the coldest *other* package and
   * retries. A factory, not a `Response`: a `clone()` per attempt would buffer the whole stream.
   */
  private async write(key: string, build: () => Response): Promise<void> {
    const cache = await this.cache()

    for (let attempt = 0; ; attempt += 1) {
      const response = build()
      try {
        await cache.put(key, response)
        return
      } catch (error) {
        // A failed put can leave a stream body half-read and still being produced; let it go
        // before building another. Cancelling a body the put still holds rejects, which is fine.
        void response.body?.cancel().catch(() => {})
        if (!isQuotaError(error)) throw error
        if (attempt >= MAX_EVICTIONS_PER_WRITE) throw new QuotaError()
        if (!(await evictColdestPackage(this.pkgId))) throw new QuotaError()
      }
    }
  }

  async destroy(): Promise<void> {
    this.cachePromise = null
    await caches.delete(cacheNameFor(this.pkgId))
  }
}

/* ------------------------------------------------------------------ module-level maintenance */

/**
 * Hooks the eviction policy up to the `packages` table. Injected, not imported, so the store tests
 * without IndexedDB; `eviction.ts` supplies the real one, installed by both workers.
 */
let coldestPackageLookup: ((exceptPkgId: string) => Promise<string | null>) | null = null

export function setEvictionPolicy(lookup: (exceptPkgId: string) => Promise<string | null>): void {
  coldestPackageLookup = lookup
}

let onPackageEvicted: ((pkgId: string) => Promise<void> | void) | null = null

export function setEvictionListener(listener: (pkgId: string) => Promise<void> | void): void {
  onPackageEvicted = listener
}

async function evictColdestPackage(exceptPkgId: string): Promise<boolean> {
  const victim = coldestPackageLookup
    ? await coldestPackageLookup(exceptPkgId)
    : await coldestCacheName(exceptPkgId)

  if (!victim) return false

  await emptyCache(cacheNameFor(victim))
  await caches.delete(cacheNameFor(victim))
  await onPackageEvicted?.(victim)
  return true
}

/**
 * Deletes a cache's entries one by one before the cache: Chromium keeps the bytes booked until
 * every `Cache` handle is collected, and the server makes one per request (770 ms against 3 ms).
 */
async function emptyCache(name: string): Promise<void> {
  if (!(await caches.has(name))) return
  const cache = await caches.open(name)
  const keys = await cache.keys()
  await Promise.all(keys.map((request) => cache.delete(request)))
}

/** Fallback when no policy is installed: any other idle package cache, in whatever order the browser lists. */
async function coldestCacheName(exceptPkgId: string): Promise<string | null> {
  const [names, busy] = await Promise.all([caches.keys(), busyPackages()])
  const mine = cacheNameFor(exceptPkgId)
  const candidate = names.find(
    (name) => name.startsWith(CACHE_PREFIX) && name !== mine && !busy.has(name.slice(CACHE_PREFIX.length))
  )
  return candidate ? candidate.slice(CACHE_PREFIX.length) : null
}

/* ------------------------------------------------------------------ watermark notices */

/**
 * The Jobs worker writes the watermark, the Service Worker waits: a channel notice wakes a waiter
 * at once, the poll notices a dead job. Two channels, as a channel never hears itself.
 */
const WATERMARK_CHANNEL = 'h5p-player-watermark'

export interface WatermarkNotice {
  pkgId: string
  entry: string
  /** The record that was just written, on a watermark notice. */
  meta?: ChunkMeta
  /** The job is running, on a liveness notice — sent every `INPUT_LIVENESS_MS` while it is. */
  running?: true
  /** Bytes the job has taken from the network so far, beside `running`, when the source counts. */
  received?: number
  /** The job is queued behind another extraction and alive, on a queued notice. */
  queued?: true
}

let announcer: BroadcastChannel | null | undefined
let listener: BroadcastChannel | null | undefined

function openChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel !== 'function') return null
  const channel = new BroadcastChannel(WATERMARK_CHANNEL)
  // Node keeps the process alive for an open channel; browsers have no such method.
  ;(channel as BroadcastChannel & { unref?: () => void }).unref?.()
  return channel
}

function announceWatermark(notice: WatermarkNotice): void {
  announcer ??= openChannel()
  try {
    announcer?.postMessage(notice)
  } catch {
    // A closed channel must not turn a successful write into a failed one.
  }
}

/**
 * Tells whoever waits on an entry that its job is alive, on a timer, with the bytes taken so far if
 * known. It writes nothing; it keeps a slow start or silent link from reading as a dead job.
 */
export function announceRunning(pkgId: string, entry: string, received?: number): void {
  announceWatermark({ pkgId, entry, running: true, received })
}

/**
 * Tells whoever waits on an entry that its job is queued behind another extraction, alive and not
 * yet producing, so the waiter keeps waiting rather than asking again or giving up.
 */
export function announceQueued(pkgId: string, entry: string): void {
  announceWatermark({ pkgId, entry, queued: true })
}

/** Calls `onNotice` for every notice about one entry, until the returned function is called. */
export function onWatermark(
  pkgId: string,
  entry: string,
  onNotice: (notice: WatermarkNotice) => void
): () => void {
  listener ??= openChannel()
  const channel = listener
  if (!channel) return () => {}

  const onMessage = (event: MessageEvent<WatermarkNotice>) => {
    const notice = event.data
    if (notice?.pkgId === pkgId && notice.entry === entry) onNotice(notice)
  }
  channel.addEventListener('message', onMessage)
  return () => channel.removeEventListener('message', onMessage)
}

/** Drops package caches written by an older major version. Called from the worker's `activate`. */
export async function deleteStaleCaches(): Promise<string[]> {
  const names = await caches.keys()
  const stale = names.filter((name) => /^h5p-pkg-v(\d+)-/.test(name) && !name.startsWith(CACHE_PREFIX))
  await Promise.all(stale.map((name) => caches.delete(name)))
  return stale
}
