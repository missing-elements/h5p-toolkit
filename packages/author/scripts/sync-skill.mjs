// Writes the generated section of each skill type file (`references/types/`) from the pinned pack,
// as `h5p-author schema --markdown`; run `sync:skill` after the pack changes (apps/skills tests).
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { schemaOf } from '../lib/author.mjs'
import { withSection } from '../lib/schema.mjs'

const folder = resolve(import.meta.dirname, '../../../skills/h5p-author/references/types')
const check = process.argv.includes('--check')
let stale = 0
for (const name of (await readdir(folder)).filter((file) => file.endsWith('.md')).sort()) {
  const path = join(folder, name)
  const text = await readFile(path, 'utf8')
  const section = await schemaOf(name.slice(0, -'.md'.length), { markdown: true })
  const updated = withSection(text, section, name)
  if (updated === text) continue
  stale += 1
  if (check) console.error(`${name} is out of date with the pack`)
  else await writeFile(path, updated)
}
if (check && stale) process.exitCode = 1
console.log(check ? `${stale} type file${stale === 1 ? '' : 's'} out of date` : `${stale} type file${stale === 1 ? '' : 's'} written`)
