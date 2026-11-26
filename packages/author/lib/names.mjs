/**
 * A library named other than by machine name: what can only mean one library (same letters and
 * digits, any case, `H5P.` and version optional) is taken as it (#174). Titles are not tried.
 */

/**
 * The keys a library is named under in place of `library` or a source's `type`: `type`,
 * `contentType` for sub-content; `contentType`, `library` for a source. Others held text, "table".
 */
export const NAMING_KEYS = ['type', 'contentType', 'library']

/** The longest text taken for a name: a sentence that happens to hold one is not it. */
const LONGEST = 64

/**
 * A name as written and the version after it (`major.minor` or `major.minor.patch`), found with no
 * backtracking regular expression, since what is written is any text.
 * @param {string} text
 * @returns {{ name: string, version?: number[] }}
 */
function split(text) {
  const trimmed = text.trim()
  let at = trimmed.length
  while (at > 0 && !/\s/.test(trimmed[at - 1])) at--
  const version = /^\d+\.\d+(?:\.\d+)?$/.test(trimmed.slice(at)) && at > 0 ? trimmed.slice(at).split('.').map(Number) : undefined
  return version ? { name: trimmed.slice(0, at).trim(), version } : { name: trimmed }
}

/**
 * A name's letters and digits, lower case, without `H5P.` before them or a version after. A
 * number with no point after it is no version: "Question Set 2" is not Question Set.
 * @param {string} text
 */
const letters = (text) => split(text).name.toLowerCase().replace(/^h5p(?![a-z0-9])[\s._-]*/, '').replace(/[^a-z0-9]/g, '')

/**
 * The machine name written, of the names given: the name itself (alone or with major and minor) or
 * the one name of the same letters. `exact` is false when written loosely.
 * @param {unknown} written
 * @param {Iterable<string>} names machine names
 * @returns {{ machineName: string, exact: boolean, major?: number, minor?: number } | null}
 */
export function machineNameOf(written, names) {
  if (typeof written !== 'string' || written.length > LONGEST || !written.trim()) return null
  const all = [...new Set(names)]
  const { name, version } = split(written)
  if (all.includes(name) && (!version || version.length === 2)) return { machineName: name, exact: true, ...(version ? { major: version[0], minor: version[1] } : {}) }
  const key = letters(written)
  if (!key) return null
  const same = all.filter((each) => letters(each) === key)
  return same.length === 1 ? { machineName: same[0], exact: false } : null
}

/**
 * The names nearest to what was written, for a problem to offer: those its letters are part of or
 * end with, at most five; not ones it begins with, as "image" is no lead to "image choice".
 * @param {unknown} written
 * @param {Iterable<string>} names machine names
 * @returns {string[]}
 */
export function nearestNames(written, names) {
  const key = typeof written === 'string' && written.length <= LONGEST ? letters(written) : ''
  if (key.length < 3) return []
  return [...new Set(names)].filter((name) => {
    const own = letters(name)
    return own.length >= 3 && (own.includes(key) || key.endsWith(own))
  }).slice(0, 5)
}

/**
 * The key under which an object names a library where `library` would: of `NAMING_KEYS`, the one
 * whose text names a library of those given; none where two do. `library` is the text to write.
 * @param {Record<string, unknown>} given
 * @param {Iterable<string>} names machine names
 * @returns {{ key: string, machineName: string, major?: number, library: string } | null}
 */
export function namingKey(given, names) {
  const all = [...new Set(names)]
  /** @type {{ key: string, machineName: string, major?: number, library: string }[]} */
  const found = []
  for (const key of NAMING_KEYS) {
    const named = Object.hasOwn(given, key) ? machineNameOf(given[key], all) : null
    if (!named) continue
    const { machineName, major, minor } = named
    found.push({ key, machineName, ...(major === undefined ? {} : { major }), library: major === undefined ? machineName : `${machineName} ${major}.${minor}` })
  }
  return found.length === 1 ? found[0] : null
}

/**
 * The content type a source is written in, as a build reads it (#174, #176): its `type`, as is or
 * loosely, else the one name under `contentType` or `library`; null where none fits, or for a quiz.
 * @param {unknown} source
 * @param {Iterable<string>} names machine names
 * @returns {string | null}
 */
export function sourceType(source, names) {
  if (source === null || typeof source !== 'object' || Array.isArray(source) || 'kind' in source) return null
  const given = /** @type {Record<string, unknown>} */ (source)
  const named = given.type !== undefined ? machineNameOf(given.type, names) : namingKey(given, names)
  return named?.machineName ?? null
}
