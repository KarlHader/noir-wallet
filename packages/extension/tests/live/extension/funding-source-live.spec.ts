import { createServer, type Server } from 'node:http'
import { lstat, readFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import type { BrowserContext, Page } from '@playwright/test'
import { NETWORKS } from '../../../src/config/networks'
import { expect, selectImportedZcashHistory, test } from '../../helpers/extension-fixtures'

const TEST_PASSWORD = 'Noir-live-test-2026!'
const SEND_AMOUNT = process.env.NOIR_TESTNET_SEND_AMOUNT || '0.0001'
const TRANSPARENT_SEED_AMOUNT = process.env.NOIR_TESTNET_SEED_AMOUNT || '0.001'
const LIVE_ENABLED = process.env.NOIR_TESTNET_FUNDING_SOURCE === '1'
const BROADCAST_ENABLED = process.env.NOIR_TESTNET_BROADCAST === '1'
const TEST_ACCOUNT_SLOT = process.env.NOIR_TESTNET_ACCOUNT === '2' ? '2' : '1'
const PROVISION_TARGET_SLOT =
  process.env.NOIR_TESTNET_PROVISION_TARGET === '1' ||
  process.env.NOIR_TESTNET_PROVISION_TARGET === '2'
    ? process.env.NOIR_TESTNET_PROVISION_TARGET
    : undefined
const MNEMONIC_FILE =
  process.env.NOIR_TESTNET_MNEMONIC_FILE ||
  process.env[`TESTNET_${TEST_ACCOUNT_SLOT}_MNEMONIC_FILE`]
const BIRTHDAY_HEIGHT =
  process.env.NOIR_TESTNET_BIRTHDAY_HEIGHT || process.env[`TESTNET_${TEST_ACCOUNT_SLOT}_BLOCK`]
const TEX_RECIPIENT = process.env.NOIR_TESTNET_TEX_ADDRESS

if (LIVE_ENABLED && process.env.NETWORK_MODE !== 'testnet') {
  throw new Error('Funded transaction tests require the isolated NETWORK_MODE=testnet build')
}

interface ZcashProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
}

interface ConnectResult {
  transparent: string
  shielded: string
}

interface BalanceResult {
  transparent: string
  shielded: string
}

interface MaxTransferResult {
  maxAmount: string
  fee: string
}

interface NodeTransaction {
  txid: string
  height?: number
  confirmations?: number
  expiryheight: number
  vin: unknown[]
  vout: unknown[]
  vShieldedOutput: unknown[]
  orchard?: { actions?: unknown[] } | null
  ironwood?: { actions?: unknown[] } | null
}

interface SyncState {
  isSyncing: boolean
  syncProgress: number
  currentHeight: number
  latestHeight: number
}

test.use({ screenshot: 'off', trace: 'off', video: 'off' })
test.skip(!LIVE_ENABLED, 'Set NOIR_TESTNET_FUNDING_SOURCE=1 to run the funded testnet flow')

async function readMnemonic(): Promise<string> {
  if (!MNEMONIC_FILE) {
    throw new Error(
      `NOIR_TESTNET_MNEMONIC_FILE or TESTNET_${TEST_ACCOUNT_SLOT}_MNEMONIC_FILE is required`
    )
  }
  return readMnemonicFile(MNEMONIC_FILE, 'Selected Zcash testnet wallet')
}

async function readMnemonicFile(filePath: string, label: string): Promise<string> {
  if (!path.isAbsolute(filePath)) throw new Error(`${label} path must be absolute`)
  let metadata
  try {
    metadata = await lstat(filePath)
  } catch {
    throw new Error(`${label} does not exist or cannot be read`)
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > 2_048) {
    throw new Error(`${label} must be a bounded regular file, not a symlink`)
  }
  if (process.platform !== 'win32' && (metadata.mode & 0o777) !== 0o600) {
    throw new Error(`${label} file permissions must be 0600`)
  }

  const mnemonic = (await readFile(filePath, 'utf8')).trim()
  if (mnemonic.split(/\s+/).length !== 24) {
    throw new Error(`${label} must contain one 24-word mnemonic`)
  }
  return mnemonic
}

