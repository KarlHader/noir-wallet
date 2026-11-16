import type { BrowserContext, CDPSession, Page, Worker } from '@playwright/test'
import { expect, selectImportedZcashHistory, test } from '../helpers/extension-fixtures'

const TEST_MNEMONIC_12 = `${'abandon '.repeat(11)}about`

type ExecutionContext = {
  id: number
  auxData?: {
    frameId?: string
    isDefault?: boolean
    type?: string
  }
}

async function findContentScriptContext(
  cdp: CDPSession,
  contexts: Map<number, ExecutionContext>,
  extensionId: string
): Promise<number | null> {
  for (const context of contexts.values()) {
    if (context.auxData?.isDefault !== false) continue
    try {
      const result = await cdp.send('Runtime.evaluate', {
        contextId: context.id,
        expression:
          "typeof chrome !== 'undefined' && chrome.runtime ? chrome.runtime.id : undefined",
        returnByValue: true
      })
      if (result.result.value === extensionId) return context.id
    } catch {
      // The execution context may have been replaced during navigation.
    }
  }
  return null
}

async function evaluateInContext<T>(
  cdp: CDPSession,
  contextId: number,
  expression: string
): Promise<T> {
  const evaluation = await cdp.send('Runtime.evaluate', {
    contextId,
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (evaluation.exceptionDetails) {
    throw new Error(evaluation.exceptionDetails.text)
  }
  return evaluation.result.value as T
}

async function openMaliciousPage(page: Page, extensionId: string) {
  const cdp = await page.context().newCDPSession(page)
  const contexts = new Map<number, ExecutionContext>()
  cdp.on('Runtime.executionContextCreated', event => {
    contexts.set(event.context.id, event.context as ExecutionContext)
  })
  cdp.on('Runtime.executionContextDestroyed', event => {
    contexts.delete(event.executionContextId)
  })
  cdp.on('Runtime.executionContextsCleared', () => {
    contexts.clear()
  })
  await cdp.send('Runtime.enable')

  await page.route('https://security.noir.test/**', route =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Untrusted dApp</title><main>security fixture</main>'
    })
  )
  await page.goto('https://security.noir.test/app')

  let contentScriptContextId: number | null = null
  await expect
    .poll(async () => {
      contentScriptContextId = await findContentScriptContext(cdp, contexts, extensionId)
      return contentScriptContextId
    })
    .not.toBeNull()

  return { cdp, contentScriptContextId: contentScriptContextId as number }
}

async function getExtensionWorker(context: BrowserContext): Promise<Worker> {
  return context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
}

async function terminateServiceWorker(context: BrowserContext, page: Page): Promise<void> {
  const worker = await getExtensionWorker(context)
  const cdp = await context.newCDPSession(page)
  try {
    const targets = await cdp.send('Target.getTargets')
    const target = targets.targetInfos.find(
      candidate => candidate.type === 'service_worker' && candidate.url === worker.url()
    )
    if (!target) throw new Error('Extension service worker target is missing')
    await cdp.send('Target.closeTarget', { targetId: target.targetId })
  } finally {
    await cdp.detach()
  }
}

async function importTestWallet(popup: Page): Promise<void> {
  await popup.getByRole('button', { name: 'Import wallet' }).click()
  await popup.getByRole('radio', { name: '12 words' }).click()
  await popup.getByRole('button', { name: 'Continue' }).click()
  await popup.locator('input[type="text"]').first().fill(TEST_MNEMONIC_12)
  const mnemonicContinue = popup.getByRole('button', { name: 'Continue' })
  await expect(mnemonicContinue).toBeEnabled({ timeout: 30_000 })
  await mnemonicContinue.click({ timeout: 30_000 })
  await selectImportedZcashHistory(popup, { birthdayHeight: 3_000_000 })
  await popup.getByPlaceholder('8–64 characters').fill('approval-replay-password')
  await popup.getByPlaceholder('Confirm password').fill('approval-replay-password')
  await popup.getByRole('checkbox').check()
  await popup.getByRole('button', { name: 'Import Wallet' }).click()
  await expect(popup.getByRole('heading', { name: 'Congratulations!' })).toBeVisible({
    timeout: 60_000
  })
  await popup.getByRole('button', { name: 'Got it' }).click()
}

