import { defineConfig } from 'vitest/config'

// The skills' scripts, tested from a project like their user's: it installs what the skills tell a
// user to install, and the scripts resolve their dependencies from it. Node, driving Chromium.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000
  }
})
