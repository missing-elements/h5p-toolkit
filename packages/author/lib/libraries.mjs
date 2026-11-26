import { ownLibraries } from '@missing-elements/h5p-offline-player/plan'
import { libraryOptions, libraryString } from './generator.mjs'
import { machineNameOf, NAMING_KEYS } from './names.mjs'
import { SourceError } from './source-error.mjs'
import { localize, translationFiles } from './translate.mjs'
import { patchSemantics } from './types.mjs'

/**
 * The libraries content brings in, loaded as a build loads them, for it and for tools that read or
 * change content the same way. No Node import: the pack is handed in, and files read by the caller.
 */

/**
 * A library as a pack's index lists it.
 * @typedef {{ folder: string, machineName: string, majorVersion: number, minorVersion: number }} LibraryRecord
 */

/**
 * A package's files, as a tool that has it open reads them: the names of its entries, and an
 * entry's text.
 * @typedef {{ names: Iterable<string>, read(name: string): Promise<string> }} PackageFiles
 */

/**
 * What libraries load from: the pack `openPack` opens, or another with these members. `newest` is the
 * library for a name and major; `open` reads `library.json` and `semantics.json` as its source checks them, and its `translations` names, for `translation`.
 * @typedef {{
 *   libraries: LibraryRecord[],
 *   newest(machineName: string, major?: number): LibraryRecord | null,
 *   open(entry: LibraryRecord): Promise<{ folder: string, library: any, semantics: any[] | null, translations: string[] }>,
 *   translation(part: { folder: string }, name: string): Promise<unknown>
 * }} LibrarySource
 */

