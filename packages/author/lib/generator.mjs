import { writtenCopyright } from './media.mjs'
import { checkMetadata } from './metadata.mjs'
import { machineNameOf, namingKey } from './names.mjs'
import { isInterfaceText } from './schema.mjs'
import { allowedTags, blockTag, escapeText, markupText, plainText, stripTags, takesMarkup, unwrapText } from './text.mjs'

/**
 * Content for a content type from its `semantics.json`, as H5P's editor saves a form: what is
 * written, else defaults. Editor pinned (design/author.md); `lenient` and `saved` are other modes.
 */

/** The nesting depth at which a library field stops choosing content of its own. */
const MAX_DEPTH = 4

/**
 * The shape H5P keeps a sub-content id in (H5PContentValidator's `validateLibrary`); one in any
 * other is removed, and the part's statements then name it as the content itself.
 */
const SUB_CONTENT_ID = /^\{?[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\}?$/

/**
 * What the platforms keep of a saved file beside `path`, `mime` and `copyright`, by its field's
 * type (H5PContentValidator's `_validateFilelike`); a field's `extraAttributes` add to it.
 * @type {Record<string, string[]>}
 */
const FILE_KEYS = { file: [], image: ['width', 'height', 'originalImage'], video: ['width', 'height', 'codecs', 'quality', 'bitrate'], audio: [] }

/** What sub-content is written with, and the id H5P stores with it. */
const SUB_CONTENT = ['library', 'params', 'metadata', 'subContentId']

/**
 * @typedef {{ folder: string, library: any, semantics: any[] | null }} PackEntry
 * @typedef {{ path: string, message: string }} Problem
 * @typedef {{ field: any, value: any, path: string }} MediaReference
 * @typedef {{
 *   lenient?: boolean,
 *   saved?: boolean,
 *   fill?: (field: any, context: { generator: ContentGenerator, stack: string[], path: string }) => unknown,
 *   id?: (count: number) => string,
 *   metadata?: (entry: PackEntry, written: any, path: string) => any
 * }} GeneratorOptions
 */

// Follows h5p-editor-php-library at 3bec2594356cf1be4e6401f7e7e557650720aa9b (2026-10-08) and
// ShowWhen 1.0.9 at 93678737300e084cb9390a691d3e1ad4e793fbaa (design/author.md, *is pinned*).
export class ContentGenerator {
  /**
   * The library whose parameters are being made, while the content names another minor of it than
   * its semantics are of.
   * @type {{ library: any, minor: number } | null}
   */
  #other = null

  /**
   * Where the source has what is stored in another place than it was written in, by the place it
   * is stored in: its problems are named by where it was written.
   * @type {Map<string, string>}
   */
  #written = new Map()

  /**
   * Sub-content put together from an object that had its parameters beside its library's name,
   * by where those are written: its problems are named there.
   * @type {WeakMap<object, string>}
   */
  #flat = new WeakMap()

  /**
   * @param {Map<string, PackEntry>} pack every library folder the content may use, by folder name
   * @param {GeneratorOptions} [options]
   */
  constructor(pack, options = {}) {
    this.pack = pack
    this.options = options
    this.lenient = options.lenient ?? false
    this.saved = options.saved ?? false
    this.ids = 0
    /** @type {Set<string>} the sub-content ids given, so that no two parts have one */
    this.taken = new Set()
    /** @type {Problem[]} what is wrong with the content, written or saved; never lenient */
    this.problems = []
    /** @type {Problem[]} what is worth saying about it and does not stop a build */
    this.notes = []
    /** @type {MediaReference[]} the files the content names: written, for the caller to copy; saved, as they are */
    this.media = []
    /** @type {WeakSet<object>} fields a content type's own widget draws: numbers take decimals, lists start empty */
    this.drawn = new WeakSet()
    /** @type {{ field: any, path: string }[]} hidden fields left for a content type's layout to set */
    this.unset = []
    /** @type {{ fields: any[], given: Record<string, any> }[]} the levels a `showWhen` path climbs, innermost last */
    this.scopes = []
    /** @type {string[]} written lists an item of which was refused: each holds fewer items than were written, at other indices */
    this.shortened = []
    /**
     * @type {{ from: string, to: string }[]} what was written in another place than its field's:
     *   where the source has it, and where the content does, outermost first
     */
    this.moved = []
    /** @type {Record<string, any>[]} the files saved content names, as saved, collected as `written` writes them */
    this.stored = []
    /** @type {string[]} what `written` left out as H5P's editor started it for nobody: a list (`#started`), a default's content (`#unopened`) */
    this.unfilled = []
  }

  /**
   * Whether the editor shows a field, by its `showWhen` rules as H5PEditor.ShowWhen reads them:
   * any one holds, or all if `and`, on the written value or default; `../` climbs a level.
   * @param {any} field
   */
  #visible(field) {
    const rules = field.showWhen?.rules
    if (!Array.isArray(rules) || !rules.length) return true
    const results = rules.map((/** @type {any} */ rule) => {
      let name = String(rule.field ?? '')
      let level = this.scopes.length - 1
      while (name.startsWith('../')) {
        name = name.slice(3)
        level -= 1
      }
      const scope = this.scopes[level]
      if (!scope) return true
      const sibling = scope.fields.find((each) => each.name === name)
      let value = scope.given[name] ?? sibling?.default
      if (value === undefined && sibling?.type === 'boolean') value = false
      if (isObject(value) && typeof value.library === 'string') value = value.library.trim().split(/\s+/)[0]
      return [rule.equals].flat().some((/** @type {unknown} */ wanted) => {
        if (typeof value === 'string' && typeof wanted === 'string' && /^\S+ \d+\.\d+$/.test(wanted)) return wanted.split(' ')[0] === value
        return String(wanted) === String(value)
      })
    })
    return field.showWhen.type === 'and' ? results.every(Boolean) : results.some(Boolean)
  }

  /**
   * A copy of a field with something changed, drawn by a widget if the field is.
   * @param {any} field
   * @param {Record<string, unknown>} changes
   */
  #copy(field, changes) {
    const copy = { ...field, ...changes }
    if (this.drawn.has(field)) this.drawn.add(copy)
    return copy
  }

  /** A field as optional, for one the editor hides. @param {any} field */
  #optional(field) {
    return this.#copy(field, { optional: true })
  }

  /** A field as it is filled here: optional where the editor hides it. @param {any} field */
  #shown(field) {
    return this.lenient || this.#visible(field) ? field : this.#optional(field)
  }

  /**
   * What a callback generates a level down, for `showWhen`: the fields a rule can name, and what
   * was written for them. A list's level names none: a rule in its item reaches out with `../../`.
   * @template T
   * @param {any[]} fields
   * @param {Record<string, unknown>} given
   * @param {() => T} generate
   * @returns {T}
   */
  #level(fields, given, generate) {
    this.scopes.push({ fields, given })
    try {
      return generate()
    } finally {
      this.scopes.pop()
    }
  }

  /**
   * The newest library in the pack with this machine name and, when given, this major — the
   * one the player serves for any minor of it.
   * @param {string} machineName
   * @param {number} [major]
   */
  find(machineName, major) {
    /** @type {PackEntry | null} */
    let best = null
    for (const entry of this.pack.values()) {
      const { library } = entry
      if (library.machineName !== machineName) continue
      if (major !== undefined && library.majorVersion !== major) continue
      if (!best || library.majorVersion > best.library.majorVersion || (library.majorVersion === best.library.majorVersion && library.minorVersion > best.library.minorVersion)) best = entry
    }
    return best
  }

  /**
   * The parameters for a library's content, with `written` — the authored parameters, if any —
   * laid in.
   * @param {PackEntry} entry
   * @param {any} [written]
   * @param {string} [path] where the parameters sit, for problems: `params` by default
   * @param {number} [minor] the minor of the library the content names, where it may be another
   *   than the entry's, as saved content's may
   */
  generate(entry, written, path = 'params', minor) {
    return this.#of(entry, minor, () => this.fields(entry.semantics ?? [], written, [entry.library.machineName], false, path))
  }

  /**
   * What a callback makes of a library's parameters, knowing whether the content names another
   * minor of the library than its semantics are of.
   * @template T
   * @param {PackEntry} entry
   * @param {number | undefined} minor
   * @param {() => T} generate
   * @returns {T}
   */
  #of(entry, minor, generate) {
    const outer = this.#other
    this.#other = minor === undefined || minor === entry.library.minorVersion ? null : { library: entry.library, minor }
    try {
      return generate()
    } finally {
      this.#other = outer
    }
  }

  /**
   * Saved parameters as a source writes them, the generation walked back (#236): what a build would
   * write by default is left out, a part's id and metadata too. Files are kept in `stored`.
   * @param {PackEntry} entry the content type's, as loaded for the content
   * @param {unknown} saved its parameters, as `checkContent` returned them
   * @returns {Record<string, any>}
   */
  written(entry, saved) {
    return this.#writtenFields(entry.semantics ?? [], saved, [entry.library.machineName], 'params')
  }

  /**
   * A level's saved values, as a source writes them: each that is not what its field holds when
   * nothing is written for it, as `written` says.
   * @param {any[]} fields
   * @param {unknown} saved
   * @param {string[]} stack
   * @param {string} path
   * @returns {Record<string, any>}
   */
  #writtenFields(fields, saved, stack, path) {
    /** @type {Record<string, any>} */
    const out = {}
    if (!isObject(saved)) return out
    this.#level(fields, saved, () => {
      for (const field of fields) {
        const value = saved[field.name]
        if (value === undefined) continue
        const shown = this.#shown(field)
        const at = `${path}.${field.name}`
        // In a written level, as a build generates it: nothing in it is taken as left closed.
        const unwritten = this.#quietly(() => this.field(shown, undefined, stack, false, at))
        // An empty text or choice where nothing is written is what H5P's editor saves for a field
        // nobody filled, as `checkContent` takes it.
        if (sameContent(value, unwritten) || (value === '' && unwritten === undefined)) continue
        if (this.#started(shown, value, stack, at) || this.#unopened(shown, value, stack, at)) {
          this.unfilled.push(at)
          continue
        }
        out[field.name] = this.#writtenValue(shown, value, stack, at)
      }
    })
    return out
  }

  /**
   * Whether a saved list is one the editor started and nobody filled: optional, every item empty,
   * as an Interactive Video's text track. A check passes it; a source leaves it out.
   * @param {any} field
   * @param {unknown} value
   * @param {string[]} stack
   * @param {string} path
   */
  #started(field, value, stack, path) {
    if (field.type !== 'list' || !field.optional || !Array.isArray(value) || !value.length) return false
    const item = this.#copy(field.field, { optional: false })
    return this.#level([], {}, () => value.every((each, index) => sameContent(each, this.#quietly(() => this.field(item, undefined, stack, false, `${path}[${index}]`)))))
  }

  /**
   * Whether saved sub-content is the field's default as the editor started it, never opened:
   * Interactive Video's summary task. A check passes it; a source leaves it out.
   * @param {any} field
   * @param {unknown} value
   * @param {string[]} stack
   * @param {string} path
   */
  #unopened(field, value, stack, path) {
    if (field.type !== 'library' || !isObject(field.default) || typeof field.default.library !== 'string' || !isObject(value) || typeof value.library !== 'string') return false
    if (value.library.trim().split(/\s+/)[0] !== field.default.library.trim().split(/\s+/)[0]) return false
    const counts = [this.stored.length, this.unfilled.length, this.notes.length]
    try {
      const written = this.#writtenPart(field, value, stack, path)
      return isObject(written) && vacant(written.params)
    } finally {
      this.stored.length = counts[0]
      this.unfilled.length = counts[1]
      this.notes.length = counts[2]
    }
  }

  /**
   * A saved value as a source writes it for its field: a group, a list and sub-content as what
   * differs within them, a file as its path and copyright, anything else as it is.
   * @param {any} field
   * @param {unknown} value
   * @param {string[]} stack
   * @param {string} path
   * @returns {unknown}
   */
  #writtenValue(field, value, stack, path) {
    switch (field.type) {
      case 'group': {
        const children = field.fields ?? []
        // A group of one field is saved as that field's value, and still a level for `showWhen`.
        if (children.length === 1 && !field.isSubContent) {
          const [only] = children
          return this.#level(children, { [only.name]: value }, () => this.#writtenValue(this.#shown(only), value, stack, path))
        }
        if (!isObject(value)) return structuredClone(value)
        if (field.widget && field.widget !== 'showWhen' && field.widget !== 'none') this.#draw(children)
        return this.#writtenFields(children, value, stack, path)
      }
      case 'list': {
        if (!Array.isArray(value)) return structuredClone(value)
        const item = this.#copy(field.field, { optional: false })
        // Every item is written, an item with its defaults alone as what makes it: `{}` for a group.
        return this.#level([], {}, () => value.map((each, index) => this.#writtenValue(item, each, stack, `${path}[${index}]`)))
      }
      case 'library':
        return this.#writtenPart(field, value, stack, path)
      case 'image':
      case 'file':
      case 'video':
      case 'audio':
        return Array.isArray(value) ? value.map((each, index) => this.#writtenFile(each, `${path}[${index}]`)) : this.#writtenFile(value, path)
      case 'text':
        // Markup that is only the blocks a build wraps typing in is written as the typing.
        return typeof value === 'string' && takesMarkup(field) ? unwrapText(value, blockTag(field)) ?? value : value
      default:
        return structuredClone(value)
    }
  }

  /**
   * Saved sub-content as a source writes it: its library by name, with a version only where the
   * field takes several majors; what differs from the defaults; its title, unless it is its type's.
   * @param {any} field
   * @param {unknown} value
   * @param {string[]} stack
   * @param {string} path
   */
  #writtenPart(field, value, stack, path) {
    if (!isObject(value) || typeof value.library !== 'string') return structuredClone(value)
    const match = /^\s*(\S+)\s+(\d+)\.(\d+)\s*$/.exec(value.library)
    const entry = match ? this.find(match[1], Number(match[2])) : null
    if (!match || !entry) return { library: value.library, params: structuredClone(value.params ?? {}) }
    const majors = new Set(libraryOptions(field).filter((option) => option.machineName === match[1]).map((option) => option.major))
    const library = majors.size > 1 ? `${match[1]} ${match[2]}.${match[3]}` : match[1]
    const params = this.#writtenFields(entry.semantics ?? [], value.params, [...stack, match[1]], `${path}.params`)
    const title = isObject(value.metadata) ? value.metadata.title : undefined
    const own = typeof title === 'string' && title.trim() !== '' && title !== escapeText(String(entry.library.title ?? match[1]))
    return { library, params, ...(own ? { metadata: { title } } : {}) }
  }

  /**
   * A saved file as a source writes it: its path, and its copyright where it gives one
   * (`writtenCopyright`), less a part a build refuses, which is noted. Kept as saved in `stored`.
   * @param {unknown} value
   * @param {string} path
   */
  #writtenFile(value, path) {
    if (!isObject(value) || typeof value.path !== 'string') return structuredClone(value)
    this.stored.push(value)
    const copyright = writtenCopyright(value.copyright, (key, kept) => this.note(`${path}.copyright.${key}`, key === 'license'
      ? `${JSON.stringify(kept)} is no licence H5P lists for a file: left out, with any version, so a build gives the file "U"`
      : `${JSON.stringify(kept)} is no web address: left out`))
    return { path: value.path, ...(copyright ? { copyright } : {}) }
  }

  /** A sub-content id: random, or the caller's, numbered, where it wants the same bytes every run. */
  nextId() {
    this.ids += 1
    return this.options.id ? this.options.id(this.ids) : newId()
  }

  /**
   * The id of a part: the saved one unless H5P would not keep it or another part took it, else
   * a new one as the editor does (h5peditor-library.js, h5peditor-group.js).
   * @param {unknown} saved
   * @param {string} path the part's
   */
  #id(saved, path) {
    let id = this.saved && typeof saved === 'string' && SUB_CONTENT_ID.test(saved) && !this.taken.has(saved) ? saved : undefined
    if (this.saved && saved !== undefined && id === undefined) {
      this.note(`${path}.subContentId`, typeof saved === 'string' && this.taken.has(saved)
        ? 'is another part\'s id too, so this part has a new one'
        : 'is not an id H5P keeps, so the part has a new one')
    }
    id ??= this.nextId()
    this.taken.add(id)
    return id
  }

  /** @param {string} path @param {string} message */
  report(path, message) {
    this.problems.push({ path, message })
  }

  /** @param {string} path @param {string} message */
  note(path, message) {
    this.notes.push({ path, message })
  }

  /**
   * @param {any[]} fields
   * @param {any} written the written object for these fields, or undefined
   * @param {string[]} stack the content types this value sits inside, to keep a type out of itself
   * @param {boolean} lenient inside an optional group nobody wrote: defaults only, as the editor
   *   saves a group left closed — and so nothing asked for a field required only within it
   * @param {string} path
   * @param {string[]} [kept] saved, keys these fields do not name that are kept as they are: what
   *   the group's own default carries, and a part's id
   */
  fields(fields, written, stack, lenient, path, kept = []) {
    /** @type {Record<string, unknown>} */
    const out = {}
    if (!this.lenient && written !== undefined && !isObject(written)) {
      this.report(path, `expected an object with the fields ${fieldNames(fields)}`)
      return out
    }
    const given = !isObject(written) ? {} : this.lenient || this.saved ? written : this.#placed(fields, written, path)
    this.#level(fields, given, () => {
      for (const field of fields) {
        const value = this.field(this.#shown(field), given[field.name], stack, lenient, `${path}.${field.name}`)
        if (value !== undefined) out[field.name] = value
      }
    })
    for (const [key, value] of Object.entries(given)) {
      if (Object.hasOwn(out, key) || fields.some((field) => field.name === key)) continue
      // Lenient, what the semantics do not name is kept as written: the content check removes
      // it, which a sweep file may mean to test.
      if (this.lenient) {
        if (value !== null) out[key] = value
      } else if (this.saved && kept.includes(key)) out[key] = value
      else if (this.saved && this.#other) {
        out[key] = value
        this.note(`${path}.${key}`, otherMinor(this.#other))
      } else this.report(`${path}.${key}`, `is not a field here; the fields are ${fieldNames(fields)}`)
    }
    return out
  }

  /**
   * What was written for a level, with what was written in the wrong place put where it belongs, to
   * be checked in one round (#172): sub-content in its group's place, and a field a level too high.
   * @param {any[]} fields
   * @param {Record<string, any>} given
   * @param {string} path
   * @returns {Record<string, any>}
   */
  #placed(fields, given, path) {
    // Sub-content in the group's place that names its library under another key than `library`
    // (#174), its parameters in `params` or beside the name: what is no field of the group.
    let flat = false
    const holders = fields.filter((field) => field.type === 'library')
    if (typeof given.library !== 'string' && holders.length) {
      const outside = Object.keys(given).filter((key) => !SUB_CONTENT.includes(key) && !fields.some((field) => field.name === key))
      const named = namingKey(pick(given, outside), holders.flatMap((field) => optionNames(field)))
      const taken = named ? takenAs(holders, named) : null
      // A title beside them that is no field of its library is its own, as one beside `library`
      // is: it stays there, for `writtenLibrary` to take for its `metadata.title`.
      const fieldsOfIt = taken ? this.find(taken.machineName, taken.major)?.semantics ?? [] : []
      const titled = typeof given.title === 'string' && !fieldsOfIt.some((/** @type {any} */ field) => field.name === 'title')
      const beside = taken ? outside.filter((key) => key !== taken.key && !(titled && key === 'title')) : []
      const loose = taken && !isObject(given.params) && beside.length > 0
      const meant = !taken ? null : loose
        ? { ...omit(given, [taken.key, ...beside]), library: taken.library, params: pick(given, beside) }
        : { ...omit(given, [taken.key]), library: taken.library }
      if (meant && holderOf(fields, meant)) {
        given = meant
        flat = Boolean(loose)
      }
    }
    const holder = holderOf(fields, given)
    if (holder) {
      // A title beside it that is no field of the group is the sub-content's own, which
      // `writtenLibrary` takes for its `metadata.title` and says so: not a field of the group.
      const kept = typeof given.title === 'string' && !fields.some((field) => field.name === 'title') ? [...SUB_CONTENT, 'title'] : SUB_CONTENT
      const subContent = pick(given, kept)
      const shown = ['library', 'params', 'metadata'].filter((key) => Object.hasOwn(subContent, key))
        .map((key) => key === 'library' ? `"library": ${JSON.stringify(given.library)}` : `"${key}": { … }`)
      const beside = Object.keys(given).filter((key) => !SUB_CONTENT.includes(key) && fields.some((field) => field.name === key)).map((key) => `, "${key}": …`)
      this.report(path, `is sub-content, but here it goes inside an object, in its field ${holder.name}: write ${path} as { "${holder.name}": { ${shown.join(', ')} }${beside.join('')} }`)
      if (flat) {
        // Its parameters are where the object is, not in a `params` of it: the nearer move first.
        this.#flat.set(subContent, path)
        this.#move(path, `${path}.${holder.name}.params`)
      }
      this.#move(path, `${path}.${holder.name}`)
      given = { ...omit(given, kept), [holder.name]: subContent }
    }
    for (const [key, value] of Object.entries(given)) {
      if (value === null || value === undefined || fields.some((field) => field.name === key)) continue
      const homes = homesOf(fields, key, value)
      if (homes.length !== 1) continue
      const placed = placedIn(omit(given, [key]), homes[0], key, value)
      if (!placed) continue
      const home = homes[0].join('.')
      this.report(`${path}.${key}`, `is a field of ${home}, not of this level: write ${path}.${home}.${key}`)
      this.#move(`${path}.${key}`, `${path}.${home}.${key}`)
      given = placed
    }
    return given
  }

  /**
   * Notes what is stored in another place than it was written in.
   * @param {string} from where the source has it
   * @param {string} to where the content does
   */
  #move(from, to) {
    this.#written.set(to, from)
    this.moved.push({ from, to })
  }

  /**
   * @param {any} field
   * @param {any} written the written value, `null` to leave the field out, or undefined
   * @param {string[]} stack
   * @param {boolean} lenient
   * @param {string} path
   * @returns {any}
   */
  field(field, written, stack, lenient, path) {
    const optional = field.optional || lenient
    // What is stored in another place than it was written in is named by where it was written.
    path = this.#written.get(path) ?? path
    if (written === null) {
      if (!this.lenient && !field.optional && field.default === undefined && field.type !== 'boolean') this.report(path, 'is required and cannot be null')
      return undefined
    }
    switch (field.type) {
      case 'group': {
        const children = field.fields ?? []
        // A group of one field is saved as that field's value (h5peditor-group.js), unless it is
        // sub-content. It is still a level for `showWhen`.
        const flattened = children.length === 1 && !field.isSubContent
        if (written === undefined && field.default !== undefined) return structuredClone(field.default)
        if (flattened) {
          const [only] = children
          return this.#level(children, written === undefined ? {} : { [only.name]: written }, () =>
            this.field(this.#shown(only), written, stack, optional && written === undefined, path))
        }
        if (written !== undefined && !isObject(written)) {
          if (this.lenient) return written
          this.report(path, `expected an object with the fields ${names(children)}`)
          return undefined
        }
        // A group the editor draws with its own widget (a duration, a slide) takes numbers as that
        // widget sets them, decimals included, and starts its lists empty.
        if (field.widget && field.widget !== 'showWhen' && field.widget !== 'none') this.#draw(children)
        // Saved even if optional and untouched, as the editor does (h5peditor-group.js): types read
        // into one unchecked (Personality Quiz's `image.file`). Saved, an empty one is not asked.
        const closed = optional && (written === undefined || (this.saved && !holds(field, written)))
        const kept = isObject(field.default) ? Object.keys(field.default) : []
        if (field.isSubContent) kept.push('subContentId')
        const value = this.fields(children, written, stack, closed, path, kept)
        if (field.isSubContent) value.subContentId = this.#id(isObject(written) ? written.subContentId : undefined, path)
        return value
      }
      case 'list': {
        const item = this.#copy(field.field, { optional: false })
        if (Array.isArray(written)) {
          if (!this.lenient) {
            if (field.min !== undefined && written.length < field.min && !lenient) this.report(path, `has ${written.length} item${written.length === 1 ? '' : 's'}; it takes at least ${field.min}`)
            if (field.max !== undefined && written.length > field.max) this.report(path, `has ${written.length} items; it takes at most ${field.max}`)
          }
          return this.#level([], {}, () => {
            /** @type {unknown[]} */
            const items = []
            let refused = false
            written.forEach((each, index) => {
              const before = this.problems.length
              // Saved, an item that holds nothing an author has to write is one the editor started
              // an optional list with, and nobody filled: nothing is asked of it.
              const value = this.field(item, each, stack, lenient || (this.saved && field.optional === true && !holds(item, each)), `${path}[${index}]`)
              if (value !== undefined) items.push(value)
              else if (this.problems.length > before) refused = true
            })
            if (refused) this.shortened.push(path)
            return items
          })
        }
        if (written !== undefined && !this.lenient) {
          this.report(path, 'expected a list')
          return undefined
        }
        const count = !this.lenient && this.drawn.has(field)
          ? optional ? 0 : field.min ?? 0
          : Math.min(Math.max(optional ? 0 : (field.min ?? 0), field.defaultNum ?? (optional ? 0 : 1)), field.max ?? Infinity)
        if (!this.lenient && count > 0) {
          // A required list nobody wrote is what the editor offers a new author (h5peditor-list):
          // its items with defaults; where one needs an author's input, the list itself is missing.
          const before = this.problems.length
          const items = this.#items(item, count, stack, lenient, path)
          if (this.problems.length > before) {
            this.problems.length = before
            this.report(path, `is required: write at least ${Math.max(field.min ?? 1, 1)} item${Math.max(field.min ?? 1, 1) === 1 ? '' : 's'}`)
            return undefined
          }
          return items
        }
        const items = this.#items(item, count, stack, lenient, path)
        return items.length > 0 || !optional ? items : undefined
      }
      case 'library':
        if (isObject(written) && typeof written.library === 'string') return this.writtenLibrary(written, stack, path, field, this.#flat.get(written))
        if (written !== undefined && !this.lenient) {
          // Sub-content naming its library under another key, as chats with no skill do (#174):
          // the one that names a library the field takes, at the major written where it takes it.
          const named = !this.saved && isObject(written) ? namingKey(omit(written, SUB_CONTENT), optionNames(field)) : null
          const taken = named ? takenAs([field], named) : null
          const entry = this.saved || !isObject(written) ? null : taken ? this.find(taken.machineName, taken.major) : this.#only(field)
          if (taken && isObject(written.params)) {
            this.report(`${path}.${taken.key}`, `is the sub-content's library: write "library": "${taken.library}"`)
            // Its parameters are checked where the library's fields are at hand.
            return entry?.semantics ? this.writtenLibrary({ ...omit(written, [taken.key]), library: taken.library }, stack, path, field) : undefined
          }
          // Parameters without their sub-content around them, of the field's one library (#172) or
          // beside its name (#174): said so, and checked in the same round.
          let params = taken ? omit(written, [taken.key]) : written
          const own = entry ? Object.keys(params).filter((key) => (entry.semantics ?? []).some((/** @type {any} */ each) => each.name === key)) : []
          if (entry && own.length) {
            let metadata = own.includes('metadata') ? undefined : params.metadata
            // A title beside them that is no field of the library is the sub-content's own, as a
            // chapter's is: its `metadata.title`.
            const titled = metadata === undefined && typeof params.title === 'string' && !own.includes('title')
            if (titled) metadata = { title: params.title }
            if (metadata !== undefined) params = omit(params, titled ? ['title'] : ['metadata'])
            const library = taken ? taken.library : entry.library.machineName
            this.report(path, `is the params of sub-content, without the sub-content around them: write ${path} as { "library": "${library}"${metadata === undefined ? '' : titled ? ', "metadata": { "title": … }' : ', "metadata": { … }'}, "params": { "${own[0]}": … } }`)
            this.#move(path, `${path}.params`)
            return this.writtenLibrary({ library, params, ...(metadata === undefined ? {} : { metadata }) }, stack, path, field, path)
          }
          this.report(path, `expected sub-content, ${subContentOf(field, taken ? taken.machineName : written)}`)
          return undefined
        }
        // A default is the content the editor starts with (Interactive Video's summary task), left
        // as it does for an author who never opens it: what it would ask for stays unwritten.
        if (written === undefined && isObject(field.default) && typeof field.default.library === 'string') {
          if (this.lenient) return this.writtenLibrary(field.default, stack, path, null)
          return this.#quietly(() => this.writtenLibrary(structuredClone(field.default), stack, path, null))
        }
        return optional ? undefined : this.missing(field, stack, path)
      case 'text':
        // Within what nothing is asked of, an empty text is what the editor saved there.
        if (written !== undefined) return this.lenient ? written : this.text(lenient ? this.#optional(field) : field, written, path)
        // A default of null, which Course Presentation gives its colours, is stored as nothing: the
        // platforms' check would turn it into an empty text.
        if (field.default === null && !this.lenient) return undefined
        if (field.default !== undefined) return field.default
        return optional ? undefined : this.missing(field, stack, path)
      case 'number':
        if (written !== undefined) return this.lenient ? written : this.number(field, written, path)
        if (field.default !== undefined) return field.default
        return optional ? undefined : this.missing(field, stack, path)
      case 'boolean':
        if (written !== undefined && !this.lenient && typeof written !== 'boolean') this.report(path, 'expected true or false')
        // The editor's checkbox saves false when nobody ticked it (h5peditor-boolean.js).
        return written ?? field.default ?? false
      case 'select':
        // Saved, an optional select left at the editor's empty choice holds "".
        if (this.saved && optional && written === '') return written
        if (written !== undefined) return this.lenient ? written : this.select(field, written, path)
        if (field.default !== undefined) return structuredClone(field.default)
        return optional ? undefined : this.missing(field, stack, path)
      case 'image':
      case 'file':
      case 'video':
      case 'audio':
        if (written !== undefined) return this.lenient ? written : this.file(field, written, path)
        return optional ? undefined : this.missing(field, stack, path)
      default:
        return written
    }
  }

  /**
   * What a callback generates, with nothing it would report: problems, notes and hidden fields.
   * @template T
   * @param {() => T} generate
   * @returns {T}
   */
  #quietly(generate) {
    const counts = [this.problems.length, this.notes.length, this.unset.length, this.shortened.length, this.moved.length]
    try {
      return generate()
    } finally {
      this.problems.length = counts[0]
      this.notes.length = counts[1]
      this.unset.length = counts[2]
      this.shortened.length = counts[3]
      for (const { to } of this.moved.splice(counts[4])) this.#written.delete(to)
    }
  }

  /** Fields, and all within them, as a widget of the editor's draws them. @param {any[]} fields */
  #draw(fields) {
    for (const field of fields) {
      if (!field || this.drawn.has(field)) continue
      this.drawn.add(field)
      if (field.fields) this.#draw(field.fields)
      if (field.field) this.#draw([field.field])
    }
  }

  /**
   * A new list's items, each with its defaults, a level below the list's.
   * @param {any} item
   * @param {number} count
   * @param {string[]} stack
   * @param {boolean} lenient
   * @param {string} path
   */
  #items(item, count, stack, lenient, path) {
    return this.#level([], {}, () => {
      const items = []
      for (let index = 0; index < count; index++) {
        const value = this.field(item, undefined, stack, lenient, `${path}[${index}]`)
        if (value !== undefined) items.push(value)
      }
      return items
    })
  }

  /**
   * A required field with neither a written value nor a default: the caller's to fill, or a
   * problem.
   * @param {any} field
   * @param {string[]} stack
   * @param {string} path
   */
  missing(field, stack, path) {
    if (this.options.fill) return this.options.fill(field, { generator: this, stack, path })
    // A field the editor hides is its own bookkeeping, a position it sets when an author drags
    // something: a content type's layout sets it here, and what none sets is a problem then.
    if (field.widget === 'none') {
      this.unset.push({ field, path })
      return undefined
    }
    this.report(path, `is required (${describe(field)})`)
    return undefined
  }

  /**
   * Sub-content: the first option the pack has that is not already a parent here, made from its own
   * semantics; none is left out. The sweep's fill, to make a content type play.
   * @param {any} field
   * @param {string[]} stack
   * @param {string} [path]
   */
  library(field, stack, path = '') {
    if (stack.length > MAX_DEPTH) return undefined
    for (const option of field.options ?? []) {
      const name = typeof option === 'string' ? option : option?.name
      const match = /^(\S+) (\d+)\.(\d+)$/.exec(name ?? '')
      if (!match || stack.includes(match[1])) continue
      const entry = this.find(match[1], Number(match[2]))
      if (!entry) continue
      return this.subContent(entry, undefined, undefined, stack, path)
    }
    return undefined
  }

  /**
   * The one library a field takes, as the pack has it: what parameters written without their
   * sub-content are taken to be of.
   * @param {any} field
   */
  #only(field) {
    const options = libraryOptions(field)
    if (!options.length || options.some((option) => option.machineName !== options[0].machineName)) return null
    return this.find(options[0].machineName, options[0].major)
  }

  /**
   * Written sub-content: the library it names, its parameters filled from its semantics. Authoring,
   * one the pack lacks or the field does not take is a problem; lenient, only one the pack lacks stays as written.
   * @param {any} written
   * @param {string[]} stack
   * @param {string} path
   * @param {any} field the library field, or null for a default the semantics give
   * @param {string} [at] where its parameters are written, where that is not in its `params`
   */
  writtenLibrary(written, stack, path, field, at) {
    if (this.lenient) {
      const match = /^(\S+) (\d+)\.(\d+)$/.exec(written.library)
      const entry = match ? this.find(match[1], Number(match[2])) : null
      if (!entry) return written
      return { ...this.subContent(entry, written.params, undefined, stack, path), ...omit(written, ['params']), library: libraryString(entry.library) }
    }
    // A library named loosely, "multichoice", where only one the field takes can be meant (#174).
    const loose = field && !this.saved ? machineNameOf(written.library, optionNames(field)) : null
    if (loose && !loose.exact) {
      this.report(`${path}.library`, `takes the machine name, "${loose.machineName}"`)
      written = { ...written, library: loose.machineName }
    }
    const match = /^\s*(\S+?)(?:\s+(\d+)\.(\d+))?\s*$/.exec(written.library)
    if (!match) {
      this.report(`${path}.library`, `expected a library's machine name, such as ${optionNames(field)[0] ?? '"H5P.MultiChoice"'}`)
      return undefined
    }
    const machineName = match[1]
    let major = match[2] === undefined ? undefined : Number(match[2])
    if (field) {
      const options = libraryOptions(field)
      const option = options.find((each) => each.machineName === machineName && (major === undefined || each.major === major))
      if (!option) {
        this.report(`${path}.library`, `${machineName} is not one this field takes; it takes ${[...new Set(options.map((each) => each.machineName))].join(', ')}`)
        return undefined
      }
      major = option.major
    }
    const entry = this.find(machineName, major)
    if (!entry) {
      this.report(`${path}.library`, `the library pack has no ${machineName}${major === undefined ? '' : ` ${major}.x`}`)
      return undefined
    }
    if (this.saved) {
      // As H5P keeps sub-content (validateLibrary): these four, and what the field adds.
      const keys = ['library', 'params', 'subContentId', 'metadata', ...extraAttributes(field)]
      for (const key of Object.keys(written)) if (!keys.includes(key)) this.report(`${path}.${key}`, `is not part of sub-content; H5P keeps ${keys.join(', ')}`)
      if (written.metadata !== undefined) checkMetadata(written.metadata, `${path}.metadata`, (at, message) => this.report(at, message))
      // A field's default content (Interactive Video's summary task) may be as the editor started
      // it, which saved content does not tell: what it holds is checked, nothing is asked of it.
      const started = isObject(field?.default) && typeof field.default.library === 'string' && field.default.library.trim().split(/\s+/)[0] === machineName
      const minor = match[3] === undefined ? undefined : Number(match[3])
      return this.subContent(entry, written.params, written.metadata, stack, path, { id: written.subContentId, minor, closed: started })
    }
    // Sub-content's title is its `metadata.title`; written beside `library`, it is taken for it.
    if (typeof written.title === 'string' && written.metadata === undefined) {
      this.report(`${path}.title`, 'is the sub-content\'s title, which is in its metadata: write "metadata": { "title": … }')
      written = { ...omit(written, ['title']), metadata: { title: written.title } }
    }
    for (const key of Object.keys(written)) {
      if (!['library', 'params', 'metadata'].includes(key)) this.report(`${path}.${key}`, 'is not part of sub-content; write library, params and metadata')
    }
    if (written.metadata !== undefined && !isObject(written.metadata)) this.report(`${path}.metadata`, 'expected an object, such as { "title": "…" }')
    else if (isObject(written.metadata)) {
      for (const key of Object.keys(written.metadata)) if (key !== 'title') this.report(`${path}.metadata.${key}`, 'is not set per sub-content here; write only its title, the rest comes from the source')
    }
    return this.subContent(entry, written.params, written.metadata, stack, path, { at })
  }

  /**
   * @param {PackEntry} entry
   * @param {any} written its parameters
   * @param {any} metadata its written metadata
   * @param {string[]} stack
   * @param {string} path
   * @param {{ id?: unknown, minor?: number, closed?: boolean, at?: string }} [saved] the saved id,
   *   the library's minor, `closed` (nothing asked of it) and `at`, where the parameters are
   */
  subContent(entry, written, metadata, stack, path, { id, minor, closed = false, at = `${path}.params` } = {}) {
    const params = this.#of(entry, minor, () => this.fields(entry.semantics ?? [], written, [...stack, entry.library.machineName], closed, at))
    return {
      library: libraryString(entry.library),
      params,
      subContentId: this.#id(id, path),
      metadata: this.saved && isObject(metadata)
        ? structuredClone(metadata)
        : this.options.metadata
          ? this.options.metadata(entry, metadata, path)
          : { contentType: entry.library.title, license: 'U', title: entry.library.title }
    }
  }

  /**
   * @param {any} field
   * @param {unknown} written
   * @param {string} path
   */
  text(field, written, path) {
    if (typeof written !== 'string') {
      this.report(path, `expected text${typeof written === 'number' ? `, such as "${written}"` : ''}`)
      return undefined
    }
    // Written text is stored as the editor's widget for the field stores what an author types;
    // saved text, as the content check keeps it, which goes by the field's `tags` alone.
    const markup = this.saved ? allowedTags(field) !== null : takesMarkup(field)
    const stored = markup
      ? markupText(written, field, (message) => this.report(path, message), { saved: this.saved })
      : plainText(written, (message) => this.note(path, message), { filtered: allowedTags(field) !== null })
    const length = Array.from(stored).length
    if (typeof field.maxLength === 'number' && length > field.maxLength) this.report(path, `is ${length} characters as stored; it takes at most ${field.maxLength}`)
    if (field.regexp?.pattern && !(stored === '' && field.optional)) {
      let pattern = null
      try {
        pattern = new RegExp(field.regexp.pattern, (field.regexp.modifiers ?? '').replace(/[^gimsuy]/g, ''))
      } catch {
        // A pattern JavaScript cannot read is the content check's to apply, not ours.
      }
      if (pattern && !pattern.test(stored)) this.report(path, `"${written.slice(0, 40)}" is not in the form this field takes${field.description ? ` (${stripTags(field.description).slice(0, 120)})` : ''}`)
    }
    if (!field.optional && stripTags(stored) === '' && !/<(img|iframe|video|audio|hr|table)/i.test(stored)) this.report(path, 'is required and is empty')
    return stored
  }

  /**
   * A number as h5peditor-number.js checks it: in range, to `decimals` decimals (none if unset and
   * no own widget), a multiple of `step` within rounding error, which the editor's `%` refuses.
   * @param {any} field
   * @param {unknown} written
   * @param {string} path
   */
  number(field, written, path) {
    if (typeof written !== 'number' || !Number.isFinite(written)) {
      this.report(path, 'expected a number')
      return undefined
    }
    if (field.min !== undefined && written < Number(field.min)) this.report(path, `is ${written}; the least it takes is ${field.min}`)
    if (field.max !== undefined && written > Number(field.max)) this.report(path, `is ${written}; the most it takes is ${field.max}`)
    if (field.decimals !== undefined && Number(field.decimals) >= 0) {
      const factor = 10 ** Number(field.decimals)
      if (Math.round(written * factor) / factor !== written) this.report(path, `takes ${field.decimals ? `at most ${field.decimals} decimals` : 'a whole number'}`)
    } else if (!field.widget && !this.drawn.has(field) && !Number.isInteger(written)) this.report(path, 'takes a whole number')
    const step = Number(field.step)
    if (field.step !== undefined && step > 0) {
      const steps = written / step
      // Value, step and quotient each round once, so the quotient is off by about 1.5 EPSILON;
      // the bound is four. A loose 1e-9 let 50000000.05 pass in steps of 0.1, half a step off.
      if (Math.abs(steps - Math.round(steps)) > 4 * Number.EPSILON * Math.max(1, Math.abs(steps))) this.report(path, `takes steps of ${field.step}`)
    }
    return written
  }

  /**
   * @param {any} field
   * @param {unknown} written
   * @param {string} path
   */
  select(field, written, path) {
    const values = selectValues(field)
    const check = (/** @type {unknown} */ value) => {
      if (values.length && !values.includes(String(value))) this.report(path, `${JSON.stringify(value)} is not an option; the options are ${values.map((each) => JSON.stringify(each)).join(', ')}`)
    }
    if (field.multiple) {
      if (!Array.isArray(written)) this.report(path, 'expected a list of options')
      else written.forEach(check)
    } else if (typeof written !== 'string' && typeof written !== 'number' && typeof written !== 'boolean') this.report(path, 'expected one of its options')
    else check(written)
    return written
  }

  /**
   * A written file: `{ "path": … }`, beside the source or a web address, with `copyright`; a video
   * or audio field takes a list, one per format. Saved, it is as H5P stores it.
   * @param {any} field
   * @param {unknown} written
   * @param {string} path
   */
  file(field, written, path) {
    const many = field.type === 'video' || field.type === 'audio'
    const list = many && Array.isArray(written) ? written : [written]
    if (many && Array.isArray(written) && !written.length) {
      this.report(path, 'expected at least one file')
      return undefined
    }
    if (!many && Array.isArray(written)) {
      this.report(path, 'expected one file, { "path": "…" }')
      return undefined
    }
    const files = []
    for (const [index, each] of list.entries()) {
      const at = many && Array.isArray(written) ? `${path}[${index}]` : path
      if (!isObject(each) || typeof each.path !== 'string' || !each.path.trim()) {
        this.report(at, this.saved
          ? 'expected a file as H5P stores it, { "path": "images/picture.jpg", "mime": "image/jpeg" }'
          : 'expected a file, { "path": "picture.jpg" }, a file beside the source or a web address')
        continue
      }
      if (this.saved) {
        const keys = ['path', 'mime', 'copyright', ...(FILE_KEYS[field.type] ?? []), ...extraAttributes(field)]
        for (const key of Object.keys(each)) if (!keys.includes(key)) this.report(`${at}.${key}`, `is not part of a file as H5P stores it; it keeps ${keys.join(', ')}`)
        if (each.mime !== undefined && typeof each.mime !== 'string') this.report(`${at}.mime`, 'expected a MIME type, such as "image/jpeg"')
        for (const key of ['width', 'height']) if (each[key] !== undefined && !(Number.isInteger(each[key]) && each[key] >= 0)) this.report(`${at}.${key}`, 'expected a whole number of pixels')
      } else for (const key of Object.keys(each)) if (!['path', 'copyright'].includes(key)) this.report(`${at}.${key}`, 'is not part of a file here; write path and, when known, copyright')
      if (each.copyright !== undefined && !isObject(each.copyright)) this.report(`${at}.copyright`, 'expected an object, such as { "license": "CC BY", "author": "…" }')
      const value = this.saved ? structuredClone(each) : { ...each }
      this.media.push({ field, value, path: at })
      files.push(value)
    }
    return many ? files : files[0]
  }
}

