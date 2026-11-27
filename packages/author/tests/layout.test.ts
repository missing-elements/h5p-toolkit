import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildPackage, SourceError } from '../lib/author.mjs'
import { imageSize } from '../lib/media.mjs'
import { GENERATED_END, GENERATED_START, schemaLines, schemaMarkdown, SOURCE_FIELDS, withSection } from '../lib/schema.mjs'
import { byNumber, inRows, movedInteraction } from '../lib/types.mjs'
import { jpeg, png } from './helpers/media'

const META = { title: 'Layout', language: 'en', license: 'U', authors: [{ name: 'Ann Author', role: 'Author' }] }
let dir: string
let count = 0
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'h5p-author-layout-')) })
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

async function build(type: string, params: unknown, options: Parameters<typeof buildPackage>[2] = {}) {
  const result = await buildPackage({ ...META, type, params }, join(dir, `layout-${++count}.h5p`), options)
  return result.content as Record<string, any> & { notes?: never }
}

async function result(type: string, params: unknown, options: Parameters<typeof buildPackage>[2] = {}) {
  return buildPackage({ ...META, type, params }, join(dir, `layout-${++count}.h5p`), options)
}

async function problems(type: string, params: unknown) {
  const error = await buildPackage({ ...META, type, params }, join(dir, `failed-${++count}.h5p`)).then(() => null, (error: unknown) => error)
  expect(error).toBeInstanceOf(SourceError)
  return (error as SourceError).problems.map(({ path, message }) => `${path}: ${message}`)
}

const question = { library: 'H5P.TrueFalse', params: { question: 'Rivers flow downhill.' } }

describe('Course Presentation', () => {
  it('stacks elements nobody placed down the slide, and keeps those placed by hand', async () => {
    const content = await build('H5P.CoursePresentation', {
      presentation: {
        slides: [
          { elements: [{ action: { library: 'H5P.AdvancedText', params: { text: '<h2>Rivers</h2><p>Water runs down to the sea.</p>' } } }, { action: question }] },
          { elements: [{ x: 10, y: 10, width: 30, height: 20, action: { library: 'H5P.AdvancedText', params: { text: 'Placed' } } }, { action: question }] }
        ]
      }
    })
    const [first, second] = content.presentation.slides.map((slide: { elements: { x: number, y: number, width: number, height: number }[] }) => slide.elements)
    expect(first[0]).toMatchObject({ x: 4, y: 5, width: 92 })
    expect(first[1].y).toBeGreaterThan(first[0].y + first[0].height)
    expect(first[1].y + first[1].height).toBeLessThanOrEqual(95.5)
    expect(second[0]).toMatchObject({ x: 10, y: 10, width: 30, height: 20 })
    expect(second[1].y).toBeGreaterThanOrEqual(30)
  })

  const text = (html: string) => ({ action: { library: 'H5P.AdvancedText', params: { text: html } } })
  const slides = async (...elements: unknown[][]) =>
    (await build('H5P.CoursePresentation', { presentation: { slides: elements.map((each) => ({ elements: each })) } })).presentation.slides.map(
      (slide: { elements: Array<{ y: number, height: number, action: { params: { text?: string } } }> }) => slide.elements
    )

  it('measures text as Course Presentation draws it, so a text box is about as tall as its text (#145)', async () => {
    // An h2 in lines of 30 px with 10 after, a paragraph in lines of 13.5 px with 10.8 after: 64 px
    // of the slide's 360. At the slide's 16 px in lines of 1.5, as before, the box was 25.
    const [[box]] = await slides([text('<h2>Rivers</h2><p>Water runs down to the sea.</p>'), { action: question }])
    expect(box.height).toBeGreaterThan(17)
    expect(box.height).toBeLessThan(21)
    // Beside a question, the text keeps its size and the question the room.
    expect(box.action.params.text).toBe('<h2>Rivers</h2><p>Water runs down to the sea.</p>')
  })

  it('sets text larger on a slide with room and no question, as large as fits (#145)', async () => {
    const long = Array.from({ length: 5 }, (_, i) => `<p>Paragraph ${i}: the sun warms the sea, and some of the water rises into the air as vapour.</p>`).join('')
    const [[short], [longer], [full]] = await slides(
      [text('<h2>The water cycle</h2><p>How water travels between the sea, the sky and the land.</p>')],
      [text(`<h2>Evaporation</h2>${long}`)],
      // Eleven one-line paragraphs: 74 % of the slide as written, 93 % at the smallest step, past the 90 there is.
      [text(Array.from({ length: 11 }, () => '<p>The sun warms the sea, and some of the water rises into the air as vapour.</p>').join(''))]
    )
    // Twice the size, the largest step, on the size each block has.
    expect(short.action.params.text).toBe('<h2 style="font-size:3.33em;">The water cycle</h2><p style="font-size:1.8em;">How water travels between the sea, the sky and the land.</p>')
    expect(short.y + short.height).toBeLessThanOrEqual(95)
    // More text, a smaller step.
    expect(longer.action.params.text).toMatch(/^<h2 style="font-size:(2\.92|2\.5|2\.08)em;">Evaporation<\/h2><p style="font-size:(1\.58|1\.35|1\.13)em;">/)
    expect(longer.y + longer.height).toBeLessThanOrEqual(95)
    // No room for even the smallest step: as written.
    expect(full.action.params.text).not.toContain('font-size')
  })

  it('keeps a size the source set, and a block’s own style beside the one it adds (#145)', async () => {
    const [[sized], [centred]] = await slides(
      [text('<p><span style="font-size:1.25em;">Already sized</span></p>')],
      [text('<p style="text-align:center;">A centred line</p>')]
    )
    expect(sized.action.params.text).toBe('<p><span style="font-size:1.25em;">Already sized</span></p>')
    // As the content check writes a style it keeps: text-align first, each ended with a semicolon.
    expect(centred.action.params.text).toBe('<p style="text-align:center;font-size:1.8em;">A centred line</p>')
  })

  it('says when a slide holds more than fits', async () => {
    const long = Array.from({ length: 12 }, (_, i) => `<p>Paragraph ${i} about rivers, lakes, seas and the water cycle that joins them.</p>`).join('')
    const { notes } = await result('H5P.CoursePresentation', { presentation: { slides: [{ elements: [{ action: { library: 'H5P.AdvancedText', params: { text: long } } }, { action: question }] }] } })
    expect(notes).toEqual([{ path: 'params.presentation.slides[0]', message: expect.stringContaining('likely holds more than fits on one slide') }])
  })
})

