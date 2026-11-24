import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../lib/app.mjs'

/**
 * The app server as a host runs it: the command the package ships, listening on a port, asked
 * over HTTP through the SDK's own client, as a chat app asks it. The check's rules are the author
 * package's and tested there; these hold the server to its two tools, its card, and to what it
 * may hold of a request: nothing.
 */

const COMMAND = resolve(import.meta.dirname, '../bin/h5p-mcp-app.mjs')
const META = { language: 'en', license: 'U', authors: [{ name: 'Unknown', role: 'Author' }] }
const QUIZ = { ...META, type: 'H5P.TrueFalse', title: 'Boiling point', params: { question: '<p>Water boils at 100 °C at sea level.</p>', correct: 'true' } }
const VIDEO = {
  ...META,
  type: 'H5P.InteractiveVideo',
  title: 'Site walkthrough',
  params: { interactiveVideo: {
    video: { files: [{ path: 'IMG_0042.mp4' }] },
    assets: { interactions: [{ duration: { from: 1, to: 3 }, pause: true, label: 'Check', action: { library: 'H5P.TrueFalse', params: { question: 'It is a river.', correct: 'true' } } }] }
  } }
}

type Content = { type: string, text?: string }
type Answer = { content: Content[], isError?: boolean, structuredContent?: Record<string, unknown>, _meta?: Record<string, unknown> }

let command: ChildProcess
/** All the command wrote, to either stream. */
let written = ''
let address: string
let client: Client
/** A store of a chat's files, which the server must never ask: it counts what it is asked. */
let store: Server
let asked = 0
let fileAddress: string

const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as Answer
const textOf = (answer: Answer) => answer.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')

beforeAll(async () => {
  store = createServer((_request, response) => { asked++; response.end('never') }).listen(0, '127.0.0.1')
  await new Promise((done) => store.once('listening', done))
  // An address as a chat gives one: https, with a key in it. Nothing listens there for https, and nothing should ask.
  fileAddress = `https://127.0.0.1:${(store.address() as AddressInfo).port}/files/abc?sig=KEY-TO-THE-FILE`
  command = spawn(process.execPath, [COMMAND, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] })
  address = await new Promise<string>((found, failed) => {
    const read = (chunk: Buffer) => {
      written += chunk.toString()
      const at = /on (http:\/\/\S+\/mcp)/.exec(written)
      if (at) found(at[1]!)
    }
    command.stdout!.on('data', read)
    command.stderr!.on('data', read)
    command.once('exit', (code) => failed(new Error(`the command ended with ${code}: ${written}`)))
  })
  client = new Client({ name: 'h5p-mcp-app-test', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(address)))
})

afterAll(async () => {
  await client?.close()
  command?.kill()
  await new Promise((done) => store.close(done))
})

