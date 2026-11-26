import { defineConfig } from 'vitest/config'

// Its own file, not a `test` block in `vite.config.ts`: the tests start the dev server themselves,
// so the runner's Vite needs none of the demo's plugins. Only the installable app is tested.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000
  }
})