describe('Interactive Video', () => {
  it('places interactions nobody placed, apart when they show at the same time, and names their library', async () => {
    const content = await build('H5P.InteractiveVideo', {
      interactiveVideo: {
        video: { files: [{ path: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }] },
        assets: {
          interactions: [
            { duration: { from: 2, to: 8 }, action: question },
            { duration: { from: 4, to: 6 }, displayType: 'poster', action: question },
            { duration: { from: 20, to: 22 }, action: question }
          ]
        }
      }
    })
    const [a, b, c] = content.interactiveVideo.assets.interactions
    expect(a).toMatchObject({ x: 5, y: 5, libraryTitle: 'True/False Question' })
    // Below the button shown with it.
    expect(b).toMatchObject({ x: 5, y: 20, width: 17, height: 16 })
    expect(c).toMatchObject({ x: 5, y: 5 })
    // The summary task nobody opened stays as the editor leaves it.
    expect(content.interactiveVideo.summary.task.library).toMatch(/^H5P\.Summary /)
  })

  it('sizes a poster by what it holds, and puts posters shown together side by side', async () => {
    await writeFile(join(dir, 'photo.png'), png(1600, 1200))
    const poster = (from: number, action: unknown, size = {}) => ({ duration: { from, to: from + 4 }, displayType: 'poster', action, ...size })
    const { content, notes } = await result('H5P.InteractiveVideo', {
      interactiveVideo: {
        video: { files: [{ path: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }] },
        assets: {
          interactions: [
            poster(1, question),
            poster(2, question),
            poster(3, question),
            poster(10, { library: 'H5P.Text', params: { text: 'All of this water ends in the sea.' } }),
            poster(20, { library: 'H5P.Image', params: { file: { path: 'photo.png' }, alt: 'A river' } }),
            poster(30, question, { width: 30, height: 20 })
          ]
        }
      }
    }, { base: dir })
    const [first, second, third, text, image, written] = (content as Record<string, any>).interactiveVideo.assets.interactions
    // A question gets room for its answers and buttons; 10 by 10, the editor's start, hid them.
    expect(first).toMatchObject({ x: 5, y: 5, width: 17, height: 16 })
    expect(second).toMatchObject({ x: 50, y: 5, width: 17, height: 16 })
    expect(third).toMatchObject({ x: 5, y: 5 })
    expect(notes).toEqual([
      { path: 'params.interactiveVideo.assets.interactions[2]', message: expect.stringContaining('has no room left for it') },
      { path: 'params.interactiveVideo.assets.interactions', message: expect.stringContaining('holds 6 interactions shown at the times written') }
    ])
    // A text its lines, a picture its shape, as the editor gives one.
    expect(text).toMatchObject({ x: 5, y: 5, width: 12, height: 5.6 })
    expect(image).toMatchObject({ width: 13.33, height: 10 })
    expect(written).toMatchObject({ width: 30, height: 20 })
  })

  it('refuses an interaction that ends before it starts', async () => {
    expect(await problems('H5P.InteractiveVideo', {
      interactiveVideo: { video: { files: [{ path: 'https://youtu.be/dQw4w9WgXcQ' }] }, assets: { interactions: [{ duration: { from: 9, to: 3 }, action: question }] } }
    })).toEqual(['params.interactiveVideo.assets.interactions[0].duration: ends at 3 s, before it starts at 9 s'])
  })

  it("says where Interactive Video plays an interaction that ends past its video's last whole second (#285)", () => {
    // As H5P.InteractiveVideo 1.28 moves it on load: to end there, as long as it was written.
    expect(movedInteraction({ from: 9.6, to: 14.6 }, 10)).toEqual({ from: 5, to: 10 })
    expect(movedInteraction({ from: 10, to: 15 }, 10)).toEqual({ from: 5, to: 10 })
    expect(movedInteraction({ from: 500, to: 600 }, 30)).toEqual({ from: 0, to: 30 })
    // Left where it is: within the video, or no start before an end.
    expect(movedInteraction({ from: 5, to: 10 }, 10)).toBeUndefined()
    expect(movedInteraction({ from: 9, to: 3 }, 2)).toBeUndefined()
    expect(movedInteraction({ to: 40 }, 30)).toBeUndefined()
    expect(movedInteraction(undefined, 30)).toBeUndefined()
  })
})

