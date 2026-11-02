import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Unit tests of the desktop code only; the shared lib (web/) runs its own.
export default defineConfig({
  resolve: { alias: { '@lib': fileURLToPath(new URL('../web/src/lib', import.meta.url)) } },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
})
