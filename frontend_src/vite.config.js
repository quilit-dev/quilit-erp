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
          // ~500 kB on its own. Being a separate chunk is NOT what makes it
          // lazy -- it shipped on the login screen for months because
          // components/shared.jsx imported it at module scope and App.jsx
          // imports shared.jsx. It is now `await import('xlsx')` inside
          // exportToExcel, and a test asserts it stays off the entry page.
          'vendor-xlsx': ['xlsx'],
        },
      },
    },
  },
})
