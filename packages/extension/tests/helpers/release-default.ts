import { chromium, type BrowserContext, type Page, type Route } from '@playwright/test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { keccak256, type Hex } from 'viem'
import {
  captureScreenshot,
  e2eEnabledChainFeatureFlags,
  extensionDir,
  expect,
  mockUnknownZcashAccountHistory,
  selectImportedZcashHistory,
  selectNewZcashAccountHistory,
  test as extensionTest,
  terminateExtensionServiceWorker,
  waitForBackgroundWalletInitialization
} from './extension-fixtures'
import {
  BUILTIN_EVM_NETWORKS as EVM_NETWORK_CONFIGS,
  NEAR_NETWORKS,
  SOLANA_NETWORKS
} from '../../src/config/networks'
import { ASSET_PRICE_SOURCE_ASSETS } from '../../src/config/asset-market-assets'
import { DEFAULT_HISTORY_API_ORIGIN } from '../../scripts/lib/extension-build-config'
import { RPC_REGISTRY } from '../../../rpc-registry/src/registry'
import { findChainEndpointOverride } from '../../src/core/chains/chain-endpoint-settings'
import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions
} from '../../src/core/chains/registry'
import type { ZcashBalance } from '../../src/types'

const TEST_MNEMONIC_12 = `${'abandon '.repeat(11)}about`
const TEST_PASSWORD = 'release-default-password'
const TEST_BETA_INVITE_CODE = 'RELEASE-DEFAULT-INVITE'
const bitcoinEnabled = e2eEnabledChainFeatureFlags.includes('chain.bitcoin')
const solanaEnabled = e2eEnabledChainFeatureFlags.includes('chain.solana')
const nearEnabled = e2eEnabledChainFeatureFlags.includes('chain.near')
const ZCASH_MAINNET_CHAIN_ID = 'bip122:00040fe8ec8471911baa1db1266ea15d'
const ZCASH_TESTNET_CHAIN_ID = 'bip122:05a60a92d99d85997cce3b87616c089f'
const BITCOIN_MAINNET_CHAIN_ID = 'bip122:000000000019d6689c085ae165831e93'
const BITCOIN_TESTNET_CHAIN_ID = 'bip122:000000000933ea01ad0ee984209779ba'
const BUILTIN_EVM_NETWORKS = [
  'Ethereum',
  'BNB Chain',
  'Arbitrum',
  'Base',
  'Optimism',
  'Polygon',
  'Avalanche'
] as const
const CUSTOM_TOKEN_CONTRACT = '0x3333333333333333333333333333333333333333'
const GNOSIS_USDC_CONTRACT = '0x2a22f9c3b484c3629090feed35f17ff8f88f76f0'
const EVM_HISTORY_PROXY_ORIGINS = new Set(['https://evm-history.test', DEFAULT_HISTORY_API_ORIGIN])
const SDK_EXAMPLE_DIST = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../sdk/example/dist'
)
const TEST_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="16" fill="#00d18a"/></svg>'
const PROVIDER_ICON_DATA_URL = `data:image/png;base64,${(
  await readFile(new URL('../../public/icons/icon128.png', import.meta.url))
).toString('base64')}`

const test = extensionTest.extend<{
  readonly offlineRpcRegistry: void
  readonly cleanupHistoryWorkers: void
}>({
  offlineRpcRegistry: [
    async ({ context }, use) => {
      await context.route('https://rpc.zknoir.com/v1/rpc-endpoints?scope=multichain', route =>
        route.abort()
      )
      await mockBetaInviteApi(context)
      await use()
    },
    { auto: true }
  ],
  cleanupHistoryWorkers: [
    async ({ context }, use) => {
      await use()
      await context.unrouteAll({ behavior: 'wait' })
      const runtimes = [...historyWorkerRuntimes]
      historyWorkerRuntimes.clear()
      await Promise.all(runtimes.map(runtime => runtime.dispose()))
    },
    { auto: true }
  ]
})

async function mockBetaInviteApi(context: BrowserContext): Promise<void> {
  const path = `/v1/invite-codes/${encodeURIComponent(TEST_BETA_INVITE_CODE)}`
  await context.route('https://api.zknoir.com/v1/invite-codes/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === `${path}/check` && request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 0, data: { exists: true, bound: false } })
      })
      return
    }
    if (url.pathname === `${path}/bind` && request.method() === 'POST') {
      const body = request.postDataJSON() as { wallet_address?: unknown }
      expect(body.wallet_address).toMatch(/^0x[0-9a-fA-F]{40}$/)
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          data: { code: TEST_BETA_INVITE_CODE, bound: true }
        })
      })
      return
    }
    await route.fulfill({ status: 404, body: 'Unknown invite request' })
  })
}

