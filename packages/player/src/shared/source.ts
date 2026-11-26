import { BlockCache } from './block-cache.js'
import { ARCHIVE_ENTRY, BLOCK_CACHE_MAX_BYTES, BLOCK_CACHE_MAX_READ, BLOCK_SIZE } from './constants.js'
import { ChunkStore } from './chunk-store.js'
import { PlayerError, type RemoteSourceDescriptor, type SourceDescriptor } from './protocol.js'
import type { ByteRange } from './range.js'
import { resilientStream } from './resilient-stream.js'
import { sliceStream } from './stream-utils.js'

/**
 * Source adapters: one interface, a size and a byte-range read, over the three ways an archive can
 * be reached, built from the persisted descriptor. The zip.js side is in `source-reader.ts`.
 */

export interface SourceHandle {
  readonly descriptor: SourceDescriptor
  /** Total size in bytes. Known for every handle by the time one is built. */
  readonly size: number
  /** Reads an inclusive byte range into memory. Callers keep these bounded. */
  read(range: ByteRange): Promise<Uint8Array>
  /** Streams an inclusive byte range. Used to serve large stored entries without buffering. */
  stream(range: ByteRange): Promise<ReadableStream<Uint8Array>>
  /**
   * Bytes taken from the network so far over every read and stream. Only a network handle counts:
   * it shows a job is alive while the inflate has produced nothing yet.
   */
  readonly received?: number
}

/* ------------------------------------------------------------------ probing */

/** Aborts the body of a response we only wanted the headers of. */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // A cancelled body that errors tells us nothing we act on.
  }
}

function parseContentRangeSize(header: string | null): number | null {
  if (!header) return null
  const match = /\/(\d+)$/.exec(header.trim())
  return match ? Number(match[1]) : null
}

function readValidator(response: Response): string | null {
  // `ETag` needs `Access-Control-Expose-Headers` to be read cross-origin, `Last-Modified` is
  // safelisted: null only if neither is readable. Else a republished archive gets a fresh pkgId.
  return response.headers.get('etag') ?? response.headers.get('last-modified')
}

/**
 * The schemes a package can be fetched from. `fetch` rejects any other with a `TypeError` that
 * reads like a network failure, so the probe refuses it first and names the scheme.
 */
const FETCHABLE_SCHEMES = new Set(['http:', 'https:', 'blob:', 'data:'])

/** The scheme of `url` when no package can be fetched from it, else `null`. */
export function unfetchableScheme(url: string, pageUrl: string | undefined): string | null {
  let target: URL
  try {
    target = new URL(url, pageUrl)
  } catch {
    return null
  }
  return FETCHABLE_SCHEMES.has(target.protocol) ? null : target.protocol
}

/**
 * The `https:` URL to suggest when `url` is `http:` on an `https:` page, else `null`. Mixed-content
 * blocking reads like a host without CORS (`no-cors`), so it is named first. Loopback is exempt.
 */
export function insecureOnSecurePage(url: string, pageUrl: string | undefined): string | null {
  if (!pageUrl) return null
  let target: URL
  try {
    target = new URL(url, pageUrl)
  } catch {
    return null
  }
  if (new URL(pageUrl).protocol !== 'https:' || target.protocol !== 'http:') return null
  const host = target.hostname
  if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host)) {
    return null
  }
  target.protocol = 'https:'
  return target.href
}

/**
 * Decides how an archive can be reached, with one `GET` of `Range: bytes=0-0`: a host without CORS
 * rejects it, one ignoring `Range` answers `200` (body cancelled; `HEAD` is often blocked).
 */
export async function probeSource(
  url: string,
  signal?: AbortSignal
): Promise<RemoteSourceDescriptor> {
  const scheme = unfetchableScheme(url, globalThis.location?.href)
  if (scheme) {
    throw new PlayerError('network', `${scheme} URLs cannot be played. Use an http:, https:, blob: or data: URL.`)
  }
  const secure = insecureOnSecurePage(url, globalThis.location?.href)
  if (secure) {
    throw new PlayerError(
      'network',
      `${url} is an http: URL and this page is served over https:, so the browser blocks it as mixed content. Use ${secure} if the host serves it.`
    )
  }

  let response: Response
  try {
    response = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal, cache: 'no-store' })
  } catch (error) {
    if (signal?.aborted) throw error
    // A CORS rejection and a dead host are indistinguishable from here; the actionable one is CORS.
    throw new PlayerError('no-cors', `Cannot read ${url} from the browser (no CORS headers?)`, {
      cause: error
    })
  }

  const validator = readValidator(response)

  if (!response.ok && response.status !== 206) {
    await discardBody(response)
    throw new PlayerError('network', `${url} returned ${response.status}`)
  }

  if (response.status === 206) {
    const size = parseContentRangeSize(response.headers.get('content-range'))
    await discardBody(response)

    // `Content-Range` is not CORS-safelisted; `Content-Length` is. When the host does not expose
    // it, a second ranged request gives the size from `Content-Length` instead.
    const resolved = size ?? (await sizeFromOpenRange(url, signal))
    if (resolved === null) {
      // Range works but the length is unknowable, so the central directory cannot be found from
      // the end. Download it instead.
      return { type: 'chunked', url, size: null, validator }
    }

    return { type: 'range-http', url, size: resolved, validator }
  }

  // Status 200 to a Range request: the host ignores Range and sent the whole archive.
  const declared = response.headers.get('content-length')
  await discardBody(response)
  return { type: 'chunked', url, size: declared ? Number(declared) : null, validator }
}

