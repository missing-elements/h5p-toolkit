import { decodeEntities, stripTags } from './text.mjs'
import { blanksGaps } from './types.mjs'

/**
 * What builds and is almost surely a mistake (#241, #268): no answer marked correct, two alike, a
 * stale draw or part setting after a chat edits content. H5P allows each, so each is a note.
 */

/** @typedef {(path: string, message: string) => void} Note */

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * A text as a learner reads it, to compare one with another: no tags or entities, and in one case
 * and spacing.
 * @param {unknown} value
 */
function plain(value) {
  return typeof value === 'string' ? decodeEntities(stripTags(value)).replace(/\s+/g, ' ').trim().toLowerCase() : ''
}

/** @param {unknown} value */
const count = (value) => (Array.isArray(value) ? value.length : 0)

/**
 * What a draw shows, where a setting shows a random pick of a list's items, as each library works
 * it out (#268): Question Set `poolSize`, Memory Game `numCardsToUse`, Crossword `poolSize`.
 * @param {string} library
 * @param {unknown} params as H5P stores them
 * @returns {{ at: string, what: string, used: number, total: number, shown: number, fixed: number, shuffles: boolean } | null}
 *   `at`, the setting's path in the parameters; `used`, the number drawn; null if nothing is drawn
 * @internal
 */
export function drawOf(library, params) {
  if (!isObject(params)) return null
  if (library === 'H5P.QuestionSet') {
    const total = count(params.questions)
    if (typeof params.poolSize !== 'number' || !(params.poolSize > 0) || !total) return null
    // questionset.js: a `poolSize` above 0 shuffles the questions and keeps `slice(0, poolSize)`,
    // which drops a fraction.
    const used = Math.trunc(params.poolSize)
    return { at: 'poolSize', what: 'questions', used, total, shown: Math.min(used, total), fixed: 0, shuffles: true }
  }
  if (library === 'H5P.MemoryGame') {
    const total = count(params.cards)
    const setting = params.behaviour?.numCardsToUse
    if (typeof setting !== 'number' || !(setting >= 1) || !total) return null
    // memory-game.js: `numCardsToUse` pairs, at least 2.
    const used = Math.max(2, Math.trunc(setting))
    return { at: 'behaviour.numCardsToUse', what: 'pairs', used, total, shown: Math.min(used, total), fixed: 0, shuffles: false }
  }
  if (library === 'H5P.Crossword') {
    const setting = params.behaviour?.poolSize
    const words = Array.isArray(params.words) ? params.words.filter((/** @type {any} */ word) => word?.answer && word?.clue) : []
    if (typeof setting !== 'number' || !setting || !words.length) return null
    // h5p-crossword.js: `poolSize` 0 is all, else at least 2, less a fraction; fixed words are kept
    // always, and a word without an answer or a clue is left out first.
    const used = Math.trunc(Math.max(2, setting))
    const fixed = words.filter((/** @type {any} */ word) => word.fixWord && word.row !== undefined && word.column !== undefined && word.orientation !== undefined).length
    const shown = fixed + Math.min(Math.max(0, used - fixed), words.length - fixed)
    return { at: 'behaviour.poolSize', what: 'words', used, total: words.length, shown, fixed, shuffles: false }
  }
  return null
}

/**
 * A draw's note: below the list's length, what it shows (it may be meant); at or above it, that it
 * leaves none out now but would once items are added.
 * @param {string} library @param {Record<string, any>} params @param {string} path @param {Note} note
 */
function noteDraw(library, params, path, note) {
  const draw = drawOf(library, params)
  if (!draw) return
  const { what, used, total, shown, fixed } = draw
  const at = `${path}.${draw.at}`
  const order = draw.shuffles ? ' but shows them in a random order' : ''
  const random = draw.shuffles ? ', and set randomQuestions for a random order' : ''
  if (shown < total) {
    if (!fixed) note(at, `shows ${shown} of the ${total} ${what} each time, drawn at random, and leaves the rest out: leave it out to show them all, or tell the user that it draws`)
    else if (shown === fixed) note(at, `shows only the ${fixed} ${what} fixed on the grid, and never the other ${total - fixed}: leave it out to show them all`)
    else note(at, `shows ${shown} of the ${total} ${what} each time, the ${fixed} fixed on the grid and ${shown - fixed} of the other ${total - fixed} drawn at random, and leaves the rest out: leave it out to show them all, or tell the user that it draws`)
  }
  else if (used === total) note(at, `is the number of ${what}, ${total}, so it leaves none out${order}, and one added later would leave one out at random: leave it out${random}`)
  else note(at, `is above the number of ${what}, ${total}, so it leaves none out${order} until more than ${used} are, and then leaves some out at random: leave it out${random}`)
}

