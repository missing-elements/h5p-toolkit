import { lstat, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { SourceError, buildPackage, coreApiLine, inside, publicFetch, readPackage } from '@missing-elements/h5p-author'
import { VerifyError, openBrowser, previewPackage, summarize, verifyPackage } from '@missing-elements/h5p-verify'
import { SOURCE_PROPERTIES, TYPES, answer, heldLines, refusal, typeAnswers } from './answers.mjs'
import { defaultFolders, fileStem, rootFolders } from './folders.mjs'

/**
 * @typedef {object} ServerOptions
 * @property {string[]} [allow] the folders a build may read and write, given when the server starts;
 *   they take precedence over the app's roots, which take precedence over Desktop, Documents and
 *   Downloads
 * @property {boolean} [open] open a preview in the person's browser; default true
 * @property {string} [libraries] the pack's `parts/` folder to build from; the installed pack by default
 */

/** The skill's flow, which every app shows the model with the tools. */
const INSTRUCTIONS = `Builds H5P content as a .h5p file from a short JSON source, checks that it plays, and opens it in the person's browser.
1. The content type is chosen with the person: where their request names none, ask which, and ask nothing else. h5p_types with no type lists them.
2. Call h5p_types with the type and write the source from its notes, example and fields: only what differs from the defaults.
3. Call h5p_build. Where it lists problems, fix each at its path and build again.
4. Tell the person where the file is and what the check found, and offer h5p_preview.
The author and the licence are what the person gave; otherwise the name you know them by, or "Unknown", and the licence "U". Say which you used.
To change a .h5p the person has, h5p_read it, change its source as asked, and h5p_build that.`

const READ = `Reads a .h5p package back into its source, to change it and build it again with h5p_build: its type, title, language, licence, authors, and the params that differ from the defaults. Writes the source and the package's media into a new folder beside it, and answers with the source, each file named where it was written. Reads content made for the library pack's versions of its libraries.`

const BUILD = `Builds a .h5p package from a source, its params holding only what differs from the type's defaults. A file is { "path": ... }, in a folder this server may use or at a web address. Writes the package and its source (.source.json) to output, or under a new name in the first folder it may use. A source with problems is refused, each problem named by its path. With verify (the default), plays the package in a headless browser and reports whether it works.`

const PREVIEW = `Opens a .h5p package in the person's browser in the real player, served from this computer until its tab is closed. Answers with the address.`

/** @param {number} bytes */
const sized = (bytes) => (bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1e3))} kB` : `${(bytes / 1e6).toFixed(1)} MB`)

/**
 * Where the person's files are, for the model: it cannot know, and a path it guesses is refused.
 * @param {string[]} folders
 */
const whereFiles = (folders) => folders.length
  ? `This server reads files and writes packages only in ${folders.join(', ')}. A file's path written alone, as { "path": "picture.png" }, is read from ${folders[0]}.`
  : 'This server has no folder to read or write in: start it with --allow <folder>.'

/** @param {string} path a package's */
const sourceBeside = (path) => path.replace(/\.h5p$/i, '.source.json')

/**
 * A read source's files named in the folder it was read into, so that a build looks for each there
 * and nowhere else: one the read wrote, where it is, and one the package lacks, where the person can
 * put it. Every file a read source names, but by a web address, is under its folder by its path
 * (`readPackage`); a path is a field of a file alone in every content type.
 * @param {unknown} value
 * @param {string} folder
 * @returns {unknown}
 */
function located(value, folder) {
  if (Array.isArray(value)) return value.map((each) => located(each, folder))
  if (!value || typeof value !== 'object') return value
  const local = (/** @type {unknown} */ each) => typeof each === 'string' && !/^[a-z][a-z0-9+.-]*:/i.test(each)
  const entries = Object.entries(value).map(([key, each]) => [key, key === 'path' && local(each) ? join(folder, ...String(each).split('/')) : located(each, folder)])
  return Object.fromEntries(entries)
}

/**
 * The server and its four tools. It holds no rules of its own: the build, the read, their checks
 * and the confinement to folders are h5p-author's, the check and the preview h5p-verify's.
 * @param {ServerOptions} [options]
 */
