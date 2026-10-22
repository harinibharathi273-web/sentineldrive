import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

// HTTPS is on by default because phones only allow the camera, microphone,
// motion sensor and GPS on secure pages. Your browser will warn about the
// self-signed certificate once; choose "Advanced" -> "Proceed".
// Set SENTINEL_HTTP=1 to serve plain HTTP on this computer only.
const https = process.env.SENTINEL_HTTP !== '1'
const backend = process.env.SENTINEL_BACKEND || 'http://localhost:8000'

export default defineConfig({
  plugins: [react(), ...(https ? [basicSsl()] : [])],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': backend,
      '/media': backend,
      '/ws': { target: backend.replace(/^http/, 'ws'), ws: true },
    },
  },
  preview: { host: true, port: 4173 },
})
