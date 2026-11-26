#!/usr/bin/env node
// Lists every comment that runs past two lines, and exits with 1 if there is one: design/build.md.
// Usage: node scripts/comments.mjs [file or folder]...   (no argument: every tracked file)
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MOST = 2
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CODE = /\.(ts|mts|mjs|js|cjs|css|html|jsonc|ya?ml|sh)$/
// Others' code and what a build writes: not ours to shorten.
const SKIPPED = /(^|\/)(node_modules|dist|dist-demo|vendor|public|cmi5-catapult|parts|staged)\/|\.d\.m?ts$|(^|\/)pnpm-lock\.yaml$/
// A line a tool reads is not prose, and a licence notice is kept whole.
const DIRECTIVE = /^(@ts-|@vitest-|v8 ignore|c8 ignore|prettier-ignore|eslint-|#region|#endregion|<reference)/
const NOTICE = /copyright \(c\)|spdx-license-identifier|@license|@preserve|permission is hereby granted/i

/**
 * A file's comments: a run of line comments, or one block. `prose` counts a block's lines before
 * its first JSDoc tag, and `tags` the longest tag, in lines.
 * @param {string} text
 * @param {string} file
 * @returns {{ line: number, prose: number, tags: number }[]}
 */
export function comments(text, file) {
  const lines = text.split('\n')
  const hash = /\.(ya?ml|sh)$/.test(file)
  const starts = (/** @type {string} */ line) => (hash ? /^#(?!!)/.test(line) : line.startsWith('//'))
  const found = []
  for (let at = 0; at < lines.length; at++) {
    const first = lines[at].trim()
    // A block that opens after code and runs on past its line counts too.
    const trailing = !hash && !first.startsWith('/*') ? /\s\/\*(?!.*\*\/)/.exec(lines[at]) : null
    const close = !hash && (trailing || first.startsWith('/*')) ? '*/' : !hash && first.startsWith('<!--') ? '-->' : null
    if (close) {
      const line = at + 1
      const body = []
      while (at < lines.length) {
        body.push((body.length || !trailing ? lines[at] : lines[at].slice(trailing.index)).trim().replace(/^(\/\*+|<!--|\*(?!\/))\s?/, '').replace(/\s*(\*\/|--!?>).*$/, '').trim())
        if (lines[at].includes(close)) break
        at++
      }
      if (NOTICE.test(body.join(' '))) continue
      let prose = 0
      let tags = 0
      let tag = 0
      // How deep in a tag's `{type}` the line ends: a type that runs over lines is not prose.
      let open = 0
      const braces = (/** @type {string} */ text) => (text.match(/\{/g) ?? []).length - (text.match(/\}/g) ?? []).length
      for (const each of body) {
        const named = /^@[a-zA-Z]+\s*(\{.*)?$/.exec(each) ?? (/^@[a-zA-Z]+\s/.test(each) ? [] : null)
        if (named) {
          tag = 1
          open = Math.max(0, braces(named[1] ?? ''))
        } else if (!each) continue
        else if (open > 0) open = Math.max(0, open + braces(each))
        else if (tag) tag++
        else prose++
        tags = Math.max(tags, tag)
      }
      found.push({ line, prose, tags })
    } else if (starts(first)) {
      const line = at + 1
      const body = []
      while (at < lines.length && starts(lines[at].trim())) body.push(lines[at++].trim().replace(/^(\/\/+|#+)\s?/, ''))
      at--
      if (NOTICE.test(body.join(' '))) continue
      found.push({ line, prose: body.filter((each) => each && !DIRECTIVE.test(each)).length, tags: 0 })
    }
  }
  return found
}

/** @param {string[]} named */
function tracked(named) {
  const args = ['-C', root, 'ls-files', '--', ...named.map((each) => relative(root, resolve(each)) || '.')]
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n').filter((file) => CODE.test(file) && !SKIPPED.test(file))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let long = 0
  for (const file of tracked(process.argv.slice(2))) {
    for (const { line, prose, tags } of comments(readFileSync(join(root, file), 'utf8'), file)) {
      if (prose <= MOST && tags <= MOST) continue
      long++
      console.log(`${file}:${line}: ${prose > MOST ? `${prose} lines` : `a tag of ${tags} lines`}`)
    }
  }
  if (long) {
    console.error(`${long} ${long === 1 ? 'comment runs' : 'comments run'} past ${MOST} lines. Say why in ${MOST}, and keep the rest in design/.`)
    process.exit(1)
  }
}
