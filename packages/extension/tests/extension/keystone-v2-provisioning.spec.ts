import {
  captureScreenshot,
  expect,
  test,
  terminateExtensionServiceWorker,
  waitForBackgroundWalletInitialization
} from '../helpers/extension-fixtures'
import * as secp256k1 from '@bitcoinerlab/secp256k1'
import { HDKey } from '@scure/bip32'
import { Buffer } from 'buffer'
import { CryptoPSBT, DataItem, extend } from '@keystonehq/bc-ur-registry'
import type { BrowserContext, Route } from '@playwright/test'
import {
  address as bitcoinAddress,
  initEccLib,
  networks,
  payments,
  Psbt,
  Transaction
} from 'bitcoinjs-lib'
import { keccak256, parseTransaction, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { BUILTIN_EVM_NETWORKS } from '../../src/config/networks'

initEccLib(secp256k1)

const PASSWORD = 'keystone-v2-first-password'
const NEW_PASSWORD = 'keystone-v2-changed-password'
const SOFTWARE_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const KEYSTONE_ROOT = HDKey.fromMasterSeed(Buffer.alloc(32, 7))
const KEYSTONE_EVM_KEY = KEYSTONE_ROOT.derive("m/44'/60'/0'/0/0")
const KEYSTONE_BITCOIN_ACCOUNT_KEY = KEYSTONE_ROOT.derive("m/84'/0'/0'")
const KEYSTONE_BITCOIN_RECEIVE_KEY = KEYSTONE_BITCOIN_ACCOUNT_KEY.derive('m/0/0')
if (
  !KEYSTONE_EVM_KEY.privateKey ||
  !KEYSTONE_EVM_KEY.publicKey ||
  !KEYSTONE_BITCOIN_ACCOUNT_KEY.publicKey ||
  !KEYSTONE_BITCOIN_ACCOUNT_KEY.chainCode ||
  !KEYSTONE_BITCOIN_RECEIVE_KEY.privateKey ||
  !KEYSTONE_BITCOIN_RECEIVE_KEY.publicKey
) {
  throw new Error('Unable to create deterministic Keystone test keys')
}
const MASTER_FINGERPRINT_HEX = KEYSTONE_ROOT.fingerprint.toString(16).padStart(8, '0')
const EVM_PRIVATE_KEY = `0x${Buffer.from(KEYSTONE_EVM_KEY.privateKey).toString('hex')}` as Hex
const EVM_PUBLIC_KEY = Buffer.from(KEYSTONE_EVM_KEY.publicKey).toString('hex')
const BITCOIN_PUBLIC_KEY = Buffer.from(KEYSTONE_BITCOIN_ACCOUNT_KEY.publicKey).toString('hex')
const CHAIN_CODE = Buffer.from(KEYSTONE_BITCOIN_ACCOUNT_KEY.chainCode).toString('hex')
const EXPECTED_EVM_ADDRESS = privateKeyToAccount(EVM_PRIVATE_KEY).address
const EXPECTED_BITCOIN_ADDRESS = payments.p2wpkh({
  pubkey: Buffer.from(KEYSTONE_BITCOIN_RECEIVE_KEY.publicKey),
  network: networks.bitcoin
}).address
if (!EXPECTED_BITCOIN_ADDRESS) throw new Error('Unable to create deterministic Bitcoin address')
const ZCASH_UFVK =
  'uview1qggz6nejagvka9wtm9r7xf84kkwy4cc0cgchptr98w0cyz33cj4958q5ulkd32nz2u3s0sp9yhcw7tu2n3nlw9x6ulghyd2zgc857tnzme2zpr3vn24zhtm2rjduv9a5zxlmzz404n7l0k69gmu4tfn2g3vpcn03rhz63e3l92fn8gra37tyly7utvgveswl20vz23pu84rc2nyqess38wvlgr2xzyhgj232ne5qutpe6ql6ghzetdy7pfzcmdzd5gd5dnwk25fwv7nnzmnty7u5ax3nzzgr6pdc905ckpd0s9v2cvn7e03qm7r46e5ngax536ywz7zxjptymm90px0rhvmqtwvttuy6d7degly023lqvskclk6mezyt69dwu6c4tfzrjgq4uuh5xa9m5dclgatykgtrrw268qe5pldfkx73f2kd5yyy2tjpjql92pa6tsk2nh2h88q23nee9z379het4akl6haqmuwf9d0nl0susg4tnxyk'
const ZCASH_SEED_FINGERPRINT = '21ed3d7882c7e37fe012b54a6408048048cb09782d4b2938617da793ccd27815'
const MAINNET_GENESIS = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f'
const EVM_RPC_URL = 'https://eth.deltarpc.com/**'
const EVM_HISTORY_URLS = [
  'https://eth.blockscout.com/api/**',
  'https://arbitrum.blockscout.com/api/**',
  'https://base.blockscout.com/api/**',
  'https://explorer.optimism.io/api/**',
  'https://polygon.blockscout.com/api/**'
] as const
const MEMPOOL_URL = 'https://mempool.space/api/**'
const BLOCKSTREAM_URL = 'https://blockstream.info/api/**'
const EMZY_URL = 'https://mempool.emzy.de/api/**'
const UTXO_TRANSACTION_ID = 'b'.repeat(64)
const UTXO_VALUE_SATS = 100_000
const EVM_RECIPIENT = '0x1111111111111111111111111111111111111111'
const BITCOIN_RECIPIENT = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
const MAINNET_EVM_NETWORKS = BUILTIN_EVM_NETWORKS.mainnet
const MAINNET_EVM_NETWORK_NAMES = Object.freeze(
  MAINNET_EVM_NETWORKS.map(network => network.displayName)
)

const credential = Object.freeze({
  schemaVersion: 2,
  vendor: 'keystone',
  firmwareProfile: 'multi-coin',
  capabilities: Object.freeze(['bitcoin', 'evm']),
  accountExport: Object.freeze({
    protocol: 'crypto-multi-accounts-v1',
    masterFingerprintHex: MASTER_FINGERPRINT_HEX,
    keys: Object.freeze([
      Object.freeze({
        publicKeyHex: EVM_PUBLIC_KEY,
        derivationPath: "m/44'/60'/0'/0/0",
        sourceFingerprintHex: MASTER_FINGERPRINT_HEX
      }),
      Object.freeze({
        publicKeyHex: BITCOIN_PUBLIC_KEY,
        chainCodeHex: CHAIN_CODE,
        derivationPath: "m/84'/0'/0'",
        sourceFingerprintHex: MASTER_FINGERPRINT_HEX,
        parentFingerprintHex: KEYSTONE_BITCOIN_ACCOUNT_KEY.parentFingerprint
          .toString(16)
          .padStart(8, '0')
      })
    ]),
    device: 'Keystone 3 Pro',
    version: '2.0.0'
  })
})

interface MockEvmRpcState {
  readonly rawTransactions: string[]
}

async function mockEvmNetwork(context: BrowserContext): Promise<MockEvmRpcState> {
  const state: MockEvmRpcState = { rawTransactions: [] }
  for (const url of EVM_HISTORY_URLS) {
    await context.route(url, route =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ status: '0', message: 'No transactions found', result: [] })
      })
    )
  }
  await context.route(EVM_RPC_URL, async route => {
    const request = route.request().postDataJSON() as {
      id: number
      method: string
      params?: readonly unknown[]
    }
    const result =
      request.method === 'eth_chainId'
        ? '0x1'
        : request.method === 'eth_getBalance'
          ? '0xde0b6b3a7640000'
          : request.method === 'eth_getTransactionCount'
            ? '0x0'
            : request.method === 'eth_call'
              ? '0x'
              : request.method === 'eth_estimateGas'
                ? '0x5208'
                : request.method === 'eth_maxPriorityFeePerGas'
                  ? '0x3b9aca00'
                  : request.method === 'eth_getBlockByNumber'
                    ? { number: '0x101', baseFeePerGas: '0x3b9aca00' }
                    : request.method === 'eth_sendRawTransaction'
                      ? (() => {
                          const rawTransaction = request.params?.[0]
                          if (
                            typeof rawTransaction !== 'string' ||
                            !/^0x[0-9a-f]+$/.test(rawTransaction)
                          ) {
                            throw new Error('Invalid EVM raw transaction in mock broadcast')
                          }
                          state.rawTransactions.push(rawTransaction)
                          return keccak256(rawTransaction as Hex)
                        })()
                      : null
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id: request.id, result })
    })
  })
  return state
}

