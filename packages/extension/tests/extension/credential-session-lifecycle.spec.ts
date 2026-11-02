import { chromium, type BrowserContext, type Page, type Worker } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  expect,
  captureScreenshot,
  extensionDir,
  e2eEnabledChainFeatureFlags,
  test,
  terminateExtensionServiceWorker,
  waitForBackgroundWalletInitialization
} from '../helpers/extension-fixtures'

async function getExtensionWorker(context: BrowserContext): Promise<Worker> {
  return context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
}

async function openExtensionPage(
  context: BrowserContext,
  extensionId: string,
  route = ''
): Promise<Page> {
  const page = await context.newPage()
  await page.setViewportSize({ width: 375, height: 600 })
  await page.goto(`chrome-extension://${extensionId}/index.html${route}`)
  return page
}

async function prepareUnlockedSession(
  page: Page,
  extensionId: string,
  password: string
): Promise<string> {
  await page.goto(
    `chrome-extension://${extensionId}/tests/extension/credential-repository-integration.html`
  )
  await expect
    .poll(() => page.evaluate(() => Boolean(window.credentialRepositoryIntegration)))
    .toBe(true)
  const setup = await page.evaluate(
    password => window.credentialRepositoryIntegration!.prepareProductionV1Migration(password),
    password
  )

  await page.goto(`chrome-extension://${extensionId}/index.html`)
  await waitForBackgroundWalletInitialization(page)
  await expect(
    page.evaluate(
      password => chrome.runtime.sendMessage({ type: 'WALLET_UNLOCK', password }),
      password
    )
  ).resolves.toMatchObject({ success: true })
  await expect(
    page.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_WALLET_SESSION_STATE' }))
  ).resolves.toEqual({ active: true })
  return setup.walletId
}

async function prepareUnlockedInventorySession(page: Page, extensionId: string, password: string) {
  await page.goto(
    `chrome-extension://${extensionId}/tests/extension/credential-repository-integration.html`
  )
  await expect
    .poll(() => page.evaluate(() => Boolean(window.credentialRepositoryIntegration)))
    .toBe(true)
  const setup = await page.evaluate(
    password =>
      window.credentialRepositoryIntegration!.prepareProductionV1WalletAndAccountInventory(
        password
      ),
    password
  )

  await page.goto(`chrome-extension://${extensionId}/index.html`)
  await waitForBackgroundWalletInitialization(page)
  await expect(
    page.evaluate(
      password => chrome.runtime.sendMessage({ type: 'WALLET_UNLOCK', password }),
      password
    )
  ).resolves.toMatchObject({ success: true })
  return setup
}

async function selectRetainedAccountThroughPopup(
  page: Page,
  target: { walletName: string; accountName: string; walletId: string; accountId: string }
): Promise<void> {
  await expect(page.getByRole('button', { name: 'Choose wallet' })).toBeVisible()
  await page.getByRole('button', { name: 'Choose wallet' }).click()
  await page.getByPlaceholder('Search Account').fill(target.walletName)
  await page.getByRole('button', { name: `Switch to ${target.accountName}` }).click({
    position: { x: 4, y: 4 }
  })
  const chooseWallet = page.getByRole('button', { name: 'Choose wallet' })
  const syncConfirmation = page.getByRole('dialog', { name: 'Switch Account' })
  await expect
    .poll(async () => {
      if (await syncConfirmation.isVisible()) return true
      return page.evaluate(async target => {
        const stored = await chrome.storage.local.get('wallet_state')
        const { currentWalletId, currentAccountId } = stored.wallet_state.state
        return currentWalletId === target.walletId && currentAccountId === target.accountId
      }, target)
    })
    .toBe(true)
  if (await syncConfirmation.isVisible()) {
    await syncConfirmation.getByRole('button', { name: 'Switch anyway' }).click()
  }
  await expect(chooseWallet).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const stored = await chrome.storage.local.get('wallet_state')
        const { currentWalletId, currentAccountId } = stored.wallet_state.state
        return { walletId: currentWalletId, accountId: currentAccountId }
      })
    )
    .toEqual({ walletId: target.walletId, accountId: target.accountId })
  await expect(
    page.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_WALLET_SESSION_STATE' }))
  ).resolves.toEqual({ active: true })
  await expect(page.getByRole('heading', { name: 'Enter your password' })).toHaveCount(0)
}