async function verifyBetaInviteCode(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Enter invite code' })).toBeVisible()
  await page.getByRole('textbox', { name: 'Invite code' }).fill(TEST_BETA_INVITE_CODE)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'Enter invite code' })).toHaveCount(0)
}

async function mockExternalAssetIcons(context: BrowserContext): Promise<void> {
  const fulfillIcon = (route: Route) =>
    route.fulfill({ contentType: 'image/svg+xml', body: TEST_ICON_SVG })
  await context.route('https://assets.zknoir.com/chain/**', fulfillIcon)
  await context.route('https://assets-cdn.trustwallet.com/**', fulfillIcon)
}

async function serveSdkExample(route: import('@playwright/test').Route): Promise<void> {
  const url = new URL(route.request().url())
  const prefix = '/example/'
  const requested = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : ''
  const relativePath = requested || 'index.html'
  if (!/^[a-zA-Z0-9._/-]+$/.test(relativePath) || relativePath.includes('..')) {
    await route.fulfill({ status: 404, body: 'Not found' })
    return
  }
  const filePath = path.resolve(SDK_EXAMPLE_DIST, relativePath)
  if (!filePath.startsWith(`${SDK_EXAMPLE_DIST}${path.sep}`)) {
    await route.fulfill({ status: 404, body: 'Not found' })
    return
  }
  const contentType = filePath.endsWith('.html')
    ? 'text/html'
    : filePath.endsWith('.js')
      ? 'text/javascript'
      : filePath.endsWith('.css')
        ? 'text/css'
        : filePath.endsWith('.svg')
          ? 'image/svg+xml'
          : filePath.endsWith('.png')
            ? 'image/png'
            : filePath.endsWith('.ico')
              ? 'image/x-icon'
              : 'application/octet-stream'
  let body: Buffer | string = await readFile(filePath)
  if (filePath.endsWith('index.html')) {
    const favicon = await readFile(path.join(SDK_EXAMPLE_DIST, 'favicon.ico'))
    body = body
      .toString('utf8')
      .replace(
        'href="/example/favicon.ico"',
        `href="data:image/x-icon;base64,${favicon.toString('base64')}"`
      )
  }
  await route.fulfill({ contentType, body })
}

async function expectDAppTabFavicon(page: Page, extensionPage: Page): Promise<void> {
  await expect
    .poll(() =>
      extensionPage.evaluate(async pageUrl => {
        const tabs = await chrome.tabs.query({})
        return tabs.find(tab => tab.url === pageUrl)?.favIconUrl
      }, page.url())
    )
    .toMatch(/^data:image\/x-icon;base64,/)
}

async function readEvmProviderChainIds(page: Page) {
  return page.evaluate(async () => {
    const provider = (
      window as typeof window & {
        noirwallet: {
          ethereum: {
            chainId: string | null
            request: (input: { method: string }) => Promise<unknown>
          }
        }
      }
    ).noirwallet.ethereum
    return {
      property: provider.chainId,
      request: await provider.request({ method: 'eth_chainId' })
    }
  })
}

