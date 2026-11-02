import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { crx, type CrxPlugin } from '@crxjs/vite-plugin'
import zip from 'vite-plugin-zip-pack'
import manifest from './manifest.config'
import path from 'path'
import { mkdirSync, readFileSync, renameSync, watch, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { name, version } from './package.json'
import { rdns as NOIR_WALLET_RDNS } from '../sdk/package.json'
import {
  ALL_CHAIN_FEATURE_FLAGS,
  EVM_CHAIN_FEATURE_FLAG,
  parseEnabledChainFeatureFlags
} from './src/config/multichain-feature-flags'
import { findProhibitedRuntimeModules } from './scripts/lib/runtime-module-policy.mjs'
import { collectLedgerDependencyNotices } from './scripts/lib/ledger-dependency-notices.mjs'
import { resolveHistoryApiOrigin } from './scripts/lib/extension-build-config'
import { resolveBetaInviteRequired } from './src/config/beta-invite'

const require = createRequire(import.meta.url)
const generatedWasmRoots = [
  path.resolve(__dirname, './src/infrastructure/generated/wasm/multichain'),
  path.resolve(__dirname, './src/lib/wasm-pkg')
]
const requestedNetworkMode = process.env.NETWORK_MODE
if (
  requestedNetworkMode !== undefined &&
  requestedNetworkMode !== 'mainnet' &&
  requestedNetworkMode !== 'testnet'
) {
  throw new Error(`Unsupported NETWORK_MODE: ${requestedNetworkMode}`)
}
const networkMode = requestedNetworkMode ?? 'mainnet'
const buildChannel = process.env.BUILD_CHANNEL || 'development'
const betaInviteRequired = resolveBetaInviteRequired(buildChannel, process.env.BETA_INVITE_REQUIRED)
const debugLogsEnabled = buildChannel !== 'production'
const isPlaywrightBuild = process.env.PLAYWRIGHT_E2E === '1'
const analyticsReportingEnabled =
  buildChannel === 'production' && networkMode === 'mainnet' && !isPlaywrightBuild
const gaApiSecret = analyticsReportingEnabled ? process.env.GA_API_SECRET?.trim() || '' : ''
const customAnalyticsPassword = analyticsReportingEnabled
  ? process.env.CUSTOM_ANALYTICS_PASSWORD || ''
  : ''
if (analyticsReportingEnabled && (!gaApiSecret || !customAnalyticsPassword.trim())) {
  throw new Error(
    'Production mainnet analytics requires GA_API_SECRET and CUSTOM_ANALYTICS_PASSWORD build variables'
  )
}
const localDevelopmentEnv =
  buildChannel === 'development' ? loadEnv('development', __dirname, '') : {}
const rheaSwapAccessToken =
  (process.env.RHEA_SWAP_ACCESS_TOKEN ?? localDevelopmentEnv.RHEA_SWAP_ACCESS_TOKEN)?.trim() ?? ''
if ((buildChannel === 'beta' || buildChannel === 'production') && !rheaSwapAccessToken) {
  throw new Error('RHEA_SWAP_ACCESS_TOKEN is required for release builds')
}
if (rheaSwapAccessToken.length > 4096 || /[\u0000-\u001f\u007f-\u009f]/.test(rheaSwapAccessToken)) {
  throw new Error('RHEA_SWAP_ACCESS_TOKEN is invalid')
}
const historyApiOrigin = resolveHistoryApiOrigin(process.env.EVM_HISTORY_API_ORIGIN, buildChannel)
const isExtensionDevServer = process.env.EXTENSION_DEV_SERVER === '1' && !isPlaywrightBuild
const extensionUpdatesEnabled = buildChannel === 'production' || isPlaywrightBuild
const e2eBuildProfile = process.env.E2E_BUILD_PROFILE ?? `${networkMode}-default`
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(e2eBuildProfile)) {
  throw new Error(`Invalid E2E_BUILD_PROFILE: ${e2eBuildProfile}`)
}
if (isPlaywrightBuild && !e2eBuildProfile.startsWith(`${networkMode}-`)) {
  throw new Error(`E2E_BUILD_PROFILE ${e2eBuildProfile} does not match NETWORK_MODE ${networkMode}`)
}
const enabledChainFeatureFlags = parseEnabledChainFeatureFlags(
  process.env.ENABLED_CHAIN_FEATURE_FLAGS,
  ALL_CHAIN_FEATURE_FLAGS
)
const providerIconDataUrl = `data:image/png;base64,${readFileSync(
  path.resolve(__dirname, './public/icons/icon128.png')
).toString('base64')}`
const earlyEvmProviderSource = path.resolve(__dirname, 'public/early-evm-provider.js')
const readEarlyEvmProviderSource = () =>
  readFileSync(earlyEvmProviderSource, 'utf8').replace(
    "'__NOIR_WALLET_RDNS__'",
    JSON.stringify(NOIR_WALLET_RDNS)
  )