async function requestWorkerPublicKey(page: Page, walletId: string, accountIndex = 0) {
  return page.evaluate(
    ({ walletId, accountIndex }) =>
      chrome.runtime.sendMessage({
        type: 'WORKER_RPC',
        method: 'wallet.getPublicKey',
        payload: { walletId, accountIndex }
      }),
    { walletId, accountIndex }
  )
}

async function expectLockedAfterRuntimeReconstruction(page: Page): Promise<void> {
  await waitForBackgroundWalletInitialization(page)
  await expect(page.getByText('Enter your password', { exact: true })).toBeVisible({
    timeout: 30_000
  })
  await expect(
    page.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_WALLET_SESSION_STATE' }))
  ).resolves.toEqual({ active: false })
  await expect(
    page.evaluate(() => chrome.runtime.sendMessage({ type: 'RECOVER_WALLET_SESSION' }))
  ).resolves.toEqual({ error: 'Unauthorized runtime message sender' })
  await expect(
    page.evaluate(
      async () =>
        (await chrome.storage.session.get('keyring_session_descriptor')).keyring_session_descriptor
    )
  ).resolves.toBeUndefined()
}

test('keeps the unlocked session after closing and reopening only the popup', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  const password = 'popup-reopen-password'
  await popup.goto(
    `chrome-extension://${extensionId}/tests/extension/credential-repository-integration.html`
  )
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.credentialRepositoryIntegration)))
    .toBe(true)
  await popup.evaluate(
    password => window.credentialRepositoryIntegration!.prepareProductionV1Migration(password),
    password
  )
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await waitForBackgroundWalletInitialization(popup)
  await expect(popup.getByRole('heading', { name: 'Enter your password' })).toBeVisible()
  await popup.getByPlaceholder('Enter Password').fill(password)
  await popup.getByRole('button', { name: 'Unlock' }).click()
  await expect(popup.getByText('Enter your password', { exact: true })).toHaveCount(0)
  await expect(
    popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_WALLET_SESSION_STATE' }))
  ).resolves.toEqual({ active: true })
  await popup.close()

  const reopenedPopup = await openExtensionPage(context, extensionId, '?popup-reopen-e2e=1')
  await waitForBackgroundWalletInitialization(reopenedPopup)
  await expect(
    reopenedPopup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_WALLET_SESSION_STATE' }))
  ).resolves.toEqual({ active: true })
  await expect(reopenedPopup.getByText('Enter your password', { exact: true })).toHaveCount(0)
  await expect.poll(() => new URL(reopenedPopup.url()).hash).not.toContain('/unlock')
  await reopenedPopup.close()
})

test('keeps the unlocked session while switching between software wallets', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  const setup = await prepareUnlockedInventorySession(
    popup,
    extensionId,
    'cross-wallet-session-password'
  )
  await popup.reload()
  await selectRetainedAccountThroughPopup(popup, {
    walletName: 'Retained V1 Wallet',
    accountName: 'Account 1',
    walletId: setup.previousWalletId,
    accountId: setup.previousAccountId
  })
  await terminateExtensionServiceWorker(context, popup)
  await expect
    .poll(() =>
      popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_WALLET_SESSION_STATE' }))
    )
    .toEqual({ active: true })
  await selectRetainedAccountThroughPopup(popup, {
    walletName: 'Added V1 Wallet',
    accountName: 'Account 2',
    walletId: setup.walletId,
    accountId: setup.accountIds[1]
  })
  await selectRetainedAccountThroughPopup(popup, {
    walletName: 'Retained V1 Wallet',
    accountName: 'Account 1',
    walletId: setup.previousWalletId,
    accountId: setup.previousAccountId
  })
  await expect(
    popup.evaluate(() => chrome.runtime.sendMessage({ type: 'WALLET_LOCKED' }))
  ).resolves.toMatchObject({ success: true })
  const denied = await popup.evaluate(
    ({ walletId, accountId }) =>
      chrome.runtime.sendMessage({ type: 'SWITCH_ACCOUNT', walletId, accountId }),
    { walletId: setup.walletId, accountId: setup.accountIds[1] }
  )
  expect(denied).toMatchObject({ error: expect.stringMatching(/Wallet is locked/) })
  await expect
    .poll(() =>
      popup.evaluate(async () => {
        const stored = await chrome.storage.local.get('wallet_state')
        const { currentWalletId, currentAccountId } = stored.wallet_state.state
        return { walletId: currentWalletId, accountId: currentAccountId }
      })
    )
    .toEqual({ walletId: setup.previousWalletId, accountId: setup.previousAccountId })
})

