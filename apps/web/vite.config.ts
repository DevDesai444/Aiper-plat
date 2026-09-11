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
      // Yjs collab. `ws: true` upgrades the HTTP CONNECT into a real
      // WebSocket to Fastify. Same origin trick the SPA relies on for
      // /api — the browser cannot set headers on a WebSocket, so auth
      // rides `?token=<jwt>` (see apps/web/src/editor/collabProvider.ts).
      '/ws': {
        target: API_ORIGIN,
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