/**
 * Each item of a list that reads as an earlier one does.
 * @param {unknown} items
 * @param {(item: any) => unknown} textOf the text of an item
 * @param {string} at the list's path
 * @param {string} what what an item is to a learner, as "answer"
 * @param {Note} note
 */
function alike(items, textOf, at, what, note) {
  if (!Array.isArray(items)) return
  /** @type {Map<string, number>} */
  const first = new Map()
  items.forEach((item, i) => {
    const text = plain(textOf(item))
    if (!text) return
    const earlier = first.get(text)
    if (earlier === undefined) first.set(text, i)
    else note(`${at}[${i}]`, `reads as ${at.slice(at.lastIndexOf('.') + 1)}[${earlier}] does, so a learner sees the same ${what} twice`)
  })
}

/**
 * Whether a list marks no item correct, where it has items.
 * @param {unknown} items
 */
const noneCorrect = (items) => Array.isArray(items) && items.length > 0 && !items.some((item) => isObject(item) && item.correct === true)

/** A text with no gap, `*word*`, in it, as Drag the Words and Mark the Words find one. @param {unknown} text */
const gapless = (text) => typeof text === 'string' && !/\*[^*]+\*/.test(text)

/**
 * Pictures whose alt text is an optional field beside them, by type: the holding group's path (`[]`
 * per list item), the picture's field and its alt's. H5P.Image's is required already.
 * @type {Record<string, [string, string, string][]>}
 * @internal
 */
export const ALT_TEXTS = {
  'H5P.BranchingScenario': [['branchingScenario.startScreen', 'startScreenImage', 'startScreenAltText']],
  'H5P.Dialogcards': [['dialogs[]', 'image', 'imageAltText']],
  'H5P.Flashcards': [['cards[]', 'image', 'imageAltText']],
  'H5P.ImageHotspots': [['', 'image', 'backgroundImageAltText']],
  'H5P.ImagePair': [['cards[]', 'match', 'matchAlt']],
  'H5P.MemoryGame': [['cards[]', 'match', 'matchAlt']],
  'H5P.QuestionSet': [['introPage', 'backgroundImage', 'backgroundImageAltText']],
  'H5P.SpeakTheWordsSet': [['introduction', 'introductionImage', 'introductionImageAltText']]
}

/**
 * The groups at a path in parameters, `[]` taking each item of a list, with their paths.
 * @param {unknown} value
 * @param {string} path
 * @param {string} at the value's own path
 * @returns {{ group: Record<string, any>, at: string }[]}
 */
function groupsAt(value, path, at) {
  if (!isObject(value)) return []
  if (!path) return [{ group: value, at }]
  const [head, ...rest] = path.split('.')
  const name = head.replace(/\[\]$/, '')
  const next = value[name]
  if (head.endsWith('[]')) return Array.isArray(next) ? next.flatMap((item, i) => groupsAt(item, rest.join('.'), `${at}.${name}[${i}]`)) : []
  return groupsAt(next, rest.join('.'), `${at}.${name}`)
}

/**
 * The checks of each content type, on its parameters as H5P stores them.
 * @type {Record<string, (params: Record<string, any>, path: string, note: Note) => void>}
 */
