import { createHash } from 'node:crypto'
import type { Page, Route } from '@playwright/test'

import { NEAR_NETWORKS } from '../../src/config/networks'
import { SOLANA_NETWORKS } from '../../src/config/networks'
import {
  captureScreenshot,
  expect,
  selectImportedZcashHistory,
  test,
  waitForBackgroundWalletInitialization
} from '../helpers/extension-fixtures'

const TEST_MNEMONIC_24 = `${'abandon '.repeat(23)}art`
const TEST_PASSWORD = 'solana-near-portfolio-password'
const BLOCK_HASH = '11111111111111111111111111111111'
const SOLANA_RECENT_BLOCKHASH = 'SysvarC1ock11111111111111111111111111111111'
const SOLANA_RECIPIENT = 'SysvarRent111111111111111111111111111111111'
const NEAR_RECIPIENT = 'alice.testnet'
const NEAR_NAMED_ACCOUNT = 'noir-wallet.testnet'
const NEAR_PUBLIC_KEY = 'ed25519:7FKSaAUy1QBdM4Q4BwjcBPUDmgHgXz4S4Xb2Ao11bk5x'
const NEAR_IMPLICIT_ACCOUNT = '5cd11aa446d8db56ace1bd3781673e351af6481b86c4660a8acd424973f9827b'
const NEAR_ACCESS_KEY_BLOCK_HASH = 'SysvarC1ock11111111111111111111111111111111'
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function encodeBase58(bytes: Uint8Array): string {
  const digits = [0]
  for (const byte of bytes) {
    let carry = byte
    for (let index = 0; index < digits.length; index += 1) {
      carry += digits[index] * 256
      digits[index] = carry % 58
      carry = Math.floor(carry / 58)
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = Math.floor(carry / 58)
    }
  }
  let leadingZeros = 0
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) leadingZeros += 1
  return `${BASE58_ALPHABET[0].repeat(leadingZeros)}${digits
    .reverse()
    .map(digit => BASE58_ALPHABET[digit])
    .join('')}`
}

function readSignedTransactionSignature(transactionBase64: string): string {
  const transaction = Buffer.from(transactionBase64, 'base64')
  if (transaction[0] !== 1 || transaction.byteLength < 65) {
    throw new Error('Expected one Solana transaction signature')
  }
  return encodeBase58(transaction.subarray(1, 65))
}

function readSignedNearTransactionHash(transactionBase64: string): string {
  const signed = Buffer.from(transactionBase64, 'base64')
  if (signed.byteLength <= 65) throw new Error('Invalid signed NEAR transaction')
  return encodeBase58(createHash('sha256').update(signed.subarray(0, -65)).digest())
}

async function importTestWallet(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Import wallet' }).click()
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
}

async function solanaRpc(route: Route): Promise<void> {
  const request = route.request().postDataJSON() as { id: number; method: string }
  const result =
    request.method === 'getGenesisHash'
      ? SOLANA_NETWORKS.devnet.genesisHash
      : request.method === 'getBalance'
        ? { context: { slot: 123 }, value: 2_500_000_000 }
        : null
  await route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ jsonrpc: '2.0', id: request.id, result })
  })
}

async function nearRpc(route: Route): Promise<void> {
  const request = route.request().postDataJSON() as {
    id: number
    method: string
    params?: Record<string, unknown>
  }
  let result: unknown
  if (request.method === 'status') {
    result = { chain_id: 'testnet', sync_info: { latest_block_hash: BLOCK_HASH } }
  } else if (request.method === 'genesis_config') {
    result = {
      chain_id: 'testnet',
      genesis_height: NEAR_NETWORKS.testnet.genesisHeight,
      genesis_time: NEAR_NETWORKS.testnet.genesisTime
    }
  } else if (request.method === 'block') {
    result = {
      header: {
        height: NEAR_NETWORKS.testnet.genesisHeight,
        hash: NEAR_NETWORKS.testnet.genesisHash
      }
    }
  } else if (request.method === 'query') {
    result =
      request.params?.request_type === 'view_access_key'
        ? {
            block_hash: BLOCK_HASH,
            block_height: 123,
            nonce: 41,
            permission: 'FullAccess'
          }
        : request.params?.request_type === 'view_account'
          ? {
              amount: '3000000000000000000000000',
              locked: '1000000000000000000000000',
              storage_usage: 182,
              code_hash: BLOCK_HASH,
              block_hash: BLOCK_HASH,
              block_height: 123
            }
          : null
  } else {
    result = null
  }
  await route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ jsonrpc: '2.0', id: request.id, result })
  })
}

