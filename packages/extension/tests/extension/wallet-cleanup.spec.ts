import { expect, test, waitForBackgroundWalletInitialization } from '../helpers/extension-fixtures'

test('removes one account logically and rejects unverified wallet deletion', async ({ popup }) => {
  const walletId = `cleanup-${crypto.randomUUID()}`
  const accountId = 'account-1'
  const remainingAccountId = 'account-2'
  const network = 'mainnet'
  const walletKey = `${network}_${walletId}`
  const accountKey = `${walletKey}_${accountId}`
  const remainingAccountKey = `${walletKey}_${remainingAccountId}`

  await waitForBackgroundWalletInitialization(popup)

  const result = await popup.evaluate(
    async ({
      walletId,
      accountId,
      remainingAccountId,
      network,
      walletKey,
      accountKey,
      remainingAccountKey
    }) => {
      const account = (id: string, derivationIndex: number) => ({
        id,
        name: id,
        addresses: {
          transparent: `t-${id}`,
          shielded: `u-${id}`,
          fullUnified: `u-full-${id}`
        },
        derivationIndex,
        birthdayHeight: 3_000_000,
        isPinned: false,
        isHidden: false
      })
      const wallet = {
        id: walletId,
        name: 'Cleanup wallet',
        seedPhraseKey: `seed_${walletId}`,
        accounts: [account(accountId, 0), account(remainingAccountId, 1)],
        createdAt: 1_700_000_000_000,
        isPinned: false,
        keySource: 'software'
      }
      const openDb = () =>
        new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('zcash-wallet-db')
          request.onupgradeneeded = () => {
            const db = request.result
            if (!db.objectStoreNames.contains('walletData')) {
              db.createObjectStore('walletData')
            }
            if (!db.objectStoreNames.contains('transactions')) {
              db.createObjectStore('transactions')
            }
            if (!db.objectStoreNames.contains('transparentTransactionCache')) {
              db.createObjectStore('transparentTransactionCache')
            }
            if (!db.objectStoreNames.contains('syncJournal')) {
              const store = db.createObjectStore('syncJournal', {
                keyPath: ['walletKey', 'seq']
              })
              store.createIndex('byWallet', 'walletKey', { unique: false })
            }
            if (!db.objectStoreNames.contains('syncJournalManifest')) {
              db.createObjectStore('syncJournalManifest')
            }
            if (!db.objectStoreNames.contains('walletPersistenceQuarantine')) {
              db.createObjectStore('walletPersistenceQuarantine')
            }
          }
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
      const openBitcoinDb = (kind: 'discovery' | 'change' | 'input') =>
        new Promise<IDBDatabase>((resolve, reject) => {
          const databaseName =
            kind === 'discovery'
              ? 'noir-wallet-bitcoin-discovery-v1-db'
              : kind === 'change'
                ? 'noir-wallet-bitcoin-change-v1-db'
                : 'noir-wallet-bitcoin-input-v1-db'
          const request = indexedDB.open(databaseName, kind === 'input' ? 2 : 1)
          request.onupgradeneeded = () => {
            const database = request.result
            if (kind === 'discovery') {
              const scans = database.createObjectStore('scans', {
                keyPath: 'chainAccountId'
              })
              scans.createIndex('byAccount', 'accountKey', { unique: false })
              const observations = database.createObjectStore('observations', {
                keyPath: 'observationKey'
              })
              observations.createIndex('byAccount', 'accountKey', { unique: false })
              observations.createIndex('byChainAccount', 'chainAccountId', {
                unique: false
              })
              observations.createIndex('byAddress', 'addressKey', { unique: true })
            } else if (kind === 'change') {
              const reservations = database.createObjectStore('reservations', {
                keyPath: 'reservationKey'
              })
              reservations.createIndex('byAccount', 'accountKey', { unique: false })
              reservations.createIndex('byScope', 'scopeKey', { unique: false })
            } else {
              const reservations = database.createObjectStore('reservations', {
                keyPath: 'reservationKey'
              })
              reservations.createIndex('byAccount', 'accountKey', { unique: false })
              reservations.createIndex('byOutpoint', 'outpointKeys', {
                unique: true,
                multiEntry: true
              })
            }
          }
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
      const openEvmHistoryDb = () =>
        new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('noir-wallet-evm-history-cache', 2)
          request.onupgradeneeded = () => {
            const database = request.result
            if (!database.objectStoreNames.contains('records')) {
              database.createObjectStore('records')
            }
          }
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
      const seedEvmHistory = async (id: string, addressCharacter: string) => {
        const database = await openEvmHistoryDb()
        const now = Date.now()
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction('records', 'readwrite')
          transaction.objectStore('records').put(
            {
              schemaVersion: 1,
              chainId: 'eip155:1',
              scope: { keyDomainId: walletId, accountId: id },
              address: `0x${addressCharacter.repeat(40)}`,
              lastAttemptAt: now,
              successfulSyncAt: now,
              retryAfter: now,
              items: []
            },
            `${walletId}:${id}:eip155:1:0x${addressCharacter.repeat(40)}`
          )
          transaction.oncomplete = () => resolve()
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        })
        database.close()
      }
      const countEvmHistory = async (id: string) => {
        const database = await openEvmHistoryDb()
        const count = await new Promise<number>((resolve, reject) => {
          let matches = 0
          const transaction = database.transaction('records', 'readonly')
          const request = transaction.objectStore('records').openCursor()
          request.onsuccess = () => {
            const cursor = request.result
            if (!cursor) return
            if (
              cursor.value?.scope?.keyDomainId === walletId &&
              cursor.value.scope.accountId === id
            ) {
              matches += 1
            }
            cursor.continue()
          }
          transaction.oncomplete = () => resolve(matches)
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        })
        database.close()
        return count
      }
      const seedBitcoinAccountData = async (id: string) => {
        const indexedAccountKey = JSON.stringify([walletId, id])
        const discovery = await openBitcoinDb('discovery')
        await new Promise<void>((resolve, reject) => {
          const transaction = discovery.transaction(['scans', 'observations'], 'readwrite')
          transaction.objectStore('scans').put({
            chainAccountId: `chain-account:${id}`,
            accountKey: indexedAccountKey
          })
          transaction.objectStore('observations').put({
            observationKey: `observation:${id}`,
            chainAccountId: `chain-account:${id}`,
            accountKey: indexedAccountKey,
            addressKey: `address:${id}`
          })
          transaction.oncomplete = () => resolve()
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        })
        discovery.close()
        const changes = await openBitcoinDb('change')
        await new Promise<void>((resolve, reject) => {
          const transaction = changes.transaction('reservations', 'readwrite')
          transaction.objectStore('reservations').put({
            reservationKey: `reservation:${id}`,
            accountKey: indexedAccountKey,
            scopeKey: `scope:${id}`
          })
          transaction.oncomplete = () => resolve()
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        })
        changes.close()
        const inputs = await openBitcoinDb('input')
        await new Promise<void>((resolve, reject) => {
          const transaction = inputs.transaction('reservations', 'readwrite')
          transaction.objectStore('reservations').put({
            reservationKey: `input-reservation:${id}`,
            accountKey: indexedAccountKey,
            scopeKey: `input-scope:${id}`,
            outpointKeys: [`outpoint:${id}`]
          })
          transaction.oncomplete = () => resolve()
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        })
        inputs.close()
      }
      const countBitcoinAccountData = async (id: string) => {
        const indexedAccountKey = JSON.stringify([walletId, id])
        const discovery = await openBitcoinDb('discovery')
        const discoveryCounts = await new Promise<readonly [number, number]>((resolve, reject) => {
          const transaction = discovery.transaction(['scans', 'observations'], 'readonly')
          const scans = transaction
            .objectStore('scans')
            .index('byAccount')
            .count(IDBKeyRange.only(indexedAccountKey))
          const observations = transaction
            .objectStore('observations')
            .index('byAccount')
            .count(IDBKeyRange.only(indexedAccountKey))
          transaction.oncomplete = () => resolve([scans.result, observations.result])
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        })
        discovery.close()
        const changes = await openBitcoinDb('change')
        const changeCount = await new Promise<number>((resolve, reject) => {
          const transaction = changes.transaction('reservations', 'readonly')
          const reservations = transaction
            .objectStore('reservations')
            .index('byAccount')
            .count(IDBKeyRange.only(indexedAccountKey))
          transaction.oncomplete = () => resolve(reservations.result)
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        })
        changes.close()
        const inputs = await openBitcoinDb('input')
        const inputCount = await new Promise<number>((resolve, reject) => {
          const transaction = inputs.transaction('reservations', 'readonly')
          const reservations = transaction
            .objectStore('reservations')
            .index('byAccount')
            .count(IDBKeyRange.only(indexedAccountKey))
          transaction.oncomplete = () => resolve(reservations.result)
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        })
        inputs.close()
        return {
          discoveryScans: discoveryCounts[0],
          discoveryObservations: discoveryCounts[1],
          changeReservations: changeCount,
          inputReservations: inputCount
        }
      }

      await chrome.storage.local.clear()
      await chrome.storage.local.set({
        wallet_state: {
          state: {
            currentWalletId: walletId,
            currentAccountId: accountId,
            currentNetwork: network,
            zecPrice: 0,
            wallets: [wallet],
            accountDisplayNames: {
              [`${walletId}_${accountId}`]: 'Removed account',
              [`${walletId}_${remainingAccountId}`]: 'Remaining account'
            }
          },
          version: 0
        },
        account_data: {
          state: {
            balances: {
              [accountKey]: { total: '1', shielded: '1', transparent: '0' },
              [remainingAccountKey]: {
                total: '2',
                shielded: '2',
                transparent: '0'
              }
            },
            syncStates: {
              [walletKey]: {
                isSyncing: false,
                syncProgress: 50,
                currentHeight: 3_000_000,
                latestHeight: 3_000_010,
                lastSyncTime: 1_700_000_000_000,
                etaMs: 1_000,
                syncReason: null
              }
            }
          },
          version: 0
        },
        [`seed_${walletId}`]: {
          encryptedData: 'fixture-ciphertext',
          salt: 'fixture-salt',
          iv: 'fixture-iv'
        },
        pending_transactions: [
          {
            walletId,
            accountId,
            accountKey,
            depositAddress: 'deposit-removed',
            tokenInSymbol: 'ZEC',
            tokenOutSymbol: 'NEAR',
            amountIn: '1',
            amountOut: '1',
            transactionId: 'relay-removed'
          },
          {
            walletId,
            accountId: remainingAccountId,
            accountKey: remainingAccountKey,
            depositAddress: 'deposit-remaining',
            tokenInSymbol: 'ZEC',
            tokenOutSymbol: 'NEAR',
            amountIn: '2',
            amountOut: '2',
            transactionId: 'relay-remaining'
          }
        ],
        pending_zcash_transactions: [
          {
            walletId,
            accountId,
            accountKey,
            txHash: 'hash-removed',
            transactionId: 'zcash-removed',
            startTime: Date.now()
          },
          {
            walletId,
            accountId: remainingAccountId,
            accountKey: remainingAccountKey,
            txHash: 'hash-remaining',
            transactionId: 'zcash-remaining',
            startTime: Date.now()
          }
        ],
        connectedDApps: [
          {
            id: 'dapp-cleanup',
            name: 'Cleanup dApp',
            host: 'cleanup.example',
            origin: 'https://cleanup.example',
            favicon: '',
            connectedAt: 1_700_000_000_000,
            lastActiveAt: 1_700_000_000_000,
            boundWalletId: walletId,
            boundAccountId: accountId,
            authorizedAccounts: [
              { walletId, accountId },
              { walletId, accountId: remainingAccountId }
            ]
          }
        ]
      })

      const db = await openDb()
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(
          [
            'walletData',
            'transactions',
            'transparentTransactionCache',
            'syncJournal',
            'syncJournalManifest'
          ],
          'readwrite'
        )
        transaction.objectStore('walletData').put(
          {
            metadata: {
              version: 1,
              timestamp: Date.now(),
              network,
              walletId
            },
            data: new Uint8Array([1, 2, 3, 4])
          },
          walletKey
        )
        transaction.objectStore('transactions').put([{ id: 'removed-tx' }], accountKey)
        transaction.objectStore('transactions').put([{ id: 'remaining-tx' }], remainingAccountKey)
        transaction.objectStore('transparentTransactionCache').put({ removed: true }, accountKey)
        transaction
          .objectStore('transparentTransactionCache')
          .put({ remaining: true }, remainingAccountKey)
        transaction.objectStore('syncJournal').put({
          walletKey,
          seq: 0,
          rangeStart: 3_000_000,
          rangeEnd: 3_000_001,
          data: new Uint8Array([5, 6]),
          committedAt: Date.now()
        })
        transaction.objectStore('syncJournalManifest').put(
          {
            walletKey,
            baseSnapshotSeq: 0,
            nextSeq: 1,
            totalBytes: 2,
            createdAt: Date.now(),
            updatedAt: Date.now()
          },
          walletKey
        )
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      })
      db.close()
      await seedBitcoinAccountData(accountId)
      await seedBitcoinAccountData(remainingAccountId)
      await seedEvmHistory(accountId, '1')
      await seedEvmHistory(remainingAccountId, '2')

      const accountRemoval = await chrome.runtime.sendMessage({
        type: 'REMOVE_ACCOUNT',
        walletId,
        accountId
      })

      const afterAccountStorage = await chrome.storage.local.get(null)
      const walletState =
        typeof afterAccountStorage.wallet_state === 'string'
          ? JSON.parse(afterAccountStorage.wallet_state)
          : afterAccountStorage.wallet_state
      const accountData =
        typeof afterAccountStorage.account_data === 'string'
          ? JSON.parse(afterAccountStorage.account_data)
          : afterAccountStorage.account_data
      const afterAccountDb = await openDb()
      const afterAccount = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const transaction = afterAccountDb.transaction(
          [
            'walletData',
            'transactions',
            'transparentTransactionCache',
            'syncJournal',
            'syncJournalManifest'
          ],
          'readonly'
        )
        const snapshot = transaction.objectStore('walletData').get(walletKey)
        const removedTransactions = transaction.objectStore('transactions').get(accountKey)
        const remainingTransactions = transaction
          .objectStore('transactions')
          .get(remainingAccountKey)
        const removedTransparentCache = transaction
          .objectStore('transparentTransactionCache')
          .get(accountKey)
        const remainingTransparentCache = transaction
          .objectStore('transparentTransactionCache')
          .get(remainingAccountKey)
        const journalCount = transaction
          .objectStore('syncJournal')
          .index('byWallet')
          .count(IDBKeyRange.only(walletKey))
        const journalManifest = transaction.objectStore('syncJournalManifest').get(walletKey)
        transaction.oncomplete = () =>
          resolve({
            snapshot: snapshot.result !== undefined,
            removedTransactions: removedTransactions.result,
            remainingTransactions: remainingTransactions.result,
            removedTransparentCache: removedTransparentCache.result,
            remainingTransparentCache: remainingTransparentCache.result,
            journalCount: journalCount.result,
            journalManifest: journalManifest.result !== undefined
          })
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      })
      afterAccountDb.close()
      const removedBitcoinData = await countBitcoinAccountData(accountId)
      const remainingBitcoinData = await countBitcoinAccountData(remainingAccountId)
      const removedEvmHistory = await countEvmHistory(accountId)
      const remainingEvmHistory = await countEvmHistory(remainingAccountId)

      const logicalRemoval = {
        response: accountRemoval,
        accounts: walletState?.state?.wallets?.[0]?.accounts?.map(
          (item: { id: string }) => item.id
        ),
        currentAccountId: walletState?.state?.currentAccountId,
        displayNames: walletState?.state?.accountDisplayNames,
        balanceKeys: Object.keys(accountData?.state?.balances ?? {}),
        syncStateKeys: Object.keys(accountData?.state?.syncStates ?? {}),
        pendingRelayAccounts: (afterAccountStorage.pending_transactions ?? []).map(
          (item: { accountId: string }) => item.accountId
        ),
        pendingZcashAccounts: (afterAccountStorage.pending_zcash_transactions ?? []).map(
          (item: { accountId: string }) => item.accountId
        ),
        dapps: afterAccountStorage.connectedDApps,
        credentialRetained: afterAccountStorage[`seed_${walletId}`] !== undefined,
        removedBitcoinData,
        remainingBitcoinData,
        removedEvmHistory,
        remainingEvmHistory,
        ...afterAccount
      }

      const walletRemoval = await chrome.runtime.sendMessage({
        type: 'REMOVE_WALLET',
        walletId
      })
      const afterWalletStorage = await chrome.storage.local.get(null)
      const finalWalletState =
        typeof afterWalletStorage.wallet_state === 'string'
          ? JSON.parse(afterWalletStorage.wallet_state)
          : afterWalletStorage.wallet_state
      const finalAccountData =
        typeof afterWalletStorage.account_data === 'string'
          ? JSON.parse(afterWalletStorage.account_data)
          : afterWalletStorage.account_data
      const finalDb = await openDb()
      const physicalRemoval = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const transaction = finalDb.transaction(
          [
            'walletData',
            'transactions',
            'transparentTransactionCache',
            'syncJournal',
            'syncJournalManifest'
          ],
          'readonly'
        )
        const snapshot = transaction.objectStore('walletData').get(walletKey)
        const transactions = transaction.objectStore('transactions').get(remainingAccountKey)
        const transparentCache = transaction
          .objectStore('transparentTransactionCache')
          .get(remainingAccountKey)
        const journalCount = transaction
          .objectStore('syncJournal')
          .index('byWallet')
          .count(IDBKeyRange.only(walletKey))
        const manifest = transaction.objectStore('syncJournalManifest').get(walletKey)
        transaction.oncomplete = () =>
          resolve({
            snapshot: snapshot.result,
            transactions: transactions.result,
            transparentCache: transparentCache.result,
            journalCount: journalCount.result,
            manifest: manifest.result
          })
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      })
      finalDb.close()
      const finalBitcoinData = await countBitcoinAccountData(remainingAccountId)
      const finalEvmHistory = await countEvmHistory(remainingAccountId)

      return {
        logicalRemoval,
        physicalRemoval: {
          response: walletRemoval,
          wallets: finalWalletState?.state?.wallets,
          currentWalletId: finalWalletState?.state?.currentWalletId,
          currentAccountId: finalWalletState?.state?.currentAccountId,
          balanceKeys: Object.keys(finalAccountData?.state?.balances ?? {}),
          syncStateKeys: Object.keys(finalAccountData?.state?.syncStates ?? {}),
          credential: afterWalletStorage[`seed_${walletId}`],
          pendingTransactions: afterWalletStorage.pending_transactions,
          pendingZcashTransactions: afterWalletStorage.pending_zcash_transactions,
          dapps: afterWalletStorage.connectedDApps,
          finalBitcoinData,
          finalEvmHistory,
          ...physicalRemoval
        }
      }
    },
    {
      walletId,
      accountId,
      remainingAccountId,
      network,
      walletKey,
      accountKey,
      remainingAccountKey
    }
  )

  // Shared WASM state must be rebuilt without the removed account; scoped history is retained.
  expect(result.logicalRemoval).toMatchObject({
    response: { success: true },
    accounts: [remainingAccountId],
    currentAccountId: remainingAccountId,
    displayNames: {
      [`${walletId}_${remainingAccountId}`]: 'Remaining account'
    },
    balanceKeys: [remainingAccountKey],
    syncStateKeys: [walletKey],
    pendingRelayAccounts: [remainingAccountId],
    pendingZcashAccounts: [remainingAccountId],
    credentialRetained: true,
    snapshot: false,
    journalCount: 0,
    journalManifest: false,
    remainingTransactions: [{ id: 'remaining-tx' }],
    remainingTransparentCache: { remaining: true }
  })
  expect(result.logicalRemoval.removedBitcoinData).toEqual({
    discoveryScans: 0,
    discoveryObservations: 0,
    changeReservations: 0,
    inputReservations: 0
  })
  expect(result.logicalRemoval.remainingBitcoinData).toEqual({
    discoveryScans: 1,
    discoveryObservations: 1,
    changeReservations: 1,
    inputReservations: 1
  })
  expect(result.logicalRemoval.removedEvmHistory).toBe(0)
  expect(result.logicalRemoval.remainingEvmHistory).toBe(1)
  expect(result.logicalRemoval.removedTransactions).toBeUndefined()
  expect(result.logicalRemoval.removedTransparentCache).toBeUndefined()
  expect(result.logicalRemoval.dapps).toEqual([
    expect.objectContaining({
      boundWalletId: walletId,
      boundAccountId: remainingAccountId,
      authorizedAccounts: [{ walletId, accountId: remainingAccountId }]
    })
  ])

  expect(result.physicalRemoval).toMatchObject({
    response: { error: 'Unable to verify this wallet backup. Unlock and view your secret phrase.' },
    wallets: [expect.objectContaining({ id: walletId })],
    currentWalletId: walletId,
    currentAccountId: remainingAccountId,
    balanceKeys: [remainingAccountKey],
    syncStateKeys: [walletKey],
    journalCount: 0
  })
  expect(result.physicalRemoval.finalBitcoinData).toEqual({
    discoveryScans: 1,
    discoveryObservations: 1,
    changeReservations: 1,
    inputReservations: 1
  })
  expect(result.physicalRemoval.finalEvmHistory).toBe(1)
  expect(result.physicalRemoval.credential).toBeDefined()
  expect(result.physicalRemoval.snapshot).toBeUndefined()
  expect(result.physicalRemoval.transactions).toEqual([{ id: 'remaining-tx' }])
  expect(result.physicalRemoval.transparentCache).toEqual({ remaining: true })
  expect(result.physicalRemoval.manifest).toBeUndefined()
})

