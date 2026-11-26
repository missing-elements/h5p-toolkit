/**
 * Authored text as H5P stores it: a rich-text field holds markup (its tags and `div`, `span`, `p`,
 * `br`, no others), every other field plain text, escaped as the platforms keep it (`takesMarkup`).
 */

/** An `&` that does not begin an entity. */
const BARE_AMPERSAND = /&(?!(?:[a-zA-Z][a-zA-Z0-9]*|#[0-9]+|#[xX][0-9a-fA-F]+);)/g

/**
 * Plain text as the platforms store a text field: `&`, `<`, `>`, `"` and `'` escaped, an entity
 * already there kept, as `htmlspecialchars` with `ENT_QUOTES` and no double encoding keeps it.
 * @param {string} value
 */
export function escapeText(value) {
  return value.replace(BARE_AMPERSAND, '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

/**
 * A tag, a comment, or a lone `<` or `>`: the pieces the content check reads markup in. A comment
 * left open runs to the end, as a browser reads it, so its end is looked for once.
 */
const PIECE = /(<(?=[^a-zA-Z!/])|<!--[\s\S]*?(?:-->|$)|<[^>]*(>|$)|>)/g

/**
 * Text without its tags and comments, read as the content check splits markup (`PIECE`): each
 * becomes a space, so removing one cannot join what was around it; a lone `<` or `>` stays text.
 * @param {string} html
 */
export function stripTags(html) {
  return html.replace(PIECE, (piece) => (piece.length > 1 ? ' ' : piece)).replace(/\s+/g, ' ').trim()
}

/**
 * The tags and comments in a markup text, as `stripTags` reads them, each with its `index`.
 * @param {string} html
 * @returns {Generator<RegExpMatchArray>}
 */
export function* tagsIn(html) {
  for (const piece of html.matchAll(PIECE)) if (piece[0].length > 1) yield piece
}

/** The named entities stored text holds: those `escapeText` writes, and a few an author types. */
const NAMED = /** @type {Record<string, string>} */ ({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '­', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', bull: '•', middot: '·', deg: '°', times: '×',
  copy: '©', reg: '®', trade: '™', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶', frac12: '½'
})

/**
 * Entities read, in one pass, so `&amp;lt;` is `&lt;` and not `<`: numeric ones, and the named
 * ones above. An entity it does not know is left as written.
 * @param {string} text
 */
export function decodeEntities(text) {
  return text.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]*));/g, (entity, decimal, hex, name) => {
    if (name) return Object.hasOwn(NAMED, name) ? NAMED[name] : entity
    const code = decimal ? Number(decimal) : Number.parseInt(hex, 16)
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : entity
  })
}

/**
 * The widget H5P's editor draws a field with: its `widget`, or for a ShowWhen, the widget the
 * ShowWhen draws inside it, else the field's type (h5peditor.js `getWidgetName`, H5PEditor.ShowWhen).
 * @param {any} field
 * @returns {string}
 */
export function editorWidget(field) {
  if (field.widget === 'showWhen') return field.showWhen?.widget ?? field.type
  return field.widget ?? field.type
}

/**
 * Whether a text field holds markup: rich-text widget (`html`) and listed `tags`. Others are plain,
 * escaped even with `tags`, which only tell the check what to keep.
 * @param {any} field
 */
export function takesMarkup(field) {
  return field.tags !== undefined && field.tags !== null && editorWidget(field) === 'html'
}

/**
 * The tags a field keeps, as the content check derives them: the four it always keeps, the field's
 * own and those one implies; `null` if none. Not whether an author writes markup: `takesMarkup`.
 * @param {any} field
 * @returns {Set<string> | null}
 */
export function allowedTags(field) {
  if (field.tags === undefined || field.tags === null) return null
  const tags = new Set(['div', 'span', 'p', 'br', ...(Array.isArray(field.tags) ? field.tags.filter((/** @type {unknown} */ tag) => typeof tag === 'string') : [])])
  if (tags.has('table')) for (const tag of ['tr', 'td', 'th', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'figure', 'figcaption']) tags.add(tag)
  if (tags.has('b')) tags.add('strong')
  if (tags.has('i')) tags.add('em')
  if (tags.has('ul') || tags.has('ol')) tags.add('li')
  if (tags.has('del') || tags.has('strike')) tags.add('s')
  return tags
}

/**
 * The block a line of text becomes in a markup field (h5peditor-html.js): `<p>` where the field
 * asks for paragraphs or offers headings, `pre`, `p` or `div`, else `<div>`.
 * @param {any} field
 */
