import type { BrowserContext, Page, Worker } from '@playwright/test'
import { getDefaultEvmRpcEndpoint } from '../../src/config/rpc-endpoints'
import { expect, test, waitForBackgroundWalletInitialization } from '../helpers/extension-fixtures'

const ethereumMainnetRpcHost = new URL(getDefaultEvmRpcEndpoint('mainnet', 'eip155:1').url).host
const ethereumMainnetRpcRoute = (url: URL) => url.host === ethereumMainnetRpcHost

async function getExtensionWorker(context: BrowserContext): Promise<Worker> {
  return context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
}

async function getActivityNotifications(page: Page): Promise<string[]> {
  return page.evaluate(async () =>
    Object.keys(await chrome.notifications.getAll()).filter(id =>
      id.startsWith('activity-transaction:')
    )
  )
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

test('persists V2 transaction graphs, events, indexes, and CAS across reloads', async ({
  popup,
  extensionId
}) => {
  const databaseName = `transaction-v2-e2e-${crypto.randomUUID()}`
  await popup.goto(
    `chrome-extension://${extensionId}/tests/extension/transaction-repository-integration.html`
  )
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.transactionRepositoryIntegration)))
    .toBe(true)

  const initialized = await popup.evaluate(name => {
    return window.transactionRepositoryIntegration!.initialize(name)
  }, databaseName)
  expect(initialized).toEqual({
    createStatuses: ['created', 'already-exists', 'id-conflict'],
    eventStatuses: ['applied', 'duplicate-event', 'event-conflict', 'ignored-stale'],
    raceStatuses: ['applied', 'revision-conflict']
  })

  await popup.reload()
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.transactionRepositoryIntegration)))
    .toBe(true)
  const persisted = await popup.evaluate(name => {
    return window.transactionRepositoryIntegration!.inspect(name)
  }, databaseName)
  expect(persisted).toEqual({
    all: ['transaction:eth', 'transaction:main', 'transaction:race'],
    ethereum: ['transaction:eth'],
    broadcastMainIncluded: true,
    mainStatus: 'broadcast',
    crossAccountVisible: false,
    hasBroadcastEvent: true
  })

  await expect(
    popup.evaluate(
      name => window.transactionRepositoryIntegration!.deleteAccount(name),
      databaseName
    )
  ).resolves.toEqual({ deleted: 3, accountOne: 0, accountTwo: 1 })
  await popup.evaluate(name => window.transactionRepositoryIntegration!.reset(name), databaseName)
})

test('invalidates affected Portfolio chains only after durable transaction changes', async ({
  popup,
  extensionId
}) => {
  const databaseName = `transaction-portfolio-invalidation-${crypto.randomUUID()}`
  await popup.goto(
    `chrome-extension://${extensionId}/tests/extension/transaction-repository-integration.html`
  )
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.transactionRepositoryIntegration)))
    .toBe(true)
  await expect(
    popup.evaluate(
      name =>
        window.transactionRepositoryIntegration!.inspectTransactionPortfolioInvalidations(name),
      databaseName
    )
  ).resolves.toEqual({
    statuses: ['created', 'applied', 'duplicate-event', 'applied', 'applied', 'created'],
    committedBeforeNotification: 'broadcast',
    waitedForNotification: true,
    events: [
      {
        network: 'mainnet',
        keyDomainId: 'key-domain:1',
        accountId: 'account:1',
        chainIds: ['eip155:1']
      },
      {
        network: 'mainnet',
        keyDomainId: 'key-domain:1',
        accountId: 'account:1',
        chainIds: ['eip155:1']
      }
    ],
    persistedStatus: 'confirming'
  })
})

test('finds an older Confidential graph through the MV3 IndexedDB repository', async ({
  popup,
  extensionId
}) => {
  const databaseName = `transaction-v2-confidential-${crypto.randomUUID()}`
  await popup.goto(
    `chrome-extension://${extensionId}/tests/extension/transaction-repository-integration.html`
  )
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.transactionRepositoryIntegration)))
    .toBe(true)
  await expect(
    popup.evaluate(
      name => window.transactionRepositoryIntegration!.inspectOlderConfidentialGraph(name),
      databaseName
    )
  ).resolves.toEqual({
    hiddenFromRecent: true,
    confidentialIds: ['transaction:confidential-old']
  })
})