/**
 * The size, for a host hiding `Content-Range`: `Content-Length` of a `206` to `Range: bytes=0-`.
 * Not a plain `GET`: gzipping hosts (GitHub Pages) report the compressed size; a `Range` avoids it.
 */
async function sizeFromOpenRange(url: string, signal?: AbortSignal): Promise<number | null> {
  const response = await fetch(url, { headers: { Range: 'bytes=0-' }, signal, cache: 'no-store' })
  const length = response.headers.get('content-length')
  await discardBody(response)
  if (!response.ok) return null
  return length ? Number(length) : null
}

/* ------------------------------------------------------------------ handles */

/**
 * The small reads of every archive this worker reads over HTTP, shared by all its handles, so a
 * rebuilt reader finds the blocks the first fetched. Made on first use: the element only probes.
 */
let blocks: BlockCache | null = null

function blockCache(): BlockCache {
  return (blocks ??= new BlockCache(BLOCK_SIZE, BLOCK_CACHE_MAX_BYTES))
}

/** Forgets every block this worker holds. For tests, whose cases share one module. */
export function forgetBlocks(): void {
  blocks?.clear()
}

type RangeHttpDescriptor = Extract<SourceDescriptor, { type: 'range-http' }>

/** What names an archive's bytes in the block cache: the package id's ingredients, and the size. */
function blockKeyOf(descriptor: RangeHttpDescriptor, size: number): string {
  return `${descriptor.url}\u0000${descriptor.validator ?? ''}\u0000${size}`
}

/** A block of an archive, by its place: block `index` starts at `index * BLOCK_SIZE`. */
export interface KeptBlock {
  index: number
  bytes: Uint8Array
}

/**
 * The blocks `handle`'s small reads went through, for keeping with the package (#136): what the
 * index and the reads before boot needed. Only a handle over HTTP has any.
 */
export function blocksReadBy(handle: SourceHandle): KeptBlock[] {
  return handle instanceof RangeHttpHandle ? handle.blocksRead() : []
}

/** Puts back blocks an earlier worker read of the archive at `descriptor`, `size` bytes long. */
export function seedBlocks(descriptor: RangeHttpDescriptor, size: number, kept: Iterable<KeptBlock>): void {
  blockCache().seed(blockKeyOf(descriptor, size), size, kept)
}

class RangeHttpHandle implements SourceHandle {
  received = 0
  /** What names these bytes in the block cache: the package id's ingredients, and the size. */
  private readonly blockKey: string
  /** The blocks this handle's small reads went through, fetched or found held. */
  private readonly used = new Set<number>()

  constructor(
    readonly descriptor: RangeHttpDescriptor,
    readonly size: number
  ) {
    this.blockKey = blockKeyOf(descriptor, size)
  }

  /** The blocks this handle's small reads went through that the cache still holds, in archive order. */
  blocksRead(): KeptBlock[] {
    return blockCache().blocksOf(this.blockKey, [...this.used].sort((a, b) => a - b))
  }

