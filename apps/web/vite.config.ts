import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Fastify's dev address per apps/server/src/config.ts defaults (HOST=127.0.0.1, PORT=8787).
// Dev-only: production builds are served from the Fastify origin, so no CORS at all.
const API_ORIGIN = 'http://127.0.0.1:8787'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: API_ORIGIN,
        changeOrigin: true,
      },
    },
  },
})