test('keeps the EVM and Bitcoin providers absent in the Zcash regression build', async ({
  context
}) => {
  await context.route('https://provider-gate.noir.test/**', route =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Provider gate</title><main>provider gate fixture</main>'
    })
  )
  const page = await context.newPage()
  await page.goto('https://provider-gate.noir.test/app')
  await page.waitForFunction(() => 'noirwallet' in window)

  const result = await page.evaluate(() => {
    const announcements: unknown[] = []
    window.addEventListener('eip6963:announceProvider', event => {
      announcements.push((event as CustomEvent).detail)
    })
    window.dispatchEvent(new Event('eip6963:requestProvider'))
    const target = window as typeof window & {
      noirwallet?: {
        zcash?: { request?: unknown }
        ethereum?: unknown
        bitcoin?: unknown
      }
      ethereum?: unknown
    }
    return {
      zcashRequestType: typeof target.noirwallet?.zcash?.request,
      hasNoirEthereum: target.noirwallet?.ethereum !== undefined,
      hasNoirBitcoin: target.noirwallet?.bitcoin !== undefined,
      hasDefaultEthereum: target.ethereum !== undefined,
      announcementCount: announcements.length
    }
  })

  expect(result).toEqual({
    zcashRequestType: 'function',
    hasNoirEthereum: false,
    hasNoirBitcoin: false,
    hasDefaultEthereum: false,
    announcementCount: 0
  })
  await page.close()
})

