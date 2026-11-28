import { TextReader } from '@zip.js/zip.js'
import { librariesNamedIn, planPack } from '@missing-elements/h5p-offline-player/plan'
import { checkContent, layoutContext, valueAt } from './check.mjs'
import { ContentGenerator, libraryString } from './generator.mjs'
import { coreApiOf, installClosure } from './install.mjs'
import { loadLibraries } from './libraries.mjs'
import { CC_VERSIONS } from './metadata.mjs'
import { machineNameOf, NAMING_KEYS, namingKey, nearestNames } from './names.mjs'
import { quizProblems, quizSource } from './quiz.mjs'
import { outlineOf } from './outline.mjs'
import { SourceError } from './source-error.mjs'
import { authorHolds, holds, NO_FIELD, NO_SOURCE, sourceSchema, TYPE } from './source-schema.mjs'
import { escapeText } from './text.mjs'
import { byNumber, LAYOUTS, placesOf, videoTimes } from './types.mjs'

export { SourceError }

/**
 * The build `node.mjs` and `browser.mjs` share, but for where the files are and the package goes:
 * a source made a package. Nothing is written unless all is right: every problem comes at once.
 */

/**
 * @typedef {import('zod/mini').output<typeof sourceSchema>} Source a package's source, as `sourceSchema`
 *   declares it: the content type, its metadata, and the parameters that differ from the defaults
 * @typedef {Source['authors'][number]} Author
 * @typedef {{ path: string, message: string }} Problem
 * @typedef {import('./translate.mjs').TranslationReport} TranslationReport
 */

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Each part in content: what holds `library`, `params` and `metadata`, as sub-content is saved.
 * @param {unknown} value
 * @returns {Generator<{ library: string, params: Record<string, any>, metadata: Record<string, any> }>}
 */
function* partsOf(value) {
  if (Array.isArray(value)) for (const each of value) yield* partsOf(each)
  else if (isObject(value)) {
    if (typeof value.library === 'string' && /^\S+ \d+\.\d+$/.test(value.library) && isObject(value.params) && isObject(value.metadata)) yield /** @type {any} */ (value)
    for (const each of Object.values(value)) yield* partsOf(each)
  }
}

/**
 * A file's copyright as its part's metadata, as the editor's metadata form holds it: PD with a
 * version that is a licence of its own there is that licence; a year that is a number is its first.
 * @param {Record<string, string>} copyright as `MediaStore` made it
 * @param {string} [title] the part's own, which a copyright's title does not take the place of
 */
function metadataOf(copyright, title) {
  const { license = 'U', version, author, source, year } = copyright
  const own = license === 'PD' && (version === 'CC0 1.0' || version === 'CC PDM') ? version : license
  return {
    license: own,
    ...(own.startsWith('CC BY') && version && CC_VERSIONS.includes(version) ? { licenseVersion: version } : {}),
    ...(author ? { authors: [{ name: author, role: 'Author' }] } : {}),
    ...(copyright.title && !title ? { title: copyright.title } : {}),
    ...(source && /^https?:\/\/.+/.test(source) ? { source } : {}),
    ...(year && /^-?\d{1,4}$/.test(year.trim()) ? { yearFrom: Number(year) } : {})
  }
}

/** A source's fields, as `sourceSchema` declares them. */
const FIELDS = Object.keys(sourceSchema.shape)
/** Those a source says of itself, which H5P keeps in an object of their own, `metadata`. */
const OWN = FIELDS.filter((name) => name !== 'type' && name !== 'params' && name !== 'builtWith')

/**
 * The machine names a source's `type` may be: the pack's libraries but those carried only for an
 * H5P site's upload check. Which of them are content types the index does not say; the build does.
 * @param {import('./pack.mjs').Pack} pack
 * @returns {string[]}
 * @internal
 */
export const typeNames = (pack) => [...new Set(pack.libraries.filter((entry) => !entry.installOnly).map((entry) => entry.machineName))]

/**
 * A source read for a build: its fields checked, and a chat's own outer shape taken as meant (#174)
 * so the content is checked in one round. While `problems` has any, `source` is not for building.
 * @param {unknown} input
 * @param {string[]} [names] the machine names `type` may be, to tell a name written loosely
 * @returns {{ source: Source, problems: Problem[], typed: boolean }}
 * @internal
 */
