/// <reference lib="webworker" />
import { ARCHIVE_ENTRY, CHUNK_SIZE, INPUT_LIVENESS_MS, WARM_ENTRY } from '../shared/constants.js'
import { ChunkStore, QuotaError, announceQueued, announceRunning, isQuotaError, type ChunkMeta } from '../shared/chunk-store.js'
import { installEvictionPolicy } from '../shared/eviction.js'
import { LocalHeaderScanner } from '../shared/forward-index.js'
import { DEFLATE, STORED, readDataStart } from '../shared/local-header.js'
import { packageLockName, packageLockPrefix } from '../shared/locks.js'
import { hex } from '../shared/pkg-id.js'
import {
  JOBS_READY,
  PlayerError,
  type EntryLocation,
  type ErrorCode,
  type FromJobsMessage,
  type SourceDescriptor,
  type ToJobsMessage,
  type WarmSpan
} from '../shared/protocol.js'
import { openSource, type SourceHandle } from '../shared/source.js'
import { streamSpan } from '../shared/span-stream.js'
import { inflated } from '../shared/stream-utils.js'
import { quotaMessage } from '../shared/storage.js'
import { createChunkWriter } from './chunk-writer.js'
import { IndexPublisher } from './index-publisher.js'
import { JobQueue, type ExtractJob } from './job-queue.js'
import { warmPackage } from './warm.js'

/**
 * The Jobs worker: what outlives a Service Worker event (downloads, warming, big inflates), in the
 * page, with no zip.js or index: the Service Worker says where each job's bytes are.
 */

const scope = self as unknown as DedicatedWorkerGlobalScope

const inFlight = new Map<string, AbortController>()
/**
 * Extractions waiting their turn, one at a time (see `JobQueue`). They announce themselves queued,
 * so a waiting request hears a live job. Downloads and warming run before boot, unqueued.
 */
const queue = new JobQueue()
let extracting: string | null = null
let heartbeat: ReturnType<typeof setInterval> | null = null
/** Files handed over by the page for local-file packages, kept for the life of the worker. */
const files = new Map<string, Blob>()

function send(message: FromJobsMessage): void {
  scope.postMessage(message)
}

// The large writes happen here, so quota runs out here: without the policy a full disk evicts
// whatever the browser lists first. Nothing to forget on eviction: no reader or index per package.
installEvictionPolicy()

/**
 * Doubles as the Web Lock name, which is why it carries the package prefix: while this job holds
 * it, eviction anywhere on the origin leaves the package alone.
 */
function jobKey(pkgId: string, entry?: string): string {
  return packageLockName(pkgId, entry ?? ARCHIVE_ENTRY)
}

scope.addEventListener('message', (event: MessageEvent<ToJobsMessage>) => {
  const message = event.data
  if (!message) return

  if (message.type === 'abort') {
    queue.drop(message.pkgId)
    syncHeartbeat()
    for (const [key, controller] of inFlight) {
      if (!key.startsWith(packageLockPrefix(message.pkgId))) continue
      controller.abort()
      // Released now, not once the abort unwinds: a second press of Play posts `abort` and
      // `download` back to back, and the new job would be dropped as a duplicate of a dying one.
      inFlight.delete(key)
    }
    return
  }

  if (message.file) files.set(message.pkgId, message.file)

  if (message.type === 'extract') {
    scheduleExtract({
      pkgId: message.pkgId,
      entry: message.entry,
      location: message.location,
      source: message.source,
      prefetch: message.prefetch === true
    })
    return
  }

  void run(message)
})

// Once the listener is in place: the page holds every job until it hears this.
scope.postMessage({ type: JOBS_READY })

/* ------------------------------------------------------------------ the extraction queue */

function scheduleExtract(job: ExtractJob): void {
  // Running already: the request is a duplicate, and the running job is never interrupted.
  if (extracting === jobKey(job.pkgId, job.entry)) return
  queue.request(job)
  syncHeartbeat()
  pump()
}