async function nearAccountDiscovery(route: Route): Promise<void> {
  await route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      account_ids: [NEAR_NAMED_ACCOUNT, NEAR_IMPLICIT_ACCOUNT],
      public_key: NEAR_PUBLIC_KEY
    })
  })
}

async function solanaTransferRpc(route: Route, state: { signature: string | null }): Promise<void> {
  const request = route.request().postDataJSON() as {
    id: number
    method: string
    params?: unknown[]
  }
  let result: unknown
  if (request.method === 'getGenesisHash') {
    result = SOLANA_NETWORKS.devnet.genesisHash
  } else if (request.method === 'getBalance') {
    result = { context: { slot: 123 }, value: 2_500_000_000 }
  } else if (request.method === 'getLatestBlockhash') {
    result = {
      context: { slot: 123 },
      value: { blockhash: SOLANA_RECENT_BLOCKHASH, lastValidBlockHeight: 500 }
    }
  } else if (request.method === 'getBlockHeight') {
    result = 125
  } else if (request.method === 'getFeeForMessage') {
    result = { context: { slot: 123 }, value: 5_000 }
  } else if (request.method === 'simulateTransaction') {
    result = { context: { slot: 123 }, value: { err: null, unitsConsumed: 150 } }
  } else if (request.method === 'sendTransaction') {
    const transactionBase64 = request.params?.[0]
    if (typeof transactionBase64 !== 'string') throw new Error('Missing Solana transaction')
    state.signature = readSignedTransactionSignature(transactionBase64)
    result = state.signature
  } else if (request.method === 'getSignatureStatuses') {
    result = {
      context: { slot: 130 },
      value: state.signature
        ? [
            {
              slot: 129,
              confirmations: null,
              err: null,
              status: { Ok: null },
              confirmationStatus: 'finalized'
            }
          ]
        : [null]
    }
  } else {
    result = null
  }
  await route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ jsonrpc: '2.0', id: request.id, result })
  })
}

async function nearTransferRpc(
  route: Route,
  state: { transactionHash: string | null }
): Promise<void> {
  const request = route.request().postDataJSON() as {
    id: number
    method: string
    params?: Record<string, unknown> | unknown[]
  }
  let result: unknown
  if (request.method === 'status') {
    result = { chain_id: 'testnet', sync_info: { latest_block_hash: BLOCK_HASH } }
  } else if (request.method === 'genesis_config') {
    result = {
      chain_id: 'testnet',
      genesis_height: NEAR_NETWORKS.testnet.genesisHeight,
      genesis_time: NEAR_NETWORKS.testnet.genesisTime
    }
  } else if (request.method === 'block') {
    const params = request.params as Record<string, unknown>
    result =
      params.block_id === NEAR_NETWORKS.testnet.genesisHeight
        ? {
            header: {
              height: NEAR_NETWORKS.testnet.genesisHeight,
              hash: NEAR_NETWORKS.testnet.genesisHash
            }
          }
        : {
            header: {
              height: 123,
              hash: BLOCK_HASH,
              timestamp_nanosec: '18446744073709551615',
              gas_price: '100000000'
            }
          }
  } else if (request.method === 'query') {
    const params = request.params as Record<string, unknown>
    if (params.request_type === 'view_access_key') {
      result = {
        block_hash: NEAR_ACCESS_KEY_BLOCK_HASH,
        block_height: 123,
        nonce: 41,
        permission: 'FullAccess'
      }
    } else if (params.request_type === 'view_account') {
      result = {
        amount: '3000000000000000000000000',
        locked: '1000000000000000000000000',
        storage_usage: 182,
        code_hash: BLOCK_HASH,
        block_hash: BLOCK_HASH,
        block_height: 123
      }
    } else {
      result = null
    }
  } else if (request.method === 'gas_price') {
    result = { gas_price: '100000000' }
  } else if (request.method === 'EXPERIMENTAL_protocol_config') {
    result = {
      chain_id: 'testnet',
      runtime_config: {
        min_gas_purchase_price: '1000000000',
        storage_amount_per_byte: '10000000000000000000',
        transaction_costs: {
          action_receipt_creation_config: {
            execution: 108059500000,
            send_not_sir: 108059500000,
            send_sir: 108059500000
          },
          action_creation_config: {
            transfer_cost: {
              execution: 115123062500,
              send_not_sir: 115123062500,
              send_sir: 115123062500
            }
          }
        }
      }
    }
  } else if (request.method === 'broadcast_tx_async') {
    const transactionBase64 = (request.params as unknown[])[0]
    if (typeof transactionBase64 !== 'string') throw new Error('Missing NEAR transaction')
    state.transactionHash = readSignedNearTransactionHash(transactionBase64)
    result = state.transactionHash
  } else if (request.method === 'tx') {
    result = {
      final_execution_status: 'FINAL',
      transaction: { hash: state.transactionHash },
      status: { SuccessValue: '' }
    }
  } else {
    result = null
  }
  await route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ jsonrpc: '2.0', id: request.id, result })
  })
}