async function expectDAppRequestHeader(
  page: Page,
  options: {
    readonly action: string
    readonly domain: string
    readonly pageUrl: string
    readonly hiddenChain?: string
  }
): Promise<void> {
  await expect(
    page.getByTestId('approval-scroll-region').getByText(options.action, { exact: true })
  ).toBeVisible()
  await expect(page.getByRole('heading', { name: options.domain, exact: true })).toBeVisible()
  const requestId = new URL(page.url()).hash.match(/requestId=([^&]+)/)?.[1]
  expect(requestId).toBeTruthy()
  const pendingFavicon = await page.evaluate(async id => {
    const response = await chrome.runtime.sendMessage({
      type: 'GET_PENDING_REQUEST',
      requestId: id
    })
    return {
      favicon: response?.request?.data?.favicon,
      pageUrl: response?.request?.data?.faviconPageUrl
    }
  }, requestId)
  expect(pendingFavicon.favicon).toMatch(/^data:image\/x-icon;base64,/)
  expect(pendingFavicon.pageUrl).toBe(options.pageUrl)
  const favicon = page.getByTestId('dapp-favicon')
  const faviconSource = await favicon.getAttribute('src')
  expect(faviconSource).toBeTruthy()
  const parsedFaviconSource = new URL(faviconSource as string)
  expect(parsedFaviconSource.protocol).toBe('chrome-extension:')
  expect(parsedFaviconSource.pathname).toBe('/_favicon/')
  expect(parsedFaviconSource.searchParams.get('pageUrl')).toBe(options.pageUrl)
  expect(parsedFaviconSource.searchParams.get('size')).toBe('64')
  await expect
    .poll(() => favicon.evaluate(image => (image as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0)
  if (options.hiddenChain) {
    await expect(page.getByText(options.hiddenChain, { exact: true })).toHaveCount(0)
  }
}

async function expectDAppConnectionHeader(
  page: Page,
  options: { readonly domain: string; readonly pageUrl: string; readonly hiddenChain?: string }
): Promise<void> {
  await expectDAppRequestHeader(page, { ...options, action: 'Connect to' })
}

function abiWord(value: number | bigint): string {
  return value.toString(16).padStart(64, '0')
}

function abiString(value: string): string {
  const encoded = Buffer.from(value, 'utf8').toString('hex')
  return `0x${abiWord(32)}${abiWord(encoded.length / 2)}${encoded.padEnd(Math.ceil(encoded.length / 64) * 64, '0')}`
}

async function mockReleasedEvmRpc(
  context: BrowserContext,
  networkMode: 'mainnet' | 'testnet' = 'mainnet',
  options: {
    readonly nativeBalanceRaw?: bigint
    readonly bundledUsdcBalanceRaw?: bigint
  } = {}
): Promise<string[]> {
  const requests: string[] = []
  for (const network of EVM_NETWORK_CONFIGS[networkMode]) {
    const rpcUrl = new URL(network.rpcUrl).href
    let transactionHash: string | null = null
    await context.route(
      url => url.href === rpcUrl,
      async route => {
        const request = route.request().postDataJSON() as {
          id?: unknown
          method?: unknown
          params?: readonly unknown[]
        }
        requests.push(`${network.chainId}:${String(request.method)}`)
        let result: unknown = '0x0'
        if (request.method === 'eth_chainId') {
          result = `0x${network.numericChainId.toString(16)}`
        } else if (request.method === 'eth_getBalance') {
          const nativeBalanceRaw =
            options.nativeBalanceRaw ??
            (network.numericChainId === 137 ? 1_234n * 10n ** 18n : 10n ** 18n)
          result = `0x${nativeBalanceRaw.toString(16)}`
        } else if (request.method === 'eth_getCode') {
          const address = request.params?.[0]
          const bundledUsdc =
            typeof address === 'string' &&
            ((typeof network.usdcContract === 'string' &&
              address.toLowerCase() === network.usdcContract.toLowerCase()) ||
              (network.chainId === 'eip155:100' && address.toLowerCase() === GNOSIS_USDC_CONTRACT))
          result =
            (typeof address === 'string' && address.toLowerCase() === CUSTOM_TOKEN_CONTRACT) ||
            bundledUsdc
              ? '0x60006000'
              : '0x'
        } else if (request.method === 'eth_call') {
          const call = request.params?.[0] as { to?: unknown; data?: unknown } | undefined
          const custom =
            typeof call?.to === 'string' && call.to.toLowerCase() === CUSTOM_TOKEN_CONTRACT
          const bundledUsdc =
            typeof call?.to === 'string' &&
            ((typeof network.usdcContract === 'string' &&
              call.to.toLowerCase() === network.usdcContract.toLowerCase()) ||
              (network.chainId === 'eip155:100' && call.to.toLowerCase() === GNOSIS_USDC_CONTRACT))
          const selector =
            typeof call?.data === 'string' ? call.data.slice(0, 10).toLowerCase() : ''
          result =
            custom && selector === '0x06fdde03'
              ? abiString('Example Token')
              : custom && selector === '0x95d89b41'
                ? abiString('USDC')
                : custom && selector === '0x313ce567'
                  ? `0x${abiWord(18)}`
                  : custom && selector === '0x70a08231'
                    ? `0x${abiWord(10n ** 18n)}`
                    : bundledUsdc && selector === '0x06fdde03'
                      ? abiString('USD Coin')
                      : bundledUsdc && selector === '0x95d89b41'
                        ? abiString('USDC')
                        : bundledUsdc && selector === '0x313ce567'
                          ? `0x${abiWord(6)}`
                          : bundledUsdc && selector === '0x70a08231'
                            ? `0x${abiWord(options.bundledUsdcBalanceRaw ?? 1n)}`
                            : custom && selector === '0xa9059cbb'
                              ? `0x${abiWord(1)}`
                              : `0x${abiWord(0)}`
        } else if (request.method === 'eth_getTransactionCount') {
          result = '0x0'
        } else if (request.method === 'eth_estimateGas') {
          result = '0x11170'
        } else if (request.method === 'eth_maxPriorityFeePerGas') {
          result = '0x3b9aca00'
        } else if (request.method === 'eth_getBlockByNumber') {
          result = { number: '0x101', baseFeePerGas: '0x3b9aca00' }
        } else if (request.method === 'eth_sendRawTransaction') {
          const rawTransaction = request.params?.[0]
          if (typeof rawTransaction !== 'string' || !/^0x[0-9a-f]+$/.test(rawTransaction)) {
            throw new Error('Expected a canonical signed EVM transaction')
          }
          transactionHash = keccak256(rawTransaction as Hex)
          result = transactionHash
        } else if (request.method === 'eth_getTransactionByHash') {
          const requestedHash = request.params?.[0]
          result =
            typeof requestedHash === 'string' && requestedHash === transactionHash
              ? {
                  hash: requestedHash,
                  blockHash: `0x${'b'.repeat(64)}`,
                  blockNumber: '0x100'
                }
              : null
        } else if (request.method === 'eth_getTransactionReceipt') {
          const requestedHash = request.params?.[0]
          result =
            typeof requestedHash === 'string' && requestedHash === transactionHash
              ? {
                  transactionHash: requestedHash,
                  blockHash: `0x${'b'.repeat(64)}`,
                  blockNumber: '0x100',
                  status: '0x1'
                }
              : null
        }
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ jsonrpc: '2.0', id: request.id, result })
        })
      }
    )
  }
  await mockReleasedSolanaNearRpc(context, networkMode)
  return requests
}

