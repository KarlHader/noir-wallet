import type { BrowserContext, Page, Route } from '@playwright/test'
import {
  keccak256,
  parseTransaction,
  recoverMessageAddress,
  recoverTypedDataAddress,
  type Hex
} from 'viem'
import { verifyMessageSignature } from '../../../sdk/src/chains/zcash/utils'
import sdkPackage from '../../../sdk/package.json' with { type: 'json' }
import { DEFAULT_HISTORY_API_ORIGIN } from '../../scripts/lib/extension-build-config'
import {
  captureScreenshot,
  expect,
  mockUnknownZcashAccountHistory,
  selectImportedZcashHistory,
  selectNewZcashAccountHistory,
  test,
  terminateExtensionServiceWorker,
  waitForBackgroundWalletInitialization
} from '../helpers/extension-fixtures'

const NOIR_WALLET_RDNS = sdkPackage.rdns
const TEST_MNEMONIC_24 = `${'abandon '.repeat(23)}art`
const TEST_PASSWORD = 'evm-testnet-transfer-password'
const TEST_BETA_INVITE_CODE = 'EVM-TESTNET-INVITE'
const RECIPIENT = '0x1111111111111111111111111111111111111111'
const ZEC_TESTNET_ASSET_ID = 'bip122:05a60a92d99d85997cce3b87616c089f/slip44:133'
const ETH_ASSET_ID = 'eip155:11155111/slip44:60'
const USDC_ASSET_ID = 'eip155:11155111/erc20:0x1c7d4b196cb0c7b01d743fbc6116a902379c7238'
const USDC_CONTRACT = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238'
const SEPOLIA_RPC_URL = 'https://ethereum-sepolia-rpc.publicnode.com/**'
const SEPOLIA_EXPLORER_URL = 'https://sepolia.etherscan.io'
const ARBITRUM_SEPOLIA_RPC_URL = 'https://sepolia-rollup.arbitrum.io/rpc'
const EVM_HISTORY_URLS = ['https://arbitrum-sepolia.blockscout.com/api/**'] as const
const EVM_HISTORY_PROXY_ORIGINS = new Set([DEFAULT_HISTORY_API_ORIGIN, 'https://evm-history.test'])

async function expectDAppRequestHeader(
  page: Page,
  action: 'Review transaction' | 'Sign message'
): Promise<void> {
  await expect(
    page.getByTestId('approval-scroll-region').getByText(action, { exact: true })
  ).toBeVisible()
  await expect(page.getByRole('heading', { name: 'evm-dapp.example', exact: true })).toBeVisible()
}

test.beforeEach(async ({ context }) => {
  await context.route('https://api.zknoir.com/v1/invite-codes/**', async route => {
    const request = route.request()
    const action = new URL(request.url()).pathname.split('/').at(-1)
    expect(new URL(request.url()).pathname).toBe(
      `/v1/invite-codes/${TEST_BETA_INVITE_CODE}/${action}`
    )
    if (action === 'bind') {
      expect(request.method()).toBe('POST')
      expect(request.postDataJSON().wallet_address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    } else {
      expect(action).toBe('check')
      expect(request.method()).toBe('GET')
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        code: 0,
        data:
          action === 'bind'
            ? { code: TEST_BETA_INVITE_CODE, bound: true }
            : { exists: true, bound: false }
      })
    })
  })
  await context.route(
    url => EVM_HISTORY_PROXY_ORIGINS.has(url.origin) && url.pathname === '/',
    route => {
      const body = route.request().postDataJSON() as { id: number | string; method: string }
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result:
            body.method === 'ankr_getTokenTransfers' ? { transfers: [] } : { transactions: [] }
        })
      })
    }
  )
  await context.route('https://assets.zknoir.com/chain/**', route =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#00d18a"/></svg>'
    })
  )
  for (const url of EVM_HISTORY_URLS) {
    await context.route(url, route =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ status: '0', message: 'No transactions found', result: [] })
      })
    )
  }
})

async function importTestWallet(
  page: Page,
  zcashHistory: 'imported' | 'new' = 'imported'
): Promise<void> {
  const activation = await page.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'GET_BETA_INVITE_ACTIVATION' })
  )
  if (activation?.result?.required) {
    await expect(page.getByRole('heading', { name: 'Enter invite code' })).toBeVisible()
    await page.getByRole('textbox', { name: 'Invite code' }).fill(TEST_BETA_INVITE_CODE)
    await page.getByRole('button', { name: 'Continue' }).click()
  }
  await page.getByRole('button', { name: 'Import wallet' }).click()
  await expect(page.getByRole('radio', { name: '24 words' })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.locator('input[type="text"]').first().fill(TEST_MNEMONIC_24)
  await page.getByRole('button', { name: 'Continue' }).click()
  if (zcashHistory === 'new') {
    await selectImportedZcashHistory(page)
  } else {
    await selectImportedZcashHistory(page, { birthdayHeight: 3_000_000 })
  }
  await page.getByPlaceholder('8–64 characters').fill(TEST_PASSWORD)
  await page.getByPlaceholder('Confirm password').fill(TEST_PASSWORD)
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Import Wallet' }).click()
  await expect(page.getByRole('heading', { name: 'Congratulations!' })).toBeVisible({
    timeout: 60_000
  })
}