/**
 * A new id, random, as H5P's editor gives each part one: crypto's, which Node has, and a page in a
 * secure context only, https, localhost or a Tauri window.
 * @internal
 */
export function newId() {
  if (typeof globalThis.crypto?.randomUUID !== 'function') throw new Error('Content takes ids from crypto.randomUUID, which a page has in a secure context only: https, localhost, or a Tauri window')
  return globalThis.crypto.randomUUID()
}

/** Every `library` string in the parameters: the sub-content a package plays. */
export function librariesIn(/** @type {any} */ params, found = new Set()) {
  if (Array.isArray(params)) for (const item of params) librariesIn(item, found)
  else if (isObject(params)) {
    if (typeof params.library === 'string' && /^\S+ \d+\.\d+$/.test(params.library)) found.add(params.library)
    for (const value of Object.values(params)) librariesIn(value, found)
  }
  return found
}

/** `H5P.MultiChoice 1.16`, the form `library` fields and `h5p.json` use. */
export function libraryString(/** @type {any} */ library) {
  return `${library.machineName} ${library.majorVersion}.${library.minorVersion}`
}

/** @param {any} field @returns {{ machineName: string, major: number, minor: number }[]} */
export function libraryOptions(field) {
  return (field?.options ?? [])
    .map((/** @type {any} */ option) => /^(\S+) (\d+)\.(\d+)$/.exec(typeof option === 'string' ? option : option?.name ?? ''))
    .filter(Boolean)
    .map((/** @type {RegExpExecArray} */ match) => ({ machineName: match[1], major: Number(match[2]), minor: Number(match[3]) }))
}

