/**
 * A source's own fields, declared once (#230): `sourceOf` holds each to it, and it is the `Source`
 * type. In zod/mini, as a build runs in a page, where zod's chained API weighs four times as much.
 */
import * as z from 'zod/mini'
import { CC_VERSIONS, LICENSES, ROLES } from './metadata.mjs'

/** @internal */
export const TYPE = 'expected a content type\'s machine name, such as "H5P.Blanks"'
const TITLE = 'expected the activity\'s title'
const LANGUAGE = 'expected a BCP 47 language tag, such as "en" or "de-AT"'
const NAME = 'expected the author\'s name'
const AUTHORS = 'name at least one author: [{ "name": "…", "role": "Author" }]'
const ADDRESS = 'expected the address the content comes from'
const YEAR = 'expected a year'
const YEAR_RANGE = 'takes a year from -9999 to 9999, as H5P does'
const BUILT_WITH = 'is written by a build, the content type and its version then, as "H5P.Blanks 1.14": leave it out'

/** @param {string} text */
const written = (text) => text.trim() !== ''

// H5P's upload counts a title's or a name's bytes, not its letters, and takes no line break (h5p.classes.php).
const BYTES = 'takes at most 255 bytes, as H5P counts them: a letter of Cyrillic, Greek or Chinese takes two or three'
const fits = (/** @type {string} */ text) => new TextEncoder().encode(text).length <= 255
const oneLine = (/** @type {string} */ text) => !/[\r\n]/.test(text)
const LINE = 'takes no line break'

/** Text H5P's upload takes up to 5000 bytes of, line breaks and all: extra terms, comments, a change's log. */
const LONG = 'takes at most 5000 bytes, as H5P counts them'
const fitsLong = (/** @type {string} */ text) => new TextEncoder().encode(text).length <= 5000
const longText = (/** @type {string} */ what) => z.string({ error: `expected ${what}` }).check(z.refine(written, { error: `expected ${what}` }), z.refine(fitsLong, { error: LONG }))

/** A change in the content's log, as H5P's metadata form records one (`changes` in h5p.json). */
const DATE = 'expected the date and time as H5P writes it, "dd-mm-yy hh:mm:ss", as "28-11-26 14:05:00"'
const change = z.strictObject({
  date: z.string({ error: DATE }).check(z.regex(/^\d{2}-\d{2}-\d{2} \d{1,2}:\d{2}:\d{2}$/, { error: DATE })),
  author: z.string({ error: 'expected who made the change' }).check(z.refine(written, { error: 'expected who made the change' }), z.refine(fits, { error: BYTES }), z.refine(oneLine, { error: LINE })),
  log: longText('what changed')
}, { error: (issue) => (issue.code === 'unrecognized_keys' ? 'is not part of a change; write date, author and log' : 'expected a change, { "date": "28-11-26 14:05:00", "author": "…", "log": "…" }') })

/** A language H5P's upload takes: letters and hyphens, at most 10, so not a region by number. @param {string} tag */
const h5pTag = (tag) => /^[-a-zA-Z]{1,10}$/.test(tag)

/** @param {string} tag */
const isTag = (tag) => {
  try {
    Intl.getCanonicalLocales(tag)
    return true
  } catch {
    return false
  }
}

/** An author, in a role H5P names. One written as a name alone, as a chat writes one, is said with the object to write. */
const author = z.strictObject({
  name: z.string({ error: NAME }).check(z.refine(written, { error: NAME }), z.refine(fits, { error: BYTES }), z.refine(oneLine, { error: LINE })),
  role: z.enum(ROLES, { error: `use one of ${ROLES.join(', ')}` })
}, {
  error: (issue) => {
    if (issue.code === 'unrecognized_keys') return 'is not part of an author; write name and role'
    return typeof issue.input === 'string'
      ? `expected an author: write { "name": ${JSON.stringify(issue.input)}, "role": "Author" }`
      : 'expected an author, { "name": "…", "role": "Author" }'
  }
})

