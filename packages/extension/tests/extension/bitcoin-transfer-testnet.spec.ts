import * as secp256k1 from '@bitcoinerlab/secp256k1'
import type { BrowserContext, Page, Route } from '@playwright/test'
import { address as bitcoinAddress, networks, payments, Transaction } from 'bitcoinjs-lib'
import { Buffer } from 'buffer'
import {
  captureScreenshot,
  expect,
  selectImportedZcashHistory,
  test,
  terminateExtensionServiceWorker,
  waitForBackgroundWalletInitialization
} from '../helpers/extension-fixtures'

const TEST_MNEMONIC_24 = `${'abandon '.repeat(23)}art`
const TEST_PASSWORD = 'bitcoin-testnet-transfer-password'
const TESTNET_GENESIS = '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943'
const BITCOIN_TESTNET_ASSET_ID = 'bip122:000000000933ea01ad0ee984209779ba/slip44:0'
const MEMPOOL_TESTNET_URL = 'https://mempool.space/testnet/api/**'
const BLOCKSTREAM_TESTNET_URL = 'https://blockstream.info/testnet/api/**'
const UTXO_TRANSACTION_ID = 'b'.repeat(64)
const REPLACEMENT_TRANSACTION_ID = 'e'.repeat(64)
const UTXO_VALUE_SATS = 100_000
const TIP_HEIGHT = 2_500_100

function p2wpkhAddress(privateKeyDigit: number, network: typeof networks.bitcoin): string {
  const privateKey = Buffer.alloc(32)
  privateKey[31] = privateKeyDigit
  const publicKey = Buffer.from(secp256k1.pointFromScalar(privateKey, true))
  const address = payments.p2wpkh({ pubkey: publicKey, network }).address
  if (!address) throw new Error('Unable to derive Bitcoin test address')
  return address
}

const RECIPIENT = p2wpkhAddress(2, networks.testnet)
const WRONG_NETWORK_RECIPIENT = p2wpkhAddress(2, networks.bitcoin)

async function importTestWallet(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Import wallet' }).click()
  await expect(page.getByRole('radio', { name: '24 words' })).toHaveAttribute(
    'aria-checked',
    'true'
  )
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

async function waitForDialogAnimations(page: Page): Promise<void> {
  await page.getByRole('dialog').evaluate(async element => {
    await Promise.all(
      element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))
    )
  })
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => ({
        viewportWidth: document.documentElement.clientWidth,
        contentWidth: document.documentElement.scrollWidth
      }))
    )
    .toEqual({ viewportWidth: 375, contentWidth: 375 })
}

async function expectTransactionResultContentFits(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page
        .locator('[data-transaction-status] .overflow-y-auto')
        .evaluate(element => element.scrollHeight - element.clientHeight)
    )
    .toBeLessThanOrEqual(1)
}

interface MockBitcoinNetwork {
  readonly rawTransactions: string[]
  readonly addresses: string[]
  setConfirmationDepth(depth: number): void
  setReplacementDepth(depth: number): void
  transactionId(): string | null
}

