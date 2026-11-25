import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import * as verify from '@missing-elements/h5p-verify'
import type { Browser, Frame, Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The card in a browser, in three chats that stand in for the ones it was written against (#274):
 * one that sandboxes a card without an origin, as Open WebUI 0.13.4 does, with the policy it
 * writes from the card's own domains; one that refuses the frame, by Claude's policy for a card;
 * and one that lets the play page be framed, as ChatGPT does. Each speaks MCP Apps to the card:
 * the handshake, the tool's input, and an answer to `ui/open-link`. The play page is a stand-in
 * too, which says its height and nothing more: what the page does is the site's to test.
 *
 * And what comes before the activity, or in its place (#276): a source the chat streams as its
 * model writes it, a call the chat stops, a reply drawn from the tool's result alone, and a page
 * that never speaks from the frame.
 */

const SOURCE = { language: 'en', license: 'U', authors: [{ name: 'Unknown', role: 'Author' }], type: 'H5P.TrueFalse', title: 'Boiling point', params: { question: '<p>Water boils at 100 °C at sea level.</p>', correct: 'true' } }
/** The chat's file store, as the server names it in the card's policy: no address of this test's. */
const STORE = 'https://files.example.org'

let browser: Browser
let site: Server
let chat: Server
let SITE: string
let CHAT: string
/** The card as another site than the chat serves it, where it has an origin of its own. */
let CARD: string
/** How many times the play page was asked for, and how long it waits before it speaks: never, below 0. */
let played = 0
let lateBy = 0

/** What is asked inside a page is written as text: this package's types know no browser. */
const ORIGIN = 'self.origin'
const SCHEME = 'document.documentElement.style.colorScheme'
const FITS = 'document.documentElement.scrollHeight <= document.documentElement.clientHeight'
const ASKED = 'window.asked'
const HEIGHTS = 'window.heights'

const port = (server: Server) => (server.address() as AddressInfo).port
const listening = (server: Server, host: string) => new Promise<void>((done) => server.listen(0, host, done))
const inScript = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c')

/** Open WebUI's policy for a card, as `app_csp` writes it from the domains the card declares. */
const sandboxedPolicy = () => [
  "default-src 'none'", `script-src 'unsafe-inline' blob: ${STORE}`, `style-src 'unsafe-inline' ${STORE}`, `img-src data: blob: ${STORE}`,
  `media-src data: blob: ${STORE}`, `font-src ${STORE}`, `connect-src ${STORE}`, `frame-src ${SITE}`, "base-uri 'none'", "object-src 'none'", "form-action 'none'"
].join('; ')

beforeAll(async () => {
  const card = (await readFile(resolve(import.meta.dirname, '../lib/card.html'), 'utf8'))
  site = createServer((request, response) => {
    if (!request.url?.startsWith('/h5p/play/')) { response.statusCode = 404; return response.end() }
    played++
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(lateBy < 0 ? '<!doctype html><p>The play page, which says nothing</p>' : `<!doctype html><p>The play page</p><script>setTimeout(() => parent.postMessage({ source: 'h5p-play', type: 'height', height: 321 }, '*'), ${lateBy})</script>`)
  })
  await listening(site, '127.0.0.1')
  SITE = `http://127.0.0.1:${port(site)}`
  const served = card.replaceAll('__SITE__', SITE)
  chat = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://chat')
    const kind = url.searchParams.get('kind')
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    if (url.pathname === '/card') {
      if (kind === 'refused') response.setHeader('Content-Security-Policy', 'frame-src blob: data:')
      return response.end(served)
    }
    const sandboxed = kind === 'sandboxed'
    const srcdoc = `<meta http-equiv="Content-Security-Policy" content="${sandboxedPolicy().replace(/"/g, '&quot;')}"><style>*{scrollbar-width:none}::-webkit-scrollbar{display:none}</style>${served}`
    response.end(`<!doctype html><meta charset="utf-8"><body style="margin:0;background:${url.searchParams.get('theme') === 'dark' ? '#212121' : '#fff'}">
<iframe id="card" style="display:block;width:100%;height:300px;border:0"${sandboxed ? ' sandbox="allow-scripts allow-downloads allow-popups" referrerpolicy="no-referrer"' : ''}></iframe>
<script>
window.asked = []; window.heights = []
const card = document.getElementById('card')
addEventListener('message', (event) => {
  const message = event.data
  if (event.source !== card.contentWindow || !message || message.jsonrpc !== '2.0') return
  const answer = (body) => card.contentWindow.postMessage({ jsonrpc: '2.0', id: message.id, ...body }, '*')
  const say = (method, params) => card.contentWindow.postMessage({ jsonrpc: '2.0', method, params }, '*')
  if (message.method === 'ui/initialize') answer({ result: { protocolVersion: message.params.protocolVersion, hostInfo: { name: 'stand-in', version: '0' }, hostCapabilities: ${url.searchParams.get('opens') === 'no' ? '{}' : '{ openLinks: {} }'}, hostContext: { theme: ${inScript(url.searchParams.get('theme') ?? 'light')} } } })
  else if (message.method === 'ui/notifications/initialized') {
    const input = ${inScript(url.searchParams.get('input') ?? 'whole')}
    const whole = () => say('ui/notifications/tool-input', { arguments: { source: ${inScript(SOURCE)} } })
    // The source as the model writes it, closed where it breaks off, as MCP Apps sends it.
    const part = () => say('ui/notifications/tool-input-partial', { arguments: { source: { type: 'H5P.TrueFalse', title: 'Boil' } } })
    if (input === 'whole') whole()
    else if (input === 'streamed') { part(); setTimeout(part, 400); setTimeout(whole, 1500) }
    else if (input === 'stopped') { part(); setTimeout(() => say('ui/notifications/tool-cancelled', { reason: 'The person stopped it' }), 400) }
    else if (input === 'result') say('ui/notifications/tool-result', { content: [{ type: 'text', text: 'The activity is checked' }], _meta: { 'h5p/source': ${inScript(SOURCE)} } })
  }
  else if (message.method === 'ui/open-link') { window.asked.push(message.params.url); answer(${url.searchParams.get('answer') === 'no' ? "{ error: { code: -32000, message: 'no' } }" : '{ result: {} }'}) }
  else if (message.method === 'ui/notifications/size-changed') { window.heights.push(message.params.height); card.style.height = message.params.height + 'px' }
})
${sandboxed ? `card.srcdoc = ${inScript(srcdoc)}` : `card.src = ${inScript(`${CARD}/card?kind=${kind}`)}`}
</script>`)
  })
  await listening(chat, '127.0.0.1')
  CHAT = `http://localhost:${port(chat)}`
  CARD = `http://127.0.0.1:${port(chat)}`
  // The verifier's own choice of a browser: Chrome or Edge where one is installed, else Playwright's.
  browser = await (verify as unknown as { launch: () => Promise<Browser> }).launch()
})

afterAll(async () => {
  await browser?.close()
  site?.close()
  chat?.close()
})

/** A chat of one kind with the card in it, and the card's frame. */
async function open(query: string, late = 0): Promise<{ page: Page, card: Frame }> {
  played = 0
  lateBy = late
  const page = await browser.newPage({ viewport: { width: 760, height: 700 } })
  await page.goto(`${CHAT}/?${query}`)
  const card = page.frames().find((frame) => frame.parentFrame() === page.mainFrame())!
  return { page, card }
}
/** The source a play page's address carries, as the page reads it. */
function sourceIn(address: string) {
  const bytes = Buffer.from(new URL(address).hash.slice('#source='.length), 'base64url')
  try { return JSON.parse(inflateRawSync(bytes).toString()) } catch { return JSON.parse(bytes.toString()) }
}
const said = async (card: Frame) => ({ title: await card.locator('#wait-title').innerText(), note: await card.locator('#wait-note').innerText(), spinner: await card.locator('#spinner').isVisible() })
const offered = async (card: Frame) => ({
  title: await card.locator('#wait-title').innerText(),
  note: await card.locator('#wait-note').innerText(),
  spinner: await card.locator('#spinner').isVisible(),
  button: await card.locator('#open').isVisible(),
  link: await card.locator('#link').isVisible(),
  frame: await card.locator('#page').isVisible(),
  framed: await card.locator('#page').getAttribute('src')
})

describe('the card, where a chat cannot play the activity in its reply', () => {
  it('frames nothing in a card without an origin, and offers the activity in a tab the chat opens', async () => {
    const { page, card } = await open('kind=sandboxed&theme=dark')
    await card.waitForSelector('#wait.tab')
    expect(await card.evaluate<string>(ORIGIN)).toBe('null')
    expect(await offered(card)).toEqual({
      title: 'The activity opens in a new tab',
      note: 'This chat does not play an activity inside a reply. It is built and played in your browser, and nothing is sent to a server.',
      spinner: false, button: true, link: false, frame: false, framed: null
    })
    // No frame was tried: the page was never asked for.
    expect(played).toBe(0)
    // The chat's theme, the MCP Apps way.
    expect(await card.evaluate<string>(SCHEME)).toBe('dark')
    // The card is as tall as what it says, and the chat was told.
    expect(await card.evaluate<boolean>(FITS)).toBe(true)
    expect((await page.evaluate<number[]>(HEIGHTS)).at(-1)).toBeLessThan(300)

    await card.locator('#open').click()
    await card.waitForSelector('#link:not([hidden])')
    const asked = await page.evaluate<string[]>(ASKED)
    expect(asked).toHaveLength(1)
    // The play page's own address, with the source in it and nothing else: no theme of the chat's.
    expect(asked[0]).toMatch(new RegExp(`^${SITE}/h5p/play/#source=[\\w-]+$`))
    expect(sourceIn(asked[0]!)).toEqual(SOURCE)
    // Whether a tab opened is not the card's to see: the address is there to copy from then on.
    expect(await card.locator('#link-note').innerText()).toBe('A new tab should have opened. If none did, copy this link into your browser’s address bar.')
    expect(await card.locator('#link-address').inputValue()).toBe(asked[0])
    expect(await card.evaluate<boolean>(FITS)).toBe(true)
    await page.close()
  })

  it('offers the tab where the chat refuses the frame', async () => {
    const { page, card } = await open('kind=refused')
    await card.waitForSelector('#wait.tab')
    expect(await card.evaluate<string>(ORIGIN)).not.toBe('null')
    expect(await offered(card)).toMatchObject({ title: 'The activity opens in a new tab', spinner: false, button: true, frame: false })
    // The refused frame loads with nothing in it: its load does not take the card back.
    await page.waitForTimeout(700)
    expect(await offered(card)).toMatchObject({ title: 'The activity opens in a new tab', button: true, frame: false })
    expect(played).toBe(0)
    await card.locator('#open').click()
    expect(sourceIn((await page.evaluate<string[]>(ASKED))[0]!)).toEqual(SOURCE)
    await page.close()
  })

  it('says so where the chat answers no, and gives the address alone where the chat opens no link', async () => {
    const refusing = await open('kind=sandboxed&answer=no')
    await refusing.card.waitForSelector('#wait.tab')
    await refusing.card.locator('#open').click()
    await expect.poll(() => refusing.card.locator('#link-note').innerText()).toBe('The chat did not open it. Copy this link into your browser’s address bar.')
    await refusing.page.close()

    const { page, card } = await open('kind=sandboxed&opens=no')
    await card.waitForSelector('#wait.tab')
    expect(await offered(card)).toMatchObject({ title: 'Open the activity in your browser', button: false, link: true })
    expect(await card.locator('#link-note').innerText()).toBe('Copy this link into your browser’s address bar.')
    expect(sourceIn(await card.locator('#link-address').inputValue())).toEqual(SOURCE)
    await page.close()
  })
})

describe('the card, where a chat lets the play page be framed', () => {
  it('frames the page and offers no tab', async () => {
    const { page, card } = await open('kind=framed&theme=dark')
    await card.waitForSelector('#page.on')
    expect(await offered(card)).toMatchObject({ frame: true, button: false, link: false })
    expect(await card.locator('#wait').isVisible()).toBe(false)
    expect(await card.locator('#page').getAttribute('src')).toMatch(new RegExp(`^${SITE}/h5p/play/\\?theme=dark#source=`))
    expect(played).toBe(1)
    expect(await page.evaluate<string[]>(ASKED)).toEqual([])
    await page.close()
  })

  it('shows a page that speaks from the frame, whatever was concluded before', async () => {
    const { page, card } = await open('kind=framed', 1500)
    await card.waitForSelector('#page[src]', { state: 'attached' })
    // The browser's word that the frame was refused, where the page then plays all the same.
    await card.evaluate(`document.dispatchEvent(new SecurityPolicyViolationEvent('securitypolicyviolation', {
      blockedURI: ${JSON.stringify(`${SITE}/h5p/play/`)}, violatedDirective: 'frame-src', effectiveDirective: 'frame-src', originalPolicy: "frame-src 'none'", documentURI: location.href, disposition: 'enforce', statusCode: 200
    }))`)
    await card.waitForSelector('#wait.tab')
    expect(await offered(card)).toMatchObject({ title: 'The activity opens in a new tab', button: true, frame: false })
    await card.waitForSelector('#page.on')
    expect(await offered(card)).toMatchObject({ frame: true, button: false })
    expect(await card.locator('#wait').isVisible()).toBe(false)
    await page.close()
  })
})

describe('the card, before the activity comes or in its place', () => {
  it('says the chat is writing the source as it streams, and frames the page once it is whole', async () => {
    const { page, card } = await open('kind=framed&input=streamed')
    await expect.poll(() => said(card)).toEqual({ title: 'The chat is writing the activity…', note: 'It is built in your browser once it is written.', spinner: true })
    // A part of the source is never played from.
    expect(played).toBe(0)
    await card.waitForSelector('#page.on')
    expect(sourceIn((await card.locator('#page').getAttribute('src'))!)).toEqual(SOURCE)
    expect(played).toBe(1)
    await page.close()
  })

  it('says a call the chat stopped, and frames nothing', async () => {
    const { page, card } = await open('kind=framed&input=stopped')
    await expect.poll(() => said(card)).toEqual({ title: 'The activity was not made', note: 'The chat stopped before it was written. Ask it again.', spinner: false })
    // Not taken back by the word that the card still waits.
    await page.waitForTimeout(6500)
    expect((await said(card)).title).toBe('The activity was not made')
    expect(await card.locator('#page').getAttribute('src')).toBeNull()
    await page.close()
  })

  it('plays from the result where no input came', async () => {
    const { page, card } = await open('kind=framed&input=result')
    await card.waitForSelector('#page.on')
    expect(sourceIn((await card.locator('#page').getAttribute('src'))!)).toEqual(SOURCE)
    await page.close()
  })

  it('says it waits, where nothing comes for a while', async () => {
    const { page, card } = await open('kind=framed&input=none')
    expect((await said(card)).title).toBe('Opening the activity…')
    await expect.poll(() => said(card), { timeout: 8000 }).toEqual({ title: 'Waiting for the activity…', note: 'The chat is still sending it.', spinner: true })
    await page.close()
  })

  it('offers the tab where the page says nothing from the frame', async () => {
    const { page, card } = await open('kind=framed', -1)
    await card.waitForSelector('#page.on')
    await card.waitForSelector('#wait.tab', { timeout: 15_000 })
    expect(await offered(card)).toMatchObject({
      title: 'The activity opens in a new tab',
      note: 'The activity did not start inside this reply. In a tab of its own it is built and played in your browser, and nothing is sent to a server.',
      button: true, frame: false
    })
    await card.locator('#open').click()
    expect(sourceIn((await page.evaluate<string[]>(ASKED))[0]!)).toEqual(SOURCE)
    await page.close()
  })
})