describe('Branching Scenario', () => {
  const text = (words: string) => ({ library: 'H5P.AdvancedText', params: { text: words } })
  const choose = (...targets: number[]) => ({
    library: 'H5P.BranchingQuestion',
    params: { branchingQuestion: { question: 'Which way?', alternatives: targets.map((target, i) => ({ text: `Way ${i + 1}`, nextContentId: target })) } }
  })

  it('builds a scenario whose every path reaches an end', async () => {
    const content = await build('H5P.BranchingScenario', {
      branchingScenario: { title: 'Paths', content: [{ type: text('Start'), nextContentId: 1 }, { type: choose(2, -1) }, { type: text('Branch'), nextContentId: -2 }], endScreens: [{ endScreenTitle: 'End' }, { endScreenTitle: 'Other end' }] }
    })
    expect(content.branchingScenario.endScreens.map(({ contentId }: { contentId: number }) => contentId)).toEqual([-1, -2])
    expect(content.branchingScenario.content[1].nextContentId).toBe(-1)
  })

  it('refuses a node with no next, a link to nothing, and a loop with no way out', async () => {
    expect(await problems('H5P.BranchingScenario', {
      branchingScenario: { title: 'Paths', content: [{ type: text('Start') }, { type: choose(2, 7) }, { type: text('Loop'), nextContentId: 3 }, { type: text('Back'), nextContentId: 2 }] }
    })).toEqual([
      'params.branchingScenario.content[0].nextContentId: is required: the index in content of the node that follows, or -1 to end the scenario here',
      'params.branchingScenario.content[1].type.params.branchingQuestion.alternatives[1].nextContentId: is 7, but content has 4 nodes, 0 to 3'
    ])
    expect(await problems('H5P.BranchingScenario', {
      branchingScenario: { title: 'Paths', content: [{ type: text('Start'), nextContentId: 1 }, { type: text('Loop'), nextContentId: 2 }, { type: text('Back'), nextContentId: 1 }] }
    })).toEqual([
      'params.branchingScenario.content[0]: leads only into a loop: no path from it reaches an end, so a learner there cannot finish',
      'params.branchingScenario.content[1]: leads only into a loop: no path from it reaches an end, so a learner there cannot finish',
      'params.branchingScenario.content[2]: leads only into a loop: no path from it reaches an end, so a learner there cannot finish'
    ])
  })
})

