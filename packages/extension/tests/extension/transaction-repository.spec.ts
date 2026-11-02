import type { BrowserContext, Page, Worker } from '@playwright/test'
import { expect, test } from '../helpers/extension-fixtures'

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
    cachedAt: 2_100,
    source: { status: 'error', errorCode: 'rate-limited', balances: [{ totalRaw: '2' }] }
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
    records: [{ cachedAt: 2_100, status: 'error', totalRaw: '2', errorCode: 'rate-limited' }],
    deleted: 1,
    remaining: 0
  })
  await popup.evaluate(name => window.transactionRepositoryIntegration!.reset(name), databaseName)
})

test('refreshes the active EVM Portfolio through the real MV3 service worker', async ({
  context,
  popup,
  extensionId
}) => {
  const rpcMethods: string[] = []
  await context.route('https://eth.deltarpc.com/**', async route => {
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
  popup,
  extensionId
}) => {
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

  await popup.goto(
    `chrome-extension://${extensionId}/tests/extension/transaction-repository-integration.html`
  )
  await expect
    .poll(() => popup.evaluate(() => Boolean(window.transactionRepositoryIntegration)))
    .toBe(true)
  await popup.evaluate(() => window.transactionRepositoryIntegration!.resetProductionActivity())
})

test('runs the persisted EVM receipt monitor inside the real MV3 service worker', async ({
  context,
  popup,
  extensionId
}) => {
  const transactionHash = `0x${'a'.repeat(64)}`
  const blockHash = `0x${'b'.repeat(64)}`
  await context.route('https://eth.deltarpc.com/**', async route => {
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
              status: '0x1'
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
  await context.route('https://eth.deltarpc.com/**', async route => {
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
              status: '0x1'
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
  await popup.evaluate(() => window.transactionRepositoryIntegration!.resetProductionEvmMonitor())
})