/** @param {any} field */
function optionNames(field) {
  return libraryOptions(field).map((option) => option.machineName)
}

/**
 * The library a name under another key than `library` stands for (#174), of those the fields take:
 * at the major written where one takes it, else the first. `library` has a version only if written.
 * @param {any[]} fields library fields
 * @param {{ key: string, machineName: string, major?: number, library: string }} named
 * @returns {{ key: string, machineName: string, major: number | undefined, library: string }}
 */
function takenAs(fields, named) {
  const offered = fields.flatMap((field) => libraryOptions(field)).filter((option) => option.machineName === named.machineName)
  const option = offered.find((each) => each.major === named.major) ?? offered[0]
  const kept = option !== undefined && option.major === named.major
  return { key: named.key, machineName: named.machineName, major: option?.major, library: kept ? named.library : named.machineName }
}

/**
 * Sub-content as a field takes it, for a problem to show: with the library named if there is one or
 * the written name is taken, else all it takes: the first of several was read as the one to write.
 * @param {any} field
 * @param {unknown} [written]
 */
function subContentOf(field, written) {
  const taken = [...new Set(optionNames(field))]
  const named = typeof written === 'string' ? written.trim().split(/\s+/)[0] : undefined
  const library = taken.length === 1 ? taken[0] : taken.find((name) => name === named)
  if (library) return `{ "library": "${library}", "params": { … } }`
  return `{ "library": "${taken.length ? '…' : 'H5P.…'}", "params": { … } }${taken.length ? `, of ${taken.join(', ')}` : ''}`
}

