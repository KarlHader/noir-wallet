import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { BrowserContext, Page } from '@playwright/test'

import {
  expect,
  selectImportedZcashHistory,
  test,
  waitForBackgroundWalletInitialization
} from '../../helpers/extension-fixtures'
import { buildSolanaNativeTransfer } from '../../../src/infrastructure/chains/solana/solana-transaction-builder'

const SOLANA_AMOUNT_RAW = '1000000'
const NEAR_AMOUNT_RAW = '1000000000000000000000'
const SOLANA_RPC_URL = 'https://api.devnet.solana.com'
const SOLANA_CHAIN_ID = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
const NEAR_RPC_URL = 'https://rpc.testnet.near.org'
const BROADCAST_ENABLED = process.env.NOIR_SOLANA_NEAR_TESTNET_BROADCAST === '1'
const LIVE_CHAIN = process.env.NOIR_SOLANA_NEAR_LIVE_CHAIN ?? 'all'

interface LiveWalletFixture {
  readonly mnemonic: string
  readonly password: string
  readonly solanaAddress: string
  readonly solanaRecipientAddress: string
  readonly nearAccountId: string
}

function loadLiveWalletFixture(): LiveWalletFixture | null {
  const fixturePath = process.env.NOIR_SOLANA_NEAR_TESTNET_WALLET_FILE
  if (!fixturePath) return null
  if (!path.isAbsolute(fixturePath)) {
    throw new Error('The live Solana/NEAR wallet fixture path must be absolute')
  }
  const stat = lstatSync(fixturePath)
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 16_384) {
    throw new Error('The live Solana/NEAR wallet fixture must be a bounded regular file')
  }
  if ((stat.mode & 0o777) !== 0o600) {
    throw new Error('The live Solana/NEAR wallet fixture must use mode 0600')
  }
  const value = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>
  if (
    Object.keys(value).sort().join(',') !==
      'mnemonic,nearAccountId,networks,password,schemaVersion,solanaAddress,solanaRecipientAddress' ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.networks) ||
    value.networks.join(',') !== 'solana-devnet,near-testnet' ||
    typeof value.mnemonic !== 'string' ||
    value.mnemonic.trim().split(/\s+/).length !== 24 ||
    typeof value.password !== 'string' ||
    value.password.length < 8 ||
    value.password.length > 64 ||
    typeof value.solanaAddress !== 'string' ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.solanaAddress) ||
    typeof value.solanaRecipientAddress !== 'string' ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.solanaRecipientAddress) ||
    value.solanaRecipientAddress === value.solanaAddress ||
    typeof value.nearAccountId !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.nearAccountId)
  ) {
    throw new Error('Invalid live Solana/NEAR wallet fixture')
  }
  return {
    mnemonic: value.mnemonic,
    password: value.password,
    solanaAddress: value.solanaAddress,
    solanaRecipientAddress: value.solanaRecipientAddress,
    nearAccountId: value.nearAccountId
  }
}

const liveWallet = loadLiveWalletFixture()

test.use({ screenshot: 'off', trace: 'off' })
test.skip(!liveWallet, 'NOIR_SOLANA_NEAR_TESTNET_WALLET_FILE is not configured')
test.skip(!BROADCAST_ENABLED, 'NOIR_SOLANA_NEAR_TESTNET_BROADCAST=1 is required')

async function importLiveWallet(page: Page, wallet: LiveWalletFixture): Promise<void> {
  await page.getByRole('button', { name: 'Import wallet' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.locator('input[type="text"]').first().fill(wallet.mnemonic)
  await page.getByRole('button', { name: 'Continue' }).click()
  await selectImportedZcashHistory(page, { birthdayHeight: 3_000_000 })
  await page.getByPlaceholder('8–64 characters').fill(wallet.password)
  await page.getByPlaceholder('Confirm password').fill(wallet.password)
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Import Wallet' }).click()
  await expect(page.getByRole('heading', { name: 'Congratulations!' })).toBeVisible({
    timeout: 60_000
  })
}

async function prepareWallet(page: Page, extensionId: string, wallet: LiveWalletFixture) {
  await waitForBackgroundWalletInitialization(page)
  await importLiveWallet(page, wallet)
  await page.goto(
    `chrome-extension://${extensionId}/tests/extension/credential-repository-integration.html`
  )
  await expect
    .poll(() => page.evaluate(() => Boolean(window.credentialRepositoryIntegration)))
    .toBe(true)
  const provisioning = await page.evaluate(() =>
    window.credentialRepositoryIntegration!.inspectProductionV2Provisioning()
  )
  expect(provisioning.chainAccounts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        chainId: expect.stringMatching(/^solana:/),
        identity: wallet.solanaAddress
      }),
      expect.objectContaining({ chainId: 'near:testnet', identity: wallet.nearAccountId })
    ])
  )
  await page.goto(`chrome-extension://${extensionId}/index.html`)
}