export function blockTag(field) {
  const own = Array.isArray(field.tags) ? field.tags : []
  return field.enterMode === 'p' || own.some((/** @type {string} */ tag) => /^(h[1-6]|pre|p|div)$/.test(tag)) ? 'p' : 'div'
}

/** The tags a style attribute may sit on, and what it may say there, as the content check keeps them. */
const STYLEABLE = new Set(['span', 'p', 'div', 'h1', 'h2', 'h3', 'table', 'col', 'figure', 'td', 'th', 'li'])
const COLOR = '(#[a-f0-9]{3}[a-f0-9]{3}?|rgba?\\([0-9, ]+\\)|hsla?\\([0-9,.% ]+\\))'
const BORDER_STYLE = '(none|solid|dotted|dashed|double|groove|ridge|inset|outset)'

/** @param {any} field */
function stylePatterns(field) {
  const patterns = ['^text-align: *(center|left|right);?$']
  const font = field.font && typeof field.font === 'object' ? field.font : {}
  if (font.size) patterns.push('^font-size: *[0-9.]+(em|px|%) *;?$')
  if (font.family) patterns.push("^font-family: *[-a-z0-9,'&; ]+;?$")
  if (font.color) patterns.push(`^color: *${COLOR} *;?$`)
  if (font.background) patterns.push(`^background-color: *${COLOR} *;?$`)
  if (font.spacing) patterns.push('^letter-spacing: *[0-9.]+(em|px|%) *;?$')
  if (font.height) patterns.push('^line-height: *[0-9.]+(em|px|%|) *;?$')
  if (Array.isArray(field.tags) && field.tags.includes('table')) {
    patterns.push(
      `^border: *[0-9.]+(em|px|%|) *${BORDER_STYLE} *${COLOR} *;?$`, `^border-style: *${BORDER_STYLE} *;?$`,
      '^border-width: *[0-9.]+(em|px|%|) *;?$', `^border-color: *${COLOR} *;?$`, '^vertical-align: *(middle|top|bottom);?$',
      '^padding: *[0-9.]+(em|px|%|) *;?$', '^width: *[0-9.]+(em|px|%|) *;?$', '^height: *[0-9.]+(em|px|%|) *;?$',
      '^float: *(right|left|none) *;?$', '^border-collapse: *collapse *;?$', `^background-color: *${COLOR} *;?$`
    )
  }
  return patterns.map((pattern) => new RegExp(pattern, 'i'))
}

const ATTRIBUTE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g

/**
 * One attribute as a browser reads it: a name (may begin with `=`; no space, `/` or `=`), then
 * after an `=` its value: quoted whole, bare to the next space, or an unclosed quote.
 */