async function mockReleasedSolanaNearRpc(
  context: BrowserContext,
  networkMode: 'mainnet' | 'testnet'
): Promise<void> {
  const solana = networkMode === 'mainnet' ? SOLANA_NETWORKS.mainnet : SOLANA_NETWORKS.devnet
  await context.route(
    url => url.href === new URL(solana.rpcUrl).href,
    async route => {
      const request = route.request().postDataJSON() as { id?: unknown; method?: unknown }
      const result =
        request.method === 'getGenesisHash'
          ? solana.genesisHash
          : request.method === 'getBlockHeight'
            ? 1_000
            : request.method === 'getLatestBlockhash'
              ? {
                  context: { slot: 123 },
                  value: { blockhash: solana.genesisHash, lastValidBlockHeight: 1_100 }
                }
              : request.method === 'getBalance'
                ? { context: { slot: 123 }, value: 0 }
                : request.method === 'getMultipleAccounts'
                  ? {
                      context: { slot: 123 },
                      value: Array.isArray(
                        (request as { params?: readonly [readonly unknown[]] }).params?.[0]
                      )
                        ? (request as { params: readonly [readonly unknown[]] }).params[0].map(
                            () => null
                          )
                        : []
                    }
                  : request.method === 'getTokenAccountsByOwner'
                    ? { context: { slot: 123 }, value: [] }
                    : request.method === 'getSignaturesForAddress'
                      ? []
                      : null
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: request.id, result })
      })
    }
  )

  if (networkMode === 'mainnet') {
    await context.route('https://transfers.main.fastnear.com/v0/transfers', route =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ resume_token: null, transfers: [] })
      })
    )
    await context.route('https://api.fastnear.com/v0/public_key/**', route =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ account_ids: [] })
      })
    )
    await context.route('https://api.fastnear.com/v1/account/**/ft', async route => {
      const accountId = decodeURIComponent(
        new URL(route.request().url()).pathname.split('/').at(-2)!
      )
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ account_id: accountId, tokens: [] })
      })
    })
  }

  const near = NEAR_NETWORKS[networkMode]
  await context.route(
    url => url.href === new URL(near.rpcUrl).href,
    async route => {
      const request = route.request().postDataJSON() as {
        id?: unknown
        method?: unknown
        params?: Record<string, unknown>
      }
      let result: unknown = null
      if (request.method === 'status') {
        result = { chain_id: near.network, sync_info: { latest_block_hash: near.genesisHash } }
      } else if (request.method === 'genesis_config') {
        result = {
          chain_id: near.network,
          genesis_height: near.genesisHeight,
          genesis_time: near.genesisTime
        }
      } else if (request.method === 'block') {
        result = {
          header: {
            height: near.genesisHeight,
            hash: near.genesisHash
          }
        }
      } else if (request.method === 'query' && request.params?.request_type === 'view_account') {
        result = {
          amount: '0',
          locked: '0',
          storage_usage: 0,
          code_hash: '11111111111111111111111111111111',
          block_hash: near.genesisHash,
          block_height: near.genesisHeight
        }
      } else if (request.method === 'query' && request.params?.request_type === 'view_access_key') {
        result = {
          nonce: 1,
          permission: 'FullAccess',
          block_hash: near.genesisHash,
          block_height: near.genesisHeight
        }
      } else if (
        request.method === 'query' &&
        request.params?.request_type === 'call_function' &&
        request.params.method_name === 'ft_balance_of'
      ) {
        result = {
          block_hash: near.genesisHash,
          block_height: near.genesisHeight,
          logs: [],
          result: [...new TextEncoder().encode('"0"')]
        }
      }
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: request.id, result })
      })
    }
  )
}

interface HistoryProxyRequest {
  readonly method: string
  readonly address: string
  readonly blockchains: readonly string[]
}

