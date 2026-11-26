import { execFileSync } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The command line as one file, `h5p-author.mjs`, with its licences in `h5p-author-LICENSES.txt` (#247), for route 3.
 * No pinned pack: `--libraries`. Run `pnpm build:tool` (plan first); `node scripts/build-tool.mjs [folder]` skips the plan.
 */
// Packing runs Vite 8, which needs Node 22.12 on the workspace's floor: said here before Vite fails
// to load. The package's `engines` stays `>=22`, since installing it runs none of this.
const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 12)) {
  throw new Error(`Packing builds the one-file tool with Vite 8, and the workspace needs Node 22.12 or later for it; this is Node ${process.versions.node}`)
}
const { build } = await import('vite')

const root = resolve(import.meta.dirname, '..')
const folder = resolve(process.argv[2] ?? join(root, 'dist'))
const TOOL = 'h5p-author.mjs'
const LICENSES = 'h5p-author-LICENSES.txt'

for (const file of [TOOL, LICENSES]) await rm(join(folder, file), { force: true })
await build({
  configFile: false,
  root,
  logLevel: 'warn',
  publicDir: false,
  build: {
    ssr: join(root, 'bin', TOOL),
    outDir: folder,
    emptyOutDir: false,
    copyPublicDir: false,
    minify: false,
    license: { fileName: LICENSES },
    reportCompressedSize: false,
    rolldownOptions: { output: { entryFileNames: TOOL, format: 'es', codeSplitting: false } }
  },
  ssr: { noExternal: true, target: 'node' }
})

// The tool says its own versions, as a model checking it first asks: this package's and its pack's.
const version = async (/** @type {string} */ path) => JSON.parse(await readFile(path, 'utf8')).version
const pack = fileURLToPath(import.meta.resolve('@missing-elements/h5p-libraries/package.json'))
const expected = `@missing-elements/h5p-author ${await version(join(root, 'package.json'))}, library pack ${await version(pack)}`
const printed = execFileSync(process.execPath, [join(folder, TOOL), '--version'], { encoding: 'utf8' }).trim()
if (printed !== expected) throw new Error(`${TOOL} --version printed "${printed}", not "${expected}"`)
console.log(`Built ${join(folder, TOOL)}: ${printed}`)