/**
 * @typedef {import('./generator.mjs').PackEntry} PackEntry
 * @typedef {import('./translate.mjs').TranslationReport} TranslationReport
 * @typedef {{ entries: Map<string, PackEntry>, main: PackEntry, translations: TranslationReport[] }} LoadedLibraries
 *   `entries` by folder, as `ContentGenerator` takes; `main`, the type's; `translations`
 */

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * The libraries content brings in, each the pack's newest of its major: the type, those its
 * parameters or a field's default name, and a field's only option (#172); the rest lack semantics.
 * @param {LibrarySource} pack
 * @param {{ type: string, language: string, params?: unknown }} content `type` a machine name, with
 *   a major and minor when known, `H5P.Blanks` or `H5P.Blanks 1.14`
 * @returns {Promise<LoadedLibraries>}
 * @throws {SourceError} when the pack has no such content type
 */
export async function loadLibraries(pack, { type, language, params }) {
  /** @type {Map<string, PackEntry>} */
  const entries = new Map()
  /** @type {TranslationReport[]} */
  const translations = []
  const main = /^(\S+?)(?:\s+(\d+)\.\d+)?$/.exec(String(type).trim())
  const mainEntry = main ? pack.newest(main[1], main[2] === undefined ? undefined : Number(main[2])) : null
  if (!mainEntry) throw new SourceError([{ path: 'type', message: `the library pack has no content type ${type}` }])
  /** @type {{ machineName: string, major?: number, unnamed?: boolean }[]} */
  const queue = [{ machineName: mainEntry.machineName, major: mainEntry.majorVersion }]
  /** @type {Set<string>} the folders of the libraries the content names, or a default does */
  const namedFolders = new Set()
  /** @type {Map<string, TranslationReport>} by folder, in the order loaded */
  const reports = new Map()
  const names = [...new Set(pack.libraries.map((entry) => entry.machineName))]
  /** Every major of a library the generator may take what is written to mean, as one a field takes unnamed. */
  const meant = (/** @type {string} */ machineName) => {
    for (const entry of pack.libraries) if (entry.machineName === machineName) queue.push({ machineName, major: entry.majorVersion, unnamed: true })
  }
  /** @param {unknown} value */
  const named = (value) => {
    if (Array.isArray(value)) value.forEach(named)
    else if (isObject(value)) {
      const match = typeof value.library === 'string' ? /^\s*(\S+?)(?:\s+(\d+)\.\d+)?\s*$/.exec(value.library) : null
      // A name without a version is resolved by the field's options, which may name any major the
      // pack has: each is loaded.
      if (match && match[2] !== undefined) queue.push({ machineName: match[1], major: Number(match[2]) })
      else if (match) for (const entry of pack.libraries) if (entry.machineName === match[1]) queue.push({ machineName: match[1], major: entry.majorVersion })
      // What the generator takes to name a library though not written as one (#174): `library`
      // loosely written, or a name under `type` or `contentType`; other keys' text loads nothing.
      if (typeof value.library === 'string') {
        const found = machineNameOf(value.library, names)
        if (found && !found.exact) meant(found.machineName)
      } else {
        for (const key of NAMING_KEYS) {
          const found = machineNameOf(value[key], names)
          if (found) meant(found.machineName)
        }
      }
      Object.values(value).forEach(named)
    }
  }
  named(params)
  /** @param {any[]} fields */
  const defaults = (fields) => {
    for (const field of fields) {
      if (field.type === 'library' && isObject(field.default)) named(field.default)
      if (field.type === 'library') {
        // Read as the generator reads them, a name or `{ name }`, so that the two agree on which
        // library is a field's only one.
        const options = libraryOptions(field)
        if (options.length && options.every(({ machineName }) => machineName === options[0].machineName)) {
          for (const { machineName, major } of options) queue.push({ machineName, major, unnamed: true })
        }
      }
      if (field.fields) defaults(field.fields)
      if (field.field) defaults([field.field])
    }
  }
  while (queue.length) {
    const { machineName, major, unnamed } = /** @type {{ machineName: string, major?: number, unnamed?: boolean }} */ (queue.shift())
    const entry = pack.newest(machineName, major)
    if (entry && !unnamed) namedFolders.add(entry.folder)
    if (!entry || entries.has(entry.folder)) continue
    const part = await pack.open(entry)
    let semantics = part.semantics
    if (semantics) {
      const files = translationFiles(part.translations, language).map((name) => ({ name, read: () => pack.translation(part, name) }))
      const localized = await localize(semantics, files, libraryString(part.library))
      semantics = patchSemantics(part.library.machineName, localized.semantics)
      // By folder, not identity: a source may build its records anew on each call.
      if (part.library.runnable || entry.folder === mainEntry.folder) reports.set(entry.folder, localized.report)
      defaults(semantics)
    }
    entries.set(entry.folder, { folder: entry.folder, library: part.library, semantics })
  }
  for (const [folder, report] of reports) if (namedFolders.has(folder)) translations.push(report)
  // Every library the index knows stays findable, so a name the pre-pass did not see is reported
  // as a library of the pack and not as an unknown one; its semantics are read when it is found.
  for (const entry of pack.libraries) {
    if (!entries.has(entry.folder)) entries.set(entry.folder, { folder: entry.folder, library: { machineName: entry.machineName, majorVersion: entry.majorVersion, minorVersion: entry.minorVersion, title: entry.machineName }, semantics: null })
  }
  return { entries, main: /** @type {PackEntry} */ (entries.get(mainEntry.folder)), translations }
}

/**
 * The libraries a saved package's content is checked against: its own where it carries a major,
 * else the pack's: content has the shape of the version it was saved with, and the pack may have moved past it.
 * @param {PackageFiles} files the package's
 * @param {LibrarySource} [fallback] for what the package does not carry: the pack `openPack` opens
 * @returns {Promise<LibrarySource>}
 */
export async function packageLibraries({ names, read }, fallback) {
  const entries = new Set(names)
  const json = async (/** @type {string} */ name) => JSON.parse(await read(name))
  const folders = [...entries].flatMap((name) => /^([^/]+)\/library\.json$/.exec(name)?.slice(1) ?? [])
  /** @type {(LibraryRecord & { patchVersion: number })[]} */
  const own = []
  for (const { folder, machineName, major, minor, patch } of await ownLibraries(folders, (folder) => json(`${folder}/library.json`))) {
    if (major !== null && minor !== null) own.push({ folder, machineName, majorVersion: major, minorVersion: minor, patchVersion: patch ?? 0 })
  }
  const carried = new Set(own.map(({ machineName, majorVersion }) => `${machineName} ${majorVersion}`))
  const mine = new Set(own.map(({ folder }) => folder))
  const libraries = [...own, ...(fallback?.libraries ?? []).filter(({ machineName, majorVersion }) => !carried.has(`${machineName} ${majorVersion}`))]
  /** @type {Map<string, string[]>} each own folder's translation files, by name without `.json` */
  const languages = new Map()
  for (const name of entries) {
    const match = /^([^/]+)\/language\/([^/]+)\.json$/.exec(name)
    if (match && mine.has(match[1])) languages.set(match[1], [...(languages.get(match[1]) ?? []), match[2]])
  }
  /** @param {any} record */
  const patchOf = (record) => Number(record.patchVersion ?? 0)
  return {
    libraries,
    newest(machineName, major) {
      /** @type {LibraryRecord | null} */
      let best = null
      for (const entry of libraries) {
        if (entry.machineName !== machineName || (major !== undefined && entry.majorVersion !== major)) continue
        if (!best || entry.majorVersion > best.majorVersion || (entry.majorVersion === best.majorVersion && (entry.minorVersion > best.minorVersion || (entry.minorVersion === best.minorVersion && patchOf(entry) > patchOf(best))))) best = entry
      }
      return best
    },
    async open(entry) {
      if (!mine.has(entry.folder)) {
        if (!fallback) throw new Error(`${entry.folder} is not one of the package's libraries`)
        return fallback.open(entry)
      }
      const semantics = entries.has(`${entry.folder}/semantics.json`) ? await json(`${entry.folder}/semantics.json`) : null
      return { folder: entry.folder, library: await json(`${entry.folder}/library.json`), semantics, translations: languages.get(entry.folder) ?? [] }
    },
    async translation(part, name) {
      if (!mine.has(part.folder)) return fallback?.translation(part, name)
      if (!languages.get(part.folder)?.includes(name)) return undefined
      return (await json(`${part.folder}/language/${name}.json`))?.semantics
    }
  }
}
