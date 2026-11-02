import type { BrowserContext, Page, Route } from '@playwright/test'
import { HDKey } from '@scure/bip32'
import { mnemonicToSeedSync } from '@scure/bip39'
import { Buffer } from 'buffer'
import { Psbt, Transaction } from 'bitcoinjs-lib'
import {
  buildBitcoinPsbt,
  finalizeBitcoinPsbt,
  selectBitcoinCoins
} from '../../src/infrastructure/chains/bitcoin'
import {
  captureScreenshot,
  expect,
  selectImportedZcashHistory,
  test,
  waitForBackgroundWalletInitialization
} from '../helpers/extension-fixtures'

const TEST_MNEMONIC_24 = `${'abandon '.repeat(23)}art`
const TEST_PASSWORD = 'bitcoin-testnet-dapp-password'
const TESTNET_GENESIS = '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943'
const TESTNET_API_PATTERNS = [
  'https://mempool.space/testnet/api/**',
  'https://blockstream.info/testnet/api/**'
]
const UTXO_TRANSACTION_ID = 'a'.repeat(64)
const UTXO_VALUE_SATS = 100_000
const TIP_HEIGHT = 2_600_000
const RECIPIENT = 'tb1qa358kx0458mz6dndv9lgz0ja3ewwgutxzxqq82'
const BITCOIN_TESTNET_CHAIN_ID = 'bip122:000000000933ea01ad0ee984209779ba'

interface BitcoinTestProvider {
  connect(): Promise<{ address: string; publicKey: string }>
  getAccounts(): Promise<string[]>
  getBalance(): Promise<{ confirmed: number; unconfirmed: number; total: number }>
  getNetwork(): Promise<string>
  signMessage(message: string, signatureType?: string): Promise<string>
  signPsbt(psbtHex: string, options?: { autoFinalized?: boolean }): Promise<string>
  pushTx(options: { rawtx: string }): Promise<string>
  sendBitcoin(recipient: string, amountSats: number): Promise<string>
  disconnect(): Promise<void>
  on(event: string, handler: (value: unknown) => void): unknown
  removeListener(event: string, handler: (value: unknown) => void): unknown
}

type BitcoinTestWindow = typeof window & {
  noirwallet: { bitcoin: BitcoinTestProvider }
}

function buildExternalPsbt(account: { address: string; publicKey: string }) {
  const masterFingerprint = HDKey.fromMasterSeed(mnemonicToSeedSync(TEST_MNEMONIC_24)).fingerprint
  const selection = selectBitcoinCoins({
    chainId: BITCOIN_TESTNET_CHAIN_ID,
    accountIndex: 0,
    addressType: 'p2wpkh',
    recipient: RECIPIENT,
    amount: { mode: 'max' },
    feeRateSatsPerVbyte: 2,
    utxos: [
      {
        chainId: BITCOIN_TESTNET_CHAIN_ID,
        addressType: 'p2wpkh',
        accountIndex: 0,
        change: false,
        addressIndex: 0,
        address: account.address,
        derivationPath: "m/84'/1'/0'/0/0",
        publicKey: `0x${account.publicKey}`,
        transactionId: UTXO_TRANSACTION_ID,
        outputIndex: 0,
        valueSats: String(UTXO_VALUE_SATS),
        blockHeight: TIP_HEIGHT - 100
      }
    ]
  })
  return buildBitcoinPsbt({
    selection,
    masterFingerprint: `0x${masterFingerprint.toString(16).padStart(8, '0')}`,
    lockTime: TIP_HEIGHT
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

async function mockBitcoinNetwork(context: BrowserContext) {
  let fundedAddress: string | null = null
  const rawTransactions: string[] = []
  const fulfillText = (route: Route, body: string) =>
    route.fulfill({ contentType: 'text/plain', body })
  const fulfillJson = (route: Route, body: unknown) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })

  const handler = async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    const marker = '/testnet/api/'
    const markerIndex = url.pathname.indexOf(marker)
    if (markerIndex < 0) throw new Error(`Unexpected Bitcoin test URL: ${request.url()}`)
    const path = decodeURIComponent(url.pathname.slice(markerIndex + marker.length))

    if (path === 'block-height/0') return fulfillText(route, TESTNET_GENESIS)
    if (path === 'blocks/tip/height') return fulfillText(route, String(TIP_HEIGHT))
    if (path === 'fee-estimates') return fulfillJson(route, { 6: 2 })
    if (path === 'tx' && request.method() === 'POST') {
      const rawTransaction = request.postData()
      if (!rawTransaction || !/^(?:[0-9a-f]{2})+$/.test(rawTransaction)) {
        throw new Error('Expected a canonical signed Bitcoin transaction')
      }
      rawTransactions.push(rawTransaction)
      return fulfillText(route, Transaction.fromHex(rawTransaction).getId())
    }
    const utxoMatch = /^address\/(.+)\/utxo$/.exec(path)
    if (utxoMatch) {
      return fulfillJson(
        route,
        utxoMatch[1] === fundedAddress
          ? [
              {
                txid: UTXO_TRANSACTION_ID,
                vout: 0,
                value: UTXO_VALUE_SATS,
                status: {
                  confirmed: true,
                  block_height: TIP_HEIGHT - 100,
                  block_hash: 'b'.repeat(64),
                  block_time: 1_786_000_000
                }
              }
            ]
          : []
      )
    }
    const addressMatch = /^address\/(.+)$/.exec(path)
    if (addressMatch) {
      const address = addressMatch[1]
      fundedAddress ??= address
      const used = address === fundedAddress
      const stats = {
        tx_count: used ? 1 : 0,
        funded_txo_count: used ? 1 : 0,
        funded_txo_sum: used ? UTXO_VALUE_SATS : 0,
        spent_txo_count: 0,
        spent_txo_sum: 0
      }
      return fulfillJson(route, {
        address,
        chain_stats: stats,
        mempool_stats: {
          tx_count: 0,
          funded_txo_count: 0,
          funded_txo_sum: 0,
          spent_txo_count: 0,
          spent_txo_sum: 0
        }
      })
    }
    throw new Error(`Unhandled Bitcoin dApp test path: ${path}`)
  }

  for (const pattern of TESTNET_API_PATTERNS) await context.route(pattern, handler)
  return { rawTransactions, fundedAddress: () => fundedAddress }
}