test('loads Solana and NEAR native balances through the real MV3 Portfolio boundary', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(120_000)
  const solanaMethods: string[] = []
  const nearMethods: string[] = []
  await context.route('https://api.devnet.solana.com/**', async route => {
    solanaMethods.push((route.request().postDataJSON() as { method: string }).method)
    await solanaRpc(route)
  })
  await context.route('https://rpc.testnet.near.org/**', async route => {
    nearMethods.push((route.request().postDataJSON() as { method: string }).method)
    await nearRpc(route)
  })
  await context.route('https://test.api.fastnear.com/**', nearAccountDiscovery)

  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(popup.getByText('Total Assets', { exact: true })).toBeVisible({ timeout: 30_000 })

  const response = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'GET_PORTFOLIO', action: 'refresh' })
  )
  expect(response).not.toHaveProperty('error')
  expect(response.result.model).toMatchObject({
    chains: [
      { chain: { family: 'zcash' } },
      { chain: { family: 'solana' }, status: 'ready' },
      { chain: { family: 'near' }, status: 'ready' }
    ]
  })
  expect(
    response.result.model.assets
      .filter(
        (asset: { metadata: { symbol: string } }) =>
          asset.metadata.symbol === 'SOL' || asset.metadata.symbol === 'NEAR'
      )
      .map((asset: { metadata: { symbol: string }; balance: { totalRaw: string } }) => [
        asset.metadata.symbol,
        asset.balance.totalRaw
      ])
  ).toEqual([
    ['SOL', '2500000000'],
    ['NEAR', '4000000000000000000000000']
  ])
  expect(solanaMethods).toContain('getGenesisHash')
  expect(solanaMethods).toContain('getBalance')
  expect(solanaMethods).not.toContain('getTokenAccountsByOwner')
  expect(nearMethods).toEqual(
    expect.arrayContaining(['status', 'genesis_config', 'block', 'query'])
  )
  const nearTarget = await popup.evaluate(async () => {
    const walletState = (await chrome.storage.local.get('wallet_state')).wallet_state?.state
    const response = await chrome.runtime.sendMessage({
      type: 'GET_ADDITIONAL_RECEIVE_TARGETS',
      walletId: walletState?.currentWalletId,
      accountId: walletState?.currentAccountId
    })
    return response.result?.targets?.find((target: { kind: string }) => target.kind === 'near')
  })
  expect(nearTarget).toMatchObject({ kind: 'near', address: NEAR_NAMED_ACCOUNT })
})

test('signs, broadcasts and finalizes a Solana Devnet transfer through the real MV3 boundary', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(120_000)
  const rpcState = { signature: null as string | null }
  await context.route('https://api.devnet.solana.com/**', route =>
    solanaTransferRpc(route, rpcState)
  )
  await context.route('https://rpc.testnet.near.org/**', nearRpc)
  await context.route('https://test.api.fastnear.com/**', nearAccountDiscovery)

  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(popup.getByText('Total Assets', { exact: true })).toBeVisible({ timeout: 30_000 })
  const portfolio = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'GET_PORTFOLIO', action: 'refresh' })
  )
  expect(portfolio).not.toHaveProperty('error')
  expect(
    portfolio.result.model.assets.some(
      (asset: { metadata: { symbol: string } }) => asset.metadata.symbol === 'SOL'
    )
  ).toBe(true)

  await popup.getByRole('button', { name: 'Send', exact: true }).click()
  await popup.getByRole('button', { name: 'Send SOL on Solana Devnet' }).click()
  await expect(popup.getByTestId('send-asset-header')).toContainText('SOL')
  await expect(popup.getByTestId('send-asset-header')).toContainText('Solana Devnet')
  const solanaMax = popup.getByRole('button', { name: 'Max' })
  await expect(solanaMax).toBeVisible()
  await expect(popup.getByText(/Beta transfer/)).toHaveCount(0)
  const solanaAmount = popup.getByRole('textbox', { name: 'SOL amount' })
  await popup.getByPlaceholder('Solana Devnet address').fill(SOLANA_RECIPIENT)
  await expect(solanaMax).toBeEnabled()
  await solanaMax.click()
  await expect(solanaAmount).toHaveValue('2.499995')
  await expect(popup.getByTestId('send-amount-card')).toContainText('Available 2.4999 SOL')
  await expect(popup.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled({
    timeout: 30_000
  })
  await captureScreenshot(popup, 'solana-native-max-available.png')
  await solanaAmount.fill('0.001')
  await expect(popup.getByTestId('send-network-fee')).toContainText('0.000005 SOL', {
    timeout: 30_000
  })
  await captureScreenshot(popup, 'solana-testnet-send-fee.png')
  await popup.getByRole('button', { name: 'Continue', exact: true }).click()

  const review = popup.getByRole('dialog', { name: 'Review Send' })
  await expect(review).toBeVisible()
  await expect(review.getByText('0.001 SOL', { exact: true })).toBeVisible()
  await expect(review.getByText('0.000005 SOL', { exact: true })).toBeVisible()
  await review.getByRole('button', { name: 'Send', exact: true }).click()

  await expect(popup.getByRole('heading', { name: 'Transaction Submitted' })).toBeVisible({
    timeout: 30_000
  })
  expect(rpcState.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/)

  await popup.evaluate(() =>
    chrome.alarms.create('solana-transaction-monitor-alarm', { when: Date.now() + 100 })
  )
  await expect(popup.getByRole('heading', { name: 'Transaction Confirmed' })).toBeVisible({
    timeout: 30_000
  })
  await expect(
    popup.locator('[data-transaction-status="final"]').getByText('Confirmed', { exact: true })
  ).toBeVisible()
})

