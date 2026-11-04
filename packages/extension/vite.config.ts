import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { crx } from '@crxjs/vite-plugin'
import zip from 'vite-plugin-zip-pack'
import manifest from './manifest.config'
import path from 'path'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { name, version } from './package.json'
import { shouldEnableAnalyticsReporting } from './analytics-build-policy'

const require = createRequire(import.meta.url)
const networkMode = process.env.NETWORK_MODE || 'mainnet'
const buildChannel = process.env.BUILD_CHANNEL || 'development'
const debugLogsEnabled = buildChannel !== 'production'
const isPlaywrightBuild = process.env.PLAYWRIGHT_E2E === '1'
const analyticsReportingEnabled = shouldEnableAnalyticsReporting({
  buildChannel,
  isPlaywrightBuild,
  networkMode
})
const gaApiSecret = analyticsReportingEnabled ? process.env.GA_API_SECRET?.trim() || '' : ''
const customAnalyticsPassword = analyticsReportingEnabled
  ? process.env.CUSTOM_ANALYTICS_PASSWORD || ''
  : ''
if (analyticsReportingEnabled && (!gaApiSecret || !customAnalyticsPassword.trim())) {
  throw new Error(
    'Production mainnet analytics requires GA_API_SECRET and CUSTOM_ANALYTICS_PASSWORD build variables'
  )
}
const extensionUpdatesEnabled = buildChannel === 'production' || isPlaywrightBuild
const buildOutDir = isPlaywrightBuild
  ? path.resolve(__dirname, '../../output/extension')
  : networkMode === 'testnet'
    ? 'dist-testnet'
    : 'dist'

const WASM_WINDOW_ACCESSOR =
  /typeof window(?:\s*===\s*['"]undefined['"]|\s*>\s*['"]u['"])\s*\?\s*null\s*:\s*window/g
const WASM_WINDOW_INSTANCE_CHECK = /instanceof Window/g

function adaptWasmWindowGlobalsForWorker() {
  return {
    name: 'adapt-wasm-window-globals-for-worker',
    transform(code: string) {
      if (!code.includes('webvotingsession_discoverRounds')) return null
      if (
        code.includes('globalThis.window??null') &&
        code.includes('instanceof globalThis.Window')
      ) {
        return null
      }
      const hasWindowAccessor = Boolean(code.match(WASM_WINDOW_ACCESSOR))
      const hasWindowInstanceCheck = Boolean(code.match(WASM_WINDOW_INSTANCE_CHECK))
      if (!hasWindowAccessor || !hasWindowInstanceCheck) {
        throw new Error('The WASM Window glue changed; update the Worker compatibility adapter')
      }

      return {
        code: code
          .replace(WASM_WINDOW_ACCESSOR, 'globalThis.window??null')
          .replace(WASM_WINDOW_INSTANCE_CHECK, 'instanceof globalThis.Window'),
        map: null
      }
    }
  }
}

export default defineConfig({
  cacheDir: path.resolve(__dirname, `../../output/node_modules/.vite/extension-${networkMode}`),
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __BUILD_CHANNEL__: JSON.stringify(buildChannel),
    __NETWORK_MODE__: JSON.stringify(networkMode),
    __ANALYTICS_REPORTING_ENABLED__: JSON.stringify(analyticsReportingEnabled),
    __GA_API_SECRET__: JSON.stringify(gaApiSecret),
    __CUSTOM_ANALYTICS_PASSWORD__: JSON.stringify(customAnalyticsPassword),
    __DEBUG_LOGS__: JSON.stringify(debugLogsEnabled),
    __EXTENSION_UPDATES_ENABLED__: JSON.stringify(extensionUpdatesEnabled)
  },
  esbuild: {
    pure: debugLogsEnabled ? [] : ['console.log']
  },
  plugins: [
    {
      name: 'extension-dev-port',
      apply: 'serve',
      async config() {
        // CRXJS and Vite both capture the HMR port before the dev server starts.
        const port = await new Promise<number>((resolve, reject) => {
          const probe = createServer()
          probe.once('error', reject)
          probe.listen(0, 'localhost', () => {
            const { port } = probe.address() as AddressInfo
            probe.close(error => (error ? reject(error) : resolve(port)))
          })
        })
        return { server: { port, strictPort: true, hmr: { port } } }
      }
    },
    react(),
    tailwindcss(),
    crx({ manifest }),
    {
      name: 'include-project-license',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'LICENSE',
          source: readFileSync(path.resolve(__dirname, '../../LICENSE'), 'utf8')
        })
      }
    },
    ...(!isPlaywrightBuild
      ? [
          zip({
            inDir: buildOutDir,
            outDir: buildOutDir,
            outFileName: `${name.replace('/', '-')}-v${version}${networkMode === 'testnet' ? '-testnet' : ''}.zip`
          })
        ]
      : []),
    {
      name: 'configure-headers',
      configureServer(server) {
        server.httpServer?.once('listening', () => {
          server.config.logger.info(
            `Extension dev server: http://localhost:${server.config.server.port}/`
          )
        })
        server.middlewares.use((_req, res, next) => {
          res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
          res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
          next()
        })
      }
    }
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Force the CJS build of the Zcash UR registry. Its ESM entry does a
      // named `import { RegistryType }` from the CJS @keystonehq/bc-ur-registry,
      // whose names are exposed via runtime __exportStar. Rollup can't detect
      // them statically and resolves the default export, leaving RegistryType
      // undefined -> "RegistryType is not a constructor" at popup load.
      '@keystonehq/bc-ur-registry-zcash': require.resolve('@keystonehq/bc-ur-registry-zcash')
    }
  },
  optimizeDeps: {
    exclude: ['zcash-wallet-wasm']
  },
  build: {
    outDir: buildOutDir,
    emptyOutDir: isPlaywrightBuild ? true : undefined,
    rollupOptions: {
      input: {
        popup: 'index.html',
        offscreen: 'src/offscreen/index.html'
      },
      // Exclude WASM worker files from bundling - they have circular imports
      external: [/public\/wasm\/snippets\/.*/]
    },
    // Copy WASM files as static assets
    assetsInlineLimit: 0,
    copyPublicDir: true
  },
  // Ensure worker files are not processed
  worker: {
    format: 'es',
    plugins: () => [adaptWasmWindowGlobalsForWorker()]
  },
  server: {
    port: 5004,
    strictPort: true,
    // Extension specific CORS
    cors: {
      origin: [/chrome-extension:\/\//]
    }
  }
})
