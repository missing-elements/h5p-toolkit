import zlib from 'node:zlib'
import { crc32 as tableCrc32 } from './crc32-table.mjs'

/**
 * CRC-32 of `bytes`, continuing from `previous`: zlib's from Node 22.2 on, a table before. Not a
 * named import: a missing builtin export fails at link time and kills the script on older Node.
 *
 * @type {(bytes: Uint8Array, previous?: number) => number}
 */
export const crc32 =
  typeof zlib.crc32 === 'function'
    ? (bytes, previous = 0) => zlib.crc32(bytes, previous)
    : (bytes, previous = 0) => tableCrc32(bytes, previous)
