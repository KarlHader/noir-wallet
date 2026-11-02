import {
  BITCOIN_MAINNET_CHAIN_ID,
  EVM_HISTORY_PROXY_ORIGINS,
  bitcoinEnabled,
  captureScreenshot,
  expect,
  importTestWallet,
  mockEvmHistoryProxy,
  mockReleasedBitcoinEsplora,
  mockReleasedEvmRpc,
  seedFreshAssetPrices,
  terminateExtensionServiceWorker,
  test,
  waitForBackgroundWalletInitialization
} from '../../helpers/release-default'

test('loads a quiet chain when another chain fills the shared History page', async ({
  context,
  popup
}) => {
  test.setTimeout(120_000)
  const requests = await mockEvmHistoryProxy(context, 0, true)
  await mockReleasedEvmRpc(context)
  await mockReleasedBitcoinEsplora(context)
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  const chains = await popup.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({
      type: 'GET_ACTIVITY',
      action: 'refresh',
      executionMode: 'main',
      chainIds: ['eip155:1', 'eip155:8453']
    })
    if (response.error) throw new Error('Activity refresh failed')
    return response.result.items.flatMap(
      (item: { segments: Array<{ target: { kind: string; chainId?: string } }> }) =>
        item.segments.flatMap(segment =>
          segment.target.kind === 'onchain' ? [segment.target.chainId] : []
        )
    ) as string[]
  })
  expect(chains).toContain('eip155:1')
  expect(chains).toContain('eip155:8453')
  expect(
    requests.some(
      request =>
        request.method === 'ankr_getTransactionsByAddress' &&
        request.blockchains.length === 1 &&
        request.blockchains[0] === 'base'
    )
  ).toBe(true)
  await popup.getByRole('tab', { name: 'Activity' }).click()
  await expect(popup.getByText('+0.001 ETH', { exact: true })).toBeVisible()
  await captureScreenshot(popup, 'history-quiet-chain-after-shared-page.png')
})

test('keeps equal EVM transaction hashes from different chains in Activity', async ({
  context,
  popup
}) => {
  test.setTimeout(120_000)
  await mockEvmHistoryProxy(context, 0, true, true)
  await mockReleasedEvmRpc(context)
  await mockReleasedBitcoinEsplora(context)
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)

  const matchingItems = await popup.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({
      type: 'GET_ACTIVITY',
      action: 'refresh',
      executionMode: 'main',
      chainIds: ['eip155:1', 'eip155:8453']
    })
    if (response.error) throw new Error('Activity refresh failed')
    return response.result.items
      .filter((item: { segments: Array<{ evidence?: { transactionHash?: string } }> }) =>
        item.segments.some(segment => segment.evidence?.transactionHash === '0x' + 'a'.repeat(64))
      )
      .map((item: { id: string; segments: Array<{ target: { chainId?: string } }> }) => ({
        id: item.id,
        chainId: item.segments[0]?.target.chainId
      }))
  })
  expect(matchingItems).toEqual(
    expect.arrayContaining([
      { id: `rpc:evm:eip155:1:0x${'a'.repeat(64)}:native`, chainId: 'eip155:1' },
      { id: `rpc:evm:eip155:8453:0x${'a'.repeat(64)}:native`, chainId: 'eip155:8453' }
    ])
  )
  expect(matchingItems).toHaveLength(2)
  await popup.getByRole('tab', { name: 'Activity' }).click()
  for (const item of matchingItems) {
    await expect(popup.locator(`[data-activity-id="${item.id}"]`)).toBeVisible()
  }
  await captureScreenshot(popup, 'history-equal-evm-hashes-two-chains.png')
})

