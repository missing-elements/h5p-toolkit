import { execFile } from 'node:child_process'
import { cp, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { BlobReader, TextWriter, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js'
import { pack } from '@missing-elements/h5p-libraries'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { toJSONSchema } from 'zod/mini'
import { buildPackage, coreApiLine, coreApiOf, describeMedia, lengthLine, librariesIn, mediaLine, missingForInstall, SourceError, sourceSchema } from '../lib/author.mjs'
import { readSource } from '../lib/build.mjs'
import { LICENSES } from '../lib/metadata.mjs'
import { MediaStore } from '../lib/media.mjs'
import { ALT_TEXTS } from '../lib/mistakes.mjs'
import { nodeMedia } from '../lib/node.mjs'
import { quizProblems } from '../lib/quiz.mjs'
import { jpeg, mp4, png } from './helpers/media'

// The quiz format's two examples, from the skill that first wrote it.
const fixtures = resolve(import.meta.dirname, 'fixtures')
const parts = resolve(import.meta.dirname, '../../libraries/parts')
const bin = resolve(import.meta.dirname, '../bin/h5p-author.mjs')
const example = JSON.parse(await readFile(join(fixtures, 'quiz.json'), 'utf8'))
const scenarios = JSON.parse(await readFile(join(fixtures, 'phishing-scenarios.json'), 'utf8'))
const exec = promisify(execFile)
const META = { title: 'Rivers', language: 'en', license: 'CC BY', authors: [{ name: 'Ann Author', role: 'Author' }] }
let dir: string
let count = 0

beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'h5p-author-test-')) })
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

async function archive(path: string | URL) {
  const reader = new ZipReader(new BlobReader(new Blob([await readFile(path)])), { checkSignature: true })
  try {
    const entries = (await reader.getEntries()).filter(entry => !entry.directory)
    const files = new Map<string, string>()
    // Decode every file independently; a copied entry must retain its CRC and compression method.
    for (const entry of entries) files.set(entry.filename, await entry.getData(new TextWriter()))
    return { files, entries }
  } finally { await reader.close() }
}

/** Builds a source, and reads its content back from the archive written. */
async function build(source: unknown, options: Parameters<typeof buildPackage>[2] = {}) {
  const path = join(dir, `build-${++count}.h5p`)
  const result = await buildPackage(source, path, options)
  const { files, entries } = await archive(path)
  return { ...result, files, entries, content: JSON.parse(files.get('content/content.json')!), manifest: JSON.parse(files.get('h5p.json')!) }
}

/** The problems a source has, as `path: message`. */
async function problems(source: unknown, options: Parameters<typeof buildPackage>[2] = {}) {
  const error = await buildPackage(source, join(dir, `failed-${++count}.h5p`), options).then(() => null, (error: unknown) => error)
  expect(error).toBeInstanceOf(SourceError)
  return (error as SourceError).problems.map(({ path, message }) => `${path}: ${message}`)
}

type Field = { name: string, type: string, default?: unknown, fields?: Field[] }
type Translated = { default?: string, fields?: Translated[] }

/** A library's English and translated default for a field, named in its semantics, read from the pack's part. */
async function defaults(machineName: string, code: string, path: string[]) {
  const library = pack.libraries.find(library => library.machineName === machineName && library.majorVersion === 1)!
  const { files } = await archive(new URL(library.url))
  let fields: Field[] = JSON.parse(files.get(`${library.folder}/semantics.json`)!)
  let translation: Translated[] = JSON.parse(files.get(`${library.folder}/language/${code}.json`)!).semantics
  let field: Field | undefined
  let translated: Translated | undefined
  for (const name of path) {
    const i = fields.findIndex(candidate => candidate.name === name)
    field = fields[i]
    translated = translation[i]
    fields = field.fields ?? []
    translation = translated.fields ?? []
  }
  return { english: field!.default, translated: translated!.default }
}

describe('the quiz format', () => {
  it('accepts both kinds, multiple correct answers, and a zero pass threshold', () => {
    expect(quizProblems(example)).toEqual([])
    expect(quizProblems({ ...example, kind: 'multiple-choice', passPercentage: 0, questions: [example.questions[0]] })).toEqual([])
    // A quiz without a pass mark, and so without its messages, as before they existed.
    expect(quizProblems({ ...example, passPercentage: undefined, passedFeedback: undefined, failedFeedback: undefined })).toEqual([])
  })

  it.each([
    [null, 'source: expected an object'],
    [{ ...example, kind: 'slides' }, 'quiz.kind'],
    [{ ...example, title: '' }, 'quiz.title'],
    [{ ...example, title: 'a'.repeat(256) }, 'quiz.title'],
    [{ ...example, language: 'not_a_tag' }, 'quiz.language'],
    [{ ...example, license: 'made-up' }, 'quiz.license'],
    [{ ...example, authors: [] }, 'quiz.authors'],
    [{ ...example, authors: [{ name: 'A', role: 'Editor' }] }, 'quiz.authors[0].role'],
    [{ ...example, passPercentage: 101 }, 'quiz.passPercentage'],
    [{ ...example, passPercentage: '50' }, 'quiz.passPercentage'],
    [{ ...example, failedFeedback: undefined }, 'quiz.failedFeedback: set passedFeedback and failedFeedback together'],
    [{ ...example, passedFeedback: undefined }, 'quiz.passedFeedback: set passedFeedback and failedFeedback together'],
    [{ ...example, passedFeedback: ' ' }, 'quiz.passedFeedback: expected non-empty text'],
    [{ ...example, passPercentage: undefined }, 'quiz.passPercentage: set it with passedFeedback and failedFeedback'],
    [{ ...example, questions: [] }, 'quiz.questions'],
    [{ ...example, kind: 'multiple-choice' }, 'exactly one question'],
    [{ ...example, customJs: 'evil.js' }, 'quiz.customJs: unsupported field'],
    [{ ...example, questions: [null] }, 'quiz.questions[0]'],
    [{ ...example, questions: [{ ...example.questions[0], prompt: '' }] }, 'quiz.questions[0].prompt'],
    [{ ...example, questions: [{ ...example.questions[0], multipleAnswers: 'yes' }] }, 'quiz.questions[0].multipleAnswers'],
    [{ ...example, questions: [{ ...example.questions[0], answers: [] }] }, 'at least two answers'],
    [{ ...example, questions: [{ ...example.questions[0], answers: [{ text: 'a', correct: 'true' }, { text: 'b', correct: false }] }] }, '.correct'],
    [{ ...example, questions: [{ ...example.questions[0], answers: [{ text: 'a', correct: true }, { text: 'b', correct: true }] }] }, 'exactly one answer'],
    [{ ...example, questions: [{ ...example.questions[0], multipleAnswers: true, answers: [{ text: 'a', correct: false }, { text: 'b', correct: false }] }] }, 'at least one answer'],
    [{ ...example, questions: [{ ...example.questions[0], answers: [{ text: 'a', correct: true, typo: 'lost' }, { text: 'b', correct: false }] }] }, '.typo: unsupported field']
  ])('rejects malformed input with its field path (%#)', (input, message) => {
    expect(() => readSource(input)).toThrow(SourceError)
    expect(() => readSource(input)).toThrow(message)
  })

  it('lists every problem a quiz has at once, each by its path', () => {
    const quiz = { ...example, title: '', license: 'made-up', questions: [{ ...example.questions[0], prompt: '' }, { ...example.questions[1], answers: [{ text: 'a', correct: true }] }] }
    expect(quizProblems(quiz).map(({ path, message }) => `${path}: ${message}`)).toEqual([
      'quiz.title: expected non-empty text',
      'quiz.license: use an H5P license code (for example "U", "CC BY", or "CC0 1.0")',
      'quiz.questions[0].prompt: expected non-empty text',
      'quiz.questions[1].answers: at least two answers are required'
    ])
  })

  it('builds a self-contained Question Set using pack versions, semantics defaults, and the full dependency closure', async () => {
    const { files, content, manifest, translations, libraries, install } = await build(example)
    expect([...files.keys()][0]).toBe('h5p.json')
    // The content comes after the libraries that play; only what an H5P site's upload check wants follows it (#146).
    expect([...files.keys()].filter(name => !install.includes(name.slice(0, name.indexOf('/')))).at(-1)).toBe('content/content.json')
    expect(manifest.mainLibrary).toBe('H5P.QuestionSet')
    expect(manifest.defaultLanguage).toBe(example.language)
    expect(manifest.authors).toEqual(example.authors)
    expect(content.passPercentage).toBe(100)
    expect(content.texts.finishButton).toBeTruthy()
    expect(content.endGame.showResultPage).toBe(true)
    // The pass mark as the set's own score ranges, escaped as H5P stores a text field; the rest
    // of the result page keeps its defaults, and no question inside gets the quiz's message.
    expect(content.endGame.overallFeedback).toEqual([
      { from: 0, to: 99, feedback: 'Not passed yet. Read each answer&#39;s feedback, then select Retry.' },
      { from: 100, to: 100, feedback: 'Passed. You chose the safe response every time.' }
    ])
    expect(content.endGame.retryButtonText).toBe('Retry')
    // English is the libraries' own; no file stands in for it.
    expect(translations.map(({ translation }) => translation)).toEqual([null, null])
    for (const question of content.questions) expect((question.params.overallFeedback ?? []).filter((range: { feedback?: string }) => range.feedback)).toEqual([])
    expect(content.questions).toHaveLength(2)
    expect(content.questions[0].params.question).toContain(example.questions[0].prompt)
    expect(content.questions[0].params.UI.checkAnswerButton).toBe('Check')
    expect(content.questions[0].params.behaviour.type).toBe('single')
    expect(content.questions[1].params.behaviour.type).toBe('multi')
    expect(content.questions[0].metadata).toMatchObject({ contentType: 'Multiple Choice', license: example.license })
    const ids = content.questions.map((question: { subContentId: string }) => question.subContentId)
    expect(new Set(ids).size).toBe(2)
    expect(ids.every((id: string) => /^[0-9a-f-]{36}$/.test(id))).toBe(true)
    expect(libraries.length).toBeGreaterThan(2)
    expect(libraries.length).toBeLessThan(30)
    for (const dependency of manifest.preloadedDependencies) {
      expect(files.has(`${dependency.machineName}-${dependency.majorVersion}.${dependency.minorVersion}/library.json`)).toBe(true)
    }
    for (const [name, json] of files) {
      // The libraries that play; what an H5P site's upload check wants follows the content (#146).
      if (!name.endsWith('/library.json') || install.includes(name.slice(0, name.indexOf('/')))) continue
      const library = JSON.parse(json)
      expect(library.machineName).not.toMatch(/H5PEditor/)
      for (const dependency of [...(library.preloadedDependencies ?? []), ...(library.dynamicDependencies ?? [])]) {
        const available = manifest.preloadedDependencies.find((candidate: { machineName: string, majorVersion: string, minorVersion: string }) =>
          candidate.machineName === dependency.machineName && Number(candidate.majorVersion) === Number(dependency.majorVersion) && Number(candidate.minorVersion) >= Number(dependency.minorVersion))
        expect(available, `${name}: ${dependency.machineName}`).toBeDefined()
      }
    }
  })

  it('says the newest H5P core a library it carries asks for, which a site needs to take it (#245)', async () => {
    const built = await build(example)
    const asked = [...built.files].filter(([name]) => /^[^/]+\/library\.json$/.test(name)).map(([, text]) => JSON.parse(text).coreApi)
    const [newest] = asked.filter(Boolean).map(({ majorVersion, minorVersion }) => [Number(majorVersion), Number(minorVersion)]).sort((a, b) => b[0] - a[0] || b[1] - a[1])
    expect(built.coreApi).toEqual({ majorVersion: newest[0], minorVersion: newest[1] })
    // H5P reads a library that names none as asking for 1.0; library.json may write the numbers as strings.
    expect(coreApiOf([])).toEqual({ majorVersion: 1, minorVersion: 0 })
    expect(coreApiOf([{ coreApi: { majorVersion: '1', minorVersion: '27' } }, { coreApi: { majorVersion: 1, minorVersion: 9 } }, {}])).toEqual({ majorVersion: 1, minorVersion: 27 })
    // A minor left out is 0, and what is not two whole numbers is passed over: never "2.NaN".
    expect(coreApiOf([{ coreApi: { majorVersion: 2 } }])).toEqual({ majorVersion: 2, minorVersion: 0 })
    expect(coreApiOf([{ coreApi: { majorVersion: 2, minorVersion: 'x' } }, { coreApi: { majorVersion: 1.5, minorVersion: 1 } }])).toEqual({ majorVersion: 1, minorVersion: 0 })
    expect(coreApiLine({ majorVersion: 1, minorVersion: 28 })).toBe('Needs H5P core 1.28 or newer on a site it is uploaded to: Moodle 4.5.11, 5.0.7 or 5.1.4 and later, or the WordPress H5P plugin 1.17 and later. An older site refuses it.')
    expect(coreApiLine({ majorVersion: 1, minorVersion: 29 })).toBe('Needs H5P core 1.29 or newer on a site it is uploaded to. An older site refuses it.')
  })

  it('builds standalone Multiple Choice, escapes markup, and preserves false and zero values', async () => {
    const source = {
      ...example, kind: 'multiple-choice', passPercentage: 0, passedFeedback: 'Done <b>& dusted</b>',
      questions: [{ ...example.questions[0], prompt: '<script>run()</script> & "quoted"\nNext line' }]
    }
    const { manifest, content, libraries } = await build(source)
    expect(manifest.mainLibrary).toBe('H5P.MultiChoice')
    expect(content.question).toBe('<p>&lt;script&gt;run()&lt;/script&gt; &amp; &quot;quoted&quot;<br>Next line</p>')
    expect(content.behaviour).toMatchObject({ type: 'single', passPercentage: 0 })
    // With nothing to fail, one range: every score passes.
    expect(content.overallFeedback).toEqual([{ from: 0, to: 100, feedback: 'Done &lt;b&gt;&amp; dusted&lt;/b&gt;' }])
    expect(content.answers).toEqual(expect.arrayContaining([expect.objectContaining({ correct: false })]))
    expect(libraries.some(name => name.startsWith('H5P.QuestionSet-'))).toBe(false)
  })

  it('stores question titles and author names as H5P stores text, and h5p.json as its exports write it', async () => {
    const source = {
      ...example,
      authors: [{ name: "Anne O'Brien <ed>", role: 'Author' }],
      questions: [{ ...example.questions[0], title: 'Kyivan Rus\' & "Cossacks" <b>' }, { ...example.questions[1], title: undefined }]
    }
    const { content, manifest } = await build(source)
    expect(content.questions.map((question: { metadata: { title: string } }) => question.metadata.title)).toEqual(['Kyivan Rus&#39; &amp; &quot;Cossacks&quot; &lt;b&gt;', 'Question 2'])
    for (const question of content.questions) expect(question.metadata.authors).toEqual([{ name: 'Anne O&#39;Brien &lt;ed&gt;', role: 'Author' }])
    expect(manifest.authors).toEqual(source.authors)
  })

  it('builds the eight-scenario example without losing questions, feedback, or its pass threshold', async () => {
    const { content } = await build(scenarios)
    expect(content.passPercentage).toBe(80)
    expect(content.endGame.overallFeedback.map(({ from, to }: { from: number, to: number }) => [from, to])).toEqual([[0, 79], [80, 100]])
    expect(content.questions).toHaveLength(8)
    expect(content.questions.filter((question: { params: { behaviour: { type: string } } }) => question.params.behaviour.type === 'multi')).toHaveLength(4)
    expect(content.questions[0].params.question).toContain('&quot;Benefits &amp; Payroll:')
    expect(content.questions[0].params.question).toContain('<br>')
    for (let i = 0; i < scenarios.questions.length; i++) {
      const written = scenarios.questions[i]
      const generated = content.questions[i]
      expect(generated.metadata.title).toBe(written.title)
      expect(generated.params.answers).toHaveLength(4)
      for (let j = 0; j < written.answers.length; j++) {
        expect(generated.params.answers[j].correct).toBe(written.answers[j].correct)
        expect(generated.params.answers[j].tipsAndFeedback.chosenFeedback).toBeTruthy()
      }
    }
  })

  it('takes the interface texts from the libraries\' own translation for the quiz\'s language', async () => {
    const untitled = { ...example, language: 'de-AT', questions: example.questions.map(({ title: _, ...question }: { title?: string }) => question) }
    const { content, translations } = await build(untitled)
    expect(translations.map(({ library, translation }) => [library.split(' ')[0], translation])).toEqual([['H5P.QuestionSet', 'de'], ['H5P.MultiChoice', 'de']])
    const question = content.questions[0].params
    for (const [machineName, path, value] of [
      ['H5P.QuestionSet', ['introPage', 'startButtonText'], content.introPage.startButtonText],
      ['H5P.QuestionSet', ['texts', 'finishButton'], content.texts.finishButton],
      ['H5P.QuestionSet', ['endGame', 'retryButtonText'], content.endGame.retryButtonText],
      ['H5P.MultiChoice', ['UI', 'checkAnswerButton'], question.UI.checkAnswerButton]
    ] as const) {
      const { english, translated } = await defaults(machineName, 'de', [...path])
      expect(translated).not.toBe(english)
      expect(value, path.join('.')).toBe(translated)
    }
    // What the report names as English is what the content holds.
    for (const [report, params] of [[translations[0], content], [translations[1], question]] as const) {
      for (const { field, text } of report.english) expect(field.split('.').reduce((object, key) => object[key], params), field).toBe(text)
    }
    // An untitled question is named as the set labels it, in the result screen's list too.
    const { translated: label } = await defaults('H5P.QuestionSet', 'de', ['texts', 'questionLabel'])
    expect(content.questions.map((question: { metadata: { title: string } }) => question.metadata.title)).toEqual([`${label} 1`, `${label} 2`])
  })

  it('stores a translated text as H5P stores plain text, escaped', async () => {
    const { content } = await build({ ...example, kind: 'multiple-choice', language: 'uk', questions: [example.questions[0]] })
    const { translated } = await defaults('H5P.MultiChoice', 'uk', ['UI', 'feedbackAvailable'])
    expect(translated).toContain("'")
    expect(content.UI.feedbackAvailable).toBe(translated!.replaceAll("'", '&#39;'))
  })

  it('never gives Simplified Chinese a Traditional file, and says when a library has no translation', async () => {
    const chinese = await build({ ...example, language: 'zh-CN' })
    // Question Set's `zh.json` is Traditional, and it has no Simplified file.
    expect(chinese.translations.map(({ translation }) => translation)).toEqual([null, 'zh-hans'])
    expect(chinese.content.texts.finishButton).toBe('Finish')
    const esperanto = await build({ ...example, language: 'eo' })
    expect(esperanto.translations).toEqual([
      expect.objectContaining({ translation: null, strings: esperanto.translations[0].english.length }),
      expect.objectContaining({ translation: null, strings: esperanto.translations[1].english.length })
    ])
    expect(esperanto.content.questions[0].params.UI.checkAnswerButton).toBe('Check')
  })
})

