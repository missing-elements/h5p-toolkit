import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { crc32 } from 'node:zlib'
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, type FileEntry } from '@zip.js/zip.js'
import { pack } from '@missing-elements/h5p-libraries/install'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildPackage as buildInNode } from '../lib/author.mjs'
import { buildPackage, openPack, SourceError } from '../lib/browser.mjs'
import { png } from './helpers/media'
import { mp4 } from './helpers/mp4'

// The page's build, run in Node with the pack's parts read from disk as a page fetches them from
// its server. tests/browser/ runs it in Chromium and plays what it writes.
const parts = resolve(import.meta.dirname, '../../libraries/parts')
const META = { title: 'Rivers', language: 'en', license: 'CC BY', authors: [{ name: 'Ann Author', role: 'Author' }] }
const BLANKS = { ...META, type: 'H5P.Blanks', params: { questions: ['The *Danube* reaches the Black Sea.'] } }
const image = (path: string) => ({ library: 'H5P.Image', params: { file: { path }, alt: 'The Volga at Yaroslavl' } })
const QUIZ = {
  ...META,
  type: 'H5P.QuestionSet',
  params: {
    questions: [{
      library: 'H5P.MultiChoice',
      metadata: { title: 'The longest river' },
      params: {
        media: { type: image('volga.png') },
        question: 'Which river is the longest in Europe?',
        answers: [{ text: 'Volga', correct: true }, { text: 'Danube', correct: false }]
      }
    }]
  }
}
const VIDEO = (path: string, from = 5) => ({
  ...META,
  type: 'H5P.InteractiveVideo',
  params: { interactiveVideo: { video: { files: [{ path }] }, assets: { interactions: [{ duration: { from, to: from + 2 }, label: 'Look', action: { library: 'H5P.Text', params: { text: 'Look' } } }] } } }
})
let dir: string
let opened: Awaited<ReturnType<typeof openPack>>
let fetched: string[]

/** A part, as the page's server would serve it. */
async function fromDisk(input: RequestInfo | URL) {
  fetched.push(String(input))
  return new Response(new Uint8Array(await readFile(fileURLToPath(String(input)))))
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'h5p-author-page-'))
  fetched = []
  opened = await openPack(pack, { fetch: fromDisk })
})
afterAll(async () => {
  await opened?.close()
  if (dir) await rm(dir, { recursive: true, force: true })
})

/** Every file of a package, and its entries. */
async function archive(bytes: Uint8Array) {
  const reader = new ZipReader(new Uint8ArrayReader(bytes), { checkSignature: true })
  try {
    const entries = (await reader.getEntries()).filter((entry) => !entry.directory) as FileEntry[]
    const files = new Map<string, Uint8Array>()
    for (const entry of entries) files.set(entry.filename, await entry.getData(new Uint8ArrayWriter()))
    return { files, entries }
  } finally {
    await reader.close()
  }
}

/** An entry's local header, as the player reads it on a host without `Range`. */
function localHeader(bytes: Uint8Array, offset: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return {
    signature: view.getUint32(offset, true), flags: view.getUint16(offset + 6, true), method: view.getUint16(offset + 8, true),
    crc32: view.getUint32(offset + 14, true), compressedSize: view.getUint32(offset + 18, true), size: view.getUint32(offset + 22, true)
  }
}

/** The problems a page's build finds, as `path: message`. */
async function problems(source: unknown, options: Parameters<typeof buildPackage>[1]) {
  const error = await buildPackage(source, options).then(() => null, (error: unknown) => error)
  expect(error).toBeInstanceOf(SourceError)
  return (error as SourceError).problems.map(({ path, message }) => `${path}: ${message}`)
}