test('signs, broadcasts and finalizes a NEAR Testnet transfer through the real MV3 boundary', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(120_000)
  const nearState = { transactionHash: null as string | null }
  await context.route('https://api.devnet.solana.com/**', solanaRpc)
  await context.route('https://rpc.testnet.near.org/**', route => nearTransferRpc(route, nearState))
  await context.route('https://test.api.fastnear.com/**', nearAccountDiscovery)

  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(popup.getByText('Total Assets', { exact: true })).toBeVisible({ timeout: 30_000 })
  const portfolio = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'GET_PORTFOLIO', action: 'refresh' })
  )
  expect(portfolio).not.toHaveProperty('error')
  expect(
    portfolio.result.model.assets.some(
      (asset: { metadata: { symbol: string } }) => asset.metadata.symbol === 'NEAR'
    )
  ).toBe(true)

  await popup.getByRole('button', { name: 'Send', exact: true }).click()
  await popup.getByRole('button', { name: 'Send NEAR on NEAR Testnet' }).click()
  await expect(popup.getByTestId('send-asset-header')).toContainText('NEAR')
  await expect(popup.getByTestId('send-asset-header')).toContainText('NEAR Testnet')
  await expect(popup.getByText(/Beta transfer/)).toHaveCount(0)
  const nearMax = popup.getByRole('button', { name: 'Max' })
  await expect(nearMax).toBeVisible()
  const nearAmount = popup.getByRole('textbox', { name: 'NEAR amount' })
  await popup.getByPlaceholder('alice.testnet or implicit account').fill(NEAR_RECIPIENT)
  await expect(nearMax).toBeEnabled()
  await nearMax.click()
  await expect(nearAmount).not.toHaveValue('')
  expect(Number(await nearAmount.inputValue())).toBeLessThan(3)
  await expect(popup.getByTestId('send-amount-card')).toContainText('Available')
  await expect(popup.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled({
    timeout: 30_000
  })
  await captureScreenshot(popup, 'near-native-max-available.png')
  await nearAmount.fill('0.001')
  await expect(popup.getByTestId('send-network-fee')).toContainText('0.000446365125 NEAR', {
    timeout: 30_000
  })
  await captureScreenshot(popup, 'near-testnet-send-fee.png')
  await popup.getByRole('button', { name: 'Continue', exact: true }).click()

  const review = popup.getByRole('dialog', { name: 'Review Send' })
  await expect(review).toBeVisible()
  await expect(review.getByText('0.001 NEAR', { exact: true })).toBeVisible()
  await expect(review.getByText('0.0004464 NEAR', { exact: true })).toBeVisible()
  await review.getByRole('button', { name: 'Send', exact: true }).click()

  await expect(popup.getByRole('heading', { name: 'Transaction Submitted' })).toBeVisible({
    timeout: 30_000
  })
  expect(nearState.transactionHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)

  await popup.evaluate(() =>
    chrome.alarms.create('near-transaction-monitor-alarm', { when: Date.now() + 100 })
  )
  await expect(popup.getByRole('heading', { name: 'Transaction Confirmed' })).toBeVisible({
    timeout: 30_000
  })
  await expect(
    popup.locator('[data-transaction-status="final"]').getByText('Confirmed', { exact: true })
  ).toBeVisible()
})
