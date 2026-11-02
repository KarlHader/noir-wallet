import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { BrowserContext, Page } from '@playwright/test'
import {
  captureScreenshot,
  expect,
  selectImportedZcashHistory,
  test,
  waitForBackgroundWalletInitialization
} from '../../helpers/extension-fixtures'

const TEST_PASSWORD_PLACEHOLDER = '8–64 characters'
const ETH_ASSET_ID = 'eip155:11155111/slip44:60'
const RECIPIENT = '0x1111111111111111111111111111111111111111'
const TRANSFER_AMOUNT_RAW = '1000000000000000'
const PRIVATE_DAPP_TRANSFER_AMOUNT_RAW = '10000000000000'
const SEPOLIA_RPC_URL = 'https://ethereum-sepolia-rpc.publicnode.com'
const PRIVATE_DAPP_ORIGIN = 'https://private-defi-live.example'

interface LiveWalletFixture {
  readonly mnemonic: string
  readonly password: string
  readonly address: string
}

function loadLiveWalletFixture(): LiveWalletFixture | null {
  const fixturePath = process.env.NOIR_EVM_TESTNET_WALLET_FILE
  if (!fixturePath) return null
  if (!path.isAbsolute(fixturePath)) {
    throw new Error('The live EVM wallet fixture path must be absolute')
  }
  let fixtureStat
  try {
    fixtureStat = lstatSync(fixturePath)
  } catch {
    throw new Error('The live EVM wallet fixture does not exist or cannot be read')
  }
  if (fixtureStat.isSymbolicLink() || !fixtureStat.isFile() || fixtureStat.size > 16_384) {
    throw new Error('The live EVM wallet fixture must be a bounded regular file, not a symlink')
  }
  if ((fixtureStat.mode & 0o777) !== 0o600) {
    throw new Error('The live EVM wallet fixture must use mode 0600')
  }
  const value = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>
  if (
    Object.keys(value).sort().join(',') !== 'address,mnemonic,network,password,schemaVersion' ||
    value.schemaVersion !== 1 ||
    value.network !== 'sepolia' ||
    typeof value.mnemonic !== 'string' ||
    value.mnemonic.split(' ').length !== 24 ||
    typeof value.password !== 'string' ||
    value.password.length < 8 ||
    value.password.length > 64 ||
    typeof value.address !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(value.address)
  ) {
    throw new Error('Invalid live EVM wallet fixture')
  }
  return { mnemonic: value.mnemonic, password: value.password, address: value.address }
}

const liveWallet = loadLiveWalletFixture()

async function importLiveWallet(page: Page, wallet: LiveWalletFixture): Promise<void> {
  await page.getByRole('button', { name: 'Import wallet' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.locator('input[type="text"]').first().fill(wallet.mnemonic)
  await page.getByRole('button', { name: 'Continue' }).click()
  await selectImportedZcashHistory(page, { birthdayHeight: 3_000_000 })
  await page.getByPlaceholder(TEST_PASSWORD_PLACEHOLDER).fill(wallet.password)
  await page.getByPlaceholder('Confirm password').fill(wallet.password)
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Import Wallet' }).click()
  await expect(page.getByRole('heading', { name: 'Congratulations!' })).toBeVisible({
    timeout: 60_000
  })
}

async function rpc(method: string, params: readonly unknown[]): Promise<unknown> {
  const response = await fetch(SEPOLIA_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  })
  if (!response.ok) throw new Error(`Sepolia RPC returned HTTP ${response.status}`)
  const value = (await response.json()) as { result?: unknown; error?: unknown }
  if (value.error !== undefined || !Object.prototype.hasOwnProperty.call(value, 'result')) {
    throw new Error('Sepolia RPC returned an invalid result')
  }
  return value.result
}

async function connectEvmDApp(
  context: BrowserContext,
  dapp: Page
): Promise<Readonly<{ readonly mainAddress: string }>> {
  await context.route(`${PRIVATE_DAPP_ORIGIN}/**`, route =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><title>Private DeFi live dApp</title></head><body>Private DeFi live dApp</body></html>'
    })
  )
  await dapp.goto(`${PRIVATE_DAPP_ORIGIN}/connect`)
  await dapp.waitForFunction(() => {
    const target = window as typeof window & {
      noirwallet?: { ethereum?: { isNoirWallet?: boolean } }
    }
    return target.noirwallet?.ethereum?.isNoirWallet === true
  })

  const approvalPromise = context.waitForEvent('page')
  const accountsPromise = dapp.evaluate(() => {
    const provider = (
      window as typeof window & {
        noirwallet: {
          ethereum: {
            request: (input: { method: string; params?: unknown[] }) => Promise<unknown>
          }
        }
      }
    ).noirwallet.ethereum
    return provider.request({ method: 'eth_requestAccounts' })
  })
  const approval = await approvalPromise
  await approval.waitForURL(/#approval\?requestId=/)
  await approval.setViewportSize({ width: 375, height: 632 })
  await expect(
    approval.getByRole('heading', { name: 'private-defi-live.example', exact: true })
  ).toBeVisible()
  await approval.getByRole('button', { name: 'Connect', exact: true }).click()
  const accounts = (await accountsPromise) as string[]
  expect(accounts).toEqual([expect.stringMatching(/^0x[0-9a-fA-F]{40}$/)])
  await approval.close()
  return Object.freeze({ mainAddress: accounts[0] })
}

