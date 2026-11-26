/**
 * The markup the pages share, in `partials/`. A page's line `<!-- partial: topbar -->` is replaced
 * by that file's contents, indented as it was; a missing or self-naming partial fails the build.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const PARTIAL = /^([ \t]*)<!--\s*partial:\s*([\w-]+)\s*-->[ \t]*$/gm

/**
 * @param {string} dir the partials' directory
 * @param {string} html
 * @param {string[]} [trail] the partials being expanded, outermost first
 * @returns {string}
 */
export function expandPartials(dir, html, trail = []) {
  return html.replace(PARTIAL, (_, indent, name) => {
    if (trail.includes(name)) throw new Error(`The partial ${name} names itself: ${[...trail, name].join(' > ')}`)
    let source
    try {
      source = readFileSync(resolve(dir, `${name}.html`), 'utf8')
    } catch {
      throw new Error(`No partial named ${name} in ${dir}`)
    }
    return expandPartials(dir, source.replace(/\n$/, ''), [...trail, name])
      .split('\n')
      .map((line) => (line ? indent + line : line))
      .join('\n')
  })
}

/**
 * @param {string} html
 * @param {string} path the page's own address, `/demo/setup.html` or `/demo/index.html`
 * @returns {string}
 */
export function markCurrentPage(html, path) {
  return html.replace(/<nav aria-label="Site">[\s\S]*?<\/nav>/, (nav) => {
    const [current] = [...nav.matchAll(/<a href="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((href) => path.startsWith(href))
      .sort((a, b) => b.length - a.length)
    return current ? nav.replace(`<a href="${current}"`, `<a href="${current}" aria-current="page"`) : nav
  })
}

/** @param {string} dir the partials' directory */
export function partialsPlugin(dir) {
  return {
    name: 'h5p-partials',
    transformIndexHtml: {
      order: /** @type {const} */ ('pre'),
      /** @param {string} html @param {{ path: string }} context */
      handler: (html, context) => markCurrentPage(expandPartials(dir, html), context.path.split('?')[0])
    },
    /** @param {{ file: string, server: import('vite').ViteDevServer }} update */
    handleHotUpdate({ file, server }) {
      if (!file.startsWith(dir)) return
      // Vite's own reload for an HTML file reaches only that page, and a partial is on many.
      server.ws.send({ type: 'full-reload' })
      return []
    }
  }
}
