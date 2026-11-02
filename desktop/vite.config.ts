import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// The shared UI library is web/src/lib in this repository. Its bare imports (react, echarts, ...)
// resolve from web/node_modules (one pnpm workspace; the catalog in pnpm-workspace.yaml keeps
// React the same version on both sides, and dedupe makes it one copy).
const lib = fileURLToPath(new URL('../web/src/lib', import.meta.url))

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: { alias: { '@lib': lib }, dedupe: ['react', 'react-dom'] },
  server: { port: 5173, strictPort: true, host: '127.0.0.1' },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 5000,
  },
})
