import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { HDKey } from '@scure/bip32'
import { mnemonicToSeedSync } from '@scure/bip39'
import type { Page } from '@playwright/test'
import { Buffer } from 'buffer'
import {
  buildBitcoinPsbt,
  finalizeBitcoinPsbt,
  selectBitcoinCoins
} from '../../../src/infrastructure/chains/bitcoin'
import {
  expect,
  selectImportedZcashHistory,
  test,
  waitForBackgroundWalletInitialization
} from '../../helpers/extension-fixtures'

const BITCOIN_TESTNET_ASSET_ID = 'bip122:000000000933ea01ad0ee984209779ba/slip44:0'
const BITCOIN_TESTNET_CHAIN_ID = 'bip122:000000000933ea01ad0ee984209779ba'
const ESPLORA_TRANSACTION_URL = 'https://mempool.space/testnet/api/tx'
const ESPLORA_ADDRESS_URL = 'https://mempool.space/testnet/api/address'
const LEGACY_INTEROP_ENABLED = process.env.NOIR_BITCOIN_LEGACY_INTEROP === '1'
const LEGACY_FUNDING_AMOUNT_BTC = '0.0011'

const LIVE_CONFORMANCE_BINDING = Object.freeze({
  kind: 'credential',
  keyDomainId: 'key-domain:bitcoin-live-interop',
  credentialGenerationId: 'credential-generation:bitcoin-live-interop',
  globalUnlockEpoch: 'global-unlock:bitcoin-live-interop'
})

let conformanceCommandSequence = 0

interface LiveBitcoinWalletFixture {
  readonly mnemonic: string
  readonly password: string
  readonly address: string
}

interface DerivedBitcoinAccount {
  readonly identity: { readonly value: string }
  readonly derivation: { readonly scheme: string; readonly path: string }
  readonly publicKey: string
  readonly masterFingerprint?: string
}

interface PreparedConformanceSigning {
  readonly commandId: string
}

interface SignedConformancePayload {
  readonly kind: 'signed-payload'
  readonly payload: { readonly encoding: 'base64'; readonly value: string }
  readonly transactionId: string
}

function loadLiveBitcoinWalletFixture(): LiveBitcoinWalletFixture | null {
  const fixturePath = process.env.NOIR_BITCOIN_TESTNET_WALLET_FILE
  if (!fixturePath) return null
  if (!path.isAbsolute(fixturePath)) {
    throw new Error('The live Bitcoin wallet fixture path must be absolute')
  }
  let fixtureStat
  try {
    fixtureStat = lstatSync(fixturePath)
  } catch {
    throw new Error('The live Bitcoin wallet fixture does not exist or cannot be read')
  }
  if (fixtureStat.isSymbolicLink() || !fixtureStat.isFile() || fixtureStat.size > 16_384) {
    throw new Error('The live Bitcoin wallet fixture must be a bounded regular file, not a symlink')
  }
  if ((fixtureStat.mode & 0o777) !== 0o600) {
    throw new Error('The live Bitcoin wallet fixture must use mode 0600')
  }
  const value = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>
  const mnemonicWordCount =
    typeof value.mnemonic === 'string' ? value.mnemonic.trim().split(/\s+/).length : 0
  if (
    Object.keys(value).sort().join(',') !== 'address,mnemonic,network,password,schemaVersion' ||
    value.schemaVersion !== 1 ||
    value.network !== 'bitcoin-testnet3' ||
    typeof value.mnemonic !== 'string' ||
    ![12, 24].includes(mnemonicWordCount) ||
    typeof value.password !== 'string' ||
    value.password.length < 8 ||
    value.password.length > 64 ||
    typeof value.address !== 'string' ||
    !/^tb1q[023456789acdefghjklmnpqrstuvwxyz]{38}$/.test(value.address)
  ) {
    throw new Error('Invalid live Bitcoin wallet fixture')
  }
  return { mnemonic: value.mnemonic, password: value.password, address: value.address }
}

const liveWallet = loadLiveBitcoinWalletFixture()

test.use({ screenshot: 'off', trace: 'off' })
test.skip(!liveWallet, 'NOIR_BITCOIN_TESTNET_WALLET_FILE is not configured')
test.skip(
  process.env.NOIR_BITCOIN_TESTNET_BROADCAST !== '1',
  'NOIR_BITCOIN_TESTNET_BROADCAST=1 is required for a funded broadcast'
)

