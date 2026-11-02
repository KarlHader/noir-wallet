import type { Locator, Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { BUILTIN_EVM_NETWORKS } from '../../src/config/networks'
import {
  captureScreenshot,
  e2eEnabledChainFeatureFlags,
  expect,
  mockUnknownZcashAccountHistory,
  mockReleaseNotesVersion,
  selectImportedZcashHistory,
  selectNewZcashAccountHistory,
  test,
  waitForBackgroundWalletInitialization
} from '../helpers/extension-fixtures'

const TEST_MNEMONIC_24 = `${'abandon '.repeat(23)}art`
const TEST_MNEMONIC_12 = `${'abandon '.repeat(11)}about`
const TEST_LIGHTWALLETD_URL = 'https://zcash-mainnet.chainsafe.dev'
const BITCOIN_CHAIN_IDS = [
  'bip122:000000000019d6689c085ae165831e93',
  'bip122:00040fe8ec8471911baa1db1266ea15d'
] as const
const SOFTWARE_CHAIN_IDS = [
  ...BITCOIN_CHAIN_IDS,
  ...BUILTIN_EVM_NETWORKS.mainnet.map(network => network.chainId),
  ...BUILTIN_EVM_NETWORKS.testnet.map(network => network.chainId)
] as const

async function selectTestRpcEndpoint(popup: Page) {
  await popup.evaluate(async () => {
    await chrome.storage.local.set({
      wallet_settings: JSON.stringify({
        state: {
          rpcEndpointPreferences: {
            zcash: 'chainsafe'
          }
        },
        version: 0
      })
    })
  })
}

async function importTestZcashWallet(popup: Page) {
  await selectTestRpcEndpoint(popup)
  await popup.getByRole('button', { name: 'Import wallet' }).click()
  await popup.getByRole('radio', { name: '12 words' }).click()
  await popup.getByRole('button', { name: 'Continue' }).click()
  await popup.locator('input[type="text"]').first().fill(TEST_MNEMONIC_12)
  await popup.getByRole('button', { name: 'Continue' }).click()
  await selectImportedZcashHistory(popup)
  await popup.getByPlaceholder('8–64 characters').fill('test-password')
  await popup.getByPlaceholder('Confirm password').fill('test-password')
  await popup.getByRole('checkbox').check()
  await popup.getByRole('button', { name: 'Import Wallet' }).click()
  await expect(popup.getByRole('heading', { name: 'Congratulations!' })).toBeVisible({
    timeout: 60_000
  })
  await popup.getByRole('button', { name: 'Got it' }).click()
  await popup.getByRole('button', { name: 'Settings' }).click()
}

async function expectNoVerticalOverflow(page: Page) {
  const measurements = await page
    .locator('.page-container, .overflow-y-auto, [role="dialog"]')
    .evaluateAll(elements =>
      elements.map(element => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight
      }))
    )

  expect(measurements.length).toBeGreaterThan(0)
  for (const measurement of measurements) {
    expect(measurement.scrollHeight).toBeLessThanOrEqual(measurement.clientHeight)
  }
}

async function waitForDialogAnimations(page: Page) {
  await page.getByRole('dialog').evaluate(async dialog => {
    await Promise.all(dialog.getAnimations({ subtree: true }).map(animation => animation.finished))
  })
}

async function expectSwitchThumbAligned(switchControl: Locator) {
  const track = switchControl.locator('[data-slot="switch"]')
  await track.evaluate(async element => {
    await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished))
  })

  const checked = (await switchControl.getAttribute('aria-checked')) === 'true'
  const gaps = await track.evaluate(trackElement => {
    const thumb = trackElement.querySelector('[data-slot="switch-thumb"]')
    if (!(thumb instanceof HTMLElement)) {
      throw new Error('Switch thumb is missing')
    }

    const trackRect = trackElement.getBoundingClientRect()
    const thumbRect = thumb.getBoundingClientRect()
    return {
      left: thumbRect.left - trackRect.left,
      right: trackRect.right - thumbRect.right,
      top: thumbRect.top - trackRect.top,
      bottom: trackRect.bottom - thumbRect.bottom
    }
  })

  const activeHorizontalGap = checked ? gaps.right : gaps.left
  expect(Math.abs(activeHorizontalGap - gaps.top)).toBeLessThanOrEqual(0.5)
  expect(Math.abs(gaps.top - gaps.bottom)).toBeLessThanOrEqual(0.5)
}

test('loads the built extension popup and service worker', async ({ extensionId, popup }) => {
  expect(extensionId).toMatch(/^[a-p]{32}$/)
  await expect(popup).toHaveURL(new RegExp(`^chrome-extension://${extensionId}/index\\.html`))
  await expect(popup.getByRole('heading', { name: 'Welcome to Noir Wallet' })).toBeVisible()
  expect(
    await popup.evaluate(async () => {
      const extensionOrigin = new URL(chrome.runtime.getURL('/')).origin
      const contexts = await chrome.runtime.getContexts({
        contextTypes: [
          chrome.runtime.ContextType.TAB,
          chrome.runtime.ContextType.POPUP,
          chrome.runtime.ContextType.SIDE_PANEL
        ],
        documentOrigins: [extensionOrigin]
      })
      return contexts.some(context => context.documentOrigin === extensionOrigin)
    })
  ).toBe(true)
  expect(
    await popup.evaluate(() => chrome.runtime.getManifest().action?.default_popup ?? null)
  ).toBeNull()
  await expect
    .poll(() => popup.evaluate(async () => chrome.action.getPopup({})))
    .toBe(`chrome-extension://${extensionId}/index.html`)
  await expect
    .poll(() =>
      popup.evaluate(async () => {
        const alarm = await chrome.alarms.get('wallet-balance-sync')
        return alarm
          ? {
              recurring: alarm.periodInMinutes !== undefined,
              scheduledInFuture: alarm.scheduledTime > Date.now()
            }
          : null
      })
    )
    .toEqual({ recurring: false, scheduledInFuture: true })
  await captureScreenshot(popup, 'extension-welcome.png')
})

test('downloads redacted diagnostic logs from an imported wallet', async ({ popup }) => {
  test.setTimeout(120_000)
  await importTestZcashWallet(popup)
  await popup.getByRole('button', { name: 'Help' }).click()
  await expect(popup.getByRole('button', { name: 'Download Logs' })).toBeVisible()
  await captureScreenshot(popup, 'settings-help-popup.png')
  await popup.setViewportSize({ width: 480, height: 900 })
  await popup.goto(new URL('?surface=side-panel', popup.url()).href)
  await popup.getByRole('button', { name: 'Settings' }).click()
  await popup.getByRole('button', { name: 'Help' }).click()
  await expect(popup.getByRole('button', { name: 'Download Logs' })).toBeVisible()
  await captureScreenshot(popup, 'settings-help-side-panel.png')

  const appendResult = await popup.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'APPEND_DIAGNOSTIC_LOG',
      entry: {
        source: 'popup',
        level: 'error',
        message: 'Diagnostic test password=never-export-this-value',
        timestamp: Date.now(),
        sequence: 0
      }
    })
  )
  expect(appendResult).toEqual({ success: true })

  const downloadPromise = popup.waitForEvent('download')
  await popup.getByRole('button', { name: 'Download Logs' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/^noir-wallet-diagnostics-.*\.txt$/)
  const path = await download.path()
  expect(path).not.toBeNull()
  const contents = await readFile(path, 'utf8')
  expect(contents).toContain('Diagnostic test password=[Redacted]')
  expect(contents).not.toContain('never-export-this-value')
})

