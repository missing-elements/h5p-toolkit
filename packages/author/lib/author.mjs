/**
 * @missing-elements/h5p-author: a playable .h5p of any content type in the library pack, from a
 * short JSON source. The Node entry: `./core` needs no Node, and `./browser` builds in a page.
 */

import { contentTypes } from './bundle.mjs'
import { openPack } from './node.mjs'
import { schemaLines, schemaMarkdown } from './schema.mjs'
import { LAYOUTS } from './types.mjs'

export * from './core.mjs'
export { buildPackage, describeMedia, inside, openPack, publicFetch, readPackage, writeBundle, writeBundles } from './node.mjs'

/**
 * @typedef {import('./node.mjs').BuildResult} BuildResult
 * @typedef {import('./node.mjs').BuildOptions} BuildOptions
 * @typedef {import('./node.mjs').BundleResult} BundleResult
 * @typedef {import('./node.mjs').DescribeOptions} DescribeOptions
 * @typedef {import('./node.mjs').MediaFacts} MediaFacts
 * @typedef {import('./node.mjs').ReadResult} ReadResult
 * @typedef {import('./node.mjs').ReadOptions} ReadOptions
 */

/**
 * A content type's fields as a source writes them, from the pack: one line each.
 * @param {string} machineName such as `H5P.Blanks`
 * @param {{ libraries?: string, markdown?: boolean, all?: boolean }} [options] `libraries`, a parts
 *   folder in place of the pinned pack; `markdown`, a type file's section; `all`, interface texts
 * @returns {Promise<string>}
 */
export async function schemaOf(machineName, options = {}) {
  const pack = await openPack(options.libraries)
  try {
    const entry = pack.newest(machineName)
    if (!entry) {
      const types = (await contentTypes(pack)).map((part) => `${part.library.machineName} (${part.library.title})`)
      throw new Error(`The library pack has no ${machineName}. Its content types: ${types.join(', ')}`)
    }
    const part = await pack.open(entry)
    if (!part.semantics) throw new Error(`${machineName} has no semantics: it is not a content type an author fills in`)
    /** @type {(name: string) => boolean} */
    const has = (name) => Boolean(pack.newest(name))
    const sets = LAYOUTS[machineName]?.sets ?? []
    if (options.markdown) return schemaMarkdown(part.library, part.semantics, { has, sets })
    const { lines, interfaceTexts } = schemaLines(part.semantics, { all: options.all, has, sets })
    const header = `${part.library.machineName} ${part.library.majorVersion}.${part.library.minorVersion}: ${part.library.title}`
    const footer = !options.all && interfaceTexts ? [`(${interfaceTexts} interface texts left out; --all lists them)`] : []
    return [header, ...lines, ...footer].join('\n')
  } finally {
    await pack.close()
  }
}