/**
 * The library field that sub-content written in a group's place belongs in: the one taking its
 * library, or the only one; none if the group has its own `library` field, or it is unclear.
 * @param {any[]} fields
 * @param {Record<string, any>} given
 */
function holderOf(fields, given) {
  if (typeof given.library !== 'string') return null
  const holders = fields.filter((field) => field.type === 'library')
  if (fields.some((field) => SUB_CONTENT.includes(field.name) && field.type !== 'library')) return null
  const machineName = given.library.trim().split(/\s+/)[0]
  const taking = holders.filter((field) => optionNames(field).includes(machineName))
  const holder = taking.length === 1 ? taking[0] : holders.length === 1 ? holders[0] : null
  return holder && (holder.name === 'library' || !Object.hasOwn(given, holder.name)) ? holder : null
}

/**
 * The group names, outermost first, from a level to a field of this name taking the kind written:
 * `slides` is `presentation.slides`, not `l10n.slides`. A one-field group is no level of a source.
 * @param {any[]} fields
 * @param {string} name
 * @param {unknown} value
 * @param {string[]} [chain]
 * @param {string[][]} [found]
 */
function homesOf(fields, name, value, chain = [], found = []) {
  for (const field of fields) {
    const children = field.fields ?? []
    if (field.type !== 'group' || (children.length === 1 && !field.isSubContent) || isInterfaceText(field)) continue
    const within = [...chain, field.name]
    if (children.some((/** @type {any} */ child) => child.name === name && !isInterfaceText(child) && takes(child, value))) found.push(within)
    homesOf(children, name, value, within, found)
  }
  return found
}

