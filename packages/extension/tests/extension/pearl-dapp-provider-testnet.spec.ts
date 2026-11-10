import type { BrowserContext, Page, Route } from '@playwright/test'
import {
  captureScreenshot,
  expect,
  selectImportedZcashHistory,
  test,
  waitForBackgroundWalletInitialization
} from '../helpers/extension-fixtures'

const TEST_MNEMONIC_24 = `${'abandon '.repeat(23)}art`
const TEST_PASSWORD = 'pearl-testnet-dapp-password'
const PEARL_TESTNET_BLOCKBOOK = 'https://blockbook.testnet.pearlresearch.ai/**'
const TIP_HEIGHT = 120_000
const BEST_BLOCK_HASH = 'a'.repeat(64)

interface PearlTestProvider {
  connect(): Promise<{ address: string; publicKey: string }>
  getAccounts(): Promise<string[]>
  getNetwork(): Promise<string>
  getChain(): Promise<{ enum: string; name: string; network: string }>
  getPublicKey(): Promise<string>
  getBalance(): Promise<{ confirmed: number; unconfirmed: number; total: number }>
  sendPearl(recipient: string, satoshis: number, options?: { feeRate?: number }): Promise<string>
  signMessage(message: string, signatureType?: string): Promise<string>
  signPsbt(psbtHex: string, options?: { autoFinalized?: boolean }): Promise<string>
  signPsbts(
    psbtHexes: readonly string[],
    options?: readonly ({ autoFinalized?: boolean } | undefined)[]
  ): Promise<readonly string[]>
  pushPsbt(psbtHex: string): Promise<string>
  pushTx(options: { rawtx: string }): Promise<string>
  disconnect(): Promise<void>
  on(event: string, handler: (value: unknown) => void): unknown
  removeListener(event: string, handler: (value: unknown) => void): unknown
}

type PearlTestWindow = typeof window & {
  noirwallet: { pearl: PearlTestProvider }
}

function fulfillJson(route: Route, body: unknown) {
  return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
}

/**
 * Pearl Blockbook stub for an unfunded Testnet account. It answers the identity
 * probe, address activity, UTXO and history reads the discovery and portfolio
 * paths need. No funded broadcast is exercised here.
 */