async function deriveTargetTransparentAddress(accountSlot: string): Promise<string> {
  const variable = `TESTNET_${accountSlot}_MNEMONIC_FILE`
  const mnemonicFile = process.env[variable]
  if (!mnemonicFile) throw new Error(`${variable} is required`)
  let mnemonic = await readMnemonicFile(mnemonicFile, `Zcash testnet wallet ${accountSlot}`)

  const originalSelf = Reflect.get(globalThis, 'self')
  if (!originalSelf) {
    Object.defineProperty(globalThis, 'self', {
      configurable: true,
      value: {
        addEventListener() {},
        removeEventListener() {}
      }
    })
  }

  try {
    const wasmModule = await import('../../../src/lib/wasm-pkg/zcash_wallet_wasm.js')
    const wasmBytes = await readFile(
      new URL('../../../src/lib/wasm-pkg/zcash_wallet_wasm_bg.wasm', import.meta.url)
    )
    await wasmModule.default({ module_or_path: wasmBytes })
    const addresses = wasmModule.mnemonic_to_addresses('test', mnemonic, '', 0) as {
      transparent?: unknown
    }
    mnemonic = ''
    if (typeof addresses.transparent !== 'string' || !addresses.transparent) {
      throw new Error('Failed to derive the target transparent address')
    }
    return addresses.transparent
  } finally {
    mnemonic = ''
    if (!originalSelf) {
      Reflect.deleteProperty(globalThis, 'self')
    }
  }
}

function parseBirthdayHeight(): string {
  if (!BIRTHDAY_HEIGHT || !/^\d+$/.test(BIRTHDAY_HEIGHT) || Number(BIRTHDAY_HEIGHT) <= 0) {
    throw new Error('NOIR_TESTNET_BIRTHDAY_HEIGHT must be a positive block height')
  }
  return BIRTHDAY_HEIGHT
}

async function startDappServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    })
    response.end('<!doctype html><html><body><main>Noir Wallet live test dApp</main></body></html>')
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, 'localhost', () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address() as AddressInfo
  return { server, url: `http://localhost:${address.port}` }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()))
  })
}

async function providerRequest(
  page: Page,
  method: string,
  params: unknown[] = []
): Promise<unknown> {
  return page.evaluate(
    async ({ requestMethod, requestParams }) => {
      const provider = (
        window as typeof window & {
          noirwallet?: { zcash: ZcashProvider }
        }
      ).noirwallet?.zcash
      if (!provider) {
        throw new Error('Noir Wallet provider was not injected')
      }
      return provider.request({ method: requestMethod, params: requestParams })
    },
    { requestMethod: method, requestParams: params }
  )
}

async function getNodeTransaction(txHash: string): Promise<NodeTransaction | null> {
  try {
    const response = await fetch(NETWORKS.testnet.nodeRpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'funding-source-live',
        method: 'getrawtransaction',
        params: [txHash, 1]
      }),
      signal: AbortSignal.timeout(15_000)
    })
    if (!response.ok) {
      throw new Error(`Testnet node returned HTTP ${response.status}`)
    }

    const rpcResponse = (await response.json()) as {
      result?: Partial<NodeTransaction>
      error?: { code?: number; message?: string }
    }
    if (rpcResponse.error?.code === -5) return null
    if (rpcResponse.error) {
      throw new Error(`Testnet node RPC failed: ${rpcResponse.error.message || 'unknown error'}`)
    }

    const value = rpcResponse.result
    if (
      !value ||
      value.txid !== txHash ||
      (value.height != null && typeof value.height !== 'number') ||
      (value.confirmations != null && typeof value.confirmations !== 'number') ||
      typeof value.expiryheight !== 'number' ||
      !Array.isArray(value.vin) ||
      !Array.isArray(value.vout) ||
      !Array.isArray(value.vShieldedOutput)
    ) {
      throw new Error('Testnet node returned an invalid transaction response')
    }
    return value as NodeTransaction
  } catch (error) {
    if (error instanceof Error && error.message.includes('invalid transaction response')) {
      throw error
    }
    return null
  }
}