test('persists and replaces generation-bound Portfolio cache records', async ({
  popup,
  extensionId
}) => {
  const databaseName = `portfolio-v2-e2e-${crypto.randomUUID()}`
  await popup.goto(
    `chrome-extension://${extensionId}/tests/extension/transaction-repository-integration.html`
  )
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.transactionRepositoryIntegration)))
    .toBe(true)
  await expect(
    popup.evaluate(name => {
      return window.transactionRepositoryIntegration!.initializePortfolioCache(name)
    }, databaseName)
  ).resolves.toMatchObject({
    cachedAt: 2_200,
    source: { status: 'loading', balances: [{ totalRaw: '2' }] }
  })

  await popup.reload()
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.transactionRepositoryIntegration)))
    .toBe(true)
  await expect(
    popup.evaluate(name => {
      return window.transactionRepositoryIntegration!.inspectPortfolioCache(name)
    }, databaseName)
  ).resolves.toEqual({
    records: [{ cachedAt: 2_200, status: 'loading', totalRaw: '2', errorCode: undefined }],
    deleted: 1,
    remaining: 0
  })
  await popup.evaluate(name => window.transactionRepositoryIntegration!.reset(name), databaseName)
})

test('reuses only matching Portfolio balances across account switch generations in IndexedDB', async ({
  popup,
  extensionId
}) => {
  const databaseName = `portfolio-account-switch-e2e-${crypto.randomUUID()}`
  await popup.goto(
    `chrome-extension://${extensionId}/tests/extension/transaction-repository-integration.html`
  )
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.transactionRepositoryIntegration)))
    .toBe(true)
  await popup.evaluate(
    name => window.transactionRepositoryIntegration!.initializeAccountSwitchPortfolioCache(name),
    databaseName
  )

  await popup.reload()
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.transactionRepositoryIntegration)))
    .toBe(true)
  await expect(
    popup.evaluate(
      name => window.transactionRepositoryIntegration!.inspectAccountSwitchPortfolioCache(name),
      databaseName
    )
  ).resolves.toEqual({
    exact: {
      generationId: 'metadata:portfolio:account-switch:1',
      cachedAt: 2_900,
      status: 'ready',
      totalRaw: '1',
      balanceUpdatedAt: 2_000,
      errorCode: undefined
    },
    fallback: {
      generationId: 'metadata:portfolio:account-switch:2',
      cachedAt: 3_100,
      status: 'loading',
      totalRaw: '2',
      balanceUpdatedAt: 2_000,
      errorCode: undefined
    },
    historicalError: {
      generationId: 'metadata:portfolio:account-switch:2',
      cachedAt: 3_200,
      status: 'error',
      totalRaw: '7',
      balanceUpdatedAt: 2_000,
      errorCode: 'rate-limited'
    },
    changedIdentity: null,
    unrelatedAccount: null
  })
  await popup.evaluate(name => window.transactionRepositoryIntegration!.reset(name), databaseName)
})