export function sourceOf(input, names) {
  if (isObject(input) && 'kind' in input) {
    const problems = quizProblems(input)
    if (problems.length) throw new SourceError(problems)
    return { source: /** @type {Source} */ (quizSource(/** @type {import('./quiz.mjs').Quiz} */ (input))), problems: [], typed: true }
  }
  /** @type {Problem[]} */
  const problems = []
  const report = (/** @type {string} */ path, /** @type {string} */ message) => problems.push({ path, message })
  if (!isObject(input)) throw new SourceError([{ path: 'source', message: NO_SOURCE }])
  /** @type {Record<string, any>} what is written for each field */
  const given = Object.fromEntries(FIELDS.filter((name) => input[name] !== undefined).map((name) => [name, input[name]]))
  /** @type {Record<string, string>} where each is written */
  const at = Object.fromEntries(FIELDS.map((name) => [name, name]))
  let rest = Object.keys(input).filter((key) => !FIELDS.includes(key))

  // The content type under another key, `contentType` or `library`: the one that names one.
  let named = ''
  if (given.type === undefined) {
    const others = Object.fromEntries(rest.map((key) => [key, input[key]]))
    const keys = names ? [] : rest.filter((key) => NAMING_KEYS.includes(key) && typeof input[key] === 'string' && input[key].length <= 64 && /^\s*H5P\.[^\s.]+(?:\s+\d+\.\d+)?\s*$/.test(input[key]))
    const found = names ? namingKey(others, names) : keys.length === 1 ? { key: keys[0], machineName: input[keys[0]].trim().split(/\s+/)[0] } : null
    if (found) {
      named = found.machineName
      report(found.key, `is not a field of a source: the content type is its type: write "type": "${named}"`)
      given.type = named
      rest = rest.filter((each) => each !== found.key)
    }
  }
  // What a source says of itself, in an object of its own: `metadata`, as H5P keeps it. Only
  // there, since a field of the content, Question Set's `introPage`, may have a title too.
  const value = rest.includes('metadata') && isObject(input.metadata) ? input.metadata : null
  const own = value ? OWN.filter((name) => given[name] === undefined && value[name] !== undefined) : []
  if (value && own.length) {
    report('metadata', `is not a field of a source: ${own.join(', ')} ${own.length === 1 ? 'is' : 'are'} written beside type, not in an object: write ${own.map((name) => `"${name}": …`).join(', ')} at the top`)
    for (const name of own) {
      given[name] = value[name]
      at[name] = `metadata.${name}`
    }
    for (const inner of Object.keys(value)) {
      if (!own.includes(inner)) report(`metadata.${inner}`, OWN.includes(inner) ? 'is written beside type already' : NO_FIELD)
    }
    rest = rest.filter((each) => each !== 'metadata')
  }
  // The content's fields beside `type`.
  if (rest.length && given.params === undefined) {
    report('params', `is not written: the content's fields go in it, not beside type: write "params": { ${rest.map((key) => `"${key}": …`).join(', ')} }`)
    given.params = Object.fromEntries(rest.map((key) => [key, input[key]]))
  } else for (const key of rest) report(key, NO_FIELD)

  // Each field held to `sourceSchema`, with what it cannot say alone written here.
  const field = sourceSchema.shape
  let typed = false
  const type = typeof given.type === 'string' ? given.type.trim() : ''
  if (named) typed = true
  else if (!type) holds(field.type, given.type, at.type, report)
  else if (names) {
    const found = machineNameOf(type, names)
    if (!found) {
      const nearest = nearestNames(type, names)
      report(at.type, `the library pack has no content type ${type}${nearest.length ? `; nearest: ${nearest.join(', ')}` : ''}`)
    } else {
      typed = true
      // checkContent takes a version, as saved content names one; a build takes the pack's newest.
      if (found.exact && /\s/.test(type)) report(at.type, `takes the machine name alone, "${found.machineName}": the version is the pack's newest`)
      else if (!found.exact) report(at.type, `takes the machine name, "${found.machineName}"`)
      given.type = found.machineName
    }
  } else if (/^\S+\s+\d+\.\d+$/.test(type)) {
    const [name] = type.split(/\s/)
    report(at.type, `takes the machine name alone, "${name}": the version is the pack's newest`)
    given.type = name
    typed = true
  } else if (!/^\S+$/.test(type)) report(at.type, TYPE)
  else typed = true

  /** @type {Record<string, any>} a stand-in for each field that does not hold */
  const source = { type: typed ? String(given.type).trim() : '', title: '', language: 'en', license: 'U', authors: [], params: {} }
  if (holds(field.title, given.title, at.title, report)) source.title = given.title
  if (holds(field.language, given.language, at.language, report)) source.language = given.language
  // A licence written with its version, "CC BY 4.0", as it is spoken of: H5P keeps the version in a
  // field of its own, and listing the names alone had a chat drop the version to fit one.
  const versioned = typeof given.license === 'string' ? /^CC[ -](BY(?:-(?:NC-SA|NC-ND|NC|ND|SA))?)[ -]v?(\d\.\d)$/i.exec(given.license.trim()) : null
  const license = versioned ? `CC ${versioned[1].toUpperCase()}` : given.license
  if (versioned) {
    const written = JSON.stringify(given.license)
    if (given.licenseVersion !== undefined) report(at.license, `${written} holds the version too, which licenseVersion names: write "license": "${license}"`)
    else if (CC_VERSIONS.includes(versioned[2])) report(at.license, `${written} holds the version too: write "license": "${license}" and "licenseVersion": "${versioned[2]}"`)
    else report(at.license, `${written} holds a version too: write "license": "${license}" and "licenseVersion", one of ${CC_VERSIONS.join(', ')}`)
    source.license = license
    if (given.licenseVersion === undefined && CC_VERSIONS.includes(versioned[2])) source.licenseVersion = versioned[2]
  } else if (holds(field.license, given.license, at.license, report)) source.license = given.license
  if (given.licenseVersion !== undefined) {
    if (!String(license).startsWith('CC ') || license === 'CC0 1.0' || license === 'CC PDM') report(at.licenseVersion, 'is for a Creative Commons BY licence only')
    else if (holds(field.licenseVersion, given.licenseVersion, at.licenseVersion, report)) source.licenseVersion = given.licenseVersion
  }
  // The authors that hold are kept, so the content is checked with them.
  const authorsHold = holds(field.authors, given.authors, at.authors, report)
  if (Array.isArray(given.authors)) source.authors = authorsHold ? given.authors : given.authors.filter(authorHolds)
  // An address written as a bare host, as the editor takes one: it puts http:// before it (#302).
  const bare = typeof given.source === 'string' && /^(?![a-z][a-z0-9+.-]*:)[\w-]+(?:\.[\w-]+)+(?:[/?#]\S*)?$/i.test(given.source.trim())
  const taken = bare ? { ...given, source: `http://${given.source.trim()}` } : given
  for (const key of /** @type {const} */ (['source', 'yearFrom', 'yearTo', 'params', 'builtWith'])) {
    if (taken[key] !== undefined && holds(field[key], taken[key], at[key], report)) source[key] = taken[key]
  }
  return { source: /** @type {Source} */ (source), problems, typed }
}

/**
 * The general source checked for its own fields; a quiz in the published format mapped onto it.
 * @param {unknown} input
 * @returns {Source}
 * @throws {SourceError} with every problem of its own fields
 * @internal
 */
export function readSource(input) {
  const { source, problems } = sourceOf(input)
  if (problems.length) throw new SourceError(problems)
  return source
}

/**
 * The libraries a package carries: what the content names, what those need and the addons whose
 * pattern its text matches, by the player's own plan (`planPack`); what the pack lacks is checked.
 * @param {import('./pack.mjs').Pack} pack
 * @param {any} main the content type's `library.json`
 * @param {Record<string, unknown>} content
 */
async function closure(pack, main, content) {
  const roots = [main, ...librariesNamedIn(content)].map(({ machineName, majorVersion, minorVersion }) => ({ machineName, majorVersion: Number(majorVersion), minorVersion: Number(minorVersion) }))
  /** @param {unknown} params */
  const plan = (params) => (planPack({ own: [], provided: [], roots, params, pack: pack.libraries, refresh: false, fill: true })?.parts ?? [])
    .map((part) => /** @type {import('./pack.mjs').IndexEntry} */ (pack.libraries.find((entry) => entry.folder === part.folder)))
  const planned = plan(content)
  /** @param {{ machineName: string, majorVersion: string | number, minorVersion: string | number }} dependency */
  const supplied = (dependency) => planned.some((entry) => entry.machineName === dependency.machineName && entry.majorVersion === Number(dependency.majorVersion) && entry.minorVersion >= Number(dependency.minorVersion))
  for (const dependency of [...roots, ...planned.flatMap((entry) => entry.preloadedDependencies ?? [])]) {
    if (!supplied(dependency)) throw new Error(`The library pack cannot supply ${dependency.machineName} ${dependency.majorVersion}.${dependency.minorVersion}`)
  }
  // Depth first, dependencies after each library, the addons last: the runtime keeps this order
  // between libraries that do not depend on each other, and it sets whose stylesheet comes later.
  const byLibrary = new Map(planned.map((entry) => [`${entry.machineName} ${entry.majorVersion}`, entry]))
  /** @type {Map<string, import('./pack.mjs').IndexEntry>} */
  const ordered = new Map()
  /** @param {{ machineName: string, majorVersion: string | number }} dependency */
  const visit = (dependency) => {
    const entry = byLibrary.get(`${dependency.machineName} ${Number(dependency.majorVersion)}`)
    if (!entry || ordered.has(entry.folder)) return
    ordered.set(entry.folder, entry)
    for (const each of entry.preloadedDependencies ?? []) visit(each)
  }
  for (const each of [...roots, ...planned]) visit(each)
  /** @type {Map<string, import('./pack.mjs').PartLibrary>} */
  const selected = new Map()
  for (const entry of ordered.values()) selected.set(entry.folder, await pack.open(entry))
  // Planned without the parameters, nothing matches an addon's pattern: what they add are the
  // addons, and of what they add, the addons alone, not what an addon would need in turn.
  const plain = new Set(plan(undefined).map((entry) => entry.folder))
  const addons = planned.filter((entry) => entry.addTo !== undefined && !plain.has(entry.folder)).map((entry) => `${entry.machineName} ${entry.majorVersion}.${entry.minorVersion}`)
  return { selected, addons }
}

/**
 * A source naming what it was built with, the content type and the pack's version, beside `type`:
 * kept with the package (#219), so a build with a later pack can say the type has moved.
 * @param {Source} source
 * @param {string} builtWith as `libraryString` writes it, "H5P.Blanks 1.14"
 * @returns {Source}
 */
function stamped(source, builtWith) {
  const { type, builtWith: _before, ...rest } = source
  return { type, builtWith, ...rest }
}

/**
 * A source made what a package holds, its media resolved through `media`: the manifest, the content,
 * the libraries' parts and what is worth telling. Nothing is written: the caller writes it.
 * @template F
 * @param {Source} source as `readSource` returned it, or `sourceOf` with its content type known
 * @param {import('./pack.mjs').Pack} pack
 * @param {import('./media.mjs').MediaStore<F>} media
 * @param {Problem[]} [said] the problems `sourceOf` found in the source's own fields, which come
 *   first among the content's: all of them in one round (#174)
 * @returns {Promise<{ source: Source, builtWith: string, manifest: Record<string, unknown>, content: Record<string, unknown>, selected: Map<string, import('./pack.mjs').PartLibrary>, install: Map<string, import('./pack.mjs').PartLibrary>, coreApi: import('./install.mjs').CoreApi, translations: TranslationReport[], notes: Problem[], lengths: import('./media.mjs').MediaLength[], outline: string }>}
 *   `selected`, the libraries it plays with; `install`, those an H5P site's upload check wants
 * @internal
 */
export async function composePackage(source, pack, media, said = []) {
  /** @type {Problem[]} */
  const problems = []
  /** @type {Problem[]} */
  const notes = []
  const report = (/** @type {string} */ path, /** @type {string} */ message) => problems.push({ path, message })
  const note = (/** @type {string} */ path, /** @type {string} */ message) => notes.push({ path, message })
  const { entries, main: mainLibrary, translations } = await loadLibraries(pack, source).catch((error) => {
    throw error instanceof SourceError ? new SourceError([...said, ...error.problems]) : error
  })
  const main = mainLibrary.library.machineName
  // A part's licence is "U", as the editor saves one: H5P lists every part with a licence under its
  // rights of use, so the activity's own repeated once a part (#302). A picture's is its file's, below.
  const generator = new ContentGenerator(entries, {
    metadata(entry, written, path) {
      const title = written?.title
      if (title !== undefined && (typeof title !== 'string' || !title.trim())) report(`${path}.metadata.title`, 'expected a title')
      else if (typeof title === 'string' && title.length > 255) report(`${path}.metadata.title`, 'takes at most 255 characters')
      return {
        contentType: escapeText(String(entry.library.title ?? entry.library.machineName)),
        license: 'U',
        ...(typeof title === 'string' && title.trim() ? { title: escapeText(title) } : {})
      }
    }
  })
  if (!mainLibrary.semantics) report('type', `${source.type} has no semantics: it is not a content type an author fills in`)
  else if (!mainLibrary.library.runnable) report('type', `${mainLibrary.library.machineName} is a part other content holds, not a content type on its own: put it in one, such as H5P.Column`)

  // Layouts that turn what a source writes into what H5P stores, before it is generated.
  const layout = layoutContext(entries, report, note)
  const written = structuredClone(source.params)
  for (const place of placesOf(main, written)) LAYOUTS[place.library]?.before?.(place.params, place.path, layout(place.library))

  const generated = generator.generate(mainLibrary, written)
  problems.push(...generator.problems)
  notes.push(...generator.notes)

  // Media: copied, described, put in place of what was written.
  for (const { field, value, path } of generator.media) {
    const resolved = await media.resolve(field, value, path, report, note)
    // What the field keeps beside the file, as a video's quality label, stays as checked.
    const kept = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'path' && key !== 'copyright'))
    for (const key of Object.keys(value)) delete value[key]
    Object.assign(value, resolved, kept)
  }

  // H5P.Image, H5P.Video and H5P.Audio hide their file's own copyright (`disableCopyright`): the
  // editor keeps it in the part's metadata, which H5P shows, so the file's copyright goes there.
  for (const part of partsOf(generated)) {
    const [name, version] = part.library.split(' ')
    const fields = generator.find(name, Number(version.split('.')[0]))?.semantics ?? []
    const field = fields.find((/** @type {any} */ each) => each.disableCopyright && each.name in part.params)
    const file = field && (Array.isArray(part.params[field.name]) ? part.params[field.name][0] : part.params[field.name])
    if (isObject(file?.copyright)) Object.assign(part.metadata, metadataOf(file.copyright, part.metadata.title))
  }

  // Checked last as saved content is. Only what it finds beyond the source's problems is added
  // (#172), not what it says of a list with a refused item: its count and indices are off.
  const checked = checkContent({ entries, main: mainLibrary, translations }, { type: libraryString(mainLibrary.library), params: generated })
  const fromSource = [...problems]
  const moves = new Set(generator.moved.map(({ from }) => from))
  const inSource = (/** @type {string} */ path) => generator.moved.reduce((at, { from, to }) => at === to || inside(at, to) ? from + at.slice(to.length) : at, path)
  const shortened = (/** @type {string} */ path) => generator.shortened.some((list) => path === list || inside(path, list))
  for (const { path: inContent, message } of checked.problems) {
    const path = inSource(inContent)
    const known = fromSource.some((problem) => problem.path === path || (inside(path, problem.path) && !moves.has(problem.path)) ||
      (inside(problem.path, path) && valueAt(checked.params, inContent) === undefined))
    if (!known && !shortened(path)) problems.push({ path, message })
  }
  for (const added of checked.notes) if (!notes.some(({ path, message }) => path === added.path && message === added.message)) notes.push(added)
  // Times past the end of a video whose length was read, which only a build, with the file, knows;
  // none in a list an item of which was refused, whose indices are no longer the source's.
  const timed = (/** @type {string} */ path, /** @type {string} */ message) => { if (!shortened(path)) report(path, message) }
  // The length each Interactive Video's times were held to, which a build's output says (#260).
  /** @type {import('./media.mjs').MediaLength[]} */
  const lengths = []
  for (const place of placesOf(main, checked.params)) {
    if (place.library === 'H5P.InteractiveVideo') {
      const length = videoTimes(place.params, inSource(place.path), (file) => media.lengthOf(file), timed)
      if (length && !lengths.some(({ file }) => file === length.file)) lengths.push(length)
    }
    // What is placed or timed by numbers alone, which only a person looking at it can check.
    const numbered = byNumber(place.library, place.params)
    if (numbered) note(`${inSource(place.path)}.${numbered.at}`, numbered.message)
  }
  // What the source was last built with, where this pack has another version of the type: said
  // with the problems, which a field that changed since may have made, and a note where it builds.
  const builtWith = libraryString(mainLibrary.library)
  const before = source.builtWith !== undefined && source.builtWith !== builtWith && source.builtWith.split(' ')[0] === main ? source.builtWith : ''
  if (before && (said.length || problems.length)) {
    report('builtWith', `this source was last built with ${before} and this pack has ${builtWith}: a field named here may have changed since, and the type's fields as they are now say what to write`)
  }
  if (said.length || problems.length) throw new SourceError([...said, ...problems])
  if (before) note('builtWith', `was ${before} and this pack has ${builtWith}: its fields may have changed since, so play it through before handing it over`)
  const content = checked.params

  const { selected, addons } = await closure(pack, mainLibrary.library, content)
  if (addons.length) notes.push({ path: 'params', message: `its text matches ${addons.join(', ')}, which the package carries, as a site with it installed would add it` })
  // What an H5P site's upload check wants with them, at the exact versions (#146); not in
  // `h5p.json`, which lists what plays, as the platforms' own exports write it.
  const install = await installClosure(pack, selected)

  // As H5P's exports write it, unescaped: the platforms check it when they load content.
  const manifest = {
    title: source.title,
    language: source.language,
    defaultLanguage: source.language,
    license: source.license,
    ...(source.licenseVersion ? { licenseVersion: source.licenseVersion } : {}),
    authors: source.authors.map(({ name, role }) => ({ name, role })),
    ...(source.source ? { source: source.source } : {}),
    ...(source.yearFrom !== undefined ? { yearFrom: source.yearFrom } : {}),
    ...(source.yearTo !== undefined ? { yearTo: source.yearTo } : {}),
    mainLibrary: mainLibrary.library.machineName,
    embedTypes: ['div'],
    preloadedDependencies: [...selected.values()].map((part) => ({
      machineName: part.library.machineName, majorVersion: String(part.library.majorVersion), minorVersion: String(part.library.minorVersion)
    }))
  }
  /** @type {string | undefined} */
  let outline
  return {
    source: stamped(source, builtWith), builtWith,
    manifest, content, selected, install, translations, notes, lengths,
    coreApi: coreApiOf([...selected.values(), ...install.values()].map((part) => part.library)),
    // Made when it is first read: it is for a review, which only some callers make, and a build
    // that never reads it never runs it.
    get outline() { return (outline ??= outlineOf({ entries, main: mainLibrary }, { params: content })) }
  }
}