async function readProviderAccount(dapp: Page): Promise<string> {
  const accounts = (await dapp.evaluate(() => {
    const provider = (
      window as typeof window & {
        noirwallet: {
          ethereum: {
            request: (input: { method: string; params?: unknown[] }) => Promise<unknown>
          }
        }
      }
    ).noirwallet.ethereum
    return provider.request({ method: 'eth_accounts' })
  })) as string[]
  expect(accounts).toEqual([expect.stringMatching(/^0x[0-9a-fA-F]{40}$/)])
  return accounts[0]
}

test('broadcasts a real pinned-WASM EVM transfer on Sepolia', async ({ popup, extensionId }) => {
  test.skip(!liveWallet, 'NOIR_EVM_TESTNET_WALLET_FILE is not configured')
  test.setTimeout(240_000)
  if (!liveWallet) throw new Error('The live EVM wallet fixture was not loaded')
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
    expect.objectContaining({ chainId: 'eip155:11155111', identity: wallet.address })
  )
  await popup.goto(`chrome-extension://${extensionId}/index.html`)

  const portfolio = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'GET_PORTFOLIO', action: 'refresh' })
  )
  expect(portfolio).toMatchObject({
    result: {
      model: { chains: expect.arrayContaining([expect.objectContaining({ status: 'ready' })]) }
    }
  })
  const eth = portfolio.result.model.assets.find(
    (asset: { asset: { id: string } }) => asset.asset.id === ETH_ASSET_ID
  )
  expect(BigInt(eth.balance.availableRaw)).toBeGreaterThan(2_000_000_000_000_000n)

  const prepared = await popup.evaluate(
    intent => chrome.runtime.sendMessage({ type: 'PREPARE_EVM_TRANSFER', intent }),
    { assetId: ETH_ASSET_ID, recipient: RECIPIENT, amountRaw: TRANSFER_AMOUNT_RAW }
  )
  expect(prepared).toMatchObject({
    result: {
      graph: { root: { status: 'prepared' } },
      review: {
        chainId: 'eip155:11155111',
        summary: { fields: { from: wallet.address, to: RECIPIENT } }
      }
    }
  })
  const transactionId = prepared.result.graph.root.id as string
  const payloadFingerprint = prepared.result.review.payloadFingerprint.digestHex as string
  const approved = await popup.evaluate(
    input =>
      chrome.runtime.sendMessage({
        type: 'APPROVE_EVM_TRANSFER',
        transactionId: input.transactionId,
        payloadFingerprint: input.payloadFingerprint
      }),
    { transactionId, payloadFingerprint }
  )
  expect(approved).toMatchObject({
    result: { status: 'broadcast', graph: { root: { id: transactionId, status: 'broadcast' } } }
  })
  const transactionHash = approved.result.graph.segments[0].evidence.transactionHash as string
  console.log(`[evm-testnet-live] broadcast tx: ${transactionHash}`)

  await expect
    .poll(() => rpc('eth_getTransactionReceipt', [transactionHash]), { timeout: 120_000 })
    .toMatchObject({ transactionHash, status: '0x1' })
  await expect(rpc('eth_getTransactionByHash', [transactionHash])).resolves.toMatchObject({
    hash: transactionHash,
    from: wallet.address.toLowerCase(),
    to: RECIPIENT.toLowerCase(),
    value: `0x${BigInt(TRANSFER_AMOUNT_RAW).toString(16)}`,
    chainId: '0xaa36a7'
  })

  await expect(
    popup.evaluate(
      scope =>
        chrome.runtime.sendMessage({
          type: 'WORKER_RPC',
          method: 'evm.conformance-poll',
          payload: { scopes: [scope] }
        }),
      prepared.result.graph.root.scope
    )
  ).resolves.toMatchObject({ result: { checked: 1, errors: 0 } })
  await expect
    .poll(async () => {
      const activity = (await popup.evaluate(() =>
        chrome.runtime.sendMessage({ type: 'GET_ACTIVITY' })
      )) as {
        result?: { items?: Array<{ id?: string; source?: string; status?: string }> }
      }
      return activity.result?.items?.find(item => item.id === transactionId)
    })
    .toMatchObject({
      id: transactionId,
      source: 'wallet-v2',
      status: expect.stringMatching(/^(confirming|final)$/)
    })
})

