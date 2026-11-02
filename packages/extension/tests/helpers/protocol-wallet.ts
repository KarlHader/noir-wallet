import * as secp256k1 from '@bitcoinerlab/secp256k1'
import type { BrowserContext, Page, Route } from '@playwright/test'
import { networks, payments } from 'bitcoinjs-lib'
import { Buffer } from 'buffer'
import { keccak256, parseTransaction, type Hex } from 'viem'
import { DEFAULT_HISTORY_API_ORIGIN } from '../../scripts/lib/extension-build-config'
import { NEAR_NETWORKS } from '../../src/config/networks'
import {
  captureScreenshot,
  e2eEnabledChainFeatureFlags,
  expect,
  selectImportedZcashHistory,
  test,
  waitForBackgroundWalletInitialization
} from './extension-fixtures'

const TEST_MNEMONIC_24 = `${'abandon '.repeat(23)}art`
const TEST_PASSWORD = 'protocol-wallet-source-password'
const TEST_BETA_INVITE_CODE = 'PROTOCOL-WALLET-SOURCE-INVITE'
const ETH_ASSET = 'nep141:eth.omft.near'
const USDC_ASSET = 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near'
const POL_ASSET = 'nep245:v2_1.omni.hot.tg:137_11111111111111111111'
const BNB_ASSET = 'nep245:v2_1.omni.hot.tg:56_11111111111111111111'
const POLYGON_USDC_ASSET = 'nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L'
const POLYGON_USDC_CONTRACT = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'
const BASE_USDC_ASSET = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near'
const BASE_USDC_CONTRACT = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const ETHEREUM_USDC_CONTRACT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const BTC_ASSET = 'nep141:btc.omft.near'
const NEAR_ASSET = 'nep141:wrap.near'
const ZEC_ASSET = 'nep141:zec.omft.near'
const TRIAL_ASSET = 'nep141:trial-eth.omft.near'
const TRIAL_CONTRACT = `0x${'7'.repeat(40)}`
const MAINNET_GENESIS = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f'
const EVM_RPC_NETWORKS = Object.freeze([
  Object.freeze({ url: 'https://eth.deltarpc.com/**', chainId: '0x1' }),
  Object.freeze({ url: 'https://bsc-dataseed.bnbchain.org/**', chainId: '0x38' }),
  Object.freeze({ url: 'https://arbitrum.drpc.org/**', chainId: '0xa4b1' }),
  Object.freeze({ url: 'https://mainnet.base.org/**', chainId: '0x2105' }),
  Object.freeze({ url: 'https://mainnet.optimism.io/**', chainId: '0xa' }),
  Object.freeze({ url: 'https://polygon.drpc.org/**', chainId: '0x89' }),
  Object.freeze({ url: 'https://api.avax.network/ext/bc/C/rpc/**', chainId: '0xa86a' }),
  Object.freeze({ url: 'https://rpc.monad.xyz/**', chainId: '0x8f' }),
  Object.freeze({ url: 'https://rpc.gnosischain.com/**', chainId: '0x64' }),
  Object.freeze({ url: 'https://rpc.plasma.to/**', chainId: '0x2611' }),
  Object.freeze({ url: 'https://rpc.xlayer.tech/**', chainId: '0xc4' }),
  Object.freeze({ url: 'https://rpc.berachain.com/**', chainId: '0x138de' })
])
const EVM_HISTORY_URLS = [
  'https://eth.blockscout.com/api/**',
  'https://arbitrum.blockscout.com/api/**',
  'https://base.blockscout.com/api/**',
  'https://explorer.optimism.io/api/**',
  'https://polygon.blockscout.com/api/**',
  'https://gnosis.blockscout.com/api/**'
] as const
const EVM_HISTORY_PROXY_ORIGINS = new Set([DEFAULT_HISTORY_API_ORIGIN, 'https://evm-history.test'])
const MEMPOOL_URL = 'https://mempool.space/api/**'
const BLOCKSTREAM_URL = 'https://blockstream.info/api/**'
const EMZY_URL = 'https://mempool.emzy.de/api/**'
const TOKEN_LIST_URL = 'https://1click.chaindefuser.com/v0/tokens'
const COINGECKO_MARKETS_URL = 'https://api.coingecko.com/api/v3/coins/markets**'
const QUOTE_URL = 'https://api.rhea.finance/api/swap/quote'
const BUILD_SWAP_URL = 'https://api.rhea.finance/api/swap/swap'
const REPORT_SWAP_URL = 'https://api.rhea.finance/api/swap/report'
const ORDER_STATUS_URL = 'https://api.rhea.finance/api/swap/order-status'
const LENDING_QUOTE_URL = 'https://api.rhea.finance/api/1click/quote'
const CONFIDENTIAL_API_URL = 'https://1click.chaindefuser.com/v0'
const CONFIDENTIAL_BALANCES_URL = 'https://1click.chaindefuser.com/v0/account/balances'
const LENDING_METADATA_URL = 'https://api.rhea.finance/list-burrow-asset-token'
const NEAR_RPC_URLS = [
  'https://free.rpc.fastnear.com/**',
  'https://nearinner.deltarpc.com/**'
] as const
const UTXO_TRANSACTION_ID = 'b'.repeat(64)
const UTXO_VALUE_SATS = 100_000
const POL_WALLET_ASSET = 'eip155:137/slip44:966'
const POLYGON_USDC_WALLET_ASSET = 'eip155:137/erc20:0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'
const USDC_BALANCE_RAW = 10_000_000n
const MOCK_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="16" fill="#00d18a"/></svg>'
const inviteBindAddresses = new WeakMap<BrowserContext, string>()
const bitcoinEnabled = e2eEnabledChainFeatureFlags.includes('chain.bitcoin')
export function registerProtocolFixtures() {
  test.beforeEach(async ({ context }) => {
    const fulfillIcon = (route: Route) =>
      route.fulfill({ contentType: 'image/svg+xml', body: MOCK_ICON_SVG })
    await context.route('https://assets.zknoir.com/**', fulfillIcon)
    await context.route('https://assets-cdn.trustwallet.com/**', fulfillIcon)
    await context.route('https://coin-images.coingecko.com/**', fulfillIcon)
    const invitePath = `/v1/invite-codes/${encodeURIComponent(TEST_BETA_INVITE_CODE)}`
    await context.route('https://api.zknoir.com/v1/invite-codes/**', async route => {
      const request = route.request()
      const url = new URL(request.url())
      if (request.method() === 'GET' && url.pathname === `${invitePath}/check`) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ code: 0, data: { exists: true, bound: false } })
        })
        return
      }
      if (request.method() === 'POST' && url.pathname === `${invitePath}/bind`) {
        const body = request.postDataJSON() as { wallet_address?: unknown }
        expect(body.wallet_address).toMatch(/^0x[0-9a-fA-F]{40}$/)
        inviteBindAddresses.set(context, body.wallet_address as string)
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ code: 0, data: { code: TEST_BETA_INVITE_CODE, bound: true } })
        })
        return
      }
      throw new Error('Unexpected invite API request')
    })
  })
}