async function connectAdditionalEvmDApp(
  context: BrowserContext,
  origin: string,
  title: string
): Promise<Readonly<{ readonly page: Page; readonly address: string }>> {
  await context.route(`${origin}/**`, route =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><title>${title}</title></head><body>${title}</body></html>`
    })
  )
  const page = await context.newPage()
  await page.goto(`${origin}/connect`)
  await page.waitForFunction(() => {
    const target = window as typeof window & {
      noirwallet?: { ethereum?: { isNoirWallet?: boolean } }
    }
    return target.noirwallet?.ethereum?.isNoirWallet === true
  })

  const approvalPromise = context.waitForEvent('page')
  const accountsPromise = page.evaluate(() => {
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
  await approval.getByRole('button', { name: 'Connect', exact: true }).click()
  const accounts = (await accountsPromise) as string[]
  expect(accounts).toEqual([expect.stringMatching(/^0x[0-9a-f]{40}$/)])
  if (!approval.isClosed()) await approval.close()
  return Object.freeze({ page, address: accounts[0] })
}

async function openDAppExecutionMode(page: Page) {
  const trigger = page.getByRole('button', { name: /dApp address:/ })
  await expect(trigger).toBeVisible()
  await expect
    .poll(async () => await trigger.boundingBox())
    .toMatchObject({ width: 32, height: 32 })
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: 'dApp address' })
  await expect(dialog).toBeVisible()
  return Object.freeze({ trigger, dialog, panel: dialog.getByTestId('dapp-execution-mode-card') })
}

async function expectHomeHeaderActionsAligned(page: Page) {
  const buttons = page.getByTestId('home-header-actions').getByRole('button')
  await expect(buttons).toHaveCount(3)
  const boxes = await buttons.evaluateAll(elements =>
    elements.map(element => {
      const box = element.getBoundingClientRect()
      const iconBox = element.firstElementChild?.getBoundingClientRect()
      const style = window.getComputedStyle(element)
      return {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        iconWidth: iconBox?.width,
        iconHeight: iconBox?.height,
        borderRadius: style.borderRadius,
        backgroundColor: style.backgroundColor
      }
    })
  )
  expect(boxes.map(({ width, height }) => ({ width, height }))).toEqual([
    { width: 32, height: 32 },
    { width: 32, height: 32 },
    { width: 32, height: 32 }
  ])
  expect(boxes.map(box => box.y)).toEqual([boxes[0].y, boxes[0].y, boxes[0].y])
  expect(boxes.map(({ iconWidth, iconHeight }) => ({ iconWidth, iconHeight }))).toEqual([
    { iconWidth: 18, iconHeight: 18 },
    { iconWidth: 18, iconHeight: 18 },
    { iconWidth: 18, iconHeight: 18 }
  ])
  expect(boxes.map(box => box.borderRadius)).toEqual(['8px', '8px', '8px'])
  expect(boxes.map(box => box.backgroundColor)).toEqual([
    boxes[0].backgroundColor,
    boxes[0].backgroundColor,
    boxes[0].backgroundColor
  ])
  expect(boxes[1].x - (boxes[0].x + boxes[0].width)).toBe(8)
  expect(boxes[2].x - (boxes[1].x + boxes[1].width)).toBe(8)
}

function waitForAccountsChanged(page: Page): Promise<unknown> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const provider = (
          window as typeof window & {
            noirwallet: {
              ethereum: {
                on: (event: string, handler: (value: unknown) => void) => unknown
                removeListener: (event: string, handler: (value: unknown) => void) => unknown
              }
            }
          }
        ).noirwallet.ethereum
        const timeout = window.setTimeout(() => {
          provider.removeListener('accountsChanged', handler)
          reject(new Error('accountsChanged event timed out'))
        }, 15_000)
        const handler = (value: unknown) => {
          window.clearTimeout(timeout)
          provider.removeListener('accountsChanged', handler)
          resolve(value)
        }
        provider.on('accountsChanged', handler)
      })
  )
}

async function readEvmAccounts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const provider = (
      window as typeof window & {
        noirwallet: {
          ethereum: {
            request: (input: { method: string; params?: unknown[] }) => Promise<unknown>
          }
        }
      }
    ).noirwallet.ethereum
    return provider.request({ method: 'eth_accounts' }) as Promise<string[]>
  })
}

async function seedFreshAssetPrices(page: Page): Promise<void> {
  const now = Date.now()
  await page.evaluate(
    ({ fetchedAt, quotes, marketQuotes }) =>
      chrome.storage.local.set({
        asset_price_cache_v1: {
          version: 1,
          fetchedAt,
          quotes: quotes.map(quote => ({ ...quote, sourceUpdatedAt: fetchedAt }))
        },
        asset_market_change_cache_v1: {
          version: 1,
          fetchedAt,
          quotes: marketQuotes.map(quote => ({ ...quote, fetchedAt }))
        }
      }),
    {
      fetchedAt: now,
      quotes: [
        { assetId: ZEC_TESTNET_ASSET_ID, priceUsd: '40' },
        { assetId: ETH_ASSET_ID, priceUsd: '2500' },
        { assetId: USDC_ASSET_ID, priceUsd: '1' }
      ],
      marketQuotes: [
        {
          marketAssetId: 'ethereum',
          percent24h: '1.25',
          observedPriceUsd: '2500'
        }
      ]
    }
  )
}

async function waitForDialogAnimations(page: Page): Promise<void> {
  await page.getByRole('dialog').evaluate(async element => {
    await Promise.all(
      element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))
    )
  })
}

async function expectResultContentFits(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page
        .locator('[data-transaction-status] .overflow-y-auto')
        .evaluate(element => element.scrollHeight - element.clientHeight)
    )
    .toBeLessThanOrEqual(1)
}

interface MockEvmRpcState {
  readonly rawTransactions: string[]
}

async function mockPreparingEvmRpc(page: Page): Promise<MockEvmRpcState> {
  const state: MockEvmRpcState = { rawTransactions: [] }
  await page.context().route(SEPOLIA_RPC_URL, async route => {
    const request = route.request().postDataJSON() as {
      id: number
      method: string
      params?: readonly unknown[]
    }
    const simulatedCall = request.params?.[0] as { data?: unknown } | undefined
    if (request.method === 'eth_call' && simulatedCall?.data === '0xdeadbeef') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: 3, message: 'execution reverted: expected revert' }
        })
      })
      return
    }
    const result =
      request.method === 'eth_chainId'
        ? '0xaa36a7'
        : request.method === 'eth_getBalance'
          ? '0xde0b6b3a7640000'
          : request.method === 'eth_getTransactionCount'
            ? `0x${state.rawTransactions.length.toString(16)}`
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
                            !/^0x[0-9a-fA-F]+$/.test(rawTransaction)
                          ) {
                            throw new Error('Expected a canonical signed EVM transaction')
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
  await page.context().route(ARBITRUM_SEPOLIA_RPC_URL, async route => {
    const request = route.request().postDataJSON() as {
      id: number
      method: string
    }
    const result = request.method === 'eth_chainId' ? '0x66eee' : '0x0'
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id: request.id, result })
    })
  })
  return state
}

test('restores an authorized EVM dApp on its first request after worker restart', async ({
  context,
  popup,
  extensionId
}) => {
  test.skip(
    process.env.APPROVAL_WINDOW_E2E !== '1',
    'Chrome popup windows require a headed browser session'
  )
  test.setTimeout(180_000)
  await mockPreparingEvmRpc(popup)
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup, 'new')
  await popup.goto(`chrome-extension://${extensionId}/index.html`)

  await context.route('https://evm-dapp.example/**', route =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><title>EVM reconnect dApp</title></head><body>
        <script>
          window.noirAutoConnectResult = null
          window.noirwallet.ethereum
            .request({ method: 'eth_accounts' })
            .then(
              accounts => { window.noirAutoConnectResult = { accounts } },
              error => { window.noirAutoConnectResult = { error: error.message } }
            )
        </script>
      </body></html>`
    })
  )
  const dapp = await context.newPage()
  await dapp.goto('https://evm-dapp.example/connect')
  const readAutoConnect = async () => {
    await dapp.waitForFunction(
      () =>
        (
          window as typeof window & {
            noirAutoConnectResult: { accounts?: string[]; error?: string } | null
          }
        ).noirAutoConnectResult !== null,
      null,
      { timeout: 10_000 }
    )
    return dapp.evaluate(
      () =>
        (
          window as typeof window & {
            noirAutoConnectResult: { accounts?: string[]; error?: string }
          }
        ).noirAutoConnectResult
    )
  }
  expect(await readAutoConnect()).toEqual({ accounts: [] })

  const approvalPromise = context.waitForEvent('page')
  const connectPromise = dapp.evaluate(() =>
    (
      window as typeof window & {
        noirwallet: {
          ethereum: { request: (args: { method: string }) => Promise<string[]> }
        }
      }
    ).noirwallet.ethereum.request({ method: 'eth_requestAccounts' })
  )
  const approval = await approvalPromise
  await approval.waitForURL(/#approval\?requestId=/)
  await approval.getByRole('button', { name: /^Connect/ }).click()
  const connectedAccounts = await connectPromise
  expect(connectedAccounts).toHaveLength(1)

  await terminateExtensionServiceWorker(context, popup)
  await dapp.reload()
  expect(await readAutoConnect()).toEqual({ accounts: connectedAccounts })
})

test('announces an EIP-6963 provider and enforces EVM permissions in real MV3', async ({
  context,
  popup,
  extensionId
}) => {
  test.skip(
    process.env.APPROVAL_WINDOW_E2E !== '1',
    'Chrome popup windows require a headed browser session'
  )
  test.setTimeout(180_000)
  const rpcState = await mockPreparingEvmRpc(popup)
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)

  await context.route('https://evm-dapp.example/**', route =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><title>EVM test dApp</title><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E%3Crect width=%2232%22 height=%2232%22 rx=%228%22 fill=%22%2300d18a%22/%3E%3C/svg%3E"></head><body>EVM dApp</body></html>'
    })
  )
  const dapp = await context.newPage()
  await dapp.goto('https://evm-dapp.example/connect')
  const dappOrigin = new URL(dapp.url()).origin
  await dapp.waitForFunction(() => {
    const target = window as typeof window & {
      noirwallet?: { ethereum?: { isNoirWallet?: boolean } }
    }
    return target.noirwallet?.ethereum?.isNoirWallet === true
  })

  const announcement = await dapp.evaluate(
    rdns =>
      new Promise<{ name: string; rdns: string; sameProvider: boolean }>((resolve, reject) => {
        const timeout = window.setTimeout(
          () => reject(new Error('EIP-6963 announcement timed out')),
          10_000
        )
        const listener = (event: Event) => {
          const detail = (event as CustomEvent).detail as {
            info?: { name?: string; rdns?: string }
            provider?: unknown
          }
          if (detail.info?.rdns !== rdns) return
          window.clearTimeout(timeout)
          window.removeEventListener('eip6963:announceProvider', listener)
          const target = window as typeof window & {
            noirwallet: { ethereum: unknown }
          }
          resolve({
            name: detail.info.name ?? '',
            rdns: detail.info.rdns,
            sameProvider: detail.provider === target.noirwallet.ethereum
          })
        }
        window.addEventListener('eip6963:announceProvider', listener)
        window.dispatchEvent(new Event('eip6963:requestProvider'))
      }),
    NOIR_WALLET_RDNS
  )
  expect(announcement).toEqual({
    name: 'Noir Wallet',
    rdns: NOIR_WALLET_RDNS,
    sameProvider: true
  })

  const initialProviderState = await dapp.evaluate(async () => {
    const provider = (
      window as typeof window & {
        noirwallet: {
          ethereum: {
            chainId: string | null
            selectedAddress: string | null
            isConnected: () => boolean
            request: (input: {
              method: string
              params?: unknown[] | Record<string, unknown>
            }) => Promise<unknown>
          }
        }
      }
    ).noirwallet.ethereum
    const chainId = await provider.request({ method: 'eth_chainId' })
    const accounts = await provider.request({ method: 'eth_accounts' })
    const publicCall = await provider.request({
      method: 'eth_call',
      params: { to: '0x1111111111111111111111111111111111111111', data: '0x' }
    })
    let unsupported: { code?: number; message?: string } | null = null
    try {
      await provider.request({ method: 'eth_sign', params: [] })
    } catch (error) {
      unsupported = error as { code?: number; message?: string }
    }
    return {
      chainId,
      accounts,
      publicCall,
      isConnected: provider.isConnected(),
      selectedAddress: provider.selectedAddress,
      unsupported: unsupported && { code: unsupported.code, message: unsupported.message }
    }
  })
  expect(initialProviderState).toEqual({
    chainId: '0xaa36a7',
    accounts: [],
    publicCall: '0x',
    isConnected: true,
    selectedAddress: null,
    unsupported: { code: 4200, message: 'The requested EVM method is not supported.' }
  })

  await expect(
    dapp.evaluate(() => {
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
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: '0xaa36a7',
            chainName: 'Ethereum Sepolia',
            nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'],
            blockExplorerUrls: ['https://sepolia.etherscan.io']
          }
        ]
      })
    })
  ).resolves.toBeNull()

  await expect(
    popup.evaluate(() => chrome.runtime.sendMessage({ type: 'WALLET_LOCKED' }))
  ).resolves.toMatchObject({ success: true })

  const unlockWindowPromise = context.waitForEvent('page')
  const connectResultPromise = dapp.evaluate(() => {
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
  const unlockWindow = await unlockWindowPromise
  await unlockWindow.waitForURL(/#unlock\?from=dapp/)
  await expect(unlockWindow.getByRole('heading', { name: 'Enter your password' })).toBeVisible()
  const connectApprovalPromise = context.waitForEvent('page')
  await unlockWindow.getByPlaceholder('Enter Password').fill(TEST_PASSWORD)
  await unlockWindow.getByRole('button', { name: 'Unlock' }).click()
  const connectApproval = await connectApprovalPromise
  await connectApproval.waitForURL(/#approval\?requestId=/)
  await connectApproval.setViewportSize({ width: 375, height: 632 })
  await expect(connectApproval.getByText('Connect to', { exact: true })).toBeVisible()
  await expect(
    connectApproval.getByRole('heading', { name: 'evm-dapp.example', exact: true })
  ).toBeVisible()
  await expect(connectApproval.getByText('Ethereum Sepolia', { exact: true })).toHaveCount(0)
  await expect(
    connectApproval.getByText(/Transactions and signatures still require your approval/)
  ).toBeVisible()
  await expect(connectApproval.getByTestId('approval-footer')).toBeVisible()
  await expect
    .poll(() =>
      connectApproval.evaluate(() => ({
        viewportWidth: document.documentElement.clientWidth,
        contentWidth: document.documentElement.scrollWidth
      }))
    )
    .toEqual({ viewportWidth: 375, contentWidth: 375 })
  await captureScreenshot(connectApproval, 'evm-dapp-connect-approval.png')
  await connectApproval.getByRole('button', { name: /^Connect/ }).click()

  const connectedAccounts = (await connectResultPromise) as string[]
  expect(connectedAccounts).toEqual([expect.stringMatching(/^0x[0-9a-f]{40}$/)])
  const connectedAddress = connectedAccounts[0]
  const connectedState = await dapp.evaluate(async () => {
    const provider = (
      window as typeof window & {
        noirwallet: {
          ethereum: {
            selectedAddress: string | null
            request: (input: { method: string; params?: unknown[] }) => Promise<unknown>
          }
        }
      }
    ).noirwallet.ethereum
    return {
      accounts: await provider.request({ method: 'eth_accounts' }),
      permissions: await provider.request({ method: 'wallet_getPermissions' }),
      selectedAddress: provider.selectedAddress
    }
  })
  expect(connectedState).toMatchObject({
    accounts: [connectedAddress],
    permissions: [
      {
        parentCapability: 'eth_accounts',
        caveats: [{ type: 'restrictReturnedAccounts', value: [connectedAddress] }]
      }
    ],
    selectedAddress: connectedAddress
  })

  await dapp.reload()
  await dapp.waitForFunction(() => {
    const target = window as typeof window & {
      noirwallet?: { ethereum?: { isNoirWallet?: boolean } }
    }
    return target.noirwallet?.ethereum?.isNoirWallet === true
  })
  await expect
    .poll(() =>
      dapp.evaluate(async () => {
        const provider = (
          window as typeof window & {
            noirwallet: {
              ethereum: {
                selectedAddress: string | null
                request: (input: { method: string }) => Promise<unknown>
              }
            }
          }
        ).noirwallet.ethereum
        return {
          accounts: await provider.request({ method: 'eth_accounts' }),
          selectedAddress: provider.selectedAddress
        }
      })
    )
    .toEqual({ accounts: [connectedAddress], selectedAddress: connectedAddress })
  await expect(
    dapp.evaluate(async () => {
      const provider = (
        window as typeof window & {
          noirwallet: {
            ethereum: {
              request: (input: { method: string }) => Promise<unknown>
            }
          }
        }
      ).noirwallet.ethereum
      return provider.request({ method: 'eth_requestAccounts' })
    })
  ).resolves.toEqual([connectedAddress])

  const switchToArbitrumApprovalPromise = context.waitForEvent('page')
  const switchToArbitrumResultPromise = dapp.evaluate(async () => {
    const provider = (
      window as typeof window & {
        noirwallet: {
          ethereum: {
            chainId: string | null
            selectedAddress: string | null
            request: (input: { method: string; params?: unknown[] }) => Promise<unknown>
            on: (event: string, handler: (value: unknown) => void) => unknown
            removeListener: (event: string, handler: (value: unknown) => void) => unknown
          }
        }
      }
    ).noirwallet.ethereum
    const nextChain = new Promise<unknown>((resolve, reject) => {
      const timeout = window.setTimeout(
        () => reject(new Error('chainChanged event timed out')),
        10_000
      )
      const handler = (value: unknown) => {
        window.clearTimeout(timeout)
        provider.removeListener('chainChanged', handler)
        resolve(value)
      }
      provider.on('chainChanged', handler)
    })
    const nextAccounts = new Promise<unknown>((resolve, reject) => {
      const timeout = window.setTimeout(
        () => reject(new Error('accountsChanged event timed out')),
        10_000
      )
      const handler = (value: unknown) => {
        window.clearTimeout(timeout)
        provider.removeListener('accountsChanged', handler)
        resolve(value)
      }
      provider.on('accountsChanged', handler)
    })
    const result = await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x66eee' }]
    })
    return {
      result,
      eventChainId: await nextChain,
      eventAccounts: await nextAccounts,
      chainId: provider.chainId,
      accounts: await provider.request({ method: 'eth_accounts' }),
      selectedAddress: provider.selectedAddress
    }
  })
  const switchToArbitrumApproval = await switchToArbitrumApprovalPromise
  await switchToArbitrumApproval.waitForURL(/#approval\?requestId=/)
  await switchToArbitrumApproval.setViewportSize({ width: 375, height: 632 })
  await expect(switchToArbitrumApproval.getByText('Switch network', { exact: true })).toBeVisible()
  await expect(
    switchToArbitrumApproval.getByRole('heading', { name: 'evm-dapp.example', exact: true })
  ).toBeVisible()
  await expect(
    switchToArbitrumApproval.getByText('Arbitrum Sepolia', { exact: true })
  ).toBeVisible()
  await expect(switchToArbitrumApproval.getByText('eip155:421614', { exact: true })).toBeVisible()
  await expect(switchToArbitrumApproval.getByTestId('approval-footer')).toBeVisible()
  await captureScreenshot(switchToArbitrumApproval, 'evm-dapp-switch-network-approval.png')

  const concurrentExplorerUpdate = await popup.evaluate(async () => {
    const current = await chrome.runtime.sendMessage({ type: 'GET_CHAIN_ENDPOINT_SETTINGS' })
    if (!current?.result) throw new Error('Chain endpoint settings are unavailable')
    const settings = current.result as {
      schemaVersion: 1
      activeEvmChainId?: string
      customEvmNetworks: readonly unknown[]
      overrides: readonly { chainId: string }[]
    }
    return chrome.runtime.sendMessage({
      type: 'APPLY_CHAIN_ENDPOINT_SETTINGS',
      settings: {
        ...settings,
        overrides: [
          ...settings.overrides.filter(override => override.chainId !== 'eip155:11155111'),
          {
            chainId: 'eip155:11155111',
            explorer: {
              label: 'Concurrent Sepolia Explorer',
              baseUrl: 'https://concurrent-sepolia-explorer.example',
              transactionPath: 'transaction'
            }
          }
        ]
      }
    })
  })
  expect(concurrentExplorerUpdate).toMatchObject({
    result: {
      overrides: [
        {
          chainId: 'eip155:11155111',
          explorer: { baseUrl: 'https://concurrent-sepolia-explorer.example' }
        }
      ]
    }
  })
  await switchToArbitrumApproval.getByRole('button', { name: 'Switch Network' }).click()
  await expect
    .poll(() => switchToArbitrumApproval.isClosed(), {
      message: 'the approval window should close after the first confirmation click'
    })
    .toBe(true)
  await expect(switchToArbitrumResultPromise).resolves.toEqual({
    result: null,
    eventChainId: '0x66eee',
    eventAccounts: [connectedAddress],
    chainId: '0x66eee',
    accounts: [connectedAddress],
    selectedAddress: connectedAddress
  })
  const settingsAfterSwitch = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'GET_CHAIN_ENDPOINT_SETTINGS' })
  )
  expect(settingsAfterSwitch).toMatchObject({
    result: {
      activeEvmChainId: 'eip155:421614',
      overrides: [
        {
          chainId: 'eip155:11155111',
          explorer: {
            label: 'Concurrent Sepolia Explorer',
            baseUrl: 'https://concurrent-sepolia-explorer.example',
            transactionPath: 'transaction'
          }
        }
      ]
    }
  })

  await dapp.reload()
  await dapp.waitForFunction(() => {
    const target = window as typeof window & {
      noirwallet?: { ethereum?: { isNoirWallet?: boolean } }
    }
    return target.noirwallet?.ethereum?.isNoirWallet === true
  })
  await expect(
    dapp.evaluate(async () => {
      const provider = (
        window as typeof window & {
          noirwallet: {
            ethereum: {
              request: (input: { method: string }) => Promise<unknown>
            }
          }
        }
      ).noirwallet.ethereum
      return {
        chainId: await provider.request({ method: 'eth_chainId' }),
        accounts: await provider.request({ method: 'eth_accounts' }),
        connected: await provider.request({ method: 'eth_requestAccounts' })
      }
    })
  ).resolves.toEqual({
    chainId: '0x66eee',
    accounts: [connectedAddress],
    connected: [connectedAddress]
  })

  const switchToSepoliaApprovalPromise = context.waitForEvent('page')
  const switchToSepoliaResultPromise = dapp.evaluate(async () => {
    const provider = (
      window as typeof window & {
        noirwallet: {
          ethereum: {
            chainId: string | null
            selectedAddress: string | null
            request: (input: { method: string; params?: unknown[] }) => Promise<unknown>
            on: (event: string, handler: (value: unknown) => void) => unknown
            removeListener: (event: string, handler: (value: unknown) => void) => unknown
          }
        }
      }
    ).noirwallet.ethereum
    const nextChain = new Promise<unknown>((resolve, reject) => {
      const timeout = window.setTimeout(
        () => reject(new Error('chainChanged event timed out')),
        10_000
      )
      const handler = (value: unknown) => {
        window.clearTimeout(timeout)
        provider.removeListener('chainChanged', handler)
        resolve(value)
      }
      provider.on('chainChanged', handler)
    })
    const nextAccounts = new Promise<unknown>((resolve, reject) => {
      const timeout = window.setTimeout(
        () => reject(new Error('accountsChanged event timed out')),
        10_000
      )
      const handler = (value: unknown) => {
        window.clearTimeout(timeout)
        provider.removeListener('accountsChanged', handler)
        resolve(value)
      }
      provider.on('accountsChanged', handler)
    })
    const result = await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0xaa36a7' }]
    })
    return {
      result,
      eventChainId: await nextChain,
      eventAccounts: await nextAccounts,
      chainId: provider.chainId,
      accounts: await provider.request({ method: 'eth_accounts' }),
      selectedAddress: provider.selectedAddress
    }
  })
  const switchToSepoliaApproval = await switchToSepoliaApprovalPromise
  await switchToSepoliaApproval.waitForURL(/#approval\?requestId=/)
  await switchToSepoliaApproval.getByRole('button', { name: 'Switch Network' }).click()
  await expect
    .poll(() => switchToSepoliaApproval.isClosed(), {
      message: 'the approval window should close after the first confirmation click'
    })
    .toBe(true)
  await expect(switchToSepoliaResultPromise).resolves.toEqual({
    result: null,
    eventChainId: '0xaa36a7',
    eventAccounts: [connectedAddress],
    chainId: '0xaa36a7',
    accounts: [connectedAddress],
    selectedAddress: connectedAddress
  })

  const transactionApprovalPromise = context.waitForEvent('page')
  const transactionResultPromise = dapp.evaluate(
    ({ address, recipient }) => {
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
        params: [{ from: address, to: recipient, value: '0x38d7ea4c68000' }]
      })
    },
    { address: connectedAddress, recipient: RECIPIENT }
  )
  const transactionApproval = await transactionApprovalPromise
  await transactionApproval.waitForURL(/#approval\?requestId=/)
  await transactionApproval.setViewportSize({ width: 375, height: 632 })
  await expectDAppRequestHeader(transactionApproval, 'Review transaction')
  await expect(transactionApproval.getByText('Ethereum Sepolia', { exact: true })).toBeVisible()
  await expect(transactionApproval.getByText('0x1111...111111', { exact: true })).toBeVisible()
  await expect(transactionApproval.getByText('0.001 ETH', { exact: true })).toBeVisible()
  await expect(transactionApproval.locator(`[title="${RECIPIENT}"]`)).toBeVisible()
  await expect(transactionApproval.getByText('Network fee', { exact: true })).toBeVisible()
  await expect(transactionApproval.getByTestId('approval-footer')).toBeVisible()
  await captureScreenshot(transactionApproval, 'evm-dapp-transaction-approval.png')
  await transactionApproval.getByRole('button', { name: 'Confirm', exact: true }).click()
  const dappTransactionHash = await transactionResultPromise
  expect(dappTransactionHash).toMatch(/^0x[0-9a-f]{64}$/)
  expect(rpcState.rawTransactions).toHaveLength(1)
  expect(dappTransactionHash).toBe(keccak256(rpcState.rawTransactions[0] as Hex))

  const contractCalldata = '0x12345678aabbccdd'
  const contractApprovalPromise = context.waitForEvent('page')
  const contractResultPromise = dapp.evaluate(
    ({ address, contract, data }) => {
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
        params: [{ from: address, to: contract, value: '0x0', data, gas: '0x5208' }]
      })
    },
    { address: connectedAddress, contract: RECIPIENT, data: contractCalldata }
  )
  const contractApproval = await contractApprovalPromise
  await contractApproval.waitForURL(/#approval\?requestId=/)
  await contractApproval.setViewportSize({ width: 375, height: 632 })
  await expectDAppRequestHeader(contractApproval, 'Review transaction')
  await expect(contractApproval.getByText('Unknown contract call', { exact: true })).toHaveCount(0)
  await expect(contractApproval.getByText('0x1111...111111', { exact: true })).toBeVisible()
  await captureScreenshot(contractApproval, 'evm-dapp-contract-call-approval.png')
  await contractApproval.getByText('Advanced', { exact: true }).click()
  await expect(contractApproval.getByText('0x12345678', { exact: true })).toBeVisible()
  await expect(contractApproval.getByText(contractCalldata, { exact: true })).toBeVisible()
  const contractCalldataRow = contractApproval.getByText(contractCalldata, { exact: true })
  await contractCalldataRow.scrollIntoViewIfNeeded()
  await expect(contractCalldataRow).toBeInViewport()
  await expect(contractApproval.getByTestId('approval-footer')).toBeVisible()
  await captureScreenshot(contractApproval, 'evm-dapp-contract-call-details.png')
  await contractApproval.getByRole('button', { name: 'Confirm', exact: true }).click()
  const contractTransactionHash = await contractResultPromise
  expect(contractTransactionHash).toMatch(/^0x[0-9a-f]{64}$/)
  expect(rpcState.rawTransactions).toHaveLength(2)
  expect(contractTransactionHash).toBe(keccak256(rpcState.rawTransactions[1] as Hex))
  expect(parseTransaction(rpcState.rawTransactions[0] as Hex).nonce).toBe(0)
  expect(parseTransaction(rpcState.rawTransactions[1] as Hex).nonce).toBe(1)
  await expect
    .poll(async () => {
      const activity = (await popup.evaluate(() =>
        chrome.runtime.sendMessage({ type: 'GET_ACTIVITY' })
      )) as {
        result?: {
          items?: Array<{
            kind?: string
            snapshot?: {
              direction?: string
              primaryAmount?: unknown
              recipient?: { chainId?: string; address?: string }
            }
          }>
        }
      }
      return activity.result?.items?.find(item => item.kind === 'contract-call') ?? null
    })
    .toMatchObject({
      kind: 'contract-call',
      snapshot: {
        direction: 'contract',
        recipient: { chainId: 'eip155:11155111', address: RECIPIENT }
      }
    })

  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await popup.getByRole('tab', { name: 'Activity' }).click()
  const contractActivity = popup.getByRole('button', {
    name: 'View Contract interaction details on Ethereum Sepolia'
  })
  await expect(contractActivity).toBeVisible({ timeout: 30_000 })
  await expect(popup.getByRole('button', { name: /View Sent ETH details/ })).toBeVisible()
  await captureScreenshot(popup, 'noir-v2-multiple-pending-activity.png')
  await contractActivity.click()
  const contractActivityDetail = popup.locator('[data-activity-detail-id]')
  await expect(
    contractActivityDetail.getByRole('heading', { name: 'Contract interaction' })
  ).toBeVisible()
  await expect(contractActivityDetail.getByText('0x12345678', { exact: true })).toBeVisible()
  await captureScreenshot(popup, 'noir-v2-contract-interaction-activity.png')

  const pageCountBeforeRevert = context.pages().length
  const revertError = await dapp.evaluate(
    async ({ address, contract }) => {
      try {
        const provider = (
          window as typeof window & {
            noirwallet: {
              ethereum: {
                request: (input: { method: string; params?: unknown[] }) => Promise<unknown>
              }
            }
          }
        ).noirwallet.ethereum
        await provider.request({
          method: 'eth_sendTransaction',
          params: [{ from: address, to: contract, value: '0x0', data: '0xdeadbeef' }]
        })
        return null
      } catch (error) {
        const providerError = error as { code?: unknown; message?: unknown }
        return {
          code: providerError.code,
          message: providerError.message
        }
      }
    },
    { address: connectedAddress, contract: RECIPIENT }
  )
  expect(revertError).toEqual({
    code: -32603,
    message: 'Noir Wallet could not complete the request.'
  })
  expect(context.pages()).toHaveLength(pageCountBeforeRevert)
  expect(rpcState.rawTransactions).toHaveLength(2)

  const signApprovalPromise = context.waitForEvent('page')
  const signResultPromise = dapp.evaluate(address => {
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
      method: 'personal_sign',
      params: ['0x48656c6c6f204e6f6972', address]
    })
  }, connectedAddress)
  const signApproval = await signApprovalPromise
  await signApproval.waitForURL(/#approval\?requestId=/)
  await signApproval.setViewportSize({ width: 375, height: 632 })
  await expectDAppRequestHeader(signApproval, 'Sign message')
  await expect(signApproval.getByText('Hello Noir', { exact: true })).toBeVisible()
  await expect(signApproval.getByTestId('approval-footer')).toBeVisible()
  await captureScreenshot(signApproval, 'evm-dapp-personal-sign-approval.png')
  await signApproval.getByRole('button', { name: 'Sign message', exact: true }).click()
  const personalSignature = (await signResultPromise) as Hex
  expect(personalSignature).toMatch(/^0x[0-9a-f]{130}$/)
  const recoveredPersonalSigner = await recoverMessageAddress({
    message: 'Hello Noir',
    signature: personalSignature
  })
  expect(recoveredPersonalSigner.toLowerCase()).toBe(connectedAddress.toLowerCase())

  const typedDataDomain = {
    name: 'Noir Wallet',
    version: '1',
    chainId: 11155111,
    verifyingContract: RECIPIENT
  } as const
  const typedDataTypes = {
    Message: [{ name: 'contents', type: 'string' }]
  } as const
  const typedDataMessage = { contents: 'EIP-712 testnet ownership proof' } as const
  const typedDataJson = JSON.stringify({
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' }
      ],
      ...typedDataTypes
    },
    primaryType: 'Message',
    domain: typedDataDomain,
    message: typedDataMessage
  })
  const typedApprovalPromise = context.waitForEvent('page')
  const typedResultPromise = dapp.evaluate(
    ({ address, payload }) => {
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
        method: 'eth_signTypedData_v4',
        params: [address, payload]
      })
    },
    { address: connectedAddress, payload: typedDataJson }
  )
  const typedApproval = await typedApprovalPromise
  await typedApproval.waitForURL(/#approval\?requestId=/)
  await typedApproval.setViewportSize({ width: 375, height: 632 })
  await expectDAppRequestHeader(typedApproval, 'Sign message')
  const typedMessage = typedApproval.getByText('EIP-712 testnet ownership proof', {
    exact: false
  })
  await expect(typedMessage).toBeVisible()
  await expect(typedApproval.getByTestId('approval-footer')).toBeVisible()
  await captureScreenshot(typedApproval, 'evm-dapp-eip712-sign-approval.png')
  await typedApproval.getByText('Advanced', { exact: true }).click()
  await expect(typedApproval.getByText(RECIPIENT, { exact: false })).toBeVisible()
  await typedMessage.scrollIntoViewIfNeeded()
  await captureScreenshot(typedApproval, 'evm-dapp-eip712-sign-details.png')
  await typedApproval.getByRole('button', { name: 'Sign message', exact: true }).click()
  const typedSignature = (await typedResultPromise) as Hex
  expect(typedSignature).toMatch(/^0x[0-9a-f]{130}$/)
  const recoveredTypedSigner = await recoverTypedDataAddress({
    domain: typedDataDomain,
    types: typedDataTypes,
    primaryType: 'Message',
    message: typedDataMessage,
    signature: typedSignature
  })
  expect(recoveredTypedSigner.toLowerCase()).toBe(connectedAddress.toLowerCase())

  const pendingApprovalPromise = context.waitForEvent('page')
  const pendingTransactionOutcome = dapp.evaluate(
    async ({ address, recipient }) => {
      const provider = (
        window as typeof window & {
          noirwallet: {
            ethereum: {
              request: (input: { method: string; params?: unknown[] }) => Promise<unknown>
            }
          }
        }
      ).noirwallet.ethereum
      try {
        return {
          result: await provider.request({
            method: 'eth_sendTransaction',
            params: [{ from: address, to: recipient, value: '0x1' }]
          })
        }
      } catch (error) {
        const providerError = error as { code?: unknown; message?: unknown }
        return { error: { code: providerError.code, message: providerError.message } }
      }
    },
    { address: connectedAddress, recipient: RECIPIENT }
  )
  const pendingApproval = await pendingApprovalPromise
  await pendingApproval.waitForURL(/#approval\?requestId=/)
  await expect(pendingApproval.getByRole('heading', { name: 'Review transaction' })).toBeVisible()

  await popup.bringToFront()
  await popup.reload()
  let pendingMode = await openDAppExecutionMode(popup)
  let pendingModeCard = pendingMode.panel
  await pendingModeCard.getByRole('radio', { name: 'Use Confidential address for dApps' }).click()
  const privateSetupDialog = popup.getByRole('dialog', { name: 'Turn on dApp privacy?' })
  await expect(privateSetupDialog).toBeVisible()
  await privateSetupDialog.getByRole('button', { name: 'Turn on', exact: true }).click()
  const cancelPendingDialog = popup.getByRole('dialog', {
    name: 'Cancel pending dApp operations?'
  })
  await expect(cancelPendingDialog).toContainText(
    '1 pending EVM dApp operation was prepared for the current address'
  )
  await cancelPendingDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(popup.getByRole('button', { name: 'dApp address: Public' })).toBeVisible()
  await expect(pendingApproval.getByRole('heading', { name: 'Review transaction' })).toBeVisible()

  const privateEventAfterCancellation = waitForAccountsChanged(dapp)
  pendingMode = await openDAppExecutionMode(popup)
  pendingModeCard = pendingMode.panel
  await pendingModeCard.getByRole('radio', { name: 'Use Confidential address for dApps' }).click()
  await expect(privateSetupDialog).toBeVisible()
  await privateSetupDialog.getByRole('button', { name: 'Turn on', exact: true }).click()
  await expect(cancelPendingDialog).toBeVisible()
  await captureScreenshot(popup, 'dapp-mode-switch-pending-confirmation.png')
  await cancelPendingDialog.getByRole('button', { name: 'Switch & Cancel' }).click()
  const cancelledPrivateEvent = (await privateEventAfterCancellation) as string[]
  expect(cancelledPrivateEvent).toEqual([expect.stringMatching(/^0x[0-9a-f]{40}$/)])
  expect(cancelledPrivateEvent[0]?.toLowerCase()).not.toBe(connectedAddress.toLowerCase())
  await expect(pendingTransactionOutcome).resolves.toEqual({
    error: {
      code: 4001,
      message: 'User rejected the transaction request.'
    }
  })
  await expect(popup.getByRole('button', { name: 'dApp address: Confidential' })).toBeVisible()

  const privateContractApprovalPromise = context.waitForEvent('page')
  const privateContractResult = dapp.evaluate(
    async ({ from, to }) => {
      const provider = (
        window as typeof window & {
          noirwallet: {
            ethereum: {
              request: (input: { method: string; params?: unknown[] }) => Promise<unknown>
            }
          }
        }
      ).noirwallet.ethereum
      try {
        return await provider.request({
          method: 'eth_sendTransaction',
          params: [
            { from, to, value: '0x71afd498d0000', data: '0x12345678aabbccdd', gas: '0x5208' }
          ]
        })
      } catch (cause) {
        return { rejected: (cause as { code: number }).code }
      }
    },
    { from: cancelledPrivateEvent[0], to: RECIPIENT }
  )
  const privateContractApproval = await privateContractApprovalPromise
  await privateContractApproval.waitForURL(/#approval\?requestId=/)
  await privateContractApproval.setViewportSize({ width: 375, height: 632 })
  await expect(privateContractApproval.getByText('Execution', { exact: true })).toBeHidden()
  await expect(privateContractApproval.getByText('Public on-chain', { exact: true })).toBeHidden()
  await expect(privateContractApproval.getByText('0.002 ETH', { exact: true })).toBeVisible()
  await expect(
    privateContractApproval.getByText('Direct contract interaction.', { exact: false })
  ).toHaveCount(0)
  await expect(privateContractApproval.getByTestId('approval-footer')).toBeInViewport()
  await captureScreenshot(privateContractApproval, 'evm-confidential-contract-review-formatted.png')
  await privateContractApproval.getByText('Advanced', { exact: true }).click()
  await expect(privateContractApproval.getByText('Execution', { exact: true })).toBeVisible()
  await expect(privateContractApproval.getByText('Public on-chain', { exact: true })).toBeVisible()
  await privateContractApproval.getByText('Advanced', { exact: true }).click()
  await privateContractApproval.getByRole('button', { name: 'Reject', exact: true }).click()
  await expect(privateContractResult).resolves.toEqual({ rejected: 4001 })

  const mainEventAfterCancellation = waitForAccountsChanged(dapp)
  pendingMode = await openDAppExecutionMode(popup)
  pendingModeCard = pendingMode.panel
  await pendingModeCard.getByRole('radio', { name: 'Use Public address for dApps' }).click()
  await expect(mainEventAfterCancellation).resolves.toEqual([connectedAddress])
  await expect(popup.getByRole('button', { name: 'dApp address: Public' })).toBeVisible()

  const zcashConnectApprovalPromise = context.waitForEvent('page')
  const zcashConnectResultPromise = dapp.evaluate(() => {
    const provider = (
      window as typeof window & {
        noirwallet: {
          zcash: {
            request: (input: { method: string; params?: unknown[] }) => Promise<unknown>
          }
        }
      }
    ).noirwallet.zcash
    return provider.request({ method: 'zcash_requestAccounts' })
  })
  const zcashConnectApproval = await zcashConnectApprovalPromise
  await zcashConnectApproval.waitForURL(/#approval\?requestId=/)
  await zcashConnectApproval.setViewportSize({ width: 375, height: 632 })
  await expect(zcashConnectApproval.getByText('Connect to', { exact: true })).toBeVisible()
  await expect(
    zcashConnectApproval.getByRole('heading', { name: 'evm-dapp.example', exact: true })
  ).toBeVisible()
  await expect(zcashConnectApproval.getByText('Zcash Testnet', { exact: true })).toHaveCount(0)
  await captureScreenshot(zcashConnectApproval, 'zcash-dapp-connect-approval.png')
  await zcashConnectApproval.getByRole('button', { name: /^Connect/ }).click()
  const initialZcashAccounts = (await zcashConnectResultPromise) as {
    transparent: string
    shielded: string
  }
  expect(initialZcashAccounts).toMatchObject({
    transparent: expect.any(String),
    shielded: expect.any(String)
  })

  await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'ABORT_SYNC' }))
  await expect
    .poll(async () => {
      const state = (await popup.evaluate(() =>
        chrome.runtime.sendMessage({ type: 'GET_SYNC_STATE' })
      )) as { isSyncing?: boolean }
      return state.isSyncing
    })
    .toBe(false)

  const rotatedZcashAccountsPromise = dapp.evaluate(
    () =>
      new Promise<unknown>((resolve, reject) => {
        const provider = (
          window as typeof window & {
            noirwallet: {
              zcash: {
                on: (event: string, handler: (value: unknown) => void) => unknown
                removeListener: (event: string, handler: (value: unknown) => void) => unknown
              }
            }
          }
        ).noirwallet.zcash
        const timeout = window.setTimeout(() => {
          provider.removeListener('accountsChanged', handler)
          reject(new Error('Zcash address rotation event timed out'))
        }, 30_000)
        const handler = (value: unknown) => {
          window.clearTimeout(timeout)
          provider.removeListener('accountsChanged', handler)
          resolve(value)
        }
        provider.on('accountsChanged', handler)
      })
  )
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await popup.getByRole('button', { name: 'Show account addresses' }).click()
  await popup.getByLabel('Account address menu').getByRole('button', { name: 'View all' }).click()
  await popup.getByRole('button', { name: 'Open Zcash settings' }).click()
  await expect(popup.getByRole('heading', { name: 'Zcash settings' })).toBeVisible()
  const rotateAddressButton = popup.getByRole('button', { name: 'Generate new shielded address' })
  await rotateAddressButton.scrollIntoViewIfNeeded()
  await rotateAddressButton.click()
  const rotatedZcashAccounts = (await rotatedZcashAccountsPromise) as {
    transparent: string
    shielded: string
  }
  expect(rotatedZcashAccounts).toMatchObject({
    transparent: initialZcashAccounts.transparent,
    shielded: expect.any(String)
  })
  expect(rotatedZcashAccounts.shielded).not.toBe(initialZcashAccounts.shielded)
  await expect(rotateAddressButton).toBeEnabled()
  await captureScreenshot(popup, 'noir-v2-zcash-rotate-dapp-updated.png')

  const zcashMessage = 'Noir Wallet Zcash testnet ownership proof'
  const zcashSignApprovalPromise = context.waitForEvent('page')
  const zcashSignResultPromise = dapp.evaluate(message => {
    const provider = (
      window as typeof window & {
        noirwallet: {
          zcash: {
            request: (input: { method: string; params?: unknown[] }) => Promise<unknown>
          }
        }
      }
    ).noirwallet.zcash
    return provider.request({ method: 'zcash_signMessage', params: [message] })
  }, zcashMessage)
  const zcashSignApproval = await zcashSignApprovalPromise
  await zcashSignApproval.waitForURL(/#approval\?requestId=/)
  await zcashSignApproval.setViewportSize({ width: 375, height: 632 })
  await expectDAppRequestHeader(zcashSignApproval, 'Sign message')
  await expect(zcashSignApproval.getByText(zcashMessage, { exact: true })).toBeVisible()
  await expect(zcashSignApproval.getByTestId('approval-footer')).toBeVisible()
  await captureScreenshot(zcashSignApproval, 'zcash-dapp-sign-message-testnet.png')
  await zcashSignApproval.getByRole('button', { name: 'Sign message', exact: true }).click()
  const zcashSignature = (await zcashSignResultPromise) as {
    signature: string
    pubkey: string
    address: string
  }
  expect(
    verifyMessageSignature({
      message: zcashMessage,
      signature: zcashSignature.signature,
      pubkey: zcashSignature.pubkey,
      address: zcashSignature.address,
      network: 'testnet'
    })
  ).toMatchObject({ valid: true, pubkeyMatch: true, addressMatch: true })

  const zcashOnlyRevoked = await dapp.evaluate(async () => {
    const providers = (
      window as typeof window & {
        noirwallet: {
          ethereum: {
            request: (input: { method: string; params?: unknown[] }) => Promise<unknown>
          }
          zcash: {
            request: (input: { method: string; params?: unknown[] }) => Promise<unknown>
          }
        }
      }
    ).noirwallet
    return {
      result: await providers.zcash.request({ method: 'zcash_disconnect' }),
      zcashAccounts: await providers.zcash.request({ method: 'zcash_getAccounts' }),
      evmAccounts: await providers.ethereum.request({ method: 'eth_accounts' })
    }
  })
  expect(zcashOnlyRevoked).toEqual({
    result: true,
    zcashAccounts: null,
    evmAccounts: [connectedAddress]
  })

  const reconnectZcashApprovalPromise = context.waitForEvent('page')
  const reconnectZcashResultPromise = dapp.evaluate(() => {
    const provider = (
      window as typeof window & {
        noirwallet: {
          zcash: {
            request: (input: { method: string; params?: unknown[] }) => Promise<unknown>
          }
        }
      }
    ).noirwallet.zcash
    return provider.request({ method: 'zcash_requestAccounts' })
  })
  const reconnectZcashApproval = await reconnectZcashApprovalPromise
  await reconnectZcashApproval.waitForURL(/#approval\?requestId=/)
  await reconnectZcashApproval.getByRole('button', { name: /^Connect/ }).click()
  await expect(reconnectZcashResultPromise).resolves.toMatchObject({
    transparent: expect.any(String),
    shielded: expect.any(String)
  })

  const revoked = await dapp.evaluate(async () => {
    const provider = (
      window as typeof window & {
        noirwallet: {
          ethereum: {
            selectedAddress: string | null
            request: (input: { method: string; params?: unknown[] }) => Promise<unknown>
            on: (event: string, handler: (value: unknown) => void) => unknown
            removeListener: (event: string, handler: (value: unknown) => void) => unknown
          }
        }
      }
    ).noirwallet.ethereum
    const changed = new Promise<unknown>((resolve, reject) => {
      const timeout = window.setTimeout(
        () => reject(new Error('accountsChanged event timed out')),
        10_000
      )
      const handler = (value: unknown) => {
        window.clearTimeout(timeout)
        provider.removeListener('accountsChanged', handler)
        resolve(value)
      }
      provider.on('accountsChanged', handler)
    })
    const result = await provider.request({
      method: 'wallet_revokePermissions',
      params: [{ eth_accounts: {} }]
    })
    return {
      result,
      event: await changed,
      accounts: await provider.request({ method: 'eth_accounts' }),
      permissions: await provider.request({ method: 'wallet_getPermissions' }),
      selectedAddress: provider.selectedAddress
    }
  })
  expect(revoked).toEqual({
    result: null,
    event: [],
    accounts: [],
    permissions: [],
    selectedAddress: null
  })
  await expect(
    dapp.evaluate(() => {
      const provider = (
        window as typeof window & {
          noirwallet: {
            zcash: {
              request: (input: { method: string; params?: unknown[] }) => Promise<unknown>
            }
          }
        }
      ).noirwallet.zcash
      return provider.request({ method: 'zcash_getAccounts' })
    })
  ).resolves.toMatchObject({ transparent: expect.any(String), shielded: expect.any(String) })

  const reconnectEvmApprovalPromise = context.waitForEvent('page')
  const reconnectEvmResultPromise = dapp.evaluate(() => {
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
  const reconnectEvmApproval = await reconnectEvmApprovalPromise
  await reconnectEvmApproval.waitForURL(/#approval\?requestId=/)
  await reconnectEvmApproval.getByRole('button', { name: /^Connect/ }).click()
  await expect(reconnectEvmResultPromise).resolves.toEqual([connectedAddress])

  const globalDisconnectEvents = dapp.evaluate(async () => {
    const providers = (
      window as typeof window & {
        noirwallet: {
          ethereum: {
            on: (event: string, handler: (value: unknown) => void) => unknown
            removeListener: (event: string, handler: (value: unknown) => void) => unknown
          }
          zcash: {
            on: (event: string, handler: (value: unknown) => void) => unknown
            removeListener: (event: string, handler: (value: unknown) => void) => unknown
          }
        }
      }
    ).noirwallet
    const waitForAccountsChanged = (
      provider: {
        on: (event: string, handler: (value: unknown) => void) => unknown
        removeListener: (event: string, handler: (value: unknown) => void) => unknown
      },
      label: string
    ) =>
      new Promise<unknown>((resolve, reject) => {
        const timeout = window.setTimeout(
          () => reject(new Error(`${label} accountsChanged event timed out`)),
          10_000
        )
        const handler = (value: unknown) => {
          window.clearTimeout(timeout)
          provider.removeListener('accountsChanged', handler)
          resolve(value)
        }
        provider.on('accountsChanged', handler)
      })
    return Promise.all([
      waitForAccountsChanged(providers.zcash, 'Zcash'),
      waitForAccountsChanged(providers.ethereum, 'EVM')
    ])
  })
  await expect(
    popup.evaluate(
      origin => chrome.runtime.sendMessage({ type: 'DISCONNECT_DAPP', origin }),
      dappOrigin
    )
  ).resolves.toEqual({ success: true })
  await expect(globalDisconnectEvents).resolves.toEqual([null, []])
  await expect(
    dapp.evaluate(async () => {
      const providers = (
        window as typeof window & {
          noirwallet: {
            ethereum: {
              request: (input: { method: string; params?: unknown[] }) => Promise<unknown>
            }
            zcash: {
              request: (input: { method: string; params?: unknown[] }) => Promise<unknown>
            }
          }
        }
      ).noirwallet
      return {
        evm: await providers.ethereum.request({ method: 'eth_accounts' }),
        zcash: await providers.zcash.request({ method: 'zcash_getAccounts' })
      }
    })
  ).resolves.toEqual({ evm: [], zcash: null })

  await dapp.close()
})

test('invalidates an EVM approval when the active Account changes in real MV3', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  await mockPreparingEvmRpc(popup)
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)

  const active = await popup.evaluate(async () => {
    const stored = (await chrome.storage.local.get('wallet_state')).wallet_state
    const walletState = typeof stored === 'string' ? JSON.parse(stored) : stored
    return {
      walletId: walletState?.state?.currentWalletId,
      accountId: walletState?.state?.currentAccountId
    }
  })
  expect(active).toEqual({ walletId: expect.any(String), accountId: expect.any(String) })

  if (!active.walletId || !active.accountId) throw new Error('Active Account fixture is missing')
  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  const removeZcashHistoryMock = await mockUnknownZcashAccountHistory(context)
  await popup.getByRole('button', { name: 'Add Account', exact: true }).click()
  await selectNewZcashAccountHistory(popup)
  await expect(popup.getByText('Account 2', { exact: true })).toBeVisible({ timeout: 60_000 })
  await removeZcashHistoryMock()
  const persistedAccountIds = await popup.evaluate(async walletId => {
    const stored = (await chrome.storage.local.get('wallet_state')).wallet_state
    const walletState = typeof stored === 'string' ? JSON.parse(stored) : stored
    const wallet = walletState?.state?.wallets?.find(
      (candidate: { id?: string }) => candidate.id === walletId
    )
    return wallet?.accounts?.map((account: { id?: string }) => account.id) ?? []
  }, active.walletId)
  const addedAccountId = persistedAccountIds.find(accountId => accountId !== active.accountId)
  expect(addedAccountId).toEqual(expect.any(String))
  if (!addedAccountId) throw new Error('Derived Account fixture is missing')
  await popup.goto(`chrome-extension://${extensionId}/index.html`)

  const prepared = (await popup.evaluate(
    intent => chrome.runtime.sendMessage({ type: 'PREPARE_EVM_TRANSFER', intent }),
    { assetId: ETH_ASSET_ID, recipient: RECIPIENT, amountRaw: '1000000000000000' }
  )) as {
    result?: {
      graph: { root: { id: string } }
      review: { payloadFingerprint: { digestHex: string } }
    }
  }
  expect(prepared).toMatchObject({
    result: {
      graph: { root: { id: expect.any(String) } },
      review: { payloadFingerprint: { digestHex: expect.stringMatching(/^[0-9a-f]{64}$/) } }
    }
  })
  if (!prepared.result) throw new Error('EVM approval fixture was not prepared')

  await expect(
    popup.evaluate(
      ({ walletId, accountId }) =>
        chrome.runtime.sendMessage({ type: 'SWITCH_ACCOUNT', walletId, accountId }),
      { walletId: active.walletId, accountId: addedAccountId }
    )
  ).resolves.toMatchObject({ success: true })
  await expect(
    popup.evaluate(
      ({ walletId, accountId }) =>
        chrome.runtime.sendMessage({ type: 'SWITCH_ACCOUNT', walletId, accountId }),
      { walletId: active.walletId, accountId: active.accountId }
    )
  ).resolves.toMatchObject({ success: true })

  await expect(
    popup.evaluate(transactionId => {
      return chrome.runtime.sendMessage({ type: 'GET_PENDING_EVM_TRANSFER', transactionId })
    }, prepared.result.graph.root.id)
  ).resolves.toEqual({ result: null })
  await expect(
    popup.evaluate(
      ({ transactionId, payloadFingerprint }) =>
        chrome.runtime.sendMessage({
          type: 'APPROVE_EVM_TRANSFER',
          transactionId,
          payloadFingerprint
        }),
      {
        transactionId: prepared.result.graph.root.id,
        payloadFingerprint: prepared.result.review.payloadFingerprint.digestHex
      }
    )
  ).resolves.toEqual({
    error: { code: 'request-failed', message: 'The EVM wallet request failed' }
  })
  await expect
    .poll(async () => {
      const response = (await popup.evaluate(() =>
        chrome.runtime.sendMessage({ type: 'GET_ACTIVITY' })
      )) as { result?: { items?: Array<{ id?: string }> } }
      return response.result?.items?.find(item => item.id === prepared.result.graph.root.id)
    })
    .toBeUndefined()
  const pendingKeys = await popup.evaluate(async () => {
    return Object.keys(await chrome.storage.session.get(null)).filter(key =>
      key.startsWith('evm_pending_transfer:')
    )
  })
  expect(pendingKeys).toEqual([])
})

test('retries the exact signed transaction from Activity after an interrupted broadcast', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)

  const submittedRawTransactions: string[] = []
  let transactionHash: Hex | null = null

  await context.route(SEPOLIA_RPC_URL, async route => {
    const request = route.request().postDataJSON() as {
      id: number
      method: string
      params: readonly unknown[]
    }
    let result: unknown
    switch (request.method) {
      case 'eth_chainId':
        result = '0xaa36a7'
        break
      case 'eth_getBalance':
        result = '0xde0b6b3a7640000'
        break
      case 'eth_getTransactionCount':
        result = '0x0'
        break
      case 'eth_call':
        result = '0x'
        break
      case 'eth_estimateGas':
        result = '0x5208'
        break
      case 'eth_maxPriorityFeePerGas':
        result = '0x3b9aca00'
        break
      case 'eth_getBlockByNumber':
        result = { number: '0x101', baseFeePerGas: '0x3b9aca00' }
        break
      case 'eth_sendRawTransaction': {
        const rawTransaction = request.params[0] as Hex
        submittedRawTransactions.push(rawTransaction)
        transactionHash = keccak256(rawTransaction)
        if (submittedRawTransactions.length === 1) {
          await route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              error: { code: -32000, message: 'temporary transport failure' }
            })
          })
          return
        }
        result = transactionHash
        break
      }
      case 'eth_getTransactionByHash':
        result =
          submittedRawTransactions.length > 1 && transactionHash
            ? { hash: transactionHash, blockHash: null, blockNumber: null }
            : null
        break
      case 'eth_getTransactionReceipt':
        result = null
        break
      default:
        result = null
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id: request.id, result })
    })
  })

  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 30_000 })
  await popup.getByRole('button', { name: 'Send', exact: true }).click()
  await popup.getByRole('button', { name: 'Send ETH on Ethereum Sepolia' }).click()
  await popup.getByLabel('Send To').fill(RECIPIENT)
  const longAmount = '0.123456789012345678'
  await popup.getByLabel('ETH amount').fill(longAmount)
  await popup.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Review Send' })).toBeVisible({
    timeout: 30_000
  })
  const reviewDialog = popup.getByRole('dialog', { name: 'Review Send' })
  const reviewAmount = reviewDialog
    .getByRole('button', { name: 'Show full ETH amount' })
    .filter({ hasText: '0.12345678… ETH' })
  await expect(reviewAmount).toContainText('0.12345678… ETH')
  await reviewAmount.click()
  await expect(popup.getByText(`${longAmount} ETH`, { exact: true })).toBeVisible()
  await reviewAmount.click()
  await expect
    .poll(() =>
      reviewDialog.evaluate(element => ({
        viewportWidth: document.documentElement.clientWidth,
        contentWidth: document.documentElement.scrollWidth,
        dialogOverflow: element.scrollWidth - element.clientWidth
      }))
    )
    .toEqual({ viewportWidth: 375, contentWidth: 375, dialogOverflow: 0 })
  await popup.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(popup.getByText('Broadcast Interrupted', { exact: true })).toBeVisible({
    timeout: 30_000
  })
  await expect(popup.getByText(longAmount, { exact: true })).toBeVisible()
  expect(submittedRawTransactions).toHaveLength(1)

  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 30_000 })
  await popup.getByRole('tab', { name: 'Activity' }).click()
  await expect(popup.locator('[data-activity-status="signed"]')).toHaveCount(1)
  await popup.getByRole('button', { name: 'View Sent ETH details' }).click()
  const detail = popup.locator('[data-activity-detail-id]')
  await expect(detail.getByRole('button', { name: 'Retry broadcast' })).toBeVisible()
  await detail.getByRole('button', { name: 'Retry broadcast' }).click()
  await expect(
    detail.getByText('Broadcast submitted. Background monitoring will continue.', { exact: true })
  ).toBeVisible()
  await expect(detail.getByText('Submitted', { exact: true })).toBeVisible()
  await expect(detail.getByText('Transaction progress', { exact: true })).toHaveCount(0)
  await expect(detail.locator('[data-activity-segment-status="broadcast"]')).toHaveCount(0)
  await expect(detail.getByRole('button', { name: 'Retry broadcast' })).toHaveCount(0)
  expect(submittedRawTransactions).toHaveLength(2)
  expect(submittedRawTransactions[1]).toBe(submittedRawTransactions[0])

  await expect(detail.getByRole('button', { name: 'Cancel transaction' })).toBeVisible()
  await detail.getByRole('button', { name: 'Cancel transaction' }).click()
  const cancelDialog = popup.getByRole('dialog', { name: 'Cancel transaction' }).last()
  await expect(cancelDialog.getByText('Nonce', { exact: true })).toBeVisible()
  await expect(cancelDialog.getByText('Max fee per gas', { exact: true })).toBeVisible()
  await expect(cancelDialog.getByText('Priority fee per gas', { exact: true })).toBeVisible()
  await expect(cancelDialog.getByText('GWEI', { exact: false })).toHaveCount(2)
  await captureScreenshot(popup, 'noir-v2-pending-cancel-review.png')
  await cancelDialog.getByRole('button', { name: 'Confirm cancel', exact: true }).click()
  await expect(popup.getByText('Cancellation submitted', { exact: true })).toBeVisible()
  expect(submittedRawTransactions).toHaveLength(3)
  const originalTransaction = parseTransaction(submittedRawTransactions[0])
  const cancellationTransaction = parseTransaction(submittedRawTransactions[2])
  expect(cancellationTransaction.nonce).toBe(originalTransaction.nonce)
  expect(cancellationTransaction.value ?? 0n).toBe(0n)
  expect(cancellationTransaction.maxFeePerGas).toBeGreaterThan(
    originalTransaction.maxFeePerGas ?? 0n
  )
  expect(cancellationTransaction.maxPriorityFeePerGas).toBeGreaterThan(
    originalTransaction.maxPriorityFeePerGas ?? 0n
  )

  const activity = (await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'GET_ACTIVITY' })
  )) as { result: { items: Array<{ status: string }> } }
  expect(activity.result.items).toEqual(
    expect.arrayContaining([expect.objectContaining({ status: 'broadcast' })])
  )
  await expect
    .poll(() =>
      popup.getByRole('dialog').evaluate(element => ({
        viewportWidth: document.documentElement.clientWidth,
        contentWidth: document.documentElement.scrollWidth,
        dialogOverflow: element.scrollWidth - element.clientWidth
      }))
    )
    .toEqual({ viewportWidth: 375, contentWidth: 375, dialogOverflow: 0 })
})

