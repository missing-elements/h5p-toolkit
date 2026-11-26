import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

/**
 * Builds `dist/scorm-page.js`: the SCORM page's script and everything it imports in one ES module,
 * as the written site has no bundler. A host that bundles imports `./scorm-page.js` instead.
 */

const root = fileURLToPath(new URL('..', import.meta.url))

/**
 * The banner of the one shipped file with third-party code: ours and zip.js's licence in full, as
 * its clause 2 asks of a binary, read from the installed package to follow the bundled version.
 */
async function notices() {
  const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  const zipJs = resolve(root, 'node_modules', '@zip.js', 'zip.js')
  const zip = JSON.parse(await readFile(resolve(zipJs, 'package.json'), 'utf8')).version
  const licence = (await readFile(resolve(zipJs, 'LICENSE'), 'utf8')).trim()
  if (licence.includes('*/')) throw new Error('[build] the zip.js licence would end the comment early')
  return (
    `/*! @missing-elements/h5p-embed ${version}, the SCORM page. Copyright (c) 2026 missing-elements. MIT (https://github.com/missing-elements/h5p-toolkit/blob/main/LICENSE). ` +
    `Bundles the library rules of @missing-elements/h5p-offline-player (MIT) and zip.js ${zip} (https://github.com/gildas-lormeau/zip.js):\n\n${licence}\n*/`
  )
}

await build({
  entryPoints: [resolve(root, 'site', 'scorm-page.js')],
  outfile: resolve(root, 'dist', 'scorm-page.js'),
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  banner: { js: await notices() }
})
