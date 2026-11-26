import type { LibrarySource } from './protocol.js'

/**
 * The `libraries` attribute: `pack` or URLs, whitespace separated, in order. Any other word is a
 * URL relative to the page, so a leftover `hub` (read as `pack` to 0.10) fails on its address.
 */
export function parseLibrarySources(value: string | null | undefined): LibrarySource[] {
  const words = value?.trim() ? value.trim().split(/\s+/) : []
  const sources = words.map((word): LibrarySource => (word === 'pack' ? 'pack' : { url: word }))
  // `pack` written twice would try the same parts twice.
  return sources.filter((source, index) => source !== 'pack' || sources.indexOf('pack') === index)
}
