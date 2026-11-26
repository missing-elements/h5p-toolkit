import { COLD_ENTRY_WAIT_MS, WATERMARK_POLL_MS } from '../shared/constants.js'
import { onWatermark, type ChunkMeta, type ChunkStore } from '../shared/chunk-store.js'

/**
 * Waits until the entry has `needed` bytes, is complete, or has a recorded failure. The bound is a
 * stall, not a wall clock, and a running or queued notice resets it: a quiet link is not death.
 */
export async function waitForWatermark(
  store: ChunkStore,
  entry: string,
  needed: number,
  options: {
    stallMs?: number
    onStall?: () => Promise<void>
    /**
     * Return once the job reports itself queued: a response whose body follows the extraction sends
     * its headers now, since a long queue could outlast how long a fetch event may stay unanswered.
     */
    queuedIsEnough?: boolean
  } = {}
): Promise<ChunkMeta | null> {
  const stallMs = options.stallMs ?? COLD_ENTRY_WAIT_MS
  let lastAvailable = -1
  let lastReceived = -1
  let lastAdvanceAt = Date.now()
  let askedAgain = false
  let queued = false

  // Woken by the writer's notice when there is one; the poll is the fallback that keeps stall
  // detection working when there is not.
  let wake: (() => void) | null = null
  const stop = onWatermark(store.pkgId, entry, (notice) => {
    if (notice.running || (notice.received !== undefined && notice.received !== lastReceived)) {
      lastReceived = notice.received ?? lastReceived
      lastAdvanceAt = Date.now()
      askedAgain = false
    }
    // Queued is alive: extractions run one at a time, and an entry waiting its turn behind a
    // long video must not read as a dead job.
    if (notice.queued) {
      queued = true
      lastAdvanceAt = Date.now()
      askedAgain = false
    }
    wake?.()
  })

  try {
    for (;;) {
      const meta = await store.getMeta(entry)
      if (meta && (meta.available >= needed || meta.complete)) return meta
      // A recorded failure is an answer too; the caller decides what to serve.
      if (meta?.error) return meta
      if (queued && options.queuedIsEnough) return meta ?? { size: null, available: 0, complete: false }

      const available = meta?.available ?? 0
      if (available !== lastAvailable) {
        lastAvailable = available
        lastAdvanceAt = Date.now()
        askedAgain = false
      } else if (Date.now() - lastAdvanceAt >= stallMs) {
        if (askedAgain || !options.onStall) return null
        await options.onStall()
        askedAgain = true
        lastAdvanceAt = Date.now()
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, WATERMARK_POLL_MS)
        wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
      wake = null
    }
  } finally {
    stop()
  }
}
