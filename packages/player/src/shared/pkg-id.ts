/**
 * Package identity, derived from what identifies the bytes, not a counter: the same URL (and
 * validator) or picked file finds its cached chunks again on a later visit.
 */

const encoder = new TextEncoder()

/** Bytes as lower-case hex, two characters each. */
export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** `count` random bytes as hex: a nonce, a token, a key nothing outside its holder can guess. */
export function randomHex(count: number): string {
  return hex(crypto.getRandomValues(new Uint8Array(count)))
}

async function sha256Hex(input: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(input))))
}

/** 32 hex characters: 128 bits, short enough to read in a URL and far past collision risk here. */
export const PKG_ID_LENGTH = 32
/** The bytes of randomness in a load key: 16 hex characters in a route. */
export const LOAD_KEY_BYTES = 8

async function shortHash(input: string): Promise<string> {
  return (await sha256Hex(input)).slice(0, PKG_ID_LENGTH)
}

/**
 * Id for a remote package. The validator (`ETag`, else `Last-Modified`) is folded in when the host
 * has one, so a republished archive at the same URL does not collide with the old chunks.
 */
export function remotePkgId(url: string, validator?: string | null): Promise<string> {
  return shortHash(`url\u0000${url}\u0000${validator ?? ''}`)
}

/**
 * Id for a picked file: name, size and mtime are all a browser exposes. The descriptor row dies
 * with the session (a `File` cannot be persisted), but the chunks survive and are found again.
 */
export function filePkgId(file: { name: string; size: number; lastModified: number }): Promise<string> {
  return shortHash(`file\u0000${file.name}\u0000${file.size}\u0000${file.lastModified}`)
}

/**
 * Id for a library pack part, from its hash alone: one library is kept once whoever serves it
 * (a CDN, a host's copy, a hashed bundler asset), and a part already kept needs no request.
 */
export function partPkgId(sha256: string): Promise<string> {
  return shortHash(`part\u0000${sha256}`)
}

/**
 * A key for one load of a package, under which the worker keeps what the load asked for (trust,
 * language, options, bundle). Random, so no two loads share one and only the frame can name it.
 */
export function loadKey(): string {
  return randomHex(LOAD_KEY_BYTES)
}