describe('any content type in the pack', () => {
  it('builds from the fields that differ from the defaults, the rest from the semantics', async () => {
    const { content, manifest, notes } = await build({
      ...META,
      type: 'H5P.Blanks',
      params: { questions: ['The *Danube/Donau:It flows through Vienna* reaches the Black Sea.', '<p>Paris lies on the <strong>*Seine*</strong>.</p>'], behaviour: { caseSensitive: false } }
    })
    expect(manifest).toMatchObject({ mainLibrary: 'H5P.Blanks', license: 'CC BY', title: 'Rivers' })
    expect(content.questions).toEqual(['<p>The *Danube/Donau:It flows through Vienna* reaches the Black Sea.</p>', '<p>Paris lies on the <strong>*Seine*</strong>.</p>'])
    expect(content.behaviour).toMatchObject({ caseSensitive: false, enableRetry: true })
    expect(content.text).toBe('Fill in the missing words')
    expect(notes).toEqual([])
  })

  it('takes a row\'s column widths with two decimals, and a column left empty, as H5P.com\'s editor writes them (#242)', async () => {
    const column = (text: string, width: number) => ({ width, content: { library: 'H5P.RowColumn', params: { content: [{ library: 'H5P.AdvancedText', params: { text } }] } } })
    const rowOf = (widths: number[]) => ({ ...META, type: 'H5P.Column', params: { content: [{ content: { library: 'H5P.Row', params: { columns: widths.map((width, i) => column(`Column ${i + 1}`, width)) } } }] } })
    const { content, notes } = await build(rowOf([62.56, 37.44]))
    expect(content.content[0].content.params.columns.map((each: { width: number }) => each.width)).toEqual([62.56, 37.44])
    expect(notes).toEqual([])
    expect(await problems(rowOf([33.333, 66.667]))).toEqual([
      'params.content[0].content.params.columns[0].width: takes at most 2 decimals',
      'params.content[0].content.params.columns[1].width: takes at most 2 decimals'
    ])
    // A spacer: a column whose content is left out, which the library plays as an empty column.
    const spacer = { width: 25, content: { library: 'H5P.RowColumn', params: {} } }
    const spaced = await build({ ...META, type: 'H5P.Column', params: { content: [{ content: { library: 'H5P.Row', params: { columns: [spacer, column('Middle', 50), spacer] } } }] } })
    expect(spaced.content.content[0].content.params.columns.map((each: { content: { params: { content?: unknown[] } } }) => each.content.params.content?.length ?? 0)).toEqual([0, 1, 0])
    expect(spaced.notes).toEqual([])
  })

  it('stores a plain text box as plain text, though its field lists tags', async () => {
    // Question Set 1.21's intro title and result message list tags, but the editor gives both a
    // plain text box, and the set draws both with textContent: a <div> around them was shown.
    const { content, notes } = await build({
      ...META,
      type: 'H5P.QuestionSet',
      params: {
        introPage: { showIntroPage: true, title: 'World War II: Five Historic Events', introduction: 'Five questions on the war.' },
        endGame: { message: "Tom's result" },
        questions: [{ library: 'H5P.TrueFalse', params: { question: 'The war in Europe ended in 1945.', correct: 'true' } }]
      }
    })
    expect(content.introPage.title).toBe('World War II: Five Historic Events')
    // An apostrophe as typed: the content check keeps it there, and the set shows an entity as written.
    expect(content.endGame.message).toBe("Tom's result")
    // The introduction is the set's rich-text field, wrapped as that widget wraps typing.
    expect(content.introPage.introduction).toBe('<p>Five questions on the war.</p>')
    expect(notes).toEqual([])

    // German as typed, umlauts and ß included; &, " and < stored as entities, and noted.
    const german = await build({ ...META, language: 'de', type: 'H5P.QuestionSet', params: {
      introPage: { showIntroPage: true, title: 'Größte Ereignisse: "Krieg" & Frieden' },
      questions: [{ library: 'H5P.TrueFalse', params: { question: 'Ja?', correct: 'true' } }]
    } })
    expect(german.content.introPage.title).toBe('Größte Ereignisse: &quot;Krieg&quot; &amp; Frieden')
    expect(german.notes).toContainEqual({ path: 'params.introPage.title', message: expect.stringMatching(/^stores &, ", < and > as entities/) })

    // Markup there is shown as written, as the editor's box would have stored it: noted, not refused.
    const marked = await build({ ...META, type: 'H5P.QuestionSet', params: {
      introPage: { showIntroPage: true, title: '<strong>WW2</strong>' },
      questions: [{ library: 'H5P.TrueFalse', params: { question: 'Yes?', correct: 'true' } }]
    } })
    expect(marked.content.introPage.title).toBe('&lt;strong&gt;WW2&lt;/strong&gt;')
    expect(marked.notes).toContainEqual({ path: 'params.introPage.title', message: 'is plain text, so its tags are shown as written, not as markup' })
  })

  it('lists every problem a source has at once, each by its path, and writes nothing', async () => {
    expect(await problems({ ...META, type: 'H5P.Nope', params: {} })).toEqual(['type: the library pack has no content type H5P.Nope'])
    // A version is saved content's, which checkContent takes; a build plays the pack's newest (#162).
    // What is wrong in the content is said in the same round as what is wrong beside it (#174).
    expect(await problems({ ...META, type: 'H5P.Blanks 1.14', params: {} })).toEqual([
      'type: takes the machine name alone, "H5P.Blanks": the version is the pack\'s newest',
      'params.questions: is required: write at least 1 item'
    ])
    expect(await problems({ ...META, license: 'MIT', authors: [{ name: 'A' }], extra: 1, type: 'H5P.Blanks', params: { questions: ['The *Danube* flows east.'] } })).toEqual([
      'extra: is not a field of a source; the fields are type, title, language, license, licenseVersion, authors, source, yearFrom, yearTo, params',
      expect.stringMatching(/^license: use one of/),
      'authors[0].role: use one of Author, Editor, Licensee, Originator'
    ])
    // A licence written with its version, as it is spoken of: the problem says where the version
    // goes, and names the licence it read. The list of names alone had a chat drop the version.
    const blanks = { type: 'H5P.Blanks', params: { questions: ['The *Danube* flows east.'] } }
    expect(await problems({ ...META, ...blanks, license: 'CC BY 4.0' })).toEqual(['license: "CC BY 4.0" holds the version too: write "license": "CC BY" and "licenseVersion": "4.0"'])
    expect(await problems({ ...META, ...blanks, license: 'cc-by-sa-4.0' })).toEqual(['license: "cc-by-sa-4.0" holds the version too: write "license": "CC BY-SA" and "licenseVersion": "4.0"'])
    expect(await problems({ ...META, ...blanks, license: 'CC BY-NC 5.0' })).toEqual(['license: "CC BY-NC 5.0" holds a version too: write "license": "CC BY-NC" and "licenseVersion", one of 4.0, 3.0, 2.5, 2.0, 1.0'])
    expect(await problems({ ...META, ...blanks, license: 'CC BY 4.0', licenseVersion: '4.0' })).toEqual(['license: "CC BY 4.0" holds the version too, which licenseVersion names: write "license": "CC BY"'])
    expect(await problems({ ...META, ...blanks, license: 'CC-BY-4.0', licenseVersion: '9' })).toEqual([
      'license: "CC-BY-4.0" holds the version too, which licenseVersion names: write "license": "CC BY"',
      'licenseVersion: use one of 4.0, 3.0, 2.5, 2.0, 1.0'
    ])
    expect((await build({ ...META, ...blanks, license: 'CC BY', licenseVersion: '4.0' })).manifest).toMatchObject({ license: 'CC BY', licenseVersion: '4.0' })
    // CC0 1.0 is one code, version and all, and no versioned CC BY.
    expect((await build({ ...META, ...blanks, license: 'CC0 1.0' })).manifest).toMatchObject({ license: 'CC0 1.0' })
    expect(await problems({ ...META, ...blanks, license: 'CC0', licenseVersion: '1.0' })).toEqual([
      expect.stringMatching(/^license: use one of "U", "CC BY", .*"CC0 1\.0"/),
      'licenseVersion: is for a Creative Commons BY licence only'
    ])
    expect(await problems({
      ...META,
      type: 'H5P.TrueFalse',
      params: { correct: 'yes', behaviour: { autoCheck: 'no', sideways: true }, question: '<p>Is <video>this</video> true?</p>' }
    })).toEqual([
      expect.stringMatching(/^params\.question: has <video>, which this field does not take/),
      'params.correct: "yes" is not an option; the options are "true", "false"',
      'params.behaviour.autoCheck: expected true or false',
      expect.stringMatching(/^params\.behaviour\.sideways: is not a field here/)
    ])
    expect((await readdir(dir)).filter(name => name.startsWith('failed-') || name.startsWith('.h5p-author-'))).toEqual([])
  })

  it('holds a source\'s own fields to one schema, which is what an app is shown of a source (#230)', async () => {
    const blanks = { type: 'H5P.Blanks', params: { questions: ['The *Danube* flows east.'] } }
    // An author written as a name alone, as Haiku wrote one through the MCP server: said with the object to write.
    expect(await problems({ ...META, ...blanks, authors: ['Unknown'] })).toEqual(['authors[0]: expected an author: write { "name": "Unknown", "role": "Author" }'])
    // Every problem of an author at once, each at its own path.
    expect(await problems({ ...META, ...blanks, authors: [{ name: ' ', role: 'Writer', email: 'ann@example.org' }] })).toEqual([
      'authors[0].name: expected the author\'s name',
      'authors[0].role: use one of Author, Editor, Licensee, Originator',
      'authors[0].email: is not part of an author; write name and role'
    ])
    // The same fields, as JSON Schema: those a source must name, the codes, an author's two fields.
    const shape = toJSONSchema(sourceSchema, { io: 'input' }) as { required: string[], properties: Record<string, any> }
    expect(shape.required).toEqual(['type', 'title', 'language', 'license', 'authors'])
    expect(shape.properties.license.enum).toEqual(LICENSES)
    expect(shape.properties.authors.items).toMatchObject({ required: ['name', 'role'], additionalProperties: false })
    // No other field, as a build refuses one: said as the build says it.
    expect(shape).toMatchObject({ additionalProperties: false })
    expect(sourceSchema.safeParse({ ...META, ...blanks }).success).toBe(true)
    expect(sourceSchema.safeParse({ ...META, ...blanks, extra: 1 }).error?.issues.map(({ message }) => message)).toEqual([
      'is not a field of a source; the fields are type, title, language, license, licenseVersion, authors, source, yearFrom, yearTo, params'
    ])
  })

  it('says what to write for what is in the wrong place, checks it in the same build, and counts no list it refused an item of (#172)', async () => {
    // A book's chapters as a chat without the type's file writes them: no H5P.Column around pages,
    // sub-content in the place of a page's items. All in one build, by where the source has it.
    expect(await problems({ ...META, type: 'H5P.InteractiveBook', params: { chapters: [
      { title: 'Sources', content: [{ library: 'H5P.AdvancedText', params: { text: 'A river begins at its source.' } }] }
    ] } })).toEqual([
      // Its title beside them is the chapter's own, shown where it goes (#174): it was two more
      // problems, "is not a field here" and "metadata.title: is required".
      'params.chapters[0]: is the params of sub-content, without the sub-content around them: write params.chapters[0] as { "library": "H5P.Column", "metadata": { "title": … }, "params": { "content": … } }',
      'params.chapters[0].content[0]: is sub-content, but here it goes inside an object, in its field content: write params.chapters[0].content[0] as { "content": { "library": "H5P.AdvancedText", "params": { … } } }'
    ])
    // A chapter refused whole leaves the list shorter: no count of what is left, and nothing said
    // of the chapter after it under the index of the one refused.
    expect(await problems({ ...META, type: 'H5P.InteractiveBook', params: { chapters: [
      'Sources',
      { library: 'H5P.Column', params: { content: [{ content: { library: 'H5P.AdvancedText', params: { text: 'A river ends at its mouth.' } } }] } }
    ] } })).toEqual(['params.chapters[0]: expected sub-content, { "library": "H5P.Column", "params": { … } }'])
    // A list a level above its group, and what is wrong inside it, in the same build.
    expect(await problems({ ...META, type: 'H5P.CoursePresentation', params: { slides: [
      { elements: [{ library: 'H5P.AdvancedText', params: { text: '<h1>Water</h1>' }, x: 5, y: 5 }] }
    ] } })).toEqual([
      'params.slides: is a field of presentation, not of this level: write params.presentation.slides',
      'params.slides[0].elements[0]: is sub-content, but here it goes inside an object, in its field action: write params.slides[0].elements[0] as { "action": { "library": "H5P.AdvancedText", "params": { … } }, "x": …, "y": … }',
      expect.stringMatching(/^params\.slides\[0\]\.elements\[0\]\.params\.text: has <h1>, which this field does not take/)
    ])
    // What only the last check finds, inside what was moved, is said too, by where the source has
    // it: a scenario's node with no next. And a question with no alternatives is not a loop.
    expect(await problems({ ...META, type: 'H5P.BranchingScenario', params: { branchingScenario: { title: 'A complaint', content: [
      { library: 'H5P.AdvancedText', params: { text: 'A customer calls.' } },
      { type: { library: 'H5P.BranchingQuestion', params: { question: 'What do you say?' } } }
    ] } } })).toEqual([
      'params.branchingScenario.content[0]: is sub-content, but here it goes inside an object, in its field type: write params.branchingScenario.content[0] as { "type": { "library": "H5P.AdvancedText", "params": { … } } }',
      'params.branchingScenario.content[1].type.params.question: is a field of branchingQuestion, not of this level: write params.branchingScenario.content[1].type.params.branchingQuestion.question',
      'params.branchingScenario.content[1].type.params.branchingQuestion.alternatives: is required: write at least 2 items',
      'params.branchingScenario.content[0].nextContentId: is required: the index in content of the node that follows, or -1 to end the scenario here'
    ])
  })

  it('checks the content in the same build as the source\'s own fields, and takes what its outer shape plainly means (#174)', async () => {
    // A book as Gemini wrote it from a link to the skill: the type as `contentType`, own fields in
    // `metadata`, sub-content naming its library the same way. It was seven problems, then thirty.
    expect(await problems({
      contentType: 'H5P.InteractiveBook',
      metadata: { title: 'Physics', license: 'CC BY', authors: [{ name: 'Ann Author', role: 'Author' }], defaultLanguage: 'en' },
      params: { chapters: [{ title: 'Newton', content: [{ contentType: 'H5P.AdvancedText', params: { text: '<h1>F = ma</h1>' } }] }] }
    })).toEqual([
      'contentType: is not a field of a source: the content type is its type: write "type": "H5P.InteractiveBook"',
      'metadata: is not a field of a source: title, license, authors are written beside type, not in an object: write "title": …, "license": …, "authors": … at the top',
      'metadata.defaultLanguage: is not a field of a source; the fields are type, title, language, license, licenseVersion, authors, source, yearFrom, yearTo, params',
      'language: expected a BCP 47 language tag, such as "en" or "de-AT"',
      'params.chapters[0]: is the params of sub-content, without the sub-content around them: write params.chapters[0] as { "library": "H5P.Column", "metadata": { "title": … }, "params": { "content": … } }',
      'params.chapters[0].content[0]: is sub-content, but here it goes inside an object, in its field content: write params.chapters[0].content[0] as { "content": { "library": "H5P.AdvancedText", "params": { … } } }',
      expect.stringMatching(/^params\.chapters\[0\]\.content\[0\]\.params\.text: has <h1>, which this field does not take/)
    ])
    // As the weakest model wrote one with no skill: the content's fields beside `type`, the type
    // by the name it is spoken of. Each round had gone to one of these, with nothing inside looked at.
    const chapter = { library: 'H5P.Column', metadata: { title: 'Newton' }, params: { content: [{ content: { library: 'H5P.AdvancedText', params: { text: 'F = ma' } } }] } }
    expect(await problems({ type: 'interactive-book', title: 'Physics', chapters: [chapter, 'Einstein'] })).toEqual([
      'params: is not written: the content\'s fields go in it, not beside type: write "params": { "chapters": … }',
      'type: takes the machine name, "H5P.InteractiveBook"',
      'language: expected a BCP 47 language tag, such as "en" or "de-AT"',
      expect.stringMatching(/^license: use one of/),
      'authors: name at least one author: [{ "name": "…", "role": "Author" }]',
      'params.chapters[1]: expected sub-content, { "library": "H5P.Column", "params": { … } }'
    ])
    // With `params` written, what is beside `type` is no field of the content.
    expect(await problems({ ...META, type: 'H5P.InteractiveBook', chapters: [], params: { chapters: [chapter] } })).toEqual([
      'chapters: is not a field of a source; the fields are type, title, language, license, licenseVersion, authors, source, yearFrom, yearTo, params'
    ])
    // A source's own field that the top has too is said so, and a year in the object is taken.
    expect(await problems({ ...META, type: 'H5P.InteractiveBook', metadata: { title: 'Other', yearFrom: 2020 }, params: { chapters: [chapter] } })).toEqual([
      'metadata: is not a field of a source: yearFrom is written beside type, not in an object: write "yearFrom": … at the top',
      'metadata.title: is written beside type already'
    ])

    // A type named as it is spoken of is the one type of those letters; one that is none has the nearest named.
    expect(await problems({ ...META, type: 'Question Set', params: { questions: [{ library: 'H5P.TrueFalse', params: { question: 'Yes?', correct: 'true' } }] } })).toEqual(['type: takes the machine name, "H5P.QuestionSet"'])
    expect(await problems({ ...META, type: 'book', params: {} })).toEqual(['type: the library pack has no content type book; nearest: H5P.InteractiveBook'])
    expect(await problems({ ...META, type: 'fill-in-the-blanks', params: {} })).toEqual(['type: the library pack has no content type fill-in-the-blanks; nearest: H5P.Blanks'])
    // "Question Set 2" is no Question Set: a number with no point is no version.
    expect(await problems({ ...META, type: 'Question Set 2', params: {} })).toEqual(['type: the library pack has no content type Question Set 2'])
    // Two keys that each name a type: neither is taken. A text under another key is no type name,
    // nor is an object other than `metadata` the source's fields (Question Set's `introPage`).
    expect(await problems({ ...META, contentType: 'H5P.Blanks', library: 'H5P.DragText', params: {} })).toEqual([
      expect.stringMatching(/^contentType: is not a field of a source; the fields are/),
      expect.stringMatching(/^library: is not a field of a source; the fields are/),
      'type: expected a content type\'s machine name, such as "H5P.Blanks"'
    ])
    expect(await problems({ ...META, description: 'Summary', params: {} })).toEqual([
      expect.stringMatching(/^description: is not a field of a source; the fields are/),
      'type: expected a content type\'s machine name, such as "H5P.Blanks"'
    ])
    expect(await problems({ ...META, title: undefined, type: 'H5P.QuestionSet', introPage: { showIntroPage: true, title: 'Welcome' }, questions: [{ library: 'H5P.TrueFalse', params: { question: 'Yes?', correct: 'true' } }] })).toEqual([
      'params: is not written: the content\'s fields go in it, not beside type: write "params": { "introPage": …, "questions": … }',
      'title: expected the activity\'s title'
    ])

    // Sub-content with its library under another key and its parameters beside it, in a field
    // that takes several libraries: the parameters of the one it names, checked as such.
    expect(await problems({ ...META, type: 'H5P.QuestionSet', params: { questions: [
      { type: 'H5P.MultiChoice', question: 'Which?', answers: [{ text: 'a', correct: true }, { text: 'b', correct: false }], sideways: 1 }
    ] } })).toEqual([
      'params.questions[0]: is the params of sub-content, without the sub-content around them: write params.questions[0] as { "library": "H5P.MultiChoice", "params": { "question": … } }',
      expect.stringMatching(/^params\.questions\[0\]\.sideways: is not a field here; the fields are media, question, answers/)
    ])
    // The same in the place of the group that holds it: what is no field of the group is its parameters.
    expect(await problems({ ...META, type: 'H5P.CoursePresentation', params: { presentation: { slides: [
      { elements: [{ type: 'H5P.AdvancedText', x: 5, y: 5, width: 90, height: 20, text: '<h1>Water</h1>' }] }
    ] } } })).toEqual([
      'params.presentation.slides[0].elements[0]: is sub-content, but here it goes inside an object, in its field action: write params.presentation.slides[0].elements[0] as { "action": { "library": "H5P.AdvancedText", "params": { … } }, "x": …, "y": …, "width": …, "height": … }',
      expect.stringMatching(/^params\.presentation\.slides\[0\]\.elements\[0\]\.text: has <h1>, which this field does not take/)
    ])
    // A name under `type` or `contentType` written loosely, in a field that takes several
    // libraries: the library is loaded, so what is written for it is checked in the same round.
    expect(await problems({ ...META, type: 'H5P.Column', params: { content: [{ type: 'advancedtext', text: '<h1>Hi</h1>' }, { content: { contentType: 'advanced-text', params: { text: '<h1>Hi</h1>' } } }] } })).toEqual([
      'params.content[0]: is sub-content, but here it goes inside an object, in its field content: write params.content[0] as { "content": { "library": "H5P.AdvancedText", "params": { … } } }',
      expect.stringMatching(/^params\.content\[0\]\.text: has <h1>, which this field does not take/),
      'params.content[1].content.contentType: is the sub-content\'s library: write "library": "H5P.AdvancedText"',
      expect.stringMatching(/^params\.content\[1\]\.content\.params\.text: has <h1>, which this field does not take/)
    ])
    // A title beside sub-content in its group's place is its own, with `library` or another key.
    expect(await problems({ ...META, type: 'H5P.Column', params: { content: [{ library: 'H5P.AdvancedText', title: 'One', params: { text: 'x' } }, { type: 'H5P.AdvancedText', title: 'Two', text: 'y' }] } })).toEqual([
      'params.content[0]: is sub-content, but here it goes inside an object, in its field content: write params.content[0] as { "content": { "library": "H5P.AdvancedText", "params": { … } } }',
      'params.content[0].title: is the sub-content\'s title, which is in its metadata: write "metadata": { "title": … }',
      'params.content[1]: is sub-content, but here it goes inside an object, in its field content: write params.content[1] as { "content": { "library": "H5P.AdvancedText", "params": { … } } }',
      'params.content[1].title: is the sub-content\'s title, which is in its metadata: write "metadata": { "title": … }'
    ])
    // A library named loosely, or with a version of three parts, a title beside `library`, and
    // two keys that each name a library.
    expect(await problems({ ...META, type: 'H5P.Column', params: { content: [{ content: { library: 'advancedtext', params: { text: 'x' } } }, { content: { library: 'H5P.AdvancedText 1.1.5', params: { text: 'x' } } }] } })).toEqual([
      'params.content[0].content.library: takes the machine name, "H5P.AdvancedText"',
      'params.content[1].content.library: takes the machine name, "H5P.AdvancedText"'
    ])
    expect(await problems({ ...META, type: 'H5P.InteractiveBook', params: { chapters: [{ ...chapter, metadata: undefined, title: 'Newton' }] } })).toEqual([
      'params.chapters[0].title: is the sub-content\'s title, which is in its metadata: write "metadata": { "title": … }'
    ])
    expect(await problems({ ...META, type: 'H5P.QuestionSet', params: { questions: [{ type: 'H5P.MultiChoice', contentType: 'H5P.TrueFalse', question: 'Which?' }] } })).toEqual([
      expect.stringMatching(/^params\.questions\[0\]: expected sub-content, \{ "library": "…", "params": \{ … \} \}, of H5P\.MultiChoice, /)
    ])
    expect((await readdir(dir)).filter(name => name.startsWith('failed-') || name.startsWith('.h5p-author-'))).toEqual([])
  })

  it('takes sub-content by machine name, at the pack\'s version, with its title', async () => {
    const { content, manifest } = await build({
      ...META,
      type: 'H5P.Column',
      params: { content: [{ content: { library: 'H5P.TrueFalse', params: { question: 'The Rhine reaches the sea.' }, metadata: { title: 'The Rhine' } } }, { content: { library: 'H5P.AdvancedText', params: { text: 'Done.' } } }] }
    })
    expect(content.content[0].content).toMatchObject({ library: expect.stringMatching(/^H5P\.TrueFalse 1\.\d+$/), metadata: { title: 'The Rhine', contentType: 'True/False Question' } })
    expect(content.content[1].content.metadata.title).toBe('Text')
    expect(manifest.preloadedDependencies.map(({ machineName }: { machineName: string }) => machineName)).toEqual(expect.arrayContaining(['H5P.Column', 'H5P.TrueFalse', 'H5P.AdvancedText']))
  })

  it('lists the libraries depth first from the content type, the order the runtime keeps between libraries that do not depend on each other', async () => {
    const { content, manifest, files } = await build({
      ...META,
      type: 'H5P.Column',
      params: { content: [{ content: { library: 'H5P.TrueFalse', params: { question: 'The Rhine reaches the sea.' } } }, { content: { library: 'H5P.AdvancedText', params: { text: 'Done.' } } }] }
    })
    // The order the build has always written, from the libraries the zip carries: the content type,
    // then each library the content names, each followed by its own dependencies before the next.
    const libraries = new Map<string, { preloadedDependencies?: { machineName: string }[] }>()
    for (const [name, json] of files) {
      if (!name.endsWith('/library.json')) continue
      const library = JSON.parse(json)
      libraries.set(library.machineName, library)
    }
    const expected: string[] = []
    const visit = (machineName: string) => {
      if (expected.includes(machineName)) return
      expected.push(machineName)
      for (const dependency of libraries.get(machineName)?.preloadedDependencies ?? []) visit(dependency.machineName)
    }
    for (const name of ['H5P.Column', ...librariesIn(content)]) visit(name.split(' ')[0])
    const listed = manifest.preloadedDependencies.map(({ machineName }: { machineName: string }) => machineName)
    expect(listed).toEqual(expected)
    // Depth first, not breadth first: True/False's own dependencies come before the text beside it.
    const [dependency] = libraries.get('H5P.TrueFalse')!.preloadedDependencies!
    expect(listed.indexOf(dependency.machineName)).toBeLessThan(listed.indexOf('H5P.AdvancedText'))
  })

  it('adds the formula addon the pack carries when the text holds LaTeX, as a site with it installed exports it', async () => {
    const { manifest, notes } = await build({ ...META, type: 'H5P.TrueFalse', params: { question: 'Is \\(e^{i\\pi} + 1 = 0\\)?' } })
    expect(manifest.preloadedDependencies.map(({ machineName }: { machineName: string }) => machineName)).toContain('H5P.MathDisplay')
    expect(notes.map(({ message }) => message).join()).toContain('H5P.MathDisplay')
  })
})

describe('notes for what builds and is almost surely a mistake (#241)', () => {
  /** The notes a build of a source gives, writing nothing. */
  async function notesOf(source: unknown, base?: string) {
    return (await buildPackage(source, undefined, { check: true, ...(base ? { base } : {}) })).notes
  }

  it('says where no answer is marked correct, or two read alike, wherever the question sits', async () => {
    const question = { question: 'Which river is the longest in Europe?', answers: [{ text: 'Volga' }, { text: '<strong>volga</strong> ' }, { text: 'Danube' }] }
    expect(await notesOf({ ...META, type: 'H5P.MultiChoice', params: question })).toEqual([
      { path: 'params.answers', message: 'marks no answer correct, so no learner can score: set "correct": true on the right one' },
      { path: 'params.answers[1]', message: 'reads as answers[0] does, so a learner sees the same answer twice' }
    ])
    // In a set, by the sub-content's path; one marked correct is enough.
    const fine = { question: 'Which river flows through Paris?', answers: [{ text: 'Seine', correct: true }, { text: 'Loire' }] }
    expect(await notesOf({ ...META, type: 'H5P.QuestionSet', params: { questions: [{ library: 'H5P.MultiChoice', params: fine }, { library: 'H5P.MultiChoice', params: question }] } })).toEqual([
      { path: 'params.questions[1].params.answers', message: 'marks no answer correct, so no learner can score: set "correct": true on the right one' },
      { path: 'params.questions[1].params.answers[1]', message: 'reads as answers[0] does, so a learner sees the same answer twice' }
    ])
    // Entities and spacing read as a learner reads them.
    expect(await notesOf({ ...META, type: 'H5P.SingleChoiceSet', params: { choices: [{ question: 'Which sea does the Danube reach?', answers: ['Black Sea', 'North Sea', 'Black  Sea'] }, { question: 'Which river flows through Paris?', answers: ['Seine', 'Loire'] }] } })).toEqual([
      { path: 'params.choices[0].answers[2]', message: 'reads as answers[0] does, so a learner sees the same answer twice' }
    ])
    expect(await notesOf({ ...META, type: 'H5P.Summary', params: { summaries: [{ summary: ['Rivers flow downhill.', 'Rivers flow uphill.', 'Rivers flow downhill.'] }] } })).toEqual([
      { path: 'params.summaries[0].summary[2]', message: 'reads as summary[0] does, so a learner sees the same statement twice' }
    ])
  })

  it('says where a quiz\'s pool leaves questions out, or draws none (#268)', async () => {
    const question = (text: string) => ({ library: 'H5P.TrueFalse', params: { question: text, correct: 'true' } })
    const questions = ['The Danube reaches the Black Sea.', 'The Seine flows through Paris.', 'The Volga is in Europe.'].map(question)
    const quiz = (poolSize?: number) => notesOf({ ...META, type: 'H5P.QuestionSet', params: { questions, ...(poolSize === undefined ? {} : { poolSize }) } })
    expect(await quiz(2)).toEqual([
      { path: 'params.poolSize', message: 'shows 2 of the 3 questions each time, drawn at random, and leaves the rest out: leave it out to show them all, or tell the user that it draws' }
    ])
    // As many as there are leaves none out, though Question Set still shuffles them, and is what
    // hides a question added later; more, once there are more still.
    expect(await quiz(3)).toEqual([
      { path: 'params.poolSize', message: 'is the number of questions, 3, so it leaves none out but shows them in a random order, and one added later would leave one out at random: leave it out, and set randomQuestions for a random order' }
    ])
    expect(await quiz(5)).toEqual([
      { path: 'params.poolSize', message: 'is above the number of questions, 3, so it leaves none out but shows them in a random order until more than 5 are, and then leaves some out at random: leave it out, and set randomQuestions for a random order' }
    ])
    expect(await quiz()).toEqual([])
  })

  it('says where a memory game or a crossword draws, as a quiz does (#268)', async () => {
    const card = (text: string) => ({ image: { path: 'river.png' }, imageAlt: text })
    const at = await mkdtemp(join(dir, 'cards-'))
    await writeFile(join(at, 'river.png'), png(64, 48))
    expect(await notesOf({ ...META, type: 'H5P.MemoryGame', params: { cards: [card('A river'), card('A lake'), card('A sea')], behaviour: { numCardsToUse: 2 } } }, at)).toEqual([
      { path: 'params.behaviour.numCardsToUse', message: 'shows 2 of the 3 pairs each time, drawn at random, and leaves the rest out: leave it out to show them all, or tell the user that it draws' }
    ])
    const word = (clue: string, answer: string) => ({ clue, answer })
    expect(await notesOf({ ...META, type: 'H5P.Crossword', params: { words: [word('A long river', 'Danube'), word('Through Paris', 'Seine')], behaviour: { poolSize: 2 } } })).toEqual([
      { path: 'params.behaviour.poolSize', message: 'is the number of words, 2, so it leaves none out, and one added later would leave one out at random: leave it out' }
    ])
    // Words fixed on the grid are always kept, and the others drawn to make up the rest.
    const fixed = (clue: string, answer: string, row: number) => ({ clue, answer, fixWord: true, row, column: 1, orientation: 'across' })
    const fourWords = [fixed('A long river', 'Danube', 1), fixed('Through Paris', 'Seine', 3), word('Through Rome', 'Tiber'), word('Through London', 'Thames')]
    expect(await notesOf({ ...META, type: 'H5P.Crossword', params: { words: fourWords, behaviour: { poolSize: 3 } } })).toEqual([
      { path: 'params.behaviour.poolSize', message: 'shows 3 of the 4 words each time, the 2 fixed on the grid and 1 of the other 2 drawn at random, and leaves the rest out: leave it out to show them all, or tell the user that it draws' }
    ])
    expect(await notesOf({ ...META, type: 'H5P.Crossword', params: { words: fourWords, behaviour: { poolSize: 2 } } })).toEqual([
      { path: 'params.behaviour.poolSize', message: 'shows only the 2 words fixed on the grid, and never the other 2: leave it out to show them all' }
    ])
  })

  it('says where a part is named by a number, an id or a name that is not there (#268)', async () => {
    const text = (html: string) => ({ action: { library: 'H5P.AdvancedText', params: { text: html } } })
    // A Course Presentation button to slide 3 of 2.
    expect(await notesOf({ ...META, type: 'H5P.CoursePresentation', params: { presentation: { slides: [
      { elements: [text('<p>Rivers</p>'), { goToSlideType: 'specified', goToSlide: 3, x: 10, y: 10, width: 20, height: 10 }] },
      { elements: [text('<p>Lakes</p>')] }
    ] } } })).toEqual([
      { path: 'params.presentation.slides[0].elements[1].goToSlide', message: 'goes to slide 3, and there are 2 slides, so the button has no slide to go to: name a slide by its number, from 1' }
    ])
    // Agamotto: a start image past the last is held to the last; a fraction is refused already.
    const at = await mkdtemp(join(dir, 'agamotto-'))
    await writeFile(join(at, 'river.png'), png(64, 48))
    const image = (alt: string) => ({ image: { library: 'H5P.Image', params: { file: { path: 'river.png' }, alt } }, labelText: alt })
    const agamotto = (startImage: number) => notesOf({ ...META, type: 'H5P.Agamotto', params: { items: [image('Spring'), image('Summer')], behaviour: { startImage } } }, at)
    expect(await agamotto(3)).toEqual([
      { path: 'params.behaviour.startImage', message: 'is image 3, and there are 2 images, so it starts at the last: name one by its number, from 1, or leave it out' }
    ])
    await expect(agamotto(1.5)).rejects.toThrow('params.behaviour.startImage: takes a whole number')
    expect(await agamotto(2)).toEqual([])
    // Drag and Drop: a right element and a zone that are not there, and an element that can be
    // dropped in none of the zones it is right in.
    const element = (text: string, zones: string[]) => ({ type: { library: 'H5P.AdvancedText', params: { text: `<p>${text}</p>` } }, dropZones: zones })
    const zone = (label: string, right: string[]) => ({ label, correctElements: right })
    expect(await notesOf({ ...META, type: 'H5P.DragQuestion', params: { question: { settings: { size: { width: 620, height: 310 } }, task: {
      elements: [element('Danube', ['0']), element('Garda', ['0']), element('Seine', ['0', '3'])],
      dropZones: [zone('Rivers', ['0', '2', '5']), zone('Lakes', ['1'])]
    } } } })).toEqual([
      { path: 'params.question.task.dropZones[0].correctElements[2]', message: 'names element "5", and there are 3 elements, counted from 0: name each by its place in elements' },
      { path: 'params.question.task.elements[1].dropZones', message: 'lets the element be dropped in zone 0, and it is right only in zone 1, so no learner can put it right: name that zone in its dropZones' },
      { path: 'params.question.task.elements[2].dropZones[1]', message: 'names drop zone "3", and there are 2 drop zones, counted from 0: name each by its place in dropZones' }
    ])
    // A Personality Quiz answer naming a personality renamed since, and one in another case: the
    // library takes a name only as its personality has it, and parts two at a comma and a space.
    expect(await notesOf({ ...META, type: 'H5P.PersonalityQuiz', params: {
      titleScreen: { title: { text: 'Which traveller are you?' } },
      personalities: [{ name: 'Explorer', description: 'Goes far.' }, { name: 'Builder', description: 'Makes things.' }],
      questions: [{ text: 'On a free day you…', answers: [{ text: 'walk somewhere new', personality: 'Explorer' }, { text: 'fix something', personality: 'Maker, builder' }, { text: 'do both', personality: 'Explorer, Builder, ' }, { text: 'roam', personality: 'Explorer, Wanderer' }] }]
    } })).toEqual([
      { path: 'params.questions[0].answers[1].personality', message: 'names "Maker", "builder", which no personality is called exactly, so those names count for none: write each name as its personality has it, capitals too, with a comma and a space between two' },
      // A comma at the end names nothing; a known name beside an unknown one still counts.
      { path: 'params.questions[0].answers[3].personality', message: 'names "Wanderer", which no personality is called exactly, so that name counts for none: write each name as its personality has it, capitals too, with a comma and a space between two' }
    ])
  })

  it('says where a choice of pictures marks none correct', async () => {
    const at = await mkdtemp(join(dir, 'pictures-'))
    await writeFile(join(at, 'delta.png'), png(64, 48))
    await writeFile(join(at, 'spring.png'), png(64, 48))
    const option = (path: string, alt: string) => ({ media: { library: 'H5P.Image', params: { file: { path }, alt } } })
    expect(await notesOf({ ...META, type: 'H5P.MultiMediaChoice', params: { question: 'Which picture shows a river delta?', options: [option('delta.png', 'A delta'), option('spring.png', 'A spring')] } }, at)).toEqual([
      { path: 'params.options', message: 'marks no option correct, so no learner can score: set "correct": true on the right one' }
    ])
  })

  it('says where a text has no gap to fill in, drag a word to or find', async () => {
    expect(await notesOf({ ...META, type: 'H5P.Blanks', params: { questions: ['The Danube flows into the Black Sea.', 'Paris lies on the Seine.'] } })).toEqual([
      { path: 'params.questions', message: 'has no gap, so a learner has nothing to fill in: put each answer between asterisks, as *Paris*' }
    ])
    // One text with a gap is enough: the others may lead in.
    expect(await notesOf({ ...META, type: 'H5P.Blanks', params: { questions: ['Rivers of Europe.', 'The *Danube* flows into the Black Sea.'] } })).toEqual([])
    expect(await notesOf({ ...META, type: 'H5P.DragText', params: { textField: 'The Danube flows into the Black Sea.' } })).toEqual([
      { path: 'params.textField', message: 'has no gap, so a learner has no word to drag: put each word between asterisks, as *Paris*' }
    ])
    expect(await notesOf({ ...META, type: 'H5P.MarkTheWords', params: { taskDescription: 'Click every name of a river.', textField: 'The Danube rises in the Black Forest.' } })).toEqual([
      { path: 'params.textField', message: 'marks no word, so a learner has none to find: put each word to find between asterisks, as *Paris*' }
    ])
  })

  it('says where a picture has no alt text, where its field is optional', async () => {
    const at = await mkdtemp(join(dir, 'alt-'))
    await writeFile(join(at, 'river.png'), png(64, 48))
    await writeFile(join(at, 'bridge.png'), png(64, 48))
    expect(await notesOf({ ...META, type: 'H5P.Dialogcards', params: { dialogs: [
      { text: 'the river', answer: 'der Fluss', image: { path: 'river.png' }, imageAltText: 'A river between hills' },
      { text: 'the bridge', answer: 'die Brücke', image: { path: 'bridge.png' } },
      { text: 'the bank', answer: 'das Ufer' }
    ] } }, at)).toEqual([
      { path: 'params.dialogs[1].imageAltText', message: 'is not written, so a screen reader has nothing to say of the picture in image: write what it shows' }
    ])
    // A card's matching picture: only where there is one.
    expect(await notesOf({ ...META, type: 'H5P.MemoryGame', params: { cards: [
      { image: { path: 'river.png' }, imageAlt: 'A river', match: { path: 'bridge.png' } },
      { image: { path: 'bridge.png' }, imageAlt: 'A bridge' }
    ] } }, at)).toEqual([
      { path: 'params.cards[0].matchAlt', message: 'is not written, so a screen reader has nothing to say of the picture in match: write what it shows' }
    ])
  })

  it('names, for each picture with an optional alt text, fields the pack has: a picture, and an optional text beside it', async () => {
    type Semantic = { name: string, type: string, optional?: boolean, field?: Semantic, fields?: Semantic[] }
    for (const [machineName, pictures] of Object.entries(ALT_TEXTS)) {
      const library = pack.libraries.filter((each) => each.machineName === machineName).sort((a, b) => b.majorVersion - a.majorVersion || b.minorVersion - a.minorVersion)[0]
      expect(library, machineName).toBeTruthy()
      const { files } = await archive(new URL(library.url))
      let fields: Semantic[] = JSON.parse(files.get(`${library.folder}/semantics.json`)!)
      for (const [group, picture, alt] of pictures) {
        let level = fields
        for (const name of group ? group.replace(/\[\]/g, '').split('.') : []) {
          const field = level.find((each) => each.name === name)
          expect(field, `${machineName} ${group}`).toBeTruthy()
          level = field!.type === 'list' ? (field!.field!.fields ?? []) : (field!.fields ?? [])
        }
        expect(level.find((each) => each.name === picture)?.type, `${machineName} ${group}.${picture}`).toBe('image')
        expect(level.find((each) => each.name === alt), `${machineName} ${group}.${alt}`).toMatchObject({ type: 'text', optional: true })
      }
      fields = []
    }
  })
})

describe('media', () => {
  let server: Server
  let origin: string
  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === '/pictures/map.png') response.writeHead(200, { 'content-type': 'image/png' }).end(png(40, 20))
      else if (request.url === '/picture') response.writeHead(200, { 'content-type': 'image/png' }).end(png(10, 30))
      else if (request.url === '/page.html') response.writeHead(200, { 'content-type': 'text/html' }).end('<p>no</p>')
      // A file's page on a wiki, at an address that ends as the file's name does (#218).
      else if (request.url === '/wiki/File:clip.mp4') response.writeHead(200, { 'content-type': 'text/html' }).end('<!DOCTYPE html><title>File:clip.mp4</title>')
      else if (request.url === '/odd%zz.png') response.writeHead(200, { 'content-type': 'image/png' }).end(png(20, 10))
      // A recording at an address with no extension, its type the server's alone (#260).
      else if (request.url === '/stream') response.writeHead(200, { 'content-type': 'audio/ogg' }).end(Buffer.concat([Buffer.from('OggS'), Buffer.alloc(60)]))
      else if (request.url === '/trickle.png') {
        // Slow, and never silent for long: eight pieces, 100 ms apart.
        const bytes = png(40, 30)
        const step = Math.ceil(bytes.length / 8)
        response.writeHead(200, { 'content-type': 'image/png' })
        let at = 0
        const timer = setInterval(() => {
          response.write(bytes.subarray(at, (at += step)))
          if (at >= bytes.length) {
            clearInterval(timer)
            response.end()
          }
        }, 100)
      } else if (request.url === '/stalled.png') {
        // Its first bytes, then silence.
        response.writeHead(200, { 'content-type': 'image/png' }).write(png(40, 30).subarray(0, 10))
        setTimeout(() => response.end(), 5000).unref()
      } else response.writeHead(404).end()
    })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => {
    server.closeAllConnections()
    server.close()
  })

  it('copies files beside the source and from the web, with their type, size and copyright', async () => {
    await writeFile(join(dir, 'red.png'), png(300, 200))
    // A colour profile of 100 kB before the frame header, past the first read.
    await writeFile(join(dir, 'photo.jpg'), jpeg(640, 480, 100_000))
    const { content, entries, media } = await build({
      ...META,
      type: 'H5P.Dialogcards',
      params: {
        dialogs: [
          { text: 'Red', answer: 'Rot', image: { path: 'red.png', copyright: { license: 'CC BY', author: "O'Neil" } }, imageAltText: 'A red square' },
          { text: 'Map', answer: 'Karte', image: { path: `${origin}/pictures/map.png` }, imageAltText: 'A map' },
          { text: 'Tall', answer: 'Hoch', image: { path: `${origin}/picture` }, imageAltText: 'Tall' },
          { text: 'Again', answer: 'Wieder', image: { path: 'red.png' }, imageAltText: 'The same red square' },
          { text: 'Photo', answer: 'Foto', image: { path: 'photo.jpg' }, imageAltText: 'A photo' }
        ]
      }
    }, { base: dir })
    expect(content.dialogs.map(({ image }: { image: unknown }) => image)).toEqual([
      { path: 'images/red.png', mime: 'image/png', width: 300, height: 200, copyright: { license: 'CC BY', author: 'O&#39;Neil' } },
      { path: 'images/map.png', mime: 'image/png', width: 40, height: 20, copyright: { license: 'U' } },
      { path: 'images/picture.png', mime: 'image/png', width: 10, height: 30, copyright: { license: 'U' } },
      { path: 'images/red.png', mime: 'image/png', width: 300, height: 200, copyright: { license: 'U' } },
      { path: 'images/photo.jpg', mime: 'image/jpeg', width: 640, height: 480, copyright: { license: 'U' } }
    ])
    expect(media).toEqual(['images/red.png', 'images/map.png', 'images/picture.png', 'images/photo.jpg'])
    // Media stored, after the content, as the normalizer lays a package out to stream.
    const names = entries.map(entry => entry.filename)
    expect(names.indexOf('content/images/red.png')).toBeGreaterThan(names.indexOf('content/content.json'))
    expect(entries.find(entry => entry.filename === 'content/images/red.png')!.compressionMethod).toBe(0)
  })

  it("says where a file's copyright takes the licence's version, written as the source's licenseVersion (#285)", async () => {
    await writeFile(join(dir, 'red.png'), png(300, 200))
    const card = (copyright: Record<string, string>) => ({ ...META, type: 'H5P.Dialogcards', params: { dialogs: [{ text: 'Red', answer: 'Rot', image: { path: 'red.png', copyright }, imageAltText: 'A red square' }] } })
    expect(await problems(card({ license: 'CC BY', licenseVersion: '4.0', author: 'Ann' }), { base: dir })).toEqual([
      'params.dialogs[0].image.copyright.licenseVersion: is the source\'s word; a file\'s copyright names its licence\'s version "version": write "version": "4.0"'
    ])
    // Beside a version, it is one more field a copyright does not have.
    expect(await problems(card({ license: 'CC BY', version: '4.0', licenseVersion: '4.0' }), { base: dir })).toEqual([
      'params.dialogs[0].image.copyright.licenseVersion: is not part of a copyright; write license, author, title, year, source or version'
    ])
    const { content } = await build(card({ license: 'CC BY', version: '4.0', author: 'Ann' }), { base: dir })
    expect(content.dialogs[0].image.copyright).toEqual({ license: 'CC BY', version: '4.0', author: 'Ann' })
  })

  it('keeps a hosted video where it is, and moves an mp4\'s index to the front', async () => {
    await writeFile(join(dir, 'slow.mp4'), mp4(false))
    const { content, entries } = await build({
      ...META,
      type: 'H5P.Column',
      params: {
        content: [
          { content: { library: 'H5P.Video', params: { sources: [{ path: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }] } } },
          { content: { library: 'H5P.Video', params: { sources: { path: 'slow.mp4' } } } }
        ]
      }
    }, { base: dir })
    expect(content.content[0].content.params.sources).toEqual([{ path: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', mime: 'video/YouTube', copyright: { license: 'U' } }])
    expect(content.content[1].content.params.sources).toEqual([{ path: 'videos/slow.mp4', mime: 'video/mp4', copyright: { license: 'U' } }])
    const reader = new ZipReader(new BlobReader(new Blob([await readFile(join(dir, `build-${count}.h5p`))])))
    try {
      const entry = (await reader.getEntries()).find(each => each.filename === 'content/videos/slow.mp4')!
      const bytes = await (entry as import('@zip.js/zip.js').FileEntry).getData(new Uint8ArrayWriter())
      expect(Buffer.from(bytes.subarray(4, 8)).toString()).toBe('ftyp')
      expect(Buffer.from(bytes).indexOf('moov')).toBeLessThan(Buffer.from(bytes).indexOf('mdat'))
    } finally { await reader.close() }
    expect(entries.length).toBeGreaterThan(3)
  })

  it('takes a hosted video at an address H5P.Video plays, a Short\'s as its video\'s, and refuses another', async () => {
    const video = (path: string) => ({ content: { library: 'H5P.Video', params: { sources: { path } } } })
    const { content } = await build({
      ...META,
      type: 'H5P.Column',
      params: {
        content: [
          'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s',
          'https://youtu.be/dQw4w9WgXcQ?si=abc',
          'https://youtube.com/shorts/aqz-KE-bpKQ?feature=share',
          'https://vimeo.com/76979871',
          'https://video.example.edu/Panopto/Pages/Viewer.aspx?id=0b6d3a5e-1f2c-4c3e-9a51-b0d1a2c3d4e5',
          'https://echo360.org/media/0b6d3a5e-1f2c-4c3e/h5p'
        ].map(video)
      }
    })
    const sources: { path: string, mime: string }[] = content.content.map(({ content }: { content: { params: { sources: unknown[] } } }) => content.params.sources[0])
    expect(sources.map(({ mime, path }) => `${mime} ${path}`)).toEqual([
      'video/YouTube https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s',
      'video/YouTube https://youtu.be/dQw4w9WgXcQ?si=abc',
      'video/YouTube https://www.youtube.com/watch?v=aqz-KE-bpKQ',
      'video/Vimeo https://vimeo.com/76979871',
      'video/Panopto https://video.example.edu/Panopto/Pages/Viewer.aspx?id=0b6d3a5e-1f2c-4c3e-9a51-b0d1a2c3d4e5',
      'video/Echo360 https://echo360.org/media/0b6d3a5e-1f2c-4c3e/h5p'
    ])
    // H5P.Video's own patterns, read from its scripts in the pack: it chooses a player by them.
    const library = pack.libraries.find(library => library.machineName === 'H5P.Video' && library.majorVersion === 1)!
    const { files } = await archive(new URL(library.url))
    const plays = Object.fromEntries(['YouTube', 'Vimeo', 'Panopto', 'Echo360'].map((host) => {
      const [, body, flags] = /url\.match\(\/(.+)\/([a-z]*)\);/.exec(files.get(`${library.folder}/scripts/${host.toLowerCase()}.js`)!)!
      return [`video/${host}`, new RegExp(body, flags)]
    }))
    for (const { mime, path } of sources) expect(plays[mime].test(path), path).toBe(true)
    const refused = ['https://player.vimeo.com/video/76979871', 'https://www.youtube.com/playlist?list=PL0123456789', 'https://example.panopto.eu/Panopto/Pages/Sessions/List.aspx', 'https://echo360.org/lesson/0b6d3a5e/classroom']
    for (const path of refused) expect(Object.values(plays).some((pattern) => pattern.test(path)), path).toBe(false)
    expect(await problems({ ...META, type: 'H5P.Column', params: { content: refused.map(video) } })).toEqual([
      'params.content[0].content.params.sources.path: https://player.vimeo.com/video/76979871 is an address on Vimeo that H5P.Video cannot play: give https://vimeo.com/ and the video\'s number',
      'params.content[1].content.params.sources.path: https://www.youtube.com/playlist?list=PL0123456789 is an address on YouTube that H5P.Video cannot play: give https://www.youtube.com/watch?v= and the video\'s id',
      'params.content[2].content.params.sources.path: https://example.panopto.eu/Panopto/Pages/Sessions/List.aspx is an address on Panopto that H5P.Video cannot play: give the viewer\'s, …/Panopto/Pages/Viewer.aspx?id= and the session\'s id',
      'params.content[3].content.params.sources.path: https://echo360.org/lesson/0b6d3a5e/classroom is an address on Echo360 that H5P.Video cannot play: give its H5P address, https://echo360.org/media/, the media\'s id and /h5p'
    ])
  })

  it('asks YouTube and Vimeo whether they have a hosted video, once each, and says what they answered (#218)', async () => {
    const video = (path: string) => ({ content: { library: 'H5P.Video', params: { sources: { path } } } })
    const column = (paths: string[]) => ({ ...META, type: 'H5P.Column', params: { content: paths.map(video) } })
    const at = (i: number) => `params.content[${i}].content.params.sources.path`
    const asked: string[] = []
    const json = 'application/json; charset=UTF-8'
    const page = 'text/html; charset=UTF-8'
    // Each host's own answer for a status, as it sent it on 2026-11-20, by the video asked of:
    // YouTube the status's words under its JSON type, Vimeo a page of them.
    const answers: Record<string, [status: number, body: string, type: string]> = {
      aaaaaaaaaaa: [400, 'Bad Request', json], bbbbbbbbbbb: [404, 'Not Found', json], ccccccccccc: [403, 'Forbidden', json], ddddddddddd: [401, 'Unauthorized', json],
      eeeeeeeeeee: [500, 'Internal Server Error', json], '999999999': [404, '404 Not Found', page], '888888888': [403, '403 Forbidden', page],
      // A box between the build and the host, answering for it: with a page of its own, with the
      // status's words alone under its own type, as a small proxy does, and with another status's.
      fffffffffff: [403, '<html><title>Blocked</title>This site is not allowed on this network.</html>', page], ggggggggggg: [403, 'Forbidden\n', 'text/plain; charset=utf-8'],
      hhhhhhhhhhh: [404, 'Forbidden', json], '777777777': [404, '404 page not found', 'text/plain; charset=utf-8'], '666666666': [404, 'Not Found', page]
    }
    const fetch = async (input: string | URL | Request) => {
      const url = String(input)
      asked.push(url)
      const [status, body, type] = Object.entries(answers).find(([id]) => url.includes(id))?.[1] ?? [200, '{}', json]
      return new Response(body, { status, headers: { 'content-type': type } })
    }
    const youtube = (id: string) => `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`
    const vimeo = (address: string) => `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(address)}`

    const { notes } = await build(column([
      'https://www.youtube.com/embed/dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ', 'https://vimeo.com/channels/staffpicks/76979871',
      'https://video.example.edu/Panopto/Pages/Viewer.aspx?id=0b6d3a5e', 'https://www.youtube.com/watch?v=ccccccccccc', 'https://www.youtube.com/watch?v=ddddddddddd',
      'https://www.youtube.com/watch?v=eeeeeeeeeee', 'https://www.youtube.com/watch?v=fffffffffff', 'https://www.youtube.com/watch?v=ggggggggggg',
      'https://www.youtube.com/watch?v=hhhhhhhhhhh', 'https://vimeo.com/888888888', 'https://vimeo.com/777777777', 'https://vimeo.com/666666666'
    ]), { fetch })
    // A YouTube video by its watch address, which its oEmbed answers for any form; once for the two
    // forms of one video; Vimeo's as written; Panopto's not, since it answers no one.
    expect(asked).toEqual([
      youtube('dQw4w9WgXcQ'), vimeo('https://vimeo.com/channels/staffpicks/76979871'), youtube('ccccccccccc'), youtube('ddddddddddd'), youtube('eeeeeeeeeee'),
      youtube('fffffffffff'), youtube('ggggggggggg'), youtube('hhhhhhhhhhh'), vimeo('https://vimeo.com/888888888'), vimeo('https://vimeo.com/777777777'), vimeo('https://vimeo.com/666666666')
    ])
    // A video nobody else can play yet is a note. Nothing is said of a status meaningless for the
    // host (a 500; Vimeo's 403, refusing the network), nor of one not sent as the host sends it.
    expect(notes).toEqual([
      { path: at(4), message: 'https://www.youtube.com/watch?v=ccccccccccc: YouTube says the video is private: nobody but its owner can play it until it is made public or unlisted (it answered 403)' },
      { path: at(5), message: 'https://www.youtube.com/watch?v=ddddddddddd: YouTube would not say the video may be embedded, which is taken to mean its owner has turned embedding off: play it where it will be used (it answered 401)' }
    ])
    expect(await problems(column(['https://youtu.be/aaaaaaaaaaa', 'https://www.youtube.com/watch?v=bbbbbbbbbbb', 'https://vimeo.com/999999999']), { fetch })).toEqual([
      `${at(0)}: https://youtu.be/aaaaaaaaaaa: YouTube has no video there: give https://www.youtube.com/watch?v= and the id of a public or unlisted video (it answered 400)`,
      `${at(1)}: https://www.youtube.com/watch?v=bbbbbbbbbbb: YouTube has no video there any more: give https://www.youtube.com/watch?v= and the id of a public or unlisted video (it answered 404)`,
      `${at(2)}: https://vimeo.com/999999999: Vimeo has no video there that others can play: give https://vimeo.com/ and the number of a public video, or all of an unlisted video's link, which has more after the number (it answered 404)`
    ])

    // With no network the build goes on, and asks each host once, not once a video.
    const tried: string[] = []
    const offline = async (input: string | URL | Request) => {
      tried.push(new URL(String(input)).hostname)
      throw new TypeError('fetch failed')
    }
    expect((await build(column(['https://youtu.be/aaaaaaaaaaa', 'https://vimeo.com/999999999', 'https://youtu.be/bbbbbbbbbbb', 'https://vimeo.com/888888888']), { fetch: offline })).notes).toEqual([])
    expect(tried).toEqual(['www.youtube.com', 'vimeo.com'])
    // And one host that does not answer leaves the other asked: its video that is not there is still refused.
    const vimeoDown = async (input: string | URL | Request) => {
      if (String(input).startsWith('https://vimeo.com/')) throw new TypeError('fetch failed')
      return fetch(input)
    }
    expect(await problems(column(['https://vimeo.com/999999999', 'https://youtu.be/aaaaaaaaaaa']), { fetch: vimeoDown })).toEqual([
      `${at(1)}: https://youtu.be/aaaaaaaaaaa: YouTube has no video there: give https://www.youtube.com/watch?v= and the id of a public or unlisted video (it answered 400)`
    ])
  })

  it('reads a video\'s and a recording\'s first bytes, and refuses one that is not what the field takes (#218)', async () => {
    await writeFile(join(dir, 'page.mp4'), '<!DOCTYPE html><title>clip</title>')
    await writeFile(join(dir, 'song.mp3'), 'not a recording at all')
    await writeFile(join(dir, 'cut.mp4'), mp4(true).subarray(0, 40))
    // A page in UTF-16: its byte-order mark, FF FE, once passed for an MP3 frame's sync bits.
    await writeFile(join(dir, 'wide.mp3'), Buffer.from('\ufeff<!DOCTYPE html><title>song</title>', 'utf16le'))
    const video = (path: string) => ({ content: { library: 'H5P.Video', params: { sources: { path } } } })
    const audio = (path: string) => ({ content: { library: 'H5P.Audio', params: { files: { path } } } })
    expect(await problems({
      ...META,
      type: 'H5P.Column',
      params: { content: [video('page.mp4'), video(`${origin}/wiki/File:clip.mp4`), audio('song.mp3'), video('cut.mp4'), audio('wide.mp3')] }
    }, { base: dir })).toEqual([
      'params.content[0].content.params.sources.path: page.mp4 is a web page, not a video',
      `params.content[1].content.params.sources.path: ${origin}/wiki/File:clip.mp4 is a web page, not a video: give the address of the file itself`,
      'params.content[2].content.params.files.path: song.mp3 is not an MP3, M4A, WAV, Ogg or WebM recording: its first bytes are none of theirs',
      'params.content[3].content.params.sources.path: cut.mp4 has no index (moov) a player can read: is the file whole?',
      'params.content[4].content.params.files.path: wide.mp3 is a web page, not a recording'
    ])
  })

  it('says of an mp4 that it has no sound, no picture, or a picture not every browser plays (#218)', async () => {
    await writeFile(join(dir, 'silent.mp4'), mp4(false, { seconds: 30, tracks: [['vide', 'avc1']] }))
    await writeFile(join(dir, 'radio.mp4'), mp4(true, { seconds: 30, tracks: [['soun', 'mp4a']] }))
    await writeFile(join(dir, 'phone.mp4'), mp4(true, { seconds: 30, tracks: [['vide', 'hvc1'], ['soun', 'mp4a']] }))
    await writeFile(join(dir, 'fine.mp4'), mp4(true, { seconds: 30, tracks: [['vide', 'avc1'], ['soun', 'mp4a']] }))
    // An older file with no `ftyp`, its index first: an mp4 by its index, as the normalizer reads it.
    await writeFile(join(dir, 'old.mp4'), mp4(true, { seconds: 30, tracks: [['vide', 'avc1'], ['soun', 'mp4a']] }).subarray(24))
    const { notes } = await build({
      ...META,
      type: 'H5P.Column',
      params: { content: ['silent.mp4', 'radio.mp4', 'phone.mp4', 'fine.mp4', 'old.mp4'].map((path) => ({ content: { library: 'H5P.Video', params: { sources: { path } } } })) }
    }, { base: dir })
    expect(notes.filter(({ path }) => path.endsWith('.sources.path')).map(({ path, message }) => `${path}: ${message}`)).toEqual([
      'params.content[0].content.params.sources.path: silent.mp4 has no sound',
      'params.content[1].content.params.sources.path: radio.mp4 has no picture',
      'params.content[2].content.params.sources.path: phone.mp4 is HEVC (H.265), which not every browser plays; H.264 plays in all of them'
    ])
  })

  it('refuses an Interactive Video\'s time past the end of a video whose length it read (#218)', async () => {
    await writeFile(join(dir, 'short.mp4'), mp4(true, { seconds: 30.0333, tracks: [['vide', 'avc1'], ['soun', 'mp4a']] }))
    const text = (from: number, to: number) => ({ duration: { from, to }, label: 'Look', action: { library: 'H5P.Text', params: { text: 'Look' } } })
    const source = (interactions: unknown[], bookmarks: unknown[], startVideoAt?: number) => ({
      ...META,
      type: 'H5P.InteractiveVideo',
      params: { interactiveVideo: { video: { files: [{ path: 'short.mp4' }] }, assets: { interactions, bookmarks } }, ...(startVideoAt === undefined ? {} : { override: { startVideoAt, retryButton: 'on' } }) }
    })
    // An interaction that ends past the last whole second is moved by the library, keeping its
    // length (#285): one that starts past the end shows before it.
    expect(await problems(source([text(5, 30.5), text(25, 40), text(500, 600)], [{ time: 10, label: 'In' }, { time: 31, label: 'Out' }], 45), { base: dir })).toEqual([
      'params.interactiveVideo.assets.interactions[0].duration: runs from 5 to 30.5 s, and the video ends at 30.03 s: Interactive Video plays it from 4.5 to 30 s instead, so end it by 30 s',
      'params.interactiveVideo.assets.interactions[1].duration: runs from 25 to 40 s, and the video ends at 30.03 s: Interactive Video plays it from 15 to 30 s instead, so end it by 30 s',
      'params.interactiveVideo.assets.interactions[2].duration: runs from 500 to 600 s, and the video ends at 30.03 s: Interactive Video plays it from 0 to 30 s instead, so end it by 30 s',
      'params.interactiveVideo.assets.bookmarks[1].time: is 31 s, after the video ends at 30.03 s',
      'params.override.startVideoAt: is 45 s, after the video ends at 30.03 s'
    ])
    // Within its length, an interaction that ends at its last whole second included, it builds.
    expect((await build(source([text(5, 30)], [{ time: 10, label: 'In' }]), { base: dir })).content.interactiveVideo.assets.interactions).toHaveLength(1)
    // An item refused leaves a list whose indices are not the source's: no time is named in it.
    expect(await problems(source(['a stray line', text(500, 600)], []), { base: dir })).toEqual([
      expect.stringMatching(/^params\.interactiveVideo\.assets\.interactions\[0\]: expected an object/)
    ])
  })

  it('holds an Interactive Video\'s times to the length Vimeo gives for its video, and says the length it held them to (#260)', async () => {
    await writeFile(join(dir, 'lesson.mp4'), mp4(true, { seconds: 30.0333, tracks: [['vide', 'avc1'], ['soun', 'mp4a']] }))
    const text = (from: number, to: number) => ({ duration: { from, to }, label: 'Look', action: { library: 'H5P.Text', params: { text: 'Look' } } })
    const source = (path: string, interactions: unknown[]) => ({ ...META, type: 'H5P.InteractiveVideo', params: { interactiveVideo: { video: { files: [{ path }] }, assets: { interactions } } } })
    const film = 'https://vimeo.com/76979871'
    // A file's length is its index's.
    const fromFile = await build(source('lesson.mp4', [text(5, 10)]), { base: dir })
    expect(fromFile.lengths).toEqual([{ file: 'lesson.mp4', seconds: 30.033 }])
    expect(fromFile.lengths.map(lengthLine)).toEqual(['The video lesson.mp4 is 30.03 s long: keep every time within it.'])
    // Vimeo's is its own answer's, in whole seconds: an interaction is held to it, and a bookmark is
    // past the end only a second beyond it.
    const answers = (body: unknown, type = 'application/json') => async () => new Response(JSON.stringify(body), { headers: { 'content-type': type } })
    const vimeo = answers({ type: 'video', provider_name: 'Vimeo', duration: 62, video_id: 76979871 })
    const hosted = await build({ ...source(film, [text(5, 10), text(55, 62)]), params: { interactiveVideo: { video: { files: [{ path: film }] }, assets: { interactions: [text(5, 10), text(55, 62)], bookmarks: [{ time: 62.9, label: 'End' }] } } } }, { fetch: vimeo })
    expect(hosted.lengths).toEqual([{ file: film, seconds: 62, host: 'Vimeo' }])
    expect(hosted.lengths.map(lengthLine)).toEqual([`The video ${film} is about 62 s long, as Vimeo says: keep every time within it.`])
    expect(await problems(source(film, [text(5, 10), text(300, 310)]), { fetch: vimeo })).toEqual([
      'params.interactiveVideo.assets.interactions[1].duration: runs from 300 to 310 s, and the video ends at about 62 s, as Vimeo says: Interactive Video plays it from 52 to 62 s instead, so end it by 62 s'
    ])
    // An answer that is not Vimeo's own for a video it has says no length, and holds no time: not
    // naming it, a page, a video made ready, no JSON, or one too long to be read to its end.
    const long = answers({ provider_name: 'Vimeo', duration: 62, html: 'x'.repeat(70_000) })
    for (const fetch of [answers({ type: 'video', duration: 62 }), answers({ provider_name: 'Vimeo', duration: 62 }, 'text/html'), answers({ provider_name: 'Vimeo', duration: 0 }), long, async () => new Response('not an answer', { headers: { 'content-type': 'application/json' } })]) {
      expect((await build(source(film, [text(300, 310)]), { fetch })).lengths).toEqual([])
    }
    // YouTube says none.
    expect((await build(source('https://www.youtube.com/watch?v=dQw4w9WgXcQ', [text(300, 310)]), { fetch: answers({ type: 'video', provider_name: 'YouTube', duration: 62 }) })).lengths).toEqual([])
    // The command line says it, for whoever changes the times next.
    await writeFile(join(dir, 'lesson.json'), JSON.stringify(source('lesson.mp4', [text(5, 10)])))
    const { stdout } = await exec(process.execPath, [bin, 'build', '--check', join(dir, 'lesson.json')])
    expect(stdout).toContain('The video lesson.mp4 is 30.03 s long: keep every time within it.')
  })

  it('says what a source places or times by numbers alone, which only a look at the preview checks (#260)', async () => {
    await writeFile(join(dir, 'delta.png'), png(40, 30))
    await writeFile(join(dir, 'spring.mp4'), mp4(true, { seconds: 30, tracks: [['vide', 'avc1'], ['soun', 'mp4a']] }))
    const noted = async (source: Record<string, unknown>) => (await build({ ...META, ...source }, { base: dir })).notes.filter(({ message }) => message.startsWith('holds ')).map(({ path, message }) => `${path}: ${message}`)
    const spot = (x: number, y: number) => ({ position: { x, y }, header: 'Here', content: [{ library: 'H5P.Text', params: { text: 'Here.' } }] })
    const hotspots = (spots: unknown[]) => ({ type: 'H5P.ImageHotspots', params: { image: { path: 'delta.png' }, backgroundImageAltText: 'A delta', hotspots: spots } })
    expect(await noted(hotspots([spot(30, 40), spot(70, 65)]))).toEqual(['params.hotspots: holds 2 hotspots placed by numbers, which a build cannot hold to the picture: look at each in the preview'])
    expect(await noted(hotspots([spot(30, 40)]))).toEqual(['params.hotspots: holds 1 hotspot placed by numbers, which a build cannot hold to the picture: look at it in the preview'])
    const area = (x: number, correct: boolean) => ({ computedSettings: { x, y: 10, width: 20, height: 20, figure: 'circle' }, userSettings: { correct, feedbackText: 'There.' } })
    expect(await noted({
      type: 'H5P.ImageHotspotQuestion',
      params: { imageHotspotQuestion: { backgroundImageSettings: { path: 'delta.png' }, hotspotSettings: { taskDescription: 'Click the mouth.', hotspot: [area(60, true), area(10, false)] } } }
    })).toEqual(['params.imageHotspotQuestion.hotspotSettings.hotspot: holds 2 areas placed by numbers, which a build cannot hold to the picture: look at each in the preview'])
    const stage = (label: string, x: number, more: Record<string, unknown> = {}) => ({
      label, telemetry: { x, y: 40 }, contentsList: [{ contentType: { library: 'H5P.TrueFalse', params: { question: 'A river can begin at a glacier.', correct: 'true' } } }], ...more
    })
    expect(await noted({
      type: 'H5P.GameMap',
      params: { gamemapSteps: { backgroundImageSettings: { backgroundImage: { path: 'delta.png' } }, gamemap: { elements: [stage('Source', 15, { canBeStartStage: true, neighbors: ['Mouth'] }), stage('Mouth', 75)] } } }
    })).toEqual(['params.gamemapSteps.gamemap.elements: holds 2 stages placed by numbers, which a build cannot hold to the map: look at each in the preview'])
    // An Interactive Video's times, wherever the type is, by where the source has it; and none with nothing timed.
    const video = (interactions: unknown[]) => ({ library: 'H5P.InteractiveVideo', params: { interactiveVideo: { video: { files: [{ path: 'spring.mp4' }] }, assets: { interactions } } } })
    const text = { duration: { from: 2, to: 6 }, label: 'Look', action: { library: 'H5P.Text', params: { text: 'Look' } } }
    expect(await noted({ type: 'H5P.Column', params: { content: [{ content: video([text, text, text]) }] } })).toEqual([
      'params.content[0].content.params.interactiveVideo.assets.interactions: holds 3 interactions shown at the times written, which a build cannot hold to what the video shows then: play it through in the preview'
    ])
    expect(await noted({ type: 'H5P.Column', params: { content: [{ content: video([]) }] } })).toEqual([])
  })

  it('says what a file is before a source names it: a picture\'s size, a video\'s length, its host\'s word (#260)', async () => {
    const both: [string, string][] = [['vide', 'avc1'], ['soun', 'mp4a']]
    await writeFile(join(dir, 'wide.png'), png(1200, 800))
    await writeFile(join(dir, 'photo.jpg'), jpeg(640, 480))
    await writeFile(join(dir, 'talk.mp4'), mp4(true, { seconds: 12.5, tracks: both }))
    await writeFile(join(dir, 'mute.mp4'), mp4(false, { seconds: 12.5, tracks: [['vide', 'hvc1']] }))
    await writeFile(join(dir, 'voice.m4a'), mp4(true, { seconds: 3, tracks: [['soun', 'mp4a']] }))
    await writeFile(join(dir, 'reel.webm'), Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
    await writeFile(join(dir, 'tune.mp3'), 'ID3 and then its frames')
    await writeFile(join(dir, 'saved.mp4'), '<!DOCTYPE html><title>clip</title>')
    await writeFile(join(dir, 'torn.png'), 'not a picture')
    await writeFile(join(dir, 'plan.txt'), 'notes')
    const film = 'https://vimeo.com/76979871'
    const tube = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    const fetch = async (input: string | URL | Request) => {
      const url = String(input)
      if (url.startsWith(origin)) return globalThis.fetch(input)
      if (url.includes('999999999')) return new Response('404 Not Found', { status: 404, headers: { 'content-type': 'text/html; charset=UTF-8' } })
      return Response.json(url.startsWith('https://vimeo.com/') ? { type: 'video', provider_name: 'Vimeo', duration: 62 } : { type: 'video', provider_name: 'YouTube' })
    }
    const named = [
      'wide.png', 'photo.jpg', 'talk.mp4', 'mute.mp4', 'voice.m4a', 'reel.webm', 'tune.mp3', `${origin}/pictures/map.png`, film, tube,
      'https://video.example.edu/Panopto/Pages/Viewer.aspx?id=0b6d3a5e', 'saved.mp4', 'torn.png', 'plan.txt', 'gone.png', 'https://vimeo.com/999999999',
      'https://www.youtube.com/playlist?list=PL0', `${origin}/page.html`, 'ftp://files.example/clip.mp4', `${origin}/stream`
    ]
    const facts = await describeMedia(named, { base: dir, fetch })
    expect(facts.map(({ source }) => source)).toEqual(named)
    expect(facts.map(mediaLine)).toEqual([
      'wide.png: a PNG picture, 1200 by 800 pixels',
      'photo.jpg: a JPEG picture, 640 by 480 pixels',
      'talk.mp4: an MP4 video, 12.5 s long',
      'mute.mp4: an MP4 video, 12.5 s long; it has no sound; it is HEVC (H.265), which not every browser plays; H.264 plays in all of them',
      'voice.m4a: an MP4 recording, 3 s long',
      'reel.webm: a WebM file, whose length a build does not read',
      'tune.mp3: an MP3 recording, whose length a build does not read',
      `${origin}/pictures/map.png: a PNG picture, 40 by 20 pixels`,
      `${film}: a video on Vimeo, about 62 s long`,
      `${tube}: a video on YouTube, which does not say how long it is`,
      'https://video.example.edu/Panopto/Pages/Viewer.aspx?id=0b6d3a5e: a video on Panopto, which does not say how long it is',
      'saved.mp4: it is a web page, not a video',
      'torn.png is not a PNG image whose size can be read',
      'plan.txt: only a picture, a video or a recording is read: .png, .jpg, .jpeg, .gif, .bmp, .mp3, .m4a, .wav, .ogg, .webm, .mp4',
      `gone.png: no such file (${join(dir, 'gone.png')})`,
      'https://vimeo.com/999999999: Vimeo has no video there that others can play: give https://vimeo.com/ and the number of a public video, or all of an unlisted video\'s link, which has more after the number (it answered 404)',
      'https://www.youtube.com/playlist?list=PL0 is an address on YouTube that H5P.Video cannot play: give https://www.youtube.com/watch?v= and the video\'s id',
      `${origin}/page.html is text/html: only a picture, a video or a recording is read: .png, .jpg, .jpeg, .gif, .bmp, .mp3, .m4a, .wav, .ogg, .webm, .mp4`,
      'ftp://files.example/clip.mp4: expected a file or an http(s) address',
      `${origin}/stream: an Ogg file, whose length a build does not read`
    ])
    expect(facts.slice(0, 3)).toEqual([
      { source: 'wide.png', kind: 'image', format: 'PNG', width: 1200, height: 800, notes: [] },
      { source: 'photo.jpg', kind: 'image', format: 'JPEG', width: 640, height: 480, notes: [] },
      { source: 'talk.mp4', kind: 'video', format: 'MP4', seconds: 12.5, notes: [] }
    ])
    // Confined, a file outside the folders is refused before it is looked for, and no path is named.
    expect((await describeMedia(['../wide.png', 'wide.png'], { base: dir, within: [dir] })).map(mediaLine)).toEqual([
      '../wide.png: is outside the folders this build may read', 'wide.png: a PNG picture, 1200 by 800 pixels'
    ])
    await expect(describeMedia('wide.png' as unknown as string[])).rejects.toThrow('takes a list of paths or web addresses')
    // The command: a line each, a problem on standard error, and a failing exit where there is one.
    const { stdout } = await exec(process.execPath, [bin, 'media', 'wide.png', 'talk.mp4'], { cwd: dir })
    expect(stdout).toBe('wide.png: a PNG picture, 1200 by 800 pixels\ntalk.mp4: an MP4 video, 12.5 s long\n')
    const failed = await exec(process.execPath, [bin, 'media', 'wide.png', 'plan.txt'], { cwd: dir }).then(() => null, (error: { code: number, stdout: string, stderr: string }) => error)
    expect(failed).toMatchObject({ code: 1, stdout: 'wide.png: a PNG picture, 1200 by 800 pixels\n', stderr: expect.stringContaining('plan.txt: only a picture, a video or a recording is read') })
    await expect(exec(process.execPath, [bin, 'media'])).rejects.toMatchObject({ stderr: expect.stringContaining('media takes the files to look at') })
    await expect(exec(process.execPath, [bin, 'media', 'wide.png', '--check'], { cwd: dir })).rejects.toMatchObject({ stderr: expect.stringContaining('media does not take --check') })
  })

  it('gives a download up once nothing has arrived for a while, however long a slow one takes', async () => {
    const reported: string[] = []
    const report = (path: string, message: string) => reported.push(`${path}: ${message}`)
    const store = new MediaStore(nodeMedia({ base: dir, temporary: dir }), { idle: 300 })
    expect(await store.resolve({ type: 'image' }, { path: `${origin}/trickle.png` }, 'params.slow', report)).toMatchObject({ path: 'images/trickle.png', width: 40, height: 30 })
    expect(await store.resolve({ type: 'image' }, { path: `${origin}/stalled.png` }, 'params.silent', report)).toEqual({ path: `${origin}/stalled.png`, copyright: { license: 'U' } })
    expect(reported).toEqual([`params.silent.path: ${origin}/stalled.png could not be downloaded: nothing arrived for 0.3 s`])
  })

  it('keeps a download whose address has an escape that is not one, under its name as written (#162)', async () => {
    const reported: string[] = []
    const store = new MediaStore(nodeMedia({ base: dir, temporary: dir }))
    expect(await store.resolve({ type: 'image' }, { path: `${origin}/odd%zz.png` }, 'params.odd', (path, message) => reported.push(`${path}: ${message}`))).toMatchObject({ path: 'images/odd-zz.png', width: 20, height: 10 })
    expect(reported).toEqual([])
  })

  it('copies one file named in an image field and a file field once for each, as H5P keeps them apart (#162)', async () => {
    await writeFile(join(dir, 'chart.png'), png(30, 20))
    const store = new MediaStore(nodeMedia({ base: dir, temporary: dir }))
    const report = () => { throw new Error('no problem expected') }
    expect(await store.resolve({ type: 'file' }, { path: 'chart.png' }, 'params.download', report)).toEqual({ path: 'files/chart.png', mime: 'image/png', copyright: { license: 'U' } })
    expect(await store.resolve({ type: 'image' }, { path: 'chart.png' }, 'params.picture', report)).toEqual({ path: 'images/chart.png', mime: 'image/png', width: 30, height: 20, copyright: { license: 'U' } })
    expect(await store.resolve({ type: 'image' }, { path: 'chart.png' }, 'params.again', report)).toMatchObject({ path: 'images/chart.png' })
    expect(store.files.map(({ name }) => name)).toEqual(['files/chart.png', 'images/chart.png'])
  })

  it('names a file that is missing, of a type the field does not take, or not downloadable', async () => {
    await writeFile(join(dir, 'notes.txt'), 'x')
    await writeFile(join(dir, 'x.constructor'), 'x')
    expect(await problems({
      ...META,
      type: 'H5P.MemoryGame',
      params: {
        cards: [
          { image: { path: 'missing.png' }, imageAlt: 'a' },
          { image: { path: 'notes.txt' }, imageAlt: 'b' },
          { image: { path: `${origin}/gone.png` }, imageAlt: 'c' },
          { image: { path: `${origin}/page.html` }, imageAlt: 'd' },
          { image: { path: 'ftp://example.org/a.png' }, imageAlt: 'e' },
          { image: { path: 'x.constructor' }, imageAlt: 'f' }
        ]
      }
    }, { base: dir })).toEqual([
      expect.stringMatching(/^params\.cards\[0\]\.image\.path: missing\.png: no such file beside the source/),
      'params.cards[1].image.path: notes.txt: this field takes .png, .jpg, .jpeg, .gif, .bmp',
      `params.cards[2].image.path: ${origin}/gone.png answered 404`,
      `params.cards[3].image.path: ${origin}/page.html is text/html: this field takes .png, .jpg, .jpeg, .gif, .bmp`,
      'params.cards[4].image.path: expected a file beside the source or an http(s) address',
      // A name an object's prototype has is no type (#162).
      'params.cards[5].image.path: x.constructor: this field takes .png, .jpg, .jpeg, .gif, .bmp'
    ])
  })
})

describe('the build', () => {
  it('does not overwrite an output, publish partial failures, or leave staging directories', async () => {
    const path = join(dir, 'existing.h5p')
    await writeFile(path, 'keep me')
    const refusal = { code: 'EEXIST', message: `${path} exists, and a build never writes over a file: name a new one` }
    await expect(buildPackage(example, path)).rejects.toMatchObject(refusal)
    // Before any work: a source with problems is not read.
    await expect(buildPackage({}, path)).rejects.toMatchObject(refusal)
    expect(await readFile(path, 'utf8')).toBe('keep me')
    await expect(buildPackage(example, join(dir, 'nowhere', 'quiz.h5p'))).rejects.toThrow(`${join(dir, 'nowhere')} is not a folder to write the package in`)
    expect((await readdir(dir)).filter(name => name.startsWith('.h5p-author-'))).toEqual([])
    await expect(buildPackage({ ...example, questions: [] }, join(dir, 'invalid.h5p'))).rejects.toThrow('quiz.questions')
    expect(await readdir(dir)).not.toContain('invalid.h5p')
  })

  it('refuses a damaged library part before publishing an archive', async () => {
    const damaged = join(dir, 'damaged-parts')
    await cp(parts, damaged, { recursive: true })
    const library = pack.libraries.find(library => library.machineName === 'H5P.MultiChoice' && library.majorVersion === 1)!
    const part = join(damaged, `${library.folder}.h5p`)
    const bytes = await readFile(part)
    const reader = new ZipReader(new BlobReader(new Blob([bytes])))
    try {
      const entry = (await reader.getEntries()).find(entry => !entry.directory && entry.filename.endsWith('.js'))!
      const offset = entry.offset + 30 + bytes.readUInt16LE(entry.offset + 26) + bytes.readUInt16LE(entry.offset + 28)
      // Damage script data without changing library.json, semantics, or the central directory.
      bytes[offset + Math.floor(entry.compressedSize / 2)] ^= 1
    } finally { await reader.close() }
    await writeFile(part, bytes)
    const output = join(dir, 'damaged.h5p')
    await expect(buildPackage(example, output, { libraries: damaged })).rejects.toThrow(`The library part ${library.folder} does not match the pack's index (SHA-256)`)
    expect(await readdir(dir)).not.toContain('damaged.h5p')
  })

  it('runs as a command: build, with the interface texts\' languages said, and schema', async () => {
    const project = await mkdtemp(join(dir, 'project-'))
    await writeFile(join(project, 'german.json'), JSON.stringify({ ...example, language: 'de' }))
    const german = await exec(process.execPath, [bin, 'build', 'german.json', 'german.h5p'], { cwd: project })
    expect(german.stdout).toMatch(/^Built .*german\.h5p: H5P\.QuestionSet, \d+ libraries from the library pack \d+\.\d+\.\d+, \d+ more for installing on an H5P site\.\nNeeds H5P core \d+\.\d+ or newer on a site it is uploaded to\b/)
    expect(german.stdout).toMatch(/H5P\.MultiChoice 1\.\d+: interface texts from its translation language\/de\.json\./)
    expect(german.stdout + german.stderr).toMatch(/H5P\.QuestionSet 1\.\d+: interface texts from its translation language\/de\.json/)
    expect(german.stdout).toContain('Not verified')
    const failed = exec(process.execPath, [bin, 'build', 'german.json', 'german.h5p'], { cwd: project })
    await expect(failed).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('german.h5p exists, and a build never writes over a file: name a new one') })
    await writeFile(join(project, 'wrong.json'), JSON.stringify({ ...META, type: 'H5P.TrueFalse', params: { correct: 'maybe' } }))
    await expect(exec(process.execPath, [bin, 'build', 'wrong.json', 'wrong.h5p'], { cwd: project })).rejects.toMatchObject({
      code: 1, stderr: expect.stringContaining('params.correct: "maybe" is not an option')
    })
    const { stdout: schema } = await exec(process.execPath, [bin, 'schema', 'H5P.TrueFalse'])
    expect(schema).toMatch(/^H5P\.TrueFalse 1\.\d+: True\/False Question\n- `media` group/)
    expect(schema).toContain('- `correct` one of "true" | "false" = "true"')
    await expect(exec(process.execPath, [bin, 'schema', 'H5P.Nope'])).rejects.toMatchObject({ stderr: expect.stringContaining('H5P.Blanks (Fill in the Blanks)') })
    // --name=value, -h and -v, as the verifier and embed read them (#162).
    expect((await exec(process.execPath, [bin, 'schema', 'H5P.TrueFalse', `--libraries=${parts}`])).stdout).toBe(schema)
    expect((await exec(process.execPath, [bin, '-h'])).stdout).toMatch(/^Usage:\n {2}h5p-author build/)
    expect((await exec(process.execPath, [bin, '-v'])).stdout).toMatch(/^@missing-elements\/h5p-author \d+\.\d+\.\d+, library pack \d+\.\d+\.\d+\n$/)
    await expect(exec(process.execPath, [bin, 'build', 'a.json', 'a.h5p', '--markdown'])).rejects.toMatchObject({ code: 1, stderr: 'h5p-author: build does not take --markdown\n' })
  })
})

describe('what a source was built with (#219)', () => {
  const entry = pack.libraries.find(library => library.machineName === 'H5P.TrueFalse')!
  const now = `H5P.TrueFalse ${entry.majorVersion}.${entry.minorVersion}`
  const before = `H5P.TrueFalse ${entry.majorVersion}.${entry.minorVersion - 1}`
  const source = { ...META, type: 'H5P.TrueFalse', params: { question: 'Is the Nile a river?', correct: 'true' } }

  it('hands back the source naming the content type and the pack\'s version of it, beside its type', async () => {
    const result = await build(source)
    expect(result.builtWith).toBe(now)
    expect(result.source).toEqual({ ...source, builtWith: now })
    expect(Object.keys(result.source).slice(0, 2)).toEqual(['type', 'builtWith'])
    // Built again as handed back: the same content, and nothing said.
    const again = await build(result.source)
    expect(again.content).toEqual(result.content)
    expect(again.notes).toEqual([])
    expect((await buildPackage(source, undefined, { check: true })).builtWith).toBe(now)
  })

  it('says so where the pack has another version of the type: a note where it builds, beside the problems where it does not', async () => {
    const { notes, source: kept } = await build({ ...source, builtWith: before })
    expect(notes).toEqual([{ path: 'builtWith', message: `was ${before} and this pack has ${now}: its fields may have changed since, so play it through before handing it over` }])
    expect(kept.builtWith).toBe(now)
    expect(await problems({ ...source, builtWith: before, params: { ...source.params, corect: 'true' } })).toEqual([
      expect.stringMatching(/^params\.corect: is not a field here/),
      `builtWith: this source was last built with ${before} and this pack has ${now}: a field named here may have changed since, and the type's fields as they are now say what to write`
    ])
    // Alone it is no problem, and another type's is the type changed by hand: named anew, nothing said.
    expect((await build({ ...source, builtWith: 'H5P.Blanks 1.14' })).notes).toEqual([])
  })

  it('refuses one that is not a type and a version, saying to leave it out', async () => {
    for (const builtWith of ['yes', 'H5P.TrueFalse', 1.8, 'H5P.TrueFalse 1.8.2']) {
      expect(await problems({ ...source, builtWith })).toEqual(['builtWith: is written by a build, the content type and its version then, as "H5P.Blanks 1.14": leave it out'])
    }
  })

  it('as a command writes it beside the package, never over a file but the one it builds from', async () => {
    const project = await realpath(await mkdtemp(join(dir, 'built-with-')))
    const run = (...args: string[]) => exec(process.execPath, [bin, 'build', ...args], { cwd: project })
    const read = async (name: string) => JSON.parse(await readFile(join(project, name), 'utf8'))
    await writeFile(join(project, 'source.json'), JSON.stringify(source))
    const { stdout } = await run('source.json', 'rivers.h5p')
    expect(stdout).toContain(`Its source, naming ${now} as what it was built with, is ${join(project, 'rivers.source.json')}: hand it over with the package.`)
    expect(await read('rivers.source.json')).toEqual({ ...source, builtWith: now })

    // A name that is taken stops the build before it writes a package; a check writes neither.
    await writeFile(join(project, 'taken.source.json'), 'mine')
    await expect(run('source.json', 'taken.h5p')).rejects.toMatchObject({ stderr: expect.stringContaining('taken.source.json exists, and a build writes its source there and never over a file: name a new package') })
    await run('--check', 'source.json')
    expect((await readdir(project)).sort()).toEqual(['rivers.h5p', 'rivers.source.json', 'source.json', 'taken.source.json'])
    expect(await readFile(join(project, 'taken.source.json'), 'utf8')).toBe('mine')

    // The file it builds from is kept up to date, and left as it is where it says so already.
    await writeFile(join(project, 'old.source.json'), JSON.stringify({ ...source, builtWith: before }))
    const old = await run('old.source.json', 'old.h5p')
    expect(old.stderr).toContain(`Note: builtWith was ${before} and this pack has ${now}`)
    expect(await read('old.source.json')).toEqual({ ...source, builtWith: now })
    const written = `${JSON.stringify({ ...source, builtWith: now })}\n\n`
    await writeFile(join(project, 'same.source.json'), written)
    await run('same.source.json', 'same.h5p')
    expect(await readFile(join(project, 'same.source.json'), 'utf8')).toBe(written)

    // A quiz in the quiz format has no field for it, and stays as written.
    const quiz = JSON.stringify(example)
    await writeFile(join(project, 'quiz.source.json'), quiz)
    const { stdout: said } = await run('quiz.source.json', 'quiz.h5p')
    expect(said).not.toContain('Its source')
    expect(await readFile(join(project, 'quiz.source.json'), 'utf8')).toBe(quiz)
    expect((await readdir(project)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })
})

describe('the package', () => {
  it('carries the skill\'s text, build routes and type files, copied as it is packed, for a page to hand to a chat (#172, #178)', async () => {
    const skill = resolve(import.meta.dirname, '../../../skills/h5p-author')
    const copied = resolve(import.meta.dirname, '../references/types')
    const { stdout } = await exec(process.execPath, [resolve(import.meta.dirname, '../scripts/copy-skill.mjs')])
    const names = (await readdir(join(skill, 'references/types'))).filter(name => name.endsWith('.md')).sort()
    expect(names).toContain('H5P.InteractiveBook.md')
    const routes = (await readdir(join(skill, 'references/build'))).filter(name => name.endsWith('.md')).sort()
    expect(routes).toContain('browser.md')
    expect(stdout).toContain(`Copied SKILL.md, references/authoring.md, references/change.md, ${routes.length} build files to references/build/ and ${names.length} type files`)
    expect((await readdir(copied)).sort()).toEqual(names)
    for (const name of names) expect(await readFile(join(copied, name), 'utf8'), name).toBe(await readFile(join(skill, 'references/types', name), 'utf8'))
    // The skill's text beside them, as it is, for a site to serve to a chat given a link.
    for (const name of ['SKILL.md', 'references/authoring.md', 'references/change.md', ...routes.map(route => `references/build/${route}`)]) {
      expect(await readFile(resolve(import.meta.dirname, '..', name), 'utf8'), name).toBe(await readFile(join(skill, name), 'utf8'))
    }
    // Packed and found: in `files`, copied by `prepack`, and each one an export of its own.
    const manifest = JSON.parse(await readFile(resolve(import.meta.dirname, '../package.json'), 'utf8'))
    expect(manifest.files).toEqual(expect.arrayContaining(['references', 'SKILL.md']))
    expect(manifest.scripts.prepack).toContain('node scripts/copy-skill.mjs')
    const require = createRequire(import.meta.url)
    expect(require.resolve('@missing-elements/h5p-author/references/types/H5P.InteractiveBook.md')).toBe(join(copied, 'H5P.InteractiveBook.md'))
    expect(require.resolve('@missing-elements/h5p-author/SKILL.md')).toBe(resolve(import.meta.dirname, '../SKILL.md'))
    expect(require.resolve('@missing-elements/h5p-author/references/authoring.md')).toBe(resolve(import.meta.dirname, '../references/authoring.md'))
    expect(require.resolve('@missing-elements/h5p-author/references/change.md')).toBe(resolve(import.meta.dirname, '../references/change.md'))
    expect(require.resolve('@missing-elements/h5p-author/references/build/browser.md')).toBe(resolve(import.meta.dirname, '../references/build/browser.md'))
  })
})

describe('installing on an H5P site (#146)', () => {
  /** Every `library.json` an archive carries. */
  const carried = (files: Map<string, string>) => [...files].filter(([name]) => /^[^/]+\/library\.json$/.test(name)).map(([, text]) => JSON.parse(text))

  it('carries what H5P core\'s upload check wants of its libraries, after the content, and lists only what plays in h5p.json', async () => {
    const { files, entries, manifest, libraries, install } = await build(example)
    expect(libraries).toContain('H5P.QuestionSet-1.21')
    expect(install.length).toBeGreaterThan(0)
    // The editor libraries at least; an older minor a library names may join them as the hub moves.
    expect(install.some(folder => folder.startsWith('H5PEditor.'))).toBe(true)
    // Nothing a carried library names, preloaded, dynamic or editor, is missing at its exact version.
    expect(missingForInstall(carried(files))).toEqual([])
    // Not in the manifest, as the platforms' own exports write it.
    const named = new Set(manifest.preloadedDependencies.map((each: { machineName: string }) => each.machineName))
    for (const folder of install) expect(named.has(folder.slice(0, folder.lastIndexOf('-')))).toBe(false)
    // After the content, where nothing reads them as the package plays; the media come last.
    const names = entries.map(entry => entry.filename)
    const content = names.indexOf('content/content.json')
    for (const folder of install) for (const name of names.filter(each => each.startsWith(`${folder}/`))) expect(names.indexOf(name)).toBeGreaterThan(content)
    for (const folder of libraries) for (const name of names.filter(each => each.startsWith(`${folder}/`))) expect(names.indexOf(name)).toBeLessThan(content)
  })

  it('carries the older minor a library names exactly, beside the newer one that plays', async () => {
    const base = await mkdtemp(join(dir, 'sequence-'))
    for (const name of ['a.png', 'b.png', 'c.png']) await writeFile(join(base, name), png(40, 20))
    // Image Sequencing 1.1 names H5P.Audio 1.2; the pack plays 1.5, which the package carries for it.
    const { libraries, install, files } = await build({
      ...META,
      type: 'H5P.ImageSequencing',
      params: { sequenceImages: ['a', 'b', 'c'].map(name => ({ image: { path: `${name}.png` }, imageDescription: name.toUpperCase() })) }
    }, { base })
    expect(libraries).toContain('H5P.Audio-1.5')
    expect(install).toContain('H5P.Audio-1.2')
    expect(missingForInstall(carried(files))).toEqual([])
  })

  it('refuses to build from a pack that lacks them, naming the first and where the pack with them is', async () => {
    const lean = join(dir, 'lean-parts')
    await cp(parts, lean, { recursive: true })
    const index = JSON.parse(await readFile(join(lean, 'index.json'), 'utf8'))
    await writeFile(join(lean, 'index.json'), JSON.stringify({ libraries: index.libraries.filter((entry: { installOnly?: true }) => !entry.installOnly) }))
    await expect(buildPackage(example, join(dir, 'lean.h5p'), { libraries: lean })).rejects.toThrow(
      /^The library pack cannot supply H5PEditor\.\S+ \d+\.\d+, which H5P\.\S+ \d+\.\d+ needs to install on an H5P site: a page imports the pack from '@missing-elements\/h5p-libraries\/install'/
    )
    expect(await readdir(dir)).not.toContain('lean.h5p')
  })
})

describe('as H5P\'s editor and validator take a source (#302)', () => {
  it('stores a select\'s option as text, as the editor does, so True/False plays the answer written', async () => {
    for (const correct of [true, 'true']) {
      const { content } = await build({ ...META, type: 'H5P.TrueFalse', params: { question: '<p>The Danube is in Europe.</p>', correct } })
      expect(content.correct).toBe('true')
    }
    expect((await build({ ...META, type: 'H5P.TrueFalse', params: { question: '<p>The Nile is in Europe.</p>', correct: false } })).content.correct).toBe('false')
  })

  it('names no media file with a leading "_", which H5P\'s upload skips', async () => {
    await writeFile(join(dir, '_DSC1234.png'), png(64, 48))
    const { content, files } = await build({ ...META, type: 'H5P.Column', params: { content: [{ content: { library: 'H5P.Image', params: { file: { path: '_DSC1234.png' }, alt: 'A river' } } }] } }, { base: dir })
    expect(content.content[0].content.params.file.path).toBe('images/DSC1234.png')
    expect(files.has('content/images/DSC1234.png')).toBe(true)
  })

  it('refuses a hosted address beside other sources, which H5P.Video would not play', async () => {
    const video = (sources: unknown) => ({ ...META, type: 'H5P.Column', params: { content: [{ content: { library: 'H5P.Video', params: { sources } } }] } })
    expect(await problems(video([{ path: 'clip.mp4' }, { path: 'https://youtu.be/dQw4w9WgXcQ' }]), { check: true, unread: true })).toEqual([
      'params.content[0].content.params.sources: a YouTube, Vimeo, Panopto or Echo360 address is a video\'s one source: H5P.Video plays only the first, and the editor keeps no other beside it'
    ])
  })

  it('keeps a video\'s quality label, which H5P.Video shows, and reads it back', async () => {
    await writeFile(join(dir, 'tour.mp4'), mp4(false))
    const source = { ...META, type: 'H5P.InteractiveVideo', params: { interactiveVideo: { video: { files: [{ path: 'tour.mp4', metadata: { qualityName: '720p & up' } }] } } } }
    const { content } = await build(source, { base: dir })
    expect(content.interactiveVideo.video.files[0].metadata).toEqual({ qualityName: '720p &amp; up' })
    expect(await problems({ ...source, params: { interactiveVideo: { video: { files: [{ path: 'tour.mp4', metadata: { label: '720p' } }] } } } }, { check: true, unread: true })).toEqual([
      'params.interactiveVideo.video.files[0].metadata: expected { "qualityName": "…" }, the label the player shows for this quality, as "720p"'
    ])
  })
})

describe('an optional group written in part (#302)', () => {
  it('asks for none of its other fields, as the editor and the validator make them optional', async () => {
    const quiz = (titleScreen: unknown) => ({ ...META, type: 'H5P.PersonalityQuiz', params: { titleScreen, personalities: [{ name: 'Calm', description: 'Steady' }, { name: 'Bold', description: 'Brave' }], questions: [{ text: 'A lake or a river?', answers: [{ text: 'A lake', personality: 'Calm' }, { text: 'A river', personality: 'Bold' }] }] } })
    // Personality Quiz's title picture, an optional group: its file alone, and no alt text asked for.
    const built = await buildPackage(quiz({ title: { text: 'Which water are you?' }, image: { file: { path: 'lake.png' } } }), undefined, { check: true, unread: true, libraries: undefined })
    expect(built.unread).toEqual(['lake.png'])
  })
})

describe('a file\'s copyright, as the editor writes one (#302)', () => {
  const picture = (copyright: unknown) => ({ ...META, type: 'H5P.Column', params: { content: [{ content: { library: 'H5P.Image', params: { file: { path: 'river.png', copyright }, alt: 'A river' } } }] } })
  it('writes CC0 1.0 and CC PDM as PD with that version, and holds a version to its licence', async () => {
    await writeFile(join(dir, 'river.png'), png(64, 48))
    for (const license of ['CC0 1.0', 'CC PDM']) {
      const { content } = await build(picture({ license, author: 'Ann' }), { base: dir })
      expect(content.content[0].content.params.file.copyright).toEqual({ license: 'PD', version: license, author: 'Ann' })
    }
    expect(await problems(picture({ license: 'CC BY', version: '9.9' }), { base: dir })).toEqual(['params.content[0].content.params.file.copyright.version: "9.9" is no version of CC BY: use one of 4.0, 3.0, 2.5, 2.0, 1.0'])
    expect(await problems(picture({ license: 'U', version: '4.0' }), { base: dir })).toEqual(['params.content[0].content.params.file.copyright.version: U takes no version: leave it out'])
    expect(await problems(picture({ license: 'GNU GPL', version: '4.0' }), { base: dir })).toEqual(['params.content[0].content.params.file.copyright.version: "4.0" is no version of GNU GPL: use one of v3, v2, v1'])
    expect((await build(picture({ license: 'GNU GPL', version: 'v3' }), { base: dir })).content.content[0].content.params.file.copyright).toEqual({ license: 'GNU GPL', version: 'v3' })
  })
})