async function importLiveWallet(page: Page, wallet: LiveBitcoinWalletFixture): Promise<void> {
  const wordCount = wallet.mnemonic.trim().split(/\s+/).length
  await page.getByRole('button', { name: 'Import wallet' }).click()
  await page.getByRole('radio', { name: `${wordCount} words` }).click()
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

async function executeConformanceCommand<T>(
  page: Page,
  operation: string,
  payload: Record<string, unknown>
): Promise<T> {
  conformanceCommandSequence += 1
  const command = {
    protocolVersion: 2,
    commandId: `keyring-command:bitcoin-live-interop:${conformanceCommandSequence}`,
    engine: 'multichain',
    operation,
    binding: LIVE_CONFORMANCE_BINDING,
    deadlineAt: Date.now() + 120_000,
    payload
  }
  const response = await page.evaluate(
    input =>
      chrome.runtime.sendMessage({
        type: 'WORKER_RPC',
        method: 'multichain.conformance-execute',
        payload: { command: input }
      }),
    command
  )
  const result = response?.result as
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error?: { readonly code?: string } }
    | undefined
  if (!result || result.ok !== true) {
    throw new Error(`Multichain conformance command failed: ${result?.error?.code ?? 'unknown'}`)
  }
  return result.value
}

async function deriveLegacyInteropAddresses(
  page: Page,
  wallet: LiveBitcoinWalletFixture
): Promise<{ readonly legacy: string; readonly nested: string }> {
  const vault = await executeConformanceCommand<unknown>(page, 'credential.import', {
    mnemonic: wallet.mnemonic,
    password: wallet.password
  })
  await executeConformanceCommand(page, 'credential.unlock', { vault, password: wallet.password })
  try {
    const [nativeSegwit, legacy, nested] = await Promise.all(
      [
        ['p2wpkh', 'bip84', "m/84'/1'/0'/0/0"],
        ['p2pkh', 'bip44', "m/44'/1'/0'/0/0"],
        ['p2sh_p2wpkh', 'bip49', "m/49'/1'/0'/0/0"]
      ].map(async ([addressType, scheme, path]) => {
        const account = await executeConformanceCommand<DerivedBitcoinAccount>(
          page,
          'account.derive-public',
          {
            family: 'bitcoin',
            chainId: BITCOIN_TESTNET_CHAIN_ID,
            addressType,
            accountIndex: 0,
            change: false,
            addressIndex: 0
          }
        )
        expect(account.derivation).toEqual({ scheme, path })
        return account.identity.value
      })
    )
    expect(nativeSegwit).toBe(wallet.address)
    expect(legacy).toMatch(/^[mn][1-9A-HJ-NP-Za-km-z]{25,34}$/)
    expect(nested).toMatch(/^2[1-9A-HJ-NP-Za-km-z]{25,34}$/)
    return { legacy, nested }
  } finally {
    await executeConformanceCommand(page, 'credential.lock', {})
  }
}

async function fetchEsploraJson<T>(
  page: Page,
  url: string
): Promise<{ readonly status: number; readonly value: T | null }> {
  const response = await fetchEsploraText(page, url)
  return {
    status: response.status,
    value: response.body === '' ? null : (JSON.parse(response.body) as T)
  }
}

async function fetchEsploraText(
  page: Page,
  url: string
): Promise<{ readonly status: number; readonly body: string }> {
  const urls = [
    url,
    ...(url.startsWith('https://mempool.space/testnet/api/')
      ? [url.replace('https://mempool.space/testnet/api/', 'https://blockstream.info/testnet/api/')]
      : [])
  ]
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    for (const requestUrl of urls) {
      try {
        const response = await page.evaluate(async candidateUrl => {
          try {
            const result = await fetch(candidateUrl)
            return { status: result.status, body: await result.text(), networkError: false }
          } catch {
            return { status: 0, body: '', networkError: true }
          }
        }, requestUrl)
        if (!response.networkError && response.status !== 429 && response.status < 500) {
          return { status: response.status, body: response.body }
        }
        lastError = new Error(
          response.networkError
            ? 'Bitcoin Testnet3 RPC network request failed'
            : `Bitcoin Testnet3 RPC returned HTTP ${response.status}`
        )
      } catch (error) {
        lastError = error
      }
    }
    if (attempt < 2) {
      await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt))
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Bitcoin Testnet3 RPC request failed')
}