test('recovers a missing Sepolia nonce in Activity before allowing another transfer', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(240_000)

  let pendingNonce = 21
  let recoveryReceiptReady = false
  let receiptQueriesAfterReady = 0
  let nonceRpcAvailable = true
  let failedNonceChecks = 0
  const rawTransactions: Hex[] = []
  const handleSepoliaRpc = async (route: Route) => {
    const request = route.request().postDataJSON() as {
      id: number
      method: string
      params: readonly unknown[]
    }
    if (!nonceRpcAvailable && request.method === 'eth_chainId') {
      failedNonceChecks += 1
      await route.fulfill({ status: 503, body: 'Unavailable' })
      return
    }
    const hash = request.params[0] as string | undefined
    const recoveryHash = rawTransactions[1] ? keccak256(rawTransactions[1]) : null
    let result: unknown = null
    switch (request.method) {
      case 'eth_chainId':
        result = '0xaa36a7'
        break
      case 'eth_getBalance':
        result = '0xde0b6b3a7640000'
        break
      case 'eth_getTransactionCount':
        result = `0x${pendingNonce.toString(16)}`
        break
      case 'eth_call':
        result = '0x'
        break
      case 'eth_estimateGas':
        result = '0x5208'
        break
      case 'eth_maxPriorityFeePerGas':
        result = '0x3b9aca00'
        break
      case 'eth_getBlockByNumber':
        result = { number: '0x101', baseFeePerGas: '0x3b9aca00' }
        break
      case 'eth_sendRawTransaction': {
        const raw = request.params[0] as Hex
        rawTransactions.push(raw)
        result = keccak256(raw)
        break
      }
      case 'eth_getTransactionByHash':
        result =
          hash === recoveryHash
            ? {
                hash,
                blockHash: recoveryReceiptReady ? `0x${'b'.repeat(64)}` : null,
                blockNumber: recoveryReceiptReady ? '0x101' : null
              }
            : null
        break
      case 'eth_getTransactionReceipt':
        if (recoveryReceiptReady) receiptQueriesAfterReady += 1
        result =
          recoveryReceiptReady && hash === recoveryHash
            ? {
                transactionHash: hash,
                blockHash: `0x${'b'.repeat(64)}`,
                blockNumber: '0x101',
                status: '0x1'
              }
            : null
        break
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id: request.id, result })
    })
  }
  await context.route(SEPOLIA_RPC_URL, handleSepoliaRpc)
  await context.route('https://public.1rpc.io/sepolia**', handleSepoliaRpc)

  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 30_000 })
  const original = (await popup.evaluate(
    intent => chrome.runtime.sendMessage({ type: 'PREPARE_EVM_TRANSFER', intent }),
    {
      assetId: ETH_ASSET_ID,
      recipient: RECIPIENT,
      amountRaw: '1000000000000000'
    }
  )) as {
    result?: {
      graph: { root: { id: string; intent: { sender: { address: string } } } }
      review: { payloadFingerprint: { digestHex: string } }
    }
  }
  expect(original.result).toBeDefined()
  if (!original.result) throw new Error('EVM fixture was not prepared')
  const originalSubmission = await popup.evaluate(
    ({ transactionId, payloadFingerprint }) =>
      chrome.runtime.sendMessage({
        type: 'APPROVE_EVM_TRANSFER',
        transactionId,
        payloadFingerprint
      }),
    {
      transactionId: original.result.graph.root.id,
      payloadFingerprint: original.result.review.payloadFingerprint.digestHex
    }
  )
  expect(originalSubmission).toMatchObject({ result: { status: 'broadcast' } })
  expect(parseTransaction(rawTransactions[0]).nonce).toBe(21)

  pendingNonce = 9
  const blockedUsdc = await popup.evaluate(
    intent => chrome.runtime.sendMessage({ type: 'PREPARE_EVM_TRANSFER', intent }),
    {
      assetId: USDC_ASSET_ID,
      recipient: RECIPIENT,
      amountRaw: '500000'
    }
  )
  expect(blockedUsdc).toMatchObject({ error: { code: 'nonce-recovery-required' } })
  expect(rawTransactions).toHaveLength(1)
  const recoveryState = await popup.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'GET_EVM_NONCE_RECOVERY',
      chainId: 'eip155:11155111',
      executionMode: 'main'
    })
  )
  expect(recoveryState).toMatchObject({
    result: {
      pendingNonce: '9',
      highestLocalNonce: '21',
      action: 'fill-gap'
    }
  })

  nonceRpcAvailable = false
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await popup.getByRole('tab', { name: 'Activity' }).click()
  const banner = popup.getByLabel('EVM nonce recovery')
  await expect.poll(() => failedNonceChecks, { timeout: 30_000 }).toBeGreaterThanOrEqual(2)
  await expect(banner).toHaveCount(0)
  await expect(popup.getByText('Unable to check the current nonce')).toHaveCount(0)
  nonceRpcAvailable = true
  await expect(banner.getByText('New sends paused')).toBeVisible({ timeout: 45_000 })
  await expect(banner).not.toContainText('Pending nonce 9')
  await captureScreenshot(popup, 'evm-nonce-recovery-activity.png')
  await banner.getByRole('button', { name: 'Review' }).click()
  await expect(banner.getByLabel('Network fee')).toBeVisible()
  await captureScreenshot(popup, 'evm-nonce-recovery-options.png')
  await banner.getByRole('button', { name: 'Continue' }).click()
  const review = popup.getByRole('dialog', { name: 'Review recovery transaction' })
  await expect(review).toContainText('Nonce')
  await expect(review).toContainText('9')
  await expect(review).toContainText('Maximum network fee')
  await captureScreenshot(popup, 'evm-nonce-recovery-review.png')
  await review.getByRole('button', { name: 'Confirm' }).click()
  await expect(banner.getByText('Clearing transaction')).toBeVisible({
    timeout: 30_000
  })
  expect(rawTransactions).toHaveLength(2)
  const recovery = parseTransaction(rawTransactions[1])
  expect(recovery.nonce).toBe(9)
  expect(recovery.value ?? 0n).toBe(0n)
  expect(recovery.to?.toLowerCase()).toBe(
    original.result.graph.root.intent.sender.address.toLowerCase()
  )
  expect(recovery.maxFeePerGas).toBeGreaterThan(0n)
  await expect(banner.getByRole('button', { name: 'Review' })).toHaveCount(0)

  pendingNonce = 10
  const waitingForReceipt = await popup.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'GET_EVM_NONCE_RECOVERY',
      chainId: 'eip155:11155111',
      executionMode: 'main'
    })
  )
  expect(waitingForReceipt).toMatchObject({
    result: {
      pendingNonce: '10',
      action: 'await-confirmation'
    }
  })
  const prematureUsdc = await popup.evaluate(
    intent => chrome.runtime.sendMessage({ type: 'PREPARE_EVM_TRANSFER', intent }),
    {
      assetId: USDC_ASSET_ID,
      recipient: RECIPIENT,
      amountRaw: '500000'
    }
  )
  expect(prematureUsdc).toMatchObject({ error: { code: 'nonce-recovery-required' } })
  recoveryReceiptReady = true
  await expect.poll(() => receiptQueriesAfterReady, { timeout: 50_000 }).toBeGreaterThan(0)
  await expect
    .poll(
      async () => {
        const activity = await popup.evaluate(() =>
          chrome.runtime.sendMessage({ type: 'GET_ACTIVITY' })
        )
        return (
          activity as { result?: { items?: Array<{ kind: string; status: string }> } }
        ).result?.items?.find(item => item.kind === 'cancel')?.status
      },
      { timeout: 30_000 }
    )
    .toBe('final')
  await expect(banner.getByText('New sends paused')).toBeVisible({ timeout: 70_000 })
  await expect(banner.getByRole('button', { name: 'Review' })).toBeVisible()
})