function p2wpkhAddress(privateKeyDigit: number): string {
  const privateKey = Buffer.alloc(32)
  privateKey[31] = privateKeyDigit
  const publicKey = Buffer.from(secp256k1.pointFromScalar(privateKey, true))
  const address = payments.p2wpkh({ pubkey: publicKey, network: networks.bitcoin }).address
  if (!address) throw new Error('Unable to derive Bitcoin test address')
  return address
}

const BITCOIN_DEPOSIT_ADDRESS = p2wpkhAddress(2)

async function importTestWallet(page: Page): Promise<void> {
  const activation = await page.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'GET_BETA_INVITE_ACTIVATION' })
  )
  if (typeof activation?.result?.required !== 'boolean') {
    throw new Error('Invite activation status is unavailable')
  }
  if (activation.result.required && activation.result.state?.phase === 'unverified') {
    await expect(page.getByRole('heading', { name: 'Enter invite code' })).toBeVisible()
    await page.getByRole('textbox', { name: 'Invite code' }).fill(TEST_BETA_INVITE_CODE)
    await page.getByRole('button', { name: 'Continue' }).click()
  }
  await page.getByRole('button', { name: 'Import wallet' }).click()
  await page.getByRole('radio', { name: '24 words' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.locator('input[type="text"]').first().fill(TEST_MNEMONIC_24)
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
  if (!activation.result.required) return
  await expect
    .poll(async () => {
      const response = await page.evaluate(() =>
        chrome.runtime.sendMessage({ type: 'GET_BETA_INVITE_ACTIVATION' })
      )
      return response?.result?.state?.phase
    })
    .toBe('activated')
  const boundAddress = inviteBindAddresses.get(page.context())
  expect(boundAddress).toMatch(/^0x[0-9a-fA-F]{40}$/)
  const accountAddress = await page.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })
    const active = response?.result?.accounts?.find(
      (account: { active?: unknown }) => account.active === true
    )
    const evm = active?.networks?.find(
      (network: { chainId?: unknown }) => network.chainId === 'eip155:1'
    )
    return evm?.addresses?.find(
      (address: { preferredForReceive?: unknown }) => address.preferredForReceive === true
    )?.value
  })
  expect(boundAddress?.toLowerCase()).toBe(accountAddress?.toLowerCase())
}

async function connectEvmDApp(
  context: BrowserContext
): Promise<Readonly<{ page: Page; address: string }>> {
  await context.route('https://private-defi.example/**', route =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><title>Private DeFi</title></head><body>Private DeFi</body></html>'
    })
  )
  const page = await context.newPage()
  await page.goto('https://private-defi.example/connect')
  await page.waitForFunction(() => {
    const target = window as typeof window & {
      noirwallet?: { ethereum?: { isNoirWallet?: boolean } }
    }
    return target.noirwallet?.ethereum?.isNoirWallet === true
  })

  const approvalPromise = context.waitForEvent('page')
  const accountsPromise = page.evaluate(() => {
    const provider = (
      window as typeof window & {
        noirwallet: {
          ethereum: {
            request: (input: { method: string; params?: unknown[] }) => Promise<unknown>
          }
        }
      }
    ).noirwallet.ethereum
    return provider.request({ method: 'eth_requestAccounts' })
  })
  const approval = await approvalPromise
  await approval.waitForURL(/#approval\?requestId=/)
  await approval.setViewportSize({ width: 375, height: 632 })
  await approval.getByRole('button', { name: 'Connect', exact: true }).click()
  const accounts = (await accountsPromise) as string[]
  if (!approval.isClosed()) await approval.close()
  expect(accounts).toEqual([expect.stringMatching(/^0x[0-9a-f]{40}$/)])
  return Object.freeze({ page, address: accounts[0] })
}

async function readEvmAccounts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const provider = (
      window as typeof window & {
        noirwallet: {
          ethereum: {
            request: (input: { method: string; params?: unknown[] }) => Promise<unknown>
          }
        }
      }
    ).noirwallet.ethereum
    return provider.request({ method: 'eth_accounts' }) as Promise<string[]>
  })
}

async function readPersistedSwapSource(page: Page): Promise<string | undefined> {
  return page.evaluate(async () => {
    const stored = await chrome.storage.local.get(['wallet_state', 'swap_preferences'])
    const walletState =
      typeof stored.wallet_state === 'string'
        ? JSON.parse(stored.wallet_state).state
        : stored.wallet_state?.state
    const swapState =
      typeof stored.swap_preferences === 'string'
        ? JSON.parse(stored.swap_preferences).state
        : stored.swap_preferences?.state
    const scope = `${walletState?.currentWalletId}:${walletState?.currentAccountId}`
    return swapState?.tokenSelections?.[scope]?.tokenInId
  })
}