async function verifyFundedHistoricalSigning(
  page: Page,
  wallet: LiveBitcoinWalletFixture,
  input: {
    readonly sourceAddress: string
    readonly recipientAddress: string
    readonly addressType: 'p2pkh' | 'p2sh-p2wpkh'
  }
): Promise<string> {
  const vault = await executeConformanceCommand<unknown>(page, 'credential.import', {
    mnemonic: wallet.mnemonic,
    password: wallet.password
  })
  await executeConformanceCommand(page, 'credential.unlock', { vault, password: wallet.password })
  try {
    const rawAddressType = input.addressType === 'p2sh-p2wpkh' ? 'p2sh_p2wpkh' : 'p2pkh'
    const expectedPath = input.addressType === 'p2pkh' ? "m/44'/1'/0'/0/0" : "m/49'/1'/0'/0/0"
    const source = await executeConformanceCommand<DerivedBitcoinAccount>(
      page,
      'account.derive-public',
      {
        family: 'bitcoin',
        chainId: BITCOIN_TESTNET_CHAIN_ID,
        addressType: rawAddressType,
        accountIndex: 0,
        change: false,
        addressIndex: 0
      }
    )
    if (
      source.identity.value !== input.sourceAddress ||
      source.derivation.path !== expectedPath ||
      !/^0x[0-9a-f]{8}$/.test(source.masterFingerprint ?? '')
    ) {
      throw new Error('The funded historical Bitcoin account does not match the live wallet')
    }

    const utxoResponse = await fetchEsploraJson<
      readonly {
        readonly txid?: unknown
        readonly vout?: unknown
        readonly value?: unknown
        readonly status?: { readonly confirmed?: unknown; readonly block_height?: unknown }
      }[]
    >(page, `${ESPLORA_ADDRESS_URL}/${input.sourceAddress}/utxo`)
    if (utxoResponse.status !== 200 || !Array.isArray(utxoResponse.value)) {
      throw new Error('Bitcoin Testnet3 did not return the funded BIP-44 UTXO')
    }
    const utxo = utxoResponse.value
      .filter(
        candidate =>
          candidate.status?.confirmed === true &&
          typeof candidate.txid === 'string' &&
          /^[0-9a-f]{64}$/.test(candidate.txid) &&
          Number.isSafeInteger(candidate.vout) &&
          Number.isSafeInteger(candidate.value) &&
          Number.isSafeInteger(candidate.status.block_height)
      )
      .sort((left, right) => Number(right.value) - Number(left.value))[0]
    if (
      !utxo ||
      typeof utxo.txid !== 'string' ||
      !Number.isSafeInteger(utxo.vout) ||
      !Number.isSafeInteger(utxo.value) ||
      !Number.isSafeInteger(utxo.status?.block_height)
    ) {
      throw new Error('The funded BIP-44 UTXO is missing confirmed spend metadata')
    }

    const [rawTransaction, tip] = await Promise.all([
      fetchEsploraText(page, `${ESPLORA_TRANSACTION_URL}/${utxo.txid}/hex`),
      fetchEsploraText(page, 'https://mempool.space/testnet/api/blocks/tip/height')
    ])
    const rawTransactionHex = rawTransaction.body.trim()
    const tipHeight = Number(tip.body.trim())
    if (
      rawTransaction.status !== 200 ||
      !/^(?:[0-9a-f]{2})+$/.test(rawTransactionHex) ||
      tip.status !== 200 ||
      !Number.isSafeInteger(tipHeight)
    ) {
      throw new Error('Bitcoin Testnet3 returned invalid BIP-44 signing context')
    }

    const selection = selectBitcoinCoins({
      chainId: BITCOIN_TESTNET_CHAIN_ID,
      accountIndex: 0,
      addressType: input.addressType,
      recipient: input.recipientAddress,
      amount: { mode: 'max' },
      feeRateSatsPerVbyte: 1,
      utxos: [
        {
          chainId: BITCOIN_TESTNET_CHAIN_ID,
          addressType: input.addressType,
          accountIndex: 0,
          change: false,
          addressIndex: 0,
          address: input.sourceAddress,
          derivationPath: source.derivation.path,
          publicKey: source.publicKey,
          transactionId: utxo.txid,
          outputIndex: Number(utxo.vout),
          valueSats: Number(utxo.value).toString(),
          blockHeight: Number(utxo.status.block_height)
        }
      ]
    })
    const prepared = buildBitcoinPsbt({
      selection,
      masterFingerprint: source.masterFingerprint ?? '',
      lockTime: tipHeight,
      ...(input.addressType === 'p2pkh'
        ? { previousTransactions: [{ transactionId: utxo.txid, rawTransactionHex }] }
        : {})
    })
    const signing = await executeConformanceCommand<PreparedConformanceSigning>(
      page,
      'signing.prepare',
      {
        kind: 'bitcoin-psbt',
        chainId: BITCOIN_TESTNET_CHAIN_ID,
        addressType: rawAddressType,
        accountIndex: 0,
        psbt: prepared.psbtBase64
      }
    )
    const signed = await executeConformanceCommand<SignedConformancePayload>(
      page,
      'signing.confirm',
      { signingCommandId: signing.commandId }
    )
    const finalized = finalizeBitcoinPsbt({
      prepared,
      signedPsbtBase64: signed.payload.value
    })
    expect(signed).toMatchObject({
      kind: 'signed-payload',
      payload: { encoding: 'base64' },
      transactionId: prepared.unsignedTransactionId
    })
    expect(finalized.transactionId).not.toBe(prepared.unsignedTransactionId)
    return finalized.transactionId
  } finally {
    await executeConformanceCommand(page, 'credential.lock', {})
  }
}

