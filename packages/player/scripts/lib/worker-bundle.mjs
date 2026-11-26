import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'

/**
 * The worker artefacts, built the same way for the package (`build-workers.mjs`) and for the
 * hosted demo (`build-demo.mjs`).
 */

const rootDir = resolve(import.meta.dirname, '..', '..')

/**
 * Takes the one `import()` out of zip.js, which ours never uses. Left in, a consumer's Vite dev
 * server prepends `import { injectQuery }` to the worker: a syntax error in a classic one.
 */
const noCodecImport = {
  name: 'no-codec-import',
  setup(build) {
    build.onLoad({ filter: /[\\/]@zip\.js[\\/]zip\.js[\\/]lib[\\/]core[\\/]codec-registry\.js$/ }, async (args) => {
      const source = await readFile(args.path, 'utf8')
      const pattern = /await import\([^)]*codecURI\)/
      if (!pattern.test(source)) throw new Error(`[no-codec-import] the codec import in ${args.path} has changed shape`)
      return {
        contents: source.replace(pattern, "await Promise.reject(new Error('codec modules are not loaded in the Service Worker'))"),
        loader: 'js'
      }
    })
  }
}

/**
 * zip.js's licence as a `/*! … *\/` header on both workers: its clause 2 asks for the text with a
 * binary, and a bundler emits `h5p-sw.js` alone (0.1.5 shipped none); read from the install.
 */
async function zipJsNotice() {
  const zipJsDir = resolve(rootDir, 'node_modules', '@zip.js', 'zip.js')
  const { version } = JSON.parse(await readFile(resolve(zipJsDir, 'package.json'), 'utf8'))
  const licence = (await readFile(resolve(zipJsDir, 'LICENSE'), 'utf8')).trim()
  if (licence.includes('*/')) throw new Error('[zip-js-notice] the zip.js licence would end the comment early')
  return `/*! @missing-elements/h5p-offline-player Service Worker. Bundles zip.js ${version} (https://github.com/gildas-lormeau/zip.js):\n\n${licence}\n*/`
}

/**
 * The package's own notice on every file it ships: MIT wants it with copies, and a bundler emits
 * each file alone. One line naming the licence and where its text is.
 */
export async function playerNotice() {
  const { version } = JSON.parse(await readFile(resolve(rootDir, 'package.json'), 'utf8'))
  return `/*! @missing-elements/h5p-offline-player ${version}. Copyright (c) 2026 missing-elements. MIT (https://github.com/missing-elements/h5p-toolkit/blob/main/LICENSE). */`
}

async function shared() {
  return {
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    banner: { js: `${await playerNotice()}\n${await zipJsNotice()}` },
    define: { 'import.meta.env.DEV': 'false' },
    plugins: [noCodecImport]
  }
}

/** `h5p-sw.js`: a self-contained classic script, because a Service Worker is registered by URL. */
export async function buildServiceWorker(outfile) {
  return build({ ...(await shared()), entryPoints: [resolve(rootDir, 'src/sw/sw-entry.ts')], outfile, format: 'iife' })
}

/** `h5p-sw-mount.js`: the same handlers as an ES module, for hosts that mount them into their own worker. */
export async function buildMountModule(outfile) {
  return build({ ...(await shared()), entryPoints: [resolve(rootDir, 'src/sw/mount.ts')], outfile, format: 'esm' })
}

/**
 * `h5p-jobs.js`: the Jobs worker the element carries as a string, as a file for a page whose
 * policy refuses a `blob:` worker. No zip.js here, so it carries the package's notice alone.
 */
export async function buildJobsWorker(outfile) {
  const { banner, plugins, ...options } = await shared()
  return build({ ...options, banner: { js: await playerNotice() }, plugins: [], entryPoints: [resolve(rootDir, 'src/jobs/jobs-worker.ts')], outfile, format: 'iife' })
}

/**
 * `h5p-plan.js`: the player's library rules (`src/plan.ts`) as an ES module for the packages that
 * write what it plays. Unminified, so a stack trace names the function; zip.js must not come in.
 */
export async function buildPlanModule(outfile) {
  const { banner, plugins, minify, ...options } = await shared()
  const result = await build({ ...options, platform: 'neutral', banner: { js: await playerNotice() }, plugins: [], metafile: true, entryPoints: [resolve(rootDir, 'src/plan.ts')], outfile, format: 'esm' })
  const zipJs = Object.keys(result.metafile.inputs).find((input) => input.includes('@zip.js'))
  if (zipJs) throw new Error(`[plan] dist/h5p-plan.js must not bundle zip.js, and imports ${zipJs}`)
  return result
}

/**
 * Resolves `@missing-elements/h5p-offline-player/sw` to the mount's source, as the demo's Vite
 * config does, so a worker here imports by a host's name and is still built from source.
 */
export const mountFromSource = {
  name: 'mount-from-source',
  setup(build) {
    build.onResolve({ filter: /^@missing-elements\/h5p-offline-player\/sw$/ }, () => ({ path: resolve(rootDir, 'src/sw/mount.ts') }))
  }
}

/**
 * A host's own Service Worker with the handlers mounted in (the demo app's), returned as text.
 * `define` fills in what its code needs; `dev` leaves it readable and turns the dev paths on.
 */
export async function bundleHostWorker(entry, { define = {}, dev = false } = {}) {
  const options = await shared()
  const result = await build({
    ...options,
    entryPoints: [entry],
    write: false,
    format: 'iife',
    minify: !dev,
    define: { ...options.define, 'import.meta.env.DEV': String(dev), ...define },
    plugins: [...options.plugins, mountFromSource]
  })
  return result.outputFiles[0].text
}