/**
 * Whether a field takes a value of this kind: a list, an object, a text, a number, or true or
 * false. A group of one field takes what that field does.
 * @param {any} field
 * @param {unknown} value
 * @returns {boolean}
 */
function takes(field, value) {
  if (field.type === 'group' && (field.fields ?? []).length === 1 && !field.isSubContent) return takes(field.fields[0], value)
  if (Array.isArray(value)) return ['list', 'video', 'audio'].includes(field.type) || (field.type === 'select' && Boolean(field.multiple))
  // A group is the home of an object that writes a field of it, not one sharing its name alone:
  // Game Map's `behaviour.map` is no home for a picture's `map`. Nor is an interface text a field.
  if (isObject(value) && field.type === 'group') return Object.keys(value).some((key) => (field.fields ?? []).some((/** @type {any} */ each) => each.name === key && !isInterfaceText(each)))
  if (isObject(value)) return ['library', 'image', 'file', 'video', 'audio'].includes(field.type)
  if (typeof value === 'string') return field.type === 'text' || (field.type === 'select' && !field.multiple)
  return typeof value === field.type
}

/**
 * What is written for a level with a value put in a group within it; null if something is written
 * there already, or a group on the way is written as something else than an object.
 * @param {Record<string, any>} given
 * @param {string[]} chain
 * @param {string} key
 * @param {unknown} value
 * @returns {Record<string, any> | null}
 */