test('enforces trusted Storage, dApp origin, and Background-only Worker routing', async ({
  context,
  extensionId,
  popup
}) => {
  await expect
    .poll(() =>
      popup.evaluate(() =>
        chrome.runtime.sendMessage({
          type: 'WORKER_RPC',
          method: 'worker.recreate',
          payload: {}
        })
      )
    )
    .toEqual({ result: true })

  await expect
    .poll(() =>
      popup.evaluate(() =>
        chrome.runtime.sendMessage({
          type: 'KEYRING_WORKER_RPC',
          method: 'worker.recreate',
          payload: {}
        })
      )
    )
    .toEqual({ error: 'Unauthorized Worker RPC sender' })

  await expect
    .poll(() =>
      popup.evaluate(() =>
        chrome.runtime.sendMessage({
          type: 'WORKER_RPC',
          method: 'multichain.unknown',
          payload: {}
        })
      )
    )
    .toEqual({ error: 'Unsupported Multichain Worker RPC method' })

  for (const operation of ['account.derive-public', 'signing.prepare']) {
    await expect(
      popup.evaluate(
        currentOperation =>
          chrome.runtime.sendMessage({
            type: 'WORKER_RPC',
            method: 'multichain.execute',
            payload: {
              command: {
                protocolVersion: 2,
                commandId: `keyring-command:release-gate:${currentOperation}`,
                engine: 'multichain',
                operation: currentOperation,
                binding: {
                  kind: 'credential',
                  keyDomainId: 'key-domain:release-gate',
                  credentialGenerationId: 'credential-generation:release-gate',
                  globalUnlockEpoch: 'global-unlock:release-gate'
                },
                deadlineAt: Date.now() + 60_000,
                payload: {}
              }
            }
          }),
        operation
      )
    ).resolves.toEqual({ error: 'Multichain capability is Background-only' })
  }

  await expect(
    popup.evaluate(() =>
      chrome.runtime.sendMessage({
        type: 'WORKER_RPC',
        method: 'multichain.restart',
        payload: {}
      })
    )
  ).resolves.toEqual({ error: 'Unsupported Multichain Worker RPC method' })

  const maliciousPage = await context.newPage()
  const { cdp, contentScriptContextId } = await openMaliciousPage(maliciousPage, extensionId)

  const validDAppResponse = await evaluateInContext<Record<string, unknown>>(
    cdp,
    contentScriptContextId,
    `chrome.runtime.sendMessage({
      type: 'DAPP_REQUEST',
      requestId: 'security-valid-request',
      chainId: 'zcash',
      request: { method: 'zcash_getAccounts' }
    })`
  )
  expect(validDAppResponse?.error).not.toBe('Unauthorized dApp request sender')
  expect(validDAppResponse?.error).not.toBe('Invalid dApp request')

  const forgedOriginResponse = await evaluateInContext<{ error?: string }>(
    cdp,
    contentScriptContextId,
    `chrome.runtime.sendMessage({
      type: 'DAPP_REQUEST',
      requestId: 'security-forged-origin',
      chainId: 'zcash',
      origin: 'https://forged.example',
      request: { method: 'zcash_getAccounts' }
    })`
  )
  expect(forgedOriginResponse).toEqual({
    requestId: 'security-forged-origin',
    error: 'Invalid dApp request'
  })

  const rawWorkerResponse = await evaluateInContext<{ error?: string }>(
    cdp,
    contentScriptContextId,
    `chrome.runtime.sendMessage({
      type: 'WORKER_RPC',
      method: 'worker.recreate',
      payload: {}
    })`
  )
  expect(rawWorkerResponse).toEqual({ error: 'Unauthorized Worker RPC sender' })

  const forgedManagementResponse = await evaluateInContext<unknown>(
    cdp,
    contentScriptContextId,
    `chrome.runtime.sendMessage({ type: 'WALLET_LOCKED' })`
  )
  expect(forgedManagementResponse).toBeUndefined()

  const forgedApprovalResponse = await evaluateInContext<unknown>(
    cdp,
    contentScriptContextId,
    `chrome.runtime.sendMessage({
      type: 'DAPP_APPROVAL_RESULT',
      requestId: 'forged-request',
      success: true
    })`
  )
  expect(forgedApprovalResponse).toBeUndefined()

  const storageAccess = await evaluateInContext<{
    local: { value?: unknown; error?: string; available?: boolean }
    session: { value?: unknown; error?: string; available?: boolean }
  }>(
    cdp,
    contentScriptContextId,
    `(async () => {
      const read = async area => {
        if (!chrome.storage || !chrome.storage[area]) return { available: false }
        try {
          return { value: await chrome.storage[area].get(null) }
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) }
        }
      }
      return {
        local: await read('local'),
        session: await read('session')
      }
    })()`
  )
  expect(storageAccess.local.value).toBeUndefined()
  expect(storageAccess.session.value).toBeUndefined()
  expect(storageAccess.local.available === false || storageAccess.local.error).toBeTruthy()
  expect(storageAccess.session.available === false || storageAccess.session.error).toBeTruthy()

  await cdp.detach()
  await maliciousPage.close()
})