export async function createServer(options = {}) {
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const server = new McpServer({ name: 'h5p-mcp', title: 'H5P Author MCP by Missing Elements', version }, { instructions: INSTRUCTIONS })
  const about = typeAnswers({ libraries: options.libraries })
  /** @type {Set<{ close: () => void }>} */
  const previews = new Set()

  /** The folders a build may read and write, asked of the app on each call, since its roots can change. */
  async function folders() {
    if (options.allow?.length) return options.allow.map((folder) => resolve(folder))
    if (server.server.getClientCapabilities()?.roots) {
      try {
        const found = rootFolders((await server.server.listRoots(undefined, { timeout: 5_000 })).roots)
        if (found.length) return found
      } catch {
        // An app that says it has roots and does not answer gets the default folders.
      }
    }
    return defaultFolders()
  }

  /** The packages being built, lower-cased, as macOS and Windows match a name in any case. */
  const building = new Set()

  /**
   * A package's path in the folder, with a number added to the name where it is taken, the
   * package's or its source's: a build never writes over a file, so a package built again takes
   * the next number. A link takes its name too, even one that leads nowhere. The path is held for
   * the build until it is let go of, so that builds at once take names of their own.
   * @param {string} folder
   * @param {string} stem the file name without `.h5p`
   */
  async function freeName(folder, stem) {
    for (let n = 1; ; n++) {
      const path = join(folder, `${stem}${n === 1 ? '' : `-${n}`}.h5p`)
      const taken = await Promise.all([path, sourceBeside(path)].map((each) => lstat(each).then(() => true, () => false)))
      // Asked after the wait and held at once, with no wait between, so no other build takes it.
      if (taken.includes(true) || building.has(path.toLowerCase())) continue
      building.add(path.toLowerCase())
      return path
    }
  }

  /**
   * A new folder beside a package for what a read writes, named after it, with a number added where
   * the name is taken, as a build's package takes one; held while the read runs.
   * @param {string} parent
   * @param {string} stem
   */
  async function freeFolder(parent, stem) {
    for (let n = 1; ; n++) {
      const path = join(parent, n === 1 ? stem : `${stem}-${n}`)
      const taken = await lstat(path).then(() => true, () => false)
      if (taken || building.has(path.toLowerCase())) continue
      building.add(path.toLowerCase())
      return path
    }
  }

  server.registerTool('h5p_types', {
    title: 'H5P content types',
    description: TYPES,
    inputSchema: z.object({ type: z.string().optional().describe('A content type, as H5P.MultiChoice or "multiple choice"') }),
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ type }) => {
    // Said with every answer, before a source is written: a model cannot know the folders, and a
    // path it guesses is refused.
    const where = whereFiles(await folders())
    if (!type) return answer(await about.list([where]))
    const text = await about.about(type)
    if (text === null) return refusal(`The library pack has no content type "${type}". h5p_types with no type lists them.`)
    return answer(`${text}\n\n${where}`)
  })

  server.registerTool('h5p_build', {
    title: 'Build an H5P package',
    description: BUILD,
    inputSchema: z.object({
      source: z.record(z.string(), z.unknown()).meta({ properties: SOURCE_PROPERTIES, description: 'The source, as h5p_types describes it for its type' }),
      output: z.string().optional().describe('Leave it out unless the person named a place: a file name, or a path in a folder this server may use'),
      verify: z.boolean().optional().describe('Play it and report whether it works; default true')
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  }, async ({ source, output, verify = true }) => {
    const allowed = await folders()
    if (!allowed.length) return refusal('This server has no folder to write in: start it with --allow <folder>, or give it a folder from the app.')
    let target = resolve(allowed[0], output || `${fileStem(source.title)}.h5p`)
    if (!/\.h5p$/i.test(target)) target += '.h5p'
    // Said here, with the folders, since a model cannot know them: the build's own refusal names none.
    if (!(await inside(target, allowed))) return refusal(`${target} is outside the folders this server may write in: ${allowed.join(', ')}. Give a file name alone, or leave output out.`)
    // A name that is taken gets a number, as a build never writes over a file.
    target = await freeName(dirname(target), basename(target).replace(/\.h5p$/i, ''))
    const sourceFile = sourceBeside(target)
    let result
    /** @type {Error | undefined} */
    let unwritten
    try {
      result = await buildPackage(source, target, { base: dirname(target), within: allowed, fetch: publicFetch, libraries: options.libraries })
      // Made new: a file or a link put at its name since the name was found free is not written through.
      // As the build took it, naming the content type's version it was built with (author's #219):
      // for a quiz in the quiz format, the source it was built as, which has the field for it.
      unwritten = await writeFile(sourceFile, `${JSON.stringify(result.source, null, 2)}\n`, { flag: 'wx' }).then(() => undefined, (error) => error)
    } catch (error) {
      if (error instanceof SourceError) return refusal(`${error.message}\nFix each at its path and build again.${/outside the folders/.test(error.message) ? ` ${whereFiles(allowed)}` : ''}`)
      return refusal(error instanceof Error ? error.message : String(error))
    } finally {
      building.delete(target.toLowerCase())
    }
    const install = result.install.length ? `, ${result.install.length} more for installing on an H5P site` : ''
    const media = result.media.length ? `, ${result.media.length} media file${result.media.length === 1 ? '' : 's'}` : ''
    const lines = [
      `Built ${target} (${sized((await stat(target)).size)}): ${result.manifest.mainLibrary}, ${result.libraries.length} libraries${install}${media}.`,
      coreApiLine(result.coreApi),
      unwritten
        ? `Its source was not written beside it: ${unwritten.message}`
        : `Its source is beside it, ${basename(sourceFile)}: https://missing-elements.github.io/h5p/build/ opens it under "Or open a file", to change and build again.`
    ]
    lines.push(...heldLines(result))
    /** @type {{ type: 'image', data: string, mimeType: string }[]} */
    const images = []
    if (verify) {
      const out = await mkdtemp(join(tmpdir(), 'h5p-mcp-'))
      try {
        const report = await verifyPackage({ file: target, out, libraries: options.libraries })
        // Its screenshot goes with the answer as an image; the path it was written to is gone.
        lines.push('', summarize(report).split('\n').filter((line) => !/^\s*screenshot:/.test(line)).join('\n'))
        const shot = await readFile(join(out, 'screenshot.png')).catch(() => null)
        if (shot) images.push({ type: 'image', data: shot.toString('base64'), mimeType: 'image/png' })
      } catch (error) {
        lines.push('', `Not verified: ${error instanceof VerifyError || error instanceof Error ? error.message : String(error)}`)
      } finally {
        await rm(out, { recursive: true, force: true })
      }
    }
    return { content: [{ type: /** @type {const} */ ('text'), text: lines.join('\n') }, ...images] }
  })

  server.registerTool('h5p_read', {
    title: 'Read an H5P package',
    description: READ,
    inputSchema: z.object({ package: z.string().describe('The .h5p by its file name alone, as the person names it, or its path in a folder this server may use') }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ package: file }) => {
    const allowed = await folders()
    // A name alone is the first folder's, as a source's file is.
    const path = resolve(allowed[0] ?? '.', file)
    if (!allowed.length || !(await inside(path, allowed))) return refusal(`${file} is not in a folder this server may use.${allowed.length ? ` ${whereFiles(allowed)}` : ''}`)
    const folder = await freeFolder(dirname(path), fileStem(basename(path).replace(/\.h5p$/i, '')))
    let result
    try {
      result = await readPackage(path, folder, { within: allowed, libraries: options.libraries })
    } catch (error) {
      return refusal(error instanceof Error ? error.message : String(error))
    } finally {
      building.delete(folder.toLowerCase())
    }
    const media = result.files.length ? `, with its ${result.files.length} media file${result.files.length === 1 ? '' : 's'} beside it` : ''
    const lines = [`Read ${path}: ${result.source.type}. Its source is in ${result.output}${media}.`]
    for (const { path: at, message } of result.notes) lines.push(`Note: ${at} ${message}`)
    const source = { ...result.source, params: located(result.source.params, folder) }
    lines.push('', 'The source, each file named where it was written: change it as the person asks and pass it to h5p_build.', JSON.stringify(source))
    return answer(lines.join('\n'))
  })

  server.registerTool('h5p_preview', {
    title: 'Preview an H5P package',
    description: PREVIEW,
    inputSchema: z.object({ package: z.string().describe('The .h5p to open, in a folder this server may use') }),
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ package: file }) => {
    const allowed = await folders()
    const path = resolve(allowed[0] ?? '.', file)
    if (!allowed.length || !(await inside(path, allowed))) return refusal(`${file} is not in a folder this server may use.`)
    let preview
    try {
      preview = await previewPackage({ file: path, libraries: options.libraries })
    } catch (error) {
      return refusal(error instanceof Error ? error.message : String(error))
    }
    previews.add(preview)
    preview.closed.then(() => previews.delete(preview))
    const address = `${preview.url}/`
    const opened = options.open !== false && (await openBrowser(address))
    return answer(`${opened ? `Opened ${basename(path)} in the browser at ${address}.` : `The preview of ${basename(path)} is at ${address}: open it in a browser.`} It is served from this computer until its tab is closed.`)
  })

  return {
    server,
    /** Ends every preview still open, as the server stops. */
    close() {
      for (const preview of previews) preview.close()
    }
  }
}