test('resumes scoped Portfolio invalidations and preserves a newer revision', async ({
  popup,
  extensionId
}) => {
  const databaseName = `portfolio-invalidations-e2e-${crypto.randomUUID()}`
  await popup.goto(
    `chrome-extension://${extensionId}/tests/extension/transaction-repository-integration.html`
  )
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.transactionRepositoryIntegration)))
    .toBe(true)
  const old = await popup.evaluate(
    name => window.transactionRepositoryIntegration!.initializePortfolioInvalidations(name),
    databaseName
  )
  if (!old) throw new Error('Portfolio invalidation marker was not persisted')

  await popup.reload()
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.transactionRepositoryIntegration)))
    .toBe(true)
  const result = await popup.evaluate(
    ({ name, marker }) =>
      window.transactionRepositoryIntegration!.inspectPortfolioInvalidations(name, marker),
    { name: databaseName, marker: old }
  )
  expect(result.resumed).toEqual(
    expect.arrayContaining([
      { chainId: 'eip155:1', domain: 'chain', revision: 1, invalidatedAt: 3_000 },
      { chainId: 'near:mainnet', domain: 'confidential', revision: 1, invalidatedAt: 3_100 }
    ])
  )
  expect(result.resumed).toHaveLength(2)
  expect(result.afterOldAcknowledgement).toEqual(
    expect.arrayContaining([
      { chainId: 'eip155:1', domain: 'chain', revision: 2, invalidatedAt: 3_200 },
      { chainId: 'near:mainnet', domain: 'confidential', revision: 1, invalidatedAt: 3_100 }
    ])
  )
  expect(result.afterOldAcknowledgement).toHaveLength(2)
  expect(result).toMatchObject({ deleted: 2, remaining: [] })
  await popup.evaluate(name => window.transactionRepositoryIntegration!.reset(name), databaseName)
})

test('refreshes the active EVM Portfolio through the real MV3 service worker', async ({
  context,
  popup,
  extensionId
}) => {
  await waitForBackgroundWalletInitialization(popup)
  const rpcMethods: string[] = []
  await context.route(ethereumMainnetRpcRoute, async route => {
    const request = route.request().postDataJSON() as { id: number; method: string }
    rpcMethods.push(request.method)
    const result =
      request.method === 'eth_chainId'
        ? '0x1'
        : request.method === 'eth_getBalance'
          ? '0xde0b6b3a7640000'
          : request.method === 'eth_call'
            ? `0x${2_000_000n.toString(16).padStart(64, '0')}`
            : null
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id: request.id, result })
    })
  })

  await popup.goto(
    `chrome-extension://${extensionId}/tests/extension/transaction-repository-integration.html`
  )
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.transactionRepositoryIntegration)))
    .toBe(true)
  await expect(
    popup.evaluate(() =>
      window.transactionRepositoryIntegration!.initializeProductionEvmPortfolio()
    )
  ).resolves.toBe('committed')

  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  const requestPortfolio = (action: 'read' | 'refresh') =>
    popup.evaluate(requestedAction => {
      return chrome.runtime.sendMessage({
        type: 'GET_EVM_PORTFOLIO',
        action: requestedAction
      })
    }, action)

  await expect(requestPortfolio('read')).resolves.toMatchObject({
    result: { status: 'loading', chains: [{ status: 'loading', assets: [] }] }
  })
  await expect(requestPortfolio('refresh')).resolves.toMatchObject({
    result: {
      status: 'ready',
      assets: [
        { metadata: { symbol: 'ETH' }, balance: { totalRaw: '1000000000000000000' } },
        { metadata: { symbol: 'USDC' }, balance: { totalRaw: '2000000' } }
      ]
    }
  })
  await expect(requestPortfolio('read')).resolves.toMatchObject({
    result: {
      status: 'ready',
      assets: [{ freshness: 'fresh' }, { freshness: 'fresh' }]
    }
  })
  expect(rpcMethods.sort()).toEqual(['eth_call', 'eth_chainId', 'eth_getBalance'])

  await popup.goto(
    `chrome-extension://${extensionId}/tests/extension/transaction-repository-integration.html`
  )
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.transactionRepositoryIntegration)))
    .toBe(true)
  await expect(
    popup.evaluate(() =>
      window.transactionRepositoryIntegration!.inspectProductionEvmPortfolioCache()
    )
  ).resolves.toEqual({
    generationId: 'metadata:portfolio:production-e2e',
    status: 'ready',
    balances: [
      { assetId: 'eip155:1/slip44:60', totalRaw: '1000000000000000000' },
      {
        assetId: 'eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        totalRaw: '2000000'
      }
    ]
  })
  await popup.evaluate(() => window.transactionRepositoryIntegration!.resetProductionEvmPortfolio())
})