function pump(): void {
  if (extracting !== null) return
  const job = queue.next()
  if (!job) {
    syncHeartbeat()
    return
  }
  const key = jobKey(job.pkgId, job.entry)
  extracting = key
  syncHeartbeat()
  void run({
    type: 'extract',
    pkgId: job.pkgId,
    entry: job.entry,
    location: job.location,
    source: job.source
  }).finally(() => {
    if (extracting === key) extracting = null
    pump()
  })
}

/** While anything waits, every queued entry is announced alive once per liveness interval. */
function syncHeartbeat(): void {
  if (queue.size === 0) {
    if (heartbeat !== null) clearInterval(heartbeat)
    heartbeat = null
    return
  }
  if (heartbeat !== null) return
  const announce = () => {
    for (const job of queue.waiting()) announceQueued(job.pkgId, job.entry)
  }
  announce()
  heartbeat = setInterval(announce, INPUT_LIVENESS_MS)
}

async function run(message: Exclude<ToJobsMessage, { type: 'abort' }>): Promise<void> {
  const entry = message.type === 'extract' ? message.entry : message.type === 'warm' ? WARM_ENTRY : undefined
  const key = jobKey(message.pkgId, entry)

  if (inFlight.has(key)) return

  const controller = new AbortController()
  inFlight.set(key, controller)

  try {
    // Shared across tabs: whoever gets the lock does the work, the others wait and then find the
    // watermark already where they need it.
    await navigator.locks.request(key, { signal: controller.signal }, async () => {
      if (message.type === 'download') {
        await downloadArchive(message.pkgId, message.source, controller.signal, false, message.sha256)
      } else if (message.type === 'warm') {
        await warmJob(message.pkgId, message.source, message.spans, controller.signal)
      } else {
        await extractEntry(message.pkgId, message.entry, message.location, message.source, controller.signal)
      }
    })
  } catch (error) {
    if (controller.signal.aborted) return
    const code = codeFor(error)
    const text = error instanceof Error ? error.message : String(error)
    // A warm that could not even start is not a failed entry; nothing waits on its record.
    if (entry && entry !== WARM_ENTRY) await recordFailure(message.pkgId, entry, code, text)
    send({ type: 'failed', pkgId: message.pkgId, entry, code, message: text })
  } finally {
    // Only its own entry: an abort may already have handed the key to a successor.
    if (inFlight.get(key) === controller) inFlight.delete(key)
  }
}

/* ------------------------------------------------------------------ download */

/**
 * Downloads an archive into the chunk store, as a host ignoring `Range` forces the whole file
 * down. Resumes from the chunk-aligned watermark (`bytes=N-`); a `200` to that restarts.
 */
