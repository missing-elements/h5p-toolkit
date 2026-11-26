import { READ_RETRIES, READ_RETRY_DELAY_MS, READ_STALL_MS } from './constants.js'
import { PlayerError } from './protocol.js'
import type { ByteRange } from './range.js'

/**
 * A ranged read that survives the link: a stalled or failed request is reopened from the byte it
 * reached, so an inflate never notices. `open` throws `PlayerError` for what retrying cannot fix.
 */
export function resilientStream(
  range: ByteRange,
  open: (range: ByteRange, signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>,
  options: { progress?: () => number } = {}
): ReadableStream<Uint8Array> {
  // A stall is a silent link, not a silent request: while `progress` moves, a request waiting its
  // turn on a one-at-a-time host is left alone, as aborting it would requeue it at the back.
  const progress = options.progress ?? (() => 0)
  const total = range.end - range.start + 1
  let delivered = 0
  let attempt = 0
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let controller: AbortController | null = null
  let cancelled = false

  const drop = () => {
    controller?.abort()
    // The abort above is what ends the request; a cancel that errors after it adds nothing.
    void reader?.cancel().catch(() => {})
    reader = null
    controller = null
  }

  return new ReadableStream<Uint8Array>(
    {
      async pull(sink) {
        for (;;) {
          try {
            if (!reader) {
              controller = new AbortController()
              const body = await bounded(
                open({ start: range.start + delivered, end: range.end }, controller.signal),
                controller,
                progress
              )
              reader = body.getReader()
            }
            const { done, value } = await bounded(reader.read(), controller!, progress)
            if (done) {
              if (delivered >= total) {
                sink.close()
                return
              }
              // A body that ended early is a failed attempt: the rest is asked for again.
              throw new StallError(`the host closed the range after ${delivered} of ${total} bytes`)
            }
            if (value.length === 0) continue
            delivered += value.length
            // Only a link dead for every attempt in a row fails: the count restarts on bytes.
            attempt = 0
            sink.enqueue(value)
            return
          } catch (error) {
            drop()
            if (cancelled || error instanceof PlayerError) throw error
            if (attempt >= READ_RETRIES) {
              throw new PlayerError(
                'network',
                `Gave up reading bytes ${range.start + delivered}-${range.end} after ${attempt + 1} attempts: ${
                  error instanceof Error ? error.message : String(error)
                }`
              )
            }
            await delay(READ_RETRY_DELAY_MS * 2 ** attempt, () => cancelled)
            attempt += 1
          }
        }
      },
      async cancel() {
        cancelled = true
        drop()
      }
    },
    // Nothing is opened until something reads: a stream nobody consumes must not hold a request.
    { highWaterMark: 0 }
  )
}

class StallError extends Error {}

/**
 * The promise, unless nothing settles it and nothing moves `progress` within `READ_STALL_MS`: then
 * the attempt is aborted and a stall thrown. Progress buys another bound, so a live link survives.
 */
function bounded<T>(promise: Promise<T>, controller: AbortController, progress: () => number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let seen = progress()
    let timer: ReturnType<typeof setTimeout>
    const check = () => {
      const now = progress()
      if (now !== seen) {
        seen = now
        timer = setTimeout(check, READ_STALL_MS)
        return
      }
      controller.abort()
      reject(new StallError(`no bytes from the host for ${READ_STALL_MS / 1000} s`))
    }
    timer = setTimeout(check, READ_STALL_MS)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/** Waits `ms`, checking every so often whether the read was cancelled meanwhile. */
async function delay(ms: number, cancelled: () => boolean): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until && !cancelled()) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, until - Date.now())))
  }
}
