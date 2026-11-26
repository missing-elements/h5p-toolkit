/**
 * Which build of a package a learner completed, in xAPI's `context.revision` (a fingerprint of the
 * archive's index) and `context.platform` (the player). H5P core sets neither.
 */
import { hex } from './pkg-id.js'


/** One central-directory record, as much of it as the fingerprint covers. */
export interface FingerprintEntry {
  /** The name's bytes as stored, so no decoding choice — CP437 or UTF-8 — can change the result. */
  rawName: Uint8Array
  crc32: number
  compressedSize: number
  size: number
  method: number
}

/**
 * SHA-256 of the index (a range-read package is never read whole), as `sha256:<hex>`: each entry's
 * name, CRC-32, sizes and method in archive order, no dates. Keep in step with the normalizer's `lib/fingerprint.mjs`.
 */
export async function indexFingerprint(entries: Iterable<FingerprintEntry>): Promise<string> {
  const parts: Uint8Array[] = []
  let length = 0
  for (const entry of entries) {
    const record = new Uint8Array(4 + entry.rawName.length + 4 + 8 + 8 + 2)
    const view = new DataView(record.buffer)
    let at = 0
    view.setUint32(at, entry.rawName.length, true)
    at += 4
    record.set(entry.rawName, at)
    at += entry.rawName.length
    view.setUint32(at, entry.crc32 >>> 0, true)
    at += 4
    view.setBigUint64(at, BigInt(entry.compressedSize), true)
    at += 8
    view.setBigUint64(at, BigInt(entry.size), true)
    at += 8
    view.setUint16(at, entry.method, true)
    parts.push(record)
    length += record.length
  }

  const all = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    all.set(part, offset)
    offset += part.length
  }

  return `sha256:${hex(new Uint8Array(await crypto.subtle.digest('SHA-256', all)))}`
}

/**
 * The revision of what was played: the package's fingerprint, then what supplied its libraries (a
 * bundle's, or `librariesFingerprint` of the pack parts). Other libraries make another revision.
 */
export function revisionOf(content: string, libraries: readonly string[] = []): string {
  return libraries.length === 0 ? content : `${content}; libraries ${libraries.join(', ')}`
}

/**
 * One fingerprint for the library pack parts a package used, sorted so it names the set, not the
 * order. A pack release changing none of the used parts keeps the revision and the saved state.
 */
export async function librariesFingerprint(fingerprints: readonly string[]): Promise<string> {
  const text = new TextEncoder().encode([...fingerprints].sort().join('\n'))
  return `sha256:${hex(new Uint8Array(await crypto.subtle.digest('SHA-256', text)))}`
}

/** What `context.platform` says: the player, and its version. */
export function platformOf(version: string): string {
  return `h5p-offline-player ${version}`
}

type Statement = Record<string, unknown> & {
  object?: { objectType?: unknown }
  context?: Record<string, unknown>
}

/**
 * A copy of `statement` with `context.revision` and `context.platform` filled in, only where the
 * spec allows (the object is an Activity, as no `objectType` means) and never over content's own.
 */
export function withProvenance(statement: unknown, revision: string | null, platform: string): unknown {
  if (!statement || typeof statement !== 'object') return statement
  const source = statement as Statement
  const objectType = source.object?.objectType
  if (objectType !== undefined && objectType !== 'Activity') return statement

  const context = { ...(source.context ?? {}) }
  if (revision && context.revision === undefined) context.revision = revision
  if (context.platform === undefined) context.platform = platform
  return { ...source, context }
}