test('discovers Zcash voting rounds from an imported wallet', async ({ popup }) => {
  test.skip(process.env.LIVE_VOTING !== '1', 'Requires the public voting service')
  test.setTimeout(120_000)
  await importTestZcashWallet(popup)
  await popup.getByRole('button', { name: 'Zcash voting' }).click()
  await expect(popup.getByRole('heading', { name: 'Zcash voting' })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Refresh voting rounds' })).toBeEnabled({
    timeout: 30_000
  })
  await expect(popup.getByText('Loading rounds…')).toHaveCount(0)
  await expect(popup.getByRole('alert')).toHaveCount(0, { timeout: 30_000 })
})

test('opens Ledger from the hardware selector and validates the account index', async ({
  extensionId,
  popup
}) => {
  await popup.goto(`chrome-extension://${extensionId}/index.html#/hardware/connect`)
  await expect(popup.getByRole('button', { name: 'Ledger' })).toBeVisible()
  await popup.getByRole('button', { name: 'Ledger' }).click()
  await expect(popup.getByRole('heading', { name: 'Connect Ledger', exact: true })).toBeVisible()
  await popup.locator('summary').filter({ hasText: 'Advanced' }).click()
  const index = popup.getByLabel('Start account index')
  await index.fill('2147483648')
  await expect(popup.getByRole('button', { name: 'Connect Ledger', exact: true })).toBeDisabled()
  await index.fill('0')
  await expect(popup.getByRole('button', { name: 'Connect Ledger', exact: true })).toBeEnabled()
  await popup.locator('summary').filter({ hasText: 'Advanced' }).click()
  await expectNoVerticalOverflow(popup)
})

test('chooses a network before showing Keystone firmware instructions', async ({
  context,
  extensionId,
  popup
}) => {
  await context.route('https://assets.zknoir.com/chain/**', route =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#00d18a"/></svg>'
    })
  )
  // Changing only the hash would not remount the app's MemoryRouter in this
  // already-open fixture page. A dedicated query makes this match the fresh
  // full-tab document that production opens.
  await popup.goto(`chrome-extension://${extensionId}/index.html?e2e=keystone#/hardware/connect`)
  await popup.getByRole('button', { name: 'Keystone' }).click()

  await expect(popup.getByRole('heading', { name: 'Choose your networks' })).toBeVisible()
  const continueButton = popup.getByRole('button', { name: 'Continue' })
  await expect(continueButton).toBeDisabled()
  const networkOptions = popup.getByRole('radio')
  const evmEnabled = e2eEnabledChainFeatureFlags.includes('chain.evm')
  const bitcoinEnabled = e2eEnabledChainFeatureFlags.includes('chain.bitcoin')
  await expect(networkOptions).toHaveCount(3)
  await expect(networkOptions.nth(0)).toHaveAccessibleName(
    evmEnabled ? 'Multi-chain' : 'Multi-chain, Coming soon'
  )
  await expect(networkOptions.nth(1)).toHaveAccessibleName(bitcoinEnabled ? 'Zcash + BTC' : 'Zcash')
  await expect(networkOptions.nth(1)).toBeEnabled()
  await expect(networkOptions.nth(2)).toHaveAccessibleName(
    bitcoinEnabled ? 'Bitcoin only' : 'Bitcoin only, Coming soon'
  )
  if (!evmEnabled) await expect(networkOptions.nth(0)).toBeDisabled()
  if (!bitcoinEnabled) await expect(networkOptions.nth(2)).toBeDisabled()
  const optionBoxes = await networkOptions.evaluateAll(elements =>
    elements.map(element => {
      const box = element.getBoundingClientRect()
      return { x: box.x, y: box.y, width: box.width, height: box.height }
    })
  )
  expect(new Set(optionBoxes.map(box => box.x)).size).toBe(1)
  expect(new Set(optionBoxes.map(box => box.width)).size).toBe(1)
  for (let index = 1; index < optionBoxes.length; index += 1) {
    expect(optionBoxes[index].y).toBeGreaterThanOrEqual(
      optionBoxes[index - 1].y + optionBoxes[index - 1].height
    )
  }
  await expect(popup.getByText(/200\+ blockchains|5,500\+ assets/i)).toHaveCount(0)
  if (!bitcoinEnabled) await expect(popup.getByText(/Coming soon/).first()).toBeVisible()
  const chainIcons = popup.locator('[role="radiogroup"] img')
  expect(await chainIcons.count()).toBeGreaterThan(0)
  await expect
    .poll(() =>
      chainIcons.evaluateAll(images =>
        images.every(
          image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
        )
      )
    )
    .toBe(true)
  await captureScreenshot(popup, 'extension-keystone-network-selection.png')

  const selected = evmEnabled ? networkOptions.nth(0) : networkOptions.nth(1)
  await selected.click()
  await expect(selected).toHaveAttribute('aria-checked', 'true')
  await expect(
    popup.getByText(evmEnabled ? 'Multi-Coin firmware' : 'Cypherpunk firmware', { exact: true })
  ).toBeVisible()
  await expect(continueButton).toBeEnabled()
  await captureScreenshot(popup, 'extension-keystone-multicoin-plan.png')

  await continueButton.click()
  await expect(popup.getByRole('heading', { name: 'Connect Hardware Wallet' })).toBeVisible()
  await expect(
    popup.getByText(
      evmEnabled
        ? /Unlock your Keystone with Multi-Coin firmware/
        : /Unlock your Keystone with Cypherpunk firmware/
    )
  ).toBeVisible()
  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(selected).toHaveAttribute('aria-checked', 'true')
})

test('keeps EVM transfer commands closed in the Zcash regression build', async ({ popup }) => {
  const result = await popup.evaluate(async () => {
    const prepare = await chrome.runtime.sendMessage({
      type: 'PREPARE_EVM_TRANSFER',
      intent: {
        assetId: 'eip155:1/slip44:60',
        recipient: '0x2222222222222222222222222222222222222222',
        amountRaw: '1'
      }
    })
    const forgedApproval = await chrome.runtime.sendMessage({
      type: 'APPROVE_EVM_TRANSFER',
      transactionId: 'transaction:evm:forged',
      payloadFingerprint: `0x${'a'.repeat(64)}`
    })
    return { prepare, forgedApproval }
  })

  expect(result).toEqual({
    prepare: {
      error: { code: 'unavailable', message: 'EVM wallet support is unavailable' }
    },
    forgedApproval: { error: 'Invalid or unsupported runtime message' }
  })
})

test('uses theme-backed surfaces for onboarding headers', async ({ popup }) => {
  const welcomeHeader = popup.locator('header')
  await expect(welcomeHeader).toHaveCSS('background-color', 'rgb(18, 18, 28)')
  await expect(welcomeHeader).toHaveCSS('border-bottom-width', '1px')
  await expect(welcomeHeader).toHaveCSS('border-bottom-style', 'solid')
  const borderColor = await welcomeHeader.evaluate(
    element => getComputedStyle(element).borderBottomColor
  )
  expect(borderColor).toMatch(/(?:,|\/)\s*0\.1\)$/)
  await captureScreenshot(popup, 'extension-welcome-header.png')

  await popup.getByRole('button', { name: 'Import wallet' }).click()

  const backButton = popup.getByRole('button', { name: 'Back' })
  await expect(backButton).toHaveCSS('background-color', 'rgb(40, 40, 50)')
  await backButton.hover()
  await expect(backButton).toHaveCSS('background-color', 'rgb(32, 32, 41)')
  await captureScreenshot(popup, 'extension-import-header.png')
})