async function createKeystoneEvmSignatureResponse(requestCborBase64: string): Promise<string> {
  const requestData = extend
    .decodeToDataItem(Buffer.from(requestCborBase64, 'base64'))
    .getData() as Record<number, unknown>
  const requestId = requestData[1]
  if (
    !(requestId instanceof DataItem) ||
    requestId.getTag() !== extend.RegistryTypes.UUID.getTag()
  ) {
    throw new Error('Keystone EVM request is missing its UUID binding')
  }
  const unsignedTransaction =
    `0x${Buffer.from(requestData[2] as Uint8Array).toString('hex')}` as Hex
  const parsedUnsigned = parseTransaction(unsignedTransaction)
  if (
    parsedUnsigned.type !== 'eip1559' ||
    parsedUnsigned.chainId !== 1 ||
    parsedUnsigned.nonce !== 0 ||
    parsedUnsigned.maxFeePerGas !== 3_000_000_000n ||
    parsedUnsigned.maxPriorityFeePerGas !== 1_000_000_000n ||
    parsedUnsigned.gas !== 21_000n ||
    parsedUnsigned.to?.toLowerCase() !== EVM_RECIPIENT ||
    parsedUnsigned.value !== 1_000_000_000_000_000n ||
    parsedUnsigned.data !== undefined
  ) {
    throw new Error('Keystone EVM request does not match the reviewed transaction')
  }
  const signedTransaction = await privateKeyToAccount(EVM_PRIVATE_KEY).signTransaction({
    type: 'eip1559',
    chainId: 1,
    nonce: 0,
    maxFeePerGas: 3_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    gas: 21_000n,
    to: EVM_RECIPIENT,
    value: 1_000_000_000_000_000n,
    data: '0x'
  })
  const parsedSigned = parseTransaction(signedTransaction)
  if (
    parsedSigned.r === undefined ||
    parsedSigned.s === undefined ||
    parsedSigned.yParity === undefined
  ) {
    throw new Error('Synthetic Keystone EVM signature is incomplete')
  }
  const signature = Buffer.from(
    `${parsedSigned.r.slice(2)}${parsedSigned.s.slice(2)}${parsedSigned.yParity.toString(16).padStart(2, '0')}`,
    'hex'
  )
  const response = extend.encodeDataItem(
    new DataItem({
      1: new DataItem(Buffer.from(requestId.getData()), extend.RegistryTypes.UUID.getTag()),
      2: signature,
      3: 'Keystone'
    })
  )
  return Buffer.from(response).toString('base64')
}