function placedIn(given, chain, key, value) {
  if (!chain.length) return Object.hasOwn(given, key) ? null : { ...given, [key]: value }
  const [name, ...rest] = chain
  if (given[name] !== undefined && !isObject(given[name])) return null
  const placed = placedIn(given[name] ?? {}, rest, key, value)
  return placed && { ...given, [name]: placed }
}

/** What a field's semantics add to what the platforms keep of its value. @param {any} field @returns {string[]} */
function extraAttributes(field) {
  return Array.isArray(field?.extraAttributes) ? field.extraAttributes.filter((/** @type {unknown} */ name) => typeof name === 'string') : []
}

/**
 * Whether a saved value holds something an author must write: a required field's value, no default.
 * What the editor saves untouched holds none: an optional group left closed, an empty text or list.
 * @param {any} field
 * @param {unknown} value
 * @returns {boolean}
 */
function holds(field, value) {
  if (value === undefined || value === null || value === '') return false
  if (field.type === 'list') return Array.isArray(value) && value.some((item) => holds(field.field ?? {}, item))
  if (field.type !== 'group' || ((field.fields ?? []).length === 1 && !field.isSubContent)) return true
  return isObject(value) && (field.fields ?? []).some((/** @type {any} */ child) =>
    !child.optional && child.default === undefined && child.type !== 'boolean' && holds(child, value[child.name]))
}

