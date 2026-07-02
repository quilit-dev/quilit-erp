import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Vitest — page render smoke suite (src/test/). `npm test`.
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.js'],
    css: false,
  },
  build: {
    outDir: '../static',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          // React core — shared by every page, cached longest
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          // xlsx is ~500 kB on its own; only loaded when a page exports
          'vendor-xlsx': ['xlsx'],
        },
      },
    },
  },
})
