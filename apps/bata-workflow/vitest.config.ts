import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@luobata/tmux-manager': fileURLToPath(new URL('../../packages/tmux-manager/src/index.ts', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20000,
    coverage: {
      reporter: ['text', 'html']
    }
  }
})