async function waitForPublicTransaction(page: Page, transactionHash: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await fetchEsploraJson<{ txid?: unknown }>(
          page,
          `${ESPLORA_TRANSACTION_URL}/${transactionHash}`
        )
        if (response.status === 404) return false
        if (response.status !== 200) {
          throw new Error(`Bitcoin Testnet3 RPC returned HTTP ${response.status}`)
        }
        return response.value?.txid === transactionHash
      },
      { timeout: 120_000 }
    )
    .toBe(true)
}

async function waitForPublicConfirmation(page: Page, transactionHash: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await fetchEsploraJson<{ confirmed?: unknown }>(
          page,
          `${ESPLORA_TRANSACTION_URL}/${transactionHash}/status`
        )
        if (response.status === 404) return false
        if (response.status !== 200) {
          throw new Error(`Bitcoin Testnet3 RPC returned HTTP ${response.status}`)
        }
        return response.value?.confirmed === true
      },
      { timeout: 1_800_000, intervals: [5_000, 10_000, 20_000] }
    )
    .toBe(true)
}

async function waitForNoPendingAddressTransactions(
  page: Page,
  addresses: readonly string[]
): Promise<void> {
  await expect
    .poll(
      async () => {
        const stats = await Promise.all(
          addresses.map(async address => {
            const response = await fetchEsploraJson<{
              mempool_stats?: { readonly tx_count?: unknown }
            }>(page, `${ESPLORA_ADDRESS_URL}/${address}`)
            if (response.status !== 200) {
              throw new Error(`Bitcoin Testnet3 RPC returned HTTP ${response.status}`)
            }
            return response.value
          })
        )
        return stats.every(value => value?.mempool_stats?.tx_count === 0)
      },
      { timeout: 1_800_000, intervals: [5_000, 10_000, 20_000] }
    )
    .toBe(true)
}

async function getConfirmedAddressBalance(page: Page, address: string): Promise<bigint> {
  const response = await fetchEsploraJson<{
    chain_stats?: {
      readonly funded_txo_sum?: unknown
      readonly spent_txo_sum?: unknown
    }
  }>(page, `${ESPLORA_ADDRESS_URL}/${address}`)
  if (response.status !== 200) {
    throw new Error(`Bitcoin Testnet3 RPC returned HTTP ${response.status}`)
  }
  const value = response.value
  const funded = value?.chain_stats?.funded_txo_sum
  const spent = value?.chain_stats?.spent_txo_sum
  if (!Number.isSafeInteger(funded) || !Number.isSafeInteger(spent)) {
    throw new Error('Bitcoin Testnet3 RPC returned invalid address balance data')
  }
  return BigInt(funded as number) - BigInt(spent as number)
}

interface LatestBitcoinActivityState {
  readonly id: string
  readonly status: string
  readonly segmentStatus: string | null
  readonly transactionHash: string | null
  readonly failureCode: string | null
}

async function readLatestBitcoinActivityState(
  page: Page
): Promise<LatestBitcoinActivityState | null> {
  return page.evaluate(bitcoinChainId => {
    return chrome.runtime
      .sendMessage({ type: 'GET_BITCOIN_ACTIVITY', action: 'read' })
      .then(response => {
        const items = response?.result?.items
        if (!Array.isArray(items)) return null
        for (const item of items) {
          if (item?.source !== 'wallet-v2' || !Array.isArray(item.segments)) continue
          const segment = item.segments.find(
            (candidate: { target?: { chainId?: unknown } }) =>
              candidate?.target?.chainId === bitcoinChainId
          )
          if (!segment || typeof item.id !== 'string' || typeof item.status !== 'string') continue
          return {
            id: item.id,
            status: item.status,
            segmentStatus: typeof segment.status === 'string' ? segment.status : null,
            transactionHash:
              typeof segment.evidence?.transactionHash === 'string'
                ? segment.evidence.transactionHash
                : null,
            failureCode: typeof item.failureCode === 'string' ? item.failureCode : null
          }
        }
        return null
      })
  }, BITCOIN_TESTNET_CHAIN_ID)
}