test('prepares, signs, broadcasts, monitors, and records a Sepolia transfer in real MV3', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)

  let signedRawTransaction: string | null = null
  let transactionHash: string | null = null
  let finalizedBlockNumber = '0x100'
  let simulatePendingReorg = false
  const rpcMethods: string[] = []
  const historyRequests: string[] = []
  const ankrRequests: Array<{ method: string; address: string; blockchains: string[] }> = []
  const unexpectedHistoryProxyRequests: string[] = []

  context.on('request', request => {
    const requestUrl = request.url()
    const url = new URL(requestUrl)
    if (
      EVM_HISTORY_PROXY_ORIGINS.has(url.origin) &&
      /^\/(?:bitcoin|solana|near|evm)(?:\/|$)/.test(url.pathname)
    ) {
      unexpectedHistoryProxyRequests.push(requestUrl)
    }
    if (
      EVM_HISTORY_PROXY_ORIGINS.has(url.origin) &&
      url.pathname === '/' &&
      request.method() === 'POST'
    ) {
      const body = request.postDataJSON() as {
        method: string
        params: { address: string | string[]; blockchain: string[] }
      }
      ankrRequests.push({
        method: body.method,
        address: Array.isArray(body.params.address) ? body.params.address[0] : body.params.address,
        blockchains: body.params.blockchain
      })
    }
    if (EVM_HISTORY_URLS.some(pattern => requestUrl.startsWith(pattern.slice(0, -3)))) {
      historyRequests.push(requestUrl)
    }
  })

  await context.route(SEPOLIA_RPC_URL, async route => {
    const request = route.request().postDataJSON() as {
      id: number
      method: string
      params: readonly unknown[]
    }
    rpcMethods.push(request.method)

    let result: unknown
    switch (request.method) {
      case 'eth_chainId':
        result = '0xaa36a7'
        break
      case 'eth_getBalance':
        result = '0xde0b6b3a7640000'
        break
      case 'eth_getTransactionCount':
        result = '0x0'
        break
      case 'eth_call':
        {
          const call = request.params[0] as { data?: string }
          if (call.data?.startsWith('0x70a08231')) {
            result = `0x${1_000_000n.toString(16).padStart(64, '0')}`
          } else if (call.data?.startsWith('0xa9059cbb')) {
            result = `0x${'0'.repeat(63)}1`
          } else {
            result = '0x'
          }
        }
        break
      case 'eth_estimateGas':
        result = '0x5208'
        break
      case 'eth_maxPriorityFeePerGas':
        result = '0x3b9aca00'
        break
      case 'eth_getBlockByNumber':
        result =
          request.params[0] === 'finalized'
            ? { number: finalizedBlockNumber }
            : { number: '0x101', baseFeePerGas: '0x3b9aca00' }
        break
      case 'eth_sendRawTransaction':
        signedRawTransaction = request.params[0] as string
        result = `0x${'f'.repeat(64)}`
        break
      case 'eth_getTransactionByHash':
        transactionHash = request.params[0] as string
        result = simulatePendingReorg
          ? { hash: transactionHash, blockHash: null, blockNumber: null }
          : {
              hash: transactionHash,
              blockHash: `0x${'b'.repeat(64)}`,
              blockNumber: '0x101'
            }
        break
      case 'eth_getTransactionReceipt':
        result =
          transactionHash && !simulatePendingReorg
            ? {
                transactionHash,
                blockHash: `0x${'b'.repeat(64)}`,
                blockNumber: '0x101',
                status: '0x1'
              }
            : null
        break
      default:
        result = null
    }

    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id: request.id, result })
    })
  })

  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await seedFreshAssetPrices(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 30_000 })
  await expect(popup.getByText('ETH', { exact: true }).first()).toBeVisible({ timeout: 30_000 })
  await expect(popup.getByText('USDC', { exact: true }).first()).toBeVisible({ timeout: 30_000 })
  await expect(popup.getByAltText('ETH', { exact: true }).first()).toBeVisible()
  await expect(popup.getByAltText('USDC', { exact: true }).first()).toBeVisible()
  await expect(
    popup.getByRole('button', { name: 'View ETH details on Ethereum Sepolia' })
  ).toContainText('+1.25%')
  const usdcAsset = popup.getByRole('button', {
    name: 'View USDC details on Ethereum Sepolia'
  })
  await expect(usdcAsset).toContainText('$2')
  await expect(usdcAsset).not.toContainText(/\d+ Networks?/)
  await expect(popup.getByText('Total Assets', { exact: true })).toBeVisible()
  await expect(popup.getByText('Known Assets Value', { exact: true })).toHaveCount(0)
  await expect(popup.getByText('Zcash Value', { exact: true })).toHaveCount(0)
  const homeActions = popup.getByTestId('home-actions')
  await expect(homeActions).toHaveAttribute('data-layout', 'centered')
  const [actionsBounds, sendBounds, receiveBounds] = await Promise.all([
    homeActions.boundingBox(),
    homeActions.getByRole('button', { name: 'Send', exact: true }).boundingBox(),
    homeActions.getByRole('button', { name: 'Receive', exact: true }).boundingBox()
  ])
  if (!actionsBounds || !sendBounds || !receiveBounds) {
    throw new Error('Testnet action buttons are not visible')
  }
  const actionsCenter = (sendBounds.x + receiveBounds.x + receiveBounds.width) / 2
  const containerCenter = actionsBounds.x + actionsBounds.width / 2
  expect(Math.abs(actionsCenter - containerCenter)).toBeLessThanOrEqual(1)
  await expect(popup.locator('body')).toHaveCSS('width', '375px')
  await expect
    .poll(() =>
      popup.evaluate(() => ({
        viewportWidth: document.documentElement.clientWidth,
        contentWidth: document.documentElement.scrollWidth
      }))
    )
    .toEqual({ viewportWidth: 375, contentWidth: 375 })
  await popup.mouse.move(374, 1)
  await captureScreenshot(popup, 'evm-testnet-portfolio-home.png')

  await popup
    .getByRole('button', { name: /total assets .*show Public and Confidential totals$/i })
    .hover()
  const totalBalanceTooltip = popup.locator(
    '[data-slot="tooltip-content"]:not([data-state="closed"])'
  )
  await expect(totalBalanceTooltip).toContainText('Public')
  await expect(totalBalanceTooltip).toContainText('Confidential')
  await popup.mouse.move(374, 1)
  await popup.getByRole('button', { name: 'dApp address: Public' }).click()
  const addressTotalsDialog = popup.getByRole('dialog', { name: 'dApp address' })
  await expect(addressTotalsDialog.getByTestId('main-address-total')).toHaveText(/^\$/)
  await expect(addressTotalsDialog.getByTestId('private-address-total')).toHaveText(/^\$/)
  await captureScreenshot(popup, 'evm-testnet-private-defi-home-address-totals.png')
  await addressTotalsDialog.getByRole('button', { name: 'Close' }).click()

  const usdcBalanceTooltipTrigger = usdcAsset.locator('[data-slot="tooltip-trigger"]')
  await usdcBalanceTooltipTrigger.hover()
  const assetBalanceTooltip = popup.locator(
    '[data-slot="tooltip-content"]:not([data-state="closed"])'
  )
  await expect(assetBalanceTooltip).toContainText('Public')
  await expect(assetBalanceTooltip).toContainText('Confidential')
  await captureScreenshot(popup, 'private-defi-home-asset-balance-breakdown.png', {
    preservePointer: true
  })
  await popup.mouse.move(374, 1)

  await popup.getByRole('tab', { name: 'Activity' }).click()
  await expect(popup.getByRole('region', { name: 'Multichain activity' })).toBeVisible()
  const activityFilter = popup.getByRole('button', {
    name: 'Filter activity by network: All Networks'
  })
  await expect(activityFilter).toBeVisible()
  await expect(popup.getByText(/EVM activity shows transactions submitted/)).toHaveCount(0)
  await activityFilter.click()
  await popup.getByRole('menuitemradio', { name: 'Ethereum Sepolia', exact: true }).click()
  await expect(
    popup.getByRole('button', { name: 'Filter activity by network: Ethereum Sepolia' })
  ).toBeVisible()
  await expect(popup.getByRole('group', { name: 'Filter activity by account mode' })).toHaveCount(0)
  await expect(popup.getByRole('link', { name: 'Full history' })).toHaveAttribute(
    'href',
    /^https:\/\/sepolia\.etherscan\.io\/address\/0x[0-9a-fA-F]{40}$/
  )
  await expect(popup.getByText('No activity yet', { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(
    popup.getByText(/Showing recent activity only|Use Full history for older/)
  ).toHaveCount(0)
  const parsedHistoryRequests = historyRequests.map(requestUrl => {
    const url = new URL(requestUrl)
    return {
      origin: url.origin,
      action: url.searchParams.get('action'),
      address: url.searchParams.get('address'),
      page: url.searchParams.get('page'),
      offset: url.searchParams.get('offset'),
      sort: url.searchParams.get('sort')
    }
  })
  const expectedHistoryQueries = ['https://arbitrum-sepolia.blockscout.com'].flatMap(origin =>
    ['tokentx', 'txlist'].map(action => ({
      origin,
      action,
      page: '1',
      offset: '200',
      sort: 'desc'
    }))
  )
  expect(ankrRequests).toHaveLength(4)
  expect(unexpectedHistoryProxyRequests).toEqual([])
  expect(new Set(ankrRequests.map(request => request.address)).size).toBe(2)
  for (const request of ankrRequests) {
    expect(request.blockchains.slice().sort()).toEqual([
      'avalanche_fuji',
      'base_sepolia',
      'eth_sepolia',
      'optimism_sepolia',
      'polygon_amoy'
    ])
    expect(['ankr_getTransactionsByAddress', 'ankr_getTokenTransfers']).toContain(request.method)
  }
  const historyAddresses = [...new Set(parsedHistoryRequests.map(request => request.address))]
  expect(historyAddresses).toHaveLength(2)
  for (const address of historyAddresses) {
    expect(
      [
        ...new Map(
          parsedHistoryRequests
            .filter(request => request.address === address)
            .map(
              ({ address: _address, ...request }) =>
                [`${request.origin}:${request.action}`, request] as const
            )
        ).values()
      ].sort((left, right) =>
        `${left.origin}:${left.action}`.localeCompare(`${right.origin}:${right.action}`)
      )
    ).toEqual(expectedHistoryQueries)
  }
  await popup.mouse.move(374, 1)
  await captureScreenshot(popup, 'evm-testnet-activity-empty.png')
  await popup.getByRole('tab', { name: 'Assets' }).click()

  await usdcAsset.click()
  await expect(popup.getByRole('heading', { name: 'USDC', exact: true })).toBeVisible()
  await expect(popup.getByText('2 USDC', { exact: true }).first()).toBeVisible()
  const recentActivity = popup.getByRole('heading', { name: 'Recent activity' })
  await recentActivity.scrollIntoViewIfNeeded()
  await expect(recentActivity).toBeVisible()
  await expect(popup.locator(`[title="${USDC_CONTRACT}"]`)).toBeVisible()
  await expect(popup.getByRole('link', { name: 'View on explorer' })).toHaveAttribute(
    'href',
    `${SEPOLIA_EXPLORER_URL}/token/${USDC_CONTRACT.toLowerCase()}`
  )
  await popup.getByRole('button', { name: 'Copy contract address' }).click()
  await expect(popup.getByText('Copied!', { exact: true })).toBeVisible()
  const assetDetailContent = popup.locator('.page-content')
  await expect(assetDetailContent).toBeVisible()
  expect(
    await assetDetailContent.evaluate(element => element.scrollHeight > element.clientHeight)
  ).toBe(true)
  await assetDetailContent.hover()
  await popup.mouse.wheel(0, 600)
  await expect
    .poll(() => assetDetailContent.evaluate(element => element.scrollTop))
    .toBeGreaterThan(0)
  await assetDetailContent.evaluate(element => {
    element.scrollTop = 0
  })
  await expect(popup.getByText('Copied!', { exact: true })).toBeHidden({ timeout: 5_000 })
  await captureScreenshot(popup, 'evm-testnet-asset-detail.png')
  const accountBalanceBreakdown = popup.getByRole('region', {
    name: 'Public and Confidential balance breakdown'
  })
  await accountBalanceBreakdown.scrollIntoViewIfNeeded()
  await expect(accountBalanceBreakdown).toContainText('Total')
  await expect(accountBalanceBreakdown).toContainText('Public')
  await expect(accountBalanceBreakdown).toContainText('Confidential')
  await captureScreenshot(popup, 'private-defi-token-balance-breakdown.png')
  await assetDetailContent.evaluate(element => {
    element.scrollTop = 0
  })

  await popup.getByRole('button', { name: 'Receive', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Addresses' })).toBeVisible()
  await expect(
    popup
      .getByRole('region', { name: 'Account network addresses' })
      .getByRole('heading', { name: 'Ethereum Sepolia', exact: true })
  ).toBeVisible()
  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByRole('heading', { name: 'USDC', exact: true })).toBeVisible()

  await popup.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(popup.getByLabel('USDC amount')).toBeVisible()
  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByLabel('Search your assets')).toBeVisible()
  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByRole('heading', { name: 'USDC', exact: true })).toBeVisible()
  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible()

  await popup.getByRole('button', { name: 'Show chain view' }).click()
  await expect(popup.getByRole('button', { name: 'Show chain view' })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(popup.getByRole('region', { name: 'Ethereum Sepolia portfolio' })).toBeVisible()
  await popup.getByRole('button', { name: 'Expand Ethereum Sepolia tokens' }).click()
  await expect(popup.getByRole('region', { name: 'Ethereum Sepolia token balances' })).toBeVisible()
  await expect
    .poll(() =>
      popup.evaluate(() => ({
        viewportWidth: document.documentElement.clientWidth,
        contentWidth: document.documentElement.scrollWidth
      }))
    )
    .toEqual({ viewportWidth: 375, contentWidth: 375 })
  await popup.getByRole('button', { name: 'Show token view' }).click()
  await expect(popup.getByRole('button', { name: 'Show token view' })).toHaveAttribute(
    'aria-pressed',
    'true'
  )

  await popup.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(popup.getByLabel('Search your assets')).toBeVisible()
  await expect(popup.getByRole('button', { name: 'All Networks' })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Send ZEC on Zcash Testnet' })).toBeVisible()
  await popup.mouse.move(374, 1)
  await captureScreenshot(popup, 'evm-testnet-send-assets.png')

  await popup.getByRole('button', { name: 'Send ZEC on Zcash Testnet' }).click()
  await expect(popup.getByTestId('send-asset-header')).toContainText('Zcash Testnet')
  const memoToggle = popup.getByRole('button', { name: 'Memo (optional)' })
  await expect(memoToggle).toBeVisible()
  await expect(popup.getByTestId('send-network-fee')).toContainText('ZEC')
  await expect(popup.getByRole('button', { name: 'Continue', exact: true })).toBeVisible()
  await captureScreenshot(popup, 'zcash-testnet-send-form.png')
  await memoToggle.click()
  await expect(popup.getByLabel('Memo (optional)')).toBeVisible()
  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByLabel('Search your assets')).toBeVisible()

  await popup.getByRole('button', { name: 'Send USDC on Ethereum Sepolia' }).click()
  await expect(popup.getByTestId('send-asset-header')).toContainText('USDC')
  await expect(popup.getByTestId('send-asset-header')).toContainText('Ethereum Sepolia')
  await popup.getByLabel('Send To').fill(RECIPIENT)
  await popup.getByLabel('USDC amount').fill('0.5')
  await expect(popup.getByTestId('send-network-fee')).toContainText('0.0000756 ETH', {
    timeout: 30_000
  })
  await expect(popup.getByTestId('send-network-fee')).toContainText('Standard')
  await popup
    .getByTestId('send-network-fee')
    .getByRole('button', { name: 'Edit network fee' })
    .click()
  const feeSettings = popup.getByRole('dialog', { name: 'Network Fee' })
  await feeSettings.getByLabel('Custom priority fee').fill('2.5')
  await captureScreenshot(popup, 'noir-v2-custom-priority-fee.png')
  await feeSettings.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(popup.getByTestId('send-network-fee')).toContainText('Custom')
  await expect(popup.getByTestId('send-network-fee')).not.toContainText('—', {
    timeout: 30_000
  })
  await popup.getByRole('button', { name: 'Continue', exact: true }).click()
  const reviewDialog = popup.getByRole('dialog', { name: 'Review Send' })
  await expect(reviewDialog.getByRole('heading', { name: 'Review Send' })).toBeVisible({
    timeout: 30_000
  })
  await expect(reviewDialog.getByRole('button', { name: 'Show full USDC amount' })).toHaveText(
    '0.5 USDC'
  )
  await expect(popup.getByText('Token transfer', { exact: true })).toBeVisible()
  await expect(
    popup.getByText('This token transfer calls the bundled USDC contract.', { exact: true })
  ).toHaveCount(0)
  await expect(reviewDialog.getByText('Max fee per gas', { exact: true })).toBeVisible()
  await expect(reviewDialog.getByText('4.5 GWEI', { exact: true })).toBeVisible()
  await expect(reviewDialog.getByText('Priority fee per gas', { exact: true })).toBeVisible()
  await expect(reviewDialog.getByText('2.5 GWEI', { exact: true })).toBeVisible()
  await waitForDialogAnimations(popup)
  await popup.mouse.move(374, 1)
  await captureScreenshot(popup, 'noir-v2-custom-gwei-review.png')
  await reviewDialog.getByRole('button', { name: /ETH.*Custom/i }).click()
  await popup
    .getByRole('dialog', { name: 'Network Fee' })
    .getByRole('radio', { name: /Standard/ })
    .click()
  await expect(reviewDialog.getByRole('button', { name: /ETH.*Standard/i })).toBeVisible({
    timeout: 30_000
  })
  await popup.getByRole('button', { name: 'Cancel', exact: true }).click()
  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByLabel('Search your assets')).toBeVisible()

  await popup.getByRole('button', { name: 'Send ETH on Ethereum Sepolia' }).click()
  await expect(popup.getByRole('button', { name: 'Change asset' })).toHaveCount(0)
  await popup.getByLabel('Send To').fill(RECIPIENT)
  const sendAmountCard = popup.getByTestId('send-amount-card')
  await sendAmountCard.getByRole('button', { name: 'Max' }).click()
  await expect(sendAmountCard).toContainText('Available', { timeout: 30_000 })
  await popup.getByLabel('ETH amount').fill('0.001')
  await expect(popup.getByTestId('send-network-fee')).toContainText('0.000063 ETH', {
    timeout: 30_000
  })
  await expect(popup.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled()
  await popup.mouse.move(374, 1)
  await captureScreenshot(popup, 'evm-testnet-send-form.png')
  await popup.getByRole('button', { name: 'Continue', exact: true }).click()

  await expect(reviewDialog.getByRole('heading', { name: 'Review Send' })).toBeVisible({
    timeout: 30_000
  })
  await expect(sendAmountCard).toContainText('Available')
  await expect(
    reviewDialog
      .getByRole('button', { name: 'Show full ETH amount' })
      .filter({ hasText: '0.001 ETH' })
  ).toBeVisible()
  await expect(reviewDialog.getByText('Network fee', { exact: true })).toBeVisible()
  await expect(popup.getByText('Native transfer', { exact: true })).toBeVisible()
  await expect(popup.getByText(/slippage/i)).toHaveCount(0)
  await expect(popup.getByText(/estimated time/i)).toHaveCount(0)
  await waitForDialogAnimations(popup)
  await popup.mouse.move(374, 1)
  await captureScreenshot(popup, 'evm-testnet-send-review.png')

  await popup.getByRole('button', { name: 'Send', exact: true }).click()
  const approvalOutcome = await Promise.race([
    popup
      .getByText('Transaction Submitted', { exact: true })
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => 'broadcast' as const),
    popup
      .locator('[role="alert"]')
      .filter({ hasText: 'The transfer could not be prepared' })
      .waitFor({ state: 'attached', timeout: 30_000 })
      .then(() => 'failed' as const)
  ])
  if (approvalOutcome === 'failed') {
    const activity = (await popup.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'GET_ACTIVITY' })
    )) as {
      result?: {
        items?: Array<{
          status?: string
          failureCode?: string
          snapshot?: { primaryAmount?: { assetId?: string; amountRaw?: string } }
        }>
      }
    }
    const failedTransfer = activity.result?.items?.find(
      item =>
        item.snapshot?.primaryAmount?.assetId === ETH_ASSET_ID &&
        item.snapshot.primaryAmount.amountRaw === '1000000000000000'
    )
    throw new Error(
      `EVM approval failed with status ${failedTransfer?.status ?? 'missing'} and code ${failedTransfer?.failureCode ?? 'missing'}`
    )
  }
  await expect(popup.locator('[data-transaction-status="broadcast"]')).toBeVisible()
  await expect(popup.getByRole('link', { name: 'View on Explorer', exact: true })).toBeVisible()
  await expect(popup.locator('[data-result-icon] svg')).toBeVisible()
  await expect(popup.locator('[data-result-icon] svg path')).toHaveCount(1)
  await expectResultContentFits(popup)
  await popup.mouse.move(374, 1)
  await captureScreenshot(popup, 'evm-testnet-transaction-broadcast.png')

  expect(signedRawTransaction).toMatch(/^0x02[0-9a-f]+$/)
  expect(transactionHash).toMatch(/^0x[0-9a-f]{64}$/)

  const broadcastActivity = (await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'GET_ACTIVITY' })
  )) as {
    result: {
      items: Array<{
        id: string
        scope: { keyDomainId: string; accountId: string }
        snapshot?: { primaryAmount?: { assetId: string; amountRaw: string } }
      }>
    }
  }
  const result = broadcastActivity.result.items.find(
    item => item.snapshot?.primaryAmount?.assetId === ETH_ASSET_ID
  )
  expect(result).toBeTruthy()
  if (!result) throw new Error('Broadcast EVM transaction was not recorded in Activity')

  const poll = () =>
    popup.evaluate(
      scope =>
        chrome.runtime.sendMessage({
          type: 'WORKER_RPC',
          method: 'evm.conformance-poll',
          payload: { scopes: [scope] }
        }),
      result.scope
    )
  const pollAndReadTransaction = async () => {
    await poll()
    const activity = (await popup.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'GET_ACTIVITY' })
    )) as {
      result?: {
        items?: Array<{ id: string; status: string; reconfirming?: true }>
      }
    }
    const item = activity.result?.items?.find(candidate => candidate.id === result.id)
    return {
      status: item?.status ?? 'missing',
      reconfirming: item?.reconfirming === true
    }
  }

  await expect.poll(pollAndReadTransaction, { timeout: 10_000 }).toEqual({
    status: 'final',
    reconfirming: false
  })
  await expect(popup.getByText('Transaction Confirmed', { exact: true })).toBeVisible({
    timeout: 10_000
  })
  await expect(popup.locator('[data-transaction-status="final"]')).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Done', exact: true })).toBeVisible()
  await expectResultContentFits(popup)
  await popup.mouse.move(374, 1)
  await captureScreenshot(popup, 'evm-testnet-transaction-final.png')

  const finalActivity = (await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'GET_ACTIVITY' })
  )) as {
    result: {
      items: Array<{
        id: string
        source: string
        status: string
        failureCode?: string
        snapshot?: { primaryAmount?: { assetId: string; amountRaw: string }; recipient?: unknown }
      }>
    }
  }
  expect(finalActivity.result.items.find(item => item.id === result.id)).toMatchObject({
    id: result.id,
    source: 'wallet-v2',
    status: 'final',
    snapshot: {
      primaryAmount: { assetId: ETH_ASSET_ID, amountRaw: '1000000000000000' },
      recipient: { chainId: 'eip155:11155111', address: RECIPIENT }
    }
  })
  expect(
    finalActivity.result.items.find(item => item.snapshot?.primaryAmount?.amountRaw === '500000')
  ).toBeUndefined()

  await popup.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 30_000 })
  const saveRecipientToast = popup.locator('[data-toast-variant="bottom-action"]')
  await expect(saveRecipientToast.getByText('Save recipient?', { exact: true })).toBeVisible()
  await expect(saveRecipientToast).toContainText('Ethereum Sepolia')
  await captureScreenshot(popup, 'evm-testnet-save-recipient-toast.png')
  await saveRecipientToast.getByRole('button', { name: 'Save', exact: true }).click()
  const saveContactDialog = popup.getByRole('dialog')
  await expect(
    saveContactDialog.getByRole('heading', { name: 'Save to Address Book' })
  ).toBeVisible()
  await expect(saveContactDialog.getByText('0x1111...111111', { exact: true })).toBeVisible()
  await saveContactDialog.getByLabel('Contact name').fill('Alice Sepolia')
  await captureScreenshot(popup, 'evm-testnet-save-recipient-name.png')
  await saveContactDialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(popup.getByText('Contact saved', { exact: true })).toBeVisible()
  await expect
    .poll(() =>
      popup.evaluate(async () => {
        const storage = await chrome.storage.local.get('address_book_v2')
        const envelope = JSON.parse(storage.address_book_v2 ?? '{}')
        const contact = envelope.state?.contacts?.[0]
        return contact
          ? { chainId: contact.chainId, address: contact.address, name: contact.name }
          : null
      })
    )
    .toEqual({
      chainId: 'eip155:11155111',
      address: RECIPIENT,
      name: 'Alice Sepolia'
    })

  await popup.getByRole('button', { name: 'Send', exact: true }).click()
  await popup.getByRole('button', { name: 'Send ETH on Ethereum Sepolia' }).click()
  await popup.getByRole('button', { name: 'Select Recipient' }).click()
  const recipientDialog = popup.getByRole('dialog')
  await expect(recipientDialog.getByRole('heading', { name: 'Select Recipient' })).toBeVisible()
  await expect(recipientDialog.getByRole('tab', { name: 'My Accounts' })).toBeVisible()
  await recipientDialog.getByRole('tab', { name: 'Address Book' }).click()
  await recipientDialog.getByRole('button').filter({ hasText: 'Alice Sepolia' }).click()
  await expect(popup.getByLabel('Send To')).toHaveValue(RECIPIENT)
  await popup.getByRole('button', { name: 'Back' }).click()
  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible()
  const assetsTab = popup.getByRole('tab', { name: 'Assets' })
  const activityTab = popup.getByRole('tab', { name: 'Activity' })
  await activityTab.click()
  await expect(activityTab).toHaveAttribute('data-state', 'active')
  await expect(assetsTab).toHaveAttribute('data-state', 'inactive')
  await expect
    .poll(() =>
      popup.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]'))
        const widths = Object.fromEntries(
          tabs.map(tab => [
            tab.textContent?.trim(),
            Number.parseFloat(getComputedStyle(tab, '::after').width)
          ])
        )
        return { assetsHidden: widths.Assets === 0, activityVisible: widths.Activity > 0 }
      })
    )
    .toEqual({ assetsHidden: true, activityVisible: true })
  await expect(popup.getByRole('region', { name: 'Multichain activity' })).toBeVisible()
  await expect(popup.getByText('Sent ETH', { exact: true })).toBeVisible()
  await expect(popup.getByText('Sent USDC', { exact: true })).toHaveCount(0)
  await expect(popup.locator('[data-activity-status="final"]')).toHaveCount(1)
  await expect(popup.locator('[data-activity-status="failed"]')).toHaveCount(0)
  await expect(popup.getByText('Cancelled', { exact: true })).toHaveCount(0)
  const ethActivityRow = popup.getByRole('button', { name: 'View Sent ETH details' })
  await expect(ethActivityRow.locator('[data-activity-avatar="token"]')).toBeVisible()
  await expect(ethActivityRow.locator('[data-activity-chain-badge]')).toBeVisible()
  await expect(
    ethActivityRow.getByText(`To: ${RECIPIENT.slice(0, 6)}...${RECIPIENT.slice(-6)}`, {
      exact: true
    })
  ).toBeVisible()
  await expect(ethActivityRow.getByText('−0.001 ETH', { exact: true })).toBeVisible()
  await expect
    .poll(() =>
      popup.evaluate(() => ({
        viewportWidth: document.documentElement.clientWidth,
        contentWidth: document.documentElement.scrollWidth
      }))
    )
    .toEqual({ viewportWidth: 375, contentWidth: 375 })
  await popup.mouse.move(374, 1)
  await captureScreenshot(popup, 'evm-testnet-activity.png')

  await ethActivityRow.click()
  await expect(popup.getByRole('dialog')).toBeVisible()
  await expect(popup.getByRole('heading', { name: 'Send', exact: true })).toBeVisible()
  const activityDetail = popup.locator(`[data-activity-detail-id="${result.id}"]`)
  await expect(activityDetail).toBeVisible()
  await expect(activityDetail.getByText('−0.001 ETH', { exact: true })).toBeVisible()
  const ethereumIcon = activityDetail.getByRole('img', { name: 'ETH' })
  await expect(ethereumIcon).toBeVisible()
  await expect(ethereumIcon).toHaveAttribute(
    'src',
    'https://assets-cdn.trustwallet.com/blockchains/ethereum/info/logo.png'
  )
  await expect
    .poll(() => ethereumIcon.evaluate(image => (image as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0)
  await expect(activityDetail.getByText('Ethereum Sepolia', { exact: true })).toHaveCount(1)
  await expect(activityDetail.getByText('Confirmed', { exact: true })).toBeVisible()
  await expect(activityDetail.getByText('From', { exact: true })).toBeVisible()
  await expect(activityDetail.getByText('To', { exact: true })).toBeVisible()
  await expect(activityDetail.getByText('Network fee', { exact: true })).toBeVisible()
  await expect(activityDetail.getByText(/0\.(?:000063|0₄63) ETH/)).toBeVisible()
  await expect(activityDetail.getByRole('button', { name: 'More details' })).toHaveCount(0)
  await expect(activityDetail.getByText('Transaction progress', { exact: true })).toHaveCount(0)
  await expect(activityDetail.locator('[data-activity-segment-status="final"]')).toHaveCount(0)
  if (!transactionHash) throw new Error('Canonical EVM transaction hash was not observed')
  await expect(
    activityDetail.locator('a[href^="https://sepolia.etherscan.io/tx/"]')
  ).toHaveAttribute('href', `https://sepolia.etherscan.io/tx/${transactionHash}`)
  await expect
    .poll(() =>
      popup.getByRole('dialog').evaluate(element => ({
        viewportWidth: document.documentElement.clientWidth,
        contentWidth: document.documentElement.scrollWidth,
        dialogOverflow: element.scrollWidth - element.clientWidth
      }))
    )
    .toEqual({ viewportWidth: 375, contentWidth: 375, dialogOverflow: 0 })
  await waitForDialogAnimations(popup)
  await popup.mouse.move(374, 1)
  await captureScreenshot(popup, 'evm-testnet-activity-detail-v1.png')
  await popup.getByRole('button', { name: 'Close' }).click()
  await expect(popup.getByRole('dialog')).toHaveCount(0)

  await popup.getByRole('button', { name: 'Settings', exact: true }).click()
  await popup.getByRole('button', { name: 'Address Book' }).click()
  await expect(popup.getByRole('heading', { name: 'Address Book' })).toBeVisible()
  await expect(popup.getByText('Alice Sepolia', { exact: true })).toBeVisible()
  await expect(popup.getByText('Ethereum Sepolia', { exact: true })).toBeVisible()
  await captureScreenshot(popup, 'evm-testnet-address-book.png')
  await popup.getByRole('button', { name: 'Rename Alice Sepolia' }).click()
  const renameDialog = popup.getByRole('dialog')
  await renameDialog.getByLabel('Contact name').fill('Alice')
  await renameDialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(popup.getByText('Alice', { exact: true })).toBeVisible()
  await popup.getByRole('button', { name: 'Delete Alice' }).click()
  const deleteDialog = popup.getByRole('dialog')
  await expect(deleteDialog.getByRole('heading', { name: 'Delete Contact?' })).toBeVisible()
  const deleteContactButton = deleteDialog.getByRole('button', { name: 'Delete', exact: true })
  await expect(deleteContactButton).toHaveAttribute('data-variant', 'destructive')
  await captureScreenshot(popup, 'evm-testnet-address-book-delete.png')
  await deleteContactButton.click()
  await expect(popup.getByText('No saved recipients', { exact: true })).toBeVisible()

  expect(rpcMethods).toEqual(
    expect.arrayContaining([
      'eth_chainId',
      'eth_getTransactionCount',
      'eth_call',
      'eth_estimateGas',
      'eth_maxPriorityFeePerGas',
      'eth_sendRawTransaction',
      'eth_getTransactionByHash',
      'eth_getTransactionReceipt'
    ])
  )
})