/**
 * What a package holds but its media, in the order it streams: manifest, playing libraries,
 * content, media, then the libraries for an upload check, which nothing reads as it plays.
 * @param {import('@zip.js/zip.js').ZipWriter<unknown>} writer
 * @param {{ manifest: Record<string, unknown>, content: Record<string, unknown>, selected: Map<string, import('./pack.mjs').PartLibrary>, install: Map<string, import('./pack.mjs').PartLibrary> }} built
 * @param {import('./pack.mjs').Pack} pack
 * @param {() => Promise<void>} media adds the media to `writer`
 * @internal
 */
export async function writePackage(writer, { manifest, content, selected, install }, pack, media) {
  /** @param {import('./pack.mjs').PartLibrary} part */
  const copy = (part) => writer.appendZip(pack.archiveOf(part), { filter: (entry) => !entry.directory && entry.filename.startsWith(`${part.folder}/`) })
  await writer.add('h5p.json', new TextReader(JSON.stringify(manifest)))
  for (const part of selected.values()) await copy(part)
  await writer.add('content/content.json', new TextReader(JSON.stringify(content)))
  await media()
  for (const part of install.values()) await copy(part)
}

/**
 * Whether a path lies inside another: `params.a[0].b` inside `params.a`.
 * @param {string} inner
 * @param {string} outer
 */
function inside(inner, outer) {
  return inner.startsWith(`${outer}.`) || inner.startsWith(`${outer}[`)
}