test('reads unified Activity through the real MV3 service worker', async ({
  context,
  popup,
  extensionId
}) => {
  await waitForBackgroundWalletInitialization(popup)
  await context.route('https://history-proxy.zknoir.com/**', async route => {
    const request = route.request().postDataJSON() as { id: number }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: { transactions: [], transfers: [] }
      })
    })
  })
  await popup.goto(
    `chrome-extension://${extensionId}/tests/extension/transaction-repository-integration.html`
  )
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.transactionRepositoryIntegration)))
    .toBe(true)
  await popup.evaluate(() =>
    window.transactionRepositoryIntegration!.initializeProductionActivity()
  )

  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(
    popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_ACTIVITY' }))
  ).resolves.toMatchObject({
    result: {
      scope: {
        keyDomainId: 'key-domain:portfolio',
        accountId: 'account:portfolio'
      },
      partialItemCount: 0,
      items: [
        {
          id: 'zcash-v1:activity:production-e2e',
          source: 'zcash-v1',
          status: 'final',
          snapshot: {
            direction: 'incoming',
            primaryAmount: { amountRaw: '50000000' }
          }
        },
        {
          id: 'transaction:activity:production-e2e',
          source: 'wallet-v2',
          status: 'signed',
          snapshot: {
            direction: 'outgoing',
            primaryAmount: {
              assetId: 'eip155:1/slip44:60',
              amountRaw: '1000000000000000000'
            }
          }
        }
      ]
    }
  })
  expect(await getActivityNotifications(popup)).toEqual([])

  await popup.goto(
    `chrome-extension://${extensionId}/tests/extension/transaction-repository-integration.html`
  )
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.transactionRepositoryIntegration)))
    .toBe(true)
  await popup.evaluate(() => window.transactionRepositoryIntegration!.resetProductionActivity())
})