async function mockBitcoinNetwork(context: BrowserContext): Promise<MockBitcoinNetwork> {
  const rawTransactions: string[] = []
  const addresses: string[] = []
  let fundedAddress: string | null = null
  let broadcastTransactionId: string | null = null
  let confirmationDepth = 0
  let replacementDepth = 0

  const stats = (used: boolean) => ({
    tx_count: used ? 1 : 0,
    funded_txo_count: used ? 1 : 0,
    funded_txo_sum: used ? UTXO_VALUE_SATS : 0,
    spent_txo_count: 0,
    spent_txo_sum: 0
  })

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

    if (path === 'block-height/0') {
      await fulfillText(route, TESTNET_GENESIS)
      return
    }
    if (path === 'blocks/tip/height') {
      const observedDepth = Math.max(confirmationDepth, replacementDepth)
      await fulfillText(route, String(TIP_HEIGHT + Math.max(observedDepth - 1, 0)))
      return
    }
    if (path === 'fee-estimates') {
      await fulfillJson(route, { 6: 2 })
      return
    }
    if (path === 'tx' && request.method() === 'POST') {
      const rawTransaction = request.postData()
      if (!rawTransaction || !/^(?:[0-9a-f]{2})+$/.test(rawTransaction)) {
        throw new Error('Expected a canonical signed Bitcoin transaction')
      }
      rawTransactions.push(rawTransaction)
      broadcastTransactionId = Transaction.fromHex(rawTransaction).getId()
      await fulfillText(route, broadcastTransactionId)
      return
    }
    const statusMatch = /^tx\/([0-9a-f]{64})\/status$/.exec(path)
    if (statusMatch) {
      if (statusMatch[1] !== broadcastTransactionId || replacementDepth > 0) {
        await route.fulfill({ status: 404, body: 'not found' })
        return
      }
      await fulfillJson(
        route,
        confirmationDepth === 0
          ? { confirmed: false }
          : {
              confirmed: true,
              block_height: TIP_HEIGHT,
              block_hash: 'c'.repeat(64),
              block_time: 1_786_000_000
            }
      )
      return
    }
    const outspendMatch = /^tx\/([0-9a-f]{64})\/outspend\/(\d+)$/.exec(path)
    if (outspendMatch) {
      if (outspendMatch[1] !== UTXO_TRANSACTION_ID || outspendMatch[2] !== '0') {
        await route.fulfill({ status: 404, body: 'not found' })
        return
      }
      await fulfillJson(
        route,
        replacementDepth > 0
          ? {
              spent: true,
              txid: REPLACEMENT_TRANSACTION_ID,
              vin: 0,
              status: {
                confirmed: true,
                block_height: TIP_HEIGHT,
                block_hash: 'f'.repeat(64),
                block_time: 1_786_100_000
              }
            }
          : { spent: false }
      )
      return
    }
    const utxoMatch = /^address\/(.+)\/utxo$/.exec(path)
    if (utxoMatch) {
      const address = utxoMatch[1]
      await fulfillJson(
        route,
        address === fundedAddress && replacementDepth === 0 && rawTransactions.length === 0
          ? [
              {
                txid: UTXO_TRANSACTION_ID,
                vout: 0,
                value: UTXO_VALUE_SATS,
                status: {
                  confirmed: true,
                  block_height: TIP_HEIGHT - 100,
                  block_hash: 'd'.repeat(64),
                  block_time: 1_785_000_000
                }
              }
            ]
          : []
      )
      return
    }
    const historyMatch = /^address\/(.+)\/txs$/.exec(path)
    if (historyMatch) {
      if (
        historyMatch[1] !== fundedAddress ||
        rawTransactions.length === 0 ||
        replacementDepth > 0
      ) {
        await fulfillJson(route, [])
        return
      }
      const rawTransaction = rawTransactions.at(-1)
      if (!rawTransaction || !broadcastTransactionId) {
        throw new Error('Expected the broadcast Bitcoin transaction before history refresh')
      }
      const transaction = Transaction.fromHex(rawTransaction)
      const fundedOutput = payments.p2wpkh({
        address: fundedAddress,
        network: networks.testnet
      }).output
      if (!fundedOutput) throw new Error('Unable to encode the funded Bitcoin test address')
      const outputTotal = transaction.outs.reduce((sum, output) => sum + BigInt(output.value), 0n)
      await fulfillJson(route, [
        {
          txid: broadcastTransactionId,
          version: transaction.version,
          locktime: transaction.locktime,
          size: transaction.byteLength(),
          weight: transaction.weight(),
          fee: Number(BigInt(UTXO_VALUE_SATS) - outputTotal),
          vin: transaction.ins.map(input => ({
            txid: UTXO_TRANSACTION_ID,
            vout: input.index,
            prevout: {
              scriptpubkey: fundedOutput.toString('hex'),
              scriptpubkey_asm: `OP_0 OP_PUSHBYTES_20 ${fundedOutput.subarray(2).toString('hex')}`,
              scriptpubkey_type: 'v0_p2wpkh',
              scriptpubkey_address: fundedAddress,
              value: UTXO_VALUE_SATS
            },
            scriptsig: input.script.toString('hex'),
            scriptsig_asm: '',
            witness: input.witness.map(item => item.toString('hex')),
            is_coinbase: false,
            sequence: input.sequence
          })),
          vout: transaction.outs.map(output => {
            const address = bitcoinAddress.fromOutputScript(output.script, networks.testnet)
            return {
              scriptpubkey: output.script.toString('hex'),
              scriptpubkey_asm: `OP_0 OP_PUSHBYTES_20 ${output.script.subarray(2).toString('hex')}`,
              scriptpubkey_type: 'v0_p2wpkh',
              scriptpubkey_address: address,
              value: Number(output.value)
            }
          }),
          status:
            confirmationDepth === 0
              ? { confirmed: false }
              : {
                  confirmed: true,
                  block_height: TIP_HEIGHT,
                  block_hash: 'c'.repeat(64),
                  block_time: 1_786_000_000
                }
        }
      ])
      return
    }
    const addressMatch = /^address\/(.+)$/.exec(path)
    if (addressMatch) {
      const address = addressMatch[1]
      if (fundedAddress === null) fundedAddress = address
      addresses.push(address)
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

  await context.route(MEMPOOL_TESTNET_URL, handler)
  await context.route(BLOCKSTREAM_TESTNET_URL, handler)

  return {
    rawTransactions,
    addresses,
    setConfirmationDepth: depth => {
      confirmationDepth = depth
    },
    setReplacementDepth: depth => {
      replacementDepth = depth
    },
    transactionId: () => broadcastTransactionId
  }
}

async function readBitcoinInputReservations(
  page: Page
): Promise<readonly { readonly state: string; readonly transactionId: string }[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('noir-wallet-bitcoin-input-v1-db', 2)
      request.onerror = () => reject(request.error ?? new Error('Unable to open Bitcoin input DB'))
      request.onsuccess = () => resolve(request.result)
    })
    try {
      const transaction = database.transaction('reservations', 'readonly')
      const values = await new Promise<unknown[]>((resolve, reject) => {
        const request = transaction.objectStore('reservations').getAll()
        request.onerror = () =>
          reject(request.error ?? new Error('Unable to read Bitcoin input reservations'))
        request.onsuccess = () => resolve(request.result)
      })
      return values.map(value => {
        if (typeof value !== 'object' || value === null || !('reservation' in value)) {
          throw new Error('Invalid Bitcoin input reservation test record')
        }
        const reservation = value.reservation
        if (
          typeof reservation !== 'object' ||
          reservation === null ||
          !('state' in reservation) ||
          typeof reservation.state !== 'string' ||
          !('transactionId' in reservation) ||
          typeof reservation.transactionId !== 'string'
        ) {
          throw new Error('Invalid Bitcoin input reservation test payload')
        }
        return { state: reservation.state, transactionId: reservation.transactionId }
      })
    } finally {
      database.close()
    }
  })
}