const ATTRIBUTE_READ = /[\s/]*=?[^\s/=]*\s*(?:=\s*(?:"[^"]*"|'[^']*'|(["'])|\S*))?/y

/**
 * Whether a tag's attributes, cut at its first `>` as the check does, leave a quoted value open, as
 * a browser reads them: a quote opens a value only after an `=` (`title=x='y` is bare).
 * @param {string} attributes
 */
function quoteLeftOpen(attributes) {
  ATTRIBUTE_READ.lastIndex = 0
  while (ATTRIBUTE_READ.lastIndex < attributes.length) {
    const read = ATTRIBUTE_READ.exec(attributes)
    if (!read?.[0]) return false
    if (read[1]) return true
  }
  return false
}
const SAFE_URL = /^(?:https?:|mailto:|ftp:|[^:]*$)/i

/**
 * Whether a value is written as markup: it has a tag. Text without one is plain, and is wrapped
 * as the editor wraps what an author types.
 * @param {string} value
 */
export function hasMarkup(value) {
  return /<[a-zA-Z!/]/.test(value)
}

/**
 * Plain text as a markup field's editor stores what an author types: escaped, in a block per
 * paragraph, a blank line between two, and a `<br>` for each other line break.
 * @param {string} value
 * @param {string} block `p` or `div`, as `blockTag` says for the field
 */
export function wrapText(value, block) {
  const paragraphs = value.trim().split(/\r?\n[ \t]*(?:\r?\n)+/).filter((paragraph) => paragraph.trim())
  return paragraphs.map((paragraph) => `<${block}>${escapeText(paragraph.trim()).replace(/\r?\n/g, '<br>')}</${block}>`).join('')
}

/**
 * Stored markup as the plain text an author would type, where `wrapText` makes exactly that markup
 * again: blocks and line breaks only, entities kept. Else `undefined`: the markup is the source.
 * @param {string} value
 * @param {string} block the field's, as `blockTag` says
 * @returns {string | undefined}
 */
export function unwrapText(value, block) {
  const blocks = value.match(new RegExp(`^(?:<${block}>[^<]*(?:<br>[^<]*)*</${block}>)+$`)) && value.split(`</${block}>`).slice(0, -1)
  if (!blocks) return undefined
  const plain = blocks.map((each) => each.slice(block.length + 2).replaceAll('<br>', '\n')).join('\n\n')
  return wrapText(plain, block) === value ? plain : undefined
}

/**
 * A markup field's value as stored. Plain text is escaped and wrapped in the field's block. Markup
 * is checked: a disallowed tag, event handler, style, script URL or comment is reported.
 * @param {string} value
 * @param {any} field
 * @param {(message: string) => void} report
 * @param {{ saved?: boolean }} [options] `saved`, a value as H5P stores it: text without markup is
 *   kept as it is, but for a lone `<` or `>`, where typed text is wrapped as the editor wraps it
 */
export function markupText(value, field, report, { saved = false } = {}) {
  const tags = allowedTags(field) ?? new Set()
  if (!hasMarkup(value) && !saved) return wrapText(value, blockTag(field))
  const styles = stylePatterns(field)
  // Each thing said once, however often the value repeats it: an opening tag and its closing one.
  const said = new Set()
  const once = (/** @type {string} */ message) => {
    if (said.has(message)) return
    said.add(message)
    report(message)
  }
  return value.replace(PIECE, (piece) => {
    if (piece === '<') return '&lt;'
    if (piece === '>') return '&gt;'
    if (piece.startsWith('<!--')) {
      once('has a comment, which H5P removes: take it out')
      return piece
    }
    const match = /^<\s*(?:(\/)\s*)?([a-zA-Z][a-zA-Z0-9]*)((?:[^>a-zA-Z0-9][^>]*)?)>$/.exec(piece)
    if (!match) {
      once(`has "${piece.slice(0, 30)}", which is not a complete tag: write &lt; for a literal <`)
      return piece
    }
    const tag = match[2].toLowerCase()
    if (!tags.has(tag)) {
      once(`has <${tag}>, which this field does not take; it takes ${[...tags].sort().map((name) => `<${name}>`).join(' ')}`)
      return piece
    }
    if (!match[1]) {
      // The slash of `<br />` is not part of the last attribute, as the content check reads it.
      const attributes = match[3].trimEnd().replace(/\/$/, '')
      // A quote the tag leaves open: a `>` inside a quoted value ended the tag here, or the quote
      // never closed. A browser reads to a later `>`, so the text between is lost (#222).
      if (quoteLeftOpen(attributes)) {
        once(`has <${tag}> with a quote it does not close: a > inside an attribute ends the tag there, so write &gt; for it`)
      }
      for (const [, name, double, single, bare] of attributes.matchAll(ATTRIBUTE)) {
        const attribute = name.toLowerCase()
        const content = double ?? single ?? bare ?? ''
        if (attribute.startsWith('on')) once(`has an event handler, ${attribute}, on <${tag}>, which H5P removes`)
        else if (attribute === 'style') {
          if (!STYLEABLE.has(tag)) once(`has a style on <${tag}>, which H5P removes; styles are kept on ${[...STYLEABLE].join(', ')}`)
          else for (const declaration of content.split(';').map((part) => part.trim()).filter(Boolean)) {
            if (!styles.some((pattern) => pattern.test(declaration))) once(`has the style "${declaration}" on <${tag}>, which this field does not allow`)
          }
        } else if ((attribute === 'href' || attribute === 'src') && !SAFE_URL.test(content.trim())) {
          once(`has ${attribute}="${content.slice(0, 40)}": only http, https, mailto and ftp addresses are kept`)
        }
      }
    }
    return piece
  })
}

/**
 * A plain text field's value as stored: escaped, as the platforms store typing. A tag in it shows
 * as written, right for a quiz on HTML and a mistake otherwise, so it is noted.
 * @param {string} value
 * @param {(message: string) => void} note
 * @param {{ filtered?: boolean }} [options] `filtered`: a plain box that lists `tags`
 */
export function plainText(value, note, { filtered = false } = {}) {
  if (/<\/?[a-zA-Z][a-zA-Z0-9]*(\s[^<>]*)?\/?>/.test(value)) note('is plain text, so its tags are shown as written, not as markup')
  if (!filtered) return escapeText(value)
  // The content check filters such a field as markup and keeps `'` as typed, which `textContent`
  // shows as written (Question Set 1.21); `"` stays escaped: the editor sets `value="…"` from it.
  if (value.search(BARE_AMPERSAND) !== -1 || /["<>]/.test(value)) {
    note('stores &, ", < and > as entities, which a content type that draws this field as plain text shows as written, as Question Set does its title and results heading: write "and", and “ ” for quotes')
  }
  return value.replace(BARE_AMPERSAND, '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}