async function getSyncState(extensionPage: Page): Promise<SyncState> {
  const result = await extensionPage.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'GET_SYNC_STATE' })
  )
  if (
    !result ||
    typeof result !== 'object' ||
    typeof result.isSyncing !== 'boolean' ||
    typeof result.syncProgress !== 'number' ||
    typeof result.currentHeight !== 'number' ||
    typeof result.latestHeight !== 'number'
  ) {
    throw new Error('Extension returned an invalid sync state')
  }
  return result
}

async function waitForExplorerConfirmation(
  context: BrowserContext,
  txHash: string,
  timeout: number
): Promise<void> {
  const explorer = await context.newPage()
  try {
    await expect
      .poll(
        async () => {
          await explorer
            .goto(`${NETWORKS.testnet.explorerUrl}/tx/${txHash}`, {
              waitUntil: 'domcontentloaded',
              timeout: 30_000
            })
            .catch(() => null)
          const pageText = await explorer
            .locator('body')
            .innerText()
            .catch(() => '')
          return /Included in canonical Zcash block #[\d,]+ with [1-9]\d* confirmations?\./.test(
            pageText
          )
        },
        {
          timeout,
          intervals: [5_000, 10_000, 20_000],
          message: `waiting for ${txHash} to be confirmed by the testnet explorer`
        }
      )
      .toBe(true)
  } finally {
    await explorer.close()
  }
}

async function getLocalTransaction(
  extensionPage: Page,
  txHash: string
): Promise<{ fromType?: string; chainHashes?: { hash: string; chain: string }[] } | null> {
  return extensionPage.evaluate(
    hash =>
      new Promise<{
        fromType?: string
        chainHashes?: { hash: string; chain: string }[]
      } | null>((resolve, reject) => {
        const openRequest = indexedDB.open('zcash-wallet-db')
        openRequest.onerror = () => reject(openRequest.error)
        openRequest.onsuccess = () => {
          const db = openRequest.result
          const transaction = db.transaction('transactions', 'readonly')
          const request = transaction.objectStore('transactions').getAll()
          request.onerror = () => {
            db.close()
            reject(request.error)
          }
          request.onsuccess = () => {
            const records = request.result
              .flatMap(value => (Array.isArray(value) ? value : []))
              .filter(
                (
                  value
                ): value is {
                  txHash: string
                  fromType?: string
                  chainHashes?: { hash: string; chain: string }[]
                } =>
                  !!value &&
                  typeof value === 'object' &&
                  typeof (value as { txHash?: unknown }).txHash === 'string'
              )
            const match = records.find(record => record.txHash === hash)
            db.close()
            resolve(match ?? null)
          }
        }
      }),
    txHash
  )
}

function assertConnectResult(value: unknown): asserts value is ConnectResult {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as ConnectResult).transparent !== 'string' ||
    typeof (value as ConnectResult).shielded !== 'string'
  ) {
    throw new Error('Provider returned an invalid account response')
  }
}

function assertBalanceResult(value: unknown): asserts value is BalanceResult {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as BalanceResult).transparent !== 'string' ||
    typeof (value as BalanceResult).shielded !== 'string'
  ) {
    throw new Error('Provider returned an invalid balance response')
  }
}

function assertMaxTransferResult(value: unknown): asserts value is MaxTransferResult {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as MaxTransferResult).maxAmount !== 'string' ||
    typeof (value as MaxTransferResult).fee !== 'string'
  ) {
    throw new Error('Provider returned an invalid Max response')
  }
}