describe('the app server', () => {
  it('offers two tools and the flow, in few words', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual(['h5p_play', 'h5p_types'])
    expect(client.getInstructions()).toMatch(/h5p_types[\s\S]*h5p_play/)
    // A chat sends these with every message.
    const words = (client.getInstructions() ?? '') + tools.map((tool) => `${tool.description}${JSON.stringify(tool.inputSchema)}`).join('')
    expect(words.length).toBeLessThan(6000)
    // Nothing of the local server's, which reads and writes a person's folders.
    expect(words).not.toMatch(/folder|h5p_build|h5p_read|h5p_preview/)
    const play = tools.find((tool) => tool.name === 'h5p_play')!
    // A source's own fields as the author package declares them, with nothing required of it (#230, #174).
    const source = play.inputSchema.properties?.source as Record<string, any>
    expect(source.properties).toMatchObject({ license: { enum: expect.arrayContaining(['U', 'CC BY']) }, authors: { items: { required: ['name', 'role'] } } })
    expect(source.required).toBeUndefined()
    // The file input as ChatGPT's reference writes one, to the letter, and named as one.
    expect(play.inputSchema.properties?.file).toEqual({
      type: 'object',
      description: expect.stringContaining('attached in the chat'),
      properties: { download_url: { type: 'string' }, file_id: { type: 'string' }, mime_type: { type: 'string' }, file_name: { type: 'string' } },
      required: ['download_url', 'file_id'],
      additionalProperties: false
    })
    expect(play.inputSchema.required).toEqual(['source'])
    expect(play._meta).toMatchObject({ 'openai/fileParams': ['file'], 'openai/outputTemplate': expect.stringMatching(/^ui:\/\/h5p-play\/card-[0-9a-f]{12}\.html$/) })
    expect((play._meta as any).ui.resourceUri).toBe(play._meta!['openai/outputTemplate'])
    // Neither tool keeps or changes anything.
    for (const tool of tools) expect(tool.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false })
  })

  it('serves one card, which frames the site and nothing else, and calls no tool', async () => {
    const { tools } = await client.listTools()
    const uri = tools.find((tool) => tool.name === 'h5p_play')!._meta!['openai/outputTemplate'] as string
    const { contents } = await client.readResource({ uri })
    const card = contents[0] as { mimeType: string, text: string, _meta: Record<string, any> }
    expect(card.mimeType).toBe('text/html;profile=mcp-app')
    expect(card.text).toContain("const SITE = 'https://missing-elements.github.io'")
    expect(card.text).not.toContain('__SITE__')
    expect(card._meta.ui.csp.frameDomains).toEqual(['https://missing-elements.github.io'])
    expect(card._meta['openai/widgetCSP']).toMatchObject({ frame_domains: ['https://missing-elements.github.io'], redirect_domains: ['https://missing-elements.github.io'] })
    // It asks the chat's file store, and no address of ours.
    expect(card._meta.ui.csp.connectDomains).toEqual(card._meta['openai/widgetCSP'].connect_domains)
    expect(card._meta.ui.csp.connectDomains.join(' ')).not.toMatch(/missing-elements|localhost|127\.0\.0\.1/)
    // It sends nothing back to this server: no tool is called from it, and nothing is reported.
    expect(card.text).not.toMatch(/callTool|h5p_card_log|Test report|console\./)
    // A card that changed has another address, which a chat keeps it by; the same card, the same.
    const other = await createApp({ site: 'https://example.org' })
    const same = await createApp()
    expect(other.cardUri).not.toBe(uri)
    expect(same.cardUri).toBe(uri)
  })

  it('lists the content types and answers for one, with no word of folders', async () => {
    const list = textOf(await call('h5p_types'))
    expect(list).toMatch(/^\* H5P\.MultiChoice: /m)
    expect(list).not.toMatch(/This server reads files|--allow/)
    const one = await call('h5p_types', { type: 'true false' })
    expect(textOf(one)).toMatch(/^# .*\(H5P\.TrueFalse\)/)
    expect(textOf(one)).not.toMatch(/This server reads files/)
    const none = await call('h5p_types', { type: 'no such type' })
    expect(none.isError).toBe(true)
  })

  it('checks a source and says what it holds, as a build does', async () => {
    const played = await call('h5p_play', { source: QUIZ })
    expect(played.isError).toBeFalsy()
    expect(textOf(played)).toMatch(/^The activity is checked and plays in the card: H5P\.TrueFalse, \d+ libraries\./)
    expect(textOf(played)).toContain('What it holds:\nWater boils at 100 °C at sea level.\nCorrect answer: True')
    expect(played.structuredContent).toEqual({ files: 0 })
    expect(played._meta?.['h5p/file']).toBeUndefined()
  })

  it('refuses a source with problems, each by its path', async () => {
    const refused = await call('h5p_play', { source: { ...QUIZ, params: { question: 'Q?', correct: 'maybe' } } })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toMatch(/params\.correct: "maybe" is not an option/)
    expect(textOf(refused)).toMatch(/call h5p_play again/)
    const draw = await call('h5p_play', { source: { ...META, type: 'H5P.QuestionSet', title: 'Rivers', params: { poolSize: 1, questions: [
      { library: 'H5P.TrueFalse', params: { question: 'The Volga is in Europe.', correct: 'true' } },
      { library: 'H5P.TrueFalse', params: { question: 'The Nile is in Asia.', correct: 'false' } }
    ] } } })
    // What a learner gets, said first: a chat that changed the content reads it back (#268).
    expect(textOf(draw)).toMatch(/What it holds:\nShows 1 of the 2 questions each time/)
  })

  it('hands an attached file\'s reference to the card alone, and never asks for the file', async () => {
    const before = asked
    const played = await call('h5p_play', { source: VIDEO, file: { download_url: fileAddress, file_id: 'file_abc', mime_type: 'video/mp4', file_name: 'IMG_0042.mp4' } })
    expect(played.isError).toBeFalsy()
    // The source is checked without its file, which is named.
    expect(textOf(played)).toContain('Its file, IMG_0042.mp4, is not checked here: the card gets the attachment in the person\'s browser.')
    expect(textOf(played)).toContain('What it holds:\nVideo: IMG_0042.mp4')
    // The reference goes back as it came, in the part of the answer the model does not see.
    expect(played._meta?.['h5p/file']).toEqual({ download_url: fileAddress, file_id: 'file_abc', mime_type: 'video/mp4', file_name: 'IMG_0042.mp4' })
    expect(textOf(played) + JSON.stringify(played.structuredContent)).not.toContain('KEY-TO-THE-FILE')
    expect(played.structuredContent).toEqual({ files: 1, fileId: 'file_abc', fileName: 'IMG_0042.mp4' })
    expect(asked).toBe(before)
  })

  it('answers a call whose file is not a reference, and passes none on', async () => {
    // A model that wrote the file's name where the attachment goes: said, not refused unread.
    const named = await call('h5p_play', { source: VIDEO, file: 'IMG_0042.mp4' })
    expect(named.isError).toBeFalsy()
    expect(textOf(named)).toContain('no attachment came with the call')
    expect(named._meta?.['h5p/file']).toBeUndefined()
    // An address that is not https, or not an address, is no reference.
    for (const address of ['http://files.example/abc', 'file:///etc/passwd', 'not an address']) {
      const other = await call('h5p_play', { source: VIDEO, file: { download_url: address, file_id: 'file_abc' } })
      expect(other._meta?.['h5p/file']).toBeUndefined()
      expect(textOf(other)).toContain('no attachment came with the call')
    }
    // An attachment the source does not name is said, so the model names it.
    const unused = await call('h5p_play', { source: QUIZ, file: { download_url: fileAddress, file_id: 'file_abc' } })
    expect(textOf(unused)).toContain('the source names no file, so it is not used')
    // A file of a type the field does not take is a problem of the source's, by its name alone.
    const wrong = await call('h5p_play', { source: { ...VIDEO, params: { interactiveVideo: { video: { files: [{ path: 'notes.txt' }] } } } } })
    expect(wrong.isError).toBe(true)
    expect(textOf(wrong)).toMatch(/notes\.txt: this field takes \.mp4/)
  })

  it('answers the endpoint and nothing else, and no body over 1 MB', async () => {
    const origin = new URL(address).origin
    expect((await fetch(`${origin}/`)).status).toBe(200)
    expect((await fetch(`${origin}/h5p/play/`)).status).toBe(404)
    expect((await fetch(`${origin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'h5p_play', arguments: { source: { ...QUIZ, title: 'x'.repeat(1024 * 1024) } } } }) })).status).toBe(413)
  })

  it('writes down nothing of what it was asked', () => {
    // Every call above was made: all the command ever wrote is where it listens.
    expect(written.trim().split('\n')).toHaveLength(1)
    expect(written).toMatch(/^h5p-mcp-app \S+ on http:\/\/127\.0\.0\.1:\d+\/mcp, framing https:\/\/missing-elements\.github\.io\n$/)
  })
})