test('returns from an active private-key wallet to a retained Zcash wallet', async ({
  context,
  popup,
  extensionId
}) => {
  test.skip(!e2eEnabledChainFeatureFlags.includes('chain.evm'), 'Requires an EVM-enabled profile')
  test.setTimeout(180_000)
  const setup = await prepareUnlockedInventorySession(
    popup,
    extensionId,
    'native-to-zcash-session-password'
  )
  const imported = await popup.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'IMPORT_PRIVATE_KEY_WALLET',
      privateKey: `0x${'00'.repeat(31)}01`,
      chainFamily: 'eip155',
      displayName: 'Imported EVM Test'
    })
  )
  expect(imported).toMatchObject({
    success: true,
    result: { keyDomainId: expect.any(String), accountId: expect.any(String) }
  })
  await expect
    .poll(() =>
      popup.evaluate(async () => {
        const saved = await chrome.storage.local.get('wallet_state')
        return saved.wallet_state.state.currentWalletId
      })
    )
    .toBeNull()
  await popup.reload()
  await selectRetainedAccountThroughPopup(popup, {
    walletName: 'Retained V1 Wallet',
    accountName: 'Account 1',
    walletId: setup.previousWalletId,
    accountId: setup.previousAccountId
  })
  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  await popup.getByPlaceholder('Search Account').fill('Imported EVM Test')
  await popup.getByRole('button', { name: 'Switch to Account 1' }).click({
    position: { x: 4, y: 4 }
  })
  await expect(popup.getByRole('button', { name: 'Choose wallet' })).toBeVisible()
  await expect
    .poll(() =>
      popup.evaluate(async walletId => {
        const response = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })
        return response.result?.accounts?.find(
          (account: { walletId: string }) => account.walletId === walletId
        )?.active
      }, imported.result.keyDomainId)
    )
    .toBe(true)

  await terminateExtensionServiceWorker(context, popup)
  await popup.reload()
  await selectRetainedAccountThroughPopup(popup, {
    walletName: 'Added V1 Wallet',
    accountName: 'Account 1',
    walletId: setup.walletId,
    accountId: setup.accountIds[0]
  })
})