async function triggerBitcoinMonitor(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await chrome.alarms.create('bitcoin-transaction-monitor-alarm', {
      when: Date.now() + 100
    })
  })
}

test('discovers, signs, broadcasts, monitors, and records a BIP-84 transfer in real MV3', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(240_000)
  const network = await mockBitcoinNetwork(context)

  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)

  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 30_000 })
  await expect(popup.getByText('BTC', { exact: true }).first()).toBeVisible({ timeout: 60_000 })
  await expect(
    popup.getByRole('button', { name: 'View BTC details on Bitcoin Testnet' })
  ).toBeVisible()
  await expectNoHorizontalOverflow(popup)

  await popup.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(popup.getByRole('button', { name: 'Send BTC on Bitcoin Testnet' })).toBeVisible({
    timeout: 30_000
  })
  await expect(popup.getByText('0.001 BTC', { exact: true })).toBeVisible()
  await captureScreenshot(popup, 'bitcoin-testnet-send-assets.png')

  await popup.getByRole('button', { name: 'Send BTC on Bitcoin Testnet' }).click()
  await expect(popup.getByLabel('Send To')).toBeFocused()
  await expect(
    popup
      .locator('#bitcoin-send-recipient, input[aria-label="BTC amount"]')
      .evaluateAll(elements =>
        elements.map(element => element.id || element.getAttribute('aria-label'))
      )
  ).resolves.toEqual(['bitcoin-send-recipient', 'BTC amount'])
  await popup.getByLabel('Send To').fill(WRONG_NETWORK_RECIPIENT)
  await expect(popup.getByText(/valid Bitcoin testnet address/i)).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled()

  await popup.getByLabel('Send To').fill(RECIPIENT)
  await expect(popup.getByTestId('send-asset-header')).toContainText('BTC')
  await expect(popup.getByTestId('send-asset-header')).toContainText('Bitcoin Testnet')
  await popup.getByRole('button', { name: 'Max', exact: true }).click()
  expect(Number(await popup.getByLabel('BTC amount').inputValue())).toBeLessThan(0.001)
  await expect(popup.getByTestId('send-amount-card')).toContainText('Available')
  await expect(popup.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled({
    timeout: 30_000
  })
  await captureScreenshot(popup, 'bitcoin-native-max-available.png')
  await expect(popup.getByRole('button', { name: 'Max', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(popup.getByTestId('send-network-fee')).not.toContainText('—', {
    timeout: 30_000
  })
  await expect(popup.getByTestId('send-network-fee')).toContainText('Standard')
  await expect(popup.getByTestId('send-network-fee')).toContainText('BTC')
  await expect(popup.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled()
  await expectNoHorizontalOverflow(popup)
  await captureScreenshot(popup, 'bitcoin-testnet-send-form.png')
  await popup.getByRole('button', { name: 'Continue', exact: true }).click()

  const reviewDialog = popup.getByRole('dialog')
  await expect(reviewDialog.getByRole('heading', { name: 'Review Send' })).toBeVisible({
    timeout: 60_000
  })
  const reviewNetworkLabels = reviewDialog.getByText('Bitcoin Testnet', { exact: true })
  await expect(reviewNetworkLabels).toHaveCount(2)
  await expect(reviewNetworkLabels.first()).toBeVisible()
  await expect(reviewNetworkLabels.last()).toBeVisible()
  await expect(reviewDialog.getByText('Network fee', { exact: true })).toBeVisible()
  await expect(reviewDialog.getByText('Native SegWit · BIP-84', { exact: true })).toBeVisible()
  await expect(reviewDialog.getByText('0.001 BTC', { exact: true })).toBeVisible()
  await expect(reviewDialog.getByText('Inputs', { exact: true })).toBeVisible()
  await expect(reviewDialog.getByText('1', { exact: true })).toBeVisible()
  await waitForDialogAnimations(popup)
  await expectNoHorizontalOverflow(popup)
  await captureScreenshot(popup, 'bitcoin-testnet-send-review.png')

  await reviewDialog.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(popup.getByText('Transaction Submitted', { exact: true })).toBeVisible({
    timeout: 60_000
  })
  await expect(popup.locator('[data-transaction-status="broadcast"]')).toBeVisible()
  await expect(popup.getByText('Network fee', { exact: true })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'View Activity', exact: true })).toBeVisible()
  await expectNoHorizontalOverflow(popup)
  await expectTransactionResultContentFits(popup)
  await captureScreenshot(popup, 'bitcoin-testnet-transaction-broadcast.png')

  expect(network.rawTransactions).toHaveLength(1)
  expect(network.rawTransactions[0]).toMatch(/^[0-9a-f]+$/)
  expect(network.transactionId()).toMatch(/^[0-9a-f]{64}$/)
  const discoveredAddresses = [...new Set(network.addresses)]
  expect(discoveredAddresses).toHaveLength(1)
  expect(discoveredAddresses[0]).toMatch(/^tb1q/)

  network.setConfirmationDepth(1)
  await triggerBitcoinMonitor(popup)
  await expect(popup.getByText('Confirming Transaction', { exact: true })).toBeVisible({
    timeout: 15_000
  })
  await expect(popup.getByText('Confirming · 1/6', { exact: true })).toBeVisible()
  await expectTransactionResultContentFits(popup)
  await captureScreenshot(popup, 'bitcoin-testnet-transaction-confirming.png')

  network.setConfirmationDepth(0)
  await triggerBitcoinMonitor(popup)
  await expect(popup.getByText('Reconfirming Transaction', { exact: true })).toBeVisible({
    timeout: 15_000
  })
  await expect(popup.getByText('Reconfirming · 0/6', { exact: true })).toBeVisible()
  await expectNoHorizontalOverflow(popup)
  await expectTransactionResultContentFits(popup)
  await captureScreenshot(popup, 'bitcoin-testnet-transaction-reconfirming.png')

  network.setConfirmationDepth(1)
  await triggerBitcoinMonitor(popup)
  await expect(popup.getByText('Reconfirming · 1/6', { exact: true })).toBeVisible({
    timeout: 15_000
  })

  network.setConfirmationDepth(6)
  await triggerBitcoinMonitor(popup)
  await expect(popup.getByText('Transaction Confirmed', { exact: true })).toBeVisible({
    timeout: 15_000
  })
  await expect(popup.locator('[data-transaction-status="final"]')).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Done', exact: true })).toBeVisible()
  await expectTransactionResultContentFits(popup)
  await captureScreenshot(popup, 'bitcoin-testnet-transaction-final.png')

  const activity = (await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'GET_BITCOIN_ACTIVITY' })
  )) as {
    result: {
      items: Array<{
        source: string
        status: string
        snapshot?: {
          primaryAmount?: { assetId: string; amountRaw: string }
          feeLimit?: { amountRaw: string }
          recipient?: { address: string }
        }
      }>
    }
  }
  const sent = activity.result.items.find(
    item => item.snapshot?.primaryAmount?.assetId === BITCOIN_TESTNET_ASSET_ID
  )
  expect(sent).toMatchObject({
    source: 'wallet-v2',
    status: 'final',
    snapshot: {
      primaryAmount: {
        assetId: BITCOIN_TESTNET_ASSET_ID,
        amountRaw: expect.stringMatching(/^[1-9][0-9]*$/)
      },
      feeLimit: { amountRaw: expect.stringMatching(/^[1-9][0-9]*$/) },
      recipient: { address: RECIPIENT }
    }
  })
  expect(
    activity.result.items.filter(
      item => item.snapshot?.primaryAmount?.assetId === BITCOIN_TESTNET_ASSET_ID
    )
  ).toHaveLength(1)
  expect(
    BigInt(sent?.snapshot?.primaryAmount?.amountRaw ?? '0') +
      BigInt(sent?.snapshot?.feeLimit?.amountRaw ?? '0')
  ).toBe(BigInt(UTXO_VALUE_SATS))

  await popup.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 30_000 })
  await expect(
    popup.getByRole('button', { name: 'View BTC details on Bitcoin Testnet' })
  ).toContainText('0 BTC')
  const saveRecipientToast = popup.locator('[data-toast-variant="bottom-action"]')
  await expect(saveRecipientToast.getByText('Save recipient?', { exact: true })).toBeVisible()
  await expect(saveRecipientToast).toContainText('Bitcoin Testnet')
  await captureScreenshot(popup, 'bitcoin-testnet-save-recipient-toast.png')
  await saveRecipientToast.getByRole('button', { name: 'Not now', exact: true }).click()
  await expect(saveRecipientToast).toBeHidden()
  await expect
    .poll(() =>
      popup.evaluate(async () => {
        const storage = await chrome.storage.session.get('address_book_prompt_dismissals')
        const dismissals = storage.address_book_prompt_dismissals
        return dismissals && typeof dismissals === 'object' ? Object.keys(dismissals).length : 0
      })
    )
    .toBe(1)
  await popup.getByRole('tab', { name: 'Activity' }).click()
  await expect(popup.getByText('Sent BTC', { exact: true })).toBeVisible()
  const bitcoinActivityRow = popup.getByRole('button', { name: 'View Sent BTC details' })
  await expect(bitcoinActivityRow.locator('[data-activity-avatar="token"]')).toBeVisible()
  await expect(bitcoinActivityRow.locator('[data-activity-chain-badge]')).toBeVisible()
  await expect(
    bitcoinActivityRow.getByText(`To: ${RECIPIENT.slice(0, 6)}...${RECIPIENT.slice(-6)}`, {
      exact: true
    })
  ).toBeVisible()
  await captureScreenshot(popup, 'bitcoin-testnet-activity.png')
  await bitcoinActivityRow.click()
  const detail = popup.locator('[data-activity-detail-id]')
  await expect(detail.getByRole('heading', { name: 'Send', exact: true })).toBeVisible()
  const bitcoinIcon = detail.getByRole('img', { name: 'BTC' })
  await expect(bitcoinIcon).toBeVisible()
  await expect(bitcoinIcon).toHaveAttribute(
    'src',
    'https://assets-cdn.trustwallet.com/blockchains/bitcoin/info/logo.png'
  )
  await expect
    .poll(() => bitcoinIcon.evaluate(image => (image as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0)
  await expect(detail.getByText('Status', { exact: true })).toBeVisible()
  await expect(detail.getByText('From', { exact: true })).toBeVisible()
  await expect(detail.getByText('To', { exact: true })).toBeVisible()
  await expect(detail.getByText('Network fee', { exact: true })).toBeVisible()
  await expect(detail.getByRole('button', { name: 'More details' })).toHaveCount(0)
  await expect(detail.locator('a[href^="https://mempool.space/testnet/tx/"]')).toHaveAttribute(
    'href',
    `https://mempool.space/testnet/tx/${network.transactionId()}`
  )
  await expectNoHorizontalOverflow(popup)
  await waitForDialogAnimations(popup)
  await captureScreenshot(popup, 'bitcoin-testnet-activity-detail-v1.png')
})