test('opens the recorded pending transfer on its explorer in real MV3', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(120_000)
  let transactionHash: Hex | null = null
  await context.route(SEPOLIA_RPC_URL, async route => {
    const request = route.request().postDataJSON() as {
      id: number
      method: string
      params: readonly unknown[]
    }
    let result: unknown = null
    switch (request.method) {
      case 'eth_chainId':
        result = '0xaa36a7'
        break
      case 'eth_getBalance':
        result = '0xde0b6b3a7640000'
        break
      case 'eth_getTransactionCount':
        result = '0x0'
        break
      case 'eth_call':
        result = '0x'
        break
      case 'eth_estimateGas':
        result = '0x5208'
        break
      case 'eth_maxPriorityFeePerGas':
        result = '0x3b9aca00'
        break
      case 'eth_getBlockByNumber':
        result = { number: '0x101', baseFeePerGas: '0x3b9aca00' }
        break
      case 'eth_sendRawTransaction':
        transactionHash = keccak256(request.params[0] as Hex)
        result = transactionHash
        break
      case 'eth_getTransactionByHash':
        result = transactionHash
          ? { hash: transactionHash, blockHash: null, blockNumber: null }
          : null
        break
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id: request.id, result })
    })
  })

  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await seedFreshAssetPrices(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 30_000 })
  await popup.getByRole('button', { name: 'Send', exact: true }).click()
  await popup.getByRole('button', { name: 'Send ETH on Ethereum Sepolia' }).click()
  await popup.getByLabel('Send To').fill(RECIPIENT)
  await popup.getByLabel('ETH amount').fill('0.001')
  await expect(popup.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled()
  await popup.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(popup.getByRole('dialog', { name: 'Review Send' })).toBeVisible()
  await popup.getByRole('button', { name: 'Send', exact: true }).click()
  const viewExplorer = popup.getByRole('link', { name: 'View on Explorer', exact: true })
  await expect(viewExplorer).toBeVisible({ timeout: 30_000 })
  const activity = (await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'GET_ACTIVITY' })
  )) as {
    result?: { items?: Array<{ id: string; snapshot?: { primaryAmount?: { amountRaw: string } } }> }
  }
  const recorded = activity.result?.items?.find(
    item => item.snapshot?.primaryAmount?.amountRaw === '1000000000000000'
  )
  expect(recorded).toBeTruthy()
  if (!recorded) throw new Error('Pending EVM transfer was not recorded')

  const expectedUrl = `${SEPOLIA_EXPLORER_URL}/tx/${transactionHash}`
  await expect(viewExplorer).toHaveAttribute('href', expectedUrl)
  await context.route(`${SEPOLIA_EXPLORER_URL}/tx/**`, route =>
    route.fulfill({ contentType: 'text/html', body: '<title>Transaction explorer</title>' })
  )
  const explorerPagePromise = context.waitForEvent('page')
  await viewExplorer.click()
  const explorerPage = await explorerPagePromise
  await explorerPage.waitForURL(expectedUrl)
  await expect(popup.locator('[data-transaction-status="broadcast"]')).toBeVisible()
  await explorerPage.close()
})

