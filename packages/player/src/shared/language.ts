/**
 * The element's language: a tag read off its `lang` (own or inherited) and written by the worker as
 * the frame's. Which core strings a tag gets is the runtime's business; English needs none.
 */

/**
 * A language tag as the player reads one: a primary subtag of letters, then subtags of letters
 * and digits, as the runtime holds them. It passes through IndexedDB, so the worker checks again.
 */
export const LANGUAGE_TAG = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/

/** A declared language as a tag, `de_DE`, a common way to write `de-DE`, as that; `undefined` for anything else. */
export function languageTag(declared: string | undefined): string | undefined {
  const tag = declared?.trim().replaceAll('_', '-')
  return tag && LANGUAGE_TAG.test(tag) ? tag : undefined
}

/** English, the core's own language, which needs none of the runtime's translations. */
export function isEnglish(tag: string): boolean {
  return tag.split('-')[0].toLowerCase() === 'en'
}
