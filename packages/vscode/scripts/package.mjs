import { spawnSync } from 'node:child_process'
import { cp, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Writes `h5p-preview-<version>.vsix` from what `build.mjs` built, for Marketplace and Open VSX.
 * `--no-dependencies`: everything is in `dist/` and `assets/`, so no node_modules goes in.
 */

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const vsce = join(dirname(require.resolve('@vscode/vsce/package.json')), 'vsce')
const { name, version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const out = `${name}-${version}.vsix`
const folder = 'https://github.com/missing-elements/h5p-toolkit'

// As the other packages' prepack does: the repository's licence, in the package.
await cp(join(root, '..', '..', 'LICENSE'), join(root, 'LICENSE'))

const result = spawnSync(
  process.execPath,
  [
    vsce,
    'package',
    '--no-dependencies',
    '--out',
    out,
    // The README's links resolve to this folder; vsce's default base is the repository root.
    '--baseContentUrl',
    `${folder}/blob/HEAD/packages/vscode/`,
    '--baseImagesUrl',
    `${folder}/raw/HEAD/packages/vscode/`
  ],
  { cwd: root, stdio: 'inherit' }
)
process.exit(result.status ?? 1)
