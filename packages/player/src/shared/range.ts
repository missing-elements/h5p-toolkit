/** A byte range with an inclusive end, the form HTTP uses. */
export interface ByteRange {
  start: number
  end: number
}

export type RangeResult = ByteRange | 'none' | 'unsatisfiable'

/**
 * Parses a `Range` header against a size: one `bytes` range; `'none'` if absent, unusable or multi (`200`);
 * `'unsatisfiable'` (`416`) for `-0`, a start past the end or end < start. A suffix on size 0 gives end -1.
 */
export function parseRange(header: string | null | undefined, size: number): RangeResult {
  if (!header) return 'none'

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return 'none'

  const [, rawStart, rawEnd] = match

  if (rawStart === '' && rawEnd === '') return 'none'

  // Suffix range: `bytes=-N` means the last N bytes.
  if (rawStart === '') {
    const suffixLength = Number(rawEnd)
    if (suffixLength === 0) return 'unsatisfiable'
    // Satisfiable on an empty entry (RFC 9110 §14.1.2), but no byte range says zero bytes: the whole (#293).
    if (size === 0) return 'none'
    const start = Math.max(0, size - suffixLength)
    return { start, end: size - 1 }
  }

  const start = Number(rawStart)
  if (start >= size) return 'unsatisfiable'

  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  if (end < start) return 'unsatisfiable'

  return { start, end }
}

export function contentRange(range: ByteRange, size: number): string {
  return `bytes ${range.start}-${range.end}/${size}`
}
