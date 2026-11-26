/**
 * Whether a statement is the content's result (`finished`): `completed` or `answered` from the
 * content, not a part. A part has a `parent` or the `h5p-subContentId` extension.
 */

const RESULT_VERBS = new Set(['http://adlnet.gov/expapi/verbs/completed', 'http://adlnet.gov/expapi/verbs/answered'])

/** The core's mark on a statement from sub-content, written by `XAPIEvent.setObject`. */
export const SUB_CONTENT_EXTENSION = 'http://h5p.org/x-api/h5p-subContentId'

interface StatementLike {
  verb?: { id?: unknown }
  object?: { definition?: { extensions?: Record<string, unknown> } }
  context?: { contextActivities?: { parent?: unknown } }
}

export function isResult(statement: unknown): boolean {
  if (!statement || typeof statement !== 'object') return false
  const { verb, object, context } = statement as StatementLike
  // Truthiness, as the core's `getVerifiedStatementValue` check has it: an empty list still names
  // a parent.
  if (context?.contextActivities?.parent) return false
  // Interactive Book 1.15, Game Map 1.5 and Virtual Tour 0.5 make parts with no parent; the core
  // marks every sub-content statement with this extension.
  if (object?.definition?.extensions?.[SUB_CONTENT_EXTENSION]) return false
  return typeof verb?.id === 'string' && RESULT_VERBS.has(verb.id)
}
