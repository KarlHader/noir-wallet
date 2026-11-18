import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const exampleRoot = fileURLToPath(new URL('.', import.meta.url))
const packageVersion = (path: string): string =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')).version
const revision = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
  cwd: exampleRoot,
  encoding: 'utf8'
}).trim()
const dirty =
  execFileSync('git', ['status', '--porcelain', '--', '.', '../src'], {
    cwd: exampleRoot,
    encoding: 'utf8'
  }).trim().length > 0

const base =
  process.env.GITHUB_PAGES_BASE ?? (process.env.GITHUB_PAGES ? '/noir-wallet-sdk/' : '/example/')

export default defineConfig({
  cacheDir: fileURLToPath(new URL('../../../output/node_modules/.vite/example', import.meta.url)),
  base,
  plugins: [react()],
  define: {
    __PUBLIC_DEMO_BUILD__: JSON.stringify({
      exampleVersion: packageVersion('./package.json'),
      sdkVersion: packageVersion('../package.json'),
      revision: `${revision}${dirty ? '-local' : ''}`
    })
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    host: 'localhost',
    port: 5002,
    strictPort: false,
    headers: {
      'Content-Security-Policy':
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: http://localhost:* http://127.0.0.1:*; object-src 'self'; connect-src 'self' http://localhost:* ws://localhost:*;"
    }
  }
})