test('shows Main and Confidential indexed history together in Activity', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(120_000)
  const observedAddresses = new Set<string>()
  let historyUnavailable = false
  await context.route(SEPOLIA_RPC_URL, async route => {
    const request = route.request().postDataJSON() as { id: number; method: string }
    const result =
      request.method === 'eth_chainId'
        ? '0xaa36a7'
        : request.method === 'eth_getBalance'
          ? '0xde0b6b3a7640000'
          : request.method === 'eth_getBlockByNumber'
            ? { number: '0x101', baseFeePerGas: '0x3b9aca00' }
            : null
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id: request.id, result })
    })
  })
  await context.route(
    url => EVM_HISTORY_PROXY_ORIGINS.has(url.origin) && url.pathname === '/',
    async route => {
      if (historyUnavailable) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' })
        return
      }
      const body = route.request().postDataJSON() as {
        id: number | string
        method: string
        params: { address: string | string[]; blockchain: string[] }
      }
      const address = (
        Array.isArray(body.params.address) ? body.params.address[0] : body.params.address
      ).toLowerCase()
      const validAddress = /^0x[0-9a-f]{40}$/.test(address)
      if (validAddress) observedAddresses.add(address)
      const result =
        body.method === 'ankr_getTransactionsByAddress' &&
        validAddress &&
        body.params.blockchain.includes('eth_sepolia')
          ? [
              {
                hash: keccak256(address as Hex),
                blockHash: `0x${'b'.repeat(64)}`,
                blockchain: 'eth_sepolia',
                blockNumber: '0x64',
                from: RECIPIENT,
                to: address,
                value: '0x38d7ea4c68000',
                gasPrice: '0x3b9aca00',
                gasUsed: '0x5208',
                gas: '0x5208',
                cumulativeGasUsed: '0x5208',
                transactionIndex: '0x0',
                nonce: '0x0',
                timestamp: '0x6553f100',
                status: '0x1',
                input: '0x'
              }
            ]
          : []
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result:
            body.method === 'ankr_getTokenTransfers' ? { transfers: [] } : { transactions: result }
        })
      })
    }
  )

  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 30_000 })
  await popup.getByRole('tab', { name: 'Activity' }).click()
  await expect
    .poll(async () => {
      const response = (await popup.evaluate(() =>
        chrome.runtime.sendMessage({
          type: 'GET_ACTIVITY',
          action: 'refresh',
          chainIds: ['eip155:11155111']
        })
      )) as {
        result?: {
          items?: Array<{ source: string; accountMode?: string; id: string }>
        }
      }
      return response.result?.items
        ?.filter(item => item.source === 'rpc' && item.id.startsWith('rpc:evm:'))
        .map(item => item.accountMode ?? 'main')
        .sort()
    })
    .toEqual(['main', 'private'])
  expect(observedAddresses.size).toBe(2)
  await expect(popup.getByRole('button', { name: 'View Received ETH details' })).toHaveCount(2)

  const expiredCacheEntries = await popup.evaluate(async () => {
    return new Promise<number>((resolve, reject) => {
      const request = indexedDB.open('noir-wallet-evm-history-cache', 2)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const database = request.result
        const transaction = database.transaction('records', 'readwrite')
        const cursorRequest = transaction.objectStore('records').openCursor()
        let count = 0
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result
          if (!cursor) return
          const record = cursor.value as {
            chainId?: string
            lastAttemptAt: number
            successfulSyncAt: number | null
            retryAfter: number
          }
          if (record.chainId === 'eip155:11155111') {
            cursor.update({
              ...record,
              lastAttemptAt: 0,
              successfulSyncAt: 0,
              historySyncAt: 0,
              retryAfter: 0
            })
            count += 1
          }
          cursor.continue()
        }
        cursorRequest.onerror = () => reject(cursorRequest.error)
        transaction.oncomplete = () => {
          database.close()
          resolve(count)
        }
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      }
    })
  })
  expect(expiredCacheEntries).toBe(2)
  historyUnavailable = true
  const outageRead = (await popup.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'GET_ACTIVITY',
      action: 'refresh',
      chainIds: ['eip155:11155111']
    })
  )) as {
    result?: { items?: Array<{ source: string; accountMode?: string; id: string }> }
  }
  expect(
    outageRead.result?.items
      ?.filter(item => item.source === 'rpc' && item.id.startsWith('rpc:evm:'))
      .map(item => item.accountMode ?? 'main')
      .sort()
  ).toEqual(['main', 'private'])
  await popup.reload()
  await popup.getByRole('tab', { name: 'Activity' }).click()
  await expect(popup.getByRole('button', { name: 'View Received ETH details' })).toHaveCount(2)
})