test('creates a 12-word phrase with the pinned Multichain WASM at 375x600', async ({
  popup,
  extensionId
}) => {
  test.setTimeout(120_000)
  await popup.getByRole('button', { name: 'Create Wallet' }).click()
  await popup.getByPlaceholder('8–64 characters').fill('create-12-password')
  await popup.getByPlaceholder('Confirm password').fill('create-12-password')
  await popup.getByRole('checkbox').check()
  await popup.getByRole('button', { name: 'Create', exact: true }).click()

  const option24 = popup.getByRole('radio', { name: '24 words' })
  const option12 = popup.getByRole('radio', { name: '12 words' })
  await expect(popup.getByRole('heading', { name: 'Create wallet' })).toBeVisible()
  await expect(option24).toHaveAttribute('aria-checked', 'true')
  await expect(option12).toHaveAttribute('aria-checked', 'false')
  await expect(option24).toHaveCSS('border-color', 'rgb(0, 209, 138)')
  await option12.click()
  await expect(option12).toHaveAttribute('aria-checked', 'true')
  await expect(option24).toHaveAttribute('aria-checked', 'false')
  await captureScreenshot(popup, 'extension-create-word-count-12.png')

  await popup.getByRole('button', { name: 'Continue' }).click()
  await expect(popup.getByText('12-word Secret Recovery Phrase')).toBeVisible()
  await popup.getByRole('button', { name: 'Start backup' }).click()
  await expect(popup.getByText('Store these 12 words securely')).toBeVisible({ timeout: 60_000 })
  await popup.getByRole('button', { name: 'Click to reveal seed phrase' }).click()
  const words = await popup.locator('div.grid.grid-cols-3 > div > div').allTextContents()
  expect(words).toHaveLength(12)
  await expect(
    popup.evaluate(
      phrase =>
        chrome.runtime.sendMessage({
          type: 'WORKER_RPC',
          method: 'mnemonic.validate',
          payload: { phrase }
        }),
      words.join(' ')
    )
  ).resolves.toEqual({ result: true })
  const viewport = await popup.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
    clientWidth: document.documentElement.clientWidth,
    clientHeight: document.documentElement.clientHeight
  }))
  expect(viewport).toEqual({ width: 375, height: 600, clientWidth: 375, clientHeight: 600 })
  await captureScreenshot(popup, 'extension-create-12-phrase.png')

  await popup.getByRole('checkbox').check()
  await popup.getByRole('button', { name: 'Next' }).click()
  const verificationPrompt = await popup.getByText(/^Select the .* words\.$/).textContent()
  const verificationIndices = (verificationPrompt?.match(/\d+/g) ?? []).map(
    ordinal => Number.parseInt(ordinal, 10) - 1
  )
  expect(verificationIndices).toHaveLength(2)

  const expectedWords = verificationIndices.map(index => words[index])
  const wrongWords =
    expectedWords[0] === expectedWords[1]
      ? [expectedWords[0], words.find(word => word !== expectedWords[1])]
      : [expectedWords[1], expectedWords[0]]
  const [firstWrongWord, secondWrongWord] = wrongWords
  if (typeof firstWrongWord !== 'string' || typeof secondWrongWord !== 'string') {
    throw new Error('Generated recovery phrase does not provide a mismatched confirmation pair')
  }
  for (const word of [firstWrongWord, secondWrongWord]) {
    await popup.getByRole('button', { name: word, exact: true, pressed: false }).first().click()
  }
  await popup.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(
    popup.getByText('Selected words do not match. Please try again.', { exact: true })
  ).toBeVisible()
  await expect(popup.getByRole('button', { pressed: true })).toHaveCount(0)
  await expect(popup.getByRole('button', { name: 'Confirm', exact: true })).toBeDisabled()
  await expect(popup.getByText(/^Select the .* words\.$/)).toHaveText(verificationPrompt ?? '')

  for (const index of verificationIndices) {
    await popup
      .getByRole('button', { name: words[index], exact: true, pressed: false })
      .first()
      .click()
  }
  await captureScreenshot(popup, 'extension-confirm-recovery-phrase.png')
  await popup.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Congratulations!' })).toBeVisible({
    timeout: 60_000
  })

  await popup.goto(
    `chrome-extension://${extensionId}/tests/extension/credential-repository-integration.html`
  )
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.credentialRepositoryIntegration)))
    .toBe(true)
  const provisioned = await popup.evaluate(() =>
    window.credentialRepositoryIntegration!.inspectProductionV2Provisioning()
  )
  expect(provisioned.keyDomainIds).toHaveLength(1)
  expect(provisioned.accountIds).toHaveLength(1)
  expect(provisioned.chainAccounts).toHaveLength(SOFTWARE_CHAIN_IDS.length)
  expect(provisioned.chainAccounts.map(item => item.chainId).sort()).toEqual(
    [...SOFTWARE_CHAIN_IDS].sort()
  )
  expect(provisioned.credentialPolicies).toEqual([
    expect.objectContaining({
      source: 'software',
      mnemonicWordCount: 12,
      zcashSeedPolicy: 'direct-bip39-v1'
    })
  ])
})

test('verification builds do not upload analytics after Google Analytics opt-out', async ({
  context,
  popup
}) => {
  const googleAnalyticsRequests: string[] = []
  const customCollectorRequests: string[] = []
  await context.route('https://www.google-analytics.com/**', route => {
    googleAnalyticsRequests.push(route.request().url())
    return route.fulfill({ status: 204 })
  })
  await context.route('https://datareport.rhea.finance/**', route => {
    customCollectorRequests.push(route.request().url())
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0 })
    })
  })

  await popup.evaluate(async () => {
    await chrome.storage.local.set({ anonymous_analytics_enabled: false })
  })
  await popup.waitForTimeout(250)
  googleAnalyticsRequests.length = 0
  customCollectorRequests.length = 0

  await popup.evaluate(async () => {
    await chrome.runtime.sendMessage({
      type: 'ANALYTICS_EVENT',
      name: 'analytics_opt_out_test',
      options: {
        params: { method: 'test' },
        extra: {
          origin: 'https://dapp.example',
          tx_hash: 'must-not-be-sent',
          error: 'must-not-be-sent'
        }
      },
      timestamp: Date.now()
    })
    await chrome.runtime.sendMessage({
      type: 'ANALYTICS_PAGE_VIEW',
      page: '/security-privacy',
      timestamp: Date.now()
    })
  })
  await popup.waitForTimeout(2_500)

  expect(googleAnalyticsRequests).toEqual([])
  expect(customCollectorRequests).toEqual([])
})

