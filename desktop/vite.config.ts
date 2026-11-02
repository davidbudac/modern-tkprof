import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// The shared UI library lives in the engine submodule (engine/web/src/lib). Its bare imports
// (react, echarts, ...) resolve to this package's node_modules, so the dependencies the lib
// needs are declared here too (scripts/check-lib-deps.mjs keeps them in step).
const lib = fileURLToPath(new URL('./engine/web/src/lib', import.meta.url))

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
