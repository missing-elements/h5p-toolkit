import { newId } from './generator.mjs'
import { stripTags } from './text.mjs'

/**
 * A layout: what a type needs beyond its semantics where its editor widget sets hidden fields:
 * `before`, `after`, `read`, and the dotted paths `sets`, `optional`, `decimals`.
 */

/**
 * @typedef {{
 *   report: (path: string, message: string) => void,
 *   note: (path: string, message: string) => void,
 *   semantics: any[],
 *   library: any,
 *   title: (library: string) => string
 * }} LayoutContext
 * @typedef {{
 *   before?: (written: any, path: string, context: LayoutContext) => void,
 *   after?: (params: any, path: string, context: LayoutContext) => void,
 *   read?: (written: any, path: string, context: LayoutContext) => void,
 *   sets?: string[],
 *   optional?: string[],
 *   decimals?: Record<string, number>
 * }} Layout
 */

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** The machine name in a library string, `H5P.Image` for `H5P.Image 1.1`. @param {unknown} library */
const machineName = (library) => (typeof library === 'string' ? library.trim().split(/\s+/)[0] : '')

/** Text without its tags and entities, for measuring. @param {string} html */
function textOf(html) {
  return stripTags(html).replace(/&[a-zA-Z#0-9]+;/g, '_')
}

/** A field's semantics, found by a path of names. @param {any[]} semantics @param {string[]} names */
function fieldAt(semantics, names) {
  let fields = semantics
  let field = null
  for (const name of names) {
    field = fields.find((each) => each.name === name)
    if (!field) return null
    if (field.type === 'list') fields = field.field?.type === 'group' ? field.field.fields ?? [] : [field.field]
    else fields = field.fields ?? []
  }
  return field
}

/* ---------------------------------------------------------------- Question Set */

/**
 * The title a Question Set gives a question with none: the set's label for a question, in the
 * content's language, and its number. The outline leaves it out: it is the build's.
 * @param {any[]} semantics the set's, as loaded for the content
 * @param {number} index
 */
export function questionTitle(semantics, index) {
  return `${fieldAt(semantics, ['texts', 'questionLabel'])?.default ?? 'Question'} ${index + 1}`
}

/**
 * A question with no title is named as the set labels it itself, in the content's language: its
 * result screen lists each question by this title.
 * @type {Layout}
 */
const questionSet = {
  after(params, path, context) {
    ;(params.questions ?? []).forEach((/** @type {any} */ question, /** @type {number} */ i) => {
      if (isObject(question?.metadata) && question.metadata.title === undefined) question.metadata.title = questionTitle(context.semantics, i)
    })
  },
  // Such a title is the build's, and a source read back leaves it out.
  read(written, path, context) {
    ;(written?.questions ?? []).forEach((/** @type {any} */ question, /** @type {number} */ i) => {
      if (!isObject(question?.metadata) || question.metadata.title !== questionTitle(context.semantics, i)) return
      delete question.metadata.title
      if (!Object.keys(question.metadata).length) delete question.metadata
    })
  }
}

/* ---------------------------------------------------------------- Interactive Book */

/** A chapter is a page, and the book's table of contents names it by its title. @type {Layout} */
const interactiveBook = {
  after(params, path, context) {
    ;(params.chapters ?? []).forEach((/** @type {any} */ chapter, /** @type {number} */ i) => {
      if (isObject(chapter?.metadata) && chapter.metadata.title === undefined) {
        context.report(`${path}.chapters[${i}].metadata.title`, 'is required: the chapter\'s name in the table of contents')
      }
    })
  }
}

/* ---------------------------------------------------------------- Course Presentation */

/**
 * Course Presentation's slide, 640 by 360 px; positions and sizes are percentages of it. `font`,
 * `char`, `line` measure text for Interactive Video (`textLines`): 16 px, 8.5 px a character, 1.5.
 */
const SLIDE = { width: 640, height: 360, font: 16, char: 8.5, line: 1.5 }
const MARGIN_X = 4
const MARGIN_Y = 5
const GAP = 2

/**
 * Text as Course Presentation 1.27 draws it on that slide, from its stylesheet and Advanced Text's
 * (#145). Measured at 16 px in lines of 1.5, a text box came out about twice as tall as its text.
 */
const SLIDE_TEXT = {
  p: { em: 0.9, size: 10.8, line: 1.25, after: 1, sized: true },
  h2: { em: 1.667, size: 20, line: 1.5, after: 0.5, sized: true },
  h3: { em: 1.333, size: 16, line: 1.5, after: 0.5, sized: true },
  li: { em: 1, size: 12, line: 1.25, after: 1, sized: true },
  pre: { em: 1, size: 12, line: 1.25, after: 1, sized: false }
}
/** A list's room above and below it, in px: 1em of the element's 12 px each way. */
const LIST_MARGIN = 24
/** About how wide a character is, as a part of the font's size, in H5P's sans. */
const CHARACTER = 0.53
/** Larger text, tried largest first, on a slide with room for it (#145). */
const TEXT_STEPS = [2, 1.75, 1.5, 1.25]

/**
 * How much of the slide's height markup takes, in percent, in a box `pixels` wide with each sized
 * block `step` times as large: its lines and the room after each block, a little to spare.
 * @param {string} html
 * @param {number} pixels
 * @param {number} [step]
 */
function slideTextHeight(html, pixels, step = 1) {
  /** @type {Array<{ tag: keyof typeof SLIDE_TEXT, inner: string }>} */
  const blocks = [...html.matchAll(/<(p|h2|h3|li|pre)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((match) => ({
    tag: /** @type {keyof typeof SLIDE_TEXT} */ (match[1].toLowerCase()),
    inner: match[2]
  }))
  if (!blocks.length && textOf(html)) blocks.push({ tag: 'p', inner: html })
  let height = (html.match(/<(?:ul|ol)\b/gi) ?? []).length * LIST_MARGIN
  for (const { tag, inner } of blocks) {
    const metric = SLIDE_TEXT[tag]
    const size = metric.size * (metric.sized ? step : 1)
    const perLine = Math.max(8, Math.floor(pixels / (size * CHARACTER)))
    const lines = inner.split(/<br\s*\/?>/i).reduce((sum, piece) => sum + Math.max(1, Math.ceil(textOf(piece).length / perLine)), 0)
    height += lines * size * metric.line + size * metric.after
  }
  return Math.min(95, (height / SLIDE.height) * 100 + 2)
}

/**
 * Markup with each sized block `step` times as large, by a `font-size` in em on the block, as a
 * span would inherit the line height as a length and overlap. Written as the check writes it.
 * @param {string} html
 * @param {number} step
 */
function sizedText(html, step) {
  const blocks = /<(?:p|h2|h3|li|pre)\b/i.test(html) ? html : `<p>${html}</p>`
  return blocks.replace(/<(p|h2|h3|li)\b([^>]*)>/gi, (_, /** @type {string} */ tag, /** @type {string} */ attributes) => {
    const style = /\sstyle\s*=\s*(["'])([\s\S]*?)\1/i.exec(attributes)
    const declarations = (style?.[2] ?? '').split(';').map((each) => each.trim()).filter(Boolean)
    declarations.push(`font-size:${round(SLIDE_TEXT[/** @type {'p' | 'h2' | 'h3' | 'li'} */ (tag.toLowerCase())].em * step)}em`)
    const rank = (/** @type {string} */ declaration) => {
      const at = STYLE_ORDER.indexOf(declaration.slice(0, declaration.indexOf(':')).trim().toLowerCase())
      return at < 0 ? STYLE_ORDER.length : at
    }
    const value = `style="${declarations.sort((a, b) => rank(a) - rank(b)).join(';')};"`
    return style ? `<${tag}${attributes.replace(style[0], ` ${value}`)}>` : `<${tag}${attributes} ${value}>`
  })
}

/** The order the content check writes a kept style's declarations in, its patterns' (`stylePatterns`). */
const STYLE_ORDER = ['text-align', 'font-size', 'font-family', 'color', 'background-color', 'letter-spacing', 'line-height']

/**
 * How many lines markup takes at 16 px in a width, about 8.5 px a character, headings at their
 * size. Interactive Video's measure; Course Presentation's is `slideTextHeight`.
 * @param {string} html
 * @param {number} pixels
 */
function textLines(html, pixels) {
  let lines = 0
  const blocks = html.split(/<\/(?:p|div|li|h[1-6]|pre)>|<br\s*\/?>/i).filter((block) => textOf(block))
  for (const block of blocks.length ? blocks : [html]) {
    const scale = /<h[1-3]/i.test(block) ? 1.5 : 1
    const perLine = Math.max(8, Math.floor(pixels / (SLIDE.char * scale)))
    lines += Math.max(1, Math.ceil(textOf(block).length / perLine)) * scale + 0.4
  }
  return lines
}

/**
 * How much of a slide's height an element wants at a width: text by its lines, an image or a
 * video by its shape, anything interactive whatever is left.
 * @param {any} element
 * @param {number} width percent of the slide's width
 * @returns {{ height: number, flexible: boolean, min: number }}
 */
function wanted(element, width) {
  const library = machineName(element?.action?.library)
  const params = element?.action?.params ?? {}
  const pixels = (width / 100) * SLIDE.width
  if (library === 'H5P.AdvancedText') return { height: slideTextHeight(String(params.text ?? ''), pixels), flexible: false, min: 8 }
  if (library === 'H5P.Image') {
    const file = params.file ?? {}
    const ratio = file.width && file.height ? file.height / file.width : 9 / 16
    return { height: width * (SLIDE.width / SLIDE.height) * ratio, flexible: false, min: 15 }
  }
  if (library === 'H5P.Video') return { height: width, flexible: false, min: 20 }
  if (library === 'H5P.Link') return { height: 9, flexible: false, min: 6 }
  if (library === 'H5P.Audio') return { height: 10, flexible: false, min: 8 }
  return { height: 0, flexible: true, min: element?.displayAsButton ? 12 : 40 }
}

/**
 * On a slide with room left and no question to take it, text set larger, the largest that fits with
 * every picture at full size (#145): Course Presentation draws text small. Only text nobody sized.
 * @param {any[]} free the elements being stacked
 * @param {Array<{ kind: string, height: number, min: number }>} kinds what each wants, in the same order
 * @param {number} spare percent of the slide's height left over
 * @param {number} width percent of the slide's width each takes
 */
function growText(free, kinds, spare, width) {
  const texts = free.flatMap((element, i) =>
    kinds[i].kind === 'fixed' && machineName(element?.action?.library) === 'H5P.AdvancedText' &&
    typeof element.action.params?.text === 'string' && !/font-size/i.test(element.action.params.text) ? [i] : [])
  if (!texts.length || spare <= 0) return
  const pixels = (width / 100) * SLIDE.width
  for (const step of TEXT_STEPS) {
    const heights = texts.map((i) => slideTextHeight(free[i].action.params.text, pixels, step))
    if (heights.reduce((sum, height, n) => sum + height - kinds[texts[n]].height, 0) > spare) continue
    texts.forEach((i, n) => {
      kinds[i].height = kinds[i].min = heights[n]
      free[i].action.params.text = sizedText(free[i].action.params.text, step)
    })
    return
  }
}

/**
 * Elements without a position are stacked down the slide, full width, below any placed by hand:
 * text takes its lines' height, pictures and videos shrink for a question, which takes the rest.
 * @param {any[]} elements
 * @param {string} path
 * @param {LayoutContext} context
 */
function stackSlide(elements, path, context) {
  const free = elements.filter((element) => typeof element?.x !== 'number' || typeof element?.y !== 'number')
  if (!free.length) return
  const placed = elements.filter((element) => !free.includes(element))
  const top = placed.length ? Math.max(...placed.map((element) => element.y + (element.height ?? 10))) + GAP : MARGIN_Y
  const width = 100 - 2 * MARGIN_X
  const kinds = free.map((element) => {
    if (element.displayAsButton) return { kind: 'button', height: 12, min: 12 }
    const library = machineName(element?.action?.library)
    const want = wanted(element, width)
    if (want.flexible) return { kind: 'flexible', height: 0, min: want.min }
    if (library === 'H5P.Image' || library === 'H5P.Video') return { kind: 'picture', height: want.height, min: Math.min(want.height, want.min) }
    return { kind: 'fixed', height: want.height, min: want.height }
  })
  const room = 100 - MARGIN_Y - top - GAP * (free.length - 1)
  const fixedHeight = () => kinds.filter((each) => each.kind === 'fixed' || each.kind === 'button').reduce((sum, each) => sum + each.height, 0)
  const flexible = kinds.filter((each) => each.kind === 'flexible')
  const pictures = kinds.filter((each) => each.kind === 'picture')
  const needed = fixedHeight() + flexible.reduce((sum, each) => sum + each.min, 0) + pictures.reduce((sum, each) => sum + each.min, 0)
  if (needed > room + 0.5) {
    context.note(path, flexible.length
      ? 'likely holds more than fits on one slide: split it, or show the question as a button ("displayAsButton": true)'
      : 'likely holds more than fits on one slide: split it')
  }
  if (!flexible.length) growText(free, kinds, room - fixedHeight() - pictures.reduce((sum, each) => sum + each.height, 0), width)
  const fixed = fixedHeight()
  let rest = Math.max(0, room - fixed)
  // Pictures first get what they want, up to an equal share of what is left after the questions' minimum.
  const forPictures = Math.max(0, rest - flexible.reduce((sum, each) => sum + each.min, 0))
  for (const picture of pictures) picture.height = Math.max(picture.min, Math.min(picture.height, forPictures / pictures.length))
  rest -= pictures.reduce((sum, each) => sum + each.height, 0)
  for (const each of flexible) each.height = Math.max(each.min, rest / flexible.length)
  const scale = needed > room ? room / Math.max(1, kinds.reduce((sum, each) => sum + each.height, 0)) : 1
  let y = top
  free.forEach((element, i) => {
    const each = kinds[i]
    const height = Math.max(3, each.height * scale)
    let w = width
    let x = MARGIN_X
    if (each.kind === 'picture') {
      // A picture keeps its shape: narrower, centred, rather than squeezed.
      const full = wanted(element, width).height
      if (height < full) {
        w = width * (height / full)
        x = (100 - w) / 2
      }
    }
    if (each.kind === 'button') w = 10
    Object.assign(element, { x: round(x), y: round(y), width: round(w), height: round(height) })
    y += height + GAP
  })
}

/** @param {number} value */
function round(value) {
  return Math.round(value * 100) / 100
}

/** @type {Layout} */
const coursePresentation = {
  sets: ['presentation.slides[].elements[].x', 'presentation.slides[].elements[].y', 'presentation.slides[].elements[].width', 'presentation.slides[].elements[].height', 'presentation.ct'],
  after(params, path, context) {
    const slides = params?.presentation?.slides
    if (!Array.isArray(slides) || !slides.length) {
      context.report(`${path}.presentation.slides`, 'is required: write at least 1 slide')
      return
    }
    slides.forEach((/** @type {any} */ slide, /** @type {number} */ i) => {
      if (Array.isArray(slide?.elements)) stackSlide(slide.elements, `${path}.presentation.slides[${i}]`, context)
    })
  }
}

/* ---------------------------------------------------------------- Interactive Video */

// Follows H5PEditor.InteractiveVideo 1.26.3, h5p/h5p-editor-interactive-video at
// 205abc173eece12046c4dedbe883ea5835e49151.
/**
 * The video Interactive Video draws interactions over, in the units of their fields: `x`, `y` in
 * percent of the video, `width`, `height` in em at 16 px to a 640 px video (16:9 is 40 by 22.5 em).
 */
const FRAME = { width: 40, height: 22.5 }

/** The room a button takes, in percent of the video, with some around it. */
const BUTTON = { width: 12, height: 12 }

/**
 * A poster's size where none is written: 10 by 10 em as in the editor, a picture its own shape; a
 * question room for its answers and Check button (10 by 10 hid it), a text enough width.
 * @param {any} interaction
 * @returns {{ width: number, height: number }}
 */
function posterSize(interaction) {
  const library = machineName(interaction?.action?.library)
  const params = interaction?.action?.params ?? {}
  if (library === 'H5P.Image') {
    const file = params.file ?? {}
    if (!(file.width > 0 && file.height > 0)) return { width: 10, height: 10 }
    // As the editor's setImageSize: no taller than the picture at 16 px an em, nor under one em.
    // And, which it does not check, no wider than the video less 2 em each side.
    const [width, height] = [Math.max(16, file.width), Math.max(16, file.height)]
    const tall = Math.min(10, height / 16)
    const wide = Math.min(FRAME.width - 4, tall * (width / height))
    return { width: round(wide), height: round(wide * (height / width)) }
  }
  if (library === 'H5P.Text') {
    for (const width of [12, 16, 20, 24]) {
      // Its lines, and an em of padding all round.
      const height = textLines(String(params.text ?? ''), (width - 2) * SLIDE.font) * SLIDE.line + 2
      if (height <= 12 || width === 24) return { width, height: round(Math.min(FRAME.height - 2, height)) }
    }
  }
  if (['H5P.Link', 'H5P.Nil', 'H5P.IVHotspot'].includes(library)) return { width: 10, height: 10 }
  // Two side by side, with a gap, within the margins.
  return { width: 17, height: 16 }
}

/**
 * Where a box nobody placed goes: down the left of the video, then the next column, a gap clear
 * of every box shown at the same time; `null` when the video has no room left.
 * @param {{ width: number, height: number }} box in percent of the video
 * @param {{ from: number, to: number }} time
 * @param {{ from: number, to: number, x: number, y: number, width: number, height: number }[]} shown
 */
function freeSpot(box, time, shown) {
  const together = shown.filter((other) => !(time.to < other.from || time.from > other.to))
  const clear = (/** @type {number} */ x, /** @type {number} */ y) => together.every((other) =>
    x + box.width + GAP <= other.x || other.x + other.width + GAP <= x || y + box.height + GAP <= other.y || other.y + other.height + GAP <= y)
  for (let x = 5; x === 5 || x + box.width <= 95; x += 5) {
    for (let y = 5; y === 5 || y + box.height <= 95; y += 5) if (clear(x, y)) return { x, y }
  }
  return null
}

/** @type {Layout} */
const interactiveVideo = {
  sets: [
    'interactiveVideo.assets.interactions[].x', 'interactiveVideo.assets.interactions[].y',
    'interactiveVideo.assets.interactions[].width', 'interactiveVideo.assets.interactions[].height',
    'interactiveVideo.assets.interactions[].libraryTitle'
  ],
  after(params, path, context) {
    const interactions = params?.interactiveVideo?.assets?.interactions
    if (!Array.isArray(interactions)) return
    /** @type {{ from: number, to: number, x: number, y: number, width: number, height: number }[]} */
    const shown = []
    interactions.forEach((/** @type {any} */ interaction, /** @type {number} */ i) => {
      if (!isObject(interaction)) return
      const at = `${path}.interactiveVideo.assets.interactions[${i}]`
      const from = typeof interaction.duration?.from === 'number' ? interaction.duration.from : 0
      const to = typeof interaction.duration?.to === 'number' ? interaction.duration.to : 0
      if (to < from) context.report(`${at}.duration`, `ends at ${to} s, before it starts at ${from} s`)
      if (interaction.action?.metadata && interaction.libraryTitle === undefined) interaction.libraryTitle = context.title(interaction.action.library)
      const poster = interaction.displayType === 'poster'
      if (poster) {
        const size = posterSize(interaction)
        if (typeof interaction.width !== 'number') interaction.width = size.width
        if (typeof interaction.height !== 'number') interaction.height = size.height
      }
      const box = poster ? { width: (interaction.width / FRAME.width) * 100, height: (interaction.height / FRAME.height) * 100 } : BUTTON
      if (typeof interaction.x !== 'number' || typeof interaction.y !== 'number') {
        const spot = freeSpot(box, { from, to }, shown)
        if (!spot) context.note(at, 'shows while the video has no room left for it, so it is placed over another: give it x and y, or show it at another time')
        Object.assign(interaction, spot ?? { x: 5, y: 5 })
      }
      shown.push({ from, to, x: interaction.x, y: interaction.y, ...box })
    })
  }
}

/**
 * An Interactive Video's times held to its video's length: the library moves an interaction ending
 * past the last whole second to end there (`loaded()`, #285), so it is refused.
 * @param {any} params an Interactive Video's, as H5P stores them
 * @param {string} path where they are
 * @param {(file: string) => import('./media.mjs').MediaLength | undefined} lengthOf a video's length, by its path in the package or the address it stays at
 * @param {(path: string, message: string) => void} report
 * @returns {import('./media.mjs').MediaLength | undefined} the length the times were held to
 */
export function videoTimes(params, path, lengthOf, report) {
  const files = params?.interactiveVideo?.video?.files
  const known = (Array.isArray(files) ? files : []).map((file) => (typeof file?.path === 'string' ? lengthOf(file.path) : undefined)).find((each) => each !== undefined)
  if (known === undefined) return undefined
  const { seconds: length, host } = known
  const end = host ? `the video ends at about ${Math.round(length * 100) / 100} s, as ${host} says` : `the video ends at ${Math.round(length * 100) / 100} s`
  const late = (/** @type {unknown} */ time) => typeof time === 'number' && time > length + (host ? 1 : 0)
  const list = (/** @type {unknown} */ value) => (Array.isArray(value) ? value : [])
  const assets = params.interactiveVideo.assets
  // The library counts a file's whole seconds; a host's length is whole seconds already.
  const last = host ? length : Math.floor(length)
  list(assets?.interactions).forEach((interaction, i) => {
    const moved = movedInteraction(interaction?.duration, last)
    if (moved) report(`${path}.interactiveVideo.assets.interactions[${i}].duration`, `runs from ${interaction.duration.from} to ${interaction.duration.to} s, and ${end}: Interactive Video plays it from ${moved.from} to ${moved.to} s instead, so end it by ${last} s`)
  })
  for (const key of ['bookmarks', 'endscreens']) {
    list(assets?.[key]).forEach((mark, i) => {
      if (late(mark?.time)) report(`${path}.interactiveVideo.assets.${key}[${i}].time`, `is ${mark.time} s, after ${end}`)
    })
  }
  if (late(params.override?.startVideoAt)) report(`${path}.override.startVideoAt`, `is ${params.override.startVideoAt} s, after ${end}`)
  return known
}

/**
 * Where H5P.InteractiveVideo 1.28 plays an interaction ending past the last whole second: moved to
 * end there, as long as written, its start clamped at 0; `undefined` if left, or not a start before an end.
 * @param {unknown} duration an interaction's `duration`, `{ from, to }` in seconds
 * @param {number} last the video's last whole second, as the library counts it
 * @returns {{ from: number, to: number } | undefined}
 */
export function movedInteraction(duration, last) {
  const { from, to } = /** @type {{ from?: unknown, to?: unknown }} */ (duration ?? {})
  if (typeof from !== 'number' || typeof to !== 'number' || from > to || to <= last) return undefined
  return { from: Math.max(0, Math.round((last - (to - from)) * 100) / 100), to: last }
}

/**
 * What a note says of things placed on a picture or a map, one or several.
 * @param {string} on what they are placed on
 * @returns {(one: boolean) => string}
 */
const placedOn = (on) => (one) => `placed by numbers, which a build cannot hold to the ${on}: look at ${one ? 'it' : 'each'} in the preview`

/**
 * What a source puts on a picture or a video by numbers alone (#260): places and times. A build
 * cannot hold them to what is shown, so it notes each list once, for the preview.
 * @type {Record<string, { at: string, what: [one: string, many: string], on: (one: boolean) => string, when?: (params: any) => boolean }>}
 */
const BY_NUMBER = {
  // Its zones mean something only against a background picture (#295).
  'H5P.DragQuestion': { at: 'question.task.dropZones', what: ['drop zone', 'drop zones'], on: placedOn('picture'), when: (params) => Boolean(params?.question?.settings?.background) },
  'H5P.ImageHotspots': { at: 'hotspots', what: ['hotspot', 'hotspots'], on: placedOn('picture') },
  'H5P.ImageHotspotQuestion': { at: 'imageHotspotQuestion.hotspotSettings.hotspot', what: ['area', 'areas'], on: placedOn('picture') },
  'H5P.ImageMultipleHotspotQuestion': { at: 'imageMultipleHotspotQuestion.hotspotSettings.hotspot', what: ['area', 'areas'], on: placedOn('picture') },
  'H5P.GameMap': { at: 'gamemapSteps.gamemap.elements', what: ['stage', 'stages'], on: placedOn('map') },
  'H5P.InteractiveVideo': { at: 'interactiveVideo.assets.interactions', what: ['interaction', 'interactions'], on: () => 'shown at the times written, which a build cannot hold to what the video shows then: play it through in the preview' }
}

/**
 * The note for what a library's content places or times by numbers alone, or none.
 * @param {string} library its machine name
 * @param {any} params its content, as H5P stores it
 * @returns {{ at: string, message: string } | undefined}
 */
export function byNumber(library, params) {
  const rule = Object.hasOwn(BY_NUMBER, library) ? BY_NUMBER[library] : undefined
  if (!rule || (rule.when && !rule.when(params))) return undefined
  const list = rule.at.split('.').reduce((value, key) => (isObject(value) ? value[key] : undefined), params)
  if (!Array.isArray(list) || !list.length) return undefined
  return { at: rule.at, message: `holds ${list.length} ${rule.what[list.length === 1 ? 0 : 1]} ${rule.on(list.length === 1)}` }
}

/* ---------------------------------------------------------------- Branching Scenario */

// Follows H5PEditor.BranchingScenario 1.5.13, h5p/h5p-editor-branching-scenario at
// 8fcd92d0a5a5f6b855d9d03ce4d19ab31baa4b99.
/**
 * The scenario as a graph: each node goes to the node `nextContentId` names, a negative id ends it;
 * all must be reachable and every path reach an end. No next is a problem, not an end.
 * @type {Layout}
 */
const branchingScenario = {
  sets: ['branchingScenario.endScreens[].contentId'],
  after(params, path, context) {
    const scenario = params?.branchingScenario
    const content = scenario?.content
    if (!Array.isArray(content)) return
    const at = `${path}.branchingScenario`
    const endScreens = Array.isArray(scenario.endScreens) ? scenario.endScreens : []
    endScreens.forEach((/** @type {any} */ screen, /** @type {number} */ i) => {
      if (typeof screen.contentId !== 'number') screen.contentId = -(i + 1)
    })
    const ends = new Set([-1, ...endScreens.map((/** @type {any} */ screen) => screen.contentId)])
    /** @type {number[][]} */
    const next = content.map((/** @type {any} */ node, /** @type {number} */ i) => {
      const nodeAt = `${at}.content[${i}]`
      if (machineName(node?.type?.library) === 'H5P.BranchingQuestion') {
        // A question goes where its alternatives say. Its own next, which the editor deletes from a
        // question, is -1 here: the field is hidden and required, and would be reported unset.
        if (node.nextContentId === undefined) node.nextContentId = -1
        const alternatives = node?.type?.params?.branchingQuestion?.alternatives ?? []
        // Without alternatives it goes nowhere, which the list's own size reports: taken as an
        // end, so that it is not reported again as a loop, which it is not (#172).
        if (!alternatives.length) return [-1]
        return alternatives.map((/** @type {any} */ alternative, /** @type {number} */ j) => check(alternative?.nextContentId, `${nodeAt}.type.params.branchingQuestion.alternatives[${j}].nextContentId`))
      }
      if (node?.nextContentId === undefined) {
        context.report(`${nodeAt}.nextContentId`, `is required: the index in content of the node that follows, or -1 to end the scenario here`)
        // Taken as an end, so that the one missing link is not reported again as a loop.
        return [-1]
      }
      return [check(node.nextContentId, `${nodeAt}.nextContentId`)]
    })
    /** @param {unknown} id @param {string} where */
    function check(id, where) {
      if (typeof id !== 'number' || !Number.isInteger(id)) {
        context.report(where, 'expected the index of a node in content, or -1 to end')
        return -1
      }
      if (id >= content.length) context.report(where, `is ${id}, but content has ${content.length} node${content.length === 1 ? '' : 's'}, 0 to ${content.length - 1}`)
      else if (id < 0 && !ends.has(id)) context.report(where, `is ${id}, but no end screen has that contentId; -1 is the default end`)
      return id
    }
    // Reachable from the first node, and able to reach an end from every node reached.
    const reached = new Set([0])
    const queue = [0]
    while (queue.length) {
      const node = /** @type {number} */ (queue.shift())
      for (const target of next[node] ?? []) if (target >= 0 && target < content.length && !reached.has(target)) {
        reached.add(target)
        queue.push(target)
      }
    }
    content.forEach((/** @type {unknown} */ _, /** @type {number} */ i) => {
      if (!reached.has(i)) context.note(`${at}.content[${i}]`, 'is not reached from the first node, so no learner sees it')
    })
    const ending = new Set()
    let changed = true
    while (changed) {
      changed = false
      next.forEach((targets, i) => {
        if (!ending.has(i) && targets.some((target) => target < 0 || ending.has(target))) {
          ending.add(i)
          changed = true
        }
      })
    }
    for (const node of reached) if (!ending.has(node)) context.report(`${at}.content[${node}]`, 'leads only into a loop: no path from it reaches an end, so a learner there cannot finish')
  }
}

/* ---------------------------------------------------------------- Game Map */

// Follows H5PEditor.GameMap 1.2.5, otacke/h5p-editor-game-map at
// a1ad6b04abb00ef0c1fda5bd446e4f95b8434873.
/**
 * Stages on a map as the editor's widget keeps them: `telemetry` in percent as text, `neighbors`
 * both ways, a UUID and `type` (hidden, required: it would be reported unset).
 * @type {Layout}
 */
const gameMap = {
  sets: [
    'gamemapSteps.gamemap.elements[].id', 'gamemapSteps.gamemap.elements[].type',
    'gamemapSteps.gamemap.paths[].from', 'gamemapSteps.gamemap.paths[].to', 'gamemapSteps.gamemap.dummy',
    'gamemapSteps.gamemap.elements[].accessRestrictions.dummy', 'gamemapSteps.gamemap.elements[].contentsList[].dummy', 'visual.misc.dummy'
  ],
  optional: [
    'gamemapSteps.gamemap.elements[].specialStageType', 'gamemapSteps.gamemap.elements[].specialStageLinkURL',
    'gamemapSteps.gamemap.elements[].contentsList', 'gamemapSteps.gamemap.elements[].neighbors'
  ],
  before(written, path, context) {
    const elements = written?.gamemapSteps?.gamemap?.elements
    if (!Array.isArray(elements)) return
    const labels = elements.map((/** @type {any} */ element) => (typeof element?.label === 'string' ? element.label.trim() : ''))
    elements.forEach((/** @type {any} */ element, /** @type {number} */ i) => {
      if (!isObject(element)) return
      const at = `${path}.gamemapSteps.gamemap.elements[${i}]`
      // Positions are kept as text; a source writes numbers, percent of the map from the top left,
      // or leaves a stage to a grid.
      const telemetry = isObject(element.telemetry) ? element.telemetry : {}
      const columns = Math.ceil(Math.sqrt(elements.length))
      const position = {
        x: telemetry.x ?? 10 + (i % columns) * (80 / Math.max(1, columns - 1 || 1)),
        y: telemetry.y ?? 15 + Math.floor(i / columns) * (65 / Math.max(1, Math.ceil(elements.length / columns) - 1 || 1)),
        width: telemetry.width ?? 6,
        height: telemetry.height ?? 10
      }
      element.telemetry = Object.fromEntries(Object.entries(position).map(([key, value]) => [key, typeof value === 'number' ? String(Math.round(value * 100) / 100) : value]))
      // A neighbour by label is stored as its index; one no label names stays as written, for the
      // check of the stored form not to report again.
      if (element.neighbors !== undefined && !Array.isArray(element.neighbors)) {
        context.report(`${at}.neighbors`, 'expected a list of stages, by label or index')
        element.neighbors = []
      } else if (Array.isArray(element.neighbors)) {
        element.neighbors = element.neighbors.map((/** @type {unknown} */ neighbor, /** @type {number} */ j) => {
          if (typeof neighbor === 'number') return String(neighbor)
          const index = labels.indexOf(String(neighbor).trim())
          if (index >= 0 && index !== i) return String(index)
          context.report(`${at}.neighbors[${j}]`, `${JSON.stringify(neighbor)} names no other stage; the stages are ${labels.map((label) => JSON.stringify(label)).join(', ')}`)
          return neighbor
        })
      }
    })
  },
  after(params, path, context) {
    const gamemap = params?.gamemapSteps?.gamemap
    const elements = gamemap?.elements
    if (!Array.isArray(elements)) return
    if (!elements.some((/** @type {any} */ element) => element?.canBeStartStage)) context.report(`${path}.gamemapSteps.gamemap.elements`, 'has no stage a learner can start at: set "canBeStartStage": true on one')
    const labels = elements.map((/** @type {any} */ element) => (typeof element?.label === 'string' ? element.label.trim() : ''))
    elements.forEach((/** @type {any} */ element, /** @type {number} */ i) => {
      const at = `${path}.gamemapSteps.gamemap.elements[${i}]`
      for (const key of ['x', 'y', 'width', 'height']) {
        const value = element.telemetry?.[key]
        if (value !== undefined && !(typeof value === 'string' && value.trim() !== '' && Number(value) >= 0 && Number(value) <= 100)) context.report(`${at}.telemetry.${key}`, 'expected a number from 0 to 100, percent of the map')
      }
      if (element.id === undefined) element.id = newId()
      if (element.type === undefined) element.type = element.specialStageType ? 'special-stage' : 'stage'
      if (!Array.isArray(element.neighbors)) element.neighbors = []
      element.neighbors.forEach((/** @type {unknown} */ neighbor, /** @type {number} */ j) => {
        if (!(typeof neighbor === 'string' && /^\d+$/.test(neighbor) && Number(neighbor) < elements.length && Number(neighbor) !== i)) {
          context.report(`${at}.neighbors[${j}]`, `${JSON.stringify(neighbor)} names no other stage; the stages are ${labels.map((/** @type {string} */ label) => JSON.stringify(label)).join(', ')}, by their index from 0`)
        }
      })
      if (element.type === 'stage' && !(Array.isArray(element.contentsList) && element.contentsList.length)) context.report(`${at}.contentsList`, 'is required for a stage: write at least 1 content')
      if (element.specialStageType === 'link' && !element.specialStageLinkURL) context.report(`${at}.specialStageLinkURL`, 'is required for a link stage')
    })
    // A connection goes both ways, as the editor draws it.
    elements.forEach((/** @type {any} */ element, /** @type {number} */ i) => {
      for (const neighbor of element.neighbors) {
        const other = elements[Number(neighbor)]
        if (Number(neighbor) === i || !isObject(other) || !Array.isArray(other.neighbors)) continue
        if (!other.neighbors.includes(String(i))) other.neighbors.push(String(i))
      }
    })
    elements.forEach((/** @type {any} */ element, /** @type {number} */ i) => {
      if (!element.neighbors.length && elements.length > 1) context.note(`${path}.gamemapSteps.gamemap.elements[${i}]`, 'is joined to no other stage')
    })
    if (gamemap.paths === undefined) gamemap.paths = []
  },
  // A neighbour is stored as its index in text, which `before` would look for among the labels: a
  // source read back writes the number.
  read(written) {
    for (const element of written?.gamemapSteps?.gamemap?.elements ?? []) {
      if (!Array.isArray(element?.neighbors)) continue
      element.neighbors = element.neighbors.map((/** @type {unknown} */ neighbor) => (typeof neighbor === 'string' && /^\d+$/.test(neighbor) ? Number(neighbor) : neighbor))
    }
  }
}

/* ---------------------------------------------------------------- Find the Hotspot */

/**
 * The areas a learner can click, each a rectangle or a circle inside the picture, and one of them
 * at least the right one, or no click can score.
 * @type {Layout}
 */
const imageHotspotQuestion = {
  after(params, path, context) {
    const settings = params?.imageHotspotQuestion?.hotspotSettings
    const hotspots = settings?.hotspot
    const at = `${path}.imageHotspotQuestion.hotspotSettings.hotspot`
    if (!Array.isArray(hotspots) || !hotspots.length) {
      context.report(at, 'is required: write at least 1 area, one of them correct')
      return
    }
    hotspots.forEach((/** @type {any} */ hotspot, /** @type {number} */ i) => {
      const area = hotspot?.computedSettings ?? {}
      for (const key of ['x', 'y', 'width', 'height']) {
        if (typeof area[key] !== 'number' || area[key] < 0 || area[key] > 100) context.report(`${at}[${i}].computedSettings.${key}`, 'is required: a number from 0 to 100, percent of the picture')
      }
      if (area.figure !== 'rectangle' && area.figure !== 'circle') context.report(`${at}[${i}].computedSettings.figure`, 'is required: "rectangle" or "circle"')
    })
    if (!hotspots.some((/** @type {any} */ hotspot) => hotspot?.userSettings?.correct)) context.report(at, 'has no correct area: set "correct": true in one area\'s userSettings')
  }
}

/* ---------------------------------------------------------------- Drag and Drop */

// Measured in H5P.DragQuestion 1.15's player (#295), in the task's em, 16 px to `size.width`: what
// a draggable's handle and padding add to the size written, and a line of its text.
const DRAGGABLE_EDGE = { width: 1.6, height: 0.8 }
const DQ_LINE = 1.25
/** The editor's new text box, H5PEditor.DragQuestion 1.10's, and the room around boxes. */
const DQ_BOX = { width: 5, height: 2.25 }
const DQ_MARGIN = 0.5
const DQ_GAP = 1

/**
 * A line's width in em at 1 em, by the widths measured per character in the player (#295):
 * within 4 % on words, wider on runs of narrow letters.
 * @param {string} text
 */
function emWidth(text) {
  let width = 0
  for (const c of text) width += c === ' ' ? 0.3 : /[mwMW]/.test(c) ? 0.9 : /[ijlft.,;:!|'I1]/.test(c) ? 0.3 : c === 'r' ? 0.4 : /[A-Z]/.test(c) ? 0.72 : 0.58
  return width
}

/** A text's lines, a block or a break ending one. @param {unknown} html */
function linesOf(html) {
  if (typeof html !== 'string') return []
  return html.split(/<\/(?:p|li|h\d|div)>|<br\s*\/?>/i).map((line) => textOf(line).replace(/\s+/g, ' ').trim()).filter(Boolean)
}

/**
 * A draggable's size where none is written, in em: a picture 6 across in its shape, a text as
 * wide as its longest line up to `most`, as tall as its lines wrap to.
 * @param {any} element
 * @param {number} most
 */
function draggableSize(element, most) {
  if (machineName(element?.type?.library) === 'H5P.Image') {
    const file = element.type.params?.file
    const shape = file?.width > 0 && file?.height > 0 ? file.height / file.width : 1
    return shape > 1 ? { width: round(6 / shape), height: 6 } : { width: 6, height: round(6 * shape) }
  }
  const lines = linesOf(element?.type?.params?.text)
  const width = Math.max(DQ_BOX.width, Math.min(most, Math.max(0, ...lines.map(emWidth)) + 0.5))
  // A line that wraps can take one more than its width says, so it is counted a tenth wider.
  const count = lines.reduce((sum, line) => sum + (emWidth(line) + 0.5 <= width ? 1 : Math.ceil((emWidth(line) * 1.1 + 0.5) / width)), 0) || 1
  return { width: round(width), height: round(Math.max(DQ_BOX.height, count * DQ_LINE + 0.5)) }
}

/**
 * Boxes in rows across the task, each row centred, from `top`: their places and the last row's
 * bottom, in em. The rows take as many each as they can share evenly, 3 and 2 rather than 4 and 1.
 * @internal
 * @param {{ width: number, height: number }[]} boxes outer sizes
 * @param {number} across the task's width
 * @param {number} top
 */
export function inRows(boxes, across, top) {
  const room = across - 2 * DQ_MARGIN
  /** The boxes' indices in rows, in order, at most `cap` to a row. @param {number} cap */
  const pack = (cap) => {
    /** @type {number[][]} */
    const rows = []
    let used = Infinity
    boxes.forEach((box, i) => {
      const row = rows.at(-1)
      if (row && row.length < cap && used + DQ_GAP + box.width <= room) {
        row.push(i)
        used += DQ_GAP + box.width
      } else {
        rows.push([i])
        used = box.width
      }
    })
    return rows
  }
  const greedy = pack(Infinity)
  // Shared evenly only where that takes no more rows, as it can with boxes of other widths.
  const even = pack(Math.ceil(boxes.length / Math.max(1, greedy.length)))
  /** @type {{ x: number, y: number }[]} */
  const places = []
  let y = top
  for (const row of even.length === greedy.length ? even : greedy) {
    let x = Math.max(DQ_MARGIN, (across - row.reduce((sum, j) => sum + boxes[j].width, 0) - DQ_GAP * (row.length - 1)) / 2)
    for (const j of row) {
      places[j] = { x, y }
      x += boxes[j].width + DQ_GAP
    }
    y += Math.max(...row.map((j) => boxes[j].height)) + DQ_GAP
  }
  return { places, bottom: boxes.length ? y - DQ_GAP : top }
}

/**
 * The editor sets every box's place and size in a picture of the task (#295): `x`, `y` in percent
 * of it, `width`, `height` in em. Boxes with no place are laid out, words above and zones below.
 * @type {Layout}
 */
const dragQuestion = {
  sets: ['elements', 'dropZones'].flatMap((list) => ['x', 'y', 'width', 'height'].map((key) => `question.task.${list}[].${key}`)),
  // A zone laid out in a row, with no picture under it, is told apart by its label alone.
  before(written) {
    if (!isObject(written?.question) || written.question.settings?.background || !Array.isArray(written.question.task?.dropZones)) return
    for (const zone of written.question.task.dropZones) {
      if (isObject(zone) && zone.showLabel === undefined && (typeof zone.x !== 'number' || typeof zone.y !== 'number')) zone.showLabel = true
    }
  },
  after(params, path, context) {
    const settings = params?.question?.settings
    const task = params?.question?.task
    const size = settings?.size
    if (!isObject(task) || !isObject(size) || !(size.width > 0) || !(size.height > 0)) return
    const elements = Array.isArray(task.elements) ? task.elements.filter(isObject) : []
    const zones = Array.isArray(task.dropZones) ? task.dropZones.filter(isObject) : []
    const free = (/** @type {any} */ box) => typeof box.x !== 'number' || typeof box.y !== 'number'
    const loose = elements.filter(free)
    const open = zones.filter(free)
    const across = size.width / 16
    // Every box with no size gets one, placed or not. Words share a size, and pictures theirs, so
    // a row reads as one bank.
    const sized = (/** @type {any} */ box) => typeof box.width === 'number' && typeof box.height === 'number'
    const most = Math.max(DQ_BOX.width, (across - 2 * DQ_MARGIN - DQ_GAP) / 2 - DRAGGABLE_EDGE.width)
    for (const image of [true, false]) {
      const same = elements.filter((element) => !sized(element) && (machineName(element.type?.library) === 'H5P.Image') === image)
      const wanted = same.map((element) => draggableSize(element, most))
      const width = Math.max(0, ...wanted.map((each) => each.width))
      const height = Math.max(0, ...wanted.map((each) => each.height))
      for (const element of same) Object.assign(element, { width: element.width ?? width, height: element.height ?? height })
    }
    // A zone holds the elements right in it; a shown label is drawn above it, outside its box.
    const widest = Math.max(DQ_BOX.width, ...elements.map((element) => element.width)) + DRAGGABLE_EDGE.width
    const tallest = Math.max(DQ_BOX.height, ...elements.map((element) => element.height)) + DRAGGABLE_EDGE.height
    const wanted = zones.filter((zone) => !sized(zone)).map((zone) => {
      const label = zone.showLabel ? emWidth(textOf(String(zone.label ?? ''))) + 1.5 : 0
      const width = Math.min(across - 2 * DQ_MARGIN, Math.max(widest + 1, label))
      const columns = Math.max(1, Math.floor((width - 0.5) / (widest + 0.5)))
      const rows = Math.ceil(Math.max(1, Array.isArray(zone.correctElements) ? zone.correctElements.length : 0) / columns)
      return { zone, width, height: rows * (tallest + 0.5) + 0.5 }
    })
    for (const { zone } of wanted) Object.assign(zone, { width: zone.width ?? round(Math.max(...wanted.map((one) => one.width))), height: zone.height ?? round(Math.max(...wanted.map((one) => one.height))) })
    if (loose.length || open.length) {
      // Written boxes keep their places, and the rest go below them.
      const tall = size.height / 16
      const placed = [...elements, ...zones].filter((box) => !free(box))
      const bottom = (/** @type {any} */ box) => (box.y / 100) * tall + (box.height ?? 0) + (elements.includes(box) ? DRAGGABLE_EDGE.height : 0)
      const top = placed.length ? Math.max(...placed.map(bottom)) + 2 * DQ_GAP : DQ_MARGIN
      const outer = (/** @type {any} */ box) => ({ width: box.width + DRAGGABLE_EDGE.width, height: box.height + DRAGGABLE_EDGE.height })
      const above = (/** @type {any} */ zone) => (zone.showLabel ? DQ_LINE : 0)
      const words = inRows(loose.map(outer), across, top)
      const targets = inRows(open.map((zone) => ({ width: zone.width, height: zone.height + above(zone) })), across, loose.length ? words.bottom + 2 * DQ_GAP : top)
      const need = (open.length ? targets.bottom : words.bottom) + DQ_MARGIN
      if (settings.background) {
        context.note(`${path}.question.settings.background`, `is under the boxes the build laid out in rows, which know nothing of the picture: place each by its x and y (percent) on what it names${need > tall ? `, since the rows need ${Math.ceil(need * 16)} px of the task's ${size.height}` : ''}`)
      } else if (need > tall) {
        size.height = Math.ceil(need * 16)
        // A written y is percent of the task as written: kept in em, so the rows stay clear of it.
        for (const box of placed) box.y = round((box.y * tall * 16) / size.height)
      }
      const height = size.height / 16
      const place = (/** @type {any} */ box, /** @type {{ x: number, y: number }} */ at) => Object.assign(box, { x: round((at.x / across) * 100), y: round((at.y / height) * 100) })
      loose.forEach((element, i) => place(element, words.places[i]))
      open.forEach((zone, i) => place(zone, { x: targets.places[i].x, y: targets.places[i].y + above(zone) }))
    }
    noteDragQuestionBoxes(elements, zones, /** @type {{ width: number, height: number }} */ (size), `${path}.question.task`, context.note)
  }
}

/**
 * Boxes past the task's edge or over each other, the elements by their place at the start (#295).
 * @param {any[]} elements
 * @param {any[]} zones
 * @param {{ width: number, height: number }} size
 * @param {string} at
 * @param {(path: string, message: string) => void} note
 */
function noteDragQuestionBoxes(elements, zones, size, at, note) {
  const across = size.width / 16
  const tall = size.height / 16
  const units = `x and y are percent of the task, width and height em, and it is ${round(across)} by ${round(tall)} em (${size.width} by ${size.height} px); leave all four out and the build lays the boxes out`
  // A zone's shown label is drawn above its box.
  const boxes = [
    ...elements.map((box, i) => ({ box, path: `${at}.elements[${i}]`, name: `element ${i}`, edge: DRAGGABLE_EDGE, lift: 0 })),
    ...zones.map((box, i) => ({ box, path: `${at}.dropZones[${i}]`, name: `drop zone ${i}`, edge: { width: 0, height: 0 }, lift: box.showLabel ? DQ_LINE : 0 }))
  ].filter(({ box }) => ['x', 'y', 'width', 'height'].every((key) => typeof box[key] === 'number'))
    .map((each) => ({ ...each, left: (each.box.x / 100) * across, top: (each.box.y / 100) * tall - each.lift, width: each.box.width + each.edge.width, height: each.box.height + each.edge.height + each.lift }))
  // A quarter em either way is rounding, not a box over another.
  const slack = 0.25
  const past = boxes.filter((one) => one.left < -slack || one.top < -slack || one.left + one.width > across + slack || one.top + one.height > tall + slack)
  const over = boxes.filter((one) => boxes.some((other) => other !== one && Math.min(one.left + one.width, other.left + other.width) - Math.max(one.left, other.left) > slack && Math.min(one.top + one.height, other.top + other.height) - Math.max(one.top, other.top) > slack))
  const names = (/** @type {typeof boxes} */ list) => list.map((one) => one.name).join(', ')
  const found = [past.length && `past the task's edge (${names(past)})`, over.length && `over each other (${names(over)})`].filter(Boolean)
  if (found.length) note(at, `has boxes ${found.join(' and ')}: ${units}`)
}

/* ---------------------------------------------------------------- Fill in the Blanks */

/**
 * The gaps of a text block as H5P.Blanks 1.14 finds them (`handleBlanks`): asterisk to asterisk,
 * tags between removed until none is left (the library does one pass).
 * @param {string} question
 * @returns {{ raw: string, content: string }[]} each gap as written, asterisks included, and what the library reads of it
 */
export function blanksGaps(question) {
  const gaps = []
  let start = question.indexOf('*')
  while (start !== -1) {
    const end = question.indexOf('*', start + 1)
    if (end === -1) break
    let content = question.slice(start + 1, end)
    for (let before = ''; before !== content; ) {
      before = content
      content = content.replaceAll(/<\/?[a-z]*\d?>/gi, '')
    }
    if (content.length) gaps.push({ raw: question.slice(start, end + 1), content })
    start = question.indexOf('*', content.length ? end + 2 : end + 1)
  }
  return gaps
}

/**
 * A backslash escaping a slash or colon in a gap's answer (`*1\/2*`): H5P.Blanks escapes neither
 * (`parseSolution`), so the answer ends there. An entity works (`*1&#47;2*`).
 * @type {Layout}
 */
const blanks = {
  after(params, path, context) {
    if (!Array.isArray(params?.questions)) return
    params.questions.forEach((/** @type {unknown} */ question, /** @type {number} */ i) => {
      if (typeof question !== 'string') return
      for (const { raw, content } of blanksGaps(question)) {
        const tipStart = content.indexOf(':')
        const answers = (tipStart === -1 ? content : content.slice(0, tipStart)).split('/')
        const escapes = answers.some((answer, at) => answer.endsWith('\\') && answer.trim() !== '\\' && (at < answers.length - 1 || tipStart !== -1))
        if (!escapes) continue
        // The gap as it was meant: a backslash's slash or colon part of the answer, up to the
        // first colon no backslash stands before, where the tip starts.
        let meant = ''
        for (let at = 0; at < content.length; at++) {
          const next = content[at + 1]
          if (content[at] === '\\' && (next === '/' || next === ':')) {
            meant += next === '/' ? '&#47;' : '&#58;'
            at++
          } else if (content[at] === ':') {
            meant += content.slice(at)
            break
          } else meant += content[at]
        }
        const taken = answers.map((answer) => `"${answer.trim()}"`).join(' or ')
        context.report(
          `${path}.questions[${i}]`,
          `\`${raw}\`: a backslash escapes nothing in a gap, so H5P.Blanks takes ${taken} here${tipStart === -1 ? '' : `, with the tip "${content.slice(tipStart + 1).trim()}"`}. ` +
            `In an answer write \`/\` as \`&#47;\` and \`:\` as \`&#58;\`: \`*${meant}*\``
        )
      }
    })
  }
}

/* ---------------------------------------------------------------- Drag the Words */

/** A gap as a problem shows it: whole when short, its start otherwise. @param {string} text @param {number} most */
const shortened = (text, most) => (text.length > most ? `${text.slice(0, most - 1)}…` : text)

/**
 * A gap H5P.DragText 1.10 cannot take apart: `lex` takes a tip or feedback out with one `replace`
 * of all matches, so with two nothing is taken out. A colon in a feedback starts a second tip.
 * @type {Layout}
 */
const dragText = {
  after(params, path, context) {
    if (typeof params?.textField !== 'string') return
    let gap = 0
    for (const part of params.textField.replace(/(\r\n|\n|\r)/gm, '<br/>').split(/(\*.*?\*)/)) {
      if (!part.startsWith('*') || !part.endsWith('*')) continue
      gap++
      const tips = part.match(/(:([^\\*]+))/g) ?? []
      const right = part.match(/(\\\+([^\\*:]+))/g) ?? []
      const wrong = part.match(/(\\-([^\\*:]+))/g) ?? []
      if (tips.length < 2 && right.length < 2 && wrong.length < 2) continue
      let word = part.slice(1, -1)
      for (const matches of [tips, right, wrong]) if (matches.length) word = word.replace(String(matches), '')
      const [why, write] =
        tips.length > 1 && /\\[+-][^*]*:/.test(part)
          ? ['its feedback holds a `:`, where H5P.DragText ends the feedback and starts another tip', 'Write `:` once in a gap, before the tip, and none in the feedback']
          : tips.length > 1
            ? ['`:` starts a tip more than once in it', 'Write `:` once in a gap, before the tip']
            : right.length > 1
              ? ['`\\+` stands more than once in it', 'Write `\\+` once in a gap, before the feedback for the right word']
              : ['`\\-` stands more than once in it', 'Write `\\-` once in a gap, before the feedback for a wrong word']
      context.report(`${path}.textField`, `gap ${gap}, \`${shortened(part, 60)}\`: ${why}, and it then leaves them in the word: the learner would drag "${shortened(word.replace(/\s+$/, ''), 70)}". ${write}`)
    }
  }
}

/* ---------------------------------------------------------------- Video */

/** @type {Layout} */
const video = { optional: ['visuals.poster'] }

/* ---------------------------------------------------------------- Row */

/**
 * A row's columns, each a share of its width in percent. H5P.com's editor writes hundredths
 * (24.76), which the check keeps and the library plays, so a share takes two decimals (#242).
 * @type {Layout}
 */
const row = { decimals: { 'columns[].width': 2 } }

/**
 * A row's column with nothing in it, as H5P.com's editor leaves a spacer. The content check drops
 * the empty list and the library plays it as empty, so a source may leave it out (#242).
 * @type {Layout}
 */
const rowColumn = { optional: ['content'] }

// Editors followed: the newest release of the minor a type names in `editorDependencies`, but for
// Course Presentation and Find the Hotspot, ours (design/author.md, *The editor is pinned*).
/** @type {Record<string, Layout>} */
export const LAYOUTS = {
  'H5P.QuestionSet': questionSet,
  'H5P.Blanks': blanks,
  'H5P.DragText': dragText,
  'H5P.InteractiveBook': interactiveBook,
  'H5P.CoursePresentation': coursePresentation,
  'H5P.InteractiveVideo': interactiveVideo,
  'H5P.BranchingScenario': branchingScenario,
  'H5P.GameMap': gameMap,
  'H5P.ImageHotspotQuestion': imageHotspotQuestion,
  'H5P.DragQuestion': dragQuestion,
  'H5P.Video': video,
  'H5P.Row': row,
  'H5P.RowColumn': rowColumn
}

/**
 * Semantics with the fields a layout makes optional marked so, and those it gives decimals given
 * them, for a copy the generator reads.
 * @param {string} machineName
 * @param {any[]} semantics
 */
export function patchSemantics(machineName, semantics) {
  const layout = LAYOUTS[machineName]
  for (const path of layout?.optional ?? []) {
    const field = fieldAt(semantics, path.replace(/\[\]/g, '').split('.'))
    if (field) field.optional = true
  }
  for (const [path, decimals] of Object.entries(layout?.decimals ?? {})) {
    const field = fieldAt(semantics, path.replace(/\[\]/g, '').split('.'))
    if (field) field.decimals = decimals
  }
  return semantics
}

/**
 * Every place a library's parameters sit in content: the content's own, at `params`, and each
 * sub-content's, with the path to it.
 * @param {string} main the main library's machine name
 * @param {any} params
 * @returns {{ library: string, params: any, path: string, holder: any }[]}
 */
export function placesOf(main, params) {
  /** @type {{ library: string, params: any, path: string, holder: any }[]} */
  const found = [{ library: main, params, path: 'params', holder: null }]
  /** @param {any} value @param {string} at */
  const walk = (value, at) => {
    if (Array.isArray(value)) value.forEach((item, i) => walk(item, `${at}[${i}]`))
    else if (isObject(value)) {
      if (typeof value.library === 'string' && isObject(value.params)) found.push({ library: machineName(value.library), params: value.params, path: `${at}.params`, holder: value })
      for (const [key, item] of Object.entries(value)) walk(item, `${at}.${key}`)
    }
  }
  walk(params, 'params')
  return found
}