async function rpc(url: string, method: string, params: unknown): Promise<unknown> {
  let failure: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(20_000)
      })
      if (!response.ok) throw new Error(`Live RPC returned HTTP ${response.status}`)
      const value = (await response.json()) as {
        readonly result?: unknown
        readonly error?: { readonly code?: unknown; readonly message?: unknown }
      }
      if (value.error !== undefined || !Object.prototype.hasOwnProperty.call(value, 'result')) {
        const code = typeof value.error?.code === 'number' ? ` ${value.error.code}` : ''
        const message = typeof value.error?.message === 'string' ? `: ${value.error.message}` : ''
        throw new Error(`Live RPC ${method} failed${code}${message}`)
      }
      return value.result
    } catch (error) {
      failure = error
      if (attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt))
      }
    }
  }
  throw failure
}

async function openAuthorizedDApp(
  context: BrowserContext,
  providerId: 'solana' | 'near',
  expectedAddress: string
): Promise<Page> {
  const origin = `https://${providerId}-dapp.example`
  await context.route(`${origin}/**`, route =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><title>${providerId} test dApp</title></head><body>dApp</body></html>`
    })
  )
  const dapp = await context.newPage()
  await dapp.goto(`${origin}/connect`)
  await dapp.waitForFunction(chain => {
    const wallet = (
      window as typeof window & {
        noirwallet?: Record<string, { connect?: unknown; requestSignIn?: unknown }>
      }
    ).noirwallet
    return chain === 'solana'
      ? typeof wallet?.[chain]?.connect === 'function'
      : typeof wallet?.[chain]?.requestSignIn === 'function'
  }, providerId)
  const approvalPromise = context.waitForEvent('page', { timeout: 60_000 })
  const connectPromise = dapp.evaluate(async chain => {
    const wallet = (window as typeof window & { noirwallet: Record<string, unknown> }).noirwallet
    if (chain === 'solana') {
      const provider = wallet.solana as {
        connect(): Promise<{ publicKey: { toString(): string } }>
      }
      return (await provider.connect()).publicKey.toString()
    }
    const provider = wallet.near as { requestSignIn(): Promise<{ accountId: string }> }
    return (await provider.requestSignIn()).accountId
  }, providerId)
  const approval = await approvalPromise
  await approval.waitForURL(/#approval\?requestId=/)
  await approval.setViewportSize({ width: 375, height: 632 })
  await expect(
    approval.getByRole('heading', {
      name: providerId === 'solana' ? 'Connect to Solana Devnet' : 'Connect to NEAR Testnet'
    })
  ).toBeVisible()
  await expect(approval.getByText(origin, { exact: true })).toBeVisible()
  await approval.getByRole('button', { name: /^Connect/ }).click()
  await expect(connectPromise).resolves.toBe(expectedAddress)
  return dapp
}

async function failIfRequestSettlesBeforeApproval(request: Promise<unknown>): Promise<Page> {
  await request
  throw new Error('The dApp request completed without opening an approval page')
}

async function approveDAppTransaction(
  providerId: 'solana' | 'near',
  approvalPromise: Promise<Page>
): Promise<void> {
  const approval = await approvalPromise
  await approval.waitForURL(/#approval\?requestId=/)
  await approval.setViewportSize({ width: 375, height: 632 })
  await expect(approval.getByText('Review transaction', { exact: true })).toBeVisible()
  await expect(
    approval.getByRole('heading', { name: `${providerId}-dapp.example`, exact: true })
  ).toBeVisible()
  await approval.getByRole('button', { name: 'Confirm', exact: true }).click()
}

test('connects a Solana dApp and broadcasts a finalized Devnet transfer through approval', async ({
  context,
  popup,
  extensionId
}) => {
  test.skip(LIVE_CHAIN !== 'all' && LIVE_CHAIN !== 'solana', 'Solana live test is not selected')
  test.setTimeout(240_000)
  if (!liveWallet) throw new Error('The live Solana/NEAR fixture was not loaded')
  await prepareWallet(popup, extensionId, liveWallet)
  const balance = (await rpc(SOLANA_RPC_URL, 'getBalance', [
    liveWallet.solanaAddress,
    { commitment: 'finalized' }
  ])) as { readonly value: number }
  expect(balance.value).toBeGreaterThan(Number(SOLANA_AMOUNT_RAW) + 5_000)
  const dapp = await openAuthorizedDApp(context, 'solana', liveWallet.solanaAddress)
  const latest = (await rpc(SOLANA_RPC_URL, 'getLatestBlockhash', [
    { commitment: 'finalized' }
  ])) as { readonly value: { readonly blockhash: string } }
  const transaction = buildSolanaNativeTransfer({
    chainId: SOLANA_CHAIN_ID,
    sender: liveWallet.solanaAddress,
    recipient: liveWallet.solanaRecipientAddress,
    recentBlockhash: latest.value.blockhash,
    lamports: SOLANA_AMOUNT_RAW
  })
  const approvalPagePromise = context.waitForEvent('page', { timeout: 60_000 })
  const transactionPromise = dapp.evaluate(async transactionBase64 => {
    const provider = (
      window as typeof window & {
        noirwallet: {
          solana: {
            signAndSendTransaction(transaction: Uint8Array): Promise<{ signature: string }>
          }
        }
      }
    ).noirwallet.solana
    const transaction = Uint8Array.from(atob(transactionBase64), character =>
      character.charCodeAt(0)
    )
    return (await provider.signAndSendTransaction(transaction)).signature
  }, transaction.transactionBase64)
  await approveDAppTransaction(
    'solana',
    Promise.race([approvalPagePromise, failIfRequestSettlesBeforeApproval(transactionPromise)])
  )
  const transactionHash = await transactionPromise
  expect(transactionHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/)
  console.log(`[solana-devnet-dapp-live] broadcast tx: ${transactionHash}`)
  await expect
    .poll(
      async () => {
        try {
          const statuses = (await rpc(SOLANA_RPC_URL, 'getSignatureStatuses', [
            [transactionHash],
            { searchTransactionHistory: true }
          ])) as {
            readonly value: ReadonlyArray<{
              readonly err: unknown
              readonly confirmationStatus?: string
            } | null>
          }
          return statuses.value[0]
        } catch {
          return null
        }
      },
      { timeout: 120_000, intervals: [2_000] }
    )
    .toMatchObject({ err: null, confirmationStatus: 'finalized' })
  await dapp.close()
})

test('connects a NEAR dApp and broadcasts a finalized Testnet transfer through approval', async ({
  context,
  popup,
  extensionId
}) => {
  test.skip(LIVE_CHAIN !== 'all' && LIVE_CHAIN !== 'near', 'NEAR live test is not selected')
  test.setTimeout(240_000)
  if (!liveWallet) throw new Error('The live Solana/NEAR fixture was not loaded')
  await prepareWallet(popup, extensionId, liveWallet)
  const account = (await rpc(NEAR_RPC_URL, 'query', {
    request_type: 'view_account',
    finality: 'final',
    account_id: liveWallet.nearAccountId
  })) as { readonly amount: string }
  expect(BigInt(account.amount)).toBeGreaterThan(BigInt(NEAR_AMOUNT_RAW) * 2n)
  const dapp = await openAuthorizedDApp(context, 'near', liveWallet.nearAccountId)
  const approvalPagePromise = context.waitForEvent('page', { timeout: 60_000 })
  const signedTransactionPromise = dapp.evaluate(
    async input => {
      const provider = (
        window as typeof window & {
          noirwallet: {
            near: {
              signTransaction(params: unknown): Promise<string>
            }
          }
        }
      ).noirwallet.near
      const signedTx = await provider.signTransaction({
        receiverId: input.receiverId,
        actions: [{ type: 'Transfer', params: { deposit: input.amountRaw } }]
      })
      return signedTx
    },
    { receiverId: liveWallet.nearAccountId, amountRaw: NEAR_AMOUNT_RAW }
  )
  await approveDAppTransaction(
    'near',
    Promise.race([
      approvalPagePromise,
      failIfRequestSettlesBeforeApproval(signedTransactionPromise)
    ])
  )
  const signedTransaction = await signedTransactionPromise
  const transactionHash = await rpc(NEAR_RPC_URL, 'broadcast_tx_async', [signedTransaction])
  expect(typeof transactionHash).toBe('string')
  expect(transactionHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
  console.log(`[near-testnet-dapp-live] broadcast tx: ${transactionHash}`)
  await expect(
    rpc(NEAR_RPC_URL, 'tx', {
      tx_hash: transactionHash,
      sender_account_id: liveWallet.nearAccountId,
      wait_until: 'FINAL'
    })
  ).resolves.toMatchObject({
    final_execution_status: 'FINAL',
    transaction: { hash: transactionHash },
    status: { SuccessValue: expect.any(String) }
  })
  await dapp.close()
})
