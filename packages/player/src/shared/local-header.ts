import { PlayerError } from './protocol.js'
import type { SourceHandle } from './source.js'
/**
 * The zip local header, the thirty bytes in front of every entry's data. The central directory has
 * said where it is, so none of its readers needs zip.js: all that is left is to step over it.
 */

export const LOCAL_HEADER_SIGNATURE = 0x04034b50
export const LOCAL_HEADER_FIXED_SIZE = 30

/** Zip compression methods: the only two an H5P package is served with. */
export const STORED = 0
export const DEFLATE = 8

/**
 * Where an entry's compressed bytes begin, given its local header's offset and first thirty bytes,
 * or `null` if they are not one. Lengths come from the local header: only it is authoritative here.
 */
export function localHeaderDataStart(offset: number, header: Uint8Array): number | null {
  if (header.length < LOCAL_HEADER_FIXED_SIZE) return null
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
  if (view.getUint32(0, true) !== LOCAL_HEADER_SIGNATURE) return null
  const nameLength = view.getUint16(26, true)
  const extraLength = view.getUint16(28, true)
  return offset + LOCAL_HEADER_FIXED_SIZE + nameLength + extraLength
}

/**
 * Where an entry's data begins: the local header at `offset` read off the handle, its variable
 * part stepped over.
 */
export async function readDataStart(handle: SourceHandle, offset: number, entryName: string): Promise<number> {
  const header = await handle.read({ start: offset, end: offset + LOCAL_HEADER_FIXED_SIZE - 1 })
  const start = localHeaderDataStart(offset, header)
  if (start === null) throw new PlayerError('bad-archive', `${entryName} has a malformed local header`)
  return start
}