test('transparent funding supports exact Max and an approved transfer on testnet', async ({
  context,
  popup
}) => {
  test.setTimeout(35 * 60_000)

  const manifest = await popup.evaluate(() => chrome.runtime.getManifest())
  expect(manifest.name).toBe('[Testnet] Noir Wallet')

  let mnemonic = await readMnemonic()
  const birthdayHeight = parseBirthdayHeight()
  const { server, url } = await startDappServer()

  try {
    await popup.getByRole('button', { name: 'Import wallet' }).click()
    await popup.locator('input[type="text"]').first().fill(mnemonic)
    mnemonic = ''
    await popup.getByRole('button', { name: 'Continue' }).click()

    await selectImportedZcashHistory(popup, {
      birthdayHeight: Number.parseInt(birthdayHeight, 10)
    })

    await popup.getByPlaceholder('8–64 characters').fill(TEST_PASSWORD)
    await popup.getByPlaceholder('Confirm password').fill(TEST_PASSWORD)
    await popup.getByRole('checkbox').check()
    await popup.getByRole('button', { name: 'Import Wallet' }).click()

    await expect(popup.getByRole('heading', { name: 'Congratulations!' })).toBeVisible({
      timeout: 60_000
    })
    await popup.getByRole('button', { name: 'Got it' }).click()

    const dapp = await context.newPage()
    await dapp.goto(url)
    await dapp.waitForFunction(() => {
      return Boolean(
        (
          window as typeof window & {
            noirwallet?: { zcash: ZcashProvider }
          }
        ).noirwallet
      )
    })

    const connectApprovalPromise = context.waitForEvent('page')
    const connectResultPromise = providerRequest(dapp, 'zcash_requestAccounts')
    const connectApproval = await connectApprovalPromise
    await connectApproval.setViewportSize({ width: 375, height: 632 })
    await expect(connectApproval.getByText('Connect to', { exact: true })).toBeVisible()
    await expect(
      connectApproval.getByRole('heading', { name: new URL(url).host, exact: true })
    ).toBeVisible()
    await expect(connectApproval.getByText('Zcash Testnet', { exact: true })).toHaveCount(0)
    await connectApproval.getByRole('button', { name: /^Connect/ }).click()

    const connection = await connectResultPromise
    assertConnectResult(connection)

    await expect
      .poll(
        async () => {
          const sync = await getSyncState(popup)
          return (
            sync.latestHeight > 0 && !sync.isSyncing && sync.currentHeight >= sync.latestHeight - 1
          )
        },
        {
          timeout: 8 * 60_000,
          intervals: [1_000, 2_000, 5_000, 10_000],
          message: 'waiting for the imported testnet wallet to finish syncing'
        }
      )
      .toBe(true)

    let balanceResult = await providerRequest(dapp, 'zcash_getBalance')
    assertBalanceResult(balanceResult)
    let balance = balanceResult

    if (PROVISION_TARGET_SLOT) {
      if (!BROADCAST_ENABLED) {
        throw new Error('NOIR_TESTNET_BROADCAST=1 is required for target provisioning')
      }
      if (PROVISION_TARGET_SLOT === TEST_ACCOUNT_SLOT) {
        throw new Error('Provision source and target accounts must be different')
      }

      const targetTransparent = await deriveTargetTransparentAddress(PROVISION_TARGET_SLOT)
      const shieldedMax = await providerRequest(dapp, 'zcash_getMaxTransfer', [
        {
          to: targetTransparent,
          feeTier: 'standard'
        }
      ])
      assertMaxTransferResult(shieldedMax)
      if (Number(TRANSPARENT_SEED_AMOUNT) >= Number(shieldedMax.maxAmount)) {
        throw new Error('NOIR_TESTNET_SEED_AMOUNT must be below shielded Max')
      }

      const provisionApprovalPromise = context.waitForEvent('page')
      const provisionResultPromise = providerRequest(dapp, 'zcash_sendTransaction', [
        {
          to: targetTransparent,
          amount: TRANSPARENT_SEED_AMOUNT
        }
      ])
      const provisionApproval = await provisionApprovalPromise
      await provisionApproval.setViewportSize({ width: 375, height: 632 })
      await expect(provisionApproval.getByText('Shielded', { exact: true })).toBeVisible()
      await provisionApproval.getByRole('button', { name: 'Approve' }).click()

      const provisionTxHash = await provisionResultPromise
      expect(typeof provisionTxHash).toBe('string')
      expect(provisionTxHash).toMatch(/^[0-9a-f]{64}$/i)
      console.log(`[funding-source-live] cross-account provision tx: ${provisionTxHash}`)

      await expect
        .poll(
          async () => {
            const transaction = await getNodeTransaction(provisionTxHash as string)
            return (transaction?.confirmations ?? 0) > 0
          },
          {
            timeout: 12 * 60_000,
            intervals: [5_000, 10_000, 20_000],
            message: 'waiting for the cross-account transparent provision to confirm'
          }
        )
        .toBe(true)
      return
    }

    if (Number(balance.transparent) <= 0) {
      if (!BROADCAST_ENABLED) {
        throw new Error('The selected test account has no spendable transparent UTXO')
      }
      if (Number(balance.shielded) <= 0) {
        throw new Error('The selected test account has neither transparent nor shielded funds')
      }

      const shieldedMax = await providerRequest(dapp, 'zcash_getMaxTransfer', [
        {
          to: connection.transparent,
          feeTier: 'standard'
        }
      ])
      assertMaxTransferResult(shieldedMax)
      if (Number(TRANSPARENT_SEED_AMOUNT) >= Number(shieldedMax.maxAmount)) {
        throw new Error('NOIR_TESTNET_SEED_AMOUNT must be below shielded Max')
      }

      const seedApprovalPromise = context.waitForEvent('page')
      const seedResultPromise = providerRequest(dapp, 'zcash_sendTransaction', [
        {
          to: connection.transparent,
          amount: TRANSPARENT_SEED_AMOUNT
        }
      ])
      const seedApproval = await seedApprovalPromise
      await seedApproval.setViewportSize({ width: 375, height: 632 })
      await expect(seedApproval.getByText('Shielded', { exact: true })).toBeVisible()
      await seedApproval.getByRole('button', { name: 'Approve' }).click()

      const seedTxHash = await seedResultPromise
      expect(typeof seedTxHash).toBe('string')
      expect(seedTxHash).toMatch(/^[0-9a-f]{64}$/i)
      console.log(`[funding-source-live] transparent seed tx: ${seedTxHash}`)

      await expect
        .poll(
          async () => {
            const result = await providerRequest(dapp, 'zcash_getBalance')
            assertBalanceResult(result)
            balance = result
            return Number(result.transparent)
          },
          {
            timeout: 12 * 60_000,
            intervals: [5_000, 10_000, 20_000],
            message: 'waiting for the seeded transparent UTXO to confirm and sync'
          }
        )
        .toBeGreaterThan(0)
    }

    const transparentMax = await providerRequest(dapp, 'zcash_getMaxTransfer', [
      {
        to: connection.transparent,
        feeTier: 'standard',
        fundingSource: 'transparent'
      }
    ])
    assertMaxTransferResult(transparentMax)

    const transparentFastMax = await providerRequest(dapp, 'zcash_getMaxTransfer', [
      {
        to: connection.transparent,
        feeTier: 'fast',
        fundingSource: 'transparent'
      }
    ])
    assertMaxTransferResult(transparentFastMax)

    const transferRecipient = TEX_RECIPIENT || connection.shielded
    const transferMemo = TEX_RECIPIENT ? undefined : 'Noir Wallet funding source E2E'

    expect(Number(transparentMax.maxAmount)).toBeGreaterThan(0)
    expect(Number(transparentMax.fee)).toBeGreaterThan(0)
    expect(Number(transparentFastMax.fee)).toBeGreaterThanOrEqual(Number(transparentMax.fee))
    expect(Number(transparentFastMax.maxAmount)).toBeLessThanOrEqual(
      Number(transparentMax.maxAmount)
    )
    expect(Number(transparentMax.maxAmount) + Number(transparentMax.fee)).toBeLessThanOrEqual(
      Number(balance.transparent) + 1e-8
    )

    if (
      !Number.isFinite(Number(SEND_AMOUNT)) ||
      Number(SEND_AMOUNT) <= 0 ||
      Number(SEND_AMOUNT) >= Number(transparentMax.maxAmount)
    ) {
      throw new Error('NOIR_TESTNET_SEND_AMOUNT must be positive and below transparent Max')
    }

    const sendApprovalPromise = context.waitForEvent('page')
    const sendResultPromise = providerRequest(dapp, 'zcash_sendTransaction', [
      {
        to: transferRecipient,
        amount: SEND_AMOUNT,
        memo: transferMemo,
        fundingSource: 'transparent'
      }
    ])
    const sendApproval = await sendApprovalPromise
    await sendApproval.setViewportSize({ width: 375, height: 632 })

    await expect(sendApproval.getByText('Funding source', { exact: true })).toBeVisible()
    await expect(sendApproval.getByText('Transparent', { exact: true })).toBeVisible()
    await expect(
      sendApproval.getByText(/reveals and may link the selected transparent UTXOs/)
    ).toBeVisible()
    await expect(sendApproval.getByRole('button', { name: 'Approve' })).toBeInViewport({
      ratio: 1
    })

    if (TEX_RECIPIENT) {
      const feeTrigger = sendApproval.getByRole('button', { name: /\(Standard\)/ })
      await expect(feeTrigger.locator('svg.animate-spin')).toHaveCount(0, { timeout: 30_000 })
      await feeTrigger.click()
      await expect(sendApproval.getByText('Approximate ZIP-317 estimate.')).toHaveCount(0)
      await sendApproval.getByRole('button', { name: /Fast/ }).click()
      await expect(sendApproval.getByRole('button', { name: /\(Fast\)/ })).toBeVisible()
    }

    if (!BROADCAST_ENABLED) {
      await sendApproval.getByRole('button', { name: 'Reject' }).click()
      await expect(sendResultPromise).rejects.toThrow(/User rejected/)
      return
    }

    await sendApproval.getByRole('button', { name: 'Approve' }).click()

    const txHash = await sendResultPromise
    expect(typeof txHash).toBe('string')
    expect(txHash).toMatch(/^[0-9a-f]{64}$/i)
    console.log(`[funding-source-live] transparent-funded tx: ${txHash}`)

    await expect
      .poll(async () => (await getLocalTransaction(popup, txHash as string))?.fromType ?? null, {
        timeout: 30_000,
        message: 'waiting for the persisted transparent funding source'
      })
      .toBe('transparent')

    let texChainHashes: { hash: string; chain: string }[] | undefined
    if (TEX_RECIPIENT) {
      await expect
        .poll(
          async () =>
            (await getLocalTransaction(popup, txHash as string))?.chainHashes?.length ?? 0,
          {
            timeout: 30_000,
            message: 'waiting for both TEX transaction hashes to be persisted'
          }
        )
        .toBe(2)
      texChainHashes = (await getLocalTransaction(popup, txHash as string))?.chainHashes
      if (!texChainHashes || texChainHashes.length !== 2) {
        throw new Error('The persisted TEX transfer did not contain exactly two transaction hashes')
      }
      expect(texChainHashes.map(entry => entry.chain)).toEqual(['Zcash', 'Zcash'])
      expect(new Set(texChainHashes.map(entry => entry.hash)).size).toBe(2)
      expect(texChainHashes[1].hash).toBe(txHash)
    }

    if (TEX_RECIPIENT) {
      await waitForExplorerConfirmation(context, txHash as string, 20 * 60_000)
      await waitForExplorerConfirmation(context, texChainHashes[0].hash, 2 * 60_000)
    } else {
      await expect
        .poll(
          async () => {
            const transaction = await getNodeTransaction(txHash as string)
            return (transaction?.confirmations ?? 0) > 0
          },
          {
            timeout: 12 * 60_000,
            intervals: [5_000, 10_000, 20_000],
            message: 'waiting for the transparent-funded transaction to confirm'
          }
        )
        .toBe(true)

      const nodeTransaction = await getNodeTransaction(txHash as string)
      expect(nodeTransaction).not.toBeNull()
      expect(nodeTransaction?.vin.length).toBeGreaterThan(0)
      expect(
        (nodeTransaction?.vShieldedOutput.length ?? 0) > 0 ||
          (nodeTransaction?.orchard?.actions?.length ?? 0) > 0 ||
          (nodeTransaction?.ironwood?.actions?.length ?? 0) > 0
      ).toBe(true)
    }
  } finally {
    mnemonic = ''
    await closeServer(server)
  }
})
