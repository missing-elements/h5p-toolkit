import { SEGMENT_CONCURRENCY, SEGMENT_MIN_SPAN, SEGMENT_SIZE } from './constants.js'
import type { ByteRange } from './range.js'
import type { SourceHandle } from './source.js'
import { deferredStream } from './stream-utils.js'

/**
 * How a span is pulled: one ranged request, or several at once when it is large and the host
 * honours `Range`. The zip.js bridge and the Jobs worker both come here; the worker has no zip.js.
 */

/**
 * Streams an inclusive range in one read, over several connections only for `range-http`: local
 * reads gain nothing from splitting. Nothing opens until read, or an unread stream hangs a request.
 */
export function streamSpan(handle: SourceHandle, range: ByteRange): ReadableStream<Uint8Array> {
  const { start, end } = range
  if (end < start) return new Blob([]).stream()

  if (handle.descriptor.type === 'range-http' && end - start + 1 >= SEGMENT_MIN_SPAN) {
    return segmentedStream(handle, { start, end })
  }
  return deferredStream(() => handle.stream({ start, end }))
}

/**
 * One segment of a span: a ranged request whose bytes are kept as they arrive, so its turn takes
 * what is there and follows the request live, not waiting for the whole segment to land.
 */
class Segment {
  private readonly arrived: Uint8Array[] = []
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private finished = false
  private failure: unknown = null
  private wake: (() => void) | null = null
  private cancelled = false
  /** Bytes that have arrived so far. */
  received = 0

  constructor(open: () => Promise<ReadableStream<Uint8Array>>) {
    void this.pump(open)
  }

  private async pump(open: () => Promise<ReadableStream<Uint8Array>>): Promise<void> {
    try {
      const stream = await open()
      if (this.cancelled) {
        await stream.cancel()
        return
      }
      this.reader = stream.getReader()
      for (;;) {
        const { done, value } = await this.reader.read()
        if (done) break
        this.arrived.push(value)
        this.received += value.length
        this.wake?.()
      }
    } catch (error) {
      if (!this.cancelled) this.failure = error
    } finally {
      this.finished = true
      this.wake?.()
    }
  }

  /** The next chunk that has arrived, waiting for one when none has; `null` once the segment is done. */
  async next(): Promise<Uint8Array | null> {
    for (;;) {
      const chunk = this.arrived.shift()
      if (chunk) return chunk
      if (this.failure) throw this.failure
      if (this.finished) return null
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
      this.wake = null
    }
  }

  cancel(): void {
    this.cancelled = true
    this.arrived.length = 0
    // A request that is already over, or errored, has nothing left to cancel.
    void this.reader?.cancel().catch(() => {})
    this.wake?.()
  }
}

/**
 * Pulls one span over several connections and emits it in order, as a deflate stream is fed from
 * the front. A rolling window, not N splits: at most `SEGMENT_CONCURRENCY` segments, flat memory.
 */
function segmentedStream(handle: SourceHandle, span: ByteRange): ReadableStream<Uint8Array> {
  const total = span.end - span.start + 1
  const count = Math.ceil(total / SEGMENT_SIZE)
  const segments = new Map<number, Segment>()

  /** The next segment to open. */
  let next = 0
  /** The segment being emitted. */
  let current = 0

  const open = (index: number) => {
    const start = span.start + index * SEGMENT_SIZE
    const range = { start, end: Math.min(start + SEGMENT_SIZE - 1, span.end) }
    segments.set(index, new Segment(() => handle.stream(range)))
  }

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        for (;;) {
          if (current >= count) {
            controller.close()
            return
          }
          // Opened here rather than in `start`, so nothing is fetched until something reads.
          if (next === current) open(next++)
          const segment = segments.get(current)!

          // The others open once the first flows: opened together, four share the link and the
          // first segment, all the inflate can use, came at a quarter rate (34 s to first output).
          if (segment.received > 0) {
            while (next < count && segments.size < SEGMENT_CONCURRENCY) open(next++)
          }

          const chunk = await segment.next()
          if (chunk) {
            controller.enqueue(chunk)
            return
          }
          segments.delete(current)
          current += 1
        }
      },
      cancel() {
        for (const segment of segments.values()) segment.cancel()
        segments.clear()
        next = count
        current = count
      }
    },
    { highWaterMark: 0 }
  )
}
