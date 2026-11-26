/**
 * The package's description of itself from `h5p.json`, as the runtime reads it: the copyright
 * dialog (`H5P.buildMetadataCopyrights`) and each statement's `object.definition` title use it.
 */
export interface ContentMetadata {
  title?: string
  license?: string
  licenseVersion?: string
  licenseExtras?: string
  source?: string
  yearFrom?: string
  yearTo?: string
  authorComments?: string
  defaultLanguage?: string
  authors?: Array<{ name: string; role?: string }>
  changes?: Array<{ date?: string; author?: string; log: string }>
}

const TEXT_FIELDS = ['title', 'license', 'licenseVersion', 'licenseExtras', 'source', 'yearFrom', 'yearTo', 'authorComments', 'defaultLanguage'] as const

/**
 * The licences H5P's copyright dialog has a name for (`H5P.copyrightLicenses` in the core), which
 * reads its table unchecked: any other string, such as `MIT`, would die at boot, so it is left out.
 */
const KNOWN_LICENSES = new Set([
  'U', 'CC BY', 'CC BY-SA', 'CC BY-ND', 'CC BY-NC', 'CC BY-NC-SA', 'CC BY-NC-ND', 'CC0 1.0', 'GNU GPL', 'PD', 'CC PDM', 'C'
])

/**
 * The metadata fields of a manifest, each kept only with the type the runtime expects: a manifest
 * and a record read back from IndexedDB are untrusted, so the frame document runs it again.
 */
export function contentMetadata(manifest: unknown): ContentMetadata | undefined {
  if (!manifest || typeof manifest !== 'object') return undefined
  const source = manifest as Record<string, unknown>
  const out: ContentMetadata = {}
  for (const field of TEXT_FIELDS) {
    const value = source[field]
    // A year arrives as a number from some exporters; the runtime only concatenates it.
    if (typeof value === 'string' && value) out[field] = value
    else if (typeof value === 'number' && (field === 'yearFrom' || field === 'yearTo')) out[field] = String(value)
  }
  if (out.license && !KNOWN_LICENSES.has(out.license)) {
    delete out.license
    delete out.licenseVersion
  }
  const authors = list(source.authors, (item) => {
    const name = text(item.name)
    if (!name) return null
    const role = text(item.role)
    return role ? { name, role } : { name }
  })
  if (authors.length) out.authors = authors
  const changes = list(source.changes, (item) => {
    const log = text(item.log)
    if (!log) return null
    const change: { date?: string; author?: string; log: string } = { log }
    const date = text(item.date)
    const author = text(item.author)
    if (date) change.date = date
    if (author) change.author = author
    return change
  })
  if (changes.length) out.changes = changes
  return Object.keys(out).length ? out : undefined
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)

function list<T>(value: unknown, pick: (item: Record<string, unknown>) => T | null): T[] {
  if (!Array.isArray(value)) return []
  const out: T[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const picked = pick(item as Record<string, unknown>)
    if (picked) out.push(picked)
  }
  return out
}