test('broadcasts and confirms a real dApp transaction from the Global PEA on Sepolia', async ({
  context,
  popup,
  extensionId
}) => {
  test.skip(!liveWallet, 'NOIR_EVM_TESTNET_WALLET_FILE is not configured')
  test.skip(
    process.env.APPROVAL_WINDOW_E2E !== '1',
    'Chrome popup windows require a headed browser session'
  )
  test.setTimeout(300_000)
  if (!liveWallet) throw new Error('The live EVM wallet fixture was not loaded')

  await waitForBackgroundWalletInitialization(popup)
  await importLiveWallet(popup, liveWallet)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 30_000 })

  const dapp = await context.newPage()
  const { mainAddress } = await connectEvmDApp(context, dapp)
  expect(mainAddress.toLowerCase()).toBe(liveWallet.address.toLowerCase())

  await dapp.bringToFront()
  const accountEvents = dapp.evaluate(() => {
    const provider = (
      window as typeof window & {
        noirwallet: {
          ethereum: {
            on: (event: string, handler: (value: unknown) => void) => unknown
          }
        }
      }
    ).noirwallet.ethereum
    const events: unknown[] = []
    provider.on('accountsChanged', value => events.push(value))
    ;(window as typeof window & { __noirPeaAccountEvents?: unknown[] }).__noirPeaAccountEvents =
      events
    return true
  })
  await expect(accountEvents).resolves.toBe(true)

  await expect(
    popup.evaluate(() =>
      chrome.runtime.sendMessage({
        type: 'SET_DAPP_EXECUTION_MODE',
        mode: 'private',
        confirmPrivateSetup: true
      })
    )
  ).resolves.toMatchObject({ success: true, state: { mode: 'private' } })

  await expect
    .poll(async () => (await readProviderAccount(dapp)).toLowerCase(), { timeout: 30_000 })
    .not.toBe(mainAddress.toLowerCase())
  const privateAddress = await readProviderAccount(dapp)
  expect(privateAddress.toLowerCase()).not.toBe(mainAddress.toLowerCase())
  await expect
    .poll(() =>
      dapp.evaluate(
        () =>
          (window as typeof window & { __noirPeaAccountEvents?: unknown[] }).__noirPeaAccountEvents
      )
    )
    .toContainEqual([privateAddress])

  const privateBalance = BigInt((await rpc('eth_getBalance', [privateAddress, 'latest'])) as string)
  expect(privateBalance).toBeGreaterThan(100_000_000_000_000n)

  await popup.bringToFront()
  await popup.reload()
  await popup.getByRole('button', { name: 'dApp address: Private' }).click()
  const modeCard = popup
    .getByRole('dialog', { name: 'dApp address' })
    .getByTestId('dapp-execution-mode-card')
  await expect(modeCard.getByRole('radio', { name: 'Use Private address for dApps' })).toBeChecked()
  await expect(modeCard.getByText('Private address', { exact: true })).toBeVisible()
  await captureScreenshot(popup, 'pea-live-testnet-private-mode.png')
  await popup
    .getByRole('dialog', { name: 'dApp address' })
    .getByRole('button', { name: 'Close' })
    .click()

  await dapp.bringToFront()
  const approvalPromise = context.waitForEvent('page')
  const transactionPromise = dapp.evaluate(
    ({ from, to, value }) => {
      const provider = (
        window as typeof window & {
          noirwallet: {
            ethereum: {
              request: (input: { method: string; params?: unknown[] }) => Promise<unknown>
            }
          }
        }
      ).noirwallet.ethereum
      return provider.request({
        method: 'eth_sendTransaction',
        params: [{ from, to, value }]
      })
    },
    {
      from: privateAddress,
      to: RECIPIENT,
      value: `0x${BigInt(PRIVATE_DAPP_TRANSFER_AMOUNT_RAW).toString(16)}`
    }
  )
  const approval = await approvalPromise
  await approval.waitForURL(/#approval\?requestId=/)
  await approval.setViewportSize({ width: 375, height: 632 })
  await expect(approval.getByRole('heading', { name: 'Review transaction' })).toBeVisible()
  const transactionReview = approval.getByRole('region', { name: 'Transaction' })
  await expect(transactionReview.getByText(new RegExp(privateAddress, 'i'))).toBeVisible()
  await expect(transactionReview.getByLabel('Private execution account')).toContainText('Private')
  await expect(approval.getByLabel('Private execution account')).toHaveCount(1)
  await expect(approval.getByText('Network fee', { exact: true })).toBeVisible()
  await captureScreenshot(approval, 'pea-live-testnet-dapp-approval.png')
  await approval.getByRole('button', { name: 'Confirm', exact: true }).click()

  const transactionHash = (await transactionPromise) as string
  expect(transactionHash).toMatch(/^0x[0-9a-f]{64}$/)
  console.log(`[pea-testnet-live] broadcast tx: ${transactionHash}`)
  await expect
    .poll(() => rpc('eth_getTransactionReceipt', [transactionHash]), { timeout: 180_000 })
    .toMatchObject({ transactionHash, status: '0x1' })
  await expect(rpc('eth_getTransactionByHash', [transactionHash])).resolves.toMatchObject({
    hash: transactionHash,
    from: privateAddress.toLowerCase(),
    to: RECIPIENT.toLowerCase(),
    value: `0x${BigInt(PRIVATE_DAPP_TRANSFER_AMOUNT_RAW).toString(16)}`,
    chainId: '0xaa36a7'
  })

  const readPrivateActivity = () =>
    popup.evaluate(hash => {
      return chrome.runtime
        .sendMessage({ type: 'GET_ACTIVITY' })
        .then(activity =>
          activity.result?.items?.find(
            (item: {
              accountMode?: string
              status?: string
              scope?: { keyDomainId: string; accountId: string }
              segments?: Array<{ evidence?: { transactionHash?: string } }>
            }) =>
              item.segments?.some(
                segment => segment.evidence?.transactionHash?.toLowerCase() === hash
              )
          )
        )
    }, transactionHash)
  await expect.poll(readPrivateActivity).toMatchObject({ accountMode: 'private' })
  const privateActivity = await readPrivateActivity()
  expect(privateActivity?.scope).toBeDefined()
  await expect(
    popup.evaluate(
      scope =>
        chrome.runtime.sendMessage({
          type: 'WORKER_RPC',
          method: 'evm.conformance-poll',
          payload: { scopes: [scope] }
        }),
      privateActivity!.scope
    )
  ).resolves.toMatchObject({ result: { checked: expect.any(Number), errors: 0 } })
  await expect.poll(readPrivateActivity, { timeout: 30_000 }).toMatchObject({
    accountMode: 'private',
    status: expect.stringMatching(/^(confirming|final)$/)
  })

  await popup.bringToFront()
  await popup.reload()
  await popup.getByRole('tab', { name: 'Activity' }).click()
  await expect(popup.getByRole('group', { name: 'Filter activity by account mode' })).toHaveCount(0)
  await expect.poll(() => popup.locator('[data-activity-id]').count()).toBeGreaterThan(0)
  await captureScreenshot(popup, 'pea-live-testnet-private-activity.png')

  await expect(
    popup.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'SET_DAPP_EXECUTION_MODE', mode: 'main' })
    )
  ).resolves.toMatchObject({ success: true, state: { mode: 'main' } })
  await expect
    .poll(async () => (await readProviderAccount(dapp)).toLowerCase(), { timeout: 30_000 })
    .toBe(mainAddress.toLowerCase())
  await expect
    .poll(() =>
      dapp.evaluate(
        () =>
          (window as typeof window & { __noirPeaAccountEvents?: unknown[] }).__noirPeaAccountEvents
      )
    )
    .toEqual(expect.arrayContaining([[privateAddress], [mainAddress]]))
  await dapp.close()
})
