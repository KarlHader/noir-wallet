import { chromium, type BrowserContext, type Page } from '@playwright/test'
import { Buffer } from 'buffer'
import { verifyMessage, type Hex } from 'viem'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NEAR_NETWORKS } from '../../../src/config/networks'
import {
  computePublicSubmissionId,
  type NoirPublicTxCandidate
} from '../../../src/core/services/noir-protocol/public/protocol'
import { verifyMessageSignature } from '../../../../sdk/src/chains/zcash/utils'
import { PUBLIC_SESSION_METHODS } from '../../../../sdk/src/protocol/public'
import { extensionDir, terminateExtensionServiceWorker } from '../../helpers/extension-fixtures'
import { serveSdkExample } from '../../helpers/release-default'
import {
  registerProtocolFixtures,
  expect,
  importTestWallet,
  mockBitcoinNetwork,
  mockEvmNetwork,
  mockProtocolApis,
  test,
  waitForBackgroundWalletInitialization
} from '../../helpers/protocol-wallet'

const PUBLIC_DAPP_ORIGIN = 'https://public-zcash.example'
const FIRST_PARTY_ORIGIN = 'https://app.zknoir.com'
const PUBLIC_PARENT = 'ma.private-mainnet.ref-dev-team.near'
const ACTIVE_MCA = 'public-test.multica.near'
const PUBLIC_RECEIVE_URL = 'https://apinoir.refburrow.top/receive/v1/public/txs'
const PUBLIC_QUERY_URL = 'https://apinoir.refburrow.top/v1/public/txs/**'
const PUBLIC_QUOTE_URL = 'https://privateindexer.refburrow.top/api/1click/quote'
const PUBLIC_INDEX_URL = 'https://tx.main.fastnear.com/v0/transactions'
const PUBLIC_TX_HASH = '1'.repeat(44)
const screenshotDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../e2e-output/public-demo-flow'
)

registerProtocolFixtures()

test.beforeEach(async ({ context }) => {
  await context.route('https://apinoir.refburrow.top/receive/v1/gas-fees', route =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        code: 0,
        data: {
          gas_fee_account: 'fees.near',
          gas_tokens: { 'zec.omft.near': 'ZEC' },
          batch: {
            batch_id: '1',
            completed_at: new Date().toISOString(),
            gas_units: '1000000000000',
            quotes: [{ symbol: 'ZEC', decimals: 8, fee_atomic: '34' }]
          }
        }
      })
    })
  )
  await context.route('https://assets.zknoir.com/chain/zcash.svg', route =>
    route.fulfill({
      contentType: 'image/svg+xml',
      path: path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../src/images/zec.svg'
      )
    })
  )
})

async function capturePublicScreenshot(page: Page, filename: string): Promise<void> {
  if (process.env.E2E_SCREENSHOTS !== '1') return
  if (page.url().startsWith('chrome-extension://') && page.url().includes('#approval')) {
    await page.setViewportSize({ width: 375, height: 632 })
  }
  await page.mouse.move(1, 1)
  await page.evaluate(
    () =>
      new Promise<void>(resolve => {
        window.scrollTo(0, 0)
        window.requestAnimationFrame(() => resolve())
      })
  )
  await mkdir(screenshotDirectory, { recursive: true })
  await page.screenshot({
    path: path.join(screenshotDirectory, filename),
    fullPage: true,
    animations: 'disabled'
  })
}

async function mockPublicNearReads(
  context: BrowserContext,
  candidate: () => NoirPublicTxCandidate | null = () => null,
  zecBalance: () => string = () => '125000000'
): Promise<void> {
  const handler = async (route: import('@playwright/test').Route) => {
    const request = route.request().postDataJSON() as {
      id: string | number
      method?: string
      params?: { account_id?: string; method_name?: string; args_base64?: string }
    }
    if (request.method === 'tx' && candidate()) {
      const signed = candidate()!
      const args = Buffer.from(
        JSON.stringify({
          business: {
            nonce: signed.nonce,
            deadline: signed.deadline,
            tx_requests: signed.tx_requests
          },
          signature: signed.signature,
          signer_wallet: signed.signer_wallet
        })
      ).toString('base64')
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            transaction: {
              hash: PUBLIC_TX_HASH,
              receiver_id: signed.address,
              signer_id: 'operator.near',
              actions: [{ FunctionCall: { method_name: 'exec', args } }]
            },
            final_execution_status: 'FINAL',
            status: { SuccessValue: '' },
            transaction_outcome: { outcome: { status: { SuccessReceiptId: 'receipt-1' } } },
            receipts_outcome: [{ outcome: { status: { SuccessValue: '' } } }]
          }
        })
      })
    }
    const method = request.params?.method_name
    if (request.method !== 'query' || !method) return route.fallback()
    const args = request.params?.args_base64
      ? JSON.parse(Buffer.from(request.params.args_base64, 'base64').toString('utf8'))
      : {}
    const result =
      method === 'ft_balance_of'
        ? request.params?.account_id === 'zec.omft.near'
          ? zecBalance()
          : '2500000000000000000000000'
        : method === 'get_create_mca_fee' && args.token_id === 'zec.omft.near'
          ? '30000'
          : method === 'get_nonce'
            ? '7'
            : method === 'ft_metadata'
              ? request.params?.account_id === 'wrap.near'
                ? { spec: 'ft-1.0.0', name: 'Wrapped NEAR', symbol: 'wNEAR', decimals: 24 }
                : { spec: 'ft-1.0.0', name: 'Zcash', symbol: 'ZEC', decimals: 8 }
              : undefined
    if (result === undefined) return route.fallback()
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
  await context.route(`${NEAR_NETWORKS.mainnet.rpcUrl}/**`, handler)
  await context.route(NEAR_NETWORKS.mainnet.rpcUrl, handler)
}

async function requestPublic(
  page: Page,
  method: string,
  params: unknown[] = []
): Promise<{ result?: unknown; error?: { code?: number; message?: string } }> {
  return page.evaluate(
    async ({ method, params }) => {
      const provider = (
        window as typeof window & {
          noirwallet: {
            zcash: { request: (input: { method: string; params?: unknown[] }) => Promise<unknown> }
          }
        }
      ).noirwallet.zcash
      try {
        const result = await provider.request({ method, params })
        return { result }
      } catch (cause) {
        const error = cause as { code?: number; message?: string }
        return { error: { code: error.code, message: error.message } }
      }
    },
    { method, params }
  )
}