const historyWorkerRuntimes = new Set<{ dispose(): Promise<void> }>()

async function mockEvmHistoryProxy(
  context: BrowserContext,
  responseDelayMs = 0,
  crowdedSharedPage = false,
  collidingChainHashes = false
): Promise<HistoryProxyRequest[]> {
  const requests: HistoryProxyRequest[] = []
  // Exercise the production Worker in workerd; only the authenticated Ankr upstream is simulated.
  const workerRequire = createRequire(
    new URL('../../../evm-history-worker/package.json', import.meta.url)
  )
  const wranglerRequire = createRequire(workerRequire.resolve('wrangler'))
  const {
    Miniflare,
    convertV4MiniflareOptions,
    Response: RuntimeResponse
  } = wranglerRequire('miniflare')
  const { build } = wranglerRequire('esbuild')
  const { outputFiles } = await build({
    entryPoints: [
      fileURLToPath(new URL('../../../evm-history-worker/src/index.ts', import.meta.url))
    ],
    bundle: true,
    write: false,
    format: 'esm',
    target: 'es2022'
  })
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: outputFiles[0].text,
      compatibilityDate: '2026-08-01',
      bindings: { ANKR_API_KEYS: 'mv3-test-key', ALLOWED_ORIGIN: '*' },
      ratelimits: {
        HISTORY_RATE_LIMITER: { namespace_id: '1', simple: { limit: 120, period: 60 } }
      },
      outboundService: async (request: Request) => {
        if (responseDelayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, responseDelayMs))
        }
        expect(new URL(request.url).hostname).toBe('rpc.ankr.com')
        expect(request.method).toBe('POST')
        const body = (await request.json()) as {
          id: number | string
          jsonrpc: string
          method: string
          params: { address: string | string[]; blockchain: string[] }
        }
        expect(body.jsonrpc).toBe('2.0')
        const address = Array.isArray(body.params.address)
          ? body.params.address[0]
          : body.params.address
        requests.push({ method: body.method, address, blockchains: body.params.blockchain })
        if (
          body.method === 'ankr_getTransactionsByAddress' &&
          (body.params.blockchain.includes('eth') ||
            (crowdedSharedPage &&
              body.params.blockchain.length === 1 &&
              body.params.blockchain[0] === 'base'))
        ) {
          const transaction = (suffix: string, value: string, timestamp: string) => ({
            blockchain: body.params.blockchain.includes('eth') ? 'eth' : 'base',
            blockNumber: '0xfa',
            timestamp: `0x${BigInt(timestamp).toString(16)}`,
            hash: `0x${suffix.repeat(64)}`,
            nonce: suffix === 'a' ? '0x1' : '0x2',
            blockHash: `0x${'c'.repeat(64)}`,
            from: '0x2222222222222222222222222222222222222222',
            to: address,
            value: `0x${BigInt(value).toString(16)}`,
            gasPrice: '0x3b9aca00',
            gasUsed: '0x5208',
            gas: '0x5208',
            cumulativeGasUsed: '0x5208',
            transactionIndex: '0x0',
            input: '0x',
            status: '0x1'
          })
          return new RuntimeResponse(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: {
                transactions: body.params.blockchain.includes('eth')
                  ? [
                      transaction('a', '5871510000000000', '1760000000'),
                      transaction('b', '1', '1750000000')
                    ]
                  : [
                      transaction(
                        collidingChainHashes ? 'a' : 'f',
                        '1000000000000000',
                        '1755000000'
                      )
                    ],
                ...(crowdedSharedPage && body.params.blockchain.length > 1
                  ? { nextPageToken: 'more-ethereum-history' }
                  : {})
              }
            }),
            { headers: { 'Content-Type': 'application/json' } }
          )
        }
        return new RuntimeResponse(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result:
              body.method === 'ankr_getTokenTransfers' ? { transfers: [] } : { transactions: [] }
          }),
          { headers: { 'Content-Type': 'application/json' } }
        )
      }
    })
  )
  historyWorkerRuntimes.add(runtime)
  await context.route(
    url => EVM_HISTORY_PROXY_ORIGINS.has(url.origin) && url.pathname === '/',
    async route => {
      const response = await runtime.dispatchFetch('http://history-worker.local/', {
        method: route.request().method(),
        headers: { 'Content-Type': 'application/json' },
        body: route.request().postData()
      })
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.text()
      })
    }
  )
  return requests
}

