import { Reader, type CreateReadableOptions } from '@zip.js/zip.js'
import type { SourceHandle } from './source.js'
import { streamSpan } from './span-stream.js'

/**
 * The zip.js side of a source, apart from `source.ts` as the one module importing zip.js: the
 * element probes a source but never reads an archive, so it must not carry it.
 */

/* ------------------------------------------------------------------ zip.js bridge */

/**
 * Presents a `SourceHandle` as a zip.js reader. zip.js only ever asks for the central directory
 * and local headers through this, so reads stay small even for a multi-gigabyte archive.
 */
export class SourceReader extends Reader<SourceHandle> {
  size: number

  constructor(private readonly handle: SourceHandle) {
    super(handle)
    this.size = handle.size
  }

  async readUint8Array(index: number, length: number): Promise<Uint8Array> {
    if (length === 0) return new Uint8Array(0)
    const end = Math.min(index + length, this.size) - 1
    if (end < index) return new Uint8Array(0)
    return this.handle.read({ start: index, end })
  }

  /**
   * Streams a span in one read. Without this zip.js walks an entry in 64 kB steps: free over a
   * `File`, a request each over HTTP (a 218 MB video meant about 3,500 round trips).
   */
  createReadable(options: CreateReadableOptions = {}): ReadableStream<Uint8Array> {
    const start = options.offset ?? 0
    const end = Math.min(start + (options.size ?? this.size - start), this.size) - 1
    return streamSpan(this.handle, { start, end })
  }
}