test('retains a persisted wallet transaction when EVM History returns 503', async ({
  context,
  popup
}) => {
  test.setTimeout(120_000)
  await mockEvmHistoryProxy(context)
  await mockReleasedEvmRpc(context)
  await mockReleasedBitcoinEsplora(context)
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)

  const localId = await popup.evaluate(async () => {
    const activity = await chrome.runtime.sendMessage({
      type: 'GET_ACTIVITY',
      action: 'refresh',
      executionMode: 'main',
      chainIds: ['eip155:1']
    })
    if (activity.error) throw new Error('Activity refresh failed')
    const scope = activity.result.scope as { keyDomainId: string; accountId: string }
    const transactionId = 'transaction:history-local-fallback'
    const segmentId = 'segment:history-local-fallback'
    const now = Date.now()
    const graph = {
      root: {
        id: transactionId,
        scope,
        kind: 'transfer',
        status: 'broadcast',
        segmentIds: [segmentId],
        createdAt: now,
        updatedAt: now,
        revision: 0,
        intent: {
          schemaVersion: 1,
          direction: 'outgoing',
          primaryAmount: { assetId: 'eip155:1/slip44:60', amountRaw: '2000000000000000' }
        }
      },
      segments: [
        {
          id: segmentId,
          transactionId,
          role: 'origin',
          target: { kind: 'onchain', chainId: 'eip155:1' },
          status: 'broadcast',
          requiredForFinality: true,
          dependsOn: [],
          evidence: { transactionHash: `0x${'e'.repeat(64)}` },
          createdAt: now,
          updatedAt: now,
          revision: 0
        }
      ]
    }
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('noir-wallet-transactions-v2-db', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('graphs', 'readwrite')
        transaction.objectStore('graphs').put({
          schemaVersion: 1,
          transactionId,
          accountKey: JSON.stringify([scope.keyDomainId, scope.accountId]),
          chainIds: ['eip155:1'],
          status: 'broadcast',
          createdAt: now,
          updatedAt: now,
          graph
        })
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      })
    } finally {
      database.close()
    }
    const historyCache = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('noir-wallet-evm-history-cache')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = historyCache.transaction('records', 'readwrite')
        const cursor = transaction.objectStore('records').openCursor()
        cursor.onsuccess = () => {
          if (!cursor.result) return
          const record = cursor.result.value
          if (
            record.chainId === 'eip155:1' &&
            record.scope.keyDomainId === scope.keyDomainId &&
            record.scope.accountId === scope.accountId
          ) {
            cursor.result.update({
              ...record,
              lastAttemptAt: 0,
              successfulSyncAt: 0,
              historySyncAt: 0,
              retryAfter: 0
            })
          }
          cursor.result.continue()
        }
        cursor.onerror = () => reject(cursor.error)
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      })
    } finally {
      historyCache.close()
    }
    return transactionId
  })

  let failedHistoryRequests = 0
  await context.route(
    url => EVM_HISTORY_PROXY_ORIGINS.has(url.origin) && url.pathname === '/',
    async route => {
      const request = route.request().postDataJSON() as { method?: unknown }
      if (
        request.method === 'ankr_getTransactionsByAddress' ||
        request.method === 'ankr_getTokenTransfers'
      ) {
        failedHistoryRequests += 1
      }
      await route.fulfill({ status: 503, body: 'History temporarily unavailable' })
    }
  )
  const readLocalItem = (action: 'read' | 'refresh') =>
    popup.evaluate(async action => {
      const response = await chrome.runtime.sendMessage({
        type: 'GET_ACTIVITY',
        action,
        executionMode: 'main',
        chainIds: ['eip155:1']
      })
      if (response.error) throw new Error('Activity request failed')
      const item = response.result.items.find(
        (item: { id: string }) => item.id === 'transaction:history-local-fallback'
      ) as { id: string; source: string } | undefined
      return item ? { id: item.id, source: item.source } : null
    }, action)
  expect(await readLocalItem('read')).toEqual({
    id: localId,
    source: 'wallet-v2'
  })
  expect(await readLocalItem('refresh')).toEqual({
    id: localId,
    source: 'wallet-v2'
  })
  expect(failedHistoryRequests).toBeGreaterThan(0)
  await popup.getByRole('tab', { name: 'Activity' }).click()
  await expect(popup.locator(`[data-activity-id="${localId}"]`)).toBeVisible()
  await captureScreenshot(popup, 'history-local-transaction-after-proxy-503.png')
  await terminateExtensionServiceWorker(context, popup)
  await popup.reload()
  await waitForBackgroundWalletInitialization(popup)
  expect(await readLocalItem('read')).toEqual({
    id: localId,
    source: 'wallet-v2'
  })
  await popup.getByRole('tab', { name: 'Activity' }).click()
  await expect(popup.locator(`[data-activity-id="${localId}"]`)).toBeVisible()
})

