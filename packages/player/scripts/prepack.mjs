import { copyFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/**
 * Copies the root LICENSE into the package before packing, as npm takes it from there. The README
 * stays the package's own: the root one is the toolkit's front page, and npm shows this one.
 */

const packageDir = resolve(import.meta.dirname, '..')
const repositoryRoot = resolve(packageDir, '..', '..')

await copyFile(resolve(repositoryRoot, 'LICENSE'), resolve(packageDir, 'LICENSE'))

console.log('[prepack] LICENSE copied from the repository root')