test('restores an evicted wallet from IndexedDB instead of recreating it empty', async ({
  popup
}) => {
  const walletId = `eviction-regression-${crypto.randomUUID()}`
  const initPayload = {
    walletId,
    dbKey: `mainnet_${walletId}`,
    network: 'mainnet',
    lightwalletdUrl: TEST_LIGHTWALLETD_URL
  }

  await expect
    .poll(
      async () => {
        const response = await popup.evaluate(async payload => {
          try {
            return await chrome.runtime.sendMessage({
              type: 'WORKER_RPC',
              method: 'init',
              payload
            })
          } catch {
            return null
          }
        }, initPayload)
        return !!response && !response.error
      },
      { message: 'offscreen wallet host should initialize', timeout: 10_000 }
    )
    .toBe(true)

  const result = await popup.evaluate(
    async ({ mnemonic, walletId, lightwalletdUrl }) => {
      const dbKey = `mainnet_${walletId}`
      const network = 'mainnet'

      const rpc = async (method: string, payload: Record<string, unknown>) => {
        const response = await chrome.runtime.sendMessage({
          type: 'WORKER_RPC',
          method,
          payload
        })
        if (!response) throw new Error(`No response for ${method}`)
        if (response?.error) throw new Error(response.error)
        return response?.result
      }

      const openDb = () =>
        new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('zcash-wallet-db')
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })

      const getSnapshotSize = async () => {
        const db = await openDb()
        const size = await new Promise<number>((resolve, reject) => {
          const transaction = db.transaction('walletData', 'readonly')
          const store = transaction.objectStore('walletData')
          const request = store.get(dbKey)
          request.onsuccess = () => resolve(request.result?.totalBytes ?? 0)
          request.onerror = () => reject(request.error)
        })
        db.close()
        return size
      }

      await rpc('wallet.createAccount', {
        walletId,
        seedPhrase: mnemonic,
        accountIndex: 0,
        birthdayHeight: 3_400_000
      })

      await rpc('wallet.persistDb', { walletId, key: dbKey })
      const snapshotBytes = await getSnapshotSize()

      await rpc('wallet.reset', { walletId })
      await rpc('init', { walletId, network, lightwalletdUrl, dbKey })
      const accountIds = await rpc('wallet.getAccountIds', { walletId })

      await rpc('wallet.reset', { walletId })
      return { accountIds, snapshotBytes }
    },
    { mnemonic: TEST_MNEMONIC_24, walletId, lightwalletdUrl: TEST_LIGHTWALLETD_URL }
  )

  expect(result.snapshotBytes).toBeGreaterThan(0)
  expect(result.accountIds).toEqual([1])
})

test('opens the available update notice without overflowing the real popup', async ({
  extensionId,
  popup
}) => {
  await waitForBackgroundWalletInitialization(popup)
  await popup.evaluate(async version => {
    await chrome.storage.local.set({
      extension_update_notice: {
        status: 'available',
        version,
        detectedAt: Date.now()
      }
    })
  }, mockReleaseNotesVersion)

  await popup.goto(`chrome-extension://${extensionId}/index.html?update-available-test=1#/update`)

  await expect(popup.getByText('Update available')).toBeVisible()
  await expect(popup.getByText(`Version ${mockReleaseNotesVersion} is ready.`)).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Restart', exact: true })).toBeInViewport({
    ratio: 1
  })
  await expectNoVerticalOverflow(popup)
  await waitForDialogAnimations(popup)
  await captureScreenshot(popup, 'extension-update-available.png')
})

test('does not show a notification for a legacy installed update state', async ({
  extensionId,
  popup
}) => {
  await popup.evaluate(async () => {
    await chrome.storage.local.set({
      extension_update_notice: {
        status: 'installed',
        version: '1.0.30',
        previousVersion: '0.0.0',
        detectedAt: Date.now()
      }
    })
  })

  await popup.goto(`chrome-extension://${extensionId}/index.html?legacy-update-test=1`)
  await expect(popup.getByText('Noir Wallet updated')).toHaveCount(0)

  await popup.goto(`chrome-extension://${extensionId}/index.html?legacy-update-page-test=1#/update`)
  await expect(popup.getByText('Noir Wallet is up to date')).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Got it' })).toBeVisible()
})