  /** Counts a body's bytes as they pass, without holding any of them. */
  private counted(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    return body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, controller) => {
          this.received += chunk.length
          controller.enqueue(chunk)
        }
      })
    )
  }

  private async fetchRange(range: ByteRange, signal: AbortSignal): Promise<Response> {
    // The chunk store is the cache. Letting the browser's HTTP cache keep a second copy of a
    // large archive doubles the storage for nothing.
    const response = await fetch(this.descriptor.url, {
      headers: { Range: `bytes=${range.start}-${range.end}` },
      cache: 'no-store',
      signal
    })
    if (response.status !== 206 && response.status !== 200) {
      await discardBody(response)
      // A `PlayerError` is final; anything else `resilientStream` retries. A status that can change
      // by itself (overloaded, restarting, rate-limiting) is retried; a missing file is not.
      if (TRANSIENT_STATUSES.has(response.status)) {
        throw new Error(`Range request answered ${response.status}`)
      }
      throw new PlayerError('network', `Range request failed with ${response.status}`)
    }
    return response
  }

  /** One attempt at a range: the request, its body counted, and sliced when the host sent it all. */
  private async attempt(range: ByteRange, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const response = await this.fetchRange(range, signal)
    if (!response.body) throw new PlayerError('network', 'Range response had no body')

    // A host that answered 200 sent the whole archive: buffering it for a slice would hold hundreds
    // of MB (four files under `segmentedStream`), so it is sliced as it flows, ending the pipe.
    const body = this.counted(response.body)
    return response.status === 200 ? sliceStream(body, range) : body
  }

  /**
   * A read of at most `BLOCK_CACHE_MAX_READ` (the index, a header, a small entry) goes through the
   * block cache, which fetches whole blocks. A longer one is fetched as asked and kept nowhere.
   */
  async read(range: ByteRange): Promise<Uint8Array> {
    if (range.end - range.start + 1 > BLOCK_CACHE_MAX_READ) return this.fetchBytes(range)
    const last = Math.floor(Math.min(range.end, this.size - 1) / BLOCK_SIZE)
    for (let index = Math.floor(range.start / BLOCK_SIZE); index <= last; index += 1) this.used.add(index)
    return blockCache().read(this.blockKey, this.size, range, (missing) => this.fetchBytes(missing))
  }

  /**
   * A range of one block, or a longer one the cache holds whole, comes from the block cache: zip.js
   * streams data right after its header, usually in that block. Else it streams from the network.
   */
  async stream(range: ByteRange): Promise<ReadableStream<Uint8Array>> {
    const length = range.end - range.start + 1
    if (length <= BLOCK_SIZE || (length <= BLOCK_CACHE_MAX_READ && blockCache().holds(this.blockKey, range))) {
      const bytes = await this.read(range)
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes)
          controller.close()
        }
      })
    }
    return this.network(range)
  }

  private async fetchBytes(range: ByteRange): Promise<Uint8Array> {
    return new Uint8Array(await new Response(this.network(range)).arrayBuffer())
  }

  /**
   * Every request, for a block or a span, goes through `resilientStream`: one that goes quiet or
   * fails is reopened from the byte it reached, so a link that drops for a moment costs a moment.
   */
  private network(range: ByteRange): ReadableStream<Uint8Array> {
    return resilientStream(range, (remaining, signal) => this.attempt(remaining, signal), {
      // Bytes on any request of this archive: a segment waiting its turn behind one that flows
      // is not a stalled link.
      progress: () => this.received
    })
  }
}

/** Statuses a host answers with when it, not the request, is the problem for now. */
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])

class ChunkedHandle implements SourceHandle {
  private store: ChunkStore

  constructor(
    readonly descriptor: Extract<SourceDescriptor, { type: 'chunked' }>,
    readonly size: number,
    pkgId: string
  ) {
    this.store = new ChunkStore(pkgId)
  }

  read(range: ByteRange): Promise<Uint8Array> {
    return this.store.readRangeBytes(ARCHIVE_ENTRY, range)
  }

  async stream(range: ByteRange): Promise<ReadableStream<Uint8Array>> {
    return this.store.readRange(ARCHIVE_ENTRY, range)
  }
}

class FileHandle implements SourceHandle {
  constructor(
    readonly descriptor: Extract<SourceDescriptor, { type: 'file' }>,
    private readonly blob: Blob
  ) {}

  get size(): number {
    return this.blob.size
  }

  async read(range: ByteRange): Promise<Uint8Array> {
    const slice = this.blob.slice(range.start, range.end + 1)
    return new Uint8Array(await slice.arrayBuffer())
  }

  async stream(range: ByteRange): Promise<ReadableStream<Uint8Array>> {
    return this.blob.slice(range.start, range.end + 1).stream()
  }
}

/**
 * Builds a handle from a persisted descriptor. A `file` descriptor needs the `File` itself, which
 * only the page holds — the caller fetches it from the page before calling this.
 */
export async function openSource(
  pkgId: string,
  descriptor: SourceDescriptor,
  file?: Blob,
  options: {
    /**
     * Open a chunked archive that is still downloading. Only the forward index can address it (its
     * size is what has arrived), never zip.js, which needs the end of the file.
     */
    partial?: boolean
  } = {}
): Promise<SourceHandle> {
  switch (descriptor.type) {
    case 'range-http':
      return new RangeHttpHandle(descriptor, descriptor.size)

    case 'chunked': {
      const meta = await new ChunkStore(pkgId).getArchiveMeta()
      if (!meta || (!meta.complete && !options.partial)) {
        throw new PlayerError('bad-archive', 'Archive has not finished downloading')
      }
      return new ChunkedHandle(descriptor, meta.size ?? meta.available, pkgId)
    }

    case 'file': {
      if (!file) throw new PlayerError('bad-archive', 'The picked file is no longer available')
      return new FileHandle(descriptor, file)
    }
  }
}