const buildOutDir = isExtensionDevServer
  ? 'dist-dev'
  : isPlaywrightBuild
    ? path.posix.join('e2e-dist', e2eBuildProfile)
    : networkMode === 'testnet'
      ? path.posix.join('e2e-dist', 'testnet-build-check')
      : 'dist'

const preferredExtensionDevServerPort = 5004

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', error => {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EADDRINUSE' || code === 'EACCES') {
        resolve(false)
        return
      }
      reject(error)
    })
    server.listen({ host: 'localhost', port, exclusive: true }, () => {
      server.close(error => {
        if (error) reject(error)
        else resolve(true)
      })
    })
  })
}

async function findExtensionDevServerPort(startPort: number): Promise<number> {
  for (let port = startPort; port < startPort + 100; port += 1) {
    if (await isPortAvailable(port)) return port
  }
  throw new Error(`No available extension development port found from ${startPort}`)
}

const extensionDevServerPort = isExtensionDevServer
  ? await findExtensionDevServerPort(preferredExtensionDevServerPort)
  : preferredExtensionDevServerPort

function stripDiagnosticCallbacks(code: string): string {
  return code.replace(/\.catch\(\s*console\.(?:log|info|warn|error)\s*\)/g, '.catch(() => {})')
}

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
      const hasWindowAccessor = WASM_WINDOW_ACCESSOR.test(code)
      WASM_WINDOW_ACCESSOR.lastIndex = 0
      const hasWindowInstanceCheck = WASM_WINDOW_INSTANCE_CHECK.test(code)
      WASM_WINDOW_INSTANCE_CHECK.lastIndex = 0
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
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __BUILD_CHANNEL__: JSON.stringify(buildChannel),
    __NETWORK_MODE__: JSON.stringify(networkMode),
    __BETA_INVITE_REQUIRED__: JSON.stringify(betaInviteRequired),
    __DEBUG_LOGS__: JSON.stringify(debugLogsEnabled),
    __EXTENSION_UPDATES_ENABLED__: JSON.stringify(extensionUpdatesEnabled),
    __MULTICHAIN_CONFORMANCE_RPC_ENABLED__: JSON.stringify(isPlaywrightBuild),
    __EVM_HISTORY_API_ORIGIN__: JSON.stringify(historyApiOrigin),
    __GA_API_SECRET__: JSON.stringify(gaApiSecret),
    __CUSTOM_ANALYTICS_PASSWORD__: JSON.stringify(customAnalyticsPassword),
    __RHEA_SWAP_ACCESS_TOKEN__: JSON.stringify(rheaSwapAccessToken),
    __CONFIDENTIAL_ONE_CLICK_API_URL__: JSON.stringify(
      process.env.CONFIDENTIAL_ONE_CLICK_API_URL ?? ''
    ),
    __ENABLED_CHAIN_FEATURE_FLAGS__: JSON.stringify(enabledChainFeatureFlags),
    'import.meta.env.NOIR_PROVIDER_ICON_DATA_URL': JSON.stringify(providerIconDataUrl),
    'import.meta.env.NOIR_WALLET_RDNS': JSON.stringify(NOIR_WALLET_RDNS),
    'import.meta.env.NOIR_APP_VERSION': JSON.stringify(version),
    'import.meta.env.NOIR_NETWORK_MODE': JSON.stringify(networkMode),
    'import.meta.env.NOIR_ENABLED_CHAIN_FEATURE_FLAGS': JSON.stringify(enabledChainFeatureFlags)
  },
  esbuild: {
    drop: debugLogsEnabled ? [] : ['console', 'debugger']
  },
  plugins: [
    react(),
    tailwindcss(),
    crx({ manifest }),
    {
      name: 'include-project-and-signing-licenses',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'LICENSE',
          source: readFileSync(path.resolve(__dirname, '../../LICENSE'), 'utf8')
        })
        for (const notice of collectLedgerDependencyNotices(__dirname)) {
          this.emitFile({
            type: 'asset',
            fileName: notice.fileName,
            source: notice.source
          })
        }
      }
    },
    {
      name: 'load-early-evm-provider-synchronously',
      enforce: 'post',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'early-evm-provider.js',
          source: readEarlyEvmProviderSource()
        })
      },
      configureServer(server) {
        // CRXJS dev loaders use dynamic import; prepend the bootstrap before that import runs.
        if (!isExtensionDevServer || !enabledChainFeatureFlags.includes(EVM_CHAIN_FEATURE_FLAG))
          return
        const outDir = path.resolve(__dirname, buildOutDir)
        const loaderPath = path.join(outDir, 'public/early-evm-provider.js-loader.js')
        const marker = '// Noir early EVM provider bootstrap\n'
        const endMarker = '// End Noir early EVM provider bootstrap\n'
        const patchLoader = () => {
          let contents: string
          try {
            contents = readFileSync(loaderPath, 'utf8')
          } catch {
            return
          }
          if (!contents.trimEnd().endsWith('})();')) return
          const endIndex = contents.indexOf(endMarker)
          if (contents.startsWith(marker) && endIndex < 0) return
          const loader = contents.startsWith(marker)
            ? contents.slice(endIndex + endMarker.length)
            : contents
          const next = `${marker}${readEarlyEvmProviderSource()};\n${endMarker}${loader}`
          if (next !== contents) {
            const stagedPath = `${loaderPath}.tmp-${process.pid}`
            writeFileSync(stagedPath, next)
            renameSync(stagedPath, loaderPath)
          }
        }
        mkdirSync(outDir, { recursive: true })
        const watcher = watch(outDir, { recursive: true }, (_event, file) => {
          if (file?.endsWith('early-evm-provider.js-loader.js')) patchLoader()
        })
        server.watcher.on('change', file => {
          if (file === earlyEvmProviderSource) patchLoader()
        })
        patchLoader()
        server.httpServer?.on('close', () => watcher.close())
      },
      renderCrxManifest(renderedManifest) {
        for (const script of renderedManifest.content_scripts ?? []) {
          if (script.js?.some(file => file.includes('early-evm-provider'))) {
            script.js = ['early-evm-provider.js']
          }
        }
        return renderedManifest
      }
    } as CrxPlugin,
    ...(!isPlaywrightBuild
      ? [
          zip({
            inDir: buildOutDir,
            outDir: buildOutDir,
            outFileName: `${name.replace('/', '-')}-v${version}${networkMode === 'testnet' ? '-testnet' : ''}.zip`
          })
        ]
      : []),
    ...(isPlaywrightBuild
      ? [
          {
            name: 'emit-e2e-build-profile',
            generateBundle() {
              this.emitFile({
                type: 'asset',
                fileName: 'e2e-build-profile.json',
                source: `${JSON.stringify(
                  {
                    schemaVersion: 1,
                    profile: e2eBuildProfile,
                    networkMode,
                    enabledChainFeatureFlags: [...enabledChainFeatureFlags].sort()
                  },
                  null,
                  2
                )}\n`
              })
            }
          } satisfies Plugin
        ]
      : []),
    {
      name: 'reject-prohibited-vulnerable-runtime-modules',
      generateBundle(_options, bundle) {
        const moduleIds = Object.values(bundle).flatMap(output =>
          output.type === 'chunk' ? Object.keys(output.modules) : []
        )
        const prohibitedModules = findProhibitedRuntimeModules(moduleIds)
        if (prohibitedModules.length > 0) {
          throw new Error(
            `Prohibited vulnerable runtime module entered the build: ${prohibitedModules.join(', ')}`
          )
        }
      }
    },
    {
      name: 'strip-production-diagnostic-callbacks',
      enforce: 'post',
      generateBundle(_options, bundle) {
        if (debugLogsEnabled) return
        for (const output of Object.values(bundle)) {
          if (output.type === 'chunk') {
            output.code = stripDiagnosticCallbacks(output.code)
          } else if (output.fileName.endsWith('.js') && typeof output.source === 'string') {
            output.source = stripDiagnosticCallbacks(output.source)
          }
        }
      },
      renderChunk(code) {
        if (debugLogsEnabled) return null
        const stripped = stripDiagnosticCallbacks(code)
        return stripped === code ? null : { code: stripped, map: null }
      }
    },
    {
      name: 'configure-headers',
      configureServer(server) {
        server.config.logger.info(
          `[Noir Wallet] Chrome extension directory: ${path.resolve(__dirname, buildOutDir)}`
        )
        if (extensionDevServerPort !== preferredExtensionDevServerPort) {
          server.config.logger.info(
            `[Noir Wallet] Port ${preferredExtensionDevServerPort} is in use; using ${extensionDevServerPort}`
          )
        }
        server.middlewares.use((_req, res, next) => {
          res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
          res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless')
          next()
        })
      }
    },
    {
      name: 'reload-generated-wasm-packages',
      handleHotUpdate({ file, server }) {
        if (
          !generatedWasmRoots.some(root => file === root || file.startsWith(`${root}${path.sep}`))
        ) {
          return
        }
        const modules = server.moduleGraph.getModulesByFile(file)
        if (modules) {
          for (const module of modules) server.moduleGraph.invalidateModule(module)
        }
        server.ws.send({ type: 'full-reload' })
        return []
      }
    }
  ],
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      { find: /^buffer$/, replacement: require.resolve('buffer/') },
      { find: /^util$/, replacement: require.resolve('util/') },
      { find: /^stream$/, replacement: require.resolve('readable-stream') },
      // Force the CJS build of the Zcash UR registry. Its ESM entry does a
      // named `import { RegistryType }` from the CJS @keystonehq/bc-ur-registry,
      // whose names are exposed via runtime __exportStar. Rollup can't detect
      // them statically and resolves the default export, leaving RegistryType
      // undefined -> "RegistryType is not a constructor" at popup load.
      {
        find: '@keystonehq/bc-ur-registry-zcash',
        replacement: require.resolve('@keystonehq/bc-ur-registry-zcash')
      }
    ]
  },
  optimizeDeps: {
    exclude: ['zcash-wallet-wasm']
  },
  build: {
    outDir: buildOutDir,
    rollupOptions: {
      input: {
        popup: 'index.html',
        offscreen: 'src/offscreen/index.html',
        ...(isPlaywrightBuild
          ? {
              credentialRepositoryIntegration:
                'tests/extension/credential-repository-integration.html',
              transactionRepositoryIntegration:
                'tests/extension/transaction-repository-integration.html',
              bitcoinDiscoveryRepositoryIntegration:
                'tests/extension/bitcoin-discovery-repository-integration.html'
            }
          : {})
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
    port: extensionDevServerPort,
    strictPort: true,
    watch: {
      // Verification builds must not reload Offscreen and end the dev wallet session.
      ignored: ['**/e2e-dist/**', '**/dist/**', '**/dist-dev/**', '**/e2e-output/**']
    },
    hmr: {
      port: extensionDevServerPort
    },
    // Extension specific CORS
    cors: {
      origin: [/chrome-extension:\/\//]
    }
  }
})
