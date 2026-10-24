import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

// The build produces a single self-contained index.html (JS + CSS inlined),
// which the Go binary embeds and serves, and which `mtkprof html` turns
// into a standalone report by injecting the trace document.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    cssCodeSplit: false,
    assetsInlineLimit: 100000000,
    chunkSizeWarningLimit: 5000,
  },
  // `mtkprof serve -addr 127.0.0.1:8048` answers /api/doc and /api/lines during `pnpm dev`
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:8048' } },
})