/** The modules an entry loads, by following its relative imports. */
async function graph(entry: string, seen = new Map<string, string[]>()) {
  if (seen.has(entry)) return seen
  const text = await readFile(entry, 'utf8')
  const specifiers = [...text.matchAll(/^(?:import|export)\b[^'"]*?from\s+'([^']+)'/gm)].map(([, specifier]) => specifier)
  seen.set(entry, specifiers)
  for (const specifier of specifiers) if (specifier.startsWith('.')) await graph(resolve(entry, '..', specifier), seen)
  return seen
}

describe('the build in a page', () => {
  it('writes what the build in Node writes: the manifest, the content, the libraries and their files', async () => {
    const page = await buildPackage(BLANKS, { libraries: opened })
    const node = await buildInNode(BLANKS, join(dir, 'blanks.h5p'))
    expect(page.blob.type).toBe('application/zip')
    expect([page.manifest, page.content, page.libraries, page.install, page.notes, page.media]).toEqual([node.manifest, node.content, node.libraries, node.install, node.notes, node.media])
    // Each file by its name and hash, in order: comparing the bytes themselves with toEqual takes seconds.
    const hashes = ({ files }: { files: Map<string, Uint8Array> }) => [...files].map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')])
    const fromPage = await archive(new Uint8Array(await page.blob.arrayBuffer()))
    const fromNode = await archive(new Uint8Array(await readFile(node.output)))
    expect(hashes(fromPage)).toEqual(hashes(fromNode))
  })

  it('stores media after the content, with their size and CRC in their local headers, and describes them as H5P records them', async () => {
    const picture = png(480, 270)
    const result = await buildPackage(QUIZ, { libraries: opened, files: { 'volga.png': new File([new Uint8Array(picture)], 'IMG_0412.png') } })
    expect(result.media).toEqual(['images/volga.png'])
    expect(result.notes).toEqual([])
    const question = (result.content as any).questions[0]
    expect(question.subContentId).toMatch(/^[0-9a-f-]{36}$/)
    expect(question.params.media.type.params.file).toEqual({ path: 'images/volga.png', mime: 'image/png', width: 480, height: 270, copyright: { license: 'U' } })
    const bytes = new Uint8Array(await result.blob.arrayBuffer())
    const { files, entries } = await archive(bytes)
    // After the content, before the libraries carried for an H5P site's upload check, as Node's
    // build lays them out: on a host without Range the media arrive before them (#162).
    const names = entries.map(({ filename }) => filename)
    const at = names.indexOf('content/images/volga.png')
    expect(result.install.length).toBeGreaterThan(0)
    expect(names[at - 1]).toBe('content/content.json')
    expect(names.slice(at + 1).every((name) => result.install.some((folder) => name.startsWith(`${folder}/`)))).toBe(true)
    expect(names.slice(at + 1).length).toBeGreaterThan(0)
    expect(files.get('content/images/volga.png')).toEqual(new Uint8Array(picture))
    // No data descriptor: the header says where the data ends.
    expect(localHeader(bytes, entries[at].offset)).toEqual({ signature: 0x04034b50, flags: 0, method: 0, crc32: crc32(picture), compressedSize: picture.length, size: picture.length })
  })

  it('takes the files from a Map too, and names one the source names that the page did not give', async () => {
    const given = new Map([['volga.png', new Blob([new Uint8Array(png(8, 8))])]])
    expect((await buildPackage(QUIZ, { libraries: opened, files: given })).media).toEqual(['images/volga.png'])
    const elsewhere = { ...QUIZ, params: { questions: [{ ...QUIZ.params.questions[0], params: { ...QUIZ.params.questions[0].params, media: { type: image('rhine.png') } } }] } }
    expect(await problems(elsewhere, { libraries: opened, files: given })).toEqual([
      'params.questions[0].params.media.type.params.file.path: rhine.png: no such file among those given (volga.png)'
    ])
    expect(await problems(QUIZ, { libraries: opened, files: { 'volga.png': 'a picture' as unknown as Blob } })).toEqual([
      'params.questions[0].params.media.type.params.file.path: volga.png: is not a File or a Blob'
    ])
  })

  it('leaves a video at the address a page names for it, played from there with none of its bytes read: a preview (#263)', async () => {
    const address = 'https://files.example/a/clip.mp4?se=2026-11-23&sig=abc'
    const asked = vi.fn(async () => { throw new Error('asked for') })
    // An interaction far past any length builds: nothing of the file is read, so nothing is held to it.
    const built = await buildPackage(VIDEO('clip.mp4', 4000), { libraries: opened, linked: { 'clip.mp4': address }, fetch: asked })
    expect((built.content as any).interactiveVideo.video.files).toEqual([{ path: address, mime: 'video/mp4', copyright: { license: 'U' } }])
    expect(built.linked).toEqual(['clip.mp4'])
    expect(built.media).toEqual([])
    expect(built.notes).toEqual([])
    expect(asked).not.toHaveBeenCalled()
    const { entries } = await archive(new Uint8Array(await built.blob.arrayBuffer()))
    expect(entries.filter(({ filename }) => /^content\/(?:videos|audios|images|files)\//.test(filename))).toEqual([])
    // A file given under the name goes before the address: the package to keep is made of its bytes.
    const clip = new File([mp4(false, { seconds: 30, tracks: [['vide', 'avc1'], ['soun', 'mp4a']] })], 'clip.mp4')
    const kept = await buildPackage(VIDEO('clip.mp4'), { libraries: opened, files: { 'clip.mp4': clip }, linked: new Map([['clip.mp4', address]]) })
    expect(kept.linked).toEqual([])
    expect(kept.media).toEqual(['videos/clip.mp4'])
    expect((kept.content as any).interactiveVideo.video.files[0]).toMatchObject({ path: 'videos/clip.mp4', mime: 'video/mp4' })
  })

  it('refuses a picture left at an address, a name its field does not take and what is no web address, the address in no problem (#263)', async () => {
    const address = 'https://files.example/a/secret.png?sig=abc'
    expect(await problems(QUIZ, { libraries: opened, linked: { 'volga.png': address } })).toEqual([
      'params.questions[0].params.media.type.params.file.path: volga.png: only a video or a recording is played from an address; give the file itself'
    ])
    expect(await problems(VIDEO('clip.mov'), { libraries: opened, linked: { 'clip.mov': address } })).toEqual([
      'params.interactiveVideo.video.files[0].path: clip.mov: this field takes .mp4, .webm, .ogg'
    ])
    expect(await problems(VIDEO('clip.mp4'), { libraries: opened, linked: { 'clip.mp4': 'blob:https://files.example/1b2c' } })).toEqual([
      'params.interactiveVideo.video.files[0].path: clip.mp4: the address it is played from is not an http(s) address'
    ])
    // A video on a host with a player of its own is named in the source, where its form is checked.
    expect(await problems(VIDEO('clip.mp4'), { libraries: opened, linked: { 'clip.mp4': 'https://www.youtube.com/shorts/abcdefghijk?sig=abc' } })).toEqual([
      'params.interactiveVideo.video.files[0].path: clip.mp4: the address it is played from is on YouTube, whose player shows a video, not a file; give https://www.youtube.com/watch?v= and the video\'s id as the path instead'
    ])
    // A name with no address is a file the page did not give, as before.
    expect(await problems(VIDEO('clip.mp4'), { libraries: opened, linked: { 'other.mp4': address } })).toEqual([
      'params.interactiveVideo.video.files[0].path: clip.mp4: no such file among those given (none)'
    ])
  })

  it('fetches each part once for a pack it was given, which stays open; one it was named it opens and closes', async () => {
    const before = fetched.length
    await buildPackage(BLANKS, { libraries: opened })
    expect(fetched.length).toBe(before)
    const library = (await opened.open(opened.newest('H5P.Blanks')!)).library
    expect(library.machineName).toBe('H5P.Blanks')
    // Named by the pack export, the build fetches with the page's fetch, which in Node reads no file: URL.
    await expect(buildPackage(BLANKS, { libraries: pack })).rejects.toThrow(/^Cannot fetch the library part H5P\.Blanks-1\.\d+ from file:/)
  })

  it('refuses a part whose bytes are not the ones the index names', async () => {
    const damaged = await openPack(pack, {
      fetch: async (input) => {
        const response = await fromDisk(input)
        if (!String(input).includes('/H5P.Blanks-')) return response
        const bytes = new Uint8Array(await response.arrayBuffer())
        bytes[bytes.length >> 1] ^= 1
        return new Response(bytes)
      }
    })
    try {
      await expect(buildPackage(BLANKS, { libraries: damaged })).rejects.toThrow(/^The library part H5P\.Blanks-1\.\d+ does not match the pack's index \(SHA-256\): serve the parts of the pack this index belongs to\.$/)
    } finally {
      await damaged.close()
    }
  })

  it('reads a copy of the parts folder by its address, its index held to the player\'s shape', async () => {
    const index = JSON.parse(await readFile(join(parts, 'index.json'), 'utf8'))
    const site = 'https://pack.example/parts/'
    const serving = (body: unknown) => async (input: RequestInfo | URL) => String(input) === `${site}index.json`
      ? Response.json(body)
      : fromDisk(String(input).replace(site, pathToFileURL(`${parts}/`).href))
    const [first, second] = index.libraries
    // A folder that is not its library's own name, and a hash that is not hex, as the player drops them.
    const tampered = { libraries: [...index.libraries, { ...first, folder: '../escape' }, { ...second, sha256: 'not a hash' }] }
    const copy = await openPack('https://pack.example/parts', { fetch: serving(tampered) })
    try {
      expect(copy.libraries).toHaveLength(index.libraries.length)
      expect(copy.libraries[0]).toMatchObject({ folder: first.folder, url: `${site}${first.folder}.h5p` })
      const built = await buildPackage(BLANKS, { libraries: copy })
      expect(built.libraries).toEqual((await buildPackage(BLANKS, { libraries: opened })).libraries)
    } finally {
      await copy.close()
    }
    await expect(openPack(site, { fetch: serving({ libraries: [{ folder: '../escape' }] }) })).rejects.toThrow(`${site}index.json is not a library pack's index: it lists no library as the pack's index does`)
    await expect(openPack(site, { fetch: async () => new Response('Not Found', { status: 404 }) })).rejects.toThrow(`${site}index.json is not a library pack's index: it answered 404`)
    await expect(openPack(pathToFileURL(`${parts}/`))).rejects.toThrow('is not an http(s) address: a copy of the pack\'s parts/ folder is read over http(s)')
    // @ts-expect-error neither a pack nor its address
    await expect(openPack({ libraries: [{ folder: 'H5P.Blanks-1.14' }] })).rejects.toThrow('Name the library pack')
  })

  it('says what a failed download most likely is, in a page', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch') })
    try {
      const remote = { ...QUIZ, params: { questions: [{ ...QUIZ.params.questions[0], params: { ...QUIZ.params.questions[0].params, media: { type: image('https://images.example/volga.png') } } }] } }
      expect(await problems(remote, { libraries: opened })).toEqual([
        'params.questions[0].params.media.type.params.file.path: https://images.example/volga.png could not be downloaded: Failed to fetch; a page reads a file from another site only where that site allows it (CORS), so give the file itself instead'
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('needs a secure context, and says so', async () => {
    vi.stubGlobal('crypto', { getRandomValues: (array: Uint8Array) => array })
    try {
      const refused = 'A page builds packages in a secure context only, https, localhost or a Tauri window'
      await expect(openPack(pack)).rejects.toThrow(refused)
      await expect(buildPackage(BLANKS, { libraries: opened })).rejects.toThrow(refused)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('imports nothing of Node, nor the normalizer, which is Node\'s, through ./core or ./browser', async () => {
    const lib = resolve(import.meta.dirname, '../lib')
    for (const entry of ['core.mjs', 'browser.mjs']) {
      const modules = await graph(join(lib, entry))
      const outside = [...modules.values()].flat().filter((specifier) => !specifier.startsWith('.'))
      expect(outside.filter((specifier) => specifier.startsWith('node:') || specifier === '@missing-elements/h5p-normalize'), entry).toEqual([])
      expect([...modules.keys()].map((path) => path.slice(lib.length + 1))).not.toContain('node.mjs')
    }
    // node.mjs is the one module that does, and the Node entry is the only one that loads it.
    const imports = await Promise.all((await readdir(lib)).map(async (name) => [name, (await graph(join(lib, name), new Map())).get(join(lib, name))!] as const))
    expect(imports.filter(([, specifiers]) => specifiers.some((specifier) => specifier.startsWith('node:'))).map(([name]) => name)).toEqual(['node.mjs'])
    expect(imports.filter(([, specifiers]) => specifiers.includes('./node.mjs')).map(([name]) => name)).toEqual(['author.mjs'])
  })
})