test('recovers an existing healthy Wallet when the selected retained credential is missing', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  const password = 'missing-retained-credential-password'
  await popup.goto(
    `chrome-extension://${extensionId}/tests/extension/credential-repository-integration.html`
  )
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.credentialRepositoryIntegration)))
    .toBe(true)
  const setup = await popup.evaluate(
    password =>
      window.credentialRepositoryIntegration!.prepareProductionV1WalletAndAccountInventory(
        password
      ),
    password
  )
  await popup.evaluate(async walletId => {
    await chrome.storage.local.remove(`seed_${walletId}`)
  }, setup.walletId)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await waitForBackgroundWalletInitialization(popup)

  const wrong = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'WALLET_UNLOCK', password: 'incorrect-password' })
  )
  expect(wrong).toMatchObject({ success: false, failure: 'wrong_password' })
  expect(
    await popup.evaluate(
      async () =>
        (await chrome.storage.local.get('wallet_state')).wallet_state.state.currentWalletId
    )
  ).toBe(setup.walletId)

  await expect(popup.getByRole('heading', { name: 'Enter your password' })).toBeVisible()
  await popup.getByPlaceholder('Enter Password').fill(password)
  await popup.getByRole('button', { name: 'Unlock' }).click()
  await expect(popup.getByRole('heading', { name: 'Enter your password' })).toHaveCount(0)
  await expect(popup.getByRole('button', { name: 'Choose wallet' })).toBeVisible()
  const metadata = await popup.evaluate(async () => {
    const saved = await chrome.storage.local.get(['wallet_state', 'wallet_deleted_ids'])
    return {
      currentWalletId: saved.wallet_state.state.currentWalletId,
      walletIds: saved.wallet_state.state.wallets.map((wallet: { id: string }) => wallet.id),
      deletedIds: saved.wallet_deleted_ids ?? []
    }
  })
  expect(metadata.currentWalletId).toBe(setup.previousWalletId)
  expect(metadata.walletIds).toContain(setup.walletId)
  expect(metadata.deletedIds).not.toContain(setup.walletId)

  const inspection = await context.newPage()
  try {
    await inspection.goto(
      `chrome-extension://${extensionId}/tests/extension/credential-repository-integration.html`
    )
    await expect
      .poll(() => inspection.evaluate(() => Boolean(window.credentialRepositoryIntegration)))
      .toBe(true)
    const active = await inspection.evaluate(() =>
      window.credentialRepositoryIntegration!.inspectProductionV2Provisioning()
    )
    expect(active.activeAccount).toMatchObject({
      keyDomainId: setup.previousWalletId,
      accountId: setup.previousAccountId
    })
    expect(active.keyDomainIds).toContain(setup.walletId)
  } finally {
    await inspection.close()
  }
})