interface MockEvmNetworkState {
  readonly getBroadcastCount: () => number
  readonly getRpcRequestCount: () => number
  readonly getBroadcastHashes: () => readonly string[]
  readonly getBroadcastRawTransactions: () => readonly string[]
  readonly getBroadcastValues: () => readonly bigint[]
  readonly setAddressBalanceRaw: (address: string, balanceRaw: bigint) => void
  readonly getContractGasEstimateCount: () => number
}

async function mockEvmNetwork(
  context: BrowserContext,
  options: {
    readonly allowBroadcast?: boolean
    readonly pendingBroadcast?: boolean
    readonly contractGas?: string
    readonly balanceRaw?: bigint
  } = {}
): Promise<MockEvmNetworkState> {
  let broadcastCount = 0
  let rpcRequestCount = 0
  let contractGasEstimateCount = 0
  const broadcastHashes: string[] = []
  const broadcastRawTransactions: string[] = []
  const broadcastValues: bigint[] = []
  const addressBalances = new Map<string, bigint>()
  await context.route(
    url => EVM_HISTORY_PROXY_ORIGINS.has(url.origin) && url.pathname === '/',
    route => {
      const request = route.request().postDataJSON() as { id: number | string; method: string }
      expect(['ankr_getTransactionsByAddress', 'ankr_getTokenTransfers']).toContain(request.method)
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result:
            request.method === 'ankr_getTokenTransfers' ? { transfers: [] } : { transactions: [] }
        })
      })
    }
  )
  for (const url of EVM_HISTORY_URLS) {
    await context.route(url, route =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ status: '0', message: 'No transactions found', result: [] })
      })
    )
  }
  for (const network of EVM_RPC_NETWORKS) {
    await context.route(network.url, async route => {
      rpcRequestCount += 1
      const request = route.request().postDataJSON() as {
        id: number
        method: string
        params?: readonly unknown[]
      }
      const call = request.params?.[0]
      const balanceAddress =
        typeof request.params?.[0] === 'string' ? request.params[0].toLowerCase() : ''
      const callData =
        typeof call === 'object' && call !== null && 'data' in call
          ? (call as { data?: unknown }).data
          : undefined
      const result =
        request.method === 'eth_chainId'
          ? network.chainId
          : request.method === 'eth_getBalance'
            ? `0x${(addressBalances.get(balanceAddress) ?? options.balanceRaw ?? 1_000_000_000_000_000_000n).toString(16)}`
            : request.method === 'eth_getTransactionCount'
              ? '0x0'
              : request.method === 'eth_call'
                ? request.params?.[1] === 'latest' &&
                  typeof callData === 'string' &&
                  callData.startsWith('0x70a08231')
                  ? `0x${USDC_BALANCE_RAW.toString(16).padStart(64, '0')}`
                  : typeof callData === 'string' && callData.startsWith('0xdd62ed3e')
                    ? `0x${'0'.repeat(64)}`
                    : '0x'
                : request.method === 'eth_estimateGas'
                  ? (() => {
                      if (callData === '0x1234') {
                        contractGasEstimateCount += 1
                        return options.contractGas ?? '0x5208'
                      }
                      return '0x5208'
                    })()
                  : request.method === 'eth_maxPriorityFeePerGas'
                    ? '0x3b9aca00'
                    : request.method === 'eth_getBlockByNumber'
                      ? { number: '0x101', baseFeePerGas: '0x3b9aca00' }
                      : request.method === 'eth_sendRawTransaction'
                        ? (() => {
                            broadcastCount += 1
                            if (!options.allowBroadcast) {
                              throw new Error(
                                'The protocol review test must not broadcast EVM funds'
                              )
                            }
                            const rawTransaction = request.params?.[0]
                            if (
                              typeof rawTransaction !== 'string' ||
                              !/^0x[0-9a-fA-F]+$/.test(rawTransaction)
                            ) {
                              throw new Error('Expected a canonical signed EVM transaction')
                            }
                            const hash = keccak256(rawTransaction as Hex)
                            const transaction = parseTransaction(rawTransaction as Hex)
                            const value = transaction.value ?? 0n
                            const fee =
                              (transaction.gas ?? 0n) *
                              (transaction.maxFeePerGas ?? transaction.gasPrice ?? 0n)
                            if (
                              options.balanceRaw !== undefined &&
                              value + fee > options.balanceRaw
                            )
                              throw new Error('Broadcast exceeds the source balance including gas')
                            broadcastValues.push(value)
                            broadcastHashes.push(hash)
                            broadcastRawTransactions.push(rawTransaction)
                            return hash
                          })()
                        : request.method === 'eth_getTransactionReceipt'
                          ? typeof request.params?.[0] === 'string' &&
                            broadcastHashes.includes(request.params[0]) &&
                            !options.pendingBroadcast
                            ? {
                                transactionHash: request.params[0],
                                blockHash: `0x${'2'.repeat(64)}`,
                                blockNumber: '0x100',
                                status: '0x1'
                              }
                            : null
                          : request.method === 'eth_getTransactionByHash'
                            ? typeof request.params?.[0] === 'string' &&
                              broadcastHashes.includes(request.params[0])
                              ? {
                                  hash: request.params[0],
                                  blockHash: options.pendingBroadcast
                                    ? null
                                    : `0x${'2'.repeat(64)}`,
                                  blockNumber: options.pendingBroadcast ? null : '0x100'
                                }
                              : null
                            : null
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: request.id, result })
      })
    })
  }
  return {
    getBroadcastCount: () => broadcastCount,
    getRpcRequestCount: () => rpcRequestCount,
    getContractGasEstimateCount: () => contractGasEstimateCount,
    getBroadcastHashes: () => [...broadcastHashes],
    getBroadcastRawTransactions: () => [...broadcastRawTransactions],
    getBroadcastValues: () => [...broadcastValues],
    setAddressBalanceRaw: (address: string, balanceRaw: bigint) => {
      addressBalances.set(address.toLowerCase(), balanceRaw)
    }
  }
}

