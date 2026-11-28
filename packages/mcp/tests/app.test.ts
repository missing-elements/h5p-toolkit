import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type AddressInfo, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../lib/app.mjs'

/**
 * The app server as a host runs it: the package's command on a port, asked through the SDK's HTTP
 * client. The check's rules are the author package's; these hold it to its tools, card, no state.
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
/** A page of three pictures, each a file of the person's (#301). */
const PICTURES = { ...META, type: 'H5P.Column', title: 'Three pictures', params: { content: ['a.png', 'b.png', 'c.png'].map((path) => ({ content: { library: 'H5P.Image', params: { file: { path }, alt: path } } })) } }

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
    // The files input: a list of files as ChatGPT's reference writes one, to the letter (#301).
    expect(play.inputSchema.properties?.files).toEqual({
      type: 'array',
      description: expect.stringContaining('attached in the chat'),
      items: {
        type: 'object',
        properties: { download_url: { type: 'string' }, file_id: { type: 'string' }, mime_type: { type: 'string' }, file_name: { type: 'string' } },
        required: ['download_url', 'file_id'],
        additionalProperties: false
      }
    })
    expect(play.inputSchema.properties?.file).toBeUndefined()
    expect(play.inputSchema.required).toEqual(['source'])
    expect(play._meta).toMatchObject({ 'openai/fileParams': ['files'], 'openai/outputTemplate': expect.stringMatching(/^ui:\/\/h5p-play\/card-[0-9a-f]{12}\.html$/) })
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
    // One card is listed, beside the skill's SKILL.md (#280).
    expect((await client.listResources()).resources.map((resource) => resource.uri).sort()).toEqual(['skill://h5p-author/SKILL.md', uri])
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

  it('serves the h5p-author skill as the author package ships it, and no other file of the package', async () => {
    // MCP's Skills extension, SEP-2640 (#280).
    expect(client.getServerCapabilities()?.extensions).toHaveProperty(['io.modelcontextprotocol/skills'])
    const listed = await fetch(address, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'skills/list', params: {} }) })
    const text = await listed.text()
    const { skills } = JSON.parse(text.split('\n').find((line) => line.startsWith('data: '))?.slice(6) ?? text).result as { skills: { uri: string, frontmatter: Record<string, unknown>, resources: { uri: string }[] }[] }
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({ uri: 'skill://h5p-author/SKILL.md', frontmatter: { name: 'h5p-author', description: expect.stringMatching(/^Create H5P content/) } })
    // SKILL.md, LICENSE and every .md under references/: nothing else of the package.
    const author = dirname(fileURLToPath(import.meta.resolve('@missing-elements/h5p-author/package.json')))
    const own = (await readdir(join(author, 'references'), { recursive: true })).filter((name) => name.endsWith('.md')).map((name) => `references/${name.split(sep).join('/')}`)
    expect(skills[0]!.resources.map((resource) => resource.uri.replace('skill://h5p-author/', '')).sort()).toEqual(['LICENSE', 'SKILL.md', ...own].sort())
    expect(own).toContain('references/build/tools.md')
    // Read as the package has it.
    const read = await client.readResource({ uri: 'skill://h5p-author/SKILL.md' })
    expect((read.contents[0] as { text: string }).text).toBe(await readFile(join(author, 'SKILL.md'), 'utf8'))
    await expect(client.readResource({ uri: 'skill://h5p-author/package.json' })).rejects.toThrow()
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
    expect(played._meta?.['h5p/files']).toBeUndefined()
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

  it('hands the attached files\' ids to the card, and neither asks their addresses nor passes them on', async () => {
    // The store does count whoever asks that address: this test's own asking, here.
    await fetch(fileAddress).catch(() => {})
    expect(asked).toBe(1)
    const before = asked
    const played = await call('h5p_play', { source: VIDEO, files: [{ download_url: fileAddress, file_id: 'file_abc', mime_type: 'video/mp4', file_name: 'IMG_0042.mp4' }] })
    expect(played.isError).toBeFalsy()
    // The source is checked without its file, which is named.
    expect(textOf(played)).toContain('Its file, IMG_0042.mp4, is not checked here: the card gets the attachment in the person\'s browser.')
    expect(textOf(played)).toContain('What it holds:\nVideo: IMG_0042.mp4')
    // The id goes to the card, with the name and the type; the address goes nowhere.
    expect(played._meta?.['h5p/files']).toEqual([{ file_id: 'file_abc', mime_type: 'video/mp4', file_name: 'IMG_0042.mp4' }])
    // Where there is one, it carries the text too, for a chat that shows the model that part alone.
    expect(played.structuredContent).toEqual({ answer: textOf(played), files: 1, attachments: [{ fileId: 'file_abc', fileName: 'IMG_0042.mp4' }] })
    expect(JSON.stringify(played)).not.toMatch(/KEY-TO-THE-FILE|127\.0\.0\.1/)
    // Several attachments, as one call carries them (#301): each once, by its id, and the rest asked for.
    const picture = (name: string, id: string) => ({ download_url: fileAddress, file_id: id, mime_type: 'image/png', file_name: name })
    const all = await call('h5p_play', { source: PICTURES, files: [picture('a.png', 'file_a'), picture('b.png', 'file_b'), picture('c.png', 'file_c'), picture('a.png', 'file_a')] })
    expect(textOf(all)).toContain('Its files, a.png, b.png, c.png, are not checked here: the card gets the 3 attachments in the person\'s browser.')
    expect(all._meta?.['h5p/files']).toEqual([picture('a.png', 'file_a'), picture('b.png', 'file_b'), picture('c.png', 'file_c')].map(({ download_url: _, ...ref }) => ref))
    expect((all.structuredContent as { attachments: unknown[] }).attachments).toHaveLength(3)
    const some = await call('h5p_play', { source: PICTURES, files: [picture('a.png', 'file_a'), picture('b.png', 'file_b')] })
    expect(textOf(some)).toContain('the card gets the 2 attachments in the person\'s browser, and asks the person for any other.')
    // One given alone, not in a list, is taken too.
    const alone = await call('h5p_play', { source: VIDEO, files: { download_url: fileAddress, file_id: 'file_abc', file_name: 'IMG_0042.mp4' } })
    expect(alone._meta?.['h5p/files']).toEqual([{ file_id: 'file_abc', file_name: 'IMG_0042.mp4' }])
    expect(JSON.stringify([all, some, alone])).not.toMatch(/KEY-TO-THE-FILE|127\.0\.0\.1/)
    expect(asked).toBe(before)
  })

  it('answers a call whose files are not references, and passes none on', async () => {
    // A model that wrote the file's name where the attachment goes: said, not refused unread.
    const named = await call('h5p_play', { source: VIDEO, files: ['IMG_0042.mp4'] })
    expect(named.isError).toBeFalsy()
    expect(textOf(named)).toContain('no attachment came with the call')
    expect(named._meta?.['h5p/files']).toBeUndefined()
    // A reference with no id is none: an address alone is passed to nobody.
    for (const file of [{ download_url: fileAddress }, { download_url: fileAddress, file_id: '' }, { download_url: fileAddress, file_id: 7 }]) {
      const other = await call('h5p_play', { source: VIDEO, files: [file] })
      expect(other._meta?.['h5p/files']).toBeUndefined()
      expect(textOf(other)).toContain('no attachment came with the call')
      expect(JSON.stringify(other)).not.toContain('KEY-TO-THE-FILE')
    }
    // Whatever address comes with an id, it is the id that is handed on.
    const made = await call('h5p_play', { source: VIDEO, files: [{ download_url: 'https://attacker.example/any.mp4', file_id: 'file_abc' }] })
    expect(made._meta?.['h5p/files']).toEqual([{ file_id: 'file_abc' }])
    expect(JSON.stringify(made)).not.toContain('attacker.example')
    // An attachment the source does not name is said, so the model names it.
    const unused = await call('h5p_play', { source: QUIZ, files: [{ download_url: fileAddress, file_id: 'file_abc' }] })
    expect(textOf(unused)).toContain('the source names no file, so it is not used')
    expect(unused.structuredContent).toBeUndefined()
    expect(unused._meta?.['h5p/files']).toBeUndefined()
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

  it('takes a host\'s site, build page and title: the card frames the one and may open the other', async () => {
    const app = await createApp({ site: 'https://lesson.example', build: 'https://tools.example/h5p/build/', title: 'A Lesson' })
    const ask = async (method: string, params: unknown) => {
      const response = await app.fetch(new Request('https://lesson.example/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
      }))
      const text = await response.text()
      return JSON.parse(text.split('\n').find((line) => line.startsWith('data: '))?.slice(6) ?? text).result
    }
    expect((await ask('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })).serverInfo).toMatchObject({ name: 'h5p-mcp-app', title: 'A Lesson' })
    expect(await (await app.fetch(new Request('https://lesson.example/'))).text()).toBe('A Lesson: the MCP endpoint is /mcp\n')
    const card = (await ask('resources/read', { uri: app.cardUri })).contents[0]
    expect(card.text).toContain("const SITE = 'https://lesson.example'")
    expect(card.text).toContain("const BUILD = 'https://tools.example'")
    expect(card._meta.ui.csp.frameDomains).toEqual(['https://lesson.example'])
    expect(card._meta['openai/widgetCSP']).toMatchObject({ frame_domains: ['https://lesson.example'], redirect_domains: ['https://lesson.example', 'https://tools.example'] })
    // A chat that did not say whether it draws cards is told the build page too.
    expect((await ask('tools/call', { name: 'h5p_play', arguments: { source: QUIZ } })).content[0].text).toContain('open https://tools.example/h5p/build/, choose "Paste your chat\'s JSON"')
    await app.close()
    // An address of another scheme has the origin "null", which would let the card open any such link.
    await expect(createApp({ build: 'javascript:alert(1)' })).rejects.toThrow(/build is not a web address/)
    await expect(createApp({ site: 'data:text/html,<p>x</p>' })).rejects.toThrow(/site is not a web address/)
  })

  it('takes the build page and the title as the command\'s options, and refuses an address that is not the web\'s', async () => {
    const other = spawn(process.execPath, [COMMAND, '--port', '0', '--build', 'https://tools.example/h5p/build/', '--title', 'A Lesson'], { stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      let said = ''
      const at = await new Promise<string>((found) => other.stdout!.on('data', (chunk: Buffer) => {
        said += chunk.toString()
        const match = /on (http:\/\/\S+)\/mcp/.exec(said)
        if (match) found(match[1]!)
      }))
      expect(await (await fetch(`${at}/`)).text()).toBe('A Lesson: the MCP endpoint is /mcp\n')
    } finally {
      other.kill()
    }
    const refused = spawnSync(process.execPath, [COMMAND, '--build', 'javascript:alert(1)'], { encoding: 'utf8' })
    expect(refused.status).toBe(2)
    expect(refused.stderr).toContain('javascript:alert(1) is not an address')
  })

  it('takes its card, its version and its type files from a host that carries them', async () => {
    // A bundle has no package folder beside the code, so its host names what it carries (#272).
    const carried = await mkdtemp(join(tmpdir(), 'h5p-mcp-carried-'))
    const references = join(carried, 'references')
    try {
      await mkdir(join(references, 'types'), { recursive: true })
      await writeFile(join(references, 'types', 'H5P.TrueFalse.md'), "# The host's own notes on a statement\n")
      await writeFile(join(references, 'authoring.md'), "The host's own brief.\n")
      // The skill beside it, as in the author package (#280).
      await writeFile(join(carried, 'SKILL.md'), "---\nname: h5p-author\ndescription: The host's own copy of the skill.\n---\n\nBuild with the tools.\n")
      await writeFile(join(carried, 'LICENSE'), 'MIT\n')
      // A link in the folder, to a file outside it, is not followed.
      await writeFile(join(carried, 'outside.md'), 'Not the skill.\n')
      await symlink(join(carried, 'outside.md'), join(references, 'linked.md'))
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
      // The skill it serves is the host's copy.
      const [skill] = (await ask('skills/list', {})).skills as { frontmatter: { description: string }, resources: { uri: string }[] }[]
      expect(skill!.frontmatter.description).toBe("The host's own copy of the skill.")
      expect(skill!.resources.map((resource) => resource.uri.replace('skill://h5p-author/', '')).sort()).toEqual(['LICENSE', 'SKILL.md', 'references/authoring.md', 'references/types/H5P.TrueFalse.md'])
      await app.close()
      // A folder that is not the author package's is said at the start, not by thinner answers.
      await expect(createApp({ references: join(references, 'types') })).rejects.toThrow(/is not the author package's references\/ folder/)
      // And so is one with no skill beside it.
      await rm(join(carried, 'SKILL.md'))
      await expect(createApp({ references })).rejects.toThrow(/does not hold the h5p-author skill/)
    } finally {
      await rm(carried, { recursive: true, force: true })
    }
  })

  it('writes down nothing of what it was asked', () => {
    // Every call above was made: all the command ever wrote is where it listens.
    expect(written.trim().split('\n')).toHaveLength(1)
    expect(written).toMatch(/^h5p-mcp-app \S+ on http:\/\/127\.0\.0\.1:\d+\/mcp, framing https:\/\/missing-elements\.github\.io\n$/)
  })
})
