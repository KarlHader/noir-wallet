import { chromium, type BrowserContext, type Page } from '@playwright/test'
import { Buffer } from 'buffer'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NEAR_NETWORKS } from '../../../src/config/networks'
import {
  computePublicSubmissionId,
  type NoirPublicTxCandidate
} from '../../../src/core/services/noir-protocol/public/protocol'
import { verifyMessageSignature } from '../../../../sdk/src/chains/zcash/utils'
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
        gas_fee_account: 'fees.near',
        gas_tokens: { 'zec.omft.near': 'ZEC' },
        minimum_fees: { ZEC: '34' },
        batch: {
          batch_id: '1',
          completed_at: new Date().toISOString(),
          gas_units: '1000000000000',
          quotes: [{ symbol: 'ZEC', decimals: 8, fee_atomic: '34' }]
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
  origin = PUBLIC_DAPP_ORIGIN
): Promise<Page> {
  await context.route(`${origin}/**`, serveSdkExample)
  const page = await context.newPage()
  await page.goto(`${origin}/example/#noir-public`)
  await page.waitForFunction(() => Boolean(window.noirwallet?.zcash))
  await expect(page.getByRole('button', { name: 'Connect Public' })).toBeEnabled()
  if (screenshotName) {
    await capturePublicScreenshot(page, screenshotName.replace(/\.png$/, '-demo-disconnected.png'))
  }
  const approvalPromise = context.waitForEvent('page')
  await page.getByRole('button', { name: 'Connect Public' }).click()
  const approval = await approvalPromise
  await approval.waitForURL(/#approval\?requestId=/)
  await approval.setViewportSize({ width: 375, height: 632 })
  await expect(approval.getByText('Connect to', { exact: true })).toBeVisible()
  if (screenshotName) await capturePublicScreenshot(approval, screenshotName)
  await approval.getByRole('button', { name: /^Connect/ }).click()
  await expect(page.getByRole('button', { name: 'Disconnect Public' })).toBeVisible()
  await expect(page.getByTestId('public-account')).toBeVisible()
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
    mcaId: null
  })
  await expect(dapp.getByTestId('public-status')).toHaveText('inactive')
  await expect(dapp.getByRole('button', { name: 'Activate public account' })).toBeEnabled()
  await popup.getByRole('tab', { name: 'Assets' }).click()
  const publicAssets = popup.getByRole('region', { name: 'Zcash L2 activation' })
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