test('retains current EVM address history during failed refresh and popup reload', async ({
  context,
  popup
}) => {
  test.setTimeout(120_000)
  await mockEvmHistoryProxy(context)
  await mockReleasedEvmRpc(context)
  await mockReleasedBitcoinEsplora(context)
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await seedFreshAssetPrices(popup)
  const seeded = await popup.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({
      type: 'GET_ACTIVITY',
      action: 'refresh',
      executionMode: 'main',
      chainIds: ['eip155:1']
    })
    const model = response.result
    if (!model?.items.length) throw new Error('Expected current history to be cached')
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('noir-wallet-evm-history-cache')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('records', 'readwrite')
        const cursor = transaction.objectStore('records').openCursor()
        cursor.onsuccess = () => {
          if (!cursor.result) return
          const record = cursor.result.value
          if (
            record.scope.keyDomainId === model.scope.keyDomainId &&
            record.scope.accountId === model.scope.accountId
          ) {
            cursor.result.update({
              ...record,
              lastAttemptAt: 0,
              successfulSyncAt: 0,
              historySyncAt: 0,
              retryAfter: 0
            })
          }
          cursor.result.continue()
        }
        cursor.onerror = () => reject(cursor.error)
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      })
    } finally {
      database.close()
    }
    return model.items.map((item: { id: string }) => item.id) as string[]
  })
  const readIds = () =>
    popup.evaluate(async () => {
      const response = await chrome.runtime.sendMessage({
        type: 'GET_ACTIVITY',
        action: 'read',
        executionMode: 'all'
      })
      if (response.error) throw new Error('Activity read failed')
      return response.result.items.map((item: { id: string }) => item.id) as string[]
    })
  let releaseRefresh: () => void = () => {}
  let failedHistoryRequests = 0
  const refreshGate = new Promise<void>(resolve => {
    releaseRefresh = resolve
  })
  await context.route(
    url => EVM_HISTORY_PROXY_ORIGINS.has(url.origin) && url.pathname === '/',
    async route => {
      await refreshGate
      failedHistoryRequests += 1
      await route.fulfill({ status: 503, body: 'History temporarily unavailable' })
    }
  )
  await popup.getByRole('tab', { name: 'Activity' }).click()
  try {
    await expect(popup.getByText('+0.005871 ETH', { exact: true }).first()).toBeVisible()
    await expect(popup.getByText('No activity yet', { exact: true })).toHaveCount(0)
    await captureScreenshot(popup, 'history-activity-cached-refresh.png')
  } finally {
    releaseRefresh()
  }
  await expect.poll(() => failedHistoryRequests).toBeGreaterThan(0)
  await expect(popup.getByRole('status', { name: 'Loading activity' })).toHaveCount(0, {
    timeout: 30_000
  })
  for (const id of seeded) expect(await readIds()).toContain(id)
  await popup.getByRole('tab', { name: 'Assets' }).click()
  await popup.getByRole('tab', { name: 'Activity' }).click()
  await expect(popup.getByText('+0.005871 ETH', { exact: true }).first()).toBeVisible()
  await popup.reload()
  await popup.getByRole('tab', { name: 'Activity' }).click()
  await expect(popup.getByText('+0.005871 ETH', { exact: true }).first()).toBeVisible()
  for (const id of seeded) expect(await readIds()).toContain(id)
  await expect(popup.getByText('No activity yet', { exact: true })).toHaveCount(0)
  await captureScreenshot(popup, 'history-activity-retained-after-reload.png')
})

