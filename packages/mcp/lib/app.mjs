import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { SourceError, buildPackage } from '@missing-elements/h5p-author'
import { SOURCE_PROPERTIES, TYPES, answer, heldLines, refusal, typeAnswers } from './answers.mjs'

/**
 * The app server (#210, #270): an MCP server over HTTP for a chat app that shows a card in its
 * reply, ChatGPT first. Two tools and one card. `h5p_play` checks a source and answers as a build
 * does; the card frames the play page of the site, which builds the activity in the person's
 * browser and plays it there.
 *
 * It keeps nothing. Each request gets a fresh server, answers, and is gone; nothing of a request
 * is stored and nothing of it is logged. A file the person attached in the chat never comes here:
 * the chat sends its reference, an address and an id. The address is never asked and never
 * passed on. The id is handed to the card, which asks the chat itself for the file's address,
 * from the person's browser: an address the chat did not give is one nobody fetches.
 *
 * @typedef {object} AppOptions
 * @property {string} [site] the origin of the site whose play page the card frames; `https://missing-elements.github.io` by default
 * @property {string} [libraries] the pack's `parts/` folder to check with; the installed pack by default
 * @property {string} [references] the folder of the author package's type files and brief, its `references/`; the installed package's by default
 * @property {string} [card] the card's text, `lib/card.html`; read from beside this file by default
 * @property {string} [version] the version the server names itself with; this package's by default
 *
 * A host with no package folder beside the code, as a bundle is, names all it carries, the pack
 * and the last three: there `import.meta` finds nothing (a Cloudflare Worker, #272). A
 * `references` folder that is not the author package's is refused as the server starts.
 */

const SITE = 'https://missing-elements.github.io'

/** A source is text: a body past this is refused before it is read whole. */
const MOST = 1024 * 1024

const INSTRUCTIONS = `Makes an H5P activity and plays it in the chat, built in the person's browser. Nothing is stored.
1. The content type is chosen with the person: where their request names none, ask which, and ask nothing else. h5p_types with no type lists them.
2. Call h5p_types with the type and write the source from its notes, example and fields: only what differs from the defaults.
3. Call h5p_play with the source. Where it lists problems, fix each at its path and call it again.
A file the person attached (a video, a recording, a picture): name it in the source by its file name, and pass the attachment in file. Do not open, read or analyse it yourself, with code or otherwise: pass it as it is, since nothing here needs what is in it.
The author and the licence are what the person gave; otherwise the name you know them by, or "Unknown", and the licence "U".
The card has the download of the .h5p file: do not offer a link of your own.`

const PLAY = `Checks an H5P activity's source and plays the activity in the chat, built in the person's browser, with a download of the .h5p file. The source is as h5p_types describes it for its type, its params holding only what differs from the type's defaults. A source with problems is refused, each problem named by its path. Nothing is stored.`

/**
 * A file attached in the chat, as ChatGPT's reference writes a file input, to the letter: it puts
 * the attachment's address and id here for an input named in `openai/fileParams`. Shown to the
 * app as the field's schema and not held to: what comes in its place, a name where a model wrote
 * one, is answered, where a schema would refuse the call unread.
 */
const FILE = {
  type: 'object',
  description: 'The file attached in the chat that the source names (a video, a recording or a picture): give the attachment itself, by its file id. Leave it out where there is none.',
  properties: { download_url: { type: 'string' }, file_id: { type: 'string' }, mime_type: { type: 'string' }, file_name: { type: 'string' } },
  required: ['download_url', 'file_id'],
  additionalProperties: false
}

/** Where a chat keeps attached files, which the card asks from the person's browser: ChatGPT's, as seen in November 2026. */
const FILE_HOSTS = ['https://*.blob.core.windows.net', 'https://files.oaiusercontent.com', 'https://*.oaiusercontent.com']

/**
 * What of the chat's reference to an attached file goes to the card: its id, and its name and
 * type where they came. Not its address, which lets whoever has it read the file, and which a
 * call could carry a made-up one of: the card asks the chat for the address by the id. Text in
 * the reference's place, or one with no id, is none.
 * @param {unknown} file
 */
function attached(file) {
  if (!file || typeof file !== 'object') return null
  const { file_id: id, mime_type: type, file_name: name } = /** @type {Record<string, unknown>} */ (file)
  const text = (/** @type {unknown} */ value) => (typeof value === 'string' && value.trim() && value.length <= 512 ? value : undefined)
  const fileId = text(id)
  return fileId ? { file_id: fileId, mime_type: text(type), file_name: text(name) } : null
}

/**
 * The app server, as a web-standard handler: `fetch(request)` answers one HTTP request. The MCP
 * endpoint is `/mcp`; every other path is a 404.
 * @param {AppOptions} [options]
 */