function createKeystoneSignedBitcoinPsbt(unsignedPsbtBase64: string): string {
  const psbt = Psbt.fromBase64(unsignedPsbtBase64, { network: networks.bitcoin })
  const derivation = psbt.data.inputs[0]?.bip32Derivation?.[0]
  if (
    psbt.inputCount !== 1 ||
    !derivation ||
    derivation.path !== "m/84'/0'/0'/0/0" ||
    !derivation.masterFingerprint.equals(Buffer.from(MASTER_FINGERPRINT_HEX, 'hex')) ||
    !derivation.pubkey.equals(Buffer.from(KEYSTONE_BITCOIN_RECEIVE_KEY.publicKey))
  ) {
    throw new Error('Keystone Bitcoin request does not match the exported Account')
  }
  psbt.signInput(0, {
    publicKey: Buffer.from(KEYSTONE_BITCOIN_RECEIVE_KEY.publicKey),
    sign: hash =>
      Buffer.from(secp256k1.sign(hash, Buffer.from(KEYSTONE_BITCOIN_RECEIVE_KEY.privateKey)))
  })
  if (psbt.data.inputs[0]?.partialSig?.length !== 1) {
    throw new Error('Synthetic Keystone Bitcoin signature is incomplete')
  }
  const encodedResponse = new CryptoPSBT(psbt.toBuffer()).toCBOR()
  return Buffer.from(CryptoPSBT.fromCBOR(Buffer.from(encodedResponse)).getPSBT()).toString('base64')
}

interface MockBitcoinRpcState {
  readonly rawTransactions: string[]
}

async function mockBitcoinNetwork(context: BrowserContext): Promise<MockBitcoinRpcState> {
  let fundedAddress: string | null = null
  const state: MockBitcoinRpcState = { rawTransactions: [] }
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
      const rawTransaction = request.postData()
      if (!rawTransaction || !/^(?:[0-9a-f]{2})+$/.test(rawTransaction)) {
        throw new Error('Invalid Bitcoin raw transaction in mock broadcast')
      }
      state.rawTransactions.push(rawTransaction)
      await route.fulfill({
        contentType: 'text/plain',
        body: Transaction.fromHex(rawTransaction).getId()
      })
      return
    }
    if (/^tx\/[0-9a-f]{64}\/status$/.test(path)) {
      await fulfillJson(route, { confirmed: false })
      return
    }
    const utxoMatch = /^address\/(.+)\/utxo$/.exec(path)
    if (utxoMatch) {
      await fulfillJson(
        route,
        utxoMatch[1] === fundedAddress
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
      fundedAddress ??= addressMatch[1]
      const used = addressMatch[1] === fundedAddress
      await fulfillJson(route, {
        address: addressMatch[1],
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
  return state
}

async function expectPopupFits(page: import('@playwright/test').Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => ({
        viewportWidth: document.documentElement.clientWidth,
        documentWidth: document.documentElement.scrollWidth,
        viewportHeight: document.documentElement.clientHeight
      }))
    )
    .toEqual({ viewportWidth: 375, documentWidth: 375, viewportHeight: 600 })
}

test('groups a Keystone wallet and persists wallet and account names', async ({
  popup,
  extensionId
}) => {
  await waitForBackgroundWalletInitialization(popup)
  const provisioned = await popup.evaluate(
    async ({ credential, password }) =>
      chrome.runtime.sendMessage({
        type: 'PROVISION_KEYSTONE_HARDWARE',
        credential,
        displayName: 'Keystone Multi-Coin',
        password
      }),
    { credential, password: PASSWORD }
  )
  expect(provisioned).toMatchObject({
    success: true,
    result: { status: 'committed', keyDomainId: expect.stringMatching(/^wallet:keystone-v2:/) }
  })
  const walletId = provisioned.result.keyDomainId
  const catalog = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })
  )
  const account = catalog.result.accounts[0]
  expect(account).toMatchObject({ walletId, walletSource: { kind: 'hardware' } })

  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  const group = popup.locator('section[aria-label="Wallet group Keystone Multi-Coin"]')
  await expect(group).toBeVisible()
  await expect(group.locator('[aria-label^="Account actions for "]')).toHaveCount(1)
  await expect(group.getByRole('button', { name: 'Add Account', exact: true })).toHaveCount(0)
  const renameKeystoneAccount = group.getByRole('button', {
    name: `Rename account ${account.accountDisplayName}`
  })
  await renameKeystoneAccount.hover()
  await expect(renameKeystoneAccount.locator('svg')).toBeVisible()
  await renameKeystoneAccount.click()
  await group.getByRole('textbox', { name: 'Account name' }).fill('Keystone Treasury')
  await group.getByRole('textbox', { name: 'Account name' }).press('Enter')
  await expect(group.getByRole('textbox', { name: 'Account name' })).toHaveCount(0)
  const renameKeystoneWallet = popup.getByRole('button', {
    name: 'Rename wallet Keystone Multi-Coin'
  })
  await renameKeystoneWallet.hover()
  await expect(renameKeystoneWallet.locator('svg')).toBeVisible()
  await renameKeystoneWallet.click()
  await group.getByRole('textbox', { name: 'Wallet name' }).fill('Keystone Archive')
  await group.getByRole('textbox', { name: 'Wallet name' }).press('Enter')
  await expect(group.getByRole('textbox', { name: 'Wallet name' })).toHaveCount(0)
  await popup.reload()
  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  const renamedGroup = popup.locator('section[aria-label="Wallet group Keystone Archive"]')
  await expect(
    renamedGroup.getByRole('button', { name: 'Account actions for Keystone Treasury' })
  ).toBeVisible()
  await expect(renamedGroup.getByRole('button', { name: 'Add Account', exact: true })).toHaveCount(
    0
  )
  const renamedCatalog = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })
  )
  expect(renamedCatalog.result.accounts[0]).toMatchObject({
    walletId,
    accountId: account.accountId,
    walletDisplayName: 'Keystone Archive',
    accountDisplayName: 'Keystone Treasury'
  })
})

