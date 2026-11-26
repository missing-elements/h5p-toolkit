import { CHUNK_SIZE } from '../shared/constants.js'
import type { ChunkStore } from '../shared/chunk-store.js'

/**
 * Smallest partial chunk worth publishing, so a cold video need not wait for a whole 8 MB chunk.
 * The interval doubles from here, so rewrites total about twice the entry, not O(n²).
 */
const FIRST_FLUSH_SIZE = 256 * 1024

export interface ChunkWriterOptions {
  store: ChunkStore
  entry: string
  /** Final size when it is known up front (from the zip index or `Content-Length`). */
  totalSize: number | null
  /** Bytes already in the store; a resumed download starts here. */
  startOffset?: number
  onProgress?: (written: number) => void
}

/**
 * A `WritableStream` that lands bytes in the chunk store and publishes a watermark as it goes.
 * The watermark is always a prefix (chunks are written in order), so readers need not check chunks.
 */
export function createChunkWriter(options: ChunkWriterOptions): WritableStream<Uint8Array> {
  const { store, entry, totalSize, onProgress } = options
  const startOffset = options.startOffset ?? 0

  if (startOffset % CHUNK_SIZE !== 0) {
    throw new Error('A resumed write must start on a chunk boundary')
  }

  let chunkIndex = startOffset / CHUNK_SIZE
  let buffer = new Uint8Array(CHUNK_SIZE)
  let filled = 0
  let written = startOffset
  let nextPartialFlush = FIRST_FLUSH_SIZE

  const publish = async (complete: boolean) => {
    await store.setMeta(entry, {
      size: complete ? written : totalSize,
      available: written,
      complete
    })
    onProgress?.(written)
  }

  return new WritableStream<Uint8Array>({
    async write(input) {
      let offset = 0

      while (offset < input.length) {
        const room = CHUNK_SIZE - filled
        const take = Math.min(room, input.length - offset)
        buffer.set(input.subarray(offset, offset + take), filled)
        filled += take
        offset += take
        written += take

        if (filled === CHUNK_SIZE) {
          await store.putChunk(entry, chunkIndex, buffer)
          chunkIndex += 1
          buffer = new Uint8Array(CHUNK_SIZE)
          filled = 0
          nextPartialFlush = FIRST_FLUSH_SIZE
          await publish(false)
        } else if (filled >= nextPartialFlush) {
          // Rewrite the partial chunk so the watermark can move before the chunk is full.
          await store.putChunk(entry, chunkIndex, buffer.subarray(0, filled))
          nextPartialFlush = filled * 2
          await publish(false)
        }
      }
    },

    async close() {
      if (filled > 0) {
        await store.putChunk(entry, chunkIndex, buffer.subarray(0, filled))
      }
      await publish(true)
    },

    abort() {
      // Nothing to publish: bytes still in `buffer` were never stored, so moving the watermark
      // to `written` would promise a reader bytes it cannot get. A retry resumes from the store.
    }
  })
}
