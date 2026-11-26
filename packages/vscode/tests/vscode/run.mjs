import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runTests } from '@vscode/test-electron'

/**
 * The extension in a real VS Code, downloaded into .vscode-test/, with the demo's content open and
 * `suite.cjs` run in its extension host. Stable unless VSCODE_TEST_VERSION says; Linux needs xvfb.
 */

const root = fileURLToPath(new URL('../..', import.meta.url))
const content = fileURLToPath(new URL('../../../../apps/demo/demo/content', import.meta.url))
const userData = mkdtempSync(join(tmpdir(), 'h5p-preview-vscode-'))

// A terminal inside VS Code passes this on, and the downloaded editor would then start as Node.
delete process.env.ELECTRON_RUN_AS_NODE

try {
  await runTests({
    version: process.env.VSCODE_TEST_VERSION ?? 'stable',
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, 'tests', 'vscode', 'suite.cjs'),
    // Trusted, as the content folder is the repository's own; Restricted Mode is the settings' test.
    launchArgs: [content, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', `--user-data-dir=${userData}`]
  })
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  rmSync(userData, { recursive: true, force: true })
}
