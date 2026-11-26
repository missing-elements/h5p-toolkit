/**
 * Refuses to publish until the player's `./plan` and the normalizer's `./crc32` are on npm: a pin to a version
 * without them fails (#108, #109). The player is pinned exactly: docs/compatibility.md does not cover `./plan`.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { served, stopUnlessAnswered, waitUntil } from '../../../scripts/published.mjs'

// One wait for both, in CI, where each was published moments before in the same run (#253).
const until = waitUntil()

/**
 * @param {string} folder the package's folder under packages/
 * @param {string} name
 * @param {string} subpath the export the embed package imports
 * @param {string} why what imports it
 */
async function published(folder, name, subpath, why) {
  const { version } = JSON.parse(await readFile(resolve(import.meta.dirname, '..', '..', folder, 'package.json'), 'utf8'))
  const response = await served(`https://registry.npmjs.org/${name.replaceAll('/', '%2f')}/${version}`, `${name}@${version}`, { until })
  stopUnlessAnswered(response, `${name}@${version} on npm`)
  if (!response.ok) {
    console.error(`[${folder}] ${name}@${version} is not on npm (${response.status}). Publish it from packages/${folder} first: the embed package depends on it, for its ${subpath}.`)
    process.exit(1)
  }
  if (!(await response.json()).exports?.[subpath]) {
    console.error(`[${folder}] ${name}@${version} on npm does not export ${subpath}, which ${why} imports: bump its version, publish it, and publish the embed package against that.`)
    process.exit(1)
  }
  console.log(`[${folder}] ${name}@${version} is published, and exports ${subpath}`)
}

await published('player', '@missing-elements/h5p-offline-player', './plan', 'the SCORM writer')
await published('normalize', '@missing-elements/h5p-normalize', './crc32', 'the SCORM writer')
