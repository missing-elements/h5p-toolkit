import { cp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DIST_DIR as RUNTIME_DIST, buildRuntime } from '../../runtime/scripts/build.mjs'

/**
 * Builds the runtime (GPL-3.0, so a package of its own) into `public/frame-assets/`, where dev and
 * the tests serve it from; a published player carries none by design. It stamps `src/` too.
 */

const rootDir = resolve(import.meta.dirname, '..')

const exists = async (path) => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

const packageJson = JSON.parse(await readFile(resolve(rootDir, 'package.json'), 'utf8'))

const manifest = await buildRuntime({ quiet: true })

const targetDir = resolve(rootDir, 'public', 'frame-assets')
await rm(targetDir, { recursive: true, force: true })
await cp(RUNTIME_DIST, targetDir, { recursive: true })

// Written only when it changes, like the version stamp below, so a sync leaves git clean.
const fontsModulePath = resolve(rootDir, 'src', 'frame-fonts.ts')
const fontsModule = `// Written by scripts/sync-h5p-assets.mjs from @missing-elements/h5p-runtime ${manifest.runtime}'s
// MANIFEST.json (the H5P core at ${manifest.core.commit.slice(0, 10)}). Do not edit; run \`pnpm sync:assets\` in packages/player.

/**
 * The text faces the runtime's stylesheet declares, by file name under its \`fonts/\`, from its
 * manifest so the two cannot drift. A host that imports it passes URLs in \`runtime\` instead.
 */
export const FRAME_FONTS = [
${manifest.fonts
  .map((font) => `  { family: '${font.family}', style: '${font.style}', weight: '${font.weight}', file: '${font.file}' }`)
  .join(',\n')}
] as const
`
const currentFontsModule = (await exists(fontsModulePath)) ? await readFile(fontsModulePath, 'utf8') : ''
if (currentFontsModule !== fontsModule) await writeFile(fontsModulePath, fontsModule, 'utf8')

// The version travels in three places — the element, the worker and the `_ping` route — and a
// mismatch between a CDN element and a hand-copied worker is the failure this makes visible.
const constantsPath = resolve(rootDir, 'src', 'shared', 'constants.ts')
const constants = await readFile(constantsPath, 'utf8')
const major = Number(packageJson.version.split('.')[0])
// The pack `libraries="pack"` names, pinned to this checkout's version so a release always plays
// against the same libraries; `prepublishOnly` refuses a version that is not on npm.
const librariesJson = JSON.parse(await readFile(resolve(rootDir, '..', 'libraries', 'package.json'), 'utf8'))
const stamped = constants
  .replace(/export const VERSION = '[^']*'/, `export const VERSION = '${packageJson.version}'`)
  .replace(/export const MAJOR_VERSION = \d+/, `export const MAJOR_VERSION = ${major}`)
  .replace(/export const LIBRARY_PACK_VERSION = '[^']*'/, `export const LIBRARY_PACK_VERSION = '${librariesJson.version}'`)

if (stamped !== constants) {
  await writeFile(constantsPath, stamped, 'utf8')
}

// The pinned pack's index, compiled into the Service Worker: parts are planned without a request,
// and checked against these hashes, so the CDN cannot change the code a host runs.
const packIndex = JSON.parse(await readFile(resolve(rootDir, '..', 'libraries', 'parts', 'index.json'), 'utf8'))
const packIndexPath = resolve(rootDir, 'src', 'shared', 'pack-index.ts')
const packIndexModule = `// Written by scripts/sync-h5p-assets.mjs from @missing-elements/h5p-libraries ${librariesJson.version}'s
// parts/index.json. Do not edit; run \`pnpm sync:assets\` in packages/player.
import type { PackLibrary } from './protocol.js'

/**
 * The index of the pack this release pins (\`LIBRARY_PACK_VERSION\`), for the Service Worker's
 * \`libraries="pack"\` plan. The \`installOnly\` libraries are left out: the plan never takes one.
 */
export const PACK_INDEX: readonly PackLibrary[] = [
${packIndex.libraries.filter((entry) => !entry.installOnly).map((entry) => `  ${JSON.stringify(entry)}`).join(',\n')}
]
`
const currentPackIndex = (await exists(packIndexPath)) ? await readFile(packIndexPath, 'utf8') : ''
if (currentPackIndex !== packIndexModule) await writeFile(packIndexPath, packIndexModule, 'utf8')

console.log(
  `[sync-h5p] @missing-elements/h5p-runtime ${manifest.runtime} (the H5P core at ${manifest.core.commit.slice(0, 10)}, core API ${manifest.core.coreApi}) -> public/frame-assets`
)