/**
 * Whether written content holds nothing but empty objects and lists: items an editor started and
 * nobody filled.
 * @param {unknown} value
 * @returns {boolean}
 */
function vacant(value) {
  if (Array.isArray(value)) return value.every(vacant)
  return isObject(value) && Object.values(value).every(vacant)
}

/**
 * Whether two values are the same content: equal but for the id and metadata a build gives anew,
 * where an `undefined` or empty-text key counts as none, as the editor saves a field nobody filled.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function sameContent(a, b) {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((each, i) => sameContent(each, b[i]))
  if (!isObject(a) || !isObject(b)) return false
  const part = typeof a.library === 'string' || typeof b.library === 'string'
  /** @param {Record<string, any>} object */
  const keys = (object) => Object.keys(object).filter((key) => object[key] !== undefined && object[key] !== '' && key !== 'subContentId' && !(part && key === 'metadata'))
  const own = keys(a)
  return own.length === keys(b).length && own.every((key) => sameContent(a[key], b[key]))
}

/**
 * Why saved content may hold a field the semantics it is checked against do not name.
 * @param {{ library: any, minor: number }} other
 */
function otherMinor({ library, minor }) {
  const named = `${library.majorVersion}.${minor}`
  const served = `${library.majorVersion}.${library.minorVersion}`
  return minor < library.minorVersion
    ? `is not a field of ${libraryString(library)}; the content names ${named}, which the player upgrades to ${served} as it plays, and that may move it`
    : `is not a field of ${libraryString(library)}; the content names ${named}, newer, which the player plays at ${served} without it`
}

