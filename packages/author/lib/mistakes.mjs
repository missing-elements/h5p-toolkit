import { decodeEntities, stripTags } from './text.mjs'
import { blanksGaps } from './types.mjs'

/**
 * What builds and is almost surely a mistake (#241, item 4 of #219): no answer marked correct, two
 * answers alike, a text with no gap, a picture with no alt text where its field is optional. And
 * what goes stale when a chat changes a content and leaves a setting as it was (#268): a number
 * of items to draw or to find that is not below how many there are, and a part named by its
 * number, id or name that is not there. H5P
 * allows each, so each is a note and not a problem, and nothing about the content is judged: whether
 * an answer is right stays the person's. Run by `checkContent` on content as H5P stores it, so a
 * build says them, and so does a check of saved content.
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
 * A number of items drawn at random from a list, against how many the list holds. Below it, which
 * may be meant, both numbers are said; at or above it, it draws nothing now, and leaves items out
 * at random once more are added: what a chat that adds items and keeps the setting gets (#268).
 * @param {unknown} drawn
 * @param {number} total
 * @param {string} what the items, as "questions"
 * @param {string} at the setting's path
 * @param {Note} note
 */
function draws(drawn, total, what, at, note) {
  if (!total || typeof drawn !== 'number' || drawn < 1) return
  if (drawn < total) note(at, `shows ${drawn} of the ${total} ${what} each time, drawn at random, and leaves the rest out: leave it out to show them all, or tell the user that it draws`)
  else if (drawn === total) note(at, `is the number of ${what}, ${total}, so it draws nothing, and one added later would leave one out at random: leave it out`)
  else note(at, `is above the number of ${what}, ${total}, so it draws nothing until more than ${drawn} are, and then leaves some out at random: leave it out`)
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
 * Pictures whose alt text is an optional field beside them, by content type: the group that holds
 * both, as a path in the type's parameters (`[]` for each item of a list), the picture's field, and
 * its alt text's. H5P.Image's alt text is required, so a build refuses one without it already.
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
    draws(params.poolSize, count(params.questions), 'questions', `${path}.poolSize`, note)
  },
  // An item of `cards` is a pair, and the number is of pairs (memory-game.js: the pool is cut to 2 × it).
  'H5P.MemoryGame'(params, path, note) {
    draws(params.behaviour?.numCardsToUse, count(params.cards), 'pairs', `${path}.behaviour.numCardsToUse`, note)
  },
  // Words fixed on the grid are always among those drawn; 0 means all.
  'H5P.Crossword'(params, path, note) {
    draws(params.behaviour?.poolSize, count(params.words), 'words', `${path}.behaviour.poolSize`, note)
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
  // A drop zone names its right elements, and an element the zones it can be dropped in, by
  // their place in the other list, as text (h5p-drag-question.js reads both). An element that
  // can be dropped in none of the zones it is right in can never be put right. One that can be
  // in some of them is left: a real package of the owner's names two elements right in a zone
  // they cannot reach, beside the one they can, and plays as meant.
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
  // Held to the images there are (h5p-agamotto.js constrains it), so nothing breaks: it starts elsewhere than written.
  'H5P.Agamotto'(params, path, note) {
    const start = params.behaviour?.startImage
    const items = count(params.items)
    if (typeof start === 'number' && items && (!Number.isInteger(start) || start < 1 || start > items)) note(`${path}.behaviour.startImage`, `is image ${start}, and there ${items === 1 ? 'is 1 image' : `are ${items} images`}, so it starts at ${start < 1 ? 'the first' : 'the last'}: name one by its number, from 1, or leave it out`)
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
  // An answer names its personalities by name. The library splits the text at ", " and takes a
  // name only where it is a personality's exactly (personalityQuiz.js: `split(', ')`, `===`), so
  // another capital, a comma with no space after it, or a personality renamed counts for none.
  'H5P.PersonalityQuiz'(params, path, note) {
    if (!Array.isArray(params.personalities) || !Array.isArray(params.questions)) return
    const names = new Set(params.personalities.map((/** @type {any} */ one) => one?.name).filter((/** @type {any} */ name) => typeof name === 'string' && name))
    params.questions.forEach((/** @type {any} */ question, /** @type {number} */ i) => {
      if (!Array.isArray(question?.answers)) return
      question.answers.forEach((/** @type {any} */ answer, /** @type {number} */ j) => {
        if (typeof answer?.personality !== 'string' || !answer.personality) return
        const unknown = answer.personality.split(', ').filter((/** @type {any} */ name) => !names.has(name))
        if (unknown.length) note(`${path}.questions[${i}].answers[${j}].personality`, `names ${unknown.map((/** @type {any} */ name) => JSON.stringify(name)).join(', ')}, which no personality is called exactly, so it counts for none: write each name as its personality has it, capitals too, with a comma and a space between two`)
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