test('detects a new external receipt with the wallet tab closed', async ({
  context,
  popup,
  extensionId
}) => {
  test.skip(
    !process.env.ENABLED_CHAIN_FEATURE_FLAGS?.split(',').includes('chain.evm'),
    'Requires a build with the EVM Activity history source enabled'
  )
  test.setTimeout(90_000)
  const worker = await getExtensionWorker(context)
  await waitForBackgroundWalletInitialization(popup)
  await worker.evaluate(() => {
    const create = chrome.notifications.create.bind(chrome.notifications)
    chrome.notifications.create = ((
      id: string,
      options: chrome.notifications.NotificationOptions
    ) => {
      Object.assign(globalThis, {
        lastActivityNotification: { title: options.title, message: options.message }
      })
      return create(id, options)
    }) as typeof chrome.notifications.create
  })
  const baselineKey =
    'activity-notifications:["mainnet","key-domain:portfolio","account:portfolio"]'
  const incoming = (timestamp: number, character: string) => ({
    blockchain: 'eth',
    hash: `0x${character.repeat(64)}`,
    blockHash: `0x${'b'.repeat(64)}`,
    blockNumber: '0x64',
    from: `0x${'2'.repeat(40)}`,
    to: `0x${'1'.repeat(40)}`,
    value: '0x16345785d8a0000',
    gasPrice: '0x2',
    gasUsed: '0x5208',
    nonce: '0x1',
    timestamp: `0x${Math.floor(timestamp / 1000).toString(16)}`,
    status: '0x1',
    input: '0x'
  })
  const transactions = [incoming(Date.now() - 86_400_000, 'a')]
  let historyAvailable = false
  await context.route('https://history-proxy.zknoir.com/**', async route => {
    if (!historyAvailable) {
      await route.fulfill({ status: 503 })
      return
    }
    const request = route.request().postDataJSON() as {
      id: number
      method: string
      params?: { blockchain?: string[] }
    }
    await route.fulfill({
      json: {
        jsonrpc: '2.0',
        id: request.id,
        result:
          request.method === 'ankr_getTransactionsByAddress'
            ? { transactions: request.params?.blockchain?.includes('eth') ? transactions : [] }
            : { transfers: [] }
      }
    })
  })
  await popup.goto(
    `chrome-extension://${extensionId}/tests/extension/transaction-repository-integration.html`
  )
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.transactionRepositoryIntegration)))
    .toBe(true)
  await popup.evaluate(() =>
    window.transactionRepositoryIntegration!.initializeProductionActivity()
  )
  const alarm = () =>
    worker.evaluate(async () => {
      const name = 'activity-receipts'
      const fired = new Promise<void>(resolve => {
        const listener = (alarm: chrome.alarms.Alarm) => {
          if (alarm.name !== name) return
          chrome.alarms.onAlarm.removeListener(listener)
          resolve()
        }
        chrome.alarms.onAlarm.addListener(listener)
      })
      await chrome.alarms.create(name, { when: Date.now() + 1_000 })
      await fired
    })
  await expect
    .poll(() =>
      worker.evaluate(async () => (await chrome.alarms.get('activity-receipts'))?.periodInMinutes)
    )
    .toBe(5)
  await alarm()
  await expect
    .poll(
      () =>
        worker.evaluate(
          async key => (await chrome.storage.local.get(key))[key]?.receiptBaselines,
          baselineKey
        ),
      { timeout: 35_000 }
    )
    .toEqual({})
  transactions.push(incoming(Date.now(), 'd'))
  historyAvailable = true
  await popup.evaluate(() =>
    window.transactionRepositoryIntegration!.expireProductionActivityHistory()
  )
  await alarm()
  await expect
    .poll(
      () =>
        worker.evaluate(
          async key =>
            (await chrome.storage.local.get(key))[key]?.receiptBaselines?.['eip155:1:main'],
          baselineKey
        ),
      { timeout: 35_000 }
    )
    .toEqual(expect.any(Number))
  expect(await getActivityNotifications(popup)).toEqual([])
  await popup.evaluate(() =>
    window.transactionRepositoryIntegration!.expireProductionActivityHistory()
  )
  await popup.close()
  transactions.push(incoming(Math.ceil(Date.now() / 1000) * 1000, 'c'))
  await alarm()
  await expect
    .poll(
      () =>
        worker.evaluate(async () =>
          Object.keys(await chrome.notifications.getAll()).filter(id =>
            id.startsWith('activity-transaction:')
          )
        ),
      { timeout: 35_000 }
    )
    .toHaveLength(1)
  expect(await worker.evaluate(() => Reflect.get(globalThis, 'lastActivityNotification'))).toEqual({
    title: 'Transaction update',
    message: 'Open Activity for details.'
  })

  const fixture = await context.newPage()
  await fixture.goto(
    `chrome-extension://${extensionId}/tests/extension/transaction-repository-integration.html`
  )
  const [noticeId] = await getActivityNotifications(fixture)
  expect(noticeId).toBeTruthy()
  const [activityTab] = await Promise.all([
    context.waitForEvent('page'),
    fixture.evaluate(
      id => window.transactionRepositoryIntegration!.openProductionActivityNotification(id),
      noticeId
    )
  ])
  await expect(activityTab).toHaveURL(url => {
    const query = new URLSearchParams(url.hash.slice(3))
    return (
      query.get('tab') === 'activity' &&
      query.get('transactionId') === `rpc:evm:eip155:1:0x${'c'.repeat(64)}:native`
    )
  })
})

