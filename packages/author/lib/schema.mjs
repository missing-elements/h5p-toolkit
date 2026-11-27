import { decodeEntities, editorWidget, stripTags, takesMarkup } from './text.mjs'

/**
 * A content type's fields as an author writes them, from its `semantics.json`: names, kinds,
 * defaults, options, sizes, tags, sub-content (not interface texts or layout-set fields).
 */

/** Groups that hold interface texts, under the names the pack's libraries give them. */
const INTERFACE_GROUPS = new Set(['l10n', 'i10n', 'a11y', 'texts', 'UI', 'localize', 'labels', 'translations'])

/**
 * Whether a field is an interface text, or a group of nothing else: what a translation supplies.
 * @param {any} field
 * @returns {boolean}
 */
export function isInterfaceText(field) {
  if (field.type === 'text') return Boolean(field.common)
  if (field.type === 'group') {
    const children = field.fields ?? []
    const texts = children.length > 0 && children.every((/** @type {any} */ child) => child.type === 'text' || (child.type === 'group' && isInterfaceText(child)))
    return texts && (Boolean(field.common) || INTERFACE_GROUPS.has(field.name))
  }
  return false
}

/** @param {string} html */
function plain(html) {
  return decodeEntities(stripTags(html.replace(/<\/li>/g, '. '))).replace(/\s+/g, ' ').replace(/\.\s*\./g, '.').trim()
}

