import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './',
  server: { port: 5173, strictPort: true },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test-setup.ts',
    exclude: ['release/**', 'node_modules/**'],
  },
})