async function downloadArchive(
  pkgId: string,
  source: SourceDescriptor,
  signal: AbortSignal,
  afresh = false,
  sha256?: string
): Promise<void> {
  if (source.type !== 'chunked') {
    throw new PlayerError('network', 'Only a chunked source is downloaded ahead of play')
  }

  const store = new ChunkStore(pkgId)
  const existing = await store.getArchiveMeta()

  if (existing?.complete) {
    // A part kept whole but never checked (its worker stopped between the last write and the
    // check, or an old player kept it) is checked now, and downloaded again if it fails.
    if (sha256 && existing.checked !== sha256) {
      try {
        await checkHash(store, existing, sha256, source.url)
      } catch {
        await store.destroy()
        return downloadArchive(pkgId, source, signal, afresh, sha256)
      }
    }
    send({ type: 'done', pkgId })
    return
  }

  // Only whole chunks can be resumed from: a partial chunk may have been flushed mid-fill.
  let startOffset = existing ? Math.floor(existing.available / CHUNK_SIZE) * CHUNK_SIZE : 0

  let response = await fetch(source.url, {
    signal,
    cache: 'no-store',
    headers: startOffset > 0 ? { Range: `bytes=${startOffset}-` } : undefined
  })

  if (startOffset > 0 && response.status !== 206) {
    // The host ignored the resume request and is sending the whole file again.
    startOffset = 0
    if (response.status !== 200) {
      response = await fetch(source.url, { signal, cache: 'no-store' })
    }
  }

  if (!response.ok && response.status !== 206) {
    throw new PlayerError('network', `${source.url} returned ${response.status}`)
  }
  if (!response.body) {
    throw new PlayerError('network', 'The archive response had no body')
  }

  // The probe's size first: it was measured by a ranged request (`identity`), while a plain `GET`
  // here may be answered with a compressing host's shorter length.
  const declared = response.headers.get('content-length')
  const totalSize = source.size ?? (declared ? Number(declared) + startOffset : null)

  // Index the archive as it passes: a host ignoring `Range` would hold every entry hostage until
  // the central directory arrives. The Service Worker serves from what the scanner finds.
  const scanner = new LocalHeaderScanner()
  if (startOffset > 0) {
    // A resumed download starts mid-archive; the scanner has to have seen the prefix.
    await store.readRange(ARCHIVE_ENTRY, { start: 0, end: startOffset - 1 }).pipeTo(
      new WritableStream({ write: (chunk) => scanner.push(chunk) })
    )
  }

  // Each progress report goes out once its snapshot is stored: the element asks whether the frame
  // can boot on every report, and the Service Worker answers from the stored snapshot (#144).
  const index = new IndexPublisher(scanner, (snapshot) => store.setForwardIndex(snapshot))

  const indexer = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      scanner.push(chunk)
      controller.enqueue(chunk)
    }
  })

  try {
    await response.body.pipeThrough(indexer).pipeTo(
      createChunkWriter({
        store,
        entry: ARCHIVE_ENTRY,
        totalSize,
        startOffset,
        onProgress: (loaded) => index.report(() => send({ type: 'progress', pkgId, loaded, total: totalSize }))
      }),
      { signal }
    )
  } catch (error) {
    if (!(error instanceof QuotaError)) throw error
    // The whole archive has to land here — that is what a host without `Range` costs — so the
    // number that matters is the archive's size against what the browser gives the site.
    throw new QuotaError(
      `${await quotaMessage('this package', totalSize)} Its host does not support partial ` +
        'downloads, so the whole archive has to be stored before it can play.'
    )
  }
  await index.publish(true)

  // Read back, as WebKit can lose it (a package downloaded whole, element removed, played again:
  // record gone). Once, so a store that keeps nothing fails here.
  const meta = await store.getArchiveMeta()
  if (!meta?.complete && !afresh) {
    await store.destroy()
    return downloadArchive(pkgId, source, signal, true, sha256)
  }
  if (!meta?.complete) throw new PlayerError('bad-archive', 'The downloaded archive could not be kept in the browser storage')
  if (sha256) await checkHash(store, meta, sha256, source.url)
  send({ type: 'done', pkgId })
}

/**
 * Reads a downloaded pack part back and refuses it unless it hashes as the pack's index says: it
 * is library code the site will run. Read whole (a few MB; SHA-256 cannot stream).
 */
async function checkHash(store: ChunkStore, meta: ChunkMeta, expected: string, url: string): Promise<void> {
  const size = meta.size ?? meta.available
  const bytes = await new Response(store.readRange(ARCHIVE_ENTRY, { start: 0, end: size - 1 })).arrayBuffer()
  if (hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))) === expected) {
    // Best-effort: a store too full to take the mark leaves the part to be checked on its next use.
    await store.setMeta(ARCHIVE_ENTRY, { ...meta, checked: expected }).catch(() => {})
    return
  }
  await store.destroy()
  throw new PlayerError('bad-archive', `${url} is not the library the pack's index names: its bytes do not match the index's hash`)
}

/* ------------------------------------------------------------------ warming */

/**
 * Pulls the spans the index named into the cache before boot. However it stops short, the server
 * serves the rest, so a warm ends in `done` or an abort; `failed` only if it cannot start.
 */
async function warmJob(
  pkgId: string,
  source: SourceDescriptor,
  spans: WarmSpan[],
  signal: AbortSignal
): Promise<void> {
  const store = new ChunkStore(pkgId)
  const marker = await store.getWhole(WARM_ENTRY)
  if (marker) {
    await marker.body?.cancel()
    send({ type: 'done', pkgId, entry: WARM_ENTRY })
    return
  }

  const handle = await openSource(pkgId, source, files.get(pkgId))
  try {
    await warmPackage(handle, spans, store, {
      signal,
      onProgress: ({ loaded, total }) => send({ type: 'progress', pkgId, entry: WARM_ENTRY, loaded, total })
    })
  } catch (error) {
    if (signal.aborted) return
    console.warn('[h5p-player] warming stopped early; the rest is served on demand:', error)
  }
  if (signal.aborted) return
  send({ type: 'done', pkgId, entry: WARM_ENTRY })
}