test('full reset removes orphaned wallet storage and retained migration data', async ({
  popup
}) => {
  const orphanWalletId = `orphan-${crypto.randomUUID()}`
  const walletKey = `mainnet_${orphanWalletId}`
  const accountKey = `${walletKey}_account-1`

  await waitForBackgroundWalletInitialization(popup)

  const result = await popup.evaluate(
    async ({ orphanWalletId, walletKey, accountKey }) => {
      const openDb = () =>
        new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('zcash-wallet-db')
          request.onupgradeneeded = () => {
            const db = request.result
            if (!db.objectStoreNames.contains('walletData')) {
              db.createObjectStore('walletData')
            }
            if (!db.objectStoreNames.contains('transactions')) {
              db.createObjectStore('transactions')
            }
            if (!db.objectStoreNames.contains('transparentTransactionCache')) {
              db.createObjectStore('transparentTransactionCache')
            }
            if (!db.objectStoreNames.contains('syncJournal')) {
              const store = db.createObjectStore('syncJournal', {
                keyPath: ['walletKey', 'seq']
              })
              store.createIndex('byWallet', 'walletKey', { unique: false })
            }
            if (!db.objectStoreNames.contains('syncJournalManifest')) {
              db.createObjectStore('syncJournalManifest')
            }
            if (!db.objectStoreNames.contains('walletPersistenceQuarantine')) {
              db.createObjectStore('walletPersistenceQuarantine')
            }
          }
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })

      await chrome.storage.local.clear()
      await chrome.storage.local.set({
        wallet_state: {
          state: {
            currentWalletId: null,
            currentAccountId: null,
            currentNetwork: 'mainnet',
            zecPrice: 0,
            wallets: [],
            accountDisplayNames: {}
          },
          version: 0
        },
        account_data: {
          state: { balances: {}, syncStates: {} },
          version: 0
        },
        [`seed_${orphanWalletId}`]: { encryptedData: 'orphan' },
        [`hw_${orphanWalletId}`]: { encryptedData: 'orphan' },
        walletData: { currentWalletId: orphanWalletId },
        legacy_wallet_data_migration_v1: {
          schemaVersion: 1,
          status: 'retained'
        },
        pending_transactions: [
          {
            walletId: orphanWalletId,
            accountId: 'account-1',
            accountKey,
            depositAddress: 'orphan-deposit'
          }
        ],
        pending_zcash_transactions: [
          {
            walletId: orphanWalletId,
            accountId: 'account-1',
            accountKey,
            txHash: 'orphan-hash',
            transactionId: 'orphan-transaction',
            startTime: Date.now()
          }
        ]
      })

      const db = await openDb()
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(
          [
            'walletData',
            'transactions',
            'transparentTransactionCache',
            'syncJournal',
            'syncJournalManifest',
            'walletPersistenceQuarantine'
          ],
          'readwrite'
        )
        transaction.objectStore('walletData').put({ orphan: true }, walletKey)
        transaction.objectStore('transactions').put([{ id: 'orphan' }], accountKey)
        transaction.objectStore('transparentTransactionCache').put({ orphan: true }, accountKey)
        transaction.objectStore('syncJournal').put({
          walletKey,
          seq: 0,
          data: new Uint8Array([1])
        })
        transaction.objectStore('syncJournalManifest').put({ walletKey }, walletKey)
        transaction.objectStore('walletPersistenceQuarantine').put({ key: walletKey }, walletKey)
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      })
      db.close()

      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('noir-wallet-bitcoin-discovery-v1-db', 1)
        request.onsuccess = () => {
          request.result.close()
          resolve()
        }
        request.onerror = () => reject(request.error)
      })
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('noir-wallet-bitcoin-change-v1-db', 1)
        request.onsuccess = () => {
          request.result.close()
          resolve()
        }
        request.onerror = () => reject(request.error)
      })
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('noir-wallet-bitcoin-input-v1-db', 2)
        request.onsuccess = () => {
          request.result.close()
          resolve()
        }
        request.onerror = () => reject(request.error)
      })

      const response = await chrome.runtime.sendMessage({
        type: 'RESET_WALLET_DATA'
      })
      const storage = await chrome.storage.local.get(null)
      const walletState =
        typeof storage.wallet_state === 'string'
          ? JSON.parse(storage.wallet_state)
          : storage.wallet_state
      const accountData =
        typeof storage.account_data === 'string'
          ? JSON.parse(storage.account_data)
          : storage.account_data
      const verifyDb = await openDb()
      const counts = await new Promise<Record<string, number>>((resolve, reject) => {
        const storeNames = [
          'walletData',
          'transactions',
          'transparentTransactionCache',
          'syncJournal',
          'syncJournalManifest',
          'walletPersistenceQuarantine'
        ]
        const transaction = verifyDb.transaction(storeNames, 'readonly')
        const requests = Object.fromEntries(
          storeNames.map(storeName => [storeName, transaction.objectStore(storeName).count()])
        ) as Record<string, IDBRequest<number>>
        transaction.oncomplete = () =>
          resolve(
            Object.fromEntries(
              Object.entries(requests).map(([key, request]) => [key, request.result])
            )
          )
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      })
      verifyDb.close()
      const databaseNames = (await indexedDB.databases()).map(database => database.name)

      return {
        response,
        wallets: walletState?.state?.wallets,
        balances: accountData?.state?.balances,
        syncStates: accountData?.state?.syncStates,
        seed: storage[`seed_${orphanWalletId}`],
        hardware: storage[`hw_${orphanWalletId}`],
        legacy: storage.walletData,
        migration: storage.legacy_wallet_data_migration_v1,
        pendingTransactions: storage.pending_transactions,
        pendingZcashTransactions: storage.pending_zcash_transactions,
        counts,
        bitcoinDiscoveryDatabasePresent: databaseNames.includes(
          'noir-wallet-bitcoin-discovery-v1-db'
        ),
        bitcoinChangeDatabasePresent: databaseNames.includes('noir-wallet-bitcoin-change-v1-db'),
        bitcoinInputDatabasePresent: databaseNames.includes('noir-wallet-bitcoin-input-v1-db')
      }
    },
    { orphanWalletId, walletKey, accountKey }
  )

  expect(result).toMatchObject({
    response: { success: true },
    wallets: [],
    balances: {},
    syncStates: {},
    pendingTransactions: [],
    pendingZcashTransactions: [],
    bitcoinDiscoveryDatabasePresent: false,
    bitcoinChangeDatabasePresent: false,
    bitcoinInputDatabasePresent: false,
    counts: {
      walletData: 0,
      transactions: 0,
      transparentTransactionCache: 0,
      syncJournal: 0,
      syncJournalManifest: 0,
      walletPersistenceQuarantine: 0
    }
  })
  expect(result.seed).toBeUndefined()
  expect(result.hardware).toBeUndefined()
  expect(result.legacy).toBeUndefined()
  expect(result.migration).toBeUndefined()
})
