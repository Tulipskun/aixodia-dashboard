import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: ['.trycloudflare.com', 'localhost', '127.0.0.1'],
    // Local-dev helper only: if you set VITE_ENGINE_URL=/engine, requests to
    // /engine/* are proxied to the engine bound on 127.0.0.1:8787. The prefix
    // is stripped so the engine sees /v1/*, /healthz, /v1/auth/token, etc.
    //
    // Alternatives for dev (all rely on the engine's ALLOWED_ORIGINS CORS):
    //   * VITE_ENGINE_URL=http://127.0.0.1:8787  -> browser calls engine directly
    //   * VITE_ENGINE_URL unset                  -> production tunnel (default)
    // The old '/api' proxy forwarded to the Worker, which no longer exists.
    proxy: {
      '/engine': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/engine/, ''),
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})
