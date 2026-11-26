/** A byte range with an inclusive end, the form HTTP uses. */
export interface ByteRange {
  start: number
  end: number
}

export type RangeResult = ByteRange | 'none' | 'unsatisfiable'

/**
 * Parses a `Range` header against a size: the single `bytes` range, `'none'` when it is absent,
 * unusable or multi (`200` is always legal), `'unsatisfiable'` when it selects no bytes: the caller's `416`.
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