async function sendBitcoinTransfer(
  page: Page,
  extensionId: string,
  input: {
    readonly recipient: string
    readonly amountBtc?: string
    readonly expectedInputType: string
  }
): Promise<string> {
  await page.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(page.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 30_000 })
  await page.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'GET_PORTFOLIO', action: 'refresh' })
  )
  await expect(page.getByText('BTC', { exact: true }).first()).toBeVisible({ timeout: 180_000 })
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  const bitcoinAsset = page.getByRole('button', { name: 'Send BTC on Bitcoin Testnet' })
  await expect(bitcoinAsset).toBeVisible({ timeout: 180_000 })
  await bitcoinAsset.click()
  await page.getByLabel('Send To').fill(input.recipient)
  if (input.amountBtc === undefined) {
    await page.getByRole('button', { name: 'Max', exact: true }).click()
  } else {
    await page.getByLabel('BTC amount').fill(input.amountBtc)
  }
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  const reviewDialog = page.getByRole('dialog')
  const reviewHeading = reviewDialog.getByRole('heading', { name: 'Review Send' })
  const preparationError = page.getByRole('alert').last()
  await expect(reviewHeading.or(preparationError).first()).toBeVisible({
    timeout: 120_000
  })
  if (await preparationError.isVisible()) {
    throw new Error(`Bitcoin Send preparation failed: ${await preparationError.innerText()}`)
  }
  await expect(reviewDialog.getByText(input.expectedInputType, { exact: true })).toBeVisible()
  await reviewDialog.getByRole('button', { name: 'Send', exact: true }).click()
  await expect
    .poll(async () => (await readLatestBitcoinActivityState(page))?.status ?? null, {
      timeout: 30_000
    })
    .toMatch(/^(approved|signed|broadcast|confirming|final)$/)
  const broadcastTitle = page.getByText('Transaction Submitted', { exact: true })
  const interruptedTitle = page.getByText('Broadcast Interrupted', { exact: true })
  const approvalError = page.getByRole('alert').last()
  try {
    await expect(broadcastTitle.or(interruptedTitle).or(approvalError).first()).toBeVisible({
      timeout: 135_000
    })
  } catch {
    const activity = await readLatestBitcoinActivityState(page)
    throw new Error(`Bitcoin approval did not settle: ${JSON.stringify(activity)}`)
  }
  if (await approvalError.isVisible()) {
    const activity = await readLatestBitcoinActivityState(page)
    throw new Error(
      `Bitcoin approval failed: ${await approvalError.innerText()}: ${JSON.stringify(activity)}`
    )
  }
  if (await interruptedTitle.isVisible()) {
    const signedTransactionUrl = await page
      .locator('a[href^="https://mempool.space/testnet/tx/"]')
      .first()
      .getAttribute('href')
    const signedTransactionHash = signedTransactionUrl?.split('/').at(-1)
    if (!signedTransactionHash || !/^[0-9a-f]{64}$/.test(signedTransactionHash)) {
      throw new Error('The signed Bitcoin transaction hash is missing')
    }
    await page.getByRole('button', { name: 'Retry broadcast', exact: true }).click()
    const retryError = page.getByRole('alert').last()
    try {
      await expect(broadcastTitle.or(retryError).first()).toBeVisible({ timeout: 120_000 })
    } catch {
      throw new Error(`Bitcoin broadcast retry did not settle: ${signedTransactionHash}`)
    }
    if (await retryError.isVisible()) {
      throw new Error(
        `Bitcoin broadcast retry failed: ${signedTransactionHash}: ${await retryError.innerText()}`
      )
    }
  }
  const transactionUrl = await page
    .locator('a[href^="https://mempool.space/testnet/tx/"]')
    .first()
    .getAttribute('href')
  const transactionHash = transactionUrl?.split('/').at(-1)
  if (!transactionHash || !/^[0-9a-f]{64}$/.test(transactionHash)) {
    throw new Error('The live Bitcoin transaction hash is missing')
  }
  await waitForPublicTransaction(page, transactionHash)
  return transactionHash
}

