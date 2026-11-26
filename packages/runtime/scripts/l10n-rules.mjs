import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The rules `build-l10n.mjs` holds the translations to, kept apart so that `tests/l10n.test.ts`
 * holds the committed files to the same ones.
 */

/**
 * The core's interface strings in English, by key: the player's part of `getLocalization()` in the
 * vendored core, written by `sync-core.mjs` with it.
 * @returns {Record<string, string>}
 */
export function coreStrings() {
  const path = resolve(import.meta.dirname, '..', 'vendor', 'h5p-core', 'strings.json')
  /** @type {Record<string, unknown>} */
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  const strings = Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'string'))
  if (Object.keys(strings).length < 50) throw new Error(`[h5p-runtime] only ${Object.keys(strings).length} strings in ${path}`)
  return /** @type {Record<string, string>} */ (strings)
}

/** The `:name` placeholders the core fills in, `:num` in "Retrying in :num....", in order. */
const placeholders = (/** @type {string} */ value) => (value.match(/:[A-Za-z]+/g) ?? []).sort().join(' ')

/**
 * Why a translation cannot replace the English, or `null`: the core fills `:placeholders` in by
 * name, so a renamed one shows raw; markup and `"` are refused, as strings go into HTML attributes.
 * @param {string} english
 * @param {unknown} translated
 * @returns {string | null}
 */
export function translationProblem(english, translated) {
  if (typeof translated !== 'string' || !translated.trim()) return 'empty'
  if (/[<>"]/.test(translated)) return 'markup or a double quote'
  if (translated.includes('{$a')) return "a Moodle placeholder, {$a}"
  if (placeholders(translated) !== placeholders(english)) return `placeholders ${placeholders(translated) || 'none'}, not ${placeholders(english) || 'none'}`
  return null
}

/** Packs whose code does not say their language the way a tag does: Serbian's two scripts, and Valencian. */
const PACK_TAGS = /** @type {Record<string, string>} */ ({ sr_cr: 'sr-Cyrl', sr_lt: 'sr-Latn', ca_valencia: 'ca-valencia' })

/**
 * The tag a Moodle pack is written under, or `null` for a variant. `xx_yy` is region `YY` only
 * where the pack's `langconfig.php` says so: `fi_co` is Finnish for companies, not Colombia.
 * @param {string} code
 * @param {Record<string, string>} config the strings of the pack's `langconfig.php`
 * @returns {string | null}
 */
export function packTag(code, config) {
  const tag = codeTag(code, config)
  return tag && Intl.getCanonicalLocales(tag)[0]
}

/** `packTag` before the canonical form. @param {string} code @param {Record<string, string>} config */
function codeTag(code, config) {
  if (Object.hasOwn(PACK_TAGS, code)) return PACK_TAGS[code]
  if (/^[a-z]{2,3}$/.test(code)) return code
  const regional = /^([a-z]{2,3})_([a-z]{2})$/.exec(code)
  if (!regional) return null
  const [, language, region] = regional
  const locale = String(config.locale ?? '').toLowerCase().split(/[.@]/)[0]
  const iso = String(config.iso6391 ?? '').toLowerCase()
  return locale === `${language}_${region}` || iso === `${language}-${region}` ? `${language}-${region.toUpperCase()}` : null
}