/** @param {unknown} value */
function short(value) {
  const text = JSON.stringify(value)
  return text.length > 48 ? `${text.slice(0, 45)}…` : text
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

/**
 * @typedef {{ has?: (machineName: string) => boolean, sets?: string[], descriptions?: boolean, all?: boolean }} SchemaOptions
 *   `has` lists only sub-content the pack can build; `sets`, layout-set fields, as `a.b[].c`; `descriptions: false` omits each field's description; `all`, all texts
 */

/**
 * What a field takes, in a few words.
 * @param {any} field
 * @param {SchemaOptions} options
 * @param {boolean} [drawn] drawn by a widget, whose numbers take decimals
 */
function kind(field, options, drawn = false) {
  switch (field.type) {
    case 'text': {
      if (!takesMarkup(field)) return editorWidget(field) === 'textarea' ? 'text, multi-line' : 'text'
      const own = (Array.isArray(field.tags) ? field.tags : []).filter((/** @type {string} */ tag) => !['div', 'span', 'p', 'br'].includes(tag))
      return own.length ? `html: ${own.join(' ')}` : 'html'
    }
    case 'number': {
      const range = field.min !== undefined || field.max !== undefined ? ` ${field.min ?? ''}–${field.max ?? ''}` : ''
      return `${field.decimals || field.widget || drawn ? 'number' : 'whole number'}${range}`
    }
    case 'boolean':
      return 'boolean'
    case 'select': {
      const values = selectValues(field)
      return values.length ? `${field.multiple ? 'some of' : 'one of'} ${values.map((value) => JSON.stringify(value)).join(' | ')}` : field.multiple ? 'list of values' : 'value'
    }
    case 'library': {
      const names = [...new Set((field.options ?? []).map((/** @type {any} */ option) => String(typeof option === 'string' ? option : option?.name).split(' ')[0]))]
      return `sub-content: ${names.filter((name) => !options.has || options.has(name)).join(' | ')}`
    }
    case 'image':
      return 'image file'
    case 'file':
      return 'file'
    case 'video':
      return 'video files'
    case 'audio':
      return 'audio files'
    default:
      return field.type
  }
}

/** A group of one field is written as that field; this is the field it is written as. @param {any} field */
function written(field) {
  let shown = field
  while (shown.type === 'group' && (shown.fields ?? []).length === 1 && !shown.isSubContent) {
    const child = shown.fields[0]
    shown = { ...child, optional: shown.optional || child.optional, label: shown.label ?? child.label, default: shown.default ?? child.default, showWhen: shown.showWhen ?? child.showWhen }
  }
  return shown
}

/**
 * One field's lines and, for a group or a list of groups, its children's.
 * @param {any} field
 * @param {string} indent
 * @param {string} path the field's path, `a.b[].c`
 * @param {{ left: number }} counts
 * @param {SchemaOptions} options
 * @param {boolean} [drawn] whether a widget of the content type's draws it, not the editor's form
 * @returns {string[]}
 */
function lines(field, indent, path, counts, options, drawn = false) {
  if ((options.sets ?? []).includes(path)) return []
  const hidden = field.widget === 'none' || field.widget === 'hidden'
  if (hidden && field.type === 'boolean') return []
  if (!options.all && isInterfaceText(field)) {
    counts.left += countTexts(field)
    return []
  }
  const shown = written(field)
  const media = ['image', 'file', 'video', 'audio'].includes(shown.type)
  const required = !shown.optional && (media || (shown.default === undefined && !['boolean', 'group', 'list'].includes(shown.type)))
  let head
  /** @type {any} */
  let item = null
  if (shown.type === 'list') {
    const range = shown.max ? ` ${shown.min ?? 0}–${shown.max}` : shown.min ? ` ${shown.min}+` : ''
    item = written(shown.field ?? {})
    head = item.type === 'group' ? `list${range} of` : `list${range} of ${kind(item, options, drawn)}`
  } else if (shown.type === 'group') head = 'group'
  else head = kind(shown, options, drawn)
  // A list the editor's own form starts with an item is required when its item needs writing; one
  // a widget of a content type's draws starts empty, and needs only its minimum.
  const list = shown.type === 'list' && !shown.optional && (shown.min > 0 || (!drawn && needsWriting(item)))
  if (required || list) head += ', required'
  if (shown.default !== undefined && shown.default !== null && shown.type !== 'group') head += ` = ${short(shown.default)}`
  if (hidden) head += ', hidden in the editor'
  const rules = shown.showWhen?.rules ?? []
  if (rules.length) head += `; only when ${rules.map((/** @type {any} */ rule) => `${String(rule.field).replace(/^\.\.\//, '')} is ${[rule.equals].flat().map((value) => JSON.stringify(value)).join(' or ')}`).join(' or ')}`
  const label = typeof shown.label === 'string' ? plain(shown.label) : ''
  const own = typeof shown.description === 'string' ? shown.description : ''
  const itemDescription = item && item.type !== 'group' && typeof item.description === 'string' ? item.description : ''
  const description = options.descriptions !== false && ['text', 'list', 'library', 'number', 'select'].includes(shown.type) ? plain(own || itemDescription) : ''
  const about = [label, description && description !== label ? description : ''].filter(Boolean).join(': ')
  const out = [`${indent}- \`${field.name}\` ${head}${about ? ` — ${about.length > 200 ? `${about.slice(0, 197)}…` : about}` : ''}`]
  // What the editor shows in its "important" box (h5peditor.js, `createImportantDescription`): the
  // syntax a field's text is written in.
  const important = shown.important ?? (item && item.type !== 'group' ? item.important : null)
  if (options.descriptions !== false && important?.description) {
    const example = important.example ? ` Example: ${plain(String(important.example))}` : ''
    out.push(`${indent}  ${plain(String(important.description))}${example}`)
  }
  const inner = drawn || Boolean(shown.type === 'group' && shown.widget && shown.widget !== 'showWhen' && shown.widget !== 'none')
  // A group's default gives its fields theirs, as Drag and Drop's task size does (#297): a field
  // with one is not required.
  const inherit = (/** @type {any} */ group, /** @type {any} */ child) => (child.default == null && group.default && typeof group.default === 'object' && group.default[child.name] != null ? { ...child, default: group.default[child.name] } : child)
  if (shown.type === 'group') for (const child of shown.fields ?? []) out.push(...lines(inherit(shown, child), `${indent}  `, `${path}.${child.name}`, counts, options, inner))
  if (item?.type === 'group') for (const child of item.fields ?? []) out.push(...lines(inherit(item, child), `${indent}  `, `${path}[].${child.name}`, counts, options, inner))
  return out
}

/**
 * Whether a list's item needs something written: a required field with no default in it.
 * @param {any} item
 * @returns {boolean}
 */
function needsWriting(item) {
  if (!item) return false
  const shown = written(item)
  if (shown.type === 'group') return (shown.fields ?? []).some((/** @type {any} */ child) => !child.optional && needsWriting(child))
  if (shown.optional || shown.default !== undefined || shown.type === 'boolean') return false
  return shown.type !== 'list' || shown.min > 0
}

/** @param {any} field @returns {number} */
function countTexts(field) {
  if (field.type === 'text') return 1
  return (field.fields ?? []).reduce((/** @type {number} */ sum, /** @type {any} */ child) => sum + countTexts(child), 0)
}

/**
 * A content type's fields, one line each, nested as they are written.
 * @param {any[]} semantics
 * @param {SchemaOptions} [options]
 * @returns {{ lines: string[], interfaceTexts: number }}
 */
export function schemaLines(semantics, options = {}) {
  const counts = { left: 0 }
  const out = []
  for (const field of semantics) out.push(...lines(field, '', field.name, counts, options))
  return { lines: out, interfaceTexts: counts.left }
}

/** The line that opens a type file's generated section, and the one that closes it. */
export const GENERATED_START = '<!-- Generated by `h5p-author schema --markdown` from the pinned pack. Do not edit by hand. -->'
export const GENERATED_END = '<!-- End of the generated section. -->'

/**
 * A type file with its generated section: between its markers, or appended if none. A lone,
 * repeated or reversed marker means a hand edit and is refused: appending would leave stale text.
 * @param {string} text
 * @param {string} section
 * @param {string} name
 * @internal
 */
export function withSection(text, section, name) {
  const count = (/** @type {string} */ marker) => text.split(marker).length - 1
  const [starts, ends] = [count(GENERATED_START), count(GENERATED_END)]
  if (!starts && !ends) return `${text.trimEnd()}\n\n${section}\n`
  const start = text.indexOf(GENERATED_START)
  const end = text.indexOf(GENERATED_END)
  if (starts !== 1 || ends !== 1 || end < start) {
    throw new Error(`${name}: its generated section's markers are broken (${starts} start, ${ends} end${starts === 1 && ends === 1 ? ', the end first' : ''}); put back one of each, ${GENERATED_START} before ${GENERATED_END}, around the section`)
  }
  return `${text.slice(0, start)}${section}${text.slice(end + GENERATED_END.length)}`
}

/**
 * What a source of any content type names beside its fields. The type file's example shows only
 * `type` and `params`: a name in it would be copied as the author (#182).
 */
export const SOURCE_FIELDS = 'The example is `type` and `params` alone, and `params` holds the fields below. A source also names its own `title`, `language`, `license` and `authors`, all four required: the build refuses a source that leaves out any of them. Write the author and the licence the user gave, as given, and ask for neither: an author not given is the name you know the user by, or "Unknown"; a licence not given, or one no code below stands for, is `U`; never make up a name. A licence is one of these H5P codes: `U`, `CC BY`, `CC BY-SA`, `CC BY-ND`, `CC BY-NC`, `CC BY-NC-SA`, `CC BY-NC-ND`, `CC0 1.0`, `CC PDM`, `GNU GPL`, `PD`, `ODC PDDL`, `C`. Only the six CC BY codes take a version, written apart, one of 4.0, 3.0, 2.5, 2.0 or 1.0: "CC BY 4.0" is `"license": "CC BY", "licenseVersion": "4.0"`. `CC0 1.0` is one code, as it stands.'

/**
 * The generated section of a type file: the fields, under a heading, between markers that a
 * refresh rewrites, and for a content type what a source names beside them.
 * @param {any} library its `library.json`
 * @param {any[]} semantics
 * @param {SchemaOptions} [options]
 */
export function schemaMarkdown(library, semantics, options = {}) {
  const { lines: fields, interfaceTexts } = schemaLines(semantics, options)
  return [
    GENERATED_START,
    '',
    `## Fields of ${library.machineName} ${library.majorVersion}.${library.minorVersion}`,
    '',
    ...(library.runnable ? [SOURCE_FIELDS, ''] : []),
    ...fields,
    '',
    interfaceTexts
      ? `${interfaceTexts} interface texts are left out: they come from the libraries' translations. \`h5p-author schema ${library.machineName} --all\` lists them, for a source to set one.`
      : 'It has no interface texts of its own.',
    '',
    GENERATED_END
  ].join('\n')
}