/** A source's fields, in the order they are listed, each with what it takes. */
const fields = {
  type: z.string({ error: TYPE }).check(z.refine(written, { error: TYPE }), z.describe('The content type\'s machine name, as "H5P.MultiChoice"')),
  title: z.string({ error: TITLE }).check(z.refine(written, { error: TITLE }), z.refine(fits, { error: BYTES }), z.refine(oneLine, { error: LINE })),
  language: z.string({ error: LANGUAGE }).check(z.refine(isTag, { error: LANGUAGE }), z.refine(h5pTag, {
    error: (issue) => `is a tag H5P's upload refuses, which takes letters and hyphens, at most 10: write ${JSON.stringify(String(issue.input).split('-')[0])}`
  }), z.describe('A BCP 47 tag, as "en"')),
  license: z.enum(LICENSES, { error: `use one of ${LICENSES.map((each) => JSON.stringify(each)).join(', ')}; "U" when it is not known` }),
  licenseVersion: z.optional(z.enum(CC_VERSIONS, { error: `use one of ${CC_VERSIONS.join(', ')}` }).check(z.describe('For a CC BY licence only'))),
  authors: z.array(author, { error: AUTHORS }).check(z.minLength(1, { error: AUTHORS })),
  source: z.optional(z.string({ error: ADDRESS }).check(z.regex(/^https?:\/\/\S+$/, { error: ADDRESS }), z.maxLength(255, { error: 'takes at most 255 characters, which H5P keeps of it' }))),
  yearFrom: z.optional(z.int({ error: YEAR }).check(z.gte(-9999, { error: YEAR_RANGE }), z.lte(9999, { error: YEAR_RANGE }))),
  yearTo: z.optional(z.int({ error: YEAR }).check(z.gte(-9999, { error: YEAR_RANGE }), z.lte(9999, { error: YEAR_RANGE }))),
  licenseExtras: z.optional(longText('the licence\'s extra terms').check(z.describe('Terms beside the licence, as attribution asked for'))),
  changes: z.optional(z.array(change, { error: 'expected a list of changes' }).check(z.describe('The content\'s change log, oldest first'))),
  authorComments: z.optional(longText('the author\'s comments').check(z.describe('The author\'s notes on the content, which H5P shows its editors alone'))),
  params: z.optional(z.record(z.string(), z.unknown(), { error: 'expected an object of the content type\'s fields' })
    .check(z.describe('The content type\'s fields that differ from their defaults'))),
  builtWith: z.optional(z.string({ error: BUILT_WITH }).check(z.regex(/^\S+ \d+\.\d+$/, { error: BUILT_WITH }),
    z.describe('Written by a build, never by hand: the content type and its version when the source was last built')))
}

/** @internal What is said of a key that is no field of a source: those one writes, so not what a build writes in it. */
export const NO_FIELD = `is not a field of a source; the fields are ${Object.keys(fields).filter((name) => name !== 'builtWith').join(', ')}`
/** @internal What is said of a source that is no object. */
export const NO_SOURCE = 'expected an object: { "type", "title", "language", "license", "authors", "params" }'

/**
 * What a source says of itself and its content's fields in `params`, nothing else. What a field
 * cannot say alone stays in `sourceOf`: loose type names, licence versions, misplaced fields.
 */
export const sourceSchema = z.strictObject(fields, {
  error: (issue) => (issue.code === 'unrecognized_keys' ? NO_FIELD : NO_SOURCE)
})

/**
 * Holds a value written for one of `sourceSchema`'s fields to it, and says each problem at the path
 * it was written at, one a path, as a build says one thing of a field.
 * @param {z.ZodMiniType} schema one of `sourceSchema.shape`
 * @param {unknown} value as written
 * @param {string} path where it was written
 * @param {(path: string, message: string) => void} report
 * @returns {boolean} whether it holds
 * @internal
 */
export function holds(schema, value, path, report) {
  const result = schema.safeParse(value)
  if (result.success) return true
  const said = new Set()
  for (const issue of result.error.issues) {
    // Keys that are no part of an object are one issue: a problem each, at its own path.
    const places = issue.code === 'unrecognized_keys' ? issue.keys.map((key) => [...issue.path, key]) : [issue.path]
    for (const place of places) {
      const at = path + place.map((key) => (typeof key === 'number' ? `[${key}]` : `.${String(key)}`)).join('')
      if (said.has(at)) continue
      said.add(at)
      report(at, issue.message)
    }
  }
  return false
}

/** @internal An author as `sourceSchema` takes one, for keeping those that are right. */
export const authorHolds = (/** @type {unknown} */ value) => author.safeParse(value).success
