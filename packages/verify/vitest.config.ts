import { defineConfig } from 'vitest/config'

// The package's limit, and no test's own (#255): a test that plays a package starts a browser, 9 to
// 18 s on a CI runner, past vitest's 5 s. A test names its own only to ask for more.
export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000
  }
})