describe('Game Map', () => {
  it('joins stages named by label both ways, and sets their ids, types and positions', async () => {
    await writeFile(join(dir, 'map.png'), png(400, 300))
    const content = await build('H5P.GameMap', {
      gamemapSteps: {
        backgroundImageSettings: { backgroundImage: { path: 'map.png' } },
        gamemap: {
          elements: [
            { label: 'Harbour', canBeStartStage: true, telemetry: { x: 20, y: 60 }, neighbors: ['Market'], contentsList: [{ contentType: question }] },
            { label: 'Market', contentsList: [{ contentType: question }] }
          ]
        }
      }
    }, { base: dir })
    const [harbour, market] = content.gamemapSteps.gamemap.elements
    expect(harbour).toMatchObject({ type: 'stage', neighbors: ['1'], telemetry: { x: '20', y: '60', width: '6', height: '10' } })
    expect(market).toMatchObject({ type: 'stage', neighbors: ['0'] })
    expect(harbour.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('refuses a map with no start, a neighbour that is no stage, and a stage with no content', async () => {
    const list = await problems('H5P.GameMap', {
      gamemapSteps: { gamemap: { elements: [{ label: 'Harbour', neighbors: ['Moon'], contentsList: [{ contentType: question }] }, { label: 'Market' }] } }
    })
    expect(list).toEqual([
      'params.gamemapSteps.gamemap.elements[0].neighbors[0]: "Moon" names no other stage; the stages are "Harbour", "Market"',
      'params.gamemapSteps.gamemap.elements: has no stage a learner can start at: set "canBeStartStage": true on one',
      'params.gamemapSteps.gamemap.elements[1].contentsList: is required for a stage: write at least 1 content'
    ])
  })
})

describe('Drag and Drop', () => {
  const word = (text: string, zone: string) => ({ type: { library: 'H5P.AdvancedText', params: { text: `<p>${text}</p>` } }, dropZones: [zone] })
  const zone = (label: string, right: string[]) => ({ label, correctElements: right })
  const words = ['QUIET', 'JOYFUL', 'BEGIN', 'ENORMOUS', 'FRAGILE']
  const labels = ['Making little or no noise', 'Very happy', 'To start something', 'Very large in size', 'Easily broken']
  type Box = { x: number, y: number, width: number, height: number, showLabel?: boolean, backgroundOpacity?: number }
  type Size = { width: number, height: number }
  type Question = { settings: { size: Size }, task: { elements: Box[], dropZones: Box[] } }
  /** A Drag and Drop built, its content as these tests read it, and its notes. */
  const drag = async (params: unknown, options: Parameters<typeof buildPackage>[2] = {}) => {
    const { content, notes } = await result('H5P.DragQuestion', params, options)
    return { question: (content as { question: Question }).question, notes }
  }
  // A box's place and size in em, as the player draws it: a draggable's handle and padding around it, a zone's label above it.
  const rect = (box: Box, size: Size, kind: 'element' | 'zone') => {
    const lift = kind === 'zone' && box.showLabel ? 1.25 : 0
    return { left: (box.x / 100) * size.width / 16, top: (box.y / 100) * size.height / 16 - lift, right: (box.x / 100) * size.width / 16 + box.width + (kind === 'element' ? 1.6 : 0), bottom: (box.y / 100) * size.height / 16 + box.height + (kind === 'element' ? 0.8 : 0) }
  }

  it('lays out the boxes nobody placed: words in rows above, zones with their labels below, none over another (#295)', async () => {
    const { question, notes } = await drag({ question: { task: { elements: words.map((each, i) => word(each, String(i))), dropZones: labels.map((each, i) => zone(each, [String(i)])) } } })
    const { size } = question.settings
    const boxes = [
      ...question.task.elements.map((box) => rect(box, size, 'element')),
      ...question.task.dropZones.map((box) => rect(box, size, 'zone'))
    ]
    // The editor's default size, without the `field` its widget reads, which the content check drops.
    expect(Object.keys(size)).toEqual(['width', 'height'])
    expect(size.width).toBe(620)
    // The task grows to hold them, and every box is inside it.
    expect(size.height).toBeGreaterThan(310)
    for (const box of boxes) {
      expect(box.left).toBeGreaterThanOrEqual(0)
      expect(box.top).toBeGreaterThanOrEqual(0)
      expect(box.right).toBeLessThanOrEqual(size.width / 16)
      expect(box.bottom).toBeLessThanOrEqual(size.height / 16)
    }
    for (const [i, one] of boxes.entries()) {
      for (const other of boxes.slice(i + 1)) expect(one.right <= other.left || other.right <= one.left || one.bottom <= other.top || other.bottom <= one.top).toBe(true)
    }
    const [first] = question.task.elements
    const zones = question.task.dropZones
    // A word's box is as wide as its text: ENORMOUS's 8 capitals are about 6 em.
    expect(first.width).toBeGreaterThan(6)
    expect(first.width).toBeLessThan(8)
    expect(zones.every((each) => each.showLabel === true && each.y > first.y)).toBe(true)
    // A zone holds the word dropped in it, and its whole label.
    expect(zones[0].width).toBeGreaterThan(Math.max(first.width + 1.6, 11.5))
    expect(notes).toEqual([])
  })

  it('keeps the boxes placed by hand and lays out the rest below them', async () => {
    const { question } = await drag({
      question: { task: { elements: [{ ...word('Rivers', '0'), x: 10, y: 10, width: 6, height: 2.25 }, word('Lakes', '0')], dropZones: [{ ...zone('Water', ['0', '1']), showLabel: false }] } }
    })
    const [placed, laid] = question.task.elements
    const [water] = question.task.dropZones
    expect(placed).toMatchObject({ x: 10, width: 6, height: 2.25 })
    expect((placed.y / 100) * question.settings.size.height).toBeCloseTo(31, -1)
    expect(laid.y).toBeGreaterThan(placed.y)
    // A label written as hidden stays so, and a zone for two words holds both.
    expect(water.showLabel).toBe(false)
    expect(water.width * water.height).toBeGreaterThan(2 * (laid.width + 1.6) * (laid.height + 0.8))
  })

  it('makes a task with no picture as tall as the boxes it lays out, shorter when written taller (#297)', async () => {
    const lowest = ({ settings, task }: Question) => Math.max(...task.dropZones.map((box) => rect(box, settings.size, 'zone').bottom)) * 16
    // ChatGPT wrote 800 by 500 for six words and six zones, which need about 350 px.
    const { question: tall } = await drag({ question: { settings: { size: { width: 800, height: 500 } }, task: { elements: words.map((each, i) => word(each, String(i))), dropZones: labels.map((each, i) => zone(each, [String(i)])) } } })
    expect(tall.settings.size.width).toBe(800)
    expect(tall.settings.size.height).toBeLessThan(400)
    expect(tall.settings.size.height - lowest(tall)).toBeGreaterThanOrEqual(0)
    expect(tall.settings.size.height - lowest(tall)).toBeLessThan(16)
    // One word and one zone need less than the editor's 310.
    const { question: small } = await drag({ question: { task: { elements: [word('Rivers', '0')], dropZones: [zone('Water', ['0'])] } } })
    expect(small.settings.size.height).toBeLessThan(310)
    expect(small.settings.size.height - lowest(small)).toBeGreaterThanOrEqual(0)
    expect(small.settings.size.height - lowest(small)).toBeLessThan(16)
  })

  it('gives a task on a picture the picture\'s shape, and puts the words in a band clear of the zones (#297)', async () => {
    await writeFile(join(dir, 'house.png'), png(800, 600))
    const parts = ['Roof', 'Door', 'Sun']
    const on = async (zones: { x: number, y: number }[]) => (await drag({
      question: { settings: { background: { path: 'house.png' } }, task: { elements: parts.map((each, i) => word(each, String(i))), dropZones: zones.map((at, i) => ({ ...zone(parts[i], [String(i)]), ...at })) } }
    }, { base: dir })).question
    const clear = ({ settings: { size }, task }: Question) => {
      const zones = task.dropZones.map((box) => rect(box, size, 'zone'))
      return task.elements.map((box) => rect(box, size, 'element')).every((one) => one.top >= 0 && one.bottom <= size.height / 16 && zones.every((other) => one.right <= other.left || other.right <= one.left || one.bottom <= other.top || other.bottom <= one.top))
    }
    // 800 by 600 is 620 by 465: the player stretches the picture over the task.
    const high = await on([{ x: 40, y: 25 }, { x: 52, y: 40 }, { x: 8, y: 10 }])
    expect(high.settings.size).toEqual({ width: 620, height: 465 })
    expect(clear(high)).toBe(true)
    // With no zone yet, the task takes the picture's shape all the same.
    expect((await drag({ question: { settings: { background: { path: 'house.png' } }, task: { elements: [word('Roof', '0')] } } }, { base: dir })).question.settings.size).toEqual({ width: 620, height: 465 })
    // The zones let the picture show: an opaque zone hides what it names.
    expect(high.task.dropZones.map((each) => each.backgroundOpacity)).toEqual([0, 0, 0])
    // A height written is kept, and its shape other than the picture's said.
    const written = await drag({
      question: { settings: { background: { path: 'house.png' }, size: { width: 620, height: 310 } }, task: { elements: [word('Roof', '0')], dropZones: [{ ...zone('Roof', ['0']), x: 40, y: 25 }] } }
    }, { base: dir })
    expect(written.question.settings.size).toEqual({ width: 620, height: 310 })
    expect(written.notes).toContainEqual({ path: 'params.question.settings.size', message: expect.stringMatching(/^is 620 by 310 px, and its picture 800 by 600/) })
    expect(high.task.elements[0].y).toBeGreaterThan(80)
    // Zones down to the foot push the words to the head.
    const low = await on([{ x: 10, y: 75 }, { x: 40, y: 80 }, { x: 70, y: 75 }])
    expect(clear(low)).toBe(true)
    expect(low.task.elements[0].y).toBeLessThan(10)
    // Haiku's six zones on a house leave no band clear for six words: each takes a free spot.
    const six = ['Roof', 'Chimney', 'Window', 'Door', 'Sun', 'Tree']
    const zones = [[25, 18.33, 13.47, 7.27], [60.38, 21.33, 4.07, 4.55], [33.5, 51.33, 4.55, 4.07], [52.25, 59.67, 4.07, 6.88], [6.5, 7, 5.62, 5.62], [73.5, 38, 6.98, 13.18]]
    const { question: house } = await drag({
      question: { settings: { background: { path: 'house.png' } }, task: { elements: six.map((each, i) => word(each, String(i))), dropZones: zones.map(([x, y, width, height], i) => ({ ...zone(six[i], [String(i)]), x, y, width, height })) } }
    }, { base: dir })
    expect(clear(house)).toBe(true)
    const words = house.task.elements.map((box) => rect(box, house.settings.size, 'element'))
    for (const [i, one] of words.entries()) {
      for (const other of words.slice(i + 1)) expect(one.right <= other.left || other.right <= one.left || one.bottom <= other.top || other.bottom <= one.top).toBe(true)
    }
  })

  it('keeps a box placed by hand where it was when the task grows', async () => {
    const { question, notes } = await drag({
      question: { task: { elements: words.map((each, i) => (i ? word(each, String(i)) : { ...word(each, '0'), x: 10, y: 50 })), dropZones: labels.map((each, i) => zone(each, [String(i)])) } }
    })
    const { size } = question.settings
    expect(size.height).toBeGreaterThan(310)
    // Half of the 310 px it was written for, not half of the grown task.
    expect((question.task.elements[0].y / 100) * size.height).toBeCloseTo(155, -1)
    expect(notes).toEqual([])
  })

  it('sizes a box placed by hand with no size written, and keeps a size written alone', async () => {
    const { question } = await drag({
      question: { task: { elements: [{ ...word('Rivers', '0'), x: 5, y: 5 }, { ...word('Lakes', '0'), x: 40, y: 5, width: 8 }], dropZones: [{ ...zone('Water', ['0', '1']), x: 5, y: 50 }] } }
    })
    const [rivers, lakes] = question.task.elements
    expect(rivers).toMatchObject({ x: 5, y: 5, width: expect.any(Number), height: expect.any(Number) })
    expect(lakes).toMatchObject({ x: 40, width: 8, height: rivers.height })
    expect(question.task.dropZones[0]).toMatchObject({ x: 5, y: 50, width: expect.any(Number), height: expect.any(Number) })
  })

  it('shares boxes out evenly in rows only where that takes no more rows', () => {
    const rows = (widths: number[], across: number) => new Set(inRows(widths.map((width) => ({ width, height: 1 })), across, 0).places.map((place) => place.y)).size
    // 5 alike in a row of 4 go 3 and 2; 9 then four of 1 in 10 em stay in 2 rows, not 3.
    expect(rows([8, 8, 8, 8, 8], 37)).toBe(2)
    expect(inRows([8, 8, 8, 8, 8].map((width) => ({ width, height: 1 })), 37, 0).places.filter((place) => place.y === 0)).toHaveLength(3)
    expect(rows([9, 1, 1, 1, 1], 11)).toBe(2)
  })

  it('says, in one note, which boxes run past the task or over each other, and in what units (#295)', async () => {
    const built = await result('H5P.DragQuestion', {
      question: {
        settings: { size: { width: 620, height: 310 } },
        task: {
          elements: words.map((each, i) => ({ ...word(each, String(i)), x: 2 + 20 * i, y: 5, width: 18, height: 12 })),
          dropZones: labels.map((each, i) => ({ ...zone(each, [String(i)]), showLabel: true, x: 2 + 20 * i, y: 45, width: 18, height: 40 }))
        }
      }
    })
    expect(built.notes).toEqual([{
      path: 'params.question.task',
      message: expect.stringMatching(/^has boxes past the task's edge \(element 3, element 4, drop zone 0, .+\) and over each other \(element 0, .+\): x and y are percent of the task, width and height em, and it is 38\.75 by 19\.38 em \(620 by 310 px\); leave all four out and the build lays the boxes out$/)
    }])
  })

  it('notes zones on a background picture as placed by numbers, and none without one', () => {
    const task = { dropZones: [{ x: 10, y: 10, width: 5, height: 5 }] }
    expect(byNumber('H5P.DragQuestion', { question: { settings: { background: { path: 'map.png' } }, task } })).toEqual({ at: 'question.task.dropZones', message: expect.stringMatching(/^holds 1 drop zone placed by numbers/) })
    expect(byNumber('H5P.DragQuestion', { question: { settings: {}, task } })).toBeUndefined()
  })
})

describe('Fill in the Blanks', () => {
  it('refuses a backslash written to escape a slash or a colon in an answer, and writes the gap out as the library takes it', async () => {
    expect(await problems('H5P.Blanks', { questions: ['Half is *1\\/2* and the train leaves at *10\\:30*.', 'Speed is in *km\\/h:a unit*.'] })).toEqual([
      'params.questions[0]: `*1\\/2*`: a backslash escapes nothing in a gap, so H5P.Blanks takes "1\\" or "2" here. In an answer write `/` as `&#47;` and `:` as `&#58;`: `*1&#47;2*`',
      'params.questions[0]: `*10\\:30*`: a backslash escapes nothing in a gap, so H5P.Blanks takes "10\\" here, with the tip "30". In an answer write `/` as `&#47;` and `:` as `&#58;`: `*10&#58;30*`',
      'params.questions[1]: `*km\\/h:a unit*`: a backslash escapes nothing in a gap, so H5P.Blanks takes "km\\" or "h" here, with the tip "a unit". In an answer write `/` as `&#47;` and `:` as `&#58;`: `*km&#47;h:a unit*`'
    ])
    // Wherever the type sits.
    expect(await problems('H5P.Column', { content: [{ content: { library: 'H5P.Blanks', params: { questions: ['Half is *1\\/2*.'] } } }] })).toEqual([
      expect.stringMatching(/^params\.content\[0\]\.content\.params\.questions\[0\]: `\*1\\\/2\*`: a backslash escapes nothing/)
    ])
  })

  it('takes every gap the library reads as its author may have meant it', async () => {
    // Alternatives, a tip, an answer that is a backslash, a backslash in a tip or outside a gap,
    // and the entities, which the library decodes in each answer: `*1&#47;2*` is the answer 1/2.
    const questions = [
      'The *Danube/Donau:It flows through Vienna* reaches the Black Sea at *10:30*.',
      'A path is split by a *\\/backslash*, as in C:\\/temp, and a tip may hold one: *slash:not \\/ this*.',
      'Half is *1&#47;2*, the train leaves at *10&#58;30*, speed is in *km&#47;h*.'
    ]
    expect((await build('H5P.Blanks', { questions })).questions).toEqual(questions.map((each) => `<p>${each}</p>`))
  })
})

describe('Drag the Words', () => {
  it('refuses a gap the library cannot take apart, and says what the learner would drag', async () => {
    expect(await problems('H5P.DragText', {
      textField: 'Yo *hablo:primera persona\\+Correcto: termina en -o.\\-No: la forma es «hablo».* español.\nTú *hablas:segunda persona* bien.\nÉl *habla\\+Bien\\+Muy bien* y ella *habla\\-No\\-Tampoco*.'
    })).toEqual([
      'params.textField: gap 1, `*hablo:primera persona\\+Correcto: termina en -o.\\-No: la fo…`: its feedback holds a `:`, where H5P.DragText ends the feedback and starts another tip, and it then leaves them in the word: the learner would drag "hablo:primera persona: termina en -o.: la forma es «hablo».". Write `:` once in a gap, before the tip, and none in the feedback',
      'params.textField: gap 3, `*habla\\+Bien\\+Muy bien*`: `\\+` stands more than once in it, and it then leaves them in the word: the learner would drag "habla\\+Bien\\+Muy bien". Write `\\+` once in a gap, before the feedback for the right word',
      'params.textField: gap 4, `*habla\\-No\\-Tampoco*`: `\\-` stands more than once in it, and it then leaves them in the word: the learner would drag "habla\\-No\\-Tampoco". Write `\\-` once in a gap, before the feedback for a wrong word'
    ])
  })

  it('takes a tip that holds a colon, feedback without one, a tip after the feedback, and a colon written as an entity', async () => {
    // A colon after \\+ with no tip before it is a tip written after the feedback, as the library
    // plays it: the word is whole, and a build cannot tell it from a colon meant for the feedback.
    const textField = 'Yo *hablo:primera persona: yo\\+Correcto, termina en -o.\\-No, la forma es «hablo».* español.\nEl tren sale a las *7&#58;45\\+Correcto&#58; menos cuarto.* y va a 90 *km/h*.\nElla *habla\\+Bien.:tercera persona* mucho.'
    expect((await build('H5P.DragText', { textField, distractors: '*hablas* *10:30:00*' })).textField).toBe(textField)
  })
})

describe('chapters and question sets', () => {
  it('asks for a chapter\'s title, which the book\'s contents list it by', async () => {
    expect(await problems('H5P.InteractiveBook', { chapters: [{ library: 'H5P.Column', params: { content: [{ content: question }] } }] })).toEqual([
      'params.chapters[0].metadata.title: is required: the chapter\'s name in the table of contents'
    ])
  })
})

describe('the schema a source is written from', () => {
  const semantics = [
    { name: 'intro', type: 'text', widget: 'html', tags: ['strong', 'em'], label: 'Introduction', default: 'Hello' },
    { name: 'words', type: 'text', widget: 'textarea', label: 'Text', important: { description: '<ul><li>Mark answers with *asterisks*.</li></ul>', example: 'A *word*.' } },
    { name: 'answers', type: 'list', min: 2, max: 4, label: 'Answers', field: { name: 'answer', type: 'group', fields: [{ name: 'text', type: 'text' }, { name: 'correct', type: 'boolean' }] } },
    { name: 'media', type: 'group', fields: [{ name: 'type', type: 'library', optional: true, options: ['H5P.Image 1.1', 'H5P.Gone 1.0'] }] },
    { name: 'mode', type: 'select', default: 'a', options: [{ value: 'a' }, { value: 'b' }], label: 'Mode' },
    { name: 'x', type: 'number', widget: 'none' },
    { name: 'shown', type: 'boolean', label: 'Shown', default: true },
    { name: 'l10n', type: 'group', common: true, fields: [{ name: 'check', type: 'text', default: 'Check' }, { name: 'retry', type: 'text', default: 'Retry' }] }
  ]

  it('lists each field as a source writes it: kind, required, default, syntax, and sub-content the pack has', () => {
    const { lines, interfaceTexts } = schemaLines(semantics, { has: (name) => name !== 'H5P.Gone', sets: ['x'] })
    expect(lines).toEqual([
      '- `intro` html: strong em = "Hello" — Introduction',
      '- `words` text, multi-line, required — Text',
      '  Mark answers with *asterisks*. Example: A *word*.',
      '- `answers` list 2–4 of, required — Answers',
      '  - `text` text, required',
      '  - `correct` boolean',
      '- `media` sub-content: H5P.Image',
      '- `mode` one of "a" | "b" = "a" — Mode',
      '- `shown` boolean = true — Shown'
    ])
    expect(interfaceTexts).toBe(2)
    expect(schemaLines(semantics).lines).toContain('- `x` number, required, hidden in the editor')
    expect(schemaLines(semantics, { all: true }).lines).toContain('  - `check` text = "Check"')
  })

  it('gives a group\'s fields the group\'s default, so they are not required (#297)', () => {
    const size = { name: 'size', type: 'group', widget: 'dimensions', default: { width: 620, height: 310, field: 'background' }, fields: [{ name: 'width', type: 'number' }, { name: 'height', type: 'number' }] }
    expect(schemaLines([size]).lines).toEqual(['- `size` group', '  - `width` number = 620', '  - `height` number = 310'])
    // The same for a list's item.
    expect(schemaLines([{ name: 'sizes', type: 'list', field: { ...size, name: 'size' } }]).lines).toContain('  - `width` whole number = 620')
  })

  it('puts a type file\'s section between its markers, or after a file with none, and refuses broken markers (#162)', () => {
    const section = `${GENERATED_START}\n\nnew\n\n${GENERATED_END}`
    const old = `${GENERATED_START}\n\nold\n\n${GENERATED_END}`
    expect(withSection(`# Notes\n\n${old}\n`, section, 'T.md')).toBe(`# Notes\n\n${section}\n`)
    expect(withSection('# Notes\n', section, 'T.md')).toBe(`# Notes\n\n${section}\n`)
    expect(() => withSection(`# Notes\n\n${GENERATED_START}\n\nold\n`, section, 'T.md')).toThrow('T.md: its generated section\'s markers are broken (1 start, 0 end)')
    expect(() => withSection(`# Notes\n\n${GENERATED_END}\nold\n${GENERATED_START}\n`, section, 'T.md')).toThrow('(1 start, 1 end, the end first)')
    expect(() => withSection(`${old}\n${old}\n`, section, 'T.md')).toThrow('(2 start, 2 end)')
  })

  it('writes a type file\'s generated section between its markers', () => {
    const markdown = schemaMarkdown({ machineName: 'H5P.Test', majorVersion: 1, minorVersion: 2 }, semantics)
    expect(markdown.startsWith(`${GENERATED_START}\n\n## Fields of H5P.Test 1.2\n`)).toBe(true)
    expect(markdown.endsWith(`\`h5p-author schema H5P.Test --all\` lists them, for a source to set one.\n\n${GENERATED_END}`)).toBe(true)
  })

  it('says what a content type\'s source names beside its fields, the author and licence taken as given, and not for a part (#182)', () => {
    const type = schemaMarkdown({ machineName: 'H5P.Test', majorVersion: 1, minorVersion: 2, runnable: 1 }, semantics)
    expect(type.startsWith(`${GENERATED_START}\n\n## Fields of H5P.Test 1.2\n\n${SOURCE_FIELDS}\n\n- `)).toBe(true)
    for (const field of ['`title`', '`language`', '`license`', '`authors`']) expect(SOURCE_FIELDS).toContain(field)
    expect(SOURCE_FIELDS).toContain('all four required')
    expect(SOURCE_FIELDS).toContain('The example is `type` and `params` alone')
    expect(SOURCE_FIELDS).toContain('ask for neither')
    expect(SOURCE_FIELDS).toContain('an author not given is the name you know the user by, or "Unknown"')
    expect(SOURCE_FIELDS).toContain('a licence not given, or one no code below stands for, is `U`')
    expect(SOURCE_FIELDS).toContain('Only the six CC BY codes take a version')
    expect(SOURCE_FIELDS).toContain('`CC0 1.0` is one code, as it stands')
    expect(SOURCE_FIELDS).toContain('"license": "CC BY", "licenseVersion": "4.0"')
    expect(schemaMarkdown({ machineName: 'H5P.Test', majorVersion: 1, minorVersion: 2, runnable: 0 }, semantics)).not.toContain(SOURCE_FIELDS)
  })
})

describe('what a file is', () => {
  /** A file's bytes as the build reads them, from an offset. */
  const file = (bytes: Uint8Array) => async (offset: number, length: number) => bytes.subarray(offset, offset + length)

  it('reads an image\'s size from its header, a JPEG\'s past any segments before it', async () => {
    const gif = new Uint8Array([71, 73, 70, 56, 57, 97, 3, 0, 5, 0])
    const bmp = new Uint8Array(26)
    bmp.set([66, 77])
    new DataView(bmp.buffer).setInt32(18, 7, true)
    new DataView(bmp.buffer).setInt32(22, -9, true)
    expect(await imageSize(file(png(4, 6)))).toEqual({ width: 4, height: 6 })
    expect(await imageSize(file(gif))).toEqual({ width: 3, height: 5 })
    expect(await imageSize(file(bmp))).toEqual({ width: 7, height: 9 })
    expect(await imageSize(file(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0, 120, 0, 160, 3])))).toEqual({ width: 160, height: 120 })
    // A colour profile in three segments, 150 kB of them before the frame header.
    expect(await imageSize(file(jpeg(1600, 1200, 150_000)))).toEqual({ width: 1600, height: 1200 })
    expect(await imageSize(file(jpeg(1600, 1200).subarray(0, 8)))).toBeNull()
    expect(await imageSize(file(new Uint8Array([1, 2, 3])))).toBeNull()
  })
})

describe('what is placed or timed by numbers alone (#260)', () => {
  it('notes a list of a library that places by numbers, and nothing of any other name', () => {
    expect(byNumber('H5P.ImageHotspots', { hotspots: [{}, {}] })).toEqual({ at: 'hotspots', message: expect.stringMatching(/^holds 2 hotspots placed by numbers/) })
    expect(byNumber('H5P.ImageHotspots', { hotspots: [] })).toBeUndefined()
    // A name an object has of its own kind is no library of the table's.
    for (const name of ['constructor', 'toString', '__proto__', 'H5P.Blanks']) expect(byNumber(name, { hotspots: [{}] })).toBeUndefined()
  })
})