test('provisions and operates a pure Storage V2 Multi-Coin Keystone Wallet', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  const evmRpcState = await mockEvmNetwork(context)
  const bitcoinRpcState = await mockBitcoinNetwork(context)
  await waitForBackgroundWalletInitialization(popup)

  const provisioned = await popup.evaluate(
    async ({ credential, password }) =>
      chrome.runtime.sendMessage({
        type: 'PROVISION_KEYSTONE_HARDWARE',
        credential,
        displayName: 'Keystone Multi-Coin',
        password
      }),
    { credential, password: PASSWORD }
  )
  expect(provisioned).toMatchObject({
    success: true,
    result: {
      status: 'committed',
      keyDomainId: expect.stringMatching(/^wallet:keystone-v2:/),
      accountIds: [expect.stringMatching(/^account:keystone-v2:/)]
    }
  })

  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(popup.getByRole('button', { name: 'Swap', exact: true })).toBeVisible({
    timeout: 30_000
  })
  await expect(popup.getByRole('button', { name: 'Lending' })).toHaveCount(0)
  await expect(popup.getByRole('button', { name: 'Swap', exact: true })).toBeVisible()
  await expectPopupFits(popup)

  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  await expect(popup.getByText('Keystone Multi-Coin', { exact: true })).toBeVisible()
  const networkTrigger = popup.getByRole('button', { name: 'Expand account networks' })
  await expect(networkTrigger).toContainText(`Networks (${MAINNET_EVM_NETWORK_NAMES.length + 1})`)
  await networkTrigger.click()
  const networks = popup.getByRole('region', { name: 'Account networks' })
  await expect(networks.getByText('EVM', { exact: true })).toBeVisible()
  await expect(networks.getByText('Bitcoin', { exact: true })).toBeVisible()
  await expect(networks.getByText('Zcash', { exact: true })).toHaveCount(0)
  const evmAddressButtons = networks.locator(`[title="${EXPECTED_EVM_ADDRESS}"]`)
  await expect(evmAddressButtons).toHaveCount(1)
  await expect(evmAddressButtons).toBeVisible()
  await expect(networks.locator(`[title="${EXPECTED_BITCOIN_ADDRESS}"]`)).toBeVisible()
  await expectPopupFits(popup)
  await captureScreenshot(popup, 'keystone-v2-account-networks.png')

  await popup.getByRole('button', { name: 'Back' }).click()
  await popup.getByRole('button', { name: 'Receive', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Addresses' })).toBeVisible()
  const receiveAddresses = popup.getByRole('region', { name: 'Account network addresses' })
  for (const network of [...MAINNET_EVM_NETWORK_NAMES, 'Bitcoin']) {
    await expect(
      receiveAddresses.getByRole('heading', { name: network, exact: true })
    ).toBeVisible()
  }
  await expect(receiveAddresses.getByRole('heading', { name: 'Zcash' })).toHaveCount(0)
  await expect(receiveAddresses.getByText('Native SegWit', { exact: true })).toBeVisible()
  await expect(receiveAddresses.locator(`[title="${EXPECTED_BITCOIN_ADDRESS}"]`)).toBeVisible()
  await expectPopupFits(popup)
  await captureScreenshot(popup, 'keystone-v2-receive-bitcoin.png')

  const sendPage = await context.newPage()
  await sendPage.setViewportSize({ width: 375, height: 600 })
  await sendPage.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(sendPage.getByRole('button', { name: 'Send', exact: true })).toBeVisible({
    timeout: 30_000
  })
  await sendPage.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(sendPage.getByRole('button', { name: /^Send BTC on / })).toBeVisible({
    timeout: 60_000
  })
  await sendPage.getByRole('button', { name: /^Send BTC on / }).click()
  await sendPage.getByLabel('Send To').fill(BITCOIN_RECIPIENT)
  await sendPage.locator('input[aria-label="BTC amount"]').fill('0.0005')
  await sendPage.getByRole('button', { name: 'Continue', exact: true }).click()
  const reviewDialog = sendPage.getByRole('dialog')
  await expect(reviewDialog.getByRole('heading', { name: 'Review Send' })).toBeVisible({
    timeout: 60_000
  })
  const signingPagePromise = context.waitForEvent('page', { timeout: 60_000 })
  await reviewDialog.getByRole('button', { name: 'Send', exact: true }).click()
  const signingPage = await signingPagePromise
  await signingPage.setViewportSize({ width: 375, height: 632 })
  const signingUrl = signingPage.url()
  await expect(signingPage.getByText('Approved in Noir Wallet', { exact: true })).toBeVisible({
    timeout: 30_000
  })
  await expect(signingPage.locator('.rounded-2xl.bg-white svg')).toBeVisible()
  await expect(signingPage.getByRole('button', { name: 'Scan Signed Transaction' })).toBeVisible()
  await expect
    .poll(() =>
      signingPage.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
        footerVisible:
          document.querySelector('.page-footer')?.getBoundingClientRect().bottom ===
          document.documentElement.clientHeight
      }))
    )
    .toEqual({ width: 375, viewportWidth: 375, footerVisible: true })
  await captureScreenshot(signingPage, 'keystone-bitcoin-sign-review.png')
  const signingPageClosed = signingPage.waitForEvent('close')
  await signingPage.getByRole('button', { name: 'Close', exact: true }).click()
  await signingPageClosed
  const cancelledSigningPage = await context.newPage()
  await cancelledSigningPage.setViewportSize({ width: 375, height: 632 })
  await cancelledSigningPage.goto(signingUrl)
  await expect(cancelledSigningPage.getByText('Request unavailable', { exact: true })).toBeVisible()
  await cancelledSigningPage.close()

  const retrySendPage = await context.newPage()
  await retrySendPage.setViewportSize({ width: 375, height: 600 })
  await retrySendPage.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(retrySendPage.getByRole('button', { name: 'Send', exact: true })).toBeVisible({
    timeout: 30_000
  })
  await retrySendPage.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(retrySendPage.getByRole('button', { name: /^Send BTC on / })).toBeVisible({
    timeout: 30_000
  })
  await retrySendPage.getByRole('button', { name: /^Send BTC on / }).click()
  await retrySendPage.getByLabel('Send To').fill(BITCOIN_RECIPIENT)
  await retrySendPage.locator('input[aria-label="BTC amount"]').fill('0.0005')
  await retrySendPage.getByRole('button', { name: 'Continue', exact: true }).click()
  const retryReview = retrySendPage.getByRole('dialog')
  await expect(retryReview.getByRole('heading', { name: 'Review Send' })).toBeVisible({
    timeout: 30_000
  })
  const retrySigningPagePromise = context.waitForEvent('page', { timeout: 60_000 })
  await retryReview.getByRole('button', { name: 'Send', exact: true }).click()
  const retrySigningPage = await retrySigningPagePromise
  await retrySigningPage.setViewportSize({ width: 375, height: 632 })
  const retrySigningUrl = retrySigningPage.url()
  await expect(retrySigningPage.getByText('Approved in Noir Wallet', { exact: true })).toBeVisible({
    timeout: 30_000
  })
  await terminateExtensionServiceWorker(context, retrySigningPage)
  await retrySigningPage.reload()
  await expect(retrySigningPage.getByText('Approved in Noir Wallet', { exact: true })).toBeVisible({
    timeout: 30_000
  })
  const encodedBitcoinTransactionId = new URL(retrySigningUrl).hash.split('?tx=')[1]
  if (!encodedBitcoinTransactionId) {
    throw new Error('Keystone Bitcoin signing URL has no transaction ID')
  }
  const bitcoinTransactionId = decodeURIComponent(encodedBitcoinTransactionId)
  const bitcoinExternalRequest = await retrySigningPage.evaluate(
    transactionId =>
      chrome.runtime.sendMessage({ type: 'GET_KEYSTONE_BITCOIN_SIGNING_REQUEST', transactionId }),
    bitcoinTransactionId
  )
  expect(bitcoinExternalRequest).toMatchObject({
    result: {
      transactionId: bitcoinTransactionId,
      payloadFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      request: { encoding: 'base64', value: expect.any(String) }
    }
  })
  const signedPsbtBase64 = createKeystoneSignedBitcoinPsbt(
    bitcoinExternalRequest.result.request.value
  )
  const bitcoinSubmission = await retrySigningPage.evaluate(
    ({ transactionId, payloadFingerprint, signedPsbtBase64 }) =>
      chrome.runtime.sendMessage({
        type: 'SUBMIT_KEYSTONE_BITCOIN_SIGNATURE',
        transactionId,
        payloadFingerprint,
        signedPsbtBase64
      }),
    {
      transactionId: bitcoinTransactionId,
      payloadFingerprint: bitcoinExternalRequest.result.payloadFingerprint,
      signedPsbtBase64
    }
  )
  expect(bitcoinSubmission).toMatchObject({
    result: {
      status: 'broadcast',
      graph: {
        root: { status: 'broadcast' },
        segments: [{ status: 'broadcast' }]
      }
    }
  })
  expect(bitcoinRpcState.rawTransactions).toHaveLength(1)
  const broadcastBitcoinTransaction = Transaction.fromHex(bitcoinRpcState.rawTransactions[0])
  expect(broadcastBitcoinTransaction.ins).toHaveLength(1)
  expect(
    broadcastBitcoinTransaction.outs.some(
      output =>
        output.value === 50_000 &&
        bitcoinAddress.fromOutputScript(output.script, networks.bitcoin) === BITCOIN_RECIPIENT
    )
  ).toBe(true)
  await retrySigningPage.close()
  const consumedBitcoinSigningPage = await context.newPage()
  await consumedBitcoinSigningPage.setViewportSize({ width: 375, height: 632 })
  await consumedBitcoinSigningPage.goto(retrySigningUrl)
  await expect(
    consumedBitcoinSigningPage.getByText('Request unavailable', { exact: true })
  ).toBeVisible()
  await consumedBitcoinSigningPage.close()
  await retrySendPage.close()

  const evmSendPage = await context.newPage()
  await evmSendPage.setViewportSize({ width: 375, height: 600 })
  await evmSendPage.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(evmSendPage.getByText('1 ETH', { exact: true })).toBeVisible({ timeout: 30_000 })
  await evmSendPage.getByRole('button', { name: 'Send', exact: true }).click()
  await evmSendPage
    .getByRole('button', { name: /^Send ETH on / })
    .first()
    .click()
  await evmSendPage.getByLabel('Send To').fill(EVM_RECIPIENT)
  await evmSendPage.locator('input[aria-label="ETH amount"]').fill('0.001')
  await evmSendPage.getByRole('button', { name: 'Continue', exact: true }).click()
  const evmReviewDialog = evmSendPage.getByRole('dialog')
  await expect(evmReviewDialog.getByRole('heading', { name: 'Review Send' })).toBeVisible({
    timeout: 30_000
  })
  await expect(evmReviewDialog.getByText('Ethereum', { exact: true }).first()).toBeVisible()
  await expect(evmReviewDialog.getByText('0.001063 ETH', { exact: true })).toBeVisible()
  const evmSigningPagePromise = context.waitForEvent('page', { timeout: 60_000 })
  await evmReviewDialog.getByRole('button', { name: 'Send', exact: true }).click()
  const evmSigningPage = await evmSigningPagePromise
  await evmSigningPage.setViewportSize({ width: 375, height: 632 })
  const evmSigningUrl = evmSigningPage.url()
  await expect(evmSigningPage.getByText('Approved in Noir Wallet', { exact: true })).toBeVisible({
    timeout: 30_000
  })
  await expect(evmSigningPage.locator('.rounded-2xl.bg-white svg')).toBeVisible()
  await expect(evmSigningPage.getByRole('button', { name: 'Scan Signature' })).toBeVisible()
  await expect
    .poll(() =>
      evmSigningPage.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
        footerVisible:
          document.querySelector('.page-footer')?.getBoundingClientRect().bottom ===
          document.documentElement.clientHeight
      }))
    )
    .toEqual({ width: 375, viewportWidth: 375, footerVisible: true })
  await captureScreenshot(evmSigningPage, 'keystone-evm-sign-review.png')
  await terminateExtensionServiceWorker(context, evmSigningPage)
  await evmSigningPage.reload()
  await expect(evmSigningPage.getByText('Approved in Noir Wallet', { exact: true })).toBeVisible({
    timeout: 30_000
  })
  await expect(evmSigningPage.locator('.rounded-2xl.bg-white svg')).toBeVisible()
  const encodedEvmTransactionId = new URL(evmSigningUrl).hash.split('?tx=')[1]
  if (!encodedEvmTransactionId) throw new Error('Keystone EVM signing URL has no transaction ID')
  const evmTransactionId = decodeURIComponent(encodedEvmTransactionId)
  const externalRequest = await evmSigningPage.evaluate(
    transactionId =>
      chrome.runtime.sendMessage({ type: 'GET_KEYSTONE_EVM_SIGNING_REQUEST', transactionId }),
    evmTransactionId
  )
  expect(externalRequest).toMatchObject({
    result: {
      transactionId: evmTransactionId,
      payloadFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      request: {
        encoding: 'base64',
        value: expect.any(String)
      }
    }
  })
  const signatureCborBase64 = await createKeystoneEvmSignatureResponse(
    externalRequest.result.request.value
  )
  const submission = await evmSigningPage.evaluate(
    ({ transactionId, payloadFingerprint, signatureCborBase64 }) =>
      chrome.runtime.sendMessage({
        type: 'SUBMIT_KEYSTONE_EVM_SIGNATURE',
        transactionId,
        payloadFingerprint,
        signatureCborBase64
      }),
    {
      transactionId: evmTransactionId,
      payloadFingerprint: externalRequest.result.payloadFingerprint,
      signatureCborBase64
    }
  )
  expect(submission).toMatchObject({
    result: {
      status: 'broadcast',
      graph: {
        root: { status: 'broadcast' },
        segments: [{ status: 'broadcast' }]
      }
    }
  })
  expect(evmRpcState.rawTransactions).toHaveLength(1)
  const broadcastTransaction = parseTransaction(evmRpcState.rawTransactions[0] as Hex)
  expect(broadcastTransaction).toMatchObject({
    chainId: 1,
    nonce: 0,
    maxFeePerGas: 3_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    gas: 21_000n,
    value: 1_000_000_000_000_000n,
    r: expect.stringMatching(/^0x[0-9a-f]{64}$/),
    s: expect.stringMatching(/^0x[0-9a-f]{64}$/),
    yParity: expect.any(Number)
  })
  expect(broadcastTransaction.to?.toLowerCase()).toBe(EVM_RECIPIENT)
  await evmSigningPage.close()
  const consumedEvmSigningPage = await context.newPage()
  await consumedEvmSigningPage.setViewportSize({ width: 375, height: 632 })
  await consumedEvmSigningPage.goto(evmSigningUrl)
  await expect(
    consumedEvmSigningPage.getByText('Request unavailable', { exact: true })
  ).toBeVisible()
  await consumedEvmSigningPage.close()

  const retryEvmSendPage = await context.newPage()
  await retryEvmSendPage.setViewportSize({ width: 375, height: 600 })
  await retryEvmSendPage.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(retryEvmSendPage.getByText('1 ETH', { exact: true })).toBeVisible({
    timeout: 30_000
  })
  await retryEvmSendPage.getByRole('button', { name: 'Send', exact: true }).click()
  await retryEvmSendPage
    .getByRole('button', { name: /^Send ETH on / })
    .first()
    .click()
  await retryEvmSendPage.getByLabel('Send To').fill(EVM_RECIPIENT)
  await retryEvmSendPage.locator('input[aria-label="ETH amount"]').fill('0.001')
  await retryEvmSendPage.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(
    retryEvmSendPage.getByText(
      'An earlier transaction needs attention. Open Activity to resolve its nonce before sending.'
    )
  ).toBeVisible({ timeout: 30_000 })
  await retryEvmSendPage.close()

  const unauthorizedSigningRead = await popup.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'GET_KEYSTONE_BITCOIN_SIGNING_REQUEST',
      transactionId: 'transaction:bitcoin:unavailable'
    })
  )
  expect(unauthorizedSigningRead).toMatchObject({
    error: { code: 'invalid-request' }
  })
  const bitcoinSignPage = await popup.context().newPage()
  await bitcoinSignPage.setViewportSize({ width: 375, height: 632 })
  await bitcoinSignPage.goto(
    `chrome-extension://${extensionId}/index.html#/hardware/bitcoin-sign?tx=transaction%3Abitcoin%3Aunavailable`
  )
  await expect(bitcoinSignPage.getByText('Request unavailable', { exact: true })).toBeVisible()
  await expect(
    bitcoinSignPage.getByText(
      'This Bitcoin signing request expired, was cancelled, or belongs to another Wallet. Start a new send from Noir Wallet.',
      { exact: true }
    )
  ).toBeVisible()
  await captureScreenshot(bitcoinSignPage, 'keystone-bitcoin-sign-request-unavailable.png')
  await bitcoinSignPage.close()

  const unauthorizedEvmSigningRead = await popup.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'GET_KEYSTONE_EVM_SIGNING_REQUEST',
      transactionId: 'transaction:evm:unavailable'
    })
  )
  expect(unauthorizedEvmSigningRead).toMatchObject({
    error: { code: 'invalid-request' }
  })
  const evmSignPage = await popup.context().newPage()
  await evmSignPage.setViewportSize({ width: 375, height: 632 })
  await evmSignPage.goto(
    `chrome-extension://${extensionId}/index.html#/hardware/evm-sign?tx=transaction%3Aevm%3Aunavailable`
  )
  await expect(evmSignPage.getByText('Request unavailable', { exact: true })).toBeVisible()
  await expect(
    evmSignPage.getByText(
      'This EVM signing request expired, was cancelled, or belongs to another Wallet. Start a new send from Noir Wallet.',
      { exact: true }
    )
  ).toBeVisible()
  await captureScreenshot(evmSignPage, 'keystone-evm-sign-request-unavailable.png')
  await evmSignPage.close()

  await expect(
    popup.evaluate(() => chrome.runtime.sendMessage({ type: 'WALLET_LOCKED' }))
  ).resolves.toEqual({ success: true })
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(popup.getByText('Enter your password', { exact: true })).toBeVisible()
  await popup.getByPlaceholder('Enter Password').fill('wrong-keystone-password')
  await popup.getByRole('button', { name: 'Unlock', exact: true }).click()
  await expect(popup.getByText('Incorrect password', { exact: true })).toBeVisible()
  await popup.getByPlaceholder('Enter Password').fill(PASSWORD)
  await popup.getByRole('button', { name: 'Unlock', exact: true }).click()
  await expect(popup.getByRole('button', { name: 'Swap', exact: true })).toBeVisible({
    timeout: 30_000
  })

  const changed = await popup.evaluate(
    ({ currentPassword, newPassword }) =>
      chrome.runtime.sendMessage({
        type: 'CHANGE_WALLET_PASSWORD',
        currentPassword,
        newPassword
      }),
    { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }
  )
  expect(changed).toEqual({ success: true })
  await expect(
    popup.evaluate(() => chrome.runtime.sendMessage({ type: 'WALLET_LOCKED' }))
  ).resolves.toEqual({ success: true })
  const oldUnlock = await popup.evaluate(
    password => chrome.runtime.sendMessage({ type: 'WALLET_UNLOCK', password }),
    PASSWORD
  )
  expect(oldUnlock).toMatchObject({ success: false })
  const newUnlock = await popup.evaluate(
    password => chrome.runtime.sendMessage({ type: 'WALLET_UNLOCK', password }),
    NEW_PASSWORD
  )
  expect(newUnlock).toMatchObject({ success: true, nativeV2Only: true })

  const catalog = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })
  )
  expect(catalog).toMatchObject({
    result: {
      accounts: [
        {
          walletDisplayName: 'Keystone Multi-Coin',
          active: true,
          networks: expect.arrayContaining([
            ...MAINNET_EVM_NETWORKS.map(network =>
              expect.objectContaining({ chainId: network.chainId })
            ),
            expect.objectContaining({ chainId: 'bip122:000000000019d6689c085ae165831e93' })
          ])
        }
      ]
    }
  })
  expect(catalog.result.accounts[0].networks).toHaveLength(MAINNET_EVM_NETWORKS.length + 1)
  const nativeWalletId = catalog.result.accounts[0].walletId
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(popup.getByRole('button', { name: 'Swap', exact: true })).toBeVisible({
    timeout: 30_000
  })
  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  await popup
    .locator('section[aria-label="Wallet group Keystone Multi-Coin"]')
    .getByRole('button', {
      name: `Account actions for ${catalog.result.accounts[0].accountDisplayName}`
    })
    .click()
  await popup.getByRole('menuitem', { name: 'Remove wallet' }).click()
  await expect(popup.getByRole('heading', { name: 'Remove wallet' })).toBeVisible()
  await popup.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Unable to remove wallet' })).toBeVisible()
  await expect(
    popup.getByText('Cannot remove the last wallet. Use Reset Wallet instead.', { exact: true })
  ).toBeVisible()
  await popup.getByRole('button', { name: 'OK', exact: true }).click()

  await popup.getByRole('button', { name: 'Rename wallet Keystone Multi-Coin' }).click()
  await popup.getByRole('textbox', { name: 'Wallet name' }).fill('Keystone Daily')
  await popup.getByRole('textbox', { name: 'Wallet name' }).press('Enter')
  await expect(popup.getByText('Keystone Daily', { exact: true })).toBeVisible()
  await captureScreenshot(popup, 'keystone-v2-wallet-renamed.png')
  const renamedCatalog = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })
  )
  expect(renamedCatalog.result.accounts[0]).toMatchObject({
    walletId: nativeWalletId,
    walletDisplayName: 'Keystone Daily',
    active: true
  })

  const addedSoftware = await popup.evaluate(
    ({ mnemonic }) =>
      chrome.runtime.sendMessage({
        type: 'ADD_SOFTWARE_WALLET',
        mode: 'import',
        mnemonic,
        accountName: 'Software Account',
        birthdayHeight: 2_000_000
      }),
    { mnemonic: SOFTWARE_MNEMONIC }
  )
  expect(addedSoftware).toMatchObject({
    success: true,
    walletId: expect.any(String),
    credentialStatus: 'synchronized'
  })
  const mixedCatalog = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })
  )
  expect(mixedCatalog).toMatchObject({
    result: {
      accounts: expect.arrayContaining([
        expect.objectContaining({
          walletDisplayName: 'Keystone Daily',
          walletSource: expect.objectContaining({ kind: 'hardware' }),
          active: false
        }),
        expect.objectContaining({
          walletSource: { kind: 'software' },
          active: true,
          networks: expect.arrayContaining([
            expect.objectContaining({ chainId: 'bip122:00040fe8ec8471911baa1db1266ea15d' }),
            expect.objectContaining({ chainId: 'eip155:1' }),
            expect.objectContaining({
              chainId: 'bip122:000000000019d6689c085ae165831e93'
            })
          ])
        })
      ])
    }
  })
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(popup.getByRole('button', { name: 'Swap', exact: true })).toBeVisible({
    timeout: 30_000
  })
  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  await popup
    .locator('section[aria-label="Wallet group Keystone Daily"]')
    .getByRole('button', {
      name: `Account actions for ${catalog.result.accounts[0].accountDisplayName}`
    })
    .click()
  await popup.getByRole('menuitem', { name: 'Remove wallet' }).click()
  await popup.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(popup.getByText('Removing wallet...', { exact: true })).toBeVisible()
  await expect(popup.getByText('Keystone Daily', { exact: true })).toHaveCount(0, {
    timeout: 30_000
  })
  await expect(popup.getByText('Enter your password', { exact: true })).toBeVisible()
  await popup.getByPlaceholder('Enter Password').fill(NEW_PASSWORD)
  await popup.getByRole('button', { name: 'Unlock', exact: true }).click()
  await expect(popup.getByText('Wallet 1', { exact: true })).toBeVisible()
  await captureScreenshot(popup, 'keystone-v2-wallet-removed.png')
  const softwareOnlyCatalog = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })
  )
  expect(softwareOnlyCatalog.result.accounts).toHaveLength(1)
  expect(softwareOnlyCatalog.result.accounts[0]).toMatchObject({
    walletSource: { kind: 'software' },
    active: true
  })
  await expect(
    popup.evaluate(() => chrome.runtime.sendMessage({ type: 'WALLET_LOCKED' }))
  ).resolves.toEqual({ success: true })
  const mixedUnlock = await popup.evaluate(
    password => chrome.runtime.sendMessage({ type: 'WALLET_UNLOCK', password }),
    NEW_PASSWORD
  )
  expect(mixedUnlock).toMatchObject({ success: true })

  const zcashHardware = await popup.evaluate(
    ({ ufvk, seedFingerprintHex }) =>
      chrome.runtime.sendMessage({
        type: 'PROVISION_KEYSTONE_HARDWARE',
        credential: {
          schemaVersion: 2,
          vendor: 'keystone',
          firmwareProfile: 'cypherpunk',
          capabilities: ['zcash'],
          accountExport: {
            protocol: 'zcash-accounts-v1',
            ufvk,
            seedFingerprintHex,
            accountHdIndex: 0
          }
        },
        displayName: 'Keystone Cypherpunk',
        birthdayHeight: 2_000_000
      }),
    { ufvk: ZCASH_UFVK, seedFingerprintHex: ZCASH_SEED_FINGERPRINT }
  )
  expect(zcashHardware).toMatchObject({
    success: true,
    result: {
      status: 'committed',
      generationId: expect.any(String),
      keyDomainId: expect.any(String),
      accountIds: [expect.any(String)]
    }
  })
  const completeCatalog = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })
  )
  expect(completeCatalog.result.accounts).toHaveLength(2)
  expect(completeCatalog.result.accounts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        walletSource: { kind: 'software' },
        active: false
      }),
      expect.objectContaining({
        walletDisplayName: 'Keystone Cypherpunk',
        walletSource: expect.objectContaining({
          kind: 'hardware',
          hardware: {
            vendor: 'keystone',
            firmwareProfile: 'cypherpunk',
            capabilities: ['zcash']
          }
        }),
        active: true,
        networks: [expect.objectContaining({ chainId: 'bip122:00040fe8ec8471911baa1db1266ea15d' })]
      })
    ])
  )
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(popup.getByRole('button', { name: 'Swap', exact: true })).toBeVisible({
    timeout: 30_000
  })
  await expect(popup.getByRole('button', { name: 'Lending', exact: true })).toHaveCount(0)
  await expect(popup.getByRole('button', { name: 'Swap', exact: true })).toBeVisible()
  await expect(popup.getByRole('status', { name: 'Zcash sync progress: Syncing' })).toBeVisible()
  await expect(popup.getByText('No networks available', { exact: true })).toHaveCount(0)
  await captureScreenshot(popup, 'keystone-v2-zcash-syncing.png')
  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  await expect(popup.getByText('Keystone Cypherpunk', { exact: true })).toBeVisible({
    timeout: 30_000
  })
  const activeBadge = popup.getByText('Active', { exact: true })
  await expect(activeBadge).toHaveCount(1)
  await activeBadge.scrollIntoViewIfNeeded()
  await expect(activeBadge).toBeVisible()
  const cypherpunkNetworkTrigger = popup
    .getByRole('button', { name: 'Expand account networks' })
    .last()
  await cypherpunkNetworkTrigger.click()
  const cypherpunkNetworks = popup.getByRole('region', { name: 'Account networks' }).last()
  await expect(cypherpunkNetworks.getByText('Zcash', { exact: true })).toBeVisible()
  await expect(cypherpunkNetworks.getByText('Ethereum', { exact: true })).toHaveCount(0)
  await expect(cypherpunkNetworks.getByText('Bitcoin', { exact: true })).toHaveCount(0)
  await expectPopupFits(popup)
  await captureScreenshot(popup, 'keystone-v2-mixed-wallets.png')
})