test('runs the persisted EVM receipt monitor inside the real MV3 service worker', async ({
  context,
  popup,
  extensionId
}) => {
  await waitForBackgroundWalletInitialization(popup)
  const transactionHash = `0x${'a'.repeat(64)}`
  const blockHash = `0x${'b'.repeat(64)}`
  await context.route(ethereumMainnetRpcRoute, async route => {
    const request = route.request().postDataJSON() as {
      id: number
      method: string
    }
    const result =
      request.method === 'eth_chainId'
        ? '0x1'
        : request.method === 'eth_getTransactionReceipt'
          ? {
              transactionHash,
              blockHash,
              blockNumber: '0x65',
              status: '0x1',
              logs: []
            }
          : request.method === 'eth_getBlockByNumber'
            ? { number: '0x65' }
            : null
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id: request.id, result })
    })
  })

  await popup.goto(
    `chrome-extension://${extensionId}/tests/extension/transaction-repository-integration.html`
  )
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.transactionRepositoryIntegration)))
    .toBe(true)
  await expect(
    popup.evaluate(hash => {
      return window.transactionRepositoryIntegration!.initializeProductionEvmMonitor(hash)
    }, transactionHash)
  ).resolves.toBe('created')

  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  const receiptPoll = await popup.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'WORKER_RPC',
      method: 'evm.conformance-poll',
      payload: { scopes: [{ keyDomainId: 'key-domain:1', accountId: 'account:1' }] }
    })
  )
  expect(receiptPoll).toMatchObject({ result: { errors: 0 } })
  expect(receiptPoll.result.checked).toBeLessThanOrEqual(1)
  expect(receiptPoll.result.applied + receiptPoll.result.unchanged).toBe(receiptPoll.result.checked)
  await popup.goto(
    `chrome-extension://${extensionId}/tests/extension/transaction-repository-integration.html`
  )
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.transactionRepositoryIntegration)))
    .toBe(true)
  await expect(
    popup.evaluate(() => window.transactionRepositoryIntegration!.inspectProductionEvmMonitor())
  ).resolves.toEqual({
    rootStatus: 'final',
    segmentStatus: 'final',
    blockHash,
    blockHeight: 101
  })
  await expect.poll(() => getActivityNotifications(popup)).toHaveLength(1)
  await popup.evaluate(() => window.transactionRepositoryIntegration!.resetProductionEvmMonitor())
})

test('resumes the persisted EVM receipt monitor after service worker reconstruction', async ({
  context,
  popup,
  extensionId
}) => {
  const transactionHash = `0x${'c'.repeat(64)}`
  const blockHash = `0x${'d'.repeat(64)}`
  const rpcMethods: string[] = []
  await context.route(ethereumMainnetRpcRoute, async route => {
    const request = route.request().postDataJSON() as { id: number; method: string }
    rpcMethods.push(request.method)
    const result =
      request.method === 'eth_chainId'
        ? '0x1'
        : request.method === 'eth_getTransactionReceipt'
          ? {
              transactionHash,
              blockHash,
              blockNumber: '0x65',
              status: '0x1',
              logs: []
            }
          : request.method === 'eth_getBlockByNumber'
            ? { number: '0x65' }
            : null
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id: request.id, result })
    })
  })

  await popup.goto(
    `chrome-extension://${extensionId}/tests/extension/transaction-repository-integration.html`
  )
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.transactionRepositoryIntegration)))
    .toBe(true)
  await expect(
    popup.evaluate(hash => {
      return window.transactionRepositoryIntegration!.initializeProductionEvmMonitor(hash)
    }, transactionHash)
  ).resolves.toBe('created')

  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await terminateServiceWorker(context, popup)
  await expect
    .poll(() =>
      popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_WALLET_SESSION_STATE' }))
    )
    .toEqual({ active: false })
  await popup.goto(
    `chrome-extension://${extensionId}/tests/extension/transaction-repository-integration.html`
  )
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.transactionRepositoryIntegration)))
    .toBe(true)
  await expect
    .poll(
      () =>
        popup.evaluate(() =>
          window.transactionRepositoryIntegration!.inspectProductionEvmMonitor()
        ),
      { timeout: 20_000 }
    )
    .toMatchObject({
      rootStatus: 'final',
      segmentStatus: 'final',
      blockHash,
      blockHeight: 101
    })
  expect(rpcMethods).toContain('eth_getTransactionReceipt')
  await expect.poll(() => getActivityNotifications(popup)).toHaveLength(1)
  await terminateServiceWorker(context, popup)
  await popup.reload()
  expect(await getActivityNotifications(popup)).toHaveLength(1)
  await popup.evaluate(() => window.transactionRepositoryIntegration!.resetProductionEvmMonitor())
})