async function mockReleasedBitcoinEsplora(context: BrowserContext): Promise<string[]> {
  const requests: string[] = []
  let delayedFirstHistoryRequest = false
  const emptyStats = {
    tx_count: 0,
    funded_txo_count: 0,
    funded_txo_sum: 0,
    spent_txo_count: 0,
    spent_txo_sum: 0
  }
  for (const origin of ['https://mempool.space/api/', 'https://blockstream.info/api/']) {
    await context.route(`${origin}**`, async route => {
      const url = new URL(route.request().url())
      const basePath = new URL(origin).pathname
      const path = url.pathname.slice(basePath.length)
      requests.push(`${url.origin}${basePath}${path}`)
      if (path === 'block-height/0') {
        await route.fulfill({
          contentType: 'text/plain',
          body: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f'
        })
        return
      }
      if (path === 'blocks/tip/height') {
        await route.fulfill({ contentType: 'text/plain', body: '900000' })
        return
      }
      const addressMatch = /^address\/([^/]+)$/.exec(path)
      if (addressMatch) {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            address: decodeURIComponent(addressMatch[1]),
            chain_stats: emptyStats,
            mempool_stats: emptyStats
          })
        })
        return
      }
      if (/^address\/[^/]+\/txs$/.test(path) && !delayedFirstHistoryRequest) {
        delayedFirstHistoryRequest = true
        await new Promise(resolve => setTimeout(resolve, 350))
      }
      if (/^address\/[^/]+\/utxo$/.test(path) || /^address\/[^/]+\/txs$/.test(path)) {
        await route.fulfill({ contentType: 'application/json', body: '[]' })
        return
      }
      await route.abort()
    })
  }
  return requests
}

async function mockAssetMarketHistory(context: BrowserContext): Promise<string[]> {
  const requests: string[] = []
  await context.route('https://api.geckoterminal.com/**', async route => {
    const url = new URL(route.request().url())
    requests.push(url.href)
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 24), 90)
    const now = Date.parse('2026-08-18T08:00:00.000Z') / 1_000
    const ohlcvList = Array.from({ length: limit }, (_, index) => {
      const price = 3_100 + index * 4 + Math.sin(index / 2) * 18
      return [now - index * 60 * 60, price - 2, price + 3, price - 4, price, 1_000 + index]
    })
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: { attributes: { ohlcv_list: ohlcvList } } })
    })
  })
  await context.route('https://pro-api.coinmarketcap.com/**', async route => {
    const url = new URL(route.request().url())
    requests.push(url.href)
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 24), 60)
    const now = Date.parse('2026-08-18T08:00:00.000Z')
    const data = Array.from({ length: limit }, (_, index) => [
      3_100 + index * 4 + Math.sin(index / 2) * 18,
      1_000 + index,
      now - (limit - index) * 60 * 60 * 1_000
    ])
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ status: { error_code: '0' }, data })
    })
  })
  return requests
}