test('fails closed for unbound persisted dApp permissions after Background reconstruction', async ({
  context,
  extensionId,
  popup
}) => {
  test.setTimeout(120_000)
  await importTestWallet(popup)
  const active = await popup.evaluate(async () => {
    const stored = (await chrome.storage.local.get('wallet_state')).wallet_state
    const walletState = typeof stored === 'string' ? JSON.parse(stored) : stored
    return {
      walletId: walletState?.state?.currentWalletId,
      accountId: walletState?.state?.currentAccountId
    }
  })
  expect(active).toEqual({ walletId: expect.any(String), accountId: expect.any(String) })

  const origin = 'https://security.noir.test'
  const persistedConnection = {
    id: 'dapp-security-persisted',
    name: 'Security fixture',
    host: 'security.noir.test',
    origin,
    favicon: '',
    connectedAt: 1_700_000_000_000,
    lastActiveAt: 1_700_000_000_000
  }
  const dappPage = await context.newPage()
  const { cdp, contentScriptContextId } = await openMaliciousPage(dappPage, extensionId)

  await popup.evaluate(
    connection => chrome.storage.local.set({ connectedDApps: [connection] }),
    persistedConnection
  )
  await terminateServiceWorker(context, popup)
  const denied = await evaluateInContext<Record<string, unknown>>(
    cdp,
    contentScriptContextId,
    `chrome.runtime.sendMessage({
      type: 'DAPP_REQUEST',
      requestId: 'security-unbound-permission',
      chainId: 'zcash',
      request: { method: 'zcash_getAccounts' }
    })`
  )
  expect(denied).toEqual({ requestId: 'security-unbound-permission', result: null })

  await popup.evaluate(
    ({ connection, binding }) =>
      chrome.storage.local.set({
        connectedDApps: [
          {
            ...connection,
            boundWalletId: binding.walletId,
            boundAccountId: binding.accountId
          }
        ]
      }),
    { connection: persistedConnection, binding: active }
  )
  await terminateServiceWorker(context, popup)
  const legacy = await evaluateInContext<Record<string, unknown>>(
    cdp,
    contentScriptContextId,
    `chrome.runtime.sendMessage({
      type: 'DAPP_REQUEST',
      requestId: 'security-legacy-permission',
      chainId: 'zcash',
      request: { method: 'zcash_getAccounts' }
    })`
  )
  expect(legacy).toMatchObject({
    requestId: 'security-legacy-permission',
    result: {
      transparent: expect.stringMatching(/^t/),
      shielded: expect.stringMatching(/^u/),
      accounts: [expect.any(Object)]
    }
  })

  await popup.evaluate(
    ({ connection, binding }) =>
      chrome.storage.local.set({
        connectedDApps: [
          {
            ...connection,
            boundWalletId: binding.walletId,
            boundAccountId: binding.accountId
          },
          {
            ...connection,
            id: 'dapp-security-corrupt',
            origin: 'https://corrupt.noir.test',
            host: 'another-host.noir.test',
            boundWalletId: binding.walletId,
            boundAccountId: binding.accountId
          }
        ]
      }),
    { connection: persistedConnection, binding: active }
  )
  await terminateServiceWorker(context, popup)
  const isolated = await evaluateInContext<Record<string, unknown>>(
    cdp,
    contentScriptContextId,
    `chrome.runtime.sendMessage({
      type: 'DAPP_REQUEST',
      requestId: 'security-isolated-permission',
      chainId: 'zcash',
      request: { method: 'zcash_getAccounts' }
    })`
  )
  expect(isolated).toMatchObject({
    requestId: 'security-isolated-permission',
    result: { accounts: [expect.any(Object)] }
  })

  await popup.evaluate(
    ({ connection, binding }) => {
      const valid = {
        ...connection,
        boundWalletId: binding.walletId,
        boundAccountId: binding.accountId
      }
      return chrome.storage.local.set({
        connectedDApps: [valid, { ...valid, id: 'dapp-security-duplicate' }]
      })
    },
    { connection: persistedConnection, binding: active }
  )
  await terminateServiceWorker(context, popup)
  const duplicate = await evaluateInContext<Record<string, unknown>>(
    cdp,
    contentScriptContextId,
    `chrome.runtime.sendMessage({
      type: 'DAPP_REQUEST',
      requestId: 'security-duplicate-permission',
      chainId: 'zcash',
      request: { method: 'zcash_getAccounts' }
    })`
  )
  expect(duplicate).toEqual({ requestId: 'security-duplicate-permission', result: null })

  await popup.evaluate(() => chrome.storage.local.remove('connectedDApps'))
  await cdp.detach()
  await dappPage.close()
})
