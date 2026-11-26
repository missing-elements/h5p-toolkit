import { defineConfig } from 'vitest/config'

// Its own file, not a `test` block in `vite.config.ts`: the app's tests start the dev server and the
// sweep's generator runs in Node, so the runner's Vite needs no demo plugins. Tested: app, sweep.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000
  }
})