async function connectPublicDApp(
  context: BrowserContext,
  screenshotName?: string,
  origin = PUBLIC_DAPP_ORIGIN,
  nativeSigning = false
): Promise<Page> {
  await context.route(`${origin}/**`, serveSdkExample)
  const page = await context.newPage()
  await page.goto(`${origin}/example/#noir-public`)
  await page.waitForFunction(() => Boolean(window.noirwallet?.zcash))
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled()
  if (screenshotName) {
    await capturePublicScreenshot(page, screenshotName.replace(/\.png$/, '-demo-disconnected.png'))
  }
  await page.getByLabel('Connection chain').selectOption('zcash')
  const approvalPromise = context.waitForEvent('page')
  const nativeConnection = nativeSigning
    ? page.evaluate(
        methods =>
          window.noirwallet!.multichain!.createSession({
            scopes: {
              'bip122:00040fe8ec8471911baa1db1266ea15d': {
                methods: [
                  ...methods,
                  'zcash_getAccounts',
                  'zcash_getPublicKey',
                  'zcash_signMessage'
                ],
                notifications: ['wallet_sessionChanged', 'accountsChanged']
              }
            }
          }),
        [...PUBLIC_SESSION_METHODS]
      )
    : null
  if (!nativeConnection) await page.getByRole('button', { name: 'Connect', exact: true }).click()
  const approval = await approvalPromise
  await approval.waitForURL(/#approval\?requestId=/)
  await approval.setViewportSize({ width: 375, height: 632 })
  await expect(approval.getByText('Connect to', { exact: true })).toBeVisible()
  if (screenshotName) await capturePublicScreenshot(approval, screenshotName)
  await approval.getByRole('button', { name: /^Connect/ }).click()
  if (nativeConnection) await nativeConnection
  await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible({
    timeout: 30_000
  })
  await expect(page.getByTestId('public-account')).toBeVisible({ timeout: 30_000 })
  if (!approval.isClosed()) await approval.close()
  return page
}

async function readPersistedPublicBinding(
  popup: Page,
  requestId: string
): Promise<{ signedRequest: string; submissionId: string } | null> {
  return popup.evaluate(async id => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('noir-wallet-transactions-v2-db', 1)
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error)
    })
    try {
      const records = await new Promise<unknown[]>((resolve, reject) => {
        const read = database.transaction('graphs', 'readonly').objectStore('graphs').getAll()
        read.onsuccess = () => resolve(read.result)
        read.onerror = () => reject(read.error)
      })
      for (const item of records) {
        const protocol = (
          item as {
            graph?: {
              root?: {
                intent?: {
                  protocol?: { requestId?: string; signedRequest?: string; submissionId?: string }
                }
              }
            }
          }
        ).graph?.root?.intent?.protocol
        if (protocol?.requestId === id && protocol.signedRequest && protocol.submissionId) {
          return { signedRequest: protocol.signedRequest, submissionId: protocol.submissionId }
        }
      }
      return null
    } finally {
      database.close()
    }
  }, requestId)
}

test('reads an inactive Public account without paying for activation in real MV3', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  await mockEvmNetwork(context)
  await mockBitcoinNetwork(context)
  await mockProtocolApis(context, { mcaByWallet: () => null })
  await mockPublicNearReads(context)
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)

  const dapp = await connectPublicDApp(context, 'public-01-connect-review.png')
  await capturePublicScreenshot(dapp, 'public-01a-connected.png')
  const read = await requestPublic(dapp, 'zcash_getPublicAccount')
  expect(read.error).toBeUndefined()
  expect(read.result).toMatchObject({
    chain: 'zcash-l2',
    network: 'mainnet',
    parentContractId: PUBLIC_PARENT,
    status: 'inactive',
    signingMode: 'derived',
    mcaId: null
  })
  await expect(dapp.getByTestId('public-status')).toHaveText('inactive')
  await expect(dapp.getByRole('button', { name: 'Activate public account' })).toBeEnabled()
  await popup.getByRole('tab', { name: 'Assets' }).click()
  const publicAssets = popup.getByRole('region', { name: 'Zcash activation' })
  await expect(publicAssets.getByRole('button', { name: 'Activate Public' })).toBeVisible()
  await publicAssets.scrollIntoViewIfNeeded()
  await capturePublicScreenshot(popup, 'public-02-inactive-account.png')

  const transparentAddress = await popup.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })
    const active = response?.result?.accounts?.find(
      (account: { active?: unknown }) => account.active === true
    )
    const address = active?.networks
      ?.flatMap(
        (network: { addresses?: Array<{ value?: string; scheme?: string }> }) =>
          network.addresses ?? []
      )
      .find(
        (candidate: { value?: string; scheme?: string }) =>
          candidate.scheme === 'zcash-transparent-p2pkh' && typeof candidate.value === 'string'
      )?.value
    if (!address) throw new Error('Synthetic wallet transparent address is unavailable')
    return address as string
  })
  const quoteRequests: Array<{ amount: string; dry: boolean }> = []
  await context.route(PUBLIC_QUOTE_URL, route => {
    const request = route.request().postDataJSON() as {
      amount: string
      deadline: string
      dry: boolean
    }
    quoteRequests.push({ amount: request.amount, dry: request.dry })
    if (request.amount === '30000') {
      return route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Amount is too low for bridge, try at least 132000' })
      })
    }
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        quote: {
          amountIn: '132664',
          amountOut: request.amount,
          minAmountOut: request.amount,
          deadline: request.deadline,
          depositAddress: transparentAddress
        }
      })
    })
  })
  const pageCount = context.pages().length
  await dapp.getByRole('button', { name: 'Activate public account' }).click()
  await expect(dapp.getByRole('alert')).toBeVisible({ timeout: 60_000 })
  expect(quoteRequests).toEqual([
    { amount: '30000', dry: true },
    { amount: '132000', dry: true },
    { amount: '132000', dry: false }
  ])
  expect(context.pages()).toHaveLength(pageCount)
  await capturePublicScreenshot(dapp, 'public-03-activation-unfunded.png')
  expect((await requestPublic(dapp, 'zcash_getPublicAccount')).result).toMatchObject({
    status: 'inactive',
    mcaId: null
  })
})