test('broadcasts a real pinned-WASM BIP-84 transfer on Bitcoin Testnet3', async ({
  popup,
  extensionId
}) => {
  test.skip(LEGACY_INTEROP_ENABLED, 'The legacy interoperability run replaces the BIP-84 self-send')
  test.setTimeout(600_000)
  if (!liveWallet) throw new Error('The live Bitcoin wallet fixture was not loaded')
  const wallet = liveWallet

  await waitForBackgroundWalletInitialization(popup)
  await importLiveWallet(popup, wallet)
  await popup.goto(
    `chrome-extension://${extensionId}/tests/extension/credential-repository-integration.html`
  )
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.credentialRepositoryIntegration)))
    .toBe(true)
  const provisioning = await popup.evaluate(() =>
    window.credentialRepositoryIntegration!.inspectProductionV2Provisioning()
  )
  expect(provisioning.chainAccounts).toContainEqual(
    expect.objectContaining({
      chainId: 'bip122:000000000933ea01ad0ee984209779ba',
      identity: wallet.address
    })
  )
  await popup.goto(`chrome-extension://${extensionId}/index.html`)

  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 30_000 })
  await expect(popup.getByText('BTC', { exact: true }).first()).toBeVisible({ timeout: 180_000 })
  const portfolio = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'GET_PORTFOLIO', action: 'refresh' })
  )
  const bitcoin = portfolio.result?.model?.assets?.find(
    (asset: { asset?: { id?: string } }) => asset.asset?.id === BITCOIN_TESTNET_ASSET_ID
  )
  expect(BigInt(bitcoin?.balance?.availableRaw ?? '0')).toBeGreaterThan(10_000n)

  await popup.getByRole('button', { name: 'Send', exact: true }).click()
  await popup.getByRole('button', { name: 'Send BTC on Bitcoin Testnet' }).click()
  await popup.getByLabel('Send To').fill(wallet.address)
  await popup.getByRole('button', { name: 'Max', exact: true }).click()
  await popup.getByRole('button', { name: 'Continue', exact: true }).click()
  const reviewDialog = popup.getByRole('dialog')
  await expect(reviewDialog.getByRole('heading', { name: 'Review Send' })).toBeVisible({
    timeout: 60_000
  })
  await reviewDialog.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(popup.getByText('Transaction Submitted', { exact: true })).toBeVisible({
    timeout: 120_000
  })

  const transactionLink = popup.locator('a[href^="https://mempool.space/testnet/tx/"]').first()
  const transactionUrl = await transactionLink.getAttribute('href')
  const transactionHash = transactionUrl?.split('/').at(-1)
  expect(transactionHash).toMatch(/^[0-9a-f]{64}$/)
  if (!transactionHash) throw new Error('The live Bitcoin transaction hash is missing')
  console.log(`[bitcoin-testnet-live] broadcast tx: ${transactionHash}`)

  await waitForPublicTransaction(popup, transactionHash)
  await expect(
    popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_BITCOIN_ACTIVITY' }))
  ).resolves.toMatchObject({
    result: {
      items: expect.arrayContaining([
        expect.objectContaining({
          source: 'wallet-v2',
          status: expect.stringMatching(/^(broadcast|confirming|final)$/),
          segments: [
            expect.objectContaining({ evidence: expect.objectContaining({ transactionHash }) })
          ]
        })
      ])
    }
  })
})

