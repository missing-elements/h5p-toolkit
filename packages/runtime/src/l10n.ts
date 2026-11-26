/**
 * Which core translations a frame gets: `dist/l10n.js` sets `window.H5PRuntimeL10n` and the boot
 * script picks one for the frame's `lang`; the player knows no language list.
 */

/**
 * A language tag, as the player's `shared/language.ts` accepts one: keep the two in step, and
 * `scripts/build.mjs`'s copy, which cannot import this file.
 */
export const LANGUAGE_TAG = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/

/**
 * The language for a declared tag, by the RFC 4647 lookup: the tag, then its last subtag cut
 * (`de-AT` gets `de`), each as written and via aliases. `undefined` when no strings (English).
 */
export function matchLanguage(tag: string | undefined, languages: readonly string[], aliases: Record<string, string> = {}): string | undefined {
  if (!tag || !LANGUAGE_TAG.test(tag)) return undefined
  const byName = new Map(languages.map((each) => [each.toLowerCase(), each]))
  const alias = new Map(
    Object.entries(aliases)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([from, to]) => [from.toLowerCase(), to.toLowerCase()])
  )

  let subtags = tag.toLowerCase().split('-')
  while (subtags.length) {
    const candidate = subtags.join('-')
    const found = byName.get(candidate) ?? byName.get(alias.get(candidate) ?? '')
    if (found) return found
    subtags = subtags.slice(0, -1)
    // A single letter opens an extension or a private use part; it goes with what followed it.
    if (subtags.length && subtags[subtags.length - 1].length === 1) subtags = subtags.slice(0, -1)
  }
  return undefined
}

/**
 * The strings laid over the core's English for a frame in `tag`, from the table in `dist/l10n.js`.
 * `undefined` without a table (an English frame loads none) or a language for the tag.
 */
export function coreTranslations(table: unknown, tag: string | undefined): { H5P: Record<string, string> } | undefined {
  if (!table || typeof table !== 'object') return undefined
  const { languages, aliases } = table as { languages?: unknown; aliases?: unknown }
  if (!languages || typeof languages !== 'object') return undefined
  const match = matchLanguage(tag, Object.keys(languages), aliases && typeof aliases === 'object' ? (aliases as Record<string, string>) : {})
  const strings = match === undefined ? undefined : (languages as Record<string, unknown>)[match]
  if (!strings || typeof strings !== 'object') return undefined

  const H5P: Record<string, string> = {}
  for (const [key, value] of Object.entries(strings)) {
    if (typeof value === 'string') H5P[key] = value
  }
  return { H5P }
}