test('uses the Native identity for Public signing and cancels stale approval on disconnect', async ({
  context,
  popup
}) => {
  test.setTimeout(180_000)
  await mockEvmNetwork(context)
  await mockBitcoinNetwork(context)
  await mockProtocolApis(context, { mcaByWallet: () => ACTIVE_MCA })
  await mockPublicNearReads(context)
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)

  const dapp = await connectPublicDApp(
    context,
    'public-22-signing-connect.png',
    PUBLIC_DAPP_ORIGIN,
    true
  )
  const assets = await requestPublic(dapp, 'zcash_getPublicAssets')
  const account = (
    assets.result as {
      account: { publicKey: string; address: string; signingMode: 'derived' | 'legacy_index0' }
    }
  ).account
  expect(account.signingMode).toBe('legacy_index0')
  expect((await requestPublic(dapp, 'zcash_getAccounts')).result).toMatchObject({
    transparent: expect.any(String)
  })
  const options = { signingMode: account.signingMode }
  const key = await requestPublic(dapp, 'zcash_getPublicKey', [options])
  expect(key.result).toMatchObject({
    pubkey: account.publicKey,
    address: account.address,
    signingMode: account.signingMode
  })

  const message = JSON.stringify({ message: 'Noir Public identity: exact message bytes' })
  const rejectWindow = context.waitForEvent('page', { timeout: 60_000 })
  const rejected = requestPublic(dapp, 'zcash_signMessage', [message, options])
  const rejectApproval = await rejectWindow
  await rejectApproval.waitForURL(/#approval\?requestId=/)
  await rejectApproval.setViewportSize({ width: 375, height: 632 })
  await expect(rejectApproval.getByText(message, { exact: true })).toBeVisible()
  await capturePublicScreenshot(rejectApproval, 'public-23-signing-review.png')
  await rejectApproval.getByRole('button', { name: 'Reject', exact: true }).click()
  expect((await rejected).error?.message).toMatch(/reject/i)
  if (!rejectApproval.isClosed()) await rejectApproval.close()

  const signWindow = context.waitForEvent('page', { timeout: 60_000 })
  await dapp.locator('#public-sign-message').fill(message)
  await dapp.getByRole('button', { name: 'Sign message', exact: true }).click()
  const signApproval = await signWindow
  await signApproval.waitForURL(/#approval\?requestId=/)
  await signApproval.getByRole('button', { name: 'Sign message', exact: true }).click()
  await expect(dapp.locator('.public-demo-signing-result').last()).toContainText('Valid')
  const signature = await dapp
    .locator('.public-demo-signing-result')
    .last()
    .locator('code')
    .textContent()
  expect(signature).toMatch(/^[0-9a-f]{130}$/)
  expect(
    verifyMessageSignature({
      message,
      signature: signature!,
      pubkey: account.publicKey,
      address: account.address,
      network: 'mainnet'
    })
  ).toMatchObject({ valid: true, pubkeyMatch: true, addressMatch: true })
  if (!signApproval.isClosed()) await signApproval.close()

  const business = JSON.stringify(
    {
      nonce: '7',
      deadline: '0',
      tx_requests: [
        {
          FunctionCall: {
            receiver_id: 'zec.omft.near',
            function_calls: [
              {
                method_name: 'ft_transfer',
                args: JSON.stringify({ receiver_id: 'recipient.near', amount: '25000000' }),
                gas: '30000000000000',
                deposit: '1'
              }
            ]
          }
        }
      ],
      protocol_version: 2
    },
    null,
    2
  )
  const businessWindow = context.waitForEvent('page', { timeout: 60_000 })
  const businessRequest = requestPublic(dapp, 'zcash_signMessage', [business, options])
  const businessApproval = await businessWindow
  await businessApproval.waitForURL(/#approval\?requestId=/)
  await expect(businessApproval.getByText(business, { exact: true })).toBeVisible()
  await capturePublicScreenshot(businessApproval, 'public-23a-business-signing-review.png')
  await businessApproval.getByRole('button', { name: 'Sign message', exact: true }).click()
  const businessSignature = (await businessRequest).result as { signature: string; pubkey: string }
  expect(businessSignature.pubkey).toBe(account.publicKey)
  expect(
    verifyMessageSignature({
      message: business,
      signature: businessSignature.signature,
      pubkey: account.publicKey,
      network: 'mainnet'
    })
  ).toMatchObject({ valid: true, pubkeyMatch: true })
  if (!businessApproval.isClosed()) await businessApproval.close()

  const staleWindow = context.waitForEvent('page', { timeout: 60_000 })
  const staleRequest = requestPublic(dapp, 'zcash_signMessage', [
    JSON.stringify({ message: 'stale request' }),
    options
  ])
  const staleApproval = await staleWindow
  await staleApproval.waitForURL(/#approval\?requestId=/)
  const staleRequestId = new URL(staleApproval.url()).hash.match(/requestId=([^&]+)/)?.[1]
  expect(staleRequestId).toBeTruthy()
  expect(await requestPublic(dapp, 'zcash_disconnect')).toEqual({ result: null })
  const pending = await popup.evaluate(
    id => chrome.runtime.sendMessage({ type: 'GET_PENDING_REQUEST', requestId: id }),
    staleRequestId
  )
  expect(pending?.error).toMatch(/not found|expired/i)
  expect((await staleRequest).error?.message).toMatch(
    /authorization|connection|cancel|expired|reject/i
  )
  expect((await requestPublic(dapp, 'zcash_getPublicKey', [options])).error).toBeTruthy()
  if (!staleApproval.isClosed()) await staleApproval.close()
})
test('shares Native authorization through restart and rejects a late Public read after disconnect', async ({
  context,
  popup
}) => {
  test.setTimeout(180_000)
  await mockEvmNetwork(context)
  await mockBitcoinNetwork(context)
  await mockProtocolApis(context, { mcaByWallet: () => ACTIVE_MCA })
  await mockPublicNearReads(context)
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)

  const dapp = await connectPublicDApp(
    context,
    'public-14-native-connect-review.png',
    PUBLIC_DAPP_ORIGIN,
    true
  )
  const native = await requestPublic(dapp, 'zcash_getAccounts')
  expect(native.result).toMatchObject({ transparent: expect.any(String) })
  const publicAccount = await requestPublic(dapp, 'zcash_getPublicAccount')
  expect(publicAccount.result).toMatchObject({
    chain: 'zcash-l2',
    mcaId: ACTIVE_MCA,
    signingMode: 'legacy_index0'
  })
  const account = publicAccount.result as {
    publicKey: string
    address: string
    signingMode: 'derived' | 'legacy_index0'
  }
  const key = await requestPublic(dapp, 'zcash_getPublicKey', [
    { signingMode: account.signingMode }
  ])
  expect(key.result).toMatchObject({
    pubkey: account.publicKey,
    address: account.address,
    signingMode: account.signingMode
  })

  await terminateExtensionServiceWorker(context, popup)
  await waitForBackgroundWalletInitialization(popup)
  expect((await requestPublic(dapp, 'zcash_getAccounts')).result).toMatchObject({
    transparent: (native.result as { transparent: string }).transparent
  })
  const restoredAccount = await requestPublic(dapp, 'zcash_getPublicAccount')
  expect(restoredAccount.error).toBeUndefined()
  expect(restoredAccount.result).toMatchObject({
    publicKey: account.publicKey,
    signingMode: account.signingMode
  })

  await dapp.evaluate(() => {
    const state = window as typeof window & {
      noirwallet: { zcash: { on: (event: string, listener: (value: unknown) => void) => void } }
      nativeAccountsChanged: unknown[]
    }
    state.nativeAccountsChanged = []
    state.noirwallet.zcash.on('accountsChanged', value => {
      state.nativeAccountsChanged.push(value)
    })
  })
  let releaseRead: (() => void) | undefined
  const readHeld = new Promise<void>(resolve => {
    releaseRead = resolve
  })
  let markReadStarted: (() => void) | undefined
  const readStarted = new Promise<void>(resolve => {
    markReadStarted = resolve
  })
  await context.route(NEAR_NETWORKS.mainnet.rpcUrl, async route => {
    const request = route.request().postDataJSON() as {
      method?: string
      params?: { method_name?: string }
    }
    if (request.method !== 'query' || request.params?.method_name !== 'ft_balance_of') {
      return route.fallback()
    }
    markReadStarted?.()
    await readHeld
    return route.fallback()
  })
  const pendingAssets = requestPublic(dapp, 'zcash_getPublicAssets')
  try {
    await readStarted
    expect(await requestPublic(dapp, 'zcash_disconnect')).toEqual({ result: null })
  } finally {
    releaseRead?.()
  }
  const revokedRead = await pendingAssets
  expect(revokedRead.result).toBeUndefined()
  expect(revokedRead.error?.message).toMatch(/authorization|connection|reconnect/i)
  await expect
    .poll(() =>
      dapp.evaluate(
        () =>
          (window as typeof window & { nativeAccountsChanged: unknown[] }).nativeAccountsChanged
            .length
      )
    )
    .toBeGreaterThan(0)
  expect((await requestPublic(dapp, 'zcash_getAccounts')).result).toBeNull()
  expect((await requestPublic(dapp, 'zcash_getPublicAccount')).result).toBeNull()
  await capturePublicScreenshot(dapp, 'public-21-native-revoked.png')

  const reconnectWindow = context.waitForEvent('page', { timeout: 60_000 })
  const reconnectRequest = requestPublic(dapp, 'zcash_requestAccounts')
  const reconnectApproval = await reconnectWindow
  await reconnectApproval.waitForURL(/#approval\?requestId=/)
  await reconnectApproval.getByRole('button', { name: /^Connect/ }).click()
  expect((await reconnectRequest).result).toMatchObject({ transparent: expect.any(String) })
  expect((await requestPublic(dapp, 'zcash_getPublicAccount')).result).toMatchObject({
    publicKey: account.publicKey
  })
  if (!reconnectApproval.isClosed()) await reconnectApproval.close()
})
test('signs a Public FunctionCall once and recovers after response loss and restart', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  const submissions: NoirPublicTxCandidate[] = []
  let statusFound = false
  let receiptVerified = false
  await context.route(PUBLIC_INDEX_URL, route => {
    const request = route.request().postDataJSON() as { tx_hashes?: string[] }
    expect(request.tx_hashes).toEqual([PUBLIC_TX_HASH])
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        transactions: [
          {
            transaction: {
              hash: PUBLIC_TX_HASH,
              receiver_id: ACTIVE_MCA,
              signer_id: 'operator.near'
            }
          }
        ]
      })
    })
  })
  await context.route(PUBLIC_QUERY_URL, route =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(
        statusFound && submissions[0]
          ? {
              code: 0,
              data: {
                hash: computePublicSubmissionId(submissions[0]),
                status: 'COMPLETED',
                tx_hash: PUBLIC_TX_HASH
              }
            }
          : { code: 4004, message: 'submission not found' }
      )
    })
  )
  await context.route(PUBLIC_RECEIVE_URL, async route => {
    const candidate = route.request().postDataJSON() as NoirPublicTxCandidate
    submissions.push(candidate)
    expect(candidate.address).toBe(ACTIVE_MCA)
    expect(candidate.tx_requests).toEqual([
      {
        FunctionCall: {
          receiver_id: 'zec.omft.near',
          function_calls: [
            {
              method_name: 'ft_transfer',
              args: '{"receiver_id":"fees.near","amount":"6800"}',
              gas: '30000000000000',
              deposit: '1'
            }
          ]
        }
      },
      {
        FunctionCall: {
          receiver_id: 'zec.omft.near',
          function_calls: [
            {
              method_name: 'ft_transfer',
              args: '{"receiver_id":"recipient.near","amount":"25000000"}',
              gas: '30000000000000',
              deposit: '1'
            }
          ]
        }
      }
    ])
    expect(candidate.tgas).toBe(200)
    expect(candidate.signer_wallet.Zcash).toMatch(/^04[0-9a-f]{128}$/)
    expect(
      verifyMessageSignature({
        message: JSON.stringify({
          nonce: candidate.nonce,
          deadline: candidate.deadline,
          tx_requests: candidate.tx_requests
        }),
        signature: candidate.signature,
        pubkey: candidate.signer_wallet.Zcash,
        network: 'mainnet'
      })
    ).toMatchObject({ valid: true, pubkeyMatch: true })
    const persisted = await readPersistedPublicBinding(popup, 'public-mv3-rejection-1')
    if (
      !persisted ||
      persisted.signedRequest !== JSON.stringify(candidate) ||
      persisted.submissionId !== computePublicSubmissionId(candidate)
    ) {
      throw new Error('Signed Public candidate was not persisted before network submission')
    }
    return route.abort('failed')
  })
  await mockEvmNetwork(context)
  await mockBitcoinNetwork(context)
  await mockProtocolApis(context, { mcaByWallet: () => ACTIVE_MCA })
  await mockPublicNearReads(
    context,
    () => submissions[0] ?? null,
    () => (receiptVerified ? '100000000' : '125000000')
  )
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)

  const dapp = await connectPublicDApp(context, 'public-04-active-connect-review.png')
  const account = await requestPublic(dapp, 'zcash_getPublicAccount')
  expect(account.result).toMatchObject({ status: 'active', mcaId: ACTIVE_MCA })
  await expect(dapp.getByTestId('public-status')).toHaveText('active')
  await expect(dapp.getByTestId('public-account')).toContainText(ACTIVE_MCA)
  await capturePublicScreenshot(dapp, 'public-04a-active-account.png')
  const assets = await requestPublic(dapp, 'zcash_getPublicAssets')
  expect(assets.error).toBeUndefined()
  expect(assets.result).toMatchObject({
    account: {
      mcaId: ACTIVE_MCA,
      signingMode: 'legacy_index0'
    },
    assets: expect.arrayContaining([
      expect.objectContaining({ tokenId: 'zec.omft.near', decimals: 8, balanceRaw: '125000000' }),
      expect.objectContaining({
        tokenId: 'wrap.near',
        decimals: 24,
        balanceRaw: '2500000000000000000000000'
      })
    ])
  })
  await expect(dapp.locator('.public-demo-assets')).toContainText('1.25 ZEC')
  await expect(dapp.locator('.public-demo-assets')).toContainText('2.5 NEAR')
  await capturePublicScreenshot(dapp, 'public-04b-dapp-assets.png')
  await popup.getByRole('tab', { name: 'Assets' }).click()
  const publicAssets = popup.getByRole('region', { name: 'Portfolio', exact: true })
  await expect(publicAssets).toBeVisible()
  await publicAssets
    .getByRole('button', { name: 'View NEAR details on Zcash · Public', exact: true })
    .scrollIntoViewIfNeeded()
  await capturePublicScreenshot(popup, 'public-05-active-assets.png')
  await publicAssets.getByRole('button', { name: /^Filter portfolio by network:/ }).click()
  await expect(popup.getByRole('menuitemradio', { name: 'Zcash', exact: true })).toHaveCount(1)
  await capturePublicScreenshot(popup, 'public-05d-network-menu.png')
  await popup.getByRole('menuitemradio', { name: 'Zcash', exact: true }).click()
  await capturePublicScreenshot(popup, 'public-05b-network-filter.png')
  await publicAssets.getByRole('button', { name: 'Show chain view', exact: true }).click()
  await expect(
    publicAssets.getByRole('button', { name: 'Expand Zcash tokens', exact: true })
  ).toHaveCount(1)
  await publicAssets.getByRole('button', { name: 'Expand Zcash tokens', exact: true }).click()
  await capturePublicScreenshot(popup, 'public-05e-zcash-chain-assets.png')
  await publicAssets.getByRole('button', { name: 'Show token view', exact: true }).click()
  await publicAssets
    .getByRole('button', { name: 'View ZEC details on Zcash · Public', exact: true })
    .click()
  await expect(popup.getByRole('heading', { name: 'Asset' })).toBeVisible()
  await expect(popup.getByText('zec.omft.near')).toBeVisible()
  await capturePublicScreenshot(popup, 'public-05a-asset-detail.png')
  await popup.getByRole('button', { name: 'Back' }).click()
  await publicAssets
    .getByRole('button', { name: 'View NEAR details on Zcash · Public', exact: true })
    .click()
  await expect(popup.getByText('wrap.near', { exact: true })).toBeVisible()
  await capturePublicScreenshot(popup, 'public-05c-near-detail.png')
  await popup.getByRole('button', { name: 'Back' }).click()

  await dapp.getByRole('button', { name: 'FunctionCall', exact: true }).click()
  await dapp.locator('#public-requests').fill(
    JSON.stringify(
      [
        {
          FunctionCall: {
            receiver_id: 'wrap.near',
            function_calls: [
              {
                method_name: 'ft_transfer',
                args: '{"receiver_id":"recipient.near","amount":"1"}',
                gas: '30000000000000',
                deposit: '1'
              }
            ]
          }
        }
      ],
      null,
      2
    )
  )
  await capturePublicScreenshot(dapp, 'public-05c-function-call-editor.png')
  const customApprovalPromise = context.waitForEvent('page')
  await dapp.getByRole('button', { name: 'Send public transaction' }).click()
  const customApproval = await customApprovalPromise
  await customApproval.waitForURL(/#approval\?requestId=/)
  await expect(customApproval.getByText('wrap.near')).toBeVisible()
  await expect(customApproval.getByText('ft_transfer', { exact: true })).toHaveCount(2)
  await capturePublicScreenshot(customApproval, 'public-05c-function-call-review.png')
  await customApproval.getByRole('button', { name: 'Reject', exact: true }).click()
  await expect(dapp.getByRole('alert')).toContainText(/rejected/i)
  expect(submissions).toHaveLength(0)
  await dapp.getByRole('button', { name: 'New intent' }).click()
  await dapp.getByRole('button', { name: 'Token transfer', exact: true }).click()

  const requestId = 'public-mv3-rejection-1'
  await dapp.locator('#public-request-id').fill(requestId)
  await dapp.locator('#public-token').selectOption('zec.omft.near')
  await dapp.locator('#public-recipient').fill('recipient.near')
  await dapp.locator('#public-amount').fill('0.25')
  await capturePublicScreenshot(dapp, 'public-05d-transfer-filled.png')
  const approvalPromise = context.waitForEvent('page')
  await dapp.getByRole('button', { name: 'Send public transaction' }).click()
  const approval = await approvalPromise
  await approval.waitForURL(/#approval\?requestId=/)
  await approval.setViewportSize({ width: 375, height: 632 })
  await expect(approval.getByText('Review Public transaction')).toBeVisible()
  await expect(approval.getByText('zec.omft.near', { exact: true })).toHaveCount(2)
  await expect(approval.getByText('ft_transfer', { exact: true })).toHaveCount(2)
  await expect(approval.getByText('0.000068 ZEC', { exact: true })).toBeVisible()
  await capturePublicScreenshot(approval, 'public-06-transaction-review.png')
  await approval.getByRole('button', { name: 'Reject', exact: true }).click()
  await expect(dapp.getByRole('alert')).toContainText(/rejected/i)
  expect(submissions).toHaveLength(0)
  await capturePublicScreenshot(dapp, 'public-07-transaction-rejected.png')

  const approvalAgainPromise = context.waitForEvent('page')
  await dapp.getByRole('button', { name: 'Retry same request' }).click()
  const approvalAgain = await approvalAgainPromise
  await approvalAgain.waitForURL(/#approval\?requestId=/)
  await approvalAgain.setViewportSize({ width: 375, height: 632 })
  await approvalAgain.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(dapp.locator('#public-operation-id')).not.toHaveValue('')
  const signedOperationId = await dapp.locator('#public-operation-id').inputValue()
  const signed = (await requestPublic(dapp, 'zcash_getPublicTransaction', [signedOperationId]))
    .result as {
    operationId: string
    status: string
    submissionId: string
  }
  expect(signed).toMatchObject({ requestId, status: 'signed', submissionId: expect.any(String) })
  expect(submissions).toHaveLength(1)
  await capturePublicScreenshot(dapp, 'public-08-signed-before-response.png')
  await popup.getByRole('tab', { name: 'Activity' }).click()
  const pendingActivity = popup.locator(`button[data-activity-id="${signed.operationId}"]`)
  await expect(pendingActivity).toBeVisible()
  await pendingActivity.scrollIntoViewIfNeeded()
  await capturePublicScreenshot(popup, 'public-08a-pending-activity.png')
  await pendingActivity.click()
  await expect(popup.locator(`[data-activity-detail-id="${signed.operationId}"]`)).toBeVisible()
  await capturePublicScreenshot(popup, 'public-08b-pending-detail.png')
  await popup.getByRole('button', { name: 'Close', exact: true }).click()

  await dapp.getByRole('button', { name: 'Retry same request' }).click()
  await expect(dapp.locator('#public-operation-id')).toHaveValue(signed.operationId)
  const sameRequest = await requestPublic(dapp, 'zcash_getPublicTransaction', [signed.operationId])
  expect(sameRequest.result).toMatchObject({ operationId: signed.operationId })
  expect(submissions).toHaveLength(1)
  await capturePublicScreenshot(dapp, 'public-09a-request-id-replayed.png')
  const changedRequest = await requestPublic(dapp, 'zcash_sendPublicTransaction', [
    {
      requestId,
      txRequests: [
        {
          FunctionCall: {
            receiver_id: 'wrap.near',
            function_calls: [
              { method_name: 'ft_transfer', args: '{}', gas: '30000000000000', deposit: '1' }
            ]
          }
        }
      ]
    }
  ])
  expect(changedRequest.error?.message).toMatch(/requestId.*different transaction/)
  expect(submissions).toHaveLength(1)
  await capturePublicScreenshot(dapp, 'public-09-request-id-reused.png')

  await terminateExtensionServiceWorker(context, popup)
  await waitForBackgroundWalletInitialization(popup)
  await dapp.getByRole('button', { name: 'Check status' }).click()
  await expect(dapp.locator('.public-demo-transaction')).toContainText('signed')
  const recovered = await requestPublic(dapp, 'zcash_getPublicTransaction', [signed.operationId])
  expect(recovered.error).toBeUndefined()
  expect(recovered.result).toMatchObject({ operationId: signed.operationId, status: 'signed' })
  expect(submissions).toHaveLength(1)
  await capturePublicScreenshot(dapp, 'public-10-worker-restarted.png')

  receiptVerified = true
  statusFound = true
  await dapp.getByRole('button', { name: 'Check status' }).click()
  await expect(dapp.locator('.public-demo-transaction')).toContainText('final')
  await expect(dapp.locator('.public-demo-assets')).toContainText('1 ZEC')
  const final = await requestPublic(dapp, 'zcash_getPublicTransaction', [signed.operationId])
  expect(final.result).toMatchObject({
    operationId: signed.operationId,
    status: 'final',
    transactionHash: PUBLIC_TX_HASH
  })
  await capturePublicScreenshot(dapp, 'public-10a-final-result.png')
  await capturePublicScreenshot(dapp, 'public-10b-dapp-updated-assets.png')
  await dapp.getByRole('button', { name: 'Refresh' }).click()
  await expect(dapp.locator('.public-demo-assets')).toContainText('1 ZEC')
  const refreshedAssets = await requestPublic(dapp, 'zcash_getPublicAssets')
  expect(refreshedAssets.result).toMatchObject({
    assets: expect.arrayContaining([
      expect.objectContaining({
        tokenId: 'zec.omft.near',
        decimals: 8,
        balanceRaw: '100000000',
        status: 'fresh'
      }),
      expect.objectContaining({
        tokenId: 'wrap.near',
        decimals: 24,
        balanceRaw: '2500000000000000000000000',
        status: 'fresh'
      })
    ])
  })
  expect(submissions).toHaveLength(1)
  await popup.getByRole('tab', { name: 'Assets' }).click()
  const updatedPublicAssets = popup.getByRole('region', { name: 'Portfolio', exact: true })
  await updatedPublicAssets.getByRole('button', { name: 'Refresh portfolio', exact: true }).click()
  const zecAsset = updatedPublicAssets.getByRole('button', {
    name: 'View ZEC details on Zcash · Public',
    exact: true
  })
  await expect(zecAsset).toContainText('1 ZEC')
  await zecAsset.scrollIntoViewIfNeeded()
  await capturePublicScreenshot(popup, 'public-11-updated-assets.png')

  await popup.getByRole('tab', { name: 'Activity' }).click()
  const activity = popup.locator(`button[data-activity-id="${signed.operationId}"]`)
  await expect(activity).toHaveAttribute('data-activity-status', 'final', { timeout: 20_000 })
  await activity.scrollIntoViewIfNeeded()
  await activity.click()
  const detail = popup.locator(`[data-activity-detail-id="${signed.operationId}"]`)
  const statusValue = detail.locator('[data-activity-status-value]')
  await expect(statusValue).toBeVisible()
  await statusValue.scrollIntoViewIfNeeded()
  await expect(statusValue).toBeInViewport()
  await capturePublicScreenshot(popup, 'public-12-verified-final.png')

  const traceDownloadPromise = dapp.waitForEvent('download')
  await dapp.getByRole('button', { name: 'Export trace' }).click()
  const traceDownload = await traceDownloadPromise
  expect(traceDownload.suggestedFilename()).toBe('noir-public-trace.json')
  await mkdir(screenshotDirectory, { recursive: true })
  const tracePath = path.join(screenshotDirectory, 'noir-public-trace.json')
  await traceDownload.saveAs(tracePath)
  const exported = JSON.parse(await readFile(tracePath, 'utf8')) as {
    schema: string
    build: Record<string, unknown>
    entries: Array<Record<string, unknown>>
  }
  expect(Object.keys(exported).sort()).toEqual(['build', 'entries', 'schema'])
  expect(exported.schema).toBe('noir-public-demo-trace-v1')
  expect(Object.keys(exported.build).sort()).toEqual([
    'exampleVersion',
    'revision',
    'sdkVersion',
    'walletVersion'
  ])
  expect(exported.entries.length).toBeGreaterThan(0)
  const allowedMethods = new Set([
    'getSession',
    'createSession',
    'revokeSession',
    'wallet_sessionChanged',
    'chainChanged',
    'getPublicKey',
    'signMessage',
    'activatePublicAccount',
    'getPublicAssets',
    'sendPublicTransaction',
    'getPublicTransaction',
    'accountsChanged'
  ])
  const allowedOutcomes = new Set(['started', 'success', 'error', 'event'])
  for (const entry of exported.entries) {
    expect(
      Object.keys(entry).every(key =>
        ['sequence', 'callId', 'at', 'method', 'outcome', 'elapsedMs', 'code', 'status'].includes(
          key
        )
      )
    ).toBe(true)
    expect(allowedMethods.has(String(entry.method))).toBe(true)
    expect(allowedOutcomes.has(String(entry.outcome))).toBe(true)
    if (entry.status !== undefined) {
      expect(
        [
          'inactive',
          'activating',
          'active',
          'signed',
          'broadcast',
          'confirming',
          'final',
          'failed',
          'disconnected'
        ].includes(String(entry.status))
      ).toBe(true)
    }
  }
  const traceText = JSON.stringify(exported)
  for (const secret of [
    'recipient.near',
    ACTIVE_MCA,
    PUBLIC_TX_HASH,
    requestId,
    submissions[0].signature,
    submissions[0].signer_wallet.Zcash,
    (account.result as { address: string }).address
  ])
    expect(traceText).not.toContain(secret)
  await capturePublicScreenshot(dapp, 'public-12c-trace-exported.png')

  const firstIdentity = (account.result as { publicKey: string }).publicKey
  const freshContext = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: process.env.APPROVAL_WINDOW_E2E !== '1',
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
  })
  try {
    await mockEvmNetwork(freshContext)
    await mockBitcoinNetwork(freshContext)
    await freshContext.route('https://assets.zknoir.com/chain/zcash.svg', route =>
      route.fulfill({
        contentType: 'image/svg+xml',
        path: path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          '../../../src/images/zec.svg'
        )
      })
    )
    await mockProtocolApis(freshContext, { mcaByWallet: () => ACTIVE_MCA })
    await mockPublicNearReads(
      freshContext,
      () => null,
      () => '100000000'
    )
    const worker =
      freshContext.serviceWorkers()[0] ?? (await freshContext.waitForEvent('serviceworker'))
    const freshExtensionId = new URL(worker.url()).host
    const freshPopup = await freshContext.newPage()
    await freshPopup.setViewportSize({ width: 375, height: 600 })
    await freshPopup.goto(`chrome-extension://${freshExtensionId}/index.html`)
    await waitForBackgroundWalletInitialization(freshPopup)
    await importTestWallet(freshPopup)
    const reimported = await connectPublicDApp(freshContext)
    const secondAccount = await requestPublic(reimported, 'zcash_getPublicAccount')
    expect(secondAccount.result).toMatchObject({ publicKey: firstIdentity, mcaId: ACTIVE_MCA })
    await reimported.locator('#public-operation-id').fill(signed.operationId)
    await reimported.getByRole('button', { name: 'Check status' }).click()
    await expect(reimported.locator('.public-demo-transaction')).toContainText(
      'No transaction found.'
    )
    expect(
      (await requestPublic(reimported, 'zcash_getPublicTransaction', [signed.operationId])).result
    ).toBeNull()
    await freshPopup.getByRole('tab', { name: 'Assets' }).click()
    const freshAssets = freshPopup.getByRole('region', { name: 'Portfolio', exact: true })
    await expect(freshAssets).toBeVisible()
    await freshAssets
      .getByRole('button', { name: 'View NEAR details on Zcash · Public', exact: true })
      .scrollIntoViewIfNeeded()
    await expect(
      freshAssets.getByRole('button', { name: 'View ZEC details on Zcash · Public', exact: true })
    ).toContainText('1 ZEC')
    await freshAssets.getByRole('button', { name: /^Filter portfolio by network:/ }).click()
    await freshPopup.getByRole('menuitemradio', { name: 'Zcash', exact: true }).click()
    await capturePublicScreenshot(freshPopup, 'public-13-fresh-profile-import.png')
  } finally {
    await freshContext.close()
  }
})