const CHECKS = {
  'H5P.MultiChoice'(params, path, note) {
    if (noneCorrect(params.answers)) note(`${path}.answers`, 'marks no answer correct, so no learner can score: set "correct": true on the right one')
    alike(params.answers, (answer) => answer?.text, `${path}.answers`, 'answer', note)
  },
  'H5P.MultiMediaChoice'(params, path, note) {
    if (noneCorrect(params.options)) note(`${path}.options`, 'marks no option correct, so no learner can score: set "correct": true on the right one')
  },
  // `poolSize`, labelled "Number of questions to be shown", is how many are drawn at random: in
  // ChatGPT a quiz of six came with it at 3 after the chat was asked to add questions (#268).
  'H5P.QuestionSet'(params, path, note) {
    noteDraw('H5P.QuestionSet', params, path, note)
  },
  'H5P.MemoryGame'(params, path, note) {
    noteDraw('H5P.MemoryGame', params, path, note)
  },
  'H5P.Crossword'(params, path, note) {
    noteDraw('H5P.Crossword', params, path, note)
  },
  // The task ends at this many found. Above the number of hotspots, right or not, the library
  // does not use it (image-multiple-hotspot-question.js).
  'H5P.ImageMultipleHotspotQuestion'(params, path, note) {
    const settings = params.imageMultipleHotspotQuestion?.hotspotSettings
    const wanted = settings?.numberHotspots
    const spots = Array.isArray(settings?.hotspot) ? settings.hotspot : []
    const correct = spots.filter((/** @type {any} */ spot) => spot?.userSettings?.correct === true).length
    if (typeof wanted !== 'number' || wanted < 1 || !correct) return
    const at = `${path}.imageMultipleHotspotQuestion.hotspotSettings.numberHotspots`
    if (wanted > spots.length) note(at, `is above the number of hotspots, ${spots.length}, so it is not used: leave it out`)
    else if (wanted > correct) note(at, `asks for ${wanted} hotspots, and ${correct} ${correct === 1 ? 'is' : 'are'} marked correct, so no learner can finish: leave it out, or mark more correct`)
    else if (wanted < correct) note(at, `ends the task once ${wanted} of the ${correct} correct hotspots are found: leave it out to ask for all of them, or tell the user`)
    else note(at, `is the number of correct hotspots, ${correct}, so it changes nothing, and one added later would not be asked for: leave it out`)
  },
  // A button that goes to a slide by its number: one that is not there goes nowhere.
  'H5P.CoursePresentation'(params, path, note) {
    const slides = params.presentation?.slides
    if (!Array.isArray(slides)) return
    slides.forEach((/** @type {any} */ slide, /** @type {number} */ i) => {
      if (!Array.isArray(slide?.elements)) return
      slide.elements.forEach((/** @type {any} */ element, /** @type {number} */ j) => {
        const to = element?.goToSlide
        if ((element?.goToSlideType ?? 'specified') !== 'specified' || typeof to !== 'number') return
        if (!Number.isInteger(to) || to < 1 || to > slides.length) note(`${path}.presentation.slides[${i}].elements[${j}].goToSlide`, `goes to slide ${to}, and there ${slides.length === 1 ? 'is 1 slide' : `are ${slides.length} slides`}, so the button has no slide to go to: name a slide by its number, from 1`)
      })
    })
  },
  // Zones and elements name each other by place, as text (h5p-drag-question.js). An element
  // droppable in none of its right zones can never be put right; one reaching some is left.
  'H5P.DragQuestion'(params, path, note) {
    const task = params.question?.task
    const elements = Array.isArray(task?.elements) ? task.elements : []
    const zones = Array.isArray(task?.dropZones) ? task.dropZones : []
    const at = `${path}.question.task`
    /** @param {unknown} named @param {number} total */
    const placed = (named, total) => { const index = Number(named); return typeof named !== 'boolean' && named !== '' && Number.isInteger(index) && index >= 0 && index < total }
    const none = (/** @type {number} */ total, /** @type {string} */ one) => (total === 1 ? `is 1 ${one}` : `are ${total} ${one}s`)
    zones.forEach((/** @type {any} */ zone, /** @type {number} */ i) => {
      if (!Array.isArray(zone?.correctElements)) return
      zone.correctElements.forEach((/** @type {any} */ named, /** @type {number} */ j) => {
        if (!placed(named, elements.length)) return note(`${at}.dropZones[${i}].correctElements[${j}]`, `names element ${JSON.stringify(named)}, and there ${none(elements.length, 'element')}, counted from 0: name each by its place in elements`)
      })
    })
    elements.forEach((/** @type {any} */ element, /** @type {number} */ e) => {
      if (!Array.isArray(element?.dropZones)) return
      const right = zones.flatMap((/** @type {any} */ zone, /** @type {number} */ i) => (Array.isArray(zone?.correctElements) && zone.correctElements.map(String).includes(String(e)) ? [i] : []))
      const allowed = new Set(element.dropZones.map(String))
      if (right.length && !right.some((/** @type {number} */ i) => allowed.has(String(i)))) note(`${at}.elements[${e}].dropZones`, `lets the element be dropped in ${element.dropZones.length ? `zone ${element.dropZones.join(', ')}` : 'no zone'}, and it is right only in zone ${right.join(', ')}, so no learner can put it right: name ${right.length === 1 ? 'that zone' : 'one of those zones'} in its dropZones`)
    })
    elements.forEach((/** @type {any} */ element, /** @type {number} */ i) => {
      if (!Array.isArray(element?.dropZones)) return
      element.dropZones.forEach((/** @type {any} */ named, /** @type {number} */ j) => {
        if (!placed(named, zones.length)) note(`${at}.elements[${i}].dropZones[${j}]`, `names drop zone ${JSON.stringify(named)}, and there ${none(zones.length, 'drop zone')}, counted from 0: name each by its place in dropZones`)
      })
    })
  },
  // Held to the images there are (h5p-agamotto.js), so nothing breaks: it starts elsewhere than
  // written. A fraction never gets here: the field takes whole numbers.
  'H5P.Agamotto'(params, path, note) {
    const start = params.behaviour?.startImage
    const items = count(params.items)
    if (typeof start === 'number' && items && (start < 1 || start > items)) note(`${path}.behaviour.startImage`, `is image ${start}, and there ${items === 1 ? 'is 1 image' : `are ${items} images`}, so it starts at the ${start < 1 ? 'first' : 'last'}: name one by its number, from 1, or leave it out`)
  },
  // A tour's scenes are named by their ids: where it starts, and where a "go to scene" leads.
  'H5P.ThreeImage'(params, path, note) {
    const tour = params.threeImage
    if (!Array.isArray(tour?.scenes)) return
    const ids = new Set(tour.scenes.map((/** @type {any} */ scene) => scene?.sceneId).filter((/** @type {any} */ id) => id !== undefined))
    const listed = [...ids].join(', ')
    if (tour.startSceneId !== undefined && !ids.has(tour.startSceneId)) note(`${path}.threeImage.startSceneId`, `is ${tour.startSceneId}, which no scene has; the scenes' ids are ${listed}: name the scene the tour starts on by its sceneId`)
    tour.scenes.forEach((/** @type {any} */ scene, /** @type {number} */ i) => {
      if (!Array.isArray(scene?.interactions)) return
      scene.interactions.forEach((/** @type {any} */ interaction, /** @type {number} */ j) => {
        const action = interaction?.action
        const to = action?.params?.nextSceneId
        if (!/^H5P\.GoToScene\b/.test(String(action?.library ?? '')) || to === undefined || ids.has(to)) return
        note(`${path}.threeImage.scenes[${i}].interactions[${j}].action.params.nextSceneId`, `is ${to}, which no scene has; the scenes' ids are ${listed}: name the scene it goes to by its sceneId`)
      })
    })
  },
  // An answer names personalities, split at ", " and counted only if exactly a personality's
  // (personalityQuiz.js): another capital, a comma without a space, or a rename counts for none.
  'H5P.PersonalityQuiz'(params, path, note) {
    if (!Array.isArray(params.personalities) || !Array.isArray(params.questions)) return
    const names = new Set(params.personalities.map((/** @type {any} */ one) => one?.name).filter((/** @type {any} */ name) => typeof name === 'string' && name))
    params.questions.forEach((/** @type {any} */ question, /** @type {number} */ i) => {
      if (!Array.isArray(question?.answers)) return
      question.answers.forEach((/** @type {any} */ answer, /** @type {number} */ j) => {
        if (typeof answer?.personality !== 'string' || !answer.personality) return
        // An empty part, after a comma at the end, names nothing and is not said.
        const unknown = answer.personality.split(', ').filter((/** @type {any} */ name) => name && !names.has(name))
        if (unknown.length) note(`${path}.questions[${i}].answers[${j}].personality`, `names ${unknown.map((/** @type {any} */ name) => JSON.stringify(name)).join(', ')}, which no personality is called exactly, so ${unknown.length === 1 ? 'that name counts' : 'those names count'} for none: write each name as its personality has it, capitals too, with a comma and a space between two`)
      })
    })
  },
  'H5P.SingleChoiceSet'(params, path, note) {
    if (!Array.isArray(params.choices)) return
    params.choices.forEach((choice, i) => alike(choice?.answers, (answer) => answer, `${path}.choices[${i}].answers`, 'answer', note))
  },
  'H5P.Summary'(params, path, note) {
    if (!Array.isArray(params.summaries)) return
    params.summaries.forEach((set, i) => alike(set?.summary, (statement) => statement, `${path}.summaries[${i}].summary`, 'statement', note))
  },
  'H5P.Blanks'(params, path, note) {
    const texts = Array.isArray(params.questions) ? params.questions.filter((text) => typeof text === 'string') : []
    if (texts.length && texts.every((text) => !blanksGaps(text).length)) note(`${path}.questions`, 'has no gap, so a learner has nothing to fill in: put each answer between asterisks, as *Paris*')
  },
  'H5P.DragText'(params, path, note) {
    if (gapless(params.textField)) note(`${path}.textField`, 'has no gap, so a learner has no word to drag: put each word between asterisks, as *Paris*')
  },
  'H5P.MarkTheWords'(params, path, note) {
    if (gapless(params.textField)) note(`${path}.textField`, 'marks no word, so a learner has none to find: put each word to find between asterisks, as *Paris*')
  }
}

/**
 * What a content type's parameters hold that builds and is almost surely a mistake, noted.
 * @param {string} library its machine name
 * @param {unknown} params as H5P stores them
 * @param {string} path theirs
 * @param {Note} note
 * @internal
 */
export function noteMistakes(library, params, path, note) {
  if (!isObject(params)) return
  CHECKS[library]?.(params, path, note)
  for (const [group, picture, alt] of ALT_TEXTS[library] ?? []) {
    for (const { group: values, at } of groupsAt(params, group, path)) {
      const file = values[picture]
      if (!isObject(file) || typeof file.path !== 'string' || !file.path.trim() || plain(values[alt])) continue
      note(`${at}.${alt}`, `is not written, so a screen reader has nothing to say of the picture in ${picture}: write what it shows`)
    }
  }
}