/** @param {any} field @returns {string[]} */
function selectValues(field) {
  /** @type {string[]} */
  const values = []
  for (const option of field.options ?? []) {
    if (option?.type === 'optgroup') for (const sub of option.options ?? []) values.push(String(sub.value))
    else if (option?.value !== undefined && option?.value !== null) values.push(String(option.value))
  }
  return values
}

/** A field's kind, as a problem names it. @param {any} field */
function describe(field) {
  switch (field.type) {
    case 'text': return takesMarkup(field) ? 'markup text' : 'text'
    case 'select': return `one of ${selectValues(field).map((value) => JSON.stringify(value)).join(', ')}`
    case 'library': return `sub-content: ${optionNames(field).join(', ')}`
    case 'image': case 'file': return `a file, { "path": "…" }`
    case 'video': case 'audio': return `a list of files, [{ "path": "…" }]`
    default: return field.type
  }
}

/** @param {any[]} fields */
function names(fields) {
  return fields.map((field) => field.name).join(', ')
}

/**
 * A level's fields by name, for a problem to list: those an author writes, and the interface
 * texts as one, since a translation supplies them and an Interactive Book has 35.
 * @param {any[]} fields
 */
function fieldNames(fields) {
  const written = fields.filter((field) => !isInterfaceText(field))
  return written.length && written.length < fields.length ? `${names(written)}, and the interface texts` : names(fields)
}

/** @param {any} object @param {string[]} keys */
function omit(object, keys) {
  return Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)))
}

/** @param {any} object @param {string[]} keys */
function pick(object, keys) {
  return Object.fromEntries(Object.entries(object).filter(([key]) => keys.includes(key)))
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