test('backs up and removes the intended retained software wallet with word proof', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  const password = 'retained-backup-removal-password'
  await popup.goto(
    `chrome-extension://${extensionId}/tests/extension/credential-repository-integration.html`
  )
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.credentialRepositoryIntegration)))
    .toBe(true)
  const setup = await popup.evaluate(
    password =>
      window.credentialRepositoryIntegration!.prepareProductionV1WalletAndAccountInventory(
        password
      ),
    password
  )
  await popup.evaluate(
    ({ walletId, accountId }) => {
      return chrome.storage.local.get('wallet_state').then(saved => {
        const state = saved.wallet_state
        const wallet = state.state.wallets.find((item: { id: string }) => item.id === walletId)
        wallet.name = 'Wallet 1791000000000'
        wallet.createdAt = 1791000000000
        state.state.accountDisplayNames[`${walletId}_${accountId}`] = 'Archive account'
        return chrome.storage.local.set({ wallet_state: state })
      })
    },
    { walletId: setup.previousWalletId, accountId: setup.previousAccountId }
  )

  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await waitForBackgroundWalletInitialization(popup)
  await expect(popup.getByRole('heading', { name: 'Enter your password' })).toBeVisible()
  await popup.getByPlaceholder('Enter Password').fill(password)
  await popup.getByRole('button', { name: 'Unlock' }).click()
  await expect(popup.getByRole('button', { name: 'Choose wallet' })).toBeVisible()
  await expect
    .poll(() =>
      popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_WALLET_SESSION_STATE' }))
    )
    .toEqual({ active: true })
  await terminateExtensionServiceWorker(context, popup)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await waitForBackgroundWalletInitialization(popup)
  await expect(
    popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_WALLET_SESSION_STATE' }))
  ).resolves.toEqual({ active: true })
  const banner = popup.getByRole('complementary', { name: 'Secret phrase backup reminder' })
  await expect(banner).toContainText('Archive account')
  await expect(banner).not.toContainText('Account 2')
  await captureScreenshot(popup, 'wallet-backup-banner-375x600.png')
  await banner.getByRole('button', { name: 'Back up' }).click()
  await expect(popup.getByRole('heading', { name: 'Back up secret phrase' })).toBeVisible()
  await popup.getByPlaceholder('Enter your password').fill('incorrect-password')
  await popup.getByRole('button', { name: 'Unlock to reveal' }).click()
  await expect(popup.getByRole('alert')).toContainText('Incorrect password')
  await popup.getByPlaceholder('Enter your password').fill(password)
  await popup.getByRole('button', { name: 'Unlock to reveal' }).click()
  await expect(popup.getByRole('button', { name: 'Continue' })).toBeVisible({ timeout: 30_000 })
  await popup.getByRole('button', { name: 'Click to reveal seed phrase' }).click()
  const displayedWords = popup.locator('div.grid.grid-cols-3 > div > div')
  await expect(displayedWords.first()).not.toHaveText('------')
  const phraseWords = await displayedWords.allTextContents()
  expect(phraseWords).toHaveLength(12)
  await popup.getByRole('button', { name: 'Continue' }).click()
  await expect(popup.getByRole('heading', { name: 'Confirm backup' })).toBeVisible()
  await expect(popup.locator('div.grid.grid-cols-3 > div > div')).toHaveCount(0)
  await expect(popup.getByRole('textbox', { name: /^Word \d+$/ })).toHaveCount(2)
  await captureScreenshot(popup, 'wallet-backup-confirm-375x600.png')
  const indices = (await popup.locator('label').allTextContents())
    .filter(label => /^Word \d+$/.test(label.trim()))
    .map(label => Number(label.trim().slice(5)) - 1)
  expect(indices).toHaveLength(2)
  await popup.getByLabel(`Word ${indices[0] + 1}`, { exact: true }).fill(phraseWords[indices[0]])
  await popup.getByLabel(`Word ${indices[1] + 1}`, { exact: true }).fill(phraseWords[indices[1]])
  await popup.getByRole('button', { name: 'Confirm backup' }).click()
  await expect
    .poll(() =>
      popup.evaluate(async walletId => {
        const saved = await chrome.storage.local.get('wallet_state')
        return Boolean(
          saved.wallet_state.state.wallets.find((wallet: { id: string }) => wallet.id === walletId)
            ?.secretPhraseBackupVerifiedAt
        )
      }, setup.previousWalletId)
    )
    .toBe(true)
  await expect(banner).toHaveCount(0)

  const challenge = await popup.evaluate(
    walletId => chrome.runtime.sendMessage({ type: 'GET_WALLET_BACKUP_WORD_INDICES', walletId }),
    setup.previousWalletId
  )
  expect(challenge).toMatchObject({ success: true })
  const removal = await popup.evaluate(
    ({ walletId, wordIndices, words }) =>
      chrome.runtime.sendMessage({
        type: 'REMOVE_WALLET',
        walletId,
        verification: { wordIndices, words }
      }),
    {
      walletId: setup.previousWalletId,
      wordIndices: challenge.wordIndices,
      words: challenge.wordIndices.map((index: number) => phraseWords[index])
    }
  )
  expect(removal).toMatchObject({ success: true })
  const after = await popup.evaluate(async walletId => {
    const saved = await chrome.storage.local.get([
      'wallet_state',
      `seed_${walletId}`,
      'wallet_deleted_ids',
      'wallet_deleted_records'
    ])
    return {
      walletIds: saved.wallet_state.state.wallets.map((wallet: { id: string }) => wallet.id),
      credential: saved[`seed_${walletId}`],
      deleted: saved.wallet_deleted_ids,
      retryRecord: saved.wallet_deleted_records?.[walletId]
    }
  }, setup.previousWalletId)
  expect(after.walletIds).toEqual([setup.walletId])
  expect(after.credential).toBeUndefined()
  expect(after.deleted).toContain(setup.previousWalletId)
  expect(after.retryRecord).toBeUndefined()
})

