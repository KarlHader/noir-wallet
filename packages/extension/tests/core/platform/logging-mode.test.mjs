import { test as it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { logger } from '../../../src/lib/logger.ts'
import { resolveHistoryApiOrigin } from '../../../scripts/lib/extension-build-config.ts'

const describe = it.describe

const viteConfigSource = readFileSync(new URL('../../../vite.config.ts', import.meta.url), 'utf-8')
const workflowSource = readFileSync(
  new URL('../../../../../.github/workflows/extension-ci.yml', import.meta.url),
  'utf-8'
)
const loggerSource = readFileSync(new URL('../../../src/lib/logger.ts', import.meta.url), 'utf-8')
const zcashWalletRuntimeSource = readFileSync(
  new URL('../../../src/background/zcash-wallet-runtime.ts', import.meta.url),
  'utf-8'
)
const buildSurfaceVerifierSource = readFileSync(
  new URL('../../../scripts/verify-build-surface.mjs', import.meta.url),
  'utf-8'
)
const historyWorkerSource = readFileSync(
  new URL('../../../../evm-history-worker/src/index.ts', import.meta.url),
  'utf-8'
)
const historyWorkerConfig = JSON.parse(
  readFileSync(new URL('../../../../evm-history-worker/wrangler.json', import.meta.url), 'utf-8')
)

describe('Build-channel logging', () => {
  it('defines debug logging from an explicit build channel', () => {
    assert.ok(
      viteConfigSource.includes("process.env.BUILD_CHANNEL || 'development'"),
      'local builds must default to the debug-enabled development channel'
    )
    assert.ok(
      viteConfigSource.includes('__DEBUG_LOGS__'),
      'Vite must inject a compile-time debug logging flag'
    )
    assert.ok(
      viteConfigSource.includes("buildChannel !== 'production'"),
      'only production builds may disable debug logging'
    )
  })

  it('removes every console and debugger diagnostic from production bundles', () => {
    assert.match(
      viteConfigSource,
      /drop:\s*debugLogsEnabled\s*\?\s*\[\]\s*:\s*\['console',\s*'debugger'\]/,
      'production builds must remove all console calls and debugger statements'
    )
    assert.ok(viteConfigSource.includes("name: 'strip-production-diagnostic-callbacks'"))
    assert.ok(viteConfigSource.includes('generateBundle(_options, bundle)'))
    assert.match(viteConfigSource, /\.catch\\\(\\s\*console\\\./)
  })

  it('uses the deployed EVM history proxy by default in every build channel', () => {
    for (const channel of ['development', 'beta', 'production']) {
      for (const configured of [undefined, '', '  ']) {
        assert.equal(
          resolveHistoryApiOrigin(configured, channel),
          'https://history-proxy.zknoir.com'
        )
      }
    }
  })

  it('accepts a canonical HTTPS override and local development history proxies', () => {
    assert.equal(
      resolveHistoryApiOrigin(' https://custom-history.example/ ', 'production'),
      'https://custom-history.example'
    )
    assert.equal(
      resolveHistoryApiOrigin('http://localhost:8799/', 'development'),
      'http://localhost:8799'
    )
    assert.equal(
      resolveHistoryApiOrigin('https://custom-history.example/', 'beta'),
      'https://custom-history.example'
    )
  })

  it('rejects credentials, paths, queries and unsafe history proxy origins', () => {
    for (const configured of [
      'not-a-url',
      'http://localhost:8799',
      'http://history.example',
      'https://key@history.example',
      'https://history.example/api',
      'https://history.example?key=private',
      'https://history.example#fragment'
    ]) {
      assert.throws(() => resolveHistoryApiOrigin(configured, 'production'))
    }
    assert.throws(() => resolveHistoryApiOrigin('http://history.example', 'development'))
    assert.throws(() => resolveHistoryApiOrigin('http://localhost:8799', 'beta'))
  })

  it('keeps the upstream history key server-side and rate limits the public proxy', () => {
    assert.ok(historyWorkerSource.includes('ANKR_API_KEYS: string'))
    assert.ok(historyWorkerSource.includes('HISTORY_RATE_LIMITER: RateLimit'))
    assert.ok(historyWorkerSource.includes("request.headers.get('CF-Connecting-IP')"))
    assert.ok(
      historyWorkerConfig.ratelimits.some(binding => binding.name === 'HISTORY_RATE_LIMITER')
    )
    assert.ok(!viteConfigSource.includes('ANKR_API_KEY'))
    assert.ok(!workflowSource.includes('ANKR_API_KEY'))
  })

  it('redacts console and persisted diagnostics while retaining the debug console gate', async () => {
    const entries = []
    const output = []
    const originalInfo = console.info
    let resolveRecorded
    const recorded = new Promise(resolve => {
      resolveRecorded = resolve
    })
    logger.configureDiagnostics(async entry => {
      entries.push(entry)
      resolveRecorded()
    })
    console.info = (...args) => output.push(args)
    try {
      logger.info('password=hunter2 address=u1' + 'a'.repeat(70))
      await recorded
      assert.equal(entries.length, 1)
      assert.doesNotMatch(entries[0].message, /hunter2|u1a{70}/)
      assert.equal(output.length, 1)
      assert.doesNotMatch(output[0].join(' '), /hunter2|u1a{70}/)
    } finally {
      console.info = originalInfo
      logger.configureDiagnostics(null)
    }
  })

  it('keeps Wallet logger cache refresh compatible with the MV3 Service Worker', () => {
    assert.doesNotMatch(
      loggerSource,
      /\bimport\s*\(/,
      'Service Workers must not execute dynamic import()'
    )
    assert.ok(loggerSource.includes('refreshCache(wallets: readonly WalletLogMetadata[])'))
    assert.doesNotMatch(
      zcashWalletRuntimeSource,
      /logger\.refreshCache\(\)/,
      'Background callers must pass the already-loaded Wallet metadata'
    )
    assert.match(zcashWalletRuntimeSource, /logger\.refreshCache\(this\.store\.wallets\)/)
  })

  it('rejects console or debugger code that survives a production build', () => {
    assert.ok(buildSurfaceVerifierSource.includes("process.env.BUILD_CHANNEL === 'production'"))
    assert.ok(buildSurfaceVerifierSource.includes('ts.isDebuggerStatement(node)'))
    assert.ok(buildSurfaceVerifierSource.includes('isConsoleExpression(node.expression)'))
    assert.ok(buildSurfaceVerifierSource.includes('Production build contains diagnostic code'))
  })

  it('keeps generated extension builds in the canonical lifecycle directories', () => {
    const testnetBuildDirectory = "path.posix.join('e2e-dist', 'testnet-build-check')"
    assert.ok(viteConfigSource.includes("? 'dist-dev'"))
    assert.ok(viteConfigSource.includes(testnetBuildDirectory))
    assert.ok(buildSurfaceVerifierSource.includes(testnetBuildDirectory))
    assert.ok(!viteConfigSource.includes("'dist-testnet'"))
    assert.ok(!buildSurfaceVerifierSource.includes("'dist-testnet'"))
    assert.match(
      viteConfigSource,
      /\[Noir Wallet\] Chrome extension directory: \$\{path\.resolve\(__dirname, buildOutDir\)\}/
    )
  })
})
