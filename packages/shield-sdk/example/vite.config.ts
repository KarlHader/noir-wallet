import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  cacheDir: fileURLToPath(
    new URL('../../../output/node_modules/.vite/shield-example', import.meta.url)
  ),
  plugins: [react()],
  resolve: {
    alias: {
      '@noir-wallet/shield-sdk': fileURLToPath(new URL('../src/index.ts', import.meta.url)),
      '@noir-wallet/sdk': fileURLToPath(new URL('../../sdk/src/index.ts', import.meta.url))
    }
  },
  server: {
    host: 'localhost',
    port: 5003,
    strictPort: true,
    headers: {
      'Content-Security-Policy':
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: http://localhost:* http://127.0.0.1:*; object-src 'self'; connect-src 'self' http://localhost:* ws://localhost:*;"
    }
  }
})