async function importPublicEvmAccount(popup: Page): Promise<void> {
  await importTestWallet(popup)
  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  const accountManager = popup.getByRole('button', { name: 'Accounts', exact: true })
  if (await accountManager.isVisible()) await accountManager.click()
  await popup.getByRole('button', { name: 'Add Wallet', exact: true }).click()
  await popup.getByRole('button', { name: 'Import Wallet', exact: true }).click()
  await popup.getByRole('button', { name: 'Private Key', exact: true }).click()
  await popup.getByLabel('Wallet name').fill('Public EVM fixture')
  await popup.getByLabel('Private key', { exact: true }).fill(`0x${'00'.repeat(31)}01`)
  await popup.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(popup.getByText('EVM address preview', { exact: true })).toBeVisible()
  await popup.getByRole('button', { name: 'Import wallet', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible()
}

test('EVM Public connects a locked private-key account through a scoped session and signs its own transactions', async ({
  context,
  popup
}) => {
  test.setTimeout(180_000)
  const address = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf'
  await mockEvmNetwork(context)
  await mockBitcoinNetwork(context)
  await mockProtocolApis(context, { mcaByWallet: () => ACTIVE_MCA })
  await mockPublicNearReads(context)
  let candidate: NoirPublicTxCandidate | null = null
  await context.route(PUBLIC_RECEIVE_URL, async route => {
    candidate = route.request().postDataJSON() as NoirPublicTxCandidate
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: { hash: computePublicSubmissionId(candidate) } })
    })
  })
  await context.route(PUBLIC_QUERY_URL, route => route.fulfill({ status: 404, body: '{}' }))
  await waitForBackgroundWalletInitialization(popup)
  await importPublicEvmAccount(popup)
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'WALLET_LOCKED' }))

  const origin = 'https://public-evm.example'
  await context.route(`${origin}/**`, serveSdkExample)
  const dapp = await context.newPage()
  await dapp.goto(`${origin}/example/#noir-public`)
  await expect(dapp.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled()
  const unlockOpened = context.waitForEvent('page')
  await dapp.getByRole('button', { name: 'Connect', exact: true }).click()
  const unlock = await unlockOpened
  await unlock.waitForURL(/#unlock/)
  await unlock.getByPlaceholder('Enter Password').fill('protocol-wallet-source-password')
  const approvalOpened = context.waitForEvent('page')
  await unlock.getByRole('button', { name: 'Unlock', exact: true }).click()
  const approval = await approvalOpened
  await approval.waitForURL(/#approval\?requestId=/)
  await approval.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(dapp.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible()
  await expect(dapp.getByTestId('public-account')).toContainText(address, { ignoreCase: true })
  await expect(dapp.locator('.public-demo-assets')).toContainText('1.25 ZEC')

  const invoke = async (method: string, params: unknown[] = [], scope = 'eip155:1') =>
    dapp.evaluate(
      async ({ method, params, scope }) => {
        try {
          const result = await window.noirwallet!.multichain!.invokeMethod({
            scope,
            request: { method, params }
          })
          return { result }
        } catch (cause) {
          const error = cause as { code?: number; message?: string }
          return { error: { code: error.code, message: error.message } }
        }
      },
      { method, params, scope }
    )
  expect((await invoke('noir_getPublicAssets', [], 'eip155:999999')).error?.code).toBe(4100)
  const message = JSON.stringify({ message: 'Public EVM fixture identity' })
  const signatureApprovalOpened = context.waitForEvent('page')
  const signing = invoke('noir_signMessage', [message])
  const signatureApproval = await signatureApprovalOpened
  await signatureApproval.waitForURL(/#approval\?requestId=/)
  await signatureApproval.getByRole('button', { name: 'Sign message', exact: true }).click()
  const signResult = await signing
  expect(signResult.error).toBeUndefined()
  const signed = signResult.result as { signature: Hex; address: Hex; signingMode: string }
  expect(signed.address.toLowerCase()).toBe(address)
  expect(signed.signingMode).toBe('evm')
  expect(
    await verifyMessage({ address: address as Hex, message, signature: signed.signature })
  ).toBe(true)

  const intent = {
    requestId: 'evm-public-fixture',
    txRequests: [
      {
        FunctionCall: {
          receiver_id: 'wrap.near',
          function_calls: [
            {
              method_name: 'ft_transfer',
              args: '{"receiver_id":"recipient.near","amount":"1"}',
              gas: '30000000000000',
              deposit: '1'
            }
          ]
        }
      }
    ]
  }
  const transactionApprovalOpened = context.waitForEvent('page')
  const sending = invoke('noir_sendPublicTransaction', [intent])
  const transactionApproval = await transactionApprovalOpened
  await transactionApproval.waitForURL(/#approval\?requestId=/)
  await transactionApproval.getByRole('button', { name: 'Confirm', exact: true }).click()
  const submitted = await sending
  expect(submitted.error).toBeUndefined()
  expect(candidate).not.toBeNull()
  expect(candidate!.signer_wallet).toEqual({ EVM: address.slice(2) })
  const operation = submitted.result as { operationId: string }
  expect((await invoke('noir_getPublicTransaction', [operation.operationId])).result).toMatchObject(
    { operationId: operation.operationId }
  )

  await dapp.reload()
  await expect(dapp.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible()
  await expect(dapp.getByTestId('public-account')).toContainText(address, { ignoreCase: true })
  await dapp.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await expect(dapp.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled()
  expect((await invoke('noir_getPublicAssets')).error?.code).toBe(4100)
})

test('EVM Public activation binds the reviewed quote to one native payment', async ({
  context,
  popup
}) => {
  test.setTimeout(180_000)
  const address = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf'
  const deposit = `0x${'3'.repeat(40)}`
  const evm = await mockEvmNetwork(context, { allowBroadcast: true })
  await mockBitcoinNetwork(context)
  await mockProtocolApis(context, {
    mcaByWallet: () => (evm.getBroadcastCount() ? ACTIVE_MCA : null)
  })
  await mockPublicNearReads(context)
  await context.route(PUBLIC_QUOTE_URL, async route => {
    const request = route.request().postDataJSON()
    expect(request.originAsset).toBe('nep141:eth.omft.near')
    expect(request.refundTo.toLowerCase()).toBe(address)
    expect(JSON.parse(request.customRecipientMsg).w).toEqual([{ EVM: address.slice(2) }])
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        quote: {
          amountIn: '100000000000000',
          amountOut: request.amount,
          minAmountOut: request.amount,
          deadline: request.deadline,
          depositAddress: deposit
        }
      })
    })
  })
  await waitForBackgroundWalletInitialization(popup)
  await importPublicEvmAccount(popup)
  const origin = 'https://public-evm-activation.example'
  await context.route(`${origin}/**`, serveSdkExample)
  const dapp = await context.newPage()
  await dapp.goto(`${origin}/example/#noir-public`)
  await expect(dapp.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled()
  const connectOpened = context.waitForEvent('page')
  await dapp.getByRole('button', { name: 'Connect', exact: true }).click()
  const connect = await connectOpened
  await connect.waitForURL(/#approval\?requestId=/)
  await connect.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(dapp.getByTestId('public-status')).toHaveText('inactive')
  for (const decision of ['Reject', 'Confirm']) {
    const reviewOpened = context.waitForEvent('page')
    await dapp.getByRole('button', { name: 'Activate public account', exact: true }).click()
    const review = await reviewOpened
    await review.waitForURL(/#approval\?requestId=/)
    await expect(review.getByText('ETH', { exact: false }).first()).toBeVisible()
    const paymentReviewOpened = context.waitForEvent('page')
    await review.getByRole('button', { name: 'Pay & activate', exact: true }).click()
    const paymentReview = await paymentReviewOpened
    await paymentReview.waitForURL(/#approval\?requestId=/)
    await paymentReview.getByRole('button', { name: decision, exact: true }).click()
    if (decision === 'Reject') {
      await expect(dapp.getByRole('alert')).toBeVisible()
      await expect(dapp.getByTestId('public-status')).toHaveText('inactive')
      expect(evm.getBroadcastCount()).toBe(0)
    }
  }
  // Native submission is intercepted by mockEvmNetwork, never a live RPC.
  await expect
    .poll(
      async () => evm.getBroadcastCount() === 1 || (await dapp.getByRole('alert').isVisible()),
      { timeout: 30_000 }
    )
    .toBe(true)
  await expect(dapp.getByRole('alert')).not.toBeVisible()
  expect(evm.getBroadcastCount()).toBe(1)
  await expect(dapp.getByTestId('public-status')).toHaveText('active', { timeout: 30_000 })
  expect(evm.getBroadcastValues()).toEqual([100000000000000n])
  const account = await dapp.evaluate(() =>
    window.noirwallet!.multichain!.invokeMethod({
      scope: 'eip155:1',
      request: { method: 'noir_activatePublicAccount' }
    })
  )
  expect(account).toMatchObject({ status: 'active', mcaId: ACTIVE_MCA })
  expect(evm.getBroadcastCount()).toBe(1)
})

test('EVM Public auto selection uses a funded chain of the active multichain account', async ({
  context,
  popup
}) => {
  test.setTimeout(120_000)
  const evm = await mockEvmNetwork(context)
  await mockBitcoinNetwork(context)
  await mockProtocolApis(context, { mcaByWallet: () => null })
  await mockPublicNearReads(context)
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  const origin = 'https://public-auto.example'
  await context.route(`${origin}/**`, serveSdkExample)
  const dapp = await context.newPage()
  await dapp.goto(`${origin}/example/#noir-public`)
  await expect(dapp.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled()
  const approvalOpened = context.waitForEvent('page')
  await dapp.getByRole('button', { name: 'Connect', exact: true }).click()
  const approval = await approvalOpened
  await approval.waitForURL(/#approval\?requestId=/)
  await approval.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(dapp.getByTestId('public-account')).toBeVisible({ timeout: 30_000 })
  const session = await dapp.evaluate(() => window.noirwallet!.multichain!.getSession())
  expect(Object.keys(session!.scopes)).toContain('bip122:00040fe8ec8471911baa1db1266ea15d')
  expect(Object.keys(session!.scopes)).toContain('eip155:1')
  const selected = await dapp.evaluate(() =>
    window.noirwallet!.multichain!.invokeMethod({
      scope: 'eip155:1',
      request: { method: 'noir_selectPublicAccount' }
    })
  )
  expect(selected).toMatchObject({
    scope: 'eip155:1',
    account: { chain: 'evm', status: 'inactive' }
  })
  expect(evm.getBroadcastCount()).toBe(0)
})