test('keeps Public authorization separate from Native across revocation and worker restart', async ({
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
    'public-14-public-only-review.png',
    FIRST_PARTY_ORIGIN
  )
  expect((await requestPublic(dapp, 'zcash_getAccounts')).result).toBeNull()
  await capturePublicScreenshot(dapp, 'public-14a-native-unavailable.png')
  expect((await requestPublic(dapp, 'zcash_getAddresses')).error?.message).toMatch(
    /authorized|reconnect/i
  )

  const nativeWindow = context.waitForEvent('page', { timeout: 60_000 })
  const nativeRequest = requestPublic(dapp, 'zcash_requestAccounts')
  const nativeWindowOrResult = await Promise.race([
    nativeWindow.then(page => ({ page })),
    nativeRequest.then(result => ({ result }))
  ])
  expect(nativeWindowOrResult).toHaveProperty('page')
  if (!('page' in nativeWindowOrResult)) throw new Error('Native approval did not open')
  const nativeApproval = nativeWindowOrResult.page
  await nativeApproval.waitForURL(/#approval\?requestId=/)
  await nativeApproval.setViewportSize({ width: 375, height: 632 })
  await expect(nativeApproval.getByText(/link your Native and Public identities/)).toBeVisible()
  await capturePublicScreenshot(nativeApproval, 'public-15-native-link-review.png')
  await nativeApproval.getByRole('button', { name: /^Connect/ }).click()
  expect((await nativeRequest).result).toMatchObject({ transparent: expect.any(String) })
  expect((await requestPublic(dapp, 'zcash_getAccounts')).result).toMatchObject({
    transparent: expect.any(String)
  })
  expect(await requestPublic(dapp, 'zcash_disconnectPublic')).toEqual({ result: null })
  expect((await requestPublic(dapp, 'zcash_getPublicAccount')).error).toBeTruthy()
  expect((await requestPublic(dapp, 'zcash_getAccounts')).result).toMatchObject({
    transparent: expect.any(String)
  })
  await capturePublicScreenshot(dapp, 'public-17-native-retained.png')

  const publicWindowPromise = context.waitForEvent('page')
  const publicRequest = requestPublic(dapp, 'zcash_requestPublicAccount')
  const publicApproval = await publicWindowPromise
  await publicApproval.waitForURL(/#approval\?requestId=/)
  await publicApproval.setViewportSize({ width: 375, height: 632 })
  await expect(publicApproval.getByText(/link your Native and Public identities/)).toBeVisible()
  await capturePublicScreenshot(publicApproval, 'public-16-public-link-review.png')
  await publicApproval.getByRole('button', { name: /^Connect/ }).click()
  expect((await publicRequest).result).toMatchObject({ chain: 'zcash-l2' })
  expect(await requestPublic(dapp, 'zcash_disconnect')).toEqual({ result: null })
  expect((await requestPublic(dapp, 'zcash_getAccounts')).result).toBeNull()
  expect((await requestPublic(dapp, 'zcash_getPublicAccount')).result).toMatchObject({
    chain: 'zcash-l2'
  })
  await capturePublicScreenshot(dapp, 'public-18-public-retained.png')

  const firstParty = await context.newPage()
  await firstParty.goto(`${FIRST_PARTY_ORIGIN}/another-tab`)
  await firstParty.waitForFunction(() => Boolean(window.noirwallet?.zcash))
  expect((await requestPublic(firstParty, 'zcash_getAccounts')).result).toBeNull()
  await popup.evaluate(async origin => {
    const stored = await chrome.storage.local.get('connectedDApps')
    const connections = stored.connectedDApps as Array<Record<string, unknown>>
    const connection = connections.find(candidate => candidate.origin === origin)
    if (!connection) throw new Error('Public connection was not persisted')
    connection.caip25Session = {
      scopes: [
        {
          chainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
          methods: ['zcash_getPublicAccount', 'zcash_getAccounts'],
          notifications: []
        }
      ]
    }
    await chrome.storage.local.set({ connectedDApps: connections })
  }, FIRST_PARTY_ORIGIN)
  await terminateExtensionServiceWorker(context, popup)
  await waitForBackgroundWalletInitialization(popup)
  expect(await requestPublic(dapp, 'zcash_getAccounts')).toEqual({ result: null })
  await capturePublicScreenshot(dapp, 'public-19-old-session-native-unavailable.png')
  expect((await requestPublic(firstParty, 'zcash_getAccounts')).result).toBeNull()
  const invoke = await dapp.evaluate(async () => {
    const provider = (
      window as typeof window & {
        noirwallet: {
          multichain: {
            request: (input: { method: string; params: unknown }) => Promise<unknown>
          }
        }
      }
    ).noirwallet.multichain
    try {
      return {
        result: await provider.request({
          method: 'wallet_invokeMethod',
          params: {
            scope: 'bip122:00040fe8ec8471911baa1db1266ea15d',
            request: { method: 'zcash_getPublicAccount' }
          }
        })
      }
    } catch (cause) {
      const error = cause as { code?: number; message?: string }
      return { error: { code: error.code, message: error.message } }
    }
  })
  expect(invoke).toMatchObject({ error: { code: 4100 } })

  const staleWindow = context.waitForEvent('page', { timeout: 60_000 })
  const staleRequest = requestPublic(dapp, 'zcash_requestPublicAccount')
  const staleWindowOrResult = await Promise.race([
    staleWindow.then(page => ({ page })),
    staleRequest.then(result => ({ result }))
  ])
  expect(staleWindowOrResult).toHaveProperty('page')
  if (!('page' in staleWindowOrResult)) throw new Error('Public approval did not open')
  const staleApproval = staleWindowOrResult.page
  await staleApproval.waitForURL(/#approval\?requestId=/)
  const staleRequestId = new URL(staleApproval.url()).hash.match(/requestId=([^&]+)/)?.[1]
  expect(staleRequestId).toBeTruthy()
  expect(await requestPublic(dapp, 'zcash_disconnectPublic')).toEqual({ result: null })
  const pendingApproval = await popup.evaluate(
    id => chrome.runtime.sendMessage({ type: 'GET_PENDING_REQUEST', requestId: id }),
    staleRequestId
  )
  expect(pendingApproval?.error).toMatch(/not found|expired/i)
  expect((await staleRequest).error?.message).toMatch(
    /authorization|connection|cancel|expired|reject/i
  )
  await capturePublicScreenshot(dapp, 'public-20-public-disconnected.png')
  expect((await requestPublic(dapp, 'zcash_getPublicAccount')).error).toBeTruthy()
  expect((await requestPublic(dapp, 'zcash_getAccounts')).result).toBeNull()
  await terminateExtensionServiceWorker(context, popup)
  await waitForBackgroundWalletInitialization(popup)
  expect((await requestPublic(firstParty, 'zcash_getAccounts')).result).toBeNull()

  const reconnectApprovalPromise = context.waitForEvent('page')
  const reconnectRequest = requestPublic(dapp, 'zcash_requestPublicAccount')
  const reconnectApproval = await reconnectApprovalPromise
  await reconnectApproval.waitForURL(/#approval\?requestId=/)
  await reconnectApproval.getByRole('button', { name: /^Connect/ }).click()
  const reconnected = await reconnectRequest
  expect(reconnected.error).toBeUndefined()
  const reconnectRevision = await popup.evaluate(async origin => {
    const stored = await chrome.storage.local.get('dapp_authorization_state')
    return stored.dapp_authorization_state?.[origin]?.revision as number | undefined
  }, FIRST_PARTY_ORIGIN)
  expect(reconnectRevision).toEqual(expect.any(Number))
  const expiredAfterReconnect = await popup.evaluate(
    id => chrome.runtime.sendMessage({ type: 'GET_PENDING_REQUEST', requestId: id }),
    staleRequestId
  )
  expect(expiredAfterReconnect?.error).toMatch(/not found|expired/i)
  if (!staleApproval.isClosed()) {
    await staleApproval
      .evaluate(
        id =>
          chrome.runtime.sendMessage({
            type: 'DAPP_APPROVAL_RESULT',
            requestId: id,
            success: true
          }),
        staleRequestId
      )
      .catch(() => undefined)
  }
  expect((await requestPublic(dapp, 'zcash_getPublicAccount')).result).toMatchObject({
    publicKey: (reconnected.result as { publicKey: string }).publicKey
  })
  expect(
    await popup.evaluate(async origin => {
      const stored = await chrome.storage.local.get('dapp_authorization_state')
      return stored.dapp_authorization_state?.[origin]?.revision as number | undefined
    }, FIRST_PARTY_ORIGIN)
  ).toBe(reconnectRevision)

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
    expect(await requestPublic(dapp, 'zcash_disconnectPublic')).toEqual({ result: null })
  } finally {
    releaseRead?.()
  }
  const revokedRead = await pendingAssets
  expect(revokedRead.result).toBeUndefined()
  expect(revokedRead.error?.message).toMatch(/authorization|connection|reconnect/i)
  await capturePublicScreenshot(dapp, 'public-21-inflight-revoked.png')
  expect((await requestPublic(dapp, 'zcash_getPublicAccount')).error).toBeTruthy()
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
                submission_id: computePublicSubmissionId(submissions[0]),
                status: 'EXECUTED',
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
    account: { mcaId: ACTIVE_MCA },
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
    .getByRole('button', { name: 'View NEAR details on Zcash L2', exact: true })
    .scrollIntoViewIfNeeded()
  await capturePublicScreenshot(popup, 'public-05-active-assets.png')
  await publicAssets.getByRole('button', { name: /^Filter portfolio by network:/ }).click()
  await popup.getByRole('menuitemradio', { name: 'Zcash L2', exact: true }).click()
  await capturePublicScreenshot(popup, 'public-05b-network-filter.png')
  await publicAssets
    .getByRole('button', { name: 'View ZEC details on Zcash L2', exact: true })
    .click()
  await expect(popup.getByRole('heading', { name: 'Asset' })).toBeVisible()
  await expect(popup.getByText('zec.omft.near')).toBeVisible()
  await capturePublicScreenshot(popup, 'public-05a-asset-detail.png')
  await popup.getByRole('button', { name: 'Back' }).click()
  await publicAssets
    .getByRole('button', { name: 'View NEAR details on Zcash L2', exact: true })
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
    name: 'View ZEC details on Zcash L2',
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
    'getPublicAccount',
    'connectPublic',
    'disconnectPublic',
    'activatePublicAccount',
    'getPublicAssets',
    'sendPublicTransaction',
    'getPublicTransaction',
    'publicAccountChanged'
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
      .getByRole('button', { name: 'View NEAR details on Zcash L2', exact: true })
      .scrollIntoViewIfNeeded()
    await expect(
      freshAssets.getByRole('button', { name: 'View ZEC details on Zcash L2', exact: true })
    ).toContainText('1 ZEC')
    await freshAssets.getByRole('button', { name: /^Filter portfolio by network:/ }).click()
    await freshPopup.getByRole('menuitemradio', { name: 'Zcash L2', exact: true }).click()
    await capturePublicScreenshot(freshPopup, 'public-13-fresh-profile-import.png')
  } finally {
    await freshContext.close()
  }
})