test('resumes retained credential deletion after the metadata tombstone was committed', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  const setup = await prepareUnlockedInventorySession(
    popup,
    extensionId,
    'retained-deletion-retry-password'
  )
  await popup.evaluate(
    async ({ walletId, accountId }) => {
      const saved = await chrome.storage.local.get('wallet_state')
      const snapshot = saved.wallet_state
      snapshot.state.wallets = snapshot.state.wallets.filter(
        (wallet: { id: string }) => wallet.id !== walletId
      )
      await chrome.storage.local.set({
        wallet_state: snapshot,
        wallet_deleted_ids: [walletId],
        wallet_deleted_records: { [walletId]: [accountId] }
      })
    },
    { walletId: setup.previousWalletId, accountId: setup.previousAccountId }
  )

  const retry = await popup.evaluate(
    walletId => chrome.runtime.sendMessage({ type: 'REMOVE_WALLET', walletId }),
    setup.previousWalletId
  )
  expect(retry).toMatchObject({ success: true })
  const saved = await popup.evaluate(async walletId => {
    const storage = await chrome.storage.local.get([
      'wallet_state',
      `seed_${walletId}`,
      'wallet_deleted_ids',
      'wallet_deleted_records'
    ])
    return {
      walletIds: storage.wallet_state.state.wallets.map((wallet: { id: string }) => wallet.id),
      credential: storage[`seed_${walletId}`],
      tombstone: storage.wallet_deleted_ids?.includes(walletId),
      retryRecord: storage.wallet_deleted_records?.[walletId]
    }
  }, setup.previousWalletId)
  expect(saved).toEqual({
    walletIds: [setup.walletId],
    credential: undefined,
    tombstone: true,
    retryRecord: undefined
  })

  const inspection = await context.newPage()
  try {
    await inspection.goto(
      `chrome-extension://${extensionId}/tests/extension/credential-repository-integration.html`
    )
    await expect
      .poll(() => inspection.evaluate(() => Boolean(window.credentialRepositoryIntegration)))
      .toBe(true)
    const inventory = await inspection.evaluate(() =>
      window.credentialRepositoryIntegration!.inspectProductionV2Provisioning()
    )
    expect(inventory.keyDomainIds).not.toContain(setup.previousWalletId)
    expect(inventory.keyDomainIds).toContain(setup.walletId)
  } finally {
    await inspection.close()
  }
})

test('renews the credential session before disabling side panel mode', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  const setup = await prepareUnlockedInventorySession(
    popup,
    extensionId,
    'side-panel-session-password'
  )

  await expect(
    popup.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'SET_EXTENSION_DISPLAY_MODE', sidePanelMode: true })
    )
  ).resolves.toMatchObject({ success: true, sidePanelMode: true })
  const before = await popup.evaluate(async () => {
    const stored = await chrome.storage.session.get('keyring_session_descriptor')
    return stored.keyring_session_descriptor?.lastUserActivityAt
  })
  expect(before).toEqual(expect.any(Number))

  await popup.waitForTimeout(10)
  await expect(
    popup.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'SET_EXTENSION_DISPLAY_MODE', sidePanelMode: false })
    )
  ).resolves.toMatchObject({ success: true, sidePanelMode: false })

  await expect(
    popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_WALLET_SESSION_STATE' }))
  ).resolves.toEqual({ active: true })
  const after = await popup.evaluate(async () => {
    const [local, session] = await Promise.all([
      chrome.storage.local.get('last_activity_time'),
      chrome.storage.session.get('keyring_session_descriptor')
    ])
    return {
      persisted: local.last_activity_time,
      descriptor: session.keyring_session_descriptor?.lastUserActivityAt
    }
  })
  expect(after.descriptor).toBeGreaterThan(before)
  expect(after.persisted).toBe(after.descriptor)

  await terminateExtensionServiceWorker(context, popup)
  await expect
    .poll(() =>
      popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_WALLET_SESSION_STATE' }))
    )
    .toEqual({ active: true })
  await expect(
    popup.evaluate(
      ({ walletId, accountId }) =>
        chrome.runtime.sendMessage({ type: 'SWITCH_ACCOUNT', walletId, accountId }),
      { walletId: setup.walletId, accountId: setup.accountIds[1] }
    )
  ).resolves.toMatchObject({ success: true })
})