async function mockPearlBlockbook(context: BrowserContext): Promise<void> {
  await context.route(PEARL_TESTNET_BLOCKBOOK, async route => {
    const url = new URL(route.request().url())
    const path = url.pathname.replace(/^\/api\/v2/, '')
    if (path === '') {
      return fulfillJson(route, {
        blockbook: { coin: 'Pearl Testnet2' },
        backend: { chain: 'testnet2', blocks: TIP_HEIGHT, bestBlockHash: BEST_BLOCK_HASH }
      })
    }
    if (path.startsWith('/utxo/')) return fulfillJson(route, [])
    if (path.startsWith('/address/')) {
      if (url.searchParams.get('details') === 'txs') {
        return fulfillJson(route, { transactions: [], txs: 0, unconfirmedTxs: 0 })
      }
      return fulfillJson(route, { txs: 0, unconfirmedTxs: 0, balance: '0' })
    }
    throw new Error(`Unhandled Pearl Blockbook path in the test: ${path}`)
  })
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

test('shows Pearl as a released chain and serves its dApp provider in real MV3', async ({
  context,
  popup,
  extensionId
}) => {
  test.skip(
    process.env.APPROVAL_WINDOW_E2E !== '1',
    'Chrome popup windows require an explicit real-browser approval run'
  )
  test.setTimeout(240_000)
  await mockPearlBlockbook(context)
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)

  // Pearl is enabled in the default profile, so it is a released family rather
  // than a "Coming soon" option in account and private-key flows.
  await popup.goto(`chrome-extension://${extensionId}/index.html?e2e=pearl#/import-private-key`)
  // An exact accessible name proves the option is not the "Pearl Coming soon"
  // variant the disabled family button renders.
  const pearlFamily = popup.getByRole('button', { name: 'Pearl', exact: true })
  await expect(pearlFamily).toBeVisible()
  await expect(pearlFamily).toBeEnabled()

  await context.route('https://pearl-dapp.example/**', route =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><title>Pearl test dApp</title></head><body>Pearl dApp</body></html>'
    })
  )
  const dapp = await context.newPage()
  await dapp.goto('https://pearl-dapp.example/connect')
  await dapp.waitForFunction(() => {
    const target = window as typeof window & {
      noirwallet?: { pearl?: { getNetwork?: unknown } }
    }
    return typeof target.noirwallet?.pearl?.getNetwork === 'function'
  })

  const initial = await dapp.evaluate(async () => {
    const provider = (window as PearlTestWindow).noirwallet.pearl
    return {
      network: await provider.getNetwork(),
      chain: await provider.getChain(),
      accounts: await provider.getAccounts()
    }
  })
  expect(initial).toEqual({
    network: 'testnet',
    chain: { enum: 'PEARL_TESTNET', name: 'Pearl Testnet', network: 'testnet' },
    accounts: []
  })

  const connectApprovalPromise = context.waitForEvent('page')
  const connectResultPromise = dapp.evaluate(() =>
    (window as PearlTestWindow).noirwallet.pearl.connect()
  )
  const connectApproval = await connectApprovalPromise
  await connectApproval.waitForURL(/#approval\?requestId=/)
  await connectApproval.setViewportSize({ width: 375, height: 632 })
  await expect(connectApproval.getByText('Connect to', { exact: true })).toBeVisible()
  await expect(
    connectApproval.getByRole('heading', { name: 'pearl-dapp.example', exact: true })
  ).toBeVisible()
  await captureScreenshot(connectApproval, 'pearl-dapp-connect-approval.png')
  await connectApproval.getByRole('button', { name: /^Connect/ }).click()
  const connected = (await connectResultPromise) as { address: string; publicKey: string }
  expect(connected.address).toMatch(/^tprl1p/)
  expect(connected.publicKey).toMatch(/^0[23][0-9a-f]{64}$/)

  const identity = await dapp.evaluate(async () => {
    const provider = (window as PearlTestWindow).noirwallet.pearl
    return {
      publicKey: await provider.getPublicKey(),
      balance: await provider.getBalance(),
      accounts: await provider.getAccounts()
    }
  })
  expect(identity.publicKey).toBe(connected.publicKey)
  expect(identity.accounts).toEqual([connected.address])
  expect(identity.balance).toEqual({ confirmed: 0, unconfirmed: 0, total: 0 })

  const spendSurface = await dapp.evaluate(() => {
    const provider = (window as PearlTestWindow).noirwallet.pearl
    return {
      sendPearl: typeof provider.sendPearl,
      signPsbt: typeof provider.signPsbt,
      signPsbts: typeof provider.signPsbts,
      pushPsbt: typeof provider.pushPsbt,
      pushTx: typeof provider.pushTx
    }
  })
  expect(spendSurface).toEqual({
    sendPearl: 'function',
    signPsbt: 'function',
    signPsbts: 'function',
    pushPsbt: 'function',
    pushTx: 'function'
  })

  const malformed = await dapp.evaluate(async () => {
    const provider = (window as PearlTestWindow).noirwallet.pearl
    const codeOf = async (operation: () => Promise<unknown>) => {
      try {
        await operation()
        return 'ok'
      } catch (error) {
        return (error as { code?: number }).code ?? 'no-code'
      }
    }
    return {
      signPsbt: await codeOf(() => provider.signPsbt('00')),
      pushPsbt: await codeOf(() => provider.pushPsbt('00')),
      pushTx: await codeOf(() => provider.pushTx({ rawtx: 'xyz' })),
      sendPearl: await codeOf(() => provider.sendPearl(provider.getAccounts.length ? '' : '', 0))
    }
  })
  expect(malformed.signPsbt).toBe(-32602)
  expect(malformed.pushPsbt).toBe(-32602)
  expect(malformed.pushTx).toBe(-32602)
  expect(malformed.sendPearl).toBe(-32602)

  const unfundedSend = await dapp.evaluate(async address => {
    const provider = (window as PearlTestWindow).noirwallet.pearl
    try {
      await provider.sendPearl(address, 1000)
      return 'sent'
    } catch (error) {
      return (error as { code?: number }).code ?? 'no-code'
    }
  }, connected.address)
  expect(unfundedSend).toBe(-32603)

  // Incomplete PSBT hex that passes the public parser but cannot be signed or broadcast.
  const incompletePsbt = await dapp.evaluate(async () => {
    const provider = (window as PearlTestWindow).noirwallet.pearl
    const codeOf = async (operation: () => Promise<unknown>) => {
      try {
        await operation()
        return 'ok'
      } catch (error) {
        return (error as { code?: number }).code ?? 'no-code'
      }
    }
    return {
      signPsbt: await codeOf(() => provider.signPsbt('70736274ff0100', { autoFinalized: false })),
      pushPsbt: await codeOf(() => provider.pushPsbt('70736274ff0100'))
    }
  })
  expect([4100, -32603]).toContain(incompletePsbt.signPsbt)
  expect(incompletePsbt.pushPsbt).toBe(-32602)

  const signApprovalPromise = context.waitForEvent('page')
  const signaturePromise = dapp.evaluate(() =>
    (window as PearlTestWindow).noirwallet.pearl.signMessage('Hello Noir Pearl', 'bip322-simple')
  )
  const signApproval = await signApprovalPromise
  await signApproval.waitForURL(/#approval\?requestId=/)
  await signApproval.setViewportSize({ width: 375, height: 632 })
  await expect(
    signApproval.getByRole('heading', { name: 'Sign message', exact: true })
  ).toBeVisible()
  await expect(
    signApproval.getByRole('heading', { name: 'pearl-dapp.example', exact: true })
  ).toBeVisible()
  await expect(signApproval.getByText('Hello Noir Pearl', { exact: true })).toBeVisible()
  const chainIcon = signApproval.getByRole('img', { name: 'Pearl', exact: true })
  await expect(chainIcon).toHaveAttribute('src', '/icons/chains/pearl.svg')
  await expect
    .poll(() => chainIcon.evaluate(image => (image as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0)
  await captureScreenshot(signApproval, 'pearl-dapp-bip322-approval.png')
  await signApproval.getByRole('button', { name: 'Sign message', exact: true }).click()
  await expect(signaturePromise).resolves.toMatch(/^[A-Za-z0-9+/]+=*$/)

  // Rejecting a signature request must leave the authorization intact and not sign.
  const rejectApprovalPromise = context.waitForEvent('page')
  const rejectedPromise = dapp.evaluate(async () => {
    try {
      await (window as PearlTestWindow).noirwallet.pearl.signMessage('Reject me')
      return 'signed'
    } catch (error) {
      return (error as { code?: number }).code ?? 'no-code'
    }
  })
  const rejectApproval = await rejectApprovalPromise
  await rejectApproval.waitForURL(/#approval\?requestId=/)
  await rejectApproval.setViewportSize({ width: 375, height: 632 })
  await rejectApproval.getByRole('button', { name: 'Reject', exact: true }).click()
  await expect(rejectedPromise).resolves.toBe(4001)

  const disconnectPromise = dapp.evaluate(async () => {
    const provider = (window as PearlTestWindow).noirwallet.pearl
    await provider.disconnect()
    return {
      accounts: await provider.getAccounts(),
      sendPearl: await provider
        .sendPearl('tprl1ptest', 1)
        .then(() => 'ok')
        .catch(error => (error as { code?: number }).code ?? 'no-code'),
      signPsbt: await provider
        .signPsbt('70736274ff0100')
        .then(() => 'ok')
        .catch(error => (error as { code?: number }).code ?? 'no-code')
    }
  })
  await expect(disconnectPromise).resolves.toEqual({
    accounts: [],
    sendPearl: 4100,
    signPsbt: 4100
  })
})