test('signs and pushes a real raw transaction from a Bitcoin dApp on Testnet3', async ({
  context,
  popup,
  extensionId
}) => {
  test.skip(LEGACY_INTEROP_ENABLED, 'The legacy interoperability run replaces dApp pushTx')
  test.setTimeout(600_000)
  if (!liveWallet) throw new Error('The live Bitcoin wallet fixture was not loaded')
  const wallet = liveWallet

  await waitForBackgroundWalletInitialization(popup)
  await importLiveWallet(popup, wallet)
  await waitForNoPendingAddressTransactions(popup, [wallet.address])

  await context.route('https://bitcoin-pushtx-live.example/**', route =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><title>Bitcoin pushTx live dApp</title></head><body>Bitcoin pushTx live dApp</body></html>'
    })
  )
  const dapp = await context.newPage()
  await dapp.goto('https://bitcoin-pushtx-live.example/connect')
  await dapp.waitForFunction(() => {
    const target = window as typeof window & {
      noirwallet?: { bitcoin?: { pushTx?: unknown } }
    }
    return typeof target.noirwallet?.bitcoin?.pushTx === 'function'
  })

  const connectApprovalPromise = context.waitForEvent('page')
  const connectResultPromise = dapp.evaluate(() => {
    const target = window as typeof window & {
      noirwallet: {
        bitcoin: {
          connect: () => Promise<{ address: string; publicKey: string }>
        }
      }
    }
    return target.noirwallet.bitcoin.connect()
  })
  const connectApproval = await connectApprovalPromise
  await connectApproval.waitForURL(/#approval\?requestId=/)
  await connectApproval.getByRole('button', { name: /^Connect/ }).click()
  const account = await connectResultPromise
  expect(account.address).toBe(wallet.address)

  const utxoResponse = await fetchEsploraJson<
    readonly {
      readonly txid?: unknown
      readonly vout?: unknown
      readonly value?: unknown
      readonly status?: { readonly confirmed?: unknown; readonly block_height?: unknown }
    }[]
  >(popup, `${ESPLORA_ADDRESS_URL}/${wallet.address}/utxo`)
  if (utxoResponse.status !== 200 || !Array.isArray(utxoResponse.value)) {
    throw new Error('Bitcoin Testnet3 did not return the live dApp UTXO')
  }
  const utxo = utxoResponse.value
    .filter(
      candidate =>
        candidate.status?.confirmed === true &&
        typeof candidate.txid === 'string' &&
        /^[0-9a-f]{64}$/.test(candidate.txid) &&
        Number.isSafeInteger(candidate.vout) &&
        Number.isSafeInteger(candidate.value) &&
        Number.isSafeInteger(candidate.status.block_height)
    )
    .sort((left, right) => Number(right.value) - Number(left.value))[0]
  if (
    !utxo ||
    typeof utxo.txid !== 'string' ||
    !Number.isSafeInteger(utxo.vout) ||
    !Number.isSafeInteger(utxo.value) ||
    !Number.isSafeInteger(utxo.status?.block_height)
  ) {
    throw new Error('The live dApp Bitcoin UTXO is missing confirmed spend metadata')
  }
  const tipResponse = await fetchEsploraText(
    popup,
    'https://mempool.space/testnet/api/blocks/tip/height'
  )
  const tipHeight = Number(tipResponse.body.trim())
  if (tipResponse.status !== 200 || !Number.isSafeInteger(tipHeight)) {
    throw new Error('Bitcoin Testnet3 returned an invalid tip height')
  }

  const selection = selectBitcoinCoins({
    chainId: BITCOIN_TESTNET_CHAIN_ID,
    accountIndex: 0,
    addressType: 'p2wpkh',
    recipient: wallet.address,
    amount: { mode: 'max' },
    feeRateSatsPerVbyte: 1,
    utxos: [
      {
        chainId: BITCOIN_TESTNET_CHAIN_ID,
        addressType: 'p2wpkh',
        accountIndex: 0,
        change: false,
        addressIndex: 0,
        address: wallet.address,
        derivationPath: "m/84'/1'/0'/0/0",
        publicKey: `0x${account.publicKey}`,
        transactionId: utxo.txid,
        outputIndex: Number(utxo.vout),
        valueSats: Number(utxo.value).toString(),
        blockHeight: Number(utxo.status.block_height)
      }
    ]
  })
  const masterFingerprint = HDKey.fromMasterSeed(mnemonicToSeedSync(wallet.mnemonic)).fingerprint
  const prepared = buildBitcoinPsbt({
    selection,
    masterFingerprint: `0x${masterFingerprint.toString(16).padStart(8, '0')}`,
    lockTime: tipHeight
  })
  const psbtHex = Buffer.from(prepared.psbtBase64, 'base64').toString('hex')

  const signApprovalPromise = context.waitForEvent('page')
  const signedPsbtPromise = dapp.evaluate(psbt => {
    const target = window as typeof window & {
      noirwallet: {
        bitcoin: {
          signPsbt: (value: string, options: { autoFinalized: boolean }) => Promise<string>
        }
      }
    }
    return target.noirwallet.bitcoin.signPsbt(psbt, { autoFinalized: false })
  }, psbtHex)
  const signApproval = await signApprovalPromise
  await signApproval.waitForURL(/#approval\?requestId=/)
  await signApproval.getByRole('button', { name: 'Confirm', exact: true }).click()
  const signedPsbtHex = await signedPsbtPromise
  const finalized = finalizeBitcoinPsbt({
    prepared,
    signedPsbtBase64: Buffer.from(signedPsbtHex, 'hex').toString('base64')
  })

  const transactionHash = await dapp.evaluate(rawtx => {
    const target = window as typeof window & {
      noirwallet: {
        bitcoin: { pushTx: (options: { rawtx: string }) => Promise<string> }
      }
    }
    return target.noirwallet.bitcoin.pushTx({ rawtx })
  }, finalized.rawTransactionHex)
  expect(transactionHash).toBe(finalized.transactionId)
  console.log(`[bitcoin-testnet-live] dApp pushTx broadcast tx: ${transactionHash}`)
  await waitForPublicTransaction(popup, transactionHash)
  await dapp.close()
})