test('routes an open side panel to unlock when its credential session ends', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  const password = 'side-panel-auto-lock-password'
  await prepareUnlockedInventorySession(popup, extensionId, password)

  const sidePanel = await context.newPage()
  await sidePanel.setViewportSize({ width: 480, height: 900 })
  await sidePanel.goto(`chrome-extension://${extensionId}/index.html?surface=side-panel`)
  await waitForBackgroundWalletInitialization(sidePanel)
  await sidePanel.getByRole('button', { name: 'Choose wallet' }).click()
  await expect(sidePanel.getByText('Noir Wallet', { exact: true })).toBeVisible()

  await expect(
    popup.evaluate(() => chrome.runtime.sendMessage({ type: 'WALLET_LOCKED' }))
  ).resolves.toMatchObject({ success: true })

  await expect(sidePanel.getByRole('heading', { name: 'Enter your password' })).toBeVisible()
  await expect(sidePanel.getByRole('dialog', { name: 'Unable to switch account' })).toHaveCount(0)
  await sidePanel.getByPlaceholder('Enter Password').fill(password)
  await sidePanel.getByRole('button', { name: 'Unlock' }).click()
  await expect(sidePanel.getByPlaceholder('Search Account')).toBeVisible()
})

test('requires the password after closing and reopening a persistent browser Profile', async () => {
  test.setTimeout(180_000)
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'noir-session-profile-e2e-'))
  const password = 'profile-restart-password'
  let context: BrowserContext | undefined

  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
    })
    const extensionId = new URL((await getExtensionWorker(context)).url()).host
    const initialPopup = await openExtensionPage(context, extensionId, '?profile-setup-e2e=1')
    await prepareUnlockedSession(initialPopup, extensionId, password)
    await initialPopup.close()
    await context.close()
    context = undefined

    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
    })
    const restartedExtensionId = new URL((await getExtensionWorker(context)).url()).host
    expect(restartedExtensionId).toBe(extensionId)
    const restartedPopup = await openExtensionPage(
      context,
      restartedExtensionId,
      '?profile-restart-e2e=1'
    )
    await expectLockedAfterRuntimeReconstruction(restartedPopup)
    await expect(
      restartedPopup.evaluate(
        password => chrome.runtime.sendMessage({ type: 'WALLET_UNLOCK', password }),
        password
      )
    ).resolves.toMatchObject({ success: true })
    await restartedPopup.close()
  } finally {
    await context?.close()
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('uses the production Background credential binding for one EVM signing command', async ({
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  const keyDomainId = await prepareUnlockedSession(
    popup,
    extensionId,
    'background-evm-signing-password'
  )

  const response = await popup.evaluate(
    keyDomainId =>
      chrome.runtime.sendMessage({
        type: 'WORKER_RPC',
        method: 'evm.conformance-sign',
        payload: {
          keyDomainId,
          signingPayload: {
            kind: 'evm-transaction',
            chainId: 'eip155:1',
            addressIndex: 0,
            transaction: {
              type: 'eip1559',
              chainId: '1',
              nonce: '0',
              maxFeePerGas: '5000000000',
              maxPriorityFeePerGas: '1000000000',
              gasLimit: '21000',
              to: '0x2222222222222222222222222222222222222222',
              value: '123',
              input: '0x',
              accessList: []
            }
          }
        }
      }),
    keyDomainId
  )

  expect(response).toMatchObject({
    result: {
      prepared: {
        chainId: 'eip155:1',
        operation: 'transaction',
        summary: {
          schema: 'evm.transaction.v1',
          fields: {
            to: '0x2222222222222222222222222222222222222222',
            valueWei: '123'
          }
        }
      },
      signed: {
        kind: 'signed-payload',
        payload: { encoding: 'hex', value: expect.stringMatching(/^0x[0-9a-f]+$/) },
        transactionId: expect.stringMatching(/^0x[0-9a-f]{64}$/)
      },
      hostFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/)
    }
  })
  expect(response.result.prepared.payloadFingerprint.digestHex).toBe(
    response.result.hostFingerprint
  )
})

test('reads the active Zcash lending identity through the Background credential session', async ({
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  const setup = await prepareUnlockedInventorySession(
    popup,
    extensionId,
    'background-zcash-lending-password'
  )
  const accountId = setup.accountIds[0]
  await expect(
    popup.evaluate(
      ({ walletId, accountId }) =>
        chrome.runtime.sendMessage({ type: 'SWITCH_ACCOUNT', walletId, accountId }),
      { walletId: setup.walletId, accountId }
    )
  ).resolves.toMatchObject({ success: true })

  const identity = await popup.evaluate(
    ({ walletId, accountId }) =>
      chrome.runtime.sendMessage({
        type: 'GET_ZCASH_LENDING_PUBLIC_KEY',
        walletId,
        accountId,
        signingMode: 'derived'
      }),
    { walletId: setup.walletId, accountId }
  )
  expect(identity).toMatchObject({
    result: { publicKey: expect.stringMatching(/^[0-9a-f]+$/) }
  })
})

test('restores Zcash signing after Background reconstruction without returning a secret', async ({
  context,
  popup,
  extensionId
}) => {
  test.setTimeout(180_000)
  const setup = await prepareUnlockedInventorySession(
    popup,
    extensionId,
    'background-zcash-session-password'
  )
  const [firstAccountId, secondAccountId] = setup.accountIds

  await expect(
    popup.evaluate(
      ({ walletId, accountId }) =>
        chrome.runtime.sendMessage({ type: 'SWITCH_ACCOUNT', walletId, accountId }),
      { walletId: setup.walletId, accountId: secondAccountId }
    )
  ).resolves.toMatchObject({ success: true })
  const beforeRestart = await requestWorkerPublicKey(popup, setup.walletId, 1)
  expect(beforeRestart).toMatchObject({
    result: {
      pubkey: expect.stringMatching(/^[0-9a-f]+$/),
      address: expect.any(String)
    }
  })

  await terminateExtensionServiceWorker(context, popup)
  await expect
    .poll(() =>
      popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_WALLET_SESSION_STATE' }))
    )
    .toEqual({ active: true })

  await expect(
    popup.evaluate(
      ({ walletId, accountId }) =>
        chrome.runtime.sendMessage({ type: 'SWITCH_ACCOUNT', walletId, accountId }),
      { walletId: setup.walletId, accountId: secondAccountId }
    )
  ).resolves.toMatchObject({ success: true })
  await expect(requestWorkerPublicKey(popup, setup.walletId, 1)).resolves.toEqual(beforeRestart)

  await expect(
    popup.evaluate(
      ({ walletId, accountId }) =>
        chrome.runtime.sendMessage({ type: 'SWITCH_ACCOUNT', walletId, accountId }),
      { walletId: setup.walletId, accountId: firstAccountId }
    )
  ).resolves.toMatchObject({ success: true })
  const firstAccountPublicKey = await requestWorkerPublicKey(popup, setup.walletId)
  expect(firstAccountPublicKey).toMatchObject({ result: { pubkey: expect.any(String) } })
  expect(firstAccountPublicKey).not.toEqual(beforeRestart)

  await expect(
    popup.evaluate(
      ({ walletId, accountId }) =>
        chrome.runtime.sendMessage({ type: 'SWITCH_ACCOUNT', walletId, accountId }),
      { walletId: setup.previousWalletId, accountId: setup.previousAccountId }
    )
  ).resolves.toMatchObject({ success: true })
  await expect(requestWorkerPublicKey(popup, setup.previousWalletId)).resolves.toMatchObject({
    result: { pubkey: expect.any(String), address: expect.any(String) }
  })

  const persisted = await popup.evaluate(() => chrome.storage.session.get(null))
  expect(persisted.session_password).toBeUndefined()
  expect(persisted.session_key_material).toBeUndefined()
  expect(JSON.stringify(persisted)).not.toMatch(/mnemonic|seedPhrase|privateKey/i)
  await expect(
    popup.evaluate(() =>
      chrome.runtime.sendMessage({
        type: 'WORKER_RPC',
        method: 'credential.getState',
        payload: {}
      })
    )
  ).resolves.toEqual({ error: 'Credential session RPC is Background-only' })

  await expect(
    popup.evaluate(() => chrome.runtime.sendMessage({ type: 'WALLET_LOCKED' }))
  ).resolves.toEqual({ success: true })
  await expect(requestWorkerPublicKey(popup, setup.previousWalletId)).resolves.toMatchObject({
    error: expect.stringMatching(/locked|not initialized/i)
  })
  await expect(
    popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_WALLET_SESSION_STATE' }))
  ).resolves.toEqual({ active: false })
})