test('imports 12 words, preserves added-wallet backup, and changes the wallet password', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(120_000)

  await selectTestRpcEndpoint(popup)
  await popup.getByRole('button', { name: 'Import wallet' }).click()

  const option24 = popup.getByRole('radio', { name: '24 words' })
  const option12 = popup.getByRole('radio', { name: '12 words' })
  await expect(popup.getByRole('button', { name: 'Back' }).locator('svg')).toBeVisible()
  await expect(option24).toHaveAttribute('aria-checked', 'true')
  await expect(option12).toHaveAttribute('aria-checked', 'false')
  await expect(option24).toHaveCSS('border-color', 'rgb(0, 209, 138)')
  const selectedBorderColor = await option24.evaluate(
    element => getComputedStyle(element).borderColor
  )
  const unselectedBorderColor = await option12.evaluate(
    element => getComputedStyle(element).borderColor
  )
  expect(selectedBorderColor).not.toBe(unselectedBorderColor)
  await captureScreenshot(popup, 'extension-import-word-count-24.png')

  await option12.click()
  await expect(option12).toHaveAttribute('aria-checked', 'true')
  await expect(option24).toHaveAttribute('aria-checked', 'false')
  await expect
    .poll(() => option12.evaluate(element => getComputedStyle(element).borderColor))
    .toBe(selectedBorderColor)
  await expect
    .poll(() => option24.evaluate(element => getComputedStyle(element).borderColor))
    .toBe(unselectedBorderColor)
  await captureScreenshot(popup, 'extension-import-word-count-12.png')
  await popup.getByRole('button', { name: 'Continue' }).click()

  await expect(popup.locator('input[type="text"]')).toHaveCount(12)
  await expect(popup.getByText('Enter your 12-word Secret Recovery Phrase')).toBeVisible()
  await captureScreenshot(popup, 'extension-import-12-words.png')

  await popup.locator('input[type="text"]').first().fill(TEST_MNEMONIC_24)
  await expect(popup.getByText('Recovery phrase must contain exactly 12 words.')).toBeVisible()
  await expect(popup.locator('input[type="text"]').first()).toHaveValue('')

  const invalidMnemonic = TEST_MNEMONIC_12.replace('abandon abandon', 'abandon abandn')
  await popup.locator('input[type="text"]').first().fill(invalidMnemonic)
  await expect(popup.locator('input[type="text"]').nth(1)).toHaveAttribute('aria-invalid', 'true')
  await popup.getByRole('button', { name: 'Continue' }).click()
  await expect(
    popup.getByText('Highlighted words are not in the BIP-39 English word list.')
  ).toBeVisible()

  const invalidChecksumMnemonic = TEST_MNEMONIC_12.replace(/about$/, 'ability')
  await popup.locator('input[type="text"]').first().fill(invalidChecksumMnemonic)
  await popup.getByRole('button', { name: 'Continue' }).click()
  await expect(
    popup.getByText('Recovery phrase checksum is invalid. Check the words and their order.')
  ).toBeVisible()

  await popup.locator('input[type="text"]').first().fill(TEST_MNEMONIC_12)
  await expect(
    popup.getByText('Recovery phrase checksum is invalid. Check the words and their order.')
  ).toHaveCount(0)
  await popup.getByRole('button', { name: 'Continue' }).click()

  const newToZcash = popup.getByRole('radio', { name: 'New to Zcash' })
  const restoreZcash = popup.getByRole('radio', { name: 'Restore Zcash history' })
  await expect(newToZcash).toHaveAttribute('aria-checked', 'true')
  await expect(restoreZcash).toHaveAttribute('aria-checked', 'false')
  await captureScreenshot(popup, 'extension-import-zcash-history-new.png')
  await restoreZcash.click()
  await expect(popup.getByText('Approximate first ZEC transaction')).toBeVisible()
  await expect(popup.getByRole('radio', { name: 'Date' })).toHaveAttribute('aria-checked', 'true')
  await expect(popup.getByRole('radio', { name: 'Full history' })).toHaveCount(0)
  await captureScreenshot(popup, 'extension-import-zcash-history-restore.png')
  await expect(popup.getByRole('radio', { name: 'Block height' })).toBeInViewport()
  await popup.getByRole('radio', { name: 'Block height' }).click()
  await popup.getByRole('textbox', { name: 'Zcash birthday height' }).fill('1')
  await popup.getByRole('button', { name: 'Continue' }).click()
  await expect(popup.getByRole('alert')).toContainText('Block height must be 419,200 or later.')
  await popup.getByRole('textbox', { name: 'Zcash birthday height' }).fill('3000000')
  await popup.getByRole('button', { name: 'Continue' }).click()

  await expect(popup.getByText('Create Password', { exact: true })).toBeVisible()
  await expect(popup.getByPlaceholder('8–64 characters')).toBeVisible()
  await expect(popup.getByPlaceholder('Confirm password')).toBeVisible()
  await expect(popup.getByRole('checkbox')).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Import Wallet' })).toBeVisible()

  const passwordInput = popup.getByPlaceholder('8–64 characters')
  await passwordInput.fill('1234567')
  await expect(popup.getByText('Password must be at least 8 characters')).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Import Wallet' })).toBeDisabled()
  await passwordInput.fill('a'.repeat(65))
  await expect(popup.getByText('Password must be no more than 64 characters')).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Import Wallet' })).toBeDisabled()
  await passwordInput.fill('')

  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByText('Zcash history', { exact: true })).toBeVisible()
  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByText('Import Secret Recovery Phrase', { exact: true })).toBeVisible()
  await expect(popup.locator('input[type="text"]').first()).toHaveValue('abandon')
  await popup.locator('input[type="text"]').first().fill(TEST_MNEMONIC_12)
  await expect(popup.getByText('Invalid recovery phrase. Please check and try again.')).toHaveCount(
    0
  )
  await popup.getByRole('button', { name: 'Continue' }).click()
  await selectImportedZcashHistory(popup)

  await popup.getByPlaceholder('8–64 characters').fill('test-password')
  await popup.getByPlaceholder('Confirm password').fill('test-password')
  await popup.getByRole('checkbox').check()
  await popup.getByRole('button', { name: 'Import Wallet' }).click()
  await expect(popup.getByRole('button', { name: 'Back' })).toBeDisabled()

  await expect(popup.getByRole('heading', { name: 'Congratulations!' })).toBeVisible({
    timeout: 60_000
  })
  await captureScreenshot(popup, 'extension-import-password.png')

  await popup.getByRole('button', { name: 'Got it' }).click()
  await popup.getByRole('button', { name: 'Receive', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Addresses' })).toBeVisible()
  const receiveAddresses = popup.getByRole('region', { name: 'Account network addresses' })
  await receiveAddresses
    .getByRole('button', { name: 'Show Zcash shielded address QR code' })
    .click()
  const shieldedQrDialog = popup.getByRole('dialog')
  await expect(
    shieldedQrDialog.getByRole('heading', { name: 'Zcash shielded address' })
  ).toBeVisible()
  await captureScreenshot(popup, 'extension-receive-zcash.png')
  await shieldedQrDialog.getByRole('button', { name: 'Close' }).click()
  await receiveAddresses
    .getByRole('button', { name: 'Show Zcash transparent address QR code' })
    .click()
  const transparentQrDialog = popup.getByRole('dialog')
  await expect(
    transparentQrDialog.getByRole('heading', { name: 'Zcash transparent address' })
  ).toBeVisible()
  await captureScreenshot(popup, 'extension-receive-zcash-transparent.png')
  await transparentQrDialog.getByRole('button', { name: 'Close' }).click()
  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByText('Total Assets', { exact: true })).toBeVisible()

  await context.route('https://app.zknoir.com/**', route =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>zkNoir Test App</title>'
    })
  )
  const zkNoirApp = await context.newPage()
  await zkNoirApp.goto('https://app.zknoir.com/')
  await zkNoirApp.waitForFunction(() => Boolean(window.noirwallet?.zcash))
  const pageCountBeforeConnect = context.pages().length
  const connectedAccounts = await zkNoirApp.evaluate(() =>
    window.noirwallet.zcash.request({ method: 'zcash_requestAccounts' })
  )
  expect(connectedAccounts.accounts).toHaveLength(1)
  expect(context.pages()).toHaveLength(pageCountBeforeConnect)
  await zkNoirApp.close()

  const lendingPagePromise = context.waitForEvent('page')
  await popup.getByRole('button', { name: 'Lending' }).click()
  const lendingPage = await lendingPagePromise
  await expect(lendingPage).toHaveURL('https://app.zknoir.com/lending')
  await lendingPage.close()

  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  await expect(popup.getByText('Noir Wallet', { exact: true })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Settings' })).toHaveCount(0)
  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByText('Total Assets', { exact: true })).toBeVisible()
  const totalValue = popup.locator('p.text-4xl').first()
  await expect(totalValue).toBeVisible({ timeout: 30_000 })
  const [totalValueBox, homeViewportWidth] = await Promise.all([
    totalValue.boundingBox(),
    popup.evaluate(() => window.innerWidth)
  ])
  expect(totalValueBox).not.toBeNull()
  expect(Math.abs(totalValueBox.x + totalValueBox.width / 2 - homeViewportWidth / 2)).toBeLessThan(
    1
  )
  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  await popup.getByRole('button', { name: 'Add Wallet' }).click()
  await popup.getByRole('button', { name: 'Create New Wallet' }).click()
  await expect(popup.getByRole('radio', { name: '24 words' })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await popup.getByRole('button', { name: 'Continue' }).click()
  await popup.getByRole('button', { name: 'Start backup' }).click()

  await expect(popup.getByText('View Secret Phrase', { exact: true })).toBeVisible({
    timeout: 60_000
  })
  await popup.getByRole('button', { name: 'Click to reveal seed phrase' }).click()
  const displayedPhraseWords = await popup
    .locator('div.grid.grid-cols-3 > div > div')
    .allTextContents()
  expect(displayedPhraseWords).toHaveLength(24)

  await expect(popup.getByText('I have saved it', { exact: true })).toBeVisible()
  await popup.getByRole('checkbox').check()
  await popup.getByRole('button', { name: 'Next' }).click()
  const verificationPrompt = await popup.getByText(/^Select the .* words\.$/).textContent()
  const verificationIndices = (verificationPrompt?.match(/\d+/g) ?? []).map(
    ordinal => Number.parseInt(ordinal, 10) - 1
  )
  expect(verificationIndices).toHaveLength(2)
  for (const index of verificationIndices) {
    await popup
      .getByRole('button', {
        name: displayedPhraseWords[index],
        exact: true,
        pressed: false
      })
      .first()
      .click()
  }

  await popup.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Congratulations!' })).toBeVisible({
    timeout: 60_000
  })
  await popup.getByRole('button', { name: 'Got it' }).click()

  const addedAccountItem = popup.getByRole('button', { name: 'Switch to Account 1' })
  await expect(addedAccountItem).toHaveCount(2)
  const addedAccountClickTarget = await addedAccountItem.first().boundingBox()
  expect(addedAccountClickTarget?.height).toBeGreaterThan(70)
  await expect(popup.getByText('Active', { exact: true })).toHaveCount(1)
  await captureScreenshot(popup, 'extension-account-list-multiwallet.png')
  const networkTriggers = popup.getByRole('button', { name: 'Expand account networks' })
  await expect(networkTriggers).toHaveCount(2)
  await networkTriggers.first().click()
  const networksRegion = popup.getByRole('region', { name: 'Account networks' })
  await expect(networksRegion.getByText('Zcash', { exact: true })).toBeVisible()
  await expect(networksRegion.getByRole('button', { name: /Copy Zcash .* address/ })).toHaveCount(2)
  await captureScreenshot(popup, 'extension-account-networks-zcash.png')
  await popup.getByRole('button', { name: 'Collapse account networks' }).click()
  const accountActionButtons = popup.getByRole('button', { name: 'Account actions for Account 1' })
  await accountActionButtons.first().click()
  const accountMenu = popup.locator('[data-slot="dropdown-menu-content"]')
  await expect(popup.getByRole('menuitem', { name: 'Account details' })).toBeVisible()
  await expect(accountMenu.getByRole('menuitem').allTextContents()).resolves.toEqual([
    'Account details',
    'Addresses',
    'Pin to top',
    'Hide account'
  ])
  await accountMenu.evaluate(async element => {
    await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished))
  })
  await expect(accountMenu).toHaveCSS('background-color', 'rgb(32, 32, 41)')
  await expect(accountMenu).toHaveCSS('color', 'rgb(255, 255, 255)')
  await captureScreenshot(popup, 'extension-account-list-menu.png')
  await popup.getByRole('menuitem', { name: 'Account details' }).click()
  await expect(popup.getByRole('button', { name: 'Addresses', exact: true })).toBeVisible()
  await expect(popup.getByText('2 addresses', { exact: true })).toHaveCount(0)
  await expect(popup.getByText('Birthday date', { exact: true })).toHaveCount(0)
  await expect(popup.getByRole('button', { name: 'Resync wallet' })).toHaveCount(0)
  await expect(popup.getByRole('button', { name: 'Open settings' })).toHaveCount(0)
  await captureScreenshot(popup, 'extension-account-detail.png')
  await popup.getByRole('button', { name: 'Addresses', exact: true }).click()
  await expect(popup.getByText('Addresses', { exact: true })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Copy Zcash shielded address' })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Copy Zcash transparent address' })).toBeVisible()
  const shieldedAddressValue = popup
    .getByText('Shielded', { exact: true })
    .locator('..')
    .locator('span[title]')
  const previousShieldedAddress = await shieldedAddressValue.getAttribute('title')
  expect(previousShieldedAddress).toBeTruthy()
  await expect(shieldedAddressValue).toHaveText(
    `${previousShieldedAddress?.slice(0, 6)}...${previousShieldedAddress?.slice(-6)}`
  )
  await expect(popup.getByRole('button', { name: 'Generate new shielded address' })).toHaveCount(0)
  await expect(popup.getByRole('button', { name: 'Open Zcash settings' })).toBeVisible()
  await captureScreenshot(popup, 'extension-addresses-list-zcash.png')
  await popup.getByRole('button', { name: 'Open Zcash settings' }).click()
  await expect(popup.getByText('Zcash settings', { exact: true })).toBeVisible()
  await expect(popup.getByText('Birthday date', { exact: true })).toBeVisible()
  await expect(popup.getByText('Shielded', { exact: true })).toBeVisible()
  await expect(popup.getByText('Transparent', { exact: true })).toBeVisible()
  const rotateShieldedButton = popup.getByRole('button', {
    name: 'Generate new shielded address'
  })
  await expect(rotateShieldedButton).toBeVisible()
  const fullShieldedAddress = popup.locator('p[title^="u1"]').first()
  await expect(fullShieldedAddress).toHaveAttribute('title', previousShieldedAddress)
  await rotateShieldedButton.click()
  await expect(fullShieldedAddress).not.toHaveAttribute('title', previousShieldedAddress, {
    timeout: 30_000
  })
  await captureScreenshot(popup, 'extension-zcash-settings.png')
  const resyncZcashButton = popup.getByRole('button', { name: 'Resync Zcash' })
  await resyncZcashButton.scrollIntoViewIfNeeded()
  await expect(resyncZcashButton).toBeVisible()
  await resyncZcashButton.click()
  await expect(popup.getByRole('heading', { name: 'Resync Zcash' })).toBeVisible()
  await expect(popup.getByText(/This rebuilds local Zcash data/)).toBeVisible()
  await popup.getByRole('button', { name: 'Cancel' }).click()
  await popup.getByRole('button', { name: 'Back' }).click()
  await popup.getByRole('button', { name: 'Back' }).click()
  await popup.getByRole('button', { name: 'Back' }).click()
  await accountActionButtons.last().click()
  await popup.getByRole('menuitem', { name: 'Account details' }).click()
  await popup.getByRole('button', { name: 'View secret phrase' }).click()
  await popup.getByPlaceholder('Enter your password').fill('test-password')
  await popup.getByRole('button', { name: 'Unlock to reveal' }).click()
  await popup.getByRole('button', { name: 'Click to reveal seed phrase' }).click()

  const storedPhraseWords = await popup
    .locator('div.grid.grid-cols-3 > div > div')
    .allTextContents()
  expect(storedPhraseWords).toEqual(displayedPhraseWords)

  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByText('Account details', { exact: true })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Open settings' })).toHaveCount(0)
  await popup.getByRole('button', { name: 'Back' }).click()
  await popup.getByRole('button', { name: 'Back' }).click()
  const homeSettingsButton = popup.getByRole('button', { name: 'Settings' })
  await expect(homeSettingsButton).toBeVisible()
  await homeSettingsButton.click()
  await expect(popup.getByText('Settings', { exact: true })).toBeVisible()

  const sidePanelModeSwitch = popup.getByRole('switch', { name: 'Side panel mode' })
  await expect(sidePanelModeSwitch).toHaveAttribute('aria-checked', 'false')

  const sidePanelPage = await context.newPage()
  await sidePanelPage.setViewportSize({ width: 480, height: 900 })
  await sidePanelPage.goto(`chrome-extension://${extensionId}/index.html?surface=side-panel`)
  await expect(sidePanelPage.getByRole('button', { name: 'Choose wallet' })).toBeVisible()
  await expect(sidePanelPage.getByRole('button', { name: 'Show account addresses' })).toBeVisible()
  expect(
    await sidePanelPage.evaluate(() => ({
      viewport: [window.innerWidth, window.innerHeight],
      root: [
        document.getElementById('root')?.clientWidth,
        document.getElementById('root')?.clientHeight
      ]
    }))
  ).toEqual({ viewport: [480, 900], root: [480, 900] })
  await sidePanelPage.getByRole('button', { name: 'Settings' }).click()
  await expect(sidePanelPage.getByText('Settings', { exact: true })).toBeVisible()
  const sidePanelPageSwitch = sidePanelPage.getByRole('switch', { name: 'Side panel mode' })
  await expect(sidePanelPageSwitch).toHaveAttribute('aria-checked', 'false')
  await captureScreenshot(sidePanelPage, 'settings-side-panel-mode.png')

  const popupClosed = popup.waitForEvent('close')
  await sidePanelModeSwitch.click()
  await popupClosed
  await expect(sidePanelPageSwitch).toHaveAttribute('aria-checked', 'true')
  await expect
    .poll(() =>
      sidePanelPage.evaluate(async () => {
        const sidePanel = (
          chrome as typeof chrome & {
            sidePanel: {
              getOptions(options: Record<string, never>): Promise<{
                enabled?: boolean
                path?: string
              }>
              getPanelBehavior(): Promise<{ openPanelOnActionClick?: boolean }>
            }
          }
        ).sidePanel
        const [popupPath, panelOptions, panelBehavior] = await Promise.all([
          chrome.action.getPopup({}),
          sidePanel.getOptions({}),
          sidePanel.getPanelBehavior()
        ])
        return { popupPath, panelOptions, panelBehavior }
      })
    )
    .toEqual({
      popupPath: '',
      panelOptions: { enabled: true, path: 'index.html?surface=side-panel' },
      panelBehavior: { openPanelOnActionClick: true }
    })
  expect(
    await sidePanelPage.evaluate(async () => {
      const stored = await chrome.storage.local.get(['extension_display_mode', 'wallet_settings'])
      const walletSettings =
        typeof stored.wallet_settings === 'string'
          ? JSON.parse(stored.wallet_settings)
          : stored.wallet_settings
      return {
        displayMode: stored.extension_display_mode,
        walletSettingsMode: walletSettings.state.sidePanelMode ?? null
      }
    })
  ).toEqual({
    displayMode: { sidePanelMode: true },
    walletSettingsMode: null
  })

  await sidePanelPageSwitch.click()
  await expect(sidePanelPageSwitch).toHaveAttribute('aria-checked', 'false')
  await expect
    .poll(() => sidePanelPage.evaluate(async () => chrome.action.getPopup({})))
    .toBe(`chrome-extension://${extensionId}/index.html`)
  await sidePanelPage.close()

  popup = await context.newPage()
  await popup.setViewportSize({ width: 375, height: 600 })
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect
    .poll(() =>
      popup.evaluate(async () => {
        const response = await chrome.runtime.sendMessage({ type: 'GET_WALLET_SESSION_STATE' })
        return response?.active === true
      })
    )
    .toBe(true)
  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  const switchableAccounts = popup.getByRole('button', { name: 'Switch to Account 1' })
  await expect(switchableAccounts).toHaveCount(2)
  await expect(popup.getByText('Active', { exact: true })).toHaveCount(1)
  await switchableAccounts.last().click({ position: { x: 4, y: 4 } })
  await expect(popup.getByText('Total Assets', { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(popup.getByRole('dialog', { name: 'Unable to switch account' })).toHaveCount(0)
  await popup.getByRole('button', { name: 'Settings' }).click()
  await expect(popup.getByRole('switch', { name: 'Side panel mode' })).toHaveAttribute(
    'aria-checked',
    'false'
  )
  await popup.getByRole('button', { name: 'Security & Privacy' }).click()

  await expect(popup.getByText('Security & Privacy', { exact: true })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Change Password' })).toBeVisible()
  const analyticsSwitch = popup.getByRole('switch', { name: 'Share Google Analytics' })
  await expect(analyticsSwitch).toHaveAttribute('aria-checked', 'true')
  await expectSwitchThumbAligned(analyticsSwitch)
  await expectNoVerticalOverflow(popup)
  await captureScreenshot(popup, 'security-privacy-analytics.png')
  await analyticsSwitch.click()
  await expect(analyticsSwitch).toHaveAttribute('aria-checked', 'false')
  await expectSwitchThumbAligned(analyticsSwitch)
  await expect
    .poll(() =>
      popup.evaluate(async () => {
        const result = await chrome.storage.local.get('anonymous_analytics_enabled')
        return result.anonymous_analytics_enabled
      })
    )
    .toBe(false)

  await popup.getByRole('button', { name: 'Change Password' }).click()
  await popup.getByPlaceholder('Current Password').fill('test-password')
  await popup.getByPlaceholder('New Password', { exact: true }).fill('1234567')
  await expect(popup.getByText('Password must be at least 8 characters')).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Change Password' })).toBeDisabled()
  await popup.getByPlaceholder('New Password', { exact: true }).fill('a'.repeat(65))
  await expect(popup.getByText('Password must be no more than 64 characters')).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Change Password' })).toBeDisabled()

  const newPassword = '  new password 🔐  '
  await popup.getByPlaceholder('New Password', { exact: true }).fill(newPassword)
  await popup.getByPlaceholder('Confirm New Password').fill(newPassword)
  await popup.getByRole('button', { name: 'Change Password' }).click()
  await expect(popup.getByText('Security & Privacy', { exact: true })).toBeVisible({
    timeout: 30_000
  })
  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByText('Settings', { exact: true })).toBeVisible({ timeout: 30_000 })

  await popup.getByRole('button', { name: 'Lock Wallet' }).click()
  await expect(popup.getByText('Enter your password', { exact: true })).toBeVisible()
  await popup.getByPlaceholder('Enter Password').fill(newPassword)
  await popup.getByRole('button', { name: 'Unlock', exact: true }).click()
  await expect(popup.getByText('Total Assets', { exact: true })).toBeVisible({ timeout: 30_000 })

  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  await expect(popup.getByText('Noir Wallet', { exact: true })).toBeVisible()
  await expect(popup.getByText('Wallet 1', { exact: true })).toBeVisible()
  await expect(popup.getByText('Wallet 2', { exact: true })).toBeVisible()
  const firstWalletGroup = popup.locator('section[aria-label="Wallet group Wallet 1"]')
  const secondWalletGroup = popup.locator('section[aria-label="Wallet group Wallet 2"]')
  await expect(firstWalletGroup.getByRole('button', { name: 'Switch to Account 1' })).toHaveCount(1)
  await expect(secondWalletGroup.getByRole('button', { name: 'Switch to Account 1' })).toHaveCount(
    1
  )
  await expect(popup.locator('[aria-label^="Account total"]')).toHaveCount(2)
  await expect(popup.getByRole('button', { name: 'Add Account', exact: true })).toHaveCount(2)
  const removeZcashHistoryMock = await mockUnknownZcashAccountHistory(context)
  await popup.getByRole('button', { name: 'Add Account', exact: true }).first().click()
  await selectNewZcashAccountHistory(popup)
  await expect(popup.getByText('Account 2', { exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(popup.locator('[aria-label^="Account total"]')).toHaveCount(3)
  await removeZcashHistoryMock()
  await captureScreenshot(popup, 'extension-wallet-account-tree.png')
  const persistedAccounts = await popup.evaluate(async () => {
    const persisted = await chrome.storage.local.get('wallet_state')
    const envelope = persisted.wallet_state as {
      state?: {
        wallets?: Array<{
          id: string
          accounts?: Array<{ id: string; derivationIndex: number }>
        }>
      }
    }
    const wallets = envelope.state?.wallets ?? []
    const derived = wallets
      .flatMap(wallet =>
        (wallet.accounts ?? []).map(account => ({ ...account, walletId: wallet.id }))
      )
      .find(account => account.derivationIndex === 1)
    return {
      counts: wallets.map(wallet => wallet.accounts?.length ?? 0).sort(),
      derived
    }
  })
  expect(persistedAccounts.counts).toEqual([1, 2])
  expect(persistedAccounts.derived).toBeDefined()
  const derivedAccount = persistedAccounts.derived
  if (!derivedAccount) throw new Error('Derived Account was not persisted')

  const renameAccountButton = popup.getByRole('button', { name: 'Rename account Account 2' })
  await expect(renameAccountButton.locator('svg')).toHaveCSS('opacity', '0')
  await renameAccountButton.hover()
  await expect(renameAccountButton.locator('svg')).toHaveCSS('opacity', '1')
  await renameAccountButton.click()
  const accountNameInput = popup.getByRole('textbox', { name: 'Account name' })
  await accountNameInput.fill('Temporary Account')
  await accountNameInput.press('Escape')
  await expect(popup.getByRole('button', { name: 'Switch to Account 2' })).toBeVisible()
  await popup.getByRole('button', { name: 'Rename account Account 2' }).click()
  await popup.getByRole('textbox', { name: 'Account name' }).fill('   ')
  await popup.getByRole('textbox', { name: 'Account name' }).press('Enter')
  await expect(popup.getByRole('textbox', { name: 'Account name' })).toHaveAttribute(
    'aria-invalid',
    'true'
  )
  await expect(popup.getByRole('alert')).toContainText('Enter an account name')
  await popup.getByRole('textbox', { name: 'Account name' }).fill('Trading Account')
  await popup.getByRole('button', { name: 'Switch to Account 2' }).click({
    position: { x: 4, y: 4 }
  })
  await expect(popup.getByRole('textbox', { name: 'Account name' })).toHaveCount(0)
  await expect(popup.getByRole('heading', { name: 'Noir Wallet' })).toBeVisible()
  await expect(popup.getByRole('dialog')).toHaveCount(0)
  await expect(popup.getByRole('button', { name: 'Switch to Trading Account' })).toBeVisible()

  await popup.getByRole('button', { name: 'Account actions for Trading Account' }).click()
  await popup.getByRole('menuitem', { name: 'Pin to top' }).click()
  await expect(popup.getByText('Pinned', { exact: true })).toBeVisible()
  await popup.getByRole('button', { name: 'Account actions for Trading Account' }).click()
  await popup.getByRole('menuitem', { name: 'Hide account' }).click()
  await expect(popup.getByText('Hidden (1)', { exact: true })).toBeVisible()
  await popup.getByRole('button', { name: 'Account actions for Trading Account' }).click()
  await popup.getByRole('menuitem', { name: 'Show account' }).click()
  await expect(popup.getByText('Hidden (1)', { exact: true })).toHaveCount(0)
  await expect(popup.getByText('Pinned', { exact: true })).toBeVisible()

  await popup.reload()
  await expect(popup.getByText('Total Assets', { exact: true })).toBeVisible({ timeout: 30_000 })
  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  await expect(popup.getByRole('heading', { name: 'Noir Wallet' })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Switch to Trading Account' })).toBeVisible()
  const persistedAccountPreferences = await popup.evaluate(
    async ({ walletId, accountId }) => {
      const persisted = await chrome.storage.local.get('wallet_state')
      const envelope = persisted.wallet_state as {
        state?: {
          accountDisplayNames?: Record<string, string>
          wallets?: Array<{
            id: string
            accounts?: Array<{ id: string; isPinned: boolean; isHidden: boolean }>
          }>
        }
      }
      const account = envelope.state?.wallets
        ?.find(wallet => wallet.id === walletId)
        ?.accounts?.find(candidate => candidate.id === accountId)
      const catalog = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })
      return {
        displayName: envelope.state?.accountDisplayNames?.[`${walletId}_${accountId}`],
        account,
        catalogDisplayName: catalog.result?.accounts?.find(
          (candidate: { walletId?: string; accountId?: string }) =>
            candidate.walletId === walletId && candidate.accountId === accountId
        )?.accountDisplayName
      }
    },
    { walletId: derivedAccount.walletId, accountId: derivedAccount.id }
  )
  expect(persistedAccountPreferences).toMatchObject({
    displayName: 'Trading Account',
    account: { isPinned: true, isHidden: false },
    catalogDisplayName: 'Trading Account'
  })
  const renameSecondWallet = popup.getByRole('button', { name: 'Rename wallet Wallet 2' })
  await renameSecondWallet.hover()
  await expect(renameSecondWallet.locator('svg')).toBeVisible()
  await renameSecondWallet.click()
  await popup.getByRole('textbox', { name: 'Wallet name' }).fill('Savings Wallet')
  await popup.getByRole('heading', { name: 'Noir Wallet' }).click()
  await expect(popup.getByRole('textbox', { name: 'Wallet name' })).toHaveCount(0)
  await expect(popup.locator('section[aria-label="Wallet group Savings Wallet"]')).toBeVisible()
  await expect(popup.locator('section[aria-label="Wallet group Wallet 1"]')).toBeVisible()
  await popup.reload()
  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  await expect(popup.locator('section[aria-label="Wallet group Savings Wallet"]')).toBeVisible()
  await expect(popup.locator('section[aria-label="Wallet group Wallet 1"]')).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Switch to Trading Account' })).toBeVisible()
  await captureScreenshot(popup, 'extension-account-preferences-persisted.png')

  await popup.getByRole('button', { name: 'Switch to Trading Account' }).click({
    position: { x: 4, y: 4 }
  })
  await expect(popup.getByText('Total Assets', { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(
    popup.evaluate(
      password => chrome.runtime.sendMessage({ type: 'WALLET_CREATED', password }),
      newPassword
    )
  ).resolves.toEqual({ success: true, credentialStatus: 'already-synchronized' })

  await expect(
    popup.evaluate(
      async ({ currentPassword, newPassword }) => {
        const local = await chrome.storage.local.get(null)
        const envelopes = Object.entries(local).filter(([key]) => key.startsWith('seed_'))
        const decrypts = async (value: unknown, password: string) => {
          const envelope = value as { encryptedData: string; salt: string; iv: string }
          const fromBase64 = (encoded: string) =>
            Uint8Array.from(atob(encoded), character => character.charCodeAt(0))
          try {
            const passwordKey = await crypto.subtle.importKey(
              'raw',
              new TextEncoder().encode(password),
              'PBKDF2',
              false,
              ['deriveKey']
            )
            const key = await crypto.subtle.deriveKey(
              {
                name: 'PBKDF2',
                salt: fromBase64(envelope.salt),
                iterations: 100_000,
                hash: 'SHA-256'
              },
              passwordKey,
              { name: 'AES-GCM', length: 256 },
              false,
              ['decrypt']
            )
            await crypto.subtle.decrypt(
              { name: 'AES-GCM', iv: fromBase64(envelope.iv) },
              key,
              fromBase64(envelope.encryptedData)
            )
            return true
          } catch {
            return false
          }
        }
        return {
          count: envelopes.length,
          allUseNewPassword: (
            await Promise.all(envelopes.map(([, value]) => decrypts(value, newPassword)))
          ).every(Boolean),
          noneUseOldPassword: (
            await Promise.all(envelopes.map(([, value]) => decrypts(value, currentPassword)))
          ).every(result => !result)
        }
      },
      { currentPassword: 'test-password', newPassword }
    )
  ).resolves.toEqual({ count: 2, allUseNewPassword: true, noneUseOldPassword: true })

  await popup.goto(
    `chrome-extension://${extensionId}/tests/extension/credential-repository-integration.html`
  )
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.credentialRepositoryIntegration)))
    .toBe(true)
  const provisioned = await popup.evaluate(() =>
    window.credentialRepositoryIntegration!.inspectProductionV2Provisioning()
  )
  expect(provisioned.keyDomainIds).toHaveLength(2)
  expect(provisioned.accountIds).toHaveLength(3)
  expect(provisioned.activeAccount).toEqual({
    keyDomainId: derivedAccount.walletId,
    accountId: derivedAccount.id
  })
  expect(provisioned.chainAccounts).toHaveLength(3 * SOFTWARE_CHAIN_IDS.length)
  expect(provisioned.chainAccounts.map(item => item.path)).toEqual(
    expect.arrayContaining(["m/32'/133'/1'", "m/44'/60'/0'/0/1", "m/84'/0'/1'/0/0"])
  )
  expect(provisioned.credentialPolicies.map(item => item.mnemonicWordCount).sort()).toEqual([
    12, 24
  ])
  expect(
    provisioned.credentialPolicies.every(item => item.zcashSeedPolicy === 'direct-bip39-v1')
  ).toBe(true)
  expect(provisioned.addressSchemes).toEqual([
    'bitcoin-p2wpkh',
    'evm',
    'zcash-full-unified',
    'zcash-shielded-unified',
    'zcash-transparent-p2pkh'
  ])
})