async function importTestWallet(page: Page): Promise<void> {
  await verifyBetaInviteCode(page)
  await page.getByRole('button', { name: 'Import wallet' }).click()
  await page.getByRole('radio', { name: '12 words' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.locator('input[type="text"]').first().fill(TEST_MNEMONIC_12)
  await page.getByRole('button', { name: 'Continue' }).click()
  await selectImportedZcashHistory(page, { birthdayHeight: 3_000_000 })
  await page.getByPlaceholder('8–64 characters').fill(TEST_PASSWORD)
  await page.getByPlaceholder('Confirm password').fill(TEST_PASSWORD)
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Import Wallet' }).click()
  await expect(page.getByRole('heading', { name: 'Congratulations!' })).toBeVisible({
    timeout: 60_000
  })
  await page.getByRole('button', { name: 'Got it' }).click()
}

async function seedFreshAssetPrices(page: Page): Promise<void> {
  const fetchedAt = Date.now()
  const pricesBySymbol: Readonly<Record<string, string>> = Object.freeze({
    ZEC: '42.75',
    ETH: '3200',
    USDC: '1',
    BNB: '585',
    POL: '0.24',
    AVAX: '21.5',
    MON: '0.05',
    xDAI: '1',
    XPL: '0.3',
    OKB: '200',
    BERA: '2.1',
    BTC: '63014',
    SOL: '145',
    NEAR: '5.25'
  })
  const releaseAssets = createAssetRegistry(
    createInitialProductChainRegistry('mainnet'),
    getBundledInitialProductAssetDefinitions('mainnet')
  )
  const assetQuotes = releaseAssets.list().map(entry => ({
    assetId: entry.asset.id,
    priceUsd: pricesBySymbol[entry.metadata.symbol],
    sourceUpdatedAt: fetchedAt
  }))
  if (assetQuotes.some(quote => quote.priceUsd === undefined)) {
    throw new Error('Release screenshot price fixture is incomplete')
  }
  await page.evaluate(
    ({ quotes, timestamp }) =>
      chrome.storage.local.set({
        asset_price_cache_v1: {
          version: 1,
          fetchedAt: timestamp,
          quotes
        },
        asset_market_change_cache_v1: {
          version: 1,
          fetchedAt: timestamp,
          quotes: [
            {
              marketAssetId: 'zcash',
              percent24h: '-0.35',
              observedPriceUsd: '42.75',
              fetchedAt: timestamp
            },
            {
              marketAssetId: 'ethereum',
              percent24h: '0.42',
              observedPriceUsd: '3200',
              fetchedAt: timestamp
            },
            {
              marketAssetId: 'bnb',
              percent24h: '0.18',
              observedPriceUsd: '585',
              fetchedAt: timestamp
            },
            {
              marketAssetId: 'polygon-ecosystem-token',
              percent24h: '-0.24',
              observedPriceUsd: '0.24',
              fetchedAt: timestamp
            },
            {
              marketAssetId: 'avalanche',
              percent24h: '0.65',
              observedPriceUsd: '21.5',
              fetchedAt: timestamp
            },
            {
              marketAssetId: 'bitcoin',
              percent24h: '1.25',
              observedPriceUsd: '63014',
              fetchedAt: timestamp
            }
          ]
        }
      }),
    { quotes: assetQuotes, timestamp: fetchedAt }
  )
}

async function seedSettledZcashBalance(page: Page, balance: ZcashBalance): Promise<void> {
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'ABORT_SYNC' }))
  await expect
    .poll(async () => {
      const state = (await page.evaluate(() =>
        chrome.runtime.sendMessage({ type: 'GET_SYNC_STATE' })
      )) as { isSyncing?: boolean }
      return state.isSyncing
    })
    .toBe(false)

  await page.evaluate(async accountBalance => {
    const local = await chrome.storage.local.get(['wallet_state', 'account_data'])
    const walletState =
      typeof local.wallet_state === 'string' ? JSON.parse(local.wallet_state) : local.wallet_state
    const accountData =
      typeof local.account_data === 'string' ? JSON.parse(local.account_data) : local.account_data
    const walletId = walletState?.state?.currentWalletId
    const accountId = walletState?.state?.currentAccountId
    if (typeof walletId !== 'string' || typeof accountId !== 'string') {
      throw new Error('Active Wallet fixture is missing')
    }
    const accountKey = `mainnet_${walletId}_${accountId}`
    const walletKey = `mainnet_${walletId}`
    const next = {
      ...(accountData ?? {}),
      state: {
        ...(accountData?.state ?? {}),
        balances: { ...(accountData?.state?.balances ?? {}), [accountKey]: accountBalance },
        syncStates: {
          ...(accountData?.state?.syncStates ?? {}),
          [walletKey]: {
            isSyncing: false,
            syncProgress: 100,
            currentHeight: 3_000_000,
            latestHeight: 3_000_000,
            lastSyncTime: Date.now(),
            etaMs: null,
            syncReason: null
          }
        }
      }
    }
    await chrome.storage.local.set({
      account_data: typeof local.account_data === 'string' ? JSON.stringify(next) : next
    })
  }, balance)
}

async function expectPopupWidth(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => ({
        viewportWidth: document.documentElement.clientWidth,
        contentWidth: document.documentElement.scrollWidth
      }))
    )
    .toEqual({ viewportWidth: 375, contentWidth: 375 })
}

async function expectVisibleImagesLoaded(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.locator('img:visible').evaluateAll(images =>
        images.flatMap(image => {
          const icon = image as HTMLImageElement
          return icon.complete && icon.naturalWidth > 0
            ? []
            : [{ alt: icon.alt, src: icon.src, naturalWidth: icon.naturalWidth }]
        })
      )
    )
    .toEqual([])
}

async function readLocalTransactions(page: Page, accountKey: string): Promise<unknown[]> {
  return page.evaluate(
    key =>
      new Promise<unknown[]>((resolve, reject) => {
        const request = indexedDB.open('zcash-wallet-db')
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const database = request.result
          const transaction = database.transaction('transactions', 'readonly')
          const stored = transaction.objectStore('transactions').get(key)
          stored.onerror = () => reject(stored.error)
          stored.onsuccess = () => resolve(Array.isArray(stored.result) ? stored.result : [])
          transaction.oncomplete = () => database.close()
        }
      }),
    accountKey
  )
}

async function readPersistedEndpointModes(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const raw = (await chrome.storage.local.get('wallet_settings')).wallet_settings
    const state = typeof raw === 'string' ? JSON.parse(raw).state : raw?.state
    return Object.keys(state?.chainEndpointSettingsByNetwork ?? {}).sort()
  })
}