test('retains Bitcoin history when EVM fills the shared window and Bitcoin refresh fails', async ({
  context,
  popup
}) => {
  test.skip(!bitcoinEnabled, 'Requires an explicit Bitcoin verification profile')
  test.setTimeout(120_000)
  const unexpectedHistoryProxyRequests: string[] = []
  context.on('request', request => {
    const url = new URL(request.url())
    if (
      EVM_HISTORY_PROXY_ORIGINS.has(url.origin) &&
      /^\/(?:bitcoin|solana|near|evm)(?:\/|$)/.test(url.pathname)
    ) {
      unexpectedHistoryProxyRequests.push(request.url())
    }
  })
  await mockEvmHistoryProxy(context)
  await mockReleasedEvmRpc(context)
  await mockReleasedBitcoinEsplora(context)
  const usedAddress = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
  for (const origin of ['https://mempool.space/api/', 'https://blockstream.info/api/']) {
    await context.route(`${origin}tx/${'e'.repeat(64)}/status`, route =>
      route.fulfill({ contentType: 'application/json', body: '{"confirmed":false}' })
    )
    await context.route(`${origin}address/${usedAddress}`, route =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          address: usedAddress,
          chain_stats: {
            tx_count: 1,
            funded_txo_count: 1,
            funded_txo_sum: 1000,
            spent_txo_count: 1,
            spent_txo_sum: 1000
          },
          mempool_stats: {
            tx_count: 0,
            funded_txo_count: 0,
            funded_txo_sum: 0,
            spent_txo_count: 0,
            spent_txo_sum: 0
          }
        })
      })
    )
  }
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  const seeded = await popup.evaluate(async bitcoinChainId => {
    const response = await chrome.runtime.sendMessage({
      type: 'GET_ACTIVITY',
      action: 'refresh',
      executionMode: 'main',
      chainIds: ['eip155:1']
    })
    const model = response.result
    const source = model?.items.find((item: { source: string }) => item.source === 'rpc')
    if (!source) throw new Error('Expected current EVM history')
    const discovery = await chrome.runtime.sendMessage({
      type: 'SET_ACTIVE_BITCOIN_ADDRESS_TYPE',
      walletId: model.scope.keyDomainId,
      accountId: model.scope.accountId,
      addressType: 'p2wpkh'
    })
    if (discovery.error) throw new Error('Bitcoin discovery failed')
    const discoveryDatabase = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('noir-wallet-bitcoin-discovery-v1-db', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      const found = await new Promise<boolean>((resolve, reject) => {
        const transaction = discoveryDatabase.transaction('observations', 'readwrite')
        const request = transaction.objectStore('observations').openCursor()
        let matched = false
        request.onsuccess = () => {
          const cursor = request.result
          if (!cursor) return
          const record = cursor.value
          if (record.observation.derived.address === 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu') {
            matched = true
            cursor.update({
              ...record,
              observation: {
                ...record.observation,
                activity: {
                  confirmedTransactionCount: 1,
                  mempoolTransactionCount: 0,
                  used: true
                }
              }
            })
          }
          cursor.continue()
        }
        transaction.oncomplete = () => resolve(matched)
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      })
      if (!found) throw new Error('Expected active p2wpkh Bitcoin discovery observation')
    } finally {
      discoveryDatabase.close()
    }
    const mutate = async (name: string, update: (store: IDBObjectStore) => void) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction('records', 'readwrite')
          update(transaction.objectStore('records'))
          transaction.oncomplete = () => resolve()
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        })
      } finally {
        database.close()
      }
    }
    await mutate('noir-wallet-evm-history-cache', store => {
      const request = store.openCursor()
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) return
        const record = cursor.value
        if (record.chainId === 'eip155:1' && record.scope.accountId === model.scope.accountId) {
          const items = Array.from({ length: 50 }, (_, index) => {
            const hash = '0x' + (index + 1).toString(16).padStart(64, '0')
            const id = 'rpc:evm:eip155:1:' + hash + ':native'
            return {
              ...source,
              id,
              segments: source.segments.map((segment: { evidence: Record<string, unknown> }) => ({
                ...segment,
                id: id + ':origin',
                evidence: { ...segment.evidence, transactionHash: hash }
              }))
            }
          })
          cursor.update({
            ...record,
            items,
            lastAttemptAt: 0,
            successfulSyncAt: 0,
            historySyncAt: 0,
            retryAfter: 0
          })
        }
        cursor.continue()
      }
    })
    const hash = 'd'.repeat(64)
    const bitcoinId = 'rpc:bitcoin:' + hash
    const cacheKey =
      'activity_history_cache_v3:mainnet:' +
      model.scope.keyDomainId +
      ':' +
      model.scope.accountId +
      ':active-address-p2wpkh-v2'
    await mutate('noir-wallet-activity-history-cache', store => {
      store.put(
        {
          schemaVersion: 2,
          refreshedAtByChainId: { [bitcoinChainId]: Date.now() },
          items: [
            {
              id: bitcoinId,
              source: 'rpc',
              scope: model.scope,
              kind: 'transfer',
              status: 'final',
              snapshot: {
                schemaVersion: 1,
                direction: 'incoming',
                primaryAmount: { assetId: bitcoinChainId + '/slip44:0', amountRaw: '1000' }
              },
              segments: [
                {
                  id: bitcoinId + ':origin',
                  role: 'origin',
                  target: { kind: 'onchain', chainId: bitcoinChainId },
                  status: 'final',
                  evidence: {
                    transactionHash: hash,
                    blockHash: 'b'.repeat(64),
                    blockHeight: 1,
                    confirmations: 6,
                    requiredConfirmations: 6
                  }
                }
              ],
              completeness: 'partial',
              createdAt: 1000,
              updatedAt: 1000
            }
          ]
        },
        cacheKey
      )
    })
    const localId = 'transaction:bitcoin-history-fallback'
    const segmentId = 'segment:bitcoin-history-fallback'
    const now = Date.now()
    const graph = {
      root: {
        id: localId,
        scope: model.scope,
        kind: 'transfer',
        status: 'broadcast',
        segmentIds: [segmentId],
        createdAt: now,
        updatedAt: now,
        revision: 0,
        intent: {
          schemaVersion: 1,
          direction: 'outgoing',
          primaryAmount: { assetId: bitcoinChainId + '/slip44:0', amountRaw: '1000' },
          sender: { chainId: bitcoinChainId, address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu' }
        }
      },
      segments: [
        {
          id: segmentId,
          transactionId: localId,
          role: 'origin',
          target: { kind: 'onchain', chainId: bitcoinChainId },
          status: 'broadcast',
          requiredForFinality: true,
          dependsOn: [],
          evidence: { transactionHash: 'e'.repeat(64) },
          createdAt: now,
          updatedAt: now,
          revision: 0
        }
      ]
    }
    const graphDatabase = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('noir-wallet-transactions-v2-db', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = graphDatabase.transaction('graphs', 'readwrite')
        transaction.objectStore('graphs').put({
          schemaVersion: 1,
          transactionId: localId,
          accountKey: JSON.stringify([model.scope.keyDomainId, model.scope.accountId]),
          chainIds: [bitcoinChainId],
          status: 'broadcast',
          createdAt: now,
          updatedAt: now,
          graph
        })
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      })
    } finally {
      graphDatabase.close()
    }
    const refreshed = await chrome.runtime.sendMessage({
      type: 'GET_ACTIVITY',
      action: 'refresh',
      executionMode: 'main',
      chainIds: ['eip155:1']
    })
    if (refreshed.error) throw new Error('EVM refresh failed')
    return {
      bitcoinId,
      localId,
      cacheKey,
      evmItemCount: refreshed.result.items.filter((item: { id: string }) =>
        item.id.startsWith('rpc:evm:')
      ).length
    }
  }, BITCOIN_MAINNET_CHAIN_ID)
  expect(seeded.evmItemCount).toBe(50)
  const readBitcoinIds = (expire = false) =>
    popup.evaluate(
      async ({ cacheKey, expire }) => {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('noir-wallet-activity-history-cache')
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        try {
          return await new Promise<string[]>((resolve, reject) => {
            const transaction = database.transaction('records', expire ? 'readwrite' : 'readonly')
            const store = transaction.objectStore('records')
            const request = store.get(cacheKey)
            let ids: string[] = []
            request.onsuccess = () => {
              const record = request.result
              ids = record?.items.map((item: { id: string }) => item.id) ?? []
              if (expire && record) store.put({ ...record, refreshedAtByChainId: {} }, cacheKey)
            }
            transaction.oncomplete = () => resolve(ids)
            transaction.onerror = () => reject(transaction.error)
            transaction.onabort = () => reject(transaction.error)
          })
        } finally {
          database.close()
        }
      },
      { cacheKey: seeded.cacheKey, expire }
    )
  expect(await readBitcoinIds(true)).toContain(seeded.bitcoinId)
  let failedBitcoinRequests = 0
  for (const origin of ['https://mempool.space/api/', 'https://blockstream.info/api/']) {
    await context.route(`${origin}address/*/txs`, async route => {
      failedBitcoinRequests += 1
      await route.fulfill({ status: 503, body: 'History temporarily unavailable' })
    })
  }
  const retained = await popup.evaluate(async chainId => {
    const response = await chrome.runtime.sendMessage({
      type: 'GET_ACTIVITY',
      action: 'refresh',
      executionMode: 'main',
      chainIds: [chainId]
    })
    if (response.error) throw new Error('Bitcoin refresh failed')
    return response.result.items.map((item: { id: string; source: string }) => ({
      id: item.id,
      source: item.source
    }))
  }, BITCOIN_MAINNET_CHAIN_ID)
  expect(failedBitcoinRequests).toBeGreaterThan(0)
  expect(await readBitcoinIds()).toContain(seeded.bitcoinId)
  expect(retained).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: seeded.localId, source: 'wallet-v2' })])
  )
  await popup.getByRole('tab', { name: 'Activity' }).click()
  await expect(popup.locator(`[data-activity-id="${seeded.localId}"]`)).toBeVisible()
  expect(unexpectedHistoryProxyRequests).toEqual([])
  await captureScreenshot(popup, 'history-bitcoin-local-retained-after-direct-rpc-failure.png')
})