test('moves funded Testnet3 BTC through BIP-44 and BIP-49 using the production wallet flow', async ({
  popup,
  extensionId
}) => {
  test.skip(!LEGACY_INTEROP_ENABLED, 'NOIR_BITCOIN_LEGACY_INTEROP=1 is required')
  test.setTimeout(3_600_000)
  if (!liveWallet) throw new Error('The live Bitcoin wallet fixture was not loaded')
  const wallet = liveWallet

  await waitForBackgroundWalletInitialization(popup)
  await importLiveWallet(popup, wallet)
  const addresses = await deriveLegacyInteropAddresses(popup, wallet)
  const controlledAddresses = [wallet.address, addresses.legacy, addresses.nested] as const
  await waitForNoPendingAddressTransactions(popup, controlledAddresses)

  const broadcasts: string[] = []
  let [nativeBalance, legacyBalance, nestedBalance] = await Promise.all(
    controlledAddresses.map(address => getConfirmedAddressBalance(popup, address))
  )
  if (nativeBalance >= 111_000n && nativeBalance > legacyBalance && nativeBalance > nestedBalance) {
    const fundingTransaction = await sendBitcoinTransfer(popup, extensionId, {
      recipient: addresses.legacy,
      amountBtc: LEGACY_FUNDING_AMOUNT_BTC,
      expectedInputType: 'Native SegWit · BIP-84'
    })
    broadcasts.push(fundingTransaction)
    console.log(`[bitcoin-testnet-live] BIP-44 funding tx: ${fundingTransaction}`)
    await waitForPublicConfirmation(popup, fundingTransaction)
    ;[nativeBalance, legacyBalance, nestedBalance] = await Promise.all(
      controlledAddresses.map(address => getConfirmedAddressBalance(popup, address))
    )
  }

  if (legacyBalance > nativeBalance && legacyBalance > nestedBalance) {
    const legacyPreflightTransaction = await verifyFundedHistoricalSigning(popup, wallet, {
      sourceAddress: addresses.legacy,
      recipientAddress: addresses.nested,
      addressType: 'p2pkh'
    })
    console.log(`[bitcoin-testnet-live] BIP-44 signing preflight: ${legacyPreflightTransaction}`)
    const legacySpendTransaction = await sendBitcoinTransfer(popup, extensionId, {
      recipient: addresses.nested,
      expectedInputType: 'Legacy · BIP-44'
    })
    broadcasts.push(legacySpendTransaction)
    console.log(`[bitcoin-testnet-live] BIP-44 spend tx: ${legacySpendTransaction}`)
    await waitForPublicConfirmation(popup, legacySpendTransaction)
    ;[nativeBalance, legacyBalance, nestedBalance] = await Promise.all(
      controlledAddresses.map(address => getConfirmedAddressBalance(popup, address))
    )
  }

  if (nestedBalance > nativeBalance && nestedBalance > legacyBalance) {
    const nestedPreflightTransaction = await verifyFundedHistoricalSigning(popup, wallet, {
      sourceAddress: addresses.nested,
      recipientAddress: wallet.address,
      addressType: 'p2sh-p2wpkh'
    })
    console.log(`[bitcoin-testnet-live] BIP-49 signing preflight: ${nestedPreflightTransaction}`)
    const nestedSpendTransaction = await sendBitcoinTransfer(popup, extensionId, {
      recipient: wallet.address,
      expectedInputType: 'Nested SegWit · BIP-49'
    })
    broadcasts.push(nestedSpendTransaction)
    console.log(`[bitcoin-testnet-live] BIP-49 spend tx: ${nestedSpendTransaction}`)
    await waitForPublicConfirmation(popup, nestedSpendTransaction)
    ;[nativeBalance, legacyBalance, nestedBalance] = await Promise.all(
      controlledAddresses.map(address => getConfirmedAddressBalance(popup, address))
    )
  }

  expect(broadcasts.length).toBeGreaterThan(0)
  expect(new Set(broadcasts).size).toBe(broadcasts.length)
  expect(nativeBalance).toBeGreaterThan(legacyBalance)
  expect(nativeBalance).toBeGreaterThan(nestedBalance)
  const activity = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'GET_BITCOIN_ACTIVITY' })
  )
  for (const transactionHash of broadcasts) {
    expect(activity).toMatchObject({
      result: {
        items: expect.arrayContaining([
          expect.objectContaining({
            source: 'wallet-v2',
            segments: [
              expect.objectContaining({ evidence: expect.objectContaining({ transactionHash }) })
            ]
          })
        ])
      }
    })
  }
})