/* ------------------------------------------------------------------ extraction */

/**
 * Inflates one large deflated entry into chunks in a single pass: the native codec streams it and
 * the chunk writer publishes the watermark behind it, so a prefix is served while the rest comes.
 */
async function extractEntry(
  pkgId: string,
  entryName: string,
  location: EntryLocation,
  source: SourceDescriptor,
  signal: AbortSignal
): Promise<void> {
  const store = new ChunkStore(pkgId)
  const existing = await store.getMeta(entryName)

  if (existing?.complete) {
    send({ type: 'done', pkgId, entry: entryName })
    return
  }

  if (location.method !== STORED && location.method !== DEFLATE) {
    throw new PlayerError('bad-archive', `${entryName} is compressed with a method this player cannot extract`)
  }

  // The Service Worker names the archive and where the entry is. `partial`: an entry the forward
  // index named is whole below the watermark of an archive still downloading.
  const handle = await openSource(pkgId, source, files.get(pkgId), { partial: true })
  const start = location.dataStart ?? (await dataStartOf(handle, entryName, location))
  const end = start + location.compressedSize - 1
  if (end >= handle.size) {
    throw new PlayerError('bad-archive', `${entryName} extends past the end of the archive`)
  }

  // A deflate stream cannot resume, so a partial extraction is discarded: why this never runs in
  // the Service Worker, where a kill mid-inflate would restart from zero each time.
  await store.setMeta(entryName, { size: location.size, available: 0, complete: false })

  const stopReporting = reportRunning(handle, pkgId, entryName)
  try {
    await inflated(streamSpan(handle, { start, end }), location.method, location.compressedSize).pipeTo(
      createChunkWriter({
        store,
        entry: entryName,
        totalSize: location.size,
        onProgress: (loaded) =>
          send({ type: 'progress', pkgId, entry: entryName, loaded, total: location.size })
      }),
      { signal }
    )
  } catch (error) {
    if (!(error instanceof QuotaError)) throw error
    throw new QuotaError(await quotaMessage('this file', location.size))
  } finally {
    stopReporting()
  }

  send({ type: 'done', pkgId, entry: entryName })
}

/** Where an entry's data begins: its local header, read for the name and extra lengths in front. */
async function dataStartOf(handle: SourceHandle, entryName: string, location: EntryLocation): Promise<number> {
  if (location.header === undefined) {
    throw new PlayerError('bad-archive', `${entryName} has no known location in the archive`)
  }
  return readDataStart(handle, location.header, entryName)
}

/**
 * Announces every `INPUT_LIVENESS_MS` that the job runs, so a stall bound tells it from one dead
 * with its tab. Bytes are not the test: a waiter giving up first ends a media response for good.
 */
function reportRunning(handle: SourceHandle, pkgId: string, entry: string): () => void {
  const announce = () => announceRunning(pkgId, entry, handle.received)
  announce()
  const timer = setInterval(announce, INPUT_LIVENESS_MS)
  return () => clearInterval(timer)
}

/**
 * Records a failed extraction's verdict: its chunks go (a deflate stream cannot resume), the meta
 * keeps the failure, so a request is answered at once and retried once it has aged.
 */
async function recordFailure(pkgId: string, entry: string, code: ErrorCode, message: string): Promise<void> {
  const store = new ChunkStore(pkgId)
  try {
    const existing = await store.getMeta(entry)
    await store.discardChunks(entry)
    await store.setMeta(entry, {
      size: existing?.size ?? null,
      available: 0,
      complete: false,
      error: { code, message, at: Date.now() }
    })
  } catch {
    // A store that cannot even take the note leaves the request to the stall path.
  }
}

function codeFor(error: unknown): ErrorCode {
  if (error instanceof PlayerError) return error.code
  if (error instanceof QuotaError || isQuotaError(error)) return 'quota'
  return 'network'
}