async function mockCustomRpcEndpoints(context: BrowserContext): Promise<string[]> {
  const requests: string[] = []
  await context.route('https://endpoint-release.noir.test/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    requests.push(`${request.method()} ${url.pathname}`)
    if (url.pathname.endsWith('/bitcoin/block-height/0')) {
      await route.fulfill({
        status: 200,
        contentType: 'text/plain',
        body: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f'
      })
      return
    }
    if (['/ethereum', '/arbitrum', '/arbitrum-wrong'].includes(url.pathname)) {
      const payload = request.postDataJSON() as { id?: unknown; method?: unknown }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          result: url.pathname === '/arbitrum' ? '0xa4b1' : '0x1'
        })
      })
      return
    }
    if (url.pathname.endsWith('/GetLightdInfo')) {
      const name = Buffer.from(url.pathname.startsWith('/zcash-wrong/') ? 'test' : 'main')
      const protobuf = Buffer.concat([Buffer.from([0x22, name.length]), name])
      const header = Buffer.alloc(5)
      header.writeUInt32BE(protobuf.length, 1)
      await route.fulfill({
        status: 200,
        contentType: 'application/grpc-web+proto',
        body: Buffer.concat([header, protobuf])
      })
      return
    }
    if (url.pathname === '/solana') {
      const payload = request.postDataJSON() as { id?: unknown; method?: unknown }
      const result =
        payload.method === 'getBlockHeight'
          ? 100
          : payload.method === 'getLatestBlockhash'
            ? {
                context: { slot: 120 },
                value: {
                  blockhash: SOLANA_NETWORKS.mainnet.genesisHash,
                  lastValidBlockHeight: 250
                }
              }
            : SOLANA_NETWORKS.mainnet.genesisHash
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          result
        })
      })
      return
    }
    if (url.pathname === '/near') {
      const payload = request.postDataJSON() as {
        id?: unknown
        method?: unknown
        params?: { block_id?: unknown }
      }
      const result =
        payload.method === 'status'
          ? {
              chain_id: 'mainnet',
              sync_info: { latest_block_hash: NEAR_NETWORKS.mainnet.genesisHash }
            }
          : payload.method === 'genesis_config'
            ? {
                chain_id: 'mainnet',
                genesis_height: NEAR_NETWORKS.mainnet.genesisHeight,
                genesis_time: NEAR_NETWORKS.mainnet.genesisTime
              }
            : payload.method === 'block' &&
                payload.params?.block_id === NEAR_NETWORKS.mainnet.genesisHeight
              ? {
                  header: {
                    height: NEAR_NETWORKS.mainnet.genesisHeight,
                    hash: NEAR_NETWORKS.mainnet.genesisHash
                  }
                }
              : null
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: payload.id, result })
      })
      return
    }
    await route.abort()
  })
  return requests
}

async function openExtensionPopup(context: BrowserContext): Promise<{
  readonly extensionId: string
  readonly popup: Page
}> {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  const extensionId = new URL(worker.url()).host
  const popup = await context.newPage()
  await popup.setViewportSize({ width: 375, height: 600 })
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  return { extensionId, popup }
}

export {
  ASSET_PRICE_SOURCE_ASSETS,
  BITCOIN_MAINNET_CHAIN_ID,
  BITCOIN_TESTNET_CHAIN_ID,
  BUILTIN_EVM_NETWORKS,
  CUSTOM_TOKEN_CONTRACT,
  EVM_HISTORY_PROXY_ORIGINS,
  EVM_NETWORK_CONFIGS,
  GNOSIS_USDC_CONTRACT,
  NEAR_NETWORKS,
  PROVIDER_ICON_DATA_URL,
  RPC_REGISTRY,
  SOLANA_NETWORKS,
  TEST_ICON_SVG,
  TEST_PASSWORD,
  ZCASH_MAINNET_CHAIN_ID,
  ZCASH_TESTNET_CHAIN_ID,
  bitcoinEnabled,
  captureScreenshot,
  chromium,
  expect,
  expectDAppConnectionHeader,
  expectDAppRequestHeader,
  expectDAppTabFavicon,
  expectPopupWidth,
  expectVisibleImagesLoaded,
  extensionDir,
  findChainEndpointOverride,
  importTestWallet,
  mkdtemp,
  mockAssetMarketHistory,
  mockBetaInviteApi,
  mockCustomRpcEndpoints,
  mockEvmHistoryProxy,
  mockExternalAssetIcons,
  mockReleasedBitcoinEsplora,
  mockReleasedEvmRpc,
  mockUnknownZcashAccountHistory,
  nearEnabled,
  openExtensionPopup,
  path,
  readEvmProviderChainIds,
  readLocalTransactions,
  readPersistedEndpointModes,
  rm,
  seedFreshAssetPrices,
  seedSettledZcashBalance,
  selectNewZcashAccountHistory,
  serveSdkExample,
  solanaEnabled,
  terminateExtensionServiceWorker,
  test,
  tmpdir,
  waitForBackgroundWalletInitialization
}
export type { BrowserContext, Route }
