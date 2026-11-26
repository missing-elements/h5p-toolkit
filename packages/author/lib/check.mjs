import { ContentGenerator, libraryString } from './generator.mjs'
import { noteMistakes } from './mistakes.mjs'
import { LAYOUTS, placesOf } from './types.mjs'

/**
 * Content checked in the form H5P stores it, by the one set of rules the build and a tool that
 * edits a package both run on what they write. No Node import: the libraries are handed in.
 */

/**
 * @typedef {import('./generator.mjs').PackEntry} PackEntry
 * @typedef {import('./libraries.mjs').LoadedLibraries} LoadedLibraries
 * @typedef {{ path: string, message: string }} Problem
 * @typedef {{ params: Record<string, any>, problems: Problem[], notes: Problem[] }} CheckedContent
 *   `params`, as checked; `problems`, what would not be taken; `notes`, what is only worth saying
 */

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * What a content type's layout is handed: where to report and note, the semantics and record of
 * its library, and a library's title by its name.
 * @param {Map<string, PackEntry>} entries
 * @param {(path: string, message: string) => void} report
 * @param {(path: string, message: string) => void} note
 * @returns {(machineName: string) => import('./types.mjs').LayoutContext}
 * @internal
 */
export function layoutContext(entries, report, note) {
  const loaded = (/** @type {string} */ machineName) => [...entries.values()].find((each) => each.library.machineName === machineName && each.semantics)
  return (machineName) => {
    const entry = loaded(machineName)
    return {
      report,
      note,
      semantics: entry?.semantics ?? [],
      library: entry?.library,
      title: (library) => {
        const name = String(library).split(' ')[0]
        return String(loaded(name)?.library.title ?? name)
      }
    }
  }
}

/**
 * Saved content checked, with what the editor's widgets would set on it. A field a newer library
 * minor lacks is noted, not refused: the player upgrades older content as it plays, this cannot.
 * @param {LoadedLibraries} libraries as `loadLibraries` loaded them for this content
 * @param {{ type: string, params: unknown }} content `type`, as `h5p.json` names it with its saved
 *   version, `H5P.QuestionSet 1.20`; `params`, `content.json`, left as it is
 * @returns {CheckedContent}
 */
export function checkContent(libraries, { type, params }) {
  /** @type {Problem[]} */
  const problems = []
  /** @type {Problem[]} */
  const notes = []
  const report = (/** @type {string} */ path, /** @type {string} */ message) => problems.push({ path, message })
  const note = (/** @type {string} */ path, /** @type {string} */ message) => notes.push({ path, message })
  const { entries, main } = libraries
  const named = /^\s*(\S+?)(?:\s+(\d+)\.(\d+))?\s*$/.exec(String(type))
  if (!named || named[1] !== main.library.machineName || (named[2] !== undefined && Number(named[2]) !== main.library.majorVersion)) {
    report('type', `is ${type}, and the libraries were loaded for ${libraryString(main.library)}`)
    return { params: isObject(params) ? structuredClone(params) : {}, problems, notes }
  }
  if (!main.semantics) report('type', `${libraryString(main.library)} has no semantics: it is not a content type an author fills in`)
  const generator = new ContentGenerator(entries, { saved: true })
  const content = generator.generate(main, structuredClone(params), 'params', named[3] === undefined ? undefined : Number(named[3]))
  problems.push(...generator.problems)
  notes.push(...generator.notes)

  // Layouts that set what the editor's widgets set, and check what they would not let pass.
  const layout = layoutContext(entries, report, note)
  const places = placesOf(main.library.machineName, content)
  for (const place of places) LAYOUTS[place.library]?.after?.(place.params, place.path, layout(place.library))
  // What builds and is almost surely a mistake, which H5P allows: a note, never a problem (#241).
  for (const place of places) noteMistakes(place.library, place.params, place.path, note)
  for (const place of places) {
    if (place.holder && isObject(place.holder.metadata) && place.holder.metadata.title === undefined) place.holder.metadata.title = place.holder.metadata.contentType
  }
  for (const { field, path } of generator.unset) {
    if (valueAt(content, path) === undefined && !problems.some((problem) => problem.path === path)) report(path, `is required (${field.type}), and nothing set it`)
  }
  return { params: content, problems, notes }
}

/**
 * The value at a generator path, `params.a[0].b`, in the content.
 * @param {any} content
 * @param {string} path
 * @internal
 */
export function valueAt(content, path) {
  let value = { params: content }
  for (const part of path.replace(/\[(\d+)\]/g, '.$1').split('.')) {
    if (value === undefined || value === null) return undefined
    value = /** @type {any} */ (value)[part]
  }
  return value
}
