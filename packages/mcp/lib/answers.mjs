import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { contentTypes, openPack, schemaOf, sourceSchema, sourceType } from '@missing-elements/h5p-author'

/**
 * What both servers of this package say alike: the local one over standard input and output
 * (`server.mjs`) and the app server over HTTP (`app.mjs`). The content types and a type's file,
 * a source's own fields, and a build's notes and outline. None of it is a rule of this package's:
 * each is the author package's, put into an answer.
 */

export const TYPES = `The H5P content types and how to write a source for one. With no type: the list, and how to write good content. With a type: its notes, a tested example and its fields. Read the type's answer before writing its source.`

const LIST_HEAD = `The content types the library pack has, by the name a source's "type" takes. Those marked * have notes and a tested example; for the rest h5p_types gives their fields.`

/**
 * A source's own fields as the author package declares them (#230), shown to the app as the
 * properties of `source`, and nothing more: no field is said to be required and none forbidden.
 * The build is the check, which reads a source written another way as it is meant (#174) and says
 * every problem at once, where the SDK, or an app holding a call to the schema, would refuse it
 * before the build looked.
 */
export const SOURCE_PROPERTIES = z.toJSONSchema(sourceSchema, { io: 'input' }).properties

/** Lines of an outline past which an answer says how many more there are. */
const OUTLINE_LINES = 80

/** @param {string} text */
export const answer = (text) => ({ content: [{ type: /** @type {const} */ ('text'), text }] })
/** @param {string} text */
export const refusal = (text) => ({ content: [{ type: /** @type {const} */ ('text'), text }], isError: true })

/**
 * A build's notes, and what its content holds, as lines of an answer: the outline, 80 lines of it
 * at most.
 * @param {{ notes: { path: string, message: string }[], outline: string }} result
 */
export function heldLines(result) {
  const lines = result.notes.map(({ path, message }) => `Note: ${path} ${message}`)
  const outline = result.outline.split('\n')
  lines.push('', 'What it holds:', ...outline.slice(0, OUTLINE_LINES))
  if (outline.length > OUTLINE_LINES) lines.push(`… and ${outline.length - OUTLINE_LINES} more lines.`)
  return lines
}

/**
 * What `h5p_types` answers, for a server: the list with the skill's brief, and a type's file, or
 * its fields where it has none.
 * @param {{ libraries?: string, references?: string }} [options] `libraries`, the pack's `parts/`
 *   folder, the installed pack by default; `references`, the author package's `references/` folder,
 *   the installed package's by default: a bundle has no package to find, and names its copy
 */
export function typeAnswers(options = {}) {
  const references = options.references ?? join(dirname(fileURLToPath(import.meta.resolve('@missing-elements/h5p-author/package.json'))), 'references')
  const typeFiles = join(references, 'types')
  /** @type {Promise<{ name: string, title: string }[]> | undefined} */
  let typeList
  /** The pack's content types, read once: each needs its part opened. */
  function types() {
    typeList ??= (async () => {
      const pack = await openPack(options.libraries)
      try {
        return (await contentTypes(pack)).map((part) => ({ name: part.library.machineName, title: part.library.title }))
      } finally {
        await pack.close()
      }
    })()
    // A pack that could not be opened is opened again at the next question.
    typeList.catch(() => { typeList = undefined })
    return typeList
  }
  /** The content types the skill has a file for, as the author package carries them. */
  async function filed() {
    const names = await readdir(typeFiles).catch(() => [])
    return new Set(names.filter((name) => name.endsWith('.md')).map((name) => name.slice(0, -3)))
  }
  return {
    /**
     * Holds a folder a host named to being the author package's `references/`. A wrong path
     * would answer every type with its fields and leave the brief out, and say nothing of it.
     * The installed package's own is taken as it is found: in this repository its type files
     * are copied in by a build step, and the fields stand in until then.
     */
    async held() {
      if (options.references === undefined) return
      const names = await readdir(typeFiles).catch(() => [])
      const brief = await readFile(join(references, 'authoring.md'), 'utf8').catch(() => '')
      if (!brief || !names.some((name) => name.endsWith('.md'))) {
        throw new Error(`${references} is not the author package's references/ folder: it has no authoring.md, or no type file in types/`)
      }
    },
    /**
     * The list, and how to write good content, with a server's own lines between them.
     * @param {string[]} [between]
     */
    async list(between = []) {
      const [list, files] = await Promise.all([types(), filed()])
      const lines = list.map(({ name, title }) => `${files.has(name) ? '*' : '-'} ${name}: ${title}`)
      const brief = await readFile(join(references, 'authoring.md'), 'utf8').catch(() => '')
      return [LIST_HEAD, ...lines, ...(between.length ? ['', ...between] : []), ...(brief ? ['', brief] : [])].join('\n')
    },
    /**
     * A type's file, or its fields; `null` for a type the pack has not. Read as a build reads one,
     * so "true false" works.
     * @param {string} type
     */
    async about(type) {
      const [list, files] = await Promise.all([types(), filed()])
      const name = sourceType({ type }, list.map((each) => each.name))
      if (!name) return null
      const text = files.has(name) ? await readFile(join(typeFiles, `${name}.md`), 'utf8') : await schemaOf(name, { markdown: true, libraries: options.libraries })
      return text.trimEnd()
    }
  }
}