async function mockBitcoinNetwork(context: BrowserContext): Promise<{
  readonly getBroadcastCount: () => number
  readonly getAddressActivityCount: () => number
  readonly getAddressUtxoCount: () => number
}> {
  let fundedAddress: string | null = null
  let broadcastCount = 0
  let addressActivityCount = 0
  let addressUtxoCount = 0
  const stats = (used: boolean) => ({
    tx_count: used ? 1 : 0,
    funded_txo_count: used ? 1 : 0,
    funded_txo_sum: used ? UTXO_VALUE_SATS : 0,
    spent_txo_count: 0,
    spent_txo_sum: 0
  })
  const fulfillJson = (route: Route, body: unknown) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
  const handler = async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    const markerIndex = url.pathname.indexOf('/api/')
    if (markerIndex < 0) throw new Error(`Unexpected Bitcoin URL: ${request.url()}`)
    const path = decodeURIComponent(url.pathname.slice(markerIndex + 5))
    if (path === 'block-height/0') {
      await route.fulfill({ contentType: 'text/plain', body: MAINNET_GENESIS })
      return
    }
    if (path === 'blocks/tip/height') {
      await route.fulfill({ contentType: 'text/plain', body: '900000' })
      return
    }
    if (path === 'fee-estimates') {
      await fulfillJson(route, { 6: 2 })
      return
    }
    if (path === 'tx' && request.method() === 'POST') {
      broadcastCount += 1
      throw new Error('The protocol review test must not broadcast Bitcoin funds')
    }
    const utxoMatch = /^address\/(.+)\/utxo$/.exec(path)
    if (utxoMatch) {
      addressUtxoCount += 1
      const address = utxoMatch[1]
      await fulfillJson(
        route,
        address === fundedAddress
          ? [
              {
                txid: UTXO_TRANSACTION_ID,
                vout: 0,
                value: UTXO_VALUE_SATS,
                status: {
                  confirmed: true,
                  block_height: 899900,
                  block_hash: 'c'.repeat(64),
                  block_time: 1_786_000_000
                }
              }
            ]
          : []
      )
      return
    }
    if (/^address\/(.+)\/txs$/.test(path)) {
      await fulfillJson(route, [])
      return
    }
    const addressMatch = /^address\/(.+)$/.exec(path)
    if (addressMatch) {
      addressActivityCount += 1
      const address = addressMatch[1]
      if (fundedAddress === null && address.startsWith('bc1q')) fundedAddress = address
      const used = address === fundedAddress
      await fulfillJson(route, {
        address,
        chain_stats: stats(used),
        mempool_stats: stats(false)
      })
      return
    }
    throw new Error(`Unhandled Bitcoin test path: ${path}`)
  }
  await context.route(MEMPOOL_URL, handler)
  await context.route(BLOCKSTREAM_URL, handler)
  await context.route(EMZY_URL, handler)
  return Object.freeze({
    getBroadcastCount: () => broadcastCount,
    getAddressActivityCount: () => addressActivityCount,
    getAddressUtxoCount: () => addressUtxoCount
  })
}