test('recovers a finalized Bitcoin replacement across service worker reconstruction', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(240_000)
  const network = await mockBitcoinNetwork(context)

  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)

  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 30_000 })
  await expect(popup.getByText('BTC', { exact: true }).first()).toBeVisible({ timeout: 60_000 })
  await popup.getByRole('button', { name: 'Send', exact: true }).click()
  await popup.getByRole('button', { name: 'Send BTC on Bitcoin Testnet' }).click()
  await popup.getByLabel('Send To').fill(RECIPIENT)
  await popup.getByRole('button', { name: 'Max', exact: true }).click()
  await popup.getByRole('button', { name: 'Continue', exact: true }).click()

  const reviewDialog = popup.getByRole('dialog')
  await expect(reviewDialog.getByRole('heading', { name: 'Review Send' })).toBeVisible({
    timeout: 60_000
  })
  await reviewDialog.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(popup.getByText('Transaction Submitted', { exact: true })).toBeVisible({
    timeout: 60_000
  })

  await expect
    .poll(() => readBitcoinInputReservations(popup))
    .toEqual([
      expect.objectContaining({
        state: 'committed',
        transactionId: expect.stringMatching(/^transaction:bitcoin:/)
      })
    ])

  network.setReplacementDepth(1)
  await triggerBitcoinMonitor(popup)
  await expect(popup.locator('[data-transaction-status="broadcast"]')).toBeVisible()
  await expect(readBitcoinInputReservations(popup)).resolves.toHaveLength(1)

  await terminateExtensionServiceWorker(context, popup)
  await waitForBackgroundWalletInitialization(popup)

  network.setReplacementDepth(6)
  await triggerBitcoinMonitor(popup)
  await expect(
    popup.getByRole('heading', { name: 'Transaction Replaced', exact: true })
  ).toBeVisible({ timeout: 20_000 })
  await expect(popup.locator('header')).toHaveCount(0)
  await expect(
    popup.getByText('Another transaction used the same network input.', { exact: true })
  ).toBeVisible()
  await expect(popup.getByText('Replacement', { exact: true })).toBeVisible()
  await expect(
    popup.locator(`a[href="https://mempool.space/testnet/tx/${REPLACEMENT_TRANSACTION_ID}"]`)
  ).toBeVisible()
  await expectNoHorizontalOverflow(popup)
  await expectTransactionResultContentFits(popup)
  await captureScreenshot(popup, 'bitcoin-testnet-transaction-replaced-headerless-spaced.png')

  await expect.poll(() => readBitcoinInputReservations(popup)).toEqual([])

  const activity = (await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'GET_BITCOIN_ACTIVITY' })
  )) as {
    result: {
      items: Array<{
        source: string
        status: string
        failureCode?: string
        snapshot?: { primaryAmount?: { assetId: string } }
        segments: Array<{
          status: string
          failureCode?: string
          evidence?: {
            transactionHash?: string
            replacementTransactionHash?: string
            externalReference?: string
            confirmations?: number
            requiredConfirmations?: number
          }
        }>
      }>
    }
  }
  const replaced = activity.result.items.find(
    item => item.snapshot?.primaryAmount?.assetId === BITCOIN_TESTNET_ASSET_ID
  )
  expect(replaced).toMatchObject({
    source: 'wallet-v2',
    status: 'failed',
    failureCode: 'dropped',
    segments: [
      {
        status: 'failed',
        failureCode: 'dropped',
        evidence: {
          transactionHash: network.transactionId(),
          replacementTransactionHash: REPLACEMENT_TRANSACTION_ID,
          externalReference: `${UTXO_TRANSACTION_ID}:0`,
          confirmations: 6,
          requiredConfirmations: 6
        }
      }
    ]
  })

  await popup.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 30_000 })
  await popup.getByRole('tab', { name: 'Activity' }).click()
  await expect(popup.getByText('Replaced', { exact: true })).toBeVisible()
  await popup.getByRole('button', { name: 'View Sent BTC details' }).click()

  const detail = popup.locator('[data-activity-detail-id]')
  await expect(
    detail.getByText('Replaced by a confirmed transaction', { exact: true })
  ).toBeVisible()
  await expect(detail.getByText('Replacement Hash', { exact: true })).toBeVisible()
  await expect(detail.getByText('Spent input', { exact: true })).toHaveCount(0)
  await expect(detail.getByRole('button', { name: 'More details' })).toHaveCount(0)
  await expect(
    detail.locator(`a[href="https://mempool.space/testnet/tx/${REPLACEMENT_TRANSACTION_ID}"]`)
  ).toBeVisible()
  await expectNoHorizontalOverflow(popup)
  await waitForDialogAnimations(popup)
  await captureScreenshot(popup, 'bitcoin-testnet-activity-replaced-v1.png')
})
