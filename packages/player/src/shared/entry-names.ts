/**
 * Entry-name normalisation. Archives are untrusted: separators and `.` or empty segments are normalised,
 * but a name that escapes the package root is rejected, never sanitised, so it cannot become another valid one.
 */

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

/**
 * Returns the canonical form of a zip entry name, or `null` if unusable: forward slashes, no
 * leading or trailing slash, no `.`, `..` or empty segments.
 */
export function normalizeEntryName(raw: string): string | null {
  if (!raw || CONTROL_CHARS.test(raw)) return null

  // Backslashes are a separator in archives written on Windows, never a literal in H5P names.
  const withSlashes = raw.replace(/\\/g, '/')

  // Absolute paths and drive letters escape the package root.
  if (withSlashes.startsWith('/')) return null
  if (/^[a-zA-Z]:/.test(withSlashes)) return null

  const segments: string[] = []
  for (const segment of withSlashes.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') return null
    segments.push(segment)
  }

  if (segments.length === 0) return null
  return segments.join('/')
}

/**
 * Normalises the path taken from a virtual-server URL. The path arrives percent-encoded from the
 * URL; it is decoded first so that `%2e%2e` is rejected like a literal `..`.
 */
export function normalizeRequestPath(raw: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return null
  }
  return normalizeEntryName(decoded)
}

/**
 * Builds the entry index from raw zip names. Directories, unusable names and a name already taken
 * are dropped: first occurrence wins, so a duplicate cannot shadow a library file already indexed.
 */
export function indexEntryNames<T extends { filename: string; directory?: boolean }>(
  entries: T[]
): { index: Map<string, T>; rejected: string[] } {
  const index = new Map<string, T>()
  const rejected: string[] = []

  for (const entry of entries) {
    if (entry.directory) continue
    const name = normalizeEntryName(entry.filename)
    if (name === null || index.has(name)) {
      rejected.push(entry.filename)
      continue
    }
    index.set(name, entry)
  }

  return { index, rejected }
}
