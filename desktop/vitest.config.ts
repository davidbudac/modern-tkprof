import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Unit tests of the desktop code only; the shared lib (engine/web) runs its own.
export default defineConfig({
  resolve: { alias: { '@lib': fileURLToPath(new URL('./engine/web/src/lib', import.meta.url)) } },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
})