test('connects, signs BIP-322 and PSBT, and broadcasts from a Bitcoin dApp in real MV3', async ({
  context,
  popup,
  extensionId
}) => {
  test.skip(
    process.env.APPROVAL_WINDOW_E2E !== '1',
    'Chrome popup windows require an explicit real-browser approval run'
  )
  test.setTimeout(240_000)
  const network = await mockBitcoinNetwork(context)
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)

  await context.route('https://bitcoin-dapp.example/**', route =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><title>Bitcoin test dApp</title></head><body>Bitcoin dApp</body></html>'
    })
  )
  const dapp = await context.newPage()
  await dapp.goto('https://bitcoin-dapp.example/connect')
  await dapp.waitForFunction(() => {
    const target = window as typeof window & {
      noirwallet?: { bitcoin?: { getNetwork?: unknown } }
      unisat?: unknown
    }
    return typeof target.noirwallet?.bitcoin?.getNetwork === 'function'
  })

  const initial = await dapp.evaluate(async () => {
    const target = window as typeof window & {
      noirwallet: {
        bitcoin: {
          getNetwork: () => Promise<string>
          getAccounts: () => Promise<string[]>
        }
      }
      unisat?: unknown
    }
    return {
      network: await target.noirwallet.bitcoin.getNetwork(),
      accounts: await target.noirwallet.bitcoin.getAccounts(),
      hasUnisatAlias: target.unisat !== undefined
    }
  })
  expect(initial).toEqual({ network: 'testnet', accounts: [], hasUnisatAlias: false })

  const connectApprovalPromise = context.waitForEvent('page')
  const connectResultPromise = dapp.evaluate(() => {
    const provider = (window as BitcoinTestWindow).noirwallet.bitcoin
    return provider.connect()
  })
  const connectApproval = await connectApprovalPromise
  await connectApproval.waitForURL(/#approval\?requestId=/)
  await connectApproval.setViewportSize({ width: 375, height: 632 })
  await expect(connectApproval.getByText('Connect to', { exact: true })).toBeVisible()
  await expect(
    connectApproval.getByRole('heading', { name: 'bitcoin-dapp.example', exact: true })
  ).toBeVisible()
  await expect(connectApproval.getByText('Bitcoin Testnet', { exact: true })).toHaveCount(0)
  await captureScreenshot(connectApproval, 'bitcoin-dapp-connect-approval.png')
  await connectApproval.getByRole('button', { name: /^Connect/ }).click()
  const connected = (await connectResultPromise) as { address: string; publicKey: string }
  expect(connected.address).toMatch(/^tb1q/)
  expect(connected.publicKey).toMatch(/^0[23][0-9a-f]{64}$/)

  const balance = await dapp.evaluate(() =>
    (window as BitcoinTestWindow).noirwallet.bitcoin.getBalance()
  )
  expect(balance).toEqual({ confirmed: UTXO_VALUE_SATS, unconfirmed: 0, total: UTXO_VALUE_SATS })
  expect(network.fundedAddress()).toBe(connected.address)

  const signApprovalPromise = context.waitForEvent('page')
  const signaturePromise = dapp.evaluate(() =>
    (window as BitcoinTestWindow).noirwallet.bitcoin.signMessage(
      'Hello Noir Bitcoin',
      'bip322-simple'
    )
  )
  const signApproval = await signApprovalPromise
  await signApproval.waitForURL(/#approval\?requestId=/)
  await signApproval.setViewportSize({ width: 375, height: 632 })
  await expect(
    signApproval.getByRole('heading', { name: 'Sign message', exact: true })
  ).toBeVisible()
  await expect(
    signApproval.getByRole('heading', { name: 'bitcoin-dapp.example', exact: true })
  ).toBeVisible()
  await expect(signApproval.getByText('Hello Noir Bitcoin', { exact: true })).toBeVisible()
  const signChainIcon = signApproval.getByRole('img', { name: 'Bitcoin', exact: true })
  await expect(signChainIcon).toHaveAttribute('src', 'https://assets.zknoir.com/chain/bitcoin.svg')
  await expect
    .poll(() => signChainIcon.evaluate(image => (image as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0)
  await captureScreenshot(signApproval, 'bitcoin-dapp-bip322-approval.png')
  await signApproval.getByRole('button', { name: 'Sign message', exact: true }).click()
  await expect(signaturePromise).resolves.toMatch(/^smp/)

  const externalPsbt = buildExternalPsbt(connected)
  const externalPsbtHex = Buffer.from(externalPsbt.psbtBase64, 'base64').toString('hex')
  const psbtApprovalPromise = context.waitForEvent('page')
  const signedPsbtPromise = dapp.evaluate(
    psbtHex =>
      (window as BitcoinTestWindow).noirwallet.bitcoin.signPsbt(psbtHex, {
        autoFinalized: false
      }),
    externalPsbtHex
  )
  const psbtApproval = await psbtApprovalPromise
  await psbtApproval.waitForURL(/#approval\?requestId=/)
  await psbtApproval.setViewportSize({ width: 375, height: 632 })
  await expect(psbtApproval.getByText('Review transaction', { exact: true })).toBeVisible()
  await expect(
    psbtApproval.getByRole('heading', { name: 'bitcoin-dapp.example', exact: true })
  ).toBeVisible()
  await captureScreenshot(psbtApproval, 'bitcoin-dapp-psbt-approval.png')
  await psbtApproval.getByText('Advanced', { exact: true }).click()
  await expect(psbtApproval.getByText('PSBT version', { exact: true })).toBeVisible()
  await psbtApproval.getByRole('button', { name: 'Confirm', exact: true }).click()
  const signedPsbtHex = await signedPsbtPromise
  const signedPsbt = Psbt.fromHex(signedPsbtHex)
  expect(signedPsbt.data.inputs[0].partialSig).toHaveLength(1)
  expect(signedPsbt.data.inputs[0].finalScriptWitness).toBeUndefined()
  const finalizedExternalPsbt = finalizeBitcoinPsbt({
    prepared: externalPsbt,
    signedPsbtBase64: Buffer.from(signedPsbtHex, 'hex').toString('base64')
  })
  expect(finalizedExternalPsbt.transactionId).toBe(externalPsbt.unsignedTransactionId)

  const pushedTransactionId = await dapp.evaluate(rawtx => {
    return (window as BitcoinTestWindow).noirwallet.bitcoin.pushTx({ rawtx })
  }, finalizedExternalPsbt.rawTransactionHex)
  expect(pushedTransactionId).toBe(finalizedExternalPsbt.transactionId)
  expect(network.rawTransactions).toEqual([finalizedExternalPsbt.rawTransactionHex])

  const sendApprovalPromise = context.waitForEvent('page')
  const transactionPromise = dapp.evaluate(
    recipient => (window as BitcoinTestWindow).noirwallet.bitcoin.sendBitcoin(recipient, 10_000),
    RECIPIENT
  )
  const sendApproval = await sendApprovalPromise
  await sendApproval.waitForURL(/#approval\?requestId=/)
  await sendApproval.setViewportSize({ width: 375, height: 632 })
  await expect(sendApproval.getByText('Review transaction', { exact: true })).toBeVisible()
  await expect(
    sendApproval.getByRole('heading', { name: 'bitcoin-dapp.example', exact: true })
  ).toBeVisible()
  await expect(sendApproval.getByText('10000 sats', { exact: true })).toBeVisible()
  await captureScreenshot(sendApproval, 'bitcoin-dapp-send-approval.png')
  await sendApproval.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(transactionPromise).resolves.toMatch(/^[0-9a-f]{64}$/)
  expect(network.rawTransactions).toHaveLength(2)

  const disconnected = await dapp.evaluate(async () => {
    const provider = (window as BitcoinTestWindow).noirwallet.bitcoin
    const changed = new Promise<unknown>((resolve, reject) => {
      const timeout = window.setTimeout(
        () => reject(new Error('Bitcoin accountsChanged event timed out')),
        10_000
      )
      const handler = (value: unknown) => {
        window.clearTimeout(timeout)
        provider.removeListener('accountsChanged', handler)
        resolve(value)
      }
      provider.on('accountsChanged', handler)
    })
    const result = await provider.disconnect()
    return { result, event: await changed, accounts: await provider.getAccounts() }
  })
  expect(disconnected).toEqual({ result: undefined, event: [], accounts: [] })

  await dapp.close()
})
