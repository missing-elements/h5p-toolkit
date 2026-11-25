import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type AddressInfo, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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
/**
 * A store of a chat's files, which the server must never ask. It counts every connection made to
 * it, whatever is said on one: an address of https is asked by a connection first.
 */
let store: Server
let asked = 0
let fileAddress: string

const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as Answer
const textOf = (answer: Answer) => answer.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')

beforeAll(async () => {
  store = createServer((socket) => { asked++; socket.destroy() }).listen(0, '127.0.0.1')
  await new Promise((done) => store.once('listening', done))
  // An address as a chat gives one: https, with a key in it.
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
    // An earlier card's address gets this card: a chat may ask one it kept from before a change (#278).
    const earlier = await client.readResource({ uri: 'ui://h5p-play/card-df8ccbdd2aa8.html' })
    expect(earlier.contents[0]).toMatchObject({ uri: 'ui://h5p-play/card-df8ccbdd2aa8.html', mimeType: 'text/html;profile=mcp-app', text: card.text })
    expect((earlier.contents[0] as { _meta: unknown })._meta).toEqual(card._meta)
    await expect(client.readResource({ uri: 'ui://h5p-play/card-latest.html' })).rejects.toThrow(/not found/i)
    // One card is listed.
    expect((await client.listResources()).resources.map((resource) => resource.uri)).toEqual([uri])
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
    // This client said nothing of cards, as a chat on the 2025 protocols says nothing to a server
    // with no session: the way where no card comes is said too, h5p-author's route 4 (#276).
    expect(textOf(played)).toContain('Where this chat draws no card, as a terminal or an editor\'s chat draws none, hand the activity over to be built in the person\'s browser: the whole source, once, in one json code block, and one line telling them to copy it, open https://missing-elements.github.io/h5p/build/, choose "Paste your chat\'s JSON"')
    expect(textOf(played)).not.toMatch(/#source=/)
    // No structured part, which a chat may show the model in place of the text (#276).
    expect(played.structuredContent).toBeUndefined()
    expect(played._meta?.['h5p/file']).toBeUndefined()
    // The source, for a card drawn from the result alone; the model is shown neither part.
    expect(played._meta?.['h5p/source']).toEqual(QUIZ)
  })

  it('answers by what the chat says it draws, where it says so', async () => {
    // Protocol 2026-07-28 carries the client's capabilities in each request, and MCP Apps names its own.
    const asked = async (capabilities: Record<string, unknown>, source: unknown) => {
      const response = await fetch(address, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'h5p_play' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'h5p_play', arguments: { source }, _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'a chat', version: '0' },
          'io.modelcontextprotocol/clientCapabilities': capabilities
        } } })
      })
      const text = await response.text()
      return JSON.parse(text.split('\n').find((line) => line.startsWith('data: '))?.slice(6) ?? text).result as Answer
    }
    const drawn = await asked({ extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } }, QUIZ)
    expect(textOf(drawn)).toMatch(/^The activity is checked and plays in the card: H5P\.TrueFalse/)
    expect(textOf(drawn)).not.toContain('draws no card')
    expect(drawn._meta?.['h5p/source']).toEqual(QUIZ)
    // A chat that draws no card, or cards of another kind: the source, to the build page.
    for (const capabilities of [{}, { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/uri-list'] } } }]) {
      const none = await asked(capabilities, QUIZ)
      expect(textOf(none)).toMatch(/^The activity is checked: H5P\.TrueFalse, \d+ libraries\. Nothing was stored\. This chat draws no card, so hand the activity over to be built in the person's browser: the whole source, once, in one json code block/)
      expect(textOf(none)).toContain('open https://missing-elements.github.io/h5p/build/, choose "Paste your chat\'s JSON", paste it into the box in place of the sample\'s, and press Build. Give the page\'s address as it is, with nothing after it.')
      expect(textOf(none)).toContain('What it holds:\nWater boils at 100 °C at sea level.')
      expect(textOf(none)).not.toMatch(/the card|#source=/)
      expect(none.structuredContent).toBeUndefined()
      // No card to hand the source to. (The SDK names the server in every result's _meta on this protocol.)
      expect(none._meta?.['h5p/source']).toBeUndefined()
    }
    const video = await asked({}, VIDEO)
    expect(textOf(video)).toContain('Add that the page asks for the files the source names before it builds.')
    expect(textOf(video)).toContain('Its file, IMG_0042.mp4, is not checked here.\n')
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

  it('hands an attached file\'s id to the card, and neither asks its address nor passes it on', async () => {
    // The store does count whoever asks that address: this test's own asking, here.
    await fetch(fileAddress).catch(() => {})
    expect(asked).toBe(1)
    const before = asked
    const played = await call('h5p_play', { source: VIDEO, file: { download_url: fileAddress, file_id: 'file_abc', mime_type: 'video/mp4', file_name: 'IMG_0042.mp4' } })
    expect(played.isError).toBeFalsy()
    // The source is checked without its file, which is named.
    expect(textOf(played)).toContain('Its file, IMG_0042.mp4, is not checked here: the card gets the attachment in the person\'s browser.')
    expect(textOf(played)).toContain('What it holds:\nVideo: IMG_0042.mp4')
    // The id goes to the card, with the name and the type; the address goes nowhere.
    expect(played._meta?.['h5p/file']).toEqual({ file_id: 'file_abc', mime_type: 'video/mp4', file_name: 'IMG_0042.mp4' })
    // Where there is one, it carries the text too, for a chat that shows the model that part alone.
    expect(played.structuredContent).toEqual({ answer: textOf(played), files: 1, fileId: 'file_abc', fileName: 'IMG_0042.mp4' })
    expect(JSON.stringify(played)).not.toMatch(/KEY-TO-THE-FILE|127\.0\.0\.1/)
    expect(asked).toBe(before)
  })

  it('answers a call whose file is not a reference, and passes none on', async () => {
    // A model that wrote the file's name where the attachment goes: said, not refused unread.
    const named = await call('h5p_play', { source: VIDEO, file: 'IMG_0042.mp4' })
    expect(named.isError).toBeFalsy()
    expect(textOf(named)).toContain('no attachment came with the call')
    expect(named._meta?.['h5p/file']).toBeUndefined()
    // A reference with no id is none: an address alone is passed to nobody.
    for (const file of [{ download_url: fileAddress }, { download_url: fileAddress, file_id: '' }, { download_url: fileAddress, file_id: 7 }]) {
      const other = await call('h5p_play', { source: VIDEO, file })
      expect(other._meta?.['h5p/file']).toBeUndefined()
      expect(textOf(other)).toContain('no attachment came with the call')
      expect(JSON.stringify(other)).not.toContain('KEY-TO-THE-FILE')
    }
    // Whatever address comes with an id, it is the id that is handed on.
    const made = await call('h5p_play', { source: VIDEO, file: { download_url: 'https://attacker.example/any.mp4', file_id: 'file_abc' } })
    expect(made._meta?.['h5p/file']).toEqual({ file_id: 'file_abc' })
    expect(JSON.stringify(made)).not.toContain('attacker.example')
    // An attachment the source does not name is said, so the model names it.
    const unused = await call('h5p_play', { source: QUIZ, file: { download_url: fileAddress, file_id: 'file_abc' } })
    expect(textOf(unused)).toContain('the source names no file, so it is not used')
    expect(unused.structuredContent).toBeUndefined()
    expect(unused._meta?.['h5p/file']).toBeUndefined()
    expect(asked).toBe(1)
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

  it('takes its card, its version and its type files from a host that carries them', async () => {
    // A bundle has no package folder beside the code, so its host names what it carries (#272).
    const references = await mkdtemp(join(tmpdir(), 'h5p-mcp-references-'))
    try {
      await mkdir(join(references, 'types'))
      await writeFile(join(references, 'types', 'H5P.TrueFalse.md'), "# The host's own notes on a statement\n")
      await writeFile(join(references, 'authoring.md'), "The host's own brief.\n")
      const app = await createApp({ version: '9.9.9', card: "<p>A host's card for __SITE__</p>", references })
      const ask = async (method: string, params: unknown) => {
        const response = await app.fetch(new Request('https://host.example/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
        }))
        const text = await response.text()
        return JSON.parse(text.split('\n').find((line) => line.startsWith('data: '))?.slice(6) ?? text).result
      }
      expect((await ask('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })).serverInfo.version).toBe('9.9.9')
      expect((await ask('resources/read', { uri: app.cardUri })).contents[0].text).toBe("<p>A host's card for https://missing-elements.github.io</p>")
      expect((await ask('tools/call', { name: 'h5p_types', arguments: { type: 'H5P.TrueFalse' } })).content[0].text).toContain("The host's own notes on a statement")
      // The list marks the types that have a file, and the host's folder has the one.
      const list: string = (await ask('tools/call', { name: 'h5p_types', arguments: {} })).content[0].text
      expect(list).toContain("The host's own brief.")
      expect(list).toMatch(/^\* H5P\.TrueFalse\b/m)
      expect(list).not.toMatch(/^\* H5P\.MultiChoice\b/m)
      await app.close()
      // A folder that is not the author package's is said at the start, not by thinner answers.
      await expect(createApp({ references: join(references, 'types') })).rejects.toThrow(/is not the author package's references\/ folder/)
    } finally {
      await rm(references, { recursive: true, force: true })
    }
  })

  it('writes down nothing of what it was asked', () => {
    // Every call above was made: all the command ever wrote is where it listens.
    expect(written.trim().split('\n')).toHaveLength(1)
    expect(written).toMatch(/^h5p-mcp-app \S+ on http:\/\/127\.0\.0\.1:\d+\/mcp, framing https:\/\/missing-elements\.github\.io\n$/)
  })
})
