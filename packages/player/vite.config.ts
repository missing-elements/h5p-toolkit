/// <reference types="vitest/config" />
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { configDefaults } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'
import { devServiceWorkerPlugin, jobsWorkerPlugin, noRangeFixturesPlugin } from './vite.plugins'

/**
 * The library build and the test runner. The plugins live in `vite.plugins.ts` because the demo
 * app (`apps/demo/vite.config.ts`), which is the dev server, needs the same ones.
 */

/**
 * The browser files that wait out real time: a stalled host, a worker update's deadlines, 20 MB
 * archives. `H5P_TEST_SKIP_SLOW` leaves them out, as CI does but for its weekly run.
 */
const SLOW = ['tests/browser/stalling-host.test.ts', 'tests/browser/worker-update.test.ts', 'tests/browser/large-media.test.ts']

export default defineConfig({
  plugins: [jobsWorkerPlugin(), devServiceWorkerPlugin(), noRangeFixturesPlugin()],

  build: {
    target: 'es2022',
    lib: {
      name: 'H5PPlayerElement',
      entry: resolve(import.meta.dirname, 'src/h5p-offline-player.ts'),
      fileName: () => 'h5p-player.js',
      formats: ['es']
    },
    rollupOptions: {
      output: { assetFileNames: '[name][extname]' }
    },
    copyPublicDir: false,
    emptyOutDir: true
  },

  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts']
        }
      },
      {
        extends: true,
        test: {
          name: 'browser',
          include: ['tests/browser/**/*.test.ts'],
          exclude: process.env.H5P_TEST_SKIP_SLOW ? [...configDefaults.exclude, ...SLOW] : configDefaults.exclude,
          browser: browserProject(engine())
        }
      },
      {
        // One file at a time in its own browser: a CDP emulation (storage cap, slow link) is per
        // browser profile, so it would land on whatever other file is running.
        extends: true,
        test: {
          name: 'browser-emulated',
          include: ['tests/browser-emulated/**/*.test.ts'],
          fileParallelism: false,
          browser: browserProject('chromium')
        }
      }
    ]
  }
})

type Engine = 'chromium' | 'firefox' | 'webkit'

/**
 * The engine the suite runs in: Chromium or `H5P_TEST_BROWSER`'s, one per run as the dev server's
 * switches are shared and two engines would flip them. The emulated project stays on Chromium: CDP.
 */
function engine(): Engine {
  const name = process.env.H5P_TEST_BROWSER?.trim() || 'chromium'
  if (name !== 'chromium' && name !== 'firefox' && name !== 'webkit') throw new Error(`H5P_TEST_BROWSER: unknown browser "${name}"`)
  return name
}

function browserProject(browser: Engine) {
  return {
    enabled: true,
    // From Vitest 4 on, a provider is a package rather than a name.
    provider: playwright(),
    headless: true,
    instances: [{ browser }]
  }
}
