import { escapeText } from './text.mjs'

/** A tag's canonical form in lower case, as H5P names its files; a name that is no tag as it is. */
function canonical(/** @type {string} */ tag) {
  try {
    return Intl.getCanonicalLocales(tag)[0].toLowerCase()
  } catch {
    return tag.toLowerCase()
  }
}

/** The script a tag is written in, its own or the likely one: `Cyrl` for `sr`. */
function scriptOf(/** @type {string} */ tag) {
  try {
    return new Intl.Locale(tag).maximize().script
  } catch {
    return undefined
  }
}

/**
 * Which translation files serve a language tag, best first: RFC 4647 lookup, never across scripts
 * (`sr-Latn` skips Cyrillic `sr.json`) nor to a bare `zh.json`, Traditional in Question Set 1.21.
 * @param {string[]} files the files' names, without `.json`
 * @param {string} language
 * @internal
 */
export function translationFiles(files, language) {
  const tag = Intl.getCanonicalLocales(language)[0]
  const { language: base, script } = new Intl.Locale(tag).maximize()
  let names
  if (base === 'zh') names = script === 'Hant' ? ['zh-hant', 'zh-tw'] : ['zh-hans', 'zh-cn']
  else {
    const subtags = tag.toLowerCase().split('-')
    names = subtags.map((_, i) => subtags.slice(0, subtags.length - i).join('-')).filter((name) => scriptOf(name) === script)
    if (base === 'no') names.push('nb')
  }
  return names.flatMap((name) => files.filter((file) => canonical(file) === name))
}

/** What the libraries fill into their own texts: `:num`, `@total`, `%d`. */
const PLACEHOLDER = /[:@%][A-Za-z]+/g

/**
 * A translation file's `semantics` laid over a library's as an H5P editor does: a text field's
 * default is replaced, English staying where the translation has no text or lacks a placeholder.
 * @param {any[]} fields
 * @param {unknown} translation
 * @internal
 */
export function translateDefaults(fields, translation) {
  /** @type {{ field: any, text: string }[]} */
  const translated = []
  /** @type {{ field: string, text: string, dropped?: string[] }[]} */
  const english = []
  /** @param {any[]} fields @param {any} translation @param {string} path @param {string} [item] */
  const walk = (fields, translation, path, item) => fields.forEach((field, i) => {
    const entry = Array.isArray(translation) && translation[i] && typeof translation[i] === 'object' ? translation[i] : undefined
    const name = item ?? (path ? `${path}.${field.name}` : field.name)
    if (field.type === 'text' && typeof field.default === 'string') {
      const text = entry?.default
      /** @type {string[]} */
      const kept = typeof text === 'string' ? text.match(PLACEHOLDER) ?? [] : []
      const dropped = typeof text === 'string' ? (field.default.match(PLACEHOLDER) ?? []).filter((/** @type {string} */ placeholder) => !kept.includes(placeholder)) : []
      if (typeof text === 'string' && text.trim() && text !== field.default && !dropped.length) translated.push({ field, text })
      else english.push({ field: name, text: field.default, ...(dropped.length ? { dropped } : {}) })
    }
    if (field.fields) walk(field.fields, entry?.fields, name)
    if (field.field) walk([field.field], entry ? [entry.field] : undefined, name, `${name}[]`)
  })
  walk(fields, translation, '')
  return { strings: translated.length + english.length, translated, english }
}

/**
 * Every plain text default stored as the platforms store it, escaped, as the server escapes typing.
 * The editor puts a default in unescaped, so one in a `tags` field is left to the server's filter.
 * @param {any[]} fields
 */
function escapeDefaults(fields) {
  for (const field of fields) {
    if (field.type === 'text' && typeof field.default === 'string' && (field.tags === undefined || field.tags === null)) field.default = escapeText(field.default)
    if (field.fields) escapeDefaults(field.fields)
    if (field.field) escapeDefaults([field.field])
  }
}

/**
 * @typedef {{ library: string, translation: string | null, strings: number, english: { field: string, text: string, dropped?: string[] }[] }} TranslationReport
 */

/**
 * A library's semantics with its interface texts in a language, from its first translation that
 * translates any. With no editor here, the content's language is used, and English stays wherever no translation text applies.
 * @param {any[]} semantics the library's, left as it is
 * @param {{ name: string, read: () => Promise<unknown> }[]} files its translations that serve the language, best first
 * @param {string} label the library as `H5P.Blanks 1.14`, for the report
 * @returns {Promise<{ semantics: any[], report: TranslationReport }>}
 * @internal
 */
export async function localize(semantics, files, label) {
  for (const file of files) {
    const localized = structuredClone(semantics)
    const { strings, translated, english } = translateDefaults(localized, await file.read())
    if (!translated.length) continue
    for (const { field, text } of translated) field.default = text
    escapeDefaults(localized)
    return { semantics: localized, report: { library: label, translation: file.name, strings, english } }
  }
  const localized = structuredClone(semantics)
  const { strings, english } = translateDefaults(localized, undefined)
  escapeDefaults(localized)
  return { semantics: localized, report: { library: label, translation: null, strings, english } }
}