async function mockProtocolApis(
  context: BrowserContext,
  options: {
    readonly mcaId?: string
    readonly mcaByWallet?: (wallet: Readonly<Record<string, string>>) => string | null
    readonly includeMultichainMarkets?: boolean
    readonly tokenResponseDelayMs?: number
    readonly quoteResponseDelayMs?: number
    readonly mockRheaCatalog?: boolean
    readonly mockRheaQuote?: boolean
    readonly evmApproval?: boolean
    readonly orderStatus?: 'pending' | 'completed'
  } = {}
): Promise<{
  readonly setTokenOnline: (online: boolean) => void
  readonly setNearOnline: (online: boolean) => void
  readonly setOrderStatus: (status: 'pending' | 'completed') => void
  readonly getQuoteRequests: () => readonly {
    originAsset: string
    destinationAsset: string
    amount: string
    refundTo: string
    recipient: string
    dry: boolean
    confidentiality?: 'basic'
    depositType?: 'ORIGIN_CHAIN' | 'CONFIDENTIAL_INTENTS'
    refundType?: 'ORIGIN_CHAIN' | 'CONFIDENTIAL_INTENTS'
    recipientType?: 'CONFIDENTIAL_INTENTS' | 'DESTINATION_CHAIN'
  }[]
}> {
  let tokenOnline = true
  let nearOnline = true
  let orderStatus = options.orderStatus ?? 'completed'
  const quoteRequests: Array<{
    originAsset: string
    destinationAsset: string
    amount: string
    refundTo: string
    recipient: string
    dry: boolean
    confidentiality?: 'basic'
    depositType?: 'ORIGIN_CHAIN' | 'CONFIDENTIAL_INTENTS'
    refundType?: 'ORIGIN_CHAIN' | 'CONFIDENTIAL_INTENTS'
    recipientType?: 'CONFIDENTIAL_INTENTS' | 'DESTINATION_CHAIN'
  }> = []
  const priceUpdatedAt = new Date().toISOString()
  await context.route(TOKEN_LIST_URL, async route => {
    if (!tokenOnline) return route.abort('failed')
    if (options.tokenResponseDelayMs) {
      await new Promise(resolve => setTimeout(resolve, options.tokenResponseDelayMs))
    }
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([
        {
          assetId: ZEC_ASSET,
          blockchain: 'zec',
          contractAddress: null,
          decimals: 8,
          icon: null,
          price: 40,
          priceUpdatedAt,
          symbol: 'ZEC'
        },
        {
          assetId: ETH_ASSET,
          blockchain: 'eth',
          contractAddress: null,
          decimals: 18,
          icon: null,
          price: 2500,
          priceUpdatedAt,
          symbol: 'ETH'
        },
        {
          assetId: TRIAL_ASSET,
          blockchain: 'eth',
          contractAddress: TRIAL_CONTRACT,
          decimals: 18,
          icon: null,
          price: 1,
          priceUpdatedAt,
          symbol: 'TRIAL'
        },
        {
          assetId: USDC_ASSET,
          blockchain: 'eth',
          contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          coingeckoId: 'usd-coin',
          decimals: 6,
          price: 1,
          priceUpdatedAt,
          symbol: 'USDC'
        },
        {
          assetId: POL_ASSET,
          blockchain: 'polygon',
          contractAddress: null,
          decimals: 18,
          icon: null,
          price: 0.5,
          priceUpdatedAt,
          symbol: 'POL'
        },
        {
          assetId: BNB_ASSET,
          blockchain: 'bsc',
          contractAddress: null,
          decimals: 18,
          icon: null,
          price: 600,
          priceUpdatedAt,
          symbol: 'BNB'
        },
        {
          assetId: POLYGON_USDC_ASSET,
          blockchain: 'polygon',
          decimals: 6,
          price: 1,
          priceUpdatedAt,
          symbol: 'USDC'
        },
        {
          assetId: BTC_ASSET,
          blockchain: 'btc',
          decimals: 8,
          icon: null,
          price: 60000,
          priceUpdatedAt,
          symbol: 'BTC'
        },
        {
          assetId: NEAR_ASSET,
          blockchain: 'near',
          contractAddress: null,
          decimals: 24,
          icon: null,
          price: 3,
          priceUpdatedAt,
          symbol: 'NEAR'
        }
      ])
    })
  })
  await context.route(COINGECKO_MARKETS_URL, route =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: 'usd-coin',
          image: 'https://coin-images.coingecko.com/coins/images/6319/large/usdc.png'
        }
      ])
    })
  )
  const rheaTokenListChainIds: Readonly<Record<string, number>> = {
    eth: 1,
    base: 8453,
    bsc: 56,
    polygon: 137,
    near: 900001,
    btc: 900002,
    zec: 900010
  }
  const rheaTokenRows = [
    {
      assetId: ZEC_ASSET,
      blockchain: 'zec',
      contractAddress: null,
      decimals: 8,
      price: 40,
      symbol: 'ZEC'
    },
    {
      assetId: ETH_ASSET,
      blockchain: 'eth',
      contractAddress: null,
      decimals: 18,
      price: 2500,
      sources: ['nearintents'],
      symbol: 'ETH'
    },
    {
      assetId: TRIAL_ASSET,
      blockchain: 'eth',
      contractAddress: TRIAL_CONTRACT,
      decimals: 18,
      price: 1,
      symbol: 'TRIAL'
    },
    {
      assetId: USDC_ASSET,
      blockchain: 'eth',
      contractAddress: ETHEREUM_USDC_CONTRACT,
      decimals: 6,
      price: 1,
      sources: ['nearintents'],
      symbol: 'USDC'
    },
    {
      assetId: BASE_USDC_ASSET,
      blockchain: 'base',
      contractAddress: BASE_USDC_CONTRACT,
      decimals: 6,
      price: 1,
      sources: ['nearintents'],
      symbol: 'USDC'
    },
    {
      assetId: 'nep141:eth-dai.omft.near',
      blockchain: 'eth',
      contractAddress: '0x6b175474e89094c44da98b954eedeac495271d0f',
      decimals: 18,
      price: 1,
      symbol: 'DAI'
    },
    {
      assetId: POL_ASSET,
      blockchain: 'polygon',
      contractAddress: null,
      decimals: 18,
      price: 0.5,
      symbol: 'POL'
    },
    {
      assetId: BNB_ASSET,
      blockchain: 'bsc',
      contractAddress: null,
      decimals: 18,
      price: 600,
      symbol: 'BNB'
    },
    {
      assetId: POLYGON_USDC_ASSET,
      blockchain: 'polygon',
      contractAddress: POLYGON_USDC_CONTRACT,
      decimals: 6,
      price: 1,
      symbol: 'USDC'
    },
    {
      assetId: BTC_ASSET,
      blockchain: 'btc',
      contractAddress: null,
      decimals: 8,
      price: 60000,
      symbol: 'BTC'
    },
    {
      assetId: NEAR_ASSET,
      blockchain: 'near',
      contractAddress: null,
      decimals: 24,
      price: 3,
      symbol: 'NEAR'
    },
    {
      assetId: 'nep141:eth.bridge.near',
      blockchain: 'near',
      contractAddress: 'eth.bridge.near',
      decimals: 18,
      price: 2500,
      symbol: 'ETH'
    }
  ].map(token => ({
    ...token,
    address: token.contractAddress ?? token.assetId,
    chainId: rheaTokenListChainIds[token.blockchain],
    isNative: token.contractAddress === null,
    priceUpdatedAt
  }))
  await context.route('**/get_multichain_lending_tokens_data**', route =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(rheaTokenRows) })
  )
  if (options.mockRheaCatalog !== false) {
    await context.route('https://api.rhea.finance/get_chain_prices**', route => {
      const chainId = Number(new URL(route.request().url()).searchParams.get('chain'))
      const rows = rheaTokenRows.filter(token => token.chainId === chainId)
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          msg: 'success',
          data: Object.fromEntries(rows.map((token, index) => [`${token.assetId}:${index}`, token]))
        })
      })
    })
    await context.route('https://api.rhea.finance/api/swap/supported_to_tokens**', route => {
      const chainId = Number(new URL(route.request().url()).searchParams.get('chain'))
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          msg: 'success',
          data: { tokens: rheaTokenRows.filter(token => token.chainId === chainId) }
        })
      })
    })
  }
  await context.route(LENDING_METADATA_URL, route =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        'zec.omft.near': {
          decimals: 8,
          icon: '',
          name: 'Zcash',
          symbol: 'ZEC'
        },
        ...(options.includeMultichainMarkets
          ? {
              'eth.bridge.near': {
                decimals: 18,
                icon: '',
                name: 'Ether',
                symbol: 'ETH'
              },
              '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': {
                decimals: 6,
                icon: '',
                name: 'USD Coin',
                symbol: 'USDC'
              },
              'nbtc.bridge.near': {
                decimals: 8,
                icon: '',
                name: 'Bitcoin',
                symbol: 'NBTC'
              },
              '6b175474e89094c44da98b954eedeac495271d0f.factory.bridge.near': {
                decimals: 18,
                icon: '',
                name: 'Dai Stablecoin',
                symbol: 'DAI'
              }
            }
          : {})
      })
    })
  )
  const nearRpcHandler = async (route: Route) => {
    if (!nearOnline) {
      await route.abort('failed')
      return
    }
    const request = route.request().postDataJSON() as {
      id: string | number
      method?: string
      params?: { method_name?: string; block_id?: unknown; args_base64?: string }
    }
    const near = NEAR_NETWORKS.mainnet
    const attestationResult =
      request.method === 'status'
        ? {
            chain_id: near.network,
            sync_info: { latest_block_hash: near.genesisHash }
          }
        : request.method === 'genesis_config'
          ? {
              chain_id: near.network,
              genesis_height: near.genesisHeight,
              genesis_time: near.genesisTime
            }
          : request.method === 'block' && request.params?.block_id === near.genesisHeight
            ? {
                header: {
                  height: near.genesisHeight,
                  hash: near.genesisHash
                }
              }
            : undefined
    if (attestationResult !== undefined) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: request.id, result: attestationResult })
      })
      return
    }
    const methodName = request.params?.method_name
    const args = request.params?.args_base64
      ? JSON.parse(Buffer.from(request.params.args_base64, 'base64').toString('utf8'))
      : {}
    const emptyPortfolio =
      options.mcaId && args.account_id === options.mcaId
        ? {
            booster_staking: null,
            booster_stakings: [],
            farms: [],
            has_non_farmed_assets: false,
            positions: {},
            supplied: options.includeMultichainMarkets
              ? [
                  {
                    token_id: 'eth.bridge.near',
                    apr: '0',
                    balance: '15000000000000000000000000000',
                    shares: '15000000000000000000000000000'
                  }
                ]
              : []
          }
        : null
    const result =
      methodName === 'current_salt'
        ? '12345678'
        : methodName === 'get_mca_by_wallet'
          ? options.mcaByWallet
            ? options.mcaByWallet(args.wallet)
            : options.mcaId || null
          : methodName === 'batch_views'
            ? [
                emptyPortfolio,
                null,
                [
                  {
                    token_id: 'zec.omft.near',
                    config: { extra_decimals: 10 },
                    farms: [],
                    supplied: { balance: '0' },
                    supply_apr: '0.05',
                    borrow_apr: '0'
                  },
                  ...(options.includeMultichainMarkets
                    ? [
                        {
                          token_id: 'eth.bridge.near',
                          config: { extra_decimals: 10 },
                          farms: [],
                          supplied: { balance: '420000000000000000000000000000' },
                          supply_apr: '0.03',
                          borrow_apr: '0'
                        },
                        {
                          token_id:
                            '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
                          config: { extra_decimals: 10 },
                          farms: [],
                          supplied: { balance: '1000000000000000000' },
                          supply_apr: '9',
                          borrow_apr: '0'
                        },
                        {
                          token_id: 'nbtc.bridge.near',
                          config: { extra_decimals: 10 },
                          farms: [],
                          supplied: { balance: '3000000000000000000' },
                          supply_apr: '0.2',
                          borrow_apr: '0'
                        },
                        {
                          token_id: '6b175474e89094c44da98b954eedeac495271d0f.factory.bridge.near',
                          config: { extra_decimals: 10 },
                          farms: [],
                          supplied: { balance: '50000000000000000000000000000' },
                          supply_apr: '0.04',
                          borrow_apr: '0'
                        }
                      ]
                    : [])
                ],
                { enable_pyth_oracle: false },
                null,
                null,
                null,
                {}
              ]
            : methodName === 'get_price_data'
              ? {
                  prices: [
                    {
                      asset_id: 'zec.omft.near',
                      price: { multiplier: '40', decimals: 8 }
                    },
                    ...(options.includeMultichainMarkets
                      ? [
                          {
                            asset_id: 'eth.bridge.near',
                            price: { multiplier: '2500', decimals: 18 }
                          },
                          {
                            asset_id:
                              '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
                            price: { multiplier: '1', decimals: 6 }
                          },
                          {
                            asset_id: 'nbtc.bridge.near',
                            price: { multiplier: '60000', decimals: 8 }
                          },
                          {
                            asset_id:
                              '6b175474e89094c44da98b954eedeac495271d0f.factory.bridge.near',
                            price: { multiplier: '1', decimals: 18 }
                          }
                        ]
                      : [])
                  ]
                }
              : methodName === 'ft_balance_of'
                ? '0'
                : methodName === 'storage_balance_of'
                  ? null
                  : methodName === 'get_booster_tokens' || methodName === 'get_asset_farms_paged'
                    ? []
                    : methodName === 'get_create_mca_fee_paged' ||
                        methodName === 'get_near_values_paged'
                      ? {}
                      : methodName === 'get_create_mca_fee' || methodName === 'get_near_value'
                        ? '0'
                        : undefined
    if (result === undefined) {
      throw new Error(`Unhandled NEAR method in protocol UI test: ${methodName || 'unknown'}`)
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          block_hash: 'near-test-block',
          block_height: 1,
          logs: [],
          result: [...Buffer.from(JSON.stringify(result))]
        }
      })
    })
  }
  for (const url of NEAR_RPC_URLS) await context.route(url, nearRpcHandler)
  let confidentialBalanceReads = 0
  let confidentialDepositAmount = '0'
  let formalWithdrawQuoteCount = 0
  const submittedConfidentialAddresses = new Set<string>()
  const confidentialFormalQuotes = new Map<
    string,
    { readonly correlationId: string; readonly deadline: string; readonly signerId: string }
  >()
  await context.route(`${CONFIDENTIAL_API_URL}/quote`, async route => {
    const request = route.request().postDataJSON() as {
      originAsset: string
      destinationAsset: string
      amount: string
      refundTo: string
      recipient: string
      dry: boolean
      confidentiality: 'basic'
      depositType: 'ORIGIN_CHAIN' | 'CONFIDENTIAL_INTENTS'
      refundType: 'ORIGIN_CHAIN' | 'CONFIDENTIAL_INTENTS'
      recipientType: 'CONFIDENTIAL_INTENTS' | 'DESTINATION_CHAIN'
      deadline: string
    }
    quoteRequests.push({
      originAsset: request.originAsset,
      destinationAsset: request.destinationAsset,
      amount: request.amount,
      refundTo: request.refundTo,
      recipient: request.recipient,
      dry: request.dry,
      confidentiality: request.confidentiality,
      depositType: request.depositType,
      refundType: request.refundType,
      recipientType: request.recipientType
    })
    const deposit = request.depositType === 'ORIGIN_CHAIN'
    if (deposit) confidentialDepositAmount = request.amount
    if (!deposit && !request.dry) formalWithdrawQuoteCount += 1
    const correlationId = `confidential-${quoteRequests.length}`
    const depositAddress = deposit
      ? '0x2222222222222222222222222222222222222222'
      : request.dry
        ? undefined
        : `withdraw-${formalWithdrawQuoteCount}.near`
    if (depositAddress && !deposit) {
      confidentialFormalQuotes.set(depositAddress, {
        correlationId,
        deadline: request.deadline,
        signerId: request.refundTo
      })
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        correlationId,
        quoteRequest: request,
        quote: {
          amountIn: request.amount,
          amountOut: request.amount,
          minAmountOut: request.amount,
          deadline: request.deadline,
          ...(depositAddress ? { depositAddress } : {})
        }
      })
    })
  })
  await context.route(`${CONFIDENTIAL_API_URL}/auth/authenticate`, route =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        accessToken: 'protocol-confidential-access',
        refreshToken: 'protocol-confidential-refresh',
        expiresIn: 3600,
        refreshExpiresIn: 7200
      })
    })
  )
  await context.route(CONFIDENTIAL_BALANCES_URL, route => {
    confidentialBalanceReads += 1
    const available = confidentialBalanceReads > 1 ? confidentialDepositAmount : '0'
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        balances: [{ tokenId: ETH_ASSET, available, source: 'confidential' }]
      })
    })
  })
  await context.route(`${CONFIDENTIAL_API_URL}/generate-intent`, route => {
    const request = route.request().postDataJSON() as { depositAddress: string }
    const quote = confidentialFormalQuotes.get(request.depositAddress)
    if (!quote) throw new Error('Intent requested outside the formal confidential quotes')
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        correlationId: `generated-${request.depositAddress}`,
        intent: {
          standard: 'erc191',
          payload: JSON.stringify({
            signer_id: quote.signerId,
            verifying_contract: 'intents.near',
            deadline: quote.deadline,
            receiver_id: request.depositAddress
          })
        }
      })
    })
  })
  await context.route(`${CONFIDENTIAL_API_URL}/submit-intent`, route => {
    const request = route.request().postDataJSON() as { signedData: { payload: string } }
    const payload = JSON.parse(request.signedData.payload) as { receiver_id: string }
    submittedConfidentialAddresses.add(payload.receiver_id)
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        intentHash: 'protocol-confidential-intent',
        correlationId: 'protocol-confidential-submit'
      })
    })
  })
  await context.route(`${CONFIDENTIAL_API_URL}/status**`, route => {
    const address = new URL(route.request().url()).searchParams.get('depositAddress')
    const successful =
      address === '0x2222222222222222222222222222222222222222' ||
      (address !== null && submittedConfidentialAddresses.has(address))
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        status: successful ? 'SUCCESS' : 'PENDING_DEPOSIT',
        swapDetails: successful
          ? { destinationChainTxHashes: [{ hash: `0x${'a'.repeat(64)}` }] }
          : {}
      })
    })
  })
  await context.route(LENDING_QUOTE_URL, async route => {
    const request = route.request().postDataJSON() as {
      originAsset: string
      amount: string
      deadline: string
    }
    const depositAddress =
      request.originAsset === BTC_ASSET
        ? BITCOIN_DEPOSIT_ADDRESS
        : '0x2222222222222222222222222222222222222222'
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        quote: {
          amountIn: request.amount,
          amountOut: request.amount,
          minAmountOut: request.amount,
          amountInFormatted: request.amount,
          amountOutFormatted: request.amount,
          depositAddress,
          deadline: request.deadline
        }
      })
    })
  })
  if (options.mockRheaQuote !== false) {
    await context.route(QUOTE_URL, async route => {
      const request = route.request().postDataJSON() as {
        fromChain: string
        toChain: string
        tokenIn: string
        tokenOut: string
        amountIn: string
        sender: string
        recipient: string
        confidentiality?: 'basic'
      }
      const originAsset = request.fromChain === 'btc' ? BTC_ASSET : request.tokenIn
      const destinationAsset =
        request.toChain === 'btc'
          ? BTC_ASSET
          : request.toChain === 'near'
            ? NEAR_ASSET
            : request.tokenOut
      quoteRequests.push({
        originAsset,
        destinationAsset,
        amount: request.amountIn,
        refundTo: request.sender,
        recipient: request.recipient,
        dry: false,
        ...(request.confidentiality === undefined
          ? {}
          : { confidentiality: request.confidentiality })
      })
      if (options.quoteResponseDelayMs) {
        await new Promise(resolve => setTimeout(resolve, options.quoteResponseDelayMs))
      }
      const amountOut =
        request.tokenOut === ETH_ASSET
          ? request.amountIn
          : request.toChain === 'near'
            ? '5000000000000000000000000'
            : request.toChain === 'btc'
              ? '500000'
              : '500000'
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          msg: 'success',
          data: {
            isCrossChain: request.fromChain !== request.toChain,
            chainType: request.fromChain === 'btc' ? 'bitcoin' : 'evm',
            bestQuote: {
              router: 'nearintents',
              amountOut,
              minAmountOut: amountOut,
              preSwap: null,
              bridge: null,
              expiresAt: Date.now() + 30 * 60_000
            },
            allQuotes: []
          }
        })
      })
    })
  }
  await context.route(BUILD_SWAP_URL, async route => {
    const request = route.request().postDataJSON() as {
      fromChain: string
      toChain: string
      tokenIn: string
      tokenOut: string
      amountIn: string
      sender: string
      expectedOut: string
      minAmountOut: string
      router: string
    }
    const tokenIn =
      request.fromChain === 'btc'
        ? { address: request.tokenIn, symbol: 'BTC', decimals: 8 }
        : request.fromChain === '137'
          ? { address: request.tokenIn, symbol: 'POL', decimals: 18 }
          : request.tokenIn.toLowerCase() === ETHEREUM_USDC_CONTRACT
            ? { address: request.tokenIn, symbol: 'USDC', decimals: 6 }
            : { address: request.tokenIn, symbol: 'ETH', decimals: 18 }
    const tokenOut =
      request.toChain === 'btc'
        ? { address: request.tokenOut, symbol: 'BTC', decimals: 8 }
        : request.toChain === 'near'
          ? { address: request.tokenOut, symbol: 'NEAR', decimals: 24 }
          : request.toChain === 'zcash'
            ? { address: request.tokenOut, symbol: 'ZEC', decimals: 8 }
            : { address: request.tokenOut, symbol: 'USDC', decimals: 6 }
    const tx =
      request.fromChain === 'btc'
        ? {
            kind: 'btc_transfer',
            amount: request.amountIn,
            depositAddress: BITCOIN_DEPOSIT_ADDRESS
          }
        : {
            chainId: Number(request.fromChain),
            from: request.sender,
            to: '0x4444444444444444444444444444444444444444',
            data: '0x1234',
            value: options.evmApproval ? '0' : request.amountIn
          }
    const spender = '0x4444444444444444444444444444444444444444'
    const approve =
      options.evmApproval && request.fromChain === '1'
        ? {
            spender,
            tx: {
              chainId: 1,
              from: request.sender,
              to: request.tokenIn,
              data: `0x095ea7b3${spender.slice(2).padStart(64, '0')}${BigInt(request.amountIn).toString(16).padStart(64, '0')}`,
              value: '0'
            }
          }
        : null
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        code: 0,
        msg: 'success',
        data: {
          isCrossChain: request.fromChain !== request.toChain,
          chainType: request.fromChain === 'btc' ? 'bitcoin' : 'evm',
          router: request.router,
          fromChain: request.fromChain,
          toChain: request.toChain,
          tokenIn,
          tokenOut,
          amountIn: request.amountIn,
          estimatedOut: request.expectedOut,
          minAmountOut: request.minAmountOut,
          tx,
          approve,
          orderId: 'protocol-private-order',
          statusRouter: 'nearintents'
        }
      })
    })
  })
  await context.route(REPORT_SWAP_URL, route =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, msg: 'success', data: {} })
    })
  )
  await context.route(`${ORDER_STATUS_URL}**`, route =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        code: 0,
        msg: 'success',
        data:
          orderStatus === 'pending'
            ? { status: 'pending' }
            : { status: 'completed', to_hash: `0x${'f'.repeat(64)}` }
      })
    })
  )
  return Object.freeze({
    setTokenOnline: (online: boolean) => {
      tokenOnline = online
    },
    setNearOnline: (online: boolean) => {
      nearOnline = online
    },
    setOrderStatus: (status: 'pending' | 'completed') => {
      orderStatus = status
    },
    getQuoteRequests: () => [...quoteRequests]
  })
}

async function expectNoOverflow(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => ({
        width: document.documentElement.clientWidth,
        contentWidth: document.documentElement.scrollWidth,
        height: document.documentElement.clientHeight
      }))
    )
    .toEqual({ width: 375, contentWidth: 375, height: 600 })
}

export {
  BASE_USDC_CONTRACT,
  BUILD_SWAP_URL,
  ETHEREUM_USDC_CONTRACT,
  ETH_ASSET,
  POLYGON_USDC_CONTRACT,
  POL_ASSET,
  QUOTE_URL,
  TRIAL_CONTRACT,
  bitcoinEnabled,
  captureScreenshot,
  connectEvmDApp,
  expect,
  expectNoOverflow,
  importTestWallet,
  mockBitcoinNetwork,
  mockEvmNetwork,
  mockProtocolApis,
  networks,
  parseTransaction,
  readEvmAccounts,
  readPersistedSwapSource,
  test,
  waitForBackgroundWalletInitialization
}
export type { Hex, Route }