test('discards old beta History caches and retains current records across worker restart', async ({
  context,
  popup
}) => {
  test.setTimeout(120_000)
  await mockEvmHistoryProxy(context)
  await mockReleasedEvmRpc(context)
  await mockReleasedBitcoinEsplora(context)
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  const seeded = await popup.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({
      type: 'GET_ACTIVITY',
      action: 'refresh',
      executionMode: 'main',
      chainIds: ['eip155:1']
    })
    const model = response.result
    const source = model?.items.find((item: { source: string }) => item.source === 'rpc')
    if (!source) throw new Error('Expected a current EVM history record')
    const scope = model.scope
    const hash = '0x' + 'c'.repeat(64)
    const oldId = 'rpc:evm:' + hash + ':native'
    const oldItem = {
      ...source,
      id: oldId,
      segments: source.segments.map((segment: { evidence: Record<string, unknown> }) => ({
        ...segment,
        id: oldId + ':origin',
        evidence: { ...segment.evidence, transactionHash: hash }
      }))
    }
    const oldRecord = {
      schemaVersion: 2,
      refreshedAtByChainId: { 'eip155:1': Date.now() },
      items: [oldItem]
    }
    const legacyKey =
      'activity_history_cache_v2:mainnet:' +
      scope.keyDomainId +
      ':' +
      scope.accountId +
      ':active-address-p2wpkh-v2-evm-main'
    const otherLegacyKey = 'activity_history_cache_v2:testnet:old-beta-wallet:old-account:default'
    const mixedKey =
      'activity_history_cache_v3:mainnet:' +
      scope.keyDomainId +
      ':' +
      scope.accountId +
      ':active-address-p2wpkh-v2'
    await chrome.storage.local.set({ [legacyKey]: oldRecord, [otherLegacyKey]: oldRecord })
    const put = async (name: string, key: string, record: unknown) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction('records', 'readwrite')
          transaction.objectStore('records').put(record, key)
          transaction.oncomplete = () => resolve()
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        })
      } finally {
        database.close()
      }
    }
    await put('noir-wallet-activity-history-cache', mixedKey, oldRecord)
    const address = source.snapshot.recipient.address.toLowerCase()
    const unscopedKey = 'eip155:1:' + address
    await put('noir-wallet-evm-history-cache', unscopedKey, {
      schemaVersion: 1,
      chainId: 'eip155:1',
      address,
      scope,
      lastAttemptAt: 0,
      successfulSyncAt: null,
      retryAfter: 0,
      items: [oldItem]
    })
    const alternateAddress = '0x1111111111111111111111111111111111111111'
    const scopedLegacyKey =
      scope.keyDomainId + ':' + scope.accountId + ':eip155:1:' + alternateAddress
    await put('noir-wallet-evm-history-cache', scopedLegacyKey, {
      schemaVersion: 1,
      chainId: 'eip155:1',
      address: alternateAddress,
      scope,
      lastAttemptAt: 0,
      successfulSyncAt: null,
      retryAfter: 0,
      items: [oldItem]
    })
    return {
      oldId,
      scope,
      legacyKeys: [legacyKey, otherLegacyKey],
      mixedKey,
      unscopedKey,
      scopedLegacyKey,
      currentIds: model.items.map((item: { id: string }) => item.id) as string[]
    }
  })
  const readIds = () =>
    popup.evaluate(async () => {
      const response = await chrome.runtime.sendMessage({
        type: 'GET_ACTIVITY',
        action: 'read',
        executionMode: 'all'
      })
      if (response.error) throw new Error('Activity read failed')
      return response.result.items.map((item: { id: string }) => item.id) as string[]
    })
  await terminateExtensionServiceWorker(context, popup)
  await popup.reload()
  await waitForBackgroundWalletInitialization(popup)
  const first = await readIds()
  expect(first).not.toContain(seeded.oldId)
  for (const id of seeded.currentIds) expect(first).toContain(id)
  const cleanup = await popup.evaluate(
    async ({ legacyKeys, mixedKey, unscopedKey, scopedLegacyKey }) => {
      const legacy = await chrome.storage.local.get(legacyKeys)
      const get = async (name: string, key: string) => {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(name)
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        try {
          return await new Promise<unknown>((resolve, reject) => {
            const request = database
              .transaction('records', 'readonly')
              .objectStore('records')
              .get(key)
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
          })
        } finally {
          database.close()
        }
      }
      return {
        legacyKeys: Object.keys(legacy),
        mixedRecord: await get('noir-wallet-activity-history-cache', mixedKey),
        unscopedRecord: await get('noir-wallet-evm-history-cache', unscopedKey),
        scopedLegacyRecord: await get('noir-wallet-evm-history-cache', scopedLegacyKey)
      }
    },
    seeded
  )
  expect(cleanup.legacyKeys).toEqual([])
  expect(cleanup.mixedRecord).toBeUndefined()
  expect(cleanup.unscopedRecord).toBeUndefined()
  expect(cleanup.scopedLegacyRecord).toBeUndefined()
  await terminateExtensionServiceWorker(context, popup)
  await popup.reload()
  await waitForBackgroundWalletInitialization(popup)
  const rebuilt = await readIds()
  expect(rebuilt).not.toContain(seeded.oldId)
  for (const id of seeded.currentIds) expect(rebuilt).toContain(id)
})
