import { readFile } from 'node:fs/promises'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import type { Plugin as EsbuildPlugin } from 'esbuild'

const base =
  process.env.GITHUB_PAGES_BASE ?? (process.env.GITHUB_PAGES ? '/noir-wallet-sdk/' : '/example/')

const BITCOIN_BUFFER_PACKAGE = /(?:bitcoinjs-lib|bip174)(?:[/\\]|$)/

function needsBufferInjection(code: string): boolean {
  return /(?:^|[^\w.$])Buffer\b/.test(code)
}

function alreadyImportsBuffer(code: string): boolean {
  return (
    /\bimport\s*\{[^}]*\bBuffer\b[^}]*\}\s*from\s*['"]buffer['"]/.test(code) ||
    /\brequire\s*\(\s*['"]buffer['"]\s*\)/.test(code)
  )
}

/** Production / direct module graph: prepend an ESM Buffer import. */
function injectBufferForBitcoinLibs(): Plugin {
  return {
    name: 'inject-buffer-for-bitcoin-libs',
    transform(code, id) {
      if (id.includes('\0') || !BITCOIN_BUFFER_PACKAGE.test(id)) return null
      if (!needsBufferInjection(code) || alreadyImportsBuffer(code)) return null
      return {
        code: `import { Buffer } from 'buffer';\n${code}`,
        map: null
      }
    }
  }
}

/** Dev optimizeDeps prebundle: CJS packages need a local Buffer binding. */
function esbuildInjectBufferPlugin(): EsbuildPlugin {
  return {
    name: 'inject-buffer-for-bitcoin-libs',
    setup(build) {
      build.onLoad({ filter: /.*/ }, async args => {
        if (!BITCOIN_BUFFER_PACKAGE.test(args.path)) return null
        if (!/\.(?:[cm]?js|ts)$/.test(args.path)) return null
        const source = await readFile(args.path, 'utf8')
        if (!needsBufferInjection(source) || alreadyImportsBuffer(source)) return null
        return {
          contents: `var Buffer = require('buffer').Buffer;\n${source}`,
          loader: 'js'
        }
      })
    }
  }
}

export default defineConfig({
  base,
  plugins: [react(), injectBufferForBitcoinLibs()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      buffer: 'buffer/'
    }
  },
  define: {
    global: 'globalThis'
  },
  optimizeDeps: {
    include: ['buffer', 'bitcoinjs-lib', 'bip174', '@bitcoinerlab/secp256k1'],
    esbuildOptions: {
      define: {
        global: 'globalThis'
      },
      plugins: [esbuildInjectBufferPlugin()]
    }
  },
  server: {
    host: 'localhost',
    port: 5002,
    strictPort: true,
    headers: {
      'Content-Security-Policy':
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: http://localhost:* http://127.0.0.1:*; object-src 'self'; connect-src 'self' http://localhost:* ws://localhost:* https://blockbook.pearlresearch.ai https://blockbook.testnet.pearlresearch.ai https://starknet-rpc.publicnode.com https://starknet-sepolia-rpc.publicnode.com;"
    },
    proxy: {
      // Same-origin proxies for Create test PSBT (avoids CSP connect-src blocks).
      '/example/pearl-blockbook-testnet': {
        target: 'https://blockbook.testnet.pearlresearch.ai',
        changeOrigin: true,
        secure: true,
        rewrite: path => path.replace(/^\/example\/pearl-blockbook-testnet/, '')
      },
      '/example/pearl-blockbook': {
        target: 'https://blockbook.pearlresearch.ai',
        changeOrigin: true,
        secure: true,
        rewrite: path => path.replace(/^\/example\/pearl-blockbook/, '')
      }
    }
  }
})