export async function createApp(options = {}) {
  const site = new URL(options.site ?? SITE).origin
  const version = options.version ?? JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version
  const card = (options.card ?? await readFile(new URL('./card.html', import.meta.url), 'utf8')).replaceAll('__SITE__', site)
  // A chat keeps a card by its address, so a card that changed has another.
  const cardUri = `ui://h5p-play/card-${createHash('sha256').update(card).digest('hex').slice(0, 12)}.html`
  const about = typeAnswers({ libraries: options.libraries, references: options.references })
  // Said as the server starts, not found out by whoever reads its answers.
  await about.held()
  // The card's policy: the one site it frames, and the chat's file store, which it asks for the
  // attached file. Written twice, as the MCP Apps specification places it and as ChatGPT reads it.
  const cardMeta = {
    ui: { csp: { frameDomains: [site], connectDomains: FILE_HOSTS, resourceDomains: FILE_HOSTS }, prefersBorder: true },
    'openai/widgetCSP': { frame_domains: [site], connect_domains: FILE_HOSTS, resource_domains: FILE_HOSTS, redirect_domains: [site] },
    'openai/widgetDescription': 'Plays the H5P activity, built in the person\'s browser, with its download.'
  }

  function server() {
    const mcp = new McpServer({ name: 'h5p-mcp-app', title: 'H5P Author MCP by Missing Elements', version }, { instructions: INSTRUCTIONS })

    mcp.registerTool('h5p_types', {
      title: 'H5P content types',
      description: TYPES,
      inputSchema: z.object({ type: z.string().optional().describe('A content type, as H5P.MultiChoice or "multiple choice"') }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    }, async ({ type }) => {
      if (!type) return answer(await about.list())
      const text = await about.about(type)
      return text === null ? refusal(`The library pack has no content type "${type}". h5p_types with no type lists them.`) : answer(text)
    })

    mcp.registerTool('h5p_play', {
      title: 'Play an H5P activity',
      description: PLAY,
      inputSchema: z.object({
        source: z.record(z.string(), z.unknown()).meta({ properties: SOURCE_PROPERTIES, description: 'The source, as h5p_types describes it for its type' }),
        file: z.unknown().optional().meta(FILE)
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: {
        ui: { resourceUri: cardUri },
        'openai/outputTemplate': cardUri,
        'openai/fileParams': ['file'],
        'openai/toolInvocation/invoking': 'Preparing the activity…',
        'openai/toolInvocation/invoked': 'Ready to play'
      }
    }, async ({ source, file }) => {
      let result
      try {
        // The author package's check of the source alone: no file is looked for and none
        // downloaded, here or anywhere, so a problem names nothing of this computer.
        result = await buildPackage(source, undefined, { check: true, unread: true, libraries: options.libraries })
      } catch (error) {
        if (error instanceof SourceError) return refusal(`${error.message}\nFix each at its path and call h5p_play again.`)
        // Not a problem of the source's, and its words may be of this computer: none are passed on.
        return refusal('The check could not be run, through no fault of the source. Call h5p_play again in a moment.')
      }
      const files = result.unread
      const came = attached(file)
      // An attachment goes to the card only for a source that names a file: one it does not name is not used.
      const given = files.length ? came : null
      const lines = [`The activity is checked and plays in the card: ${result.manifest.mainLibrary}, ${result.libraries.length} libraries. It is built in the person's browser; nothing was stored.`]
      if (files.length) {
        lines.push(given
          ? `Its file${files.length === 1 ? '' : 's'}, ${files.join(', ')}, ${files.length === 1 ? 'is' : 'are'} not checked here: the card gets the attachment in the person's browser${files.length === 1 ? '' : ', and asks the person for any other'}.`
          : `Its file${files.length === 1 ? '' : 's'}, ${files.join(', ')}, ${files.length === 1 ? 'is' : 'are'} not checked here, and no attachment came with the call: the card asks the person to choose ${files.length === 1 ? 'it' : 'them'}. Where the person attached ${files.length === 1 ? 'it' : 'one'} in the chat, call h5p_play again with the attachment in file.`)
      } else if (came) {
        lines.push('An attachment came with the call, and the source names no file, so it is not used: name it in the source, as the type\'s notes say, to use it.')
      }
      lines.push(...heldLines(result))
      return {
        ...answer(lines.join('\n')),
        structuredContent: { files: files.length, ...(given ? { fileId: given.file_id } : {}), ...(given?.file_name ? { fileName: given.file_name } : {}) },
        // For the card, as a chat hands a card either part of an answer.
        ...(given ? { _meta: { 'h5p/file': given } } : {})
      }
    })

    mcp.registerResource('h5p-play-card', cardUri, { title: 'H5P activity', mimeType: 'text/html;profile=mcp-app', _meta: cardMeta },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/html;profile=mcp-app', text: card, _meta: cardMeta }] }))
    return mcp
  }

  // Nothing is said of an error either: a message of the protocol's may quote what was sent.
  const handler = createMcpHandler(() => server(), { maxRequestBodySize: MOST })
  return {
    version,
    cardUri,
    /**
     * @param {Request} request
     * @returns {Promise<Response>}
     */
    async fetch(request) {
      const { pathname } = new URL(request.url)
      // For whoever opens the address, and for a host that asks whether the server is up.
      if (pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')) return new Response('H5P Author MCP by Missing Elements: the MCP endpoint is /mcp\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } })
      if (pathname !== '/mcp') return new Response('Not found\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
      // Said before a body is read, where its length is given; the handler holds one that gives none to the same bound.
      if (Number(request.headers.get('content-length')) > MOST) return new Response('A request takes 1 MB at most\n', { status: 413, headers: { 'content-type': 'text/plain; charset=utf-8' } })
      return handler.fetch(request)
    },
    close: () => handler.close()
  }
}
