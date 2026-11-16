const createdAt = 1_700_000_000_000

const encryptedEnvelope = Object.freeze({
  encryptedData: 'Zml4dHVyZS1jaXBoZXJ0ZXh0',
  salt: 'AAAAAAAAAAAAAAAAAAAAAA==',
  iv: 'AAAAAAAAAAAAAAAA'
})

function account(id, derivationIndex, overrides = {}) {
  return {
    id,
    name: `Account ${derivationIndex + 1}`,
    addresses: {
      transparent: `t-fixture-${id}`,
      shielded: `u-fixture-${id}`,
      fullUnified: `u-full-fixture-${id}`
    },
    derivationIndex,
    birthdayHeight: 2_000_000 + derivationIndex,
    isPinned: false,
    isHidden: false,
    ...overrides
  }
}

function wallet(id, accounts, overrides = {}) {
  return {
    id,
    name: `Fixture ${id}`,
    seedPhraseKey: `seed_${id}`,
    accounts,
    createdAt,
    isPinned: false,
    keySource: 'software',
    ...overrides
  }
}

function persist(state, version = 0) {
  return JSON.stringify({ state, version })
}

function walletState(wallets, currentWalletId, currentAccountId, accountDisplayNames = {}) {
  return persist({
    currentWalletId,
    currentAccountId,
    currentNetwork: 'mainnet',
    zecPrice: 0,
    wallets,
    accountDisplayNames
  })
}

function accountData(balances = {}, syncStates = {}) {
  return persist({ balances, syncStates })
}

const empty = {
  id: 'empty-profile',
  local: {},
  session: {},
  indexedDb: { databaseVersion: null, stores: {} },
  expected: { wallets: 0, accounts: 0, keySources: [] }
}

const softwareSingle = (() => {
  const firstAccount = account('account-software-0', 0)
  const firstWallet = wallet('wallet-software', [firstAccount])
  return {
    id: 'software-single-account',
    local: {
      wallet_state: walletState([firstWallet], firstWallet.id, firstAccount.id),
      account_data: accountData(),
      [`seed_${firstWallet.id}`]: encryptedEnvelope
    },
    session: {},
    indexedDb: {
      databaseVersion: 5,
      stores: {
        walletData: [
          {
            key: 'mainnet_wallet-software',
            metadata: {
              version: 1,
              network: 'mainnet',
              walletId: firstWallet.id,
              chunked: true,
              chunkCount: 2,
              totalBytes: 1024
            }
          }
        ],
        transactions: [],
        transparentTransactionCache: [],
        syncJournal: [],
        syncJournalManifest: []
      }
    },
    expected: { wallets: 1, accounts: 1, keySources: ['software'] }
  }
})()

const softwareMultiAccount = (() => {
  const accounts = [
    account('account_multi_0', 0),
    account('account_multi_2', 2, {
      addresses: {
        transparent: 't-fixture-rotated',
        shielded: 'u-fixture-rotated',
        fullUnified: 'u-full-fixture-rotated'
      }
    })
  ]
  const firstWallet = wallet('wallet_with_underscores', accounts)
  return {
    id: 'software-multi-account',
    local: {
      wallet_state: walletState([firstWallet], firstWallet.id, accounts[1].id, {
        [`${firstWallet.id}_${accounts[1].id}`]: 'Savings'
      }),
      account_data: accountData(
        {
          [`mainnet_${firstWallet.id}_${accounts[0].id}`]: {
            total: '0',
            transparent: '0',
            shielded: '0'
          }
        },
        {
          [`mainnet_${firstWallet.id}`]: {
            isSyncing: false,
            syncProgress: 100,
            currentHeight: 2_100_000,
            latestHeight: 2_100_000,
            lastSyncTime: createdAt,
            etaMs: null
          }
        }
      ),
      [`seed_${firstWallet.id}`]: encryptedEnvelope,
      connectedDApps: [
        {
          origin: 'https://fixture-dapp.example',
          walletId: firstWallet.id,
          accountId: accounts[0].id,
          authorizedAccounts: [accounts[0].id],
          connectedAt: createdAt,
          lastActiveAt: createdAt
        }
      ]
    },
    session: {},
    indexedDb: {
      databaseVersion: 5,
      stores: {
        walletData: [],
        transactions: [
          {
            key: `mainnet_${firstWallet.id}_${accounts[0].id}`,
            records: [
              {
                id: 'transaction-fixture-pending',
                txHash: 'fixture-transaction-hash',
                status: 'pending',
                type: 'send'
              }
            ]
          }
        ],
        transparentTransactionCache: [],
        syncJournal: [
          {
            walletKey: `mainnet_${firstWallet.id}`,
            seq: 1,
            fromHeight: 2_099_990,
            toHeight: 2_100_000,
            deltaBase64: 'Zml4dHVyZS1kZWx0YQ=='
          }
        ],
        syncJournalManifest: [
          {
            walletKey: `mainnet_${firstWallet.id}`,
            baseSeq: 0,
            nextSeq: 2,
            totalBytes: 13
          }
        ]
      }
    },
    expected: { wallets: 1, accounts: 2, keySources: ['software'] }
  }
})()

const keystone = (() => {
  const firstAccount = account('account-keystone-0', 0)
  const firstWallet = wallet('wallet-keystone', [firstAccount], {
    seedPhraseKey: '',
    keySource: 'keystone'
  })
  return {
    id: 'keystone-single-account',
    local: {
      wallet_state: walletState([firstWallet], firstWallet.id, firstAccount.id),
      [`hw_${firstWallet.id}`]: encryptedEnvelope
    },
    session: {},
    indexedDb: { databaseVersion: 5, stores: {} },
    expected: { wallets: 1, accounts: 1, keySources: ['keystone'] }
  }
})()

const mixedWallets = (() => {
  const softwareAccount = account('account-mixed-software-0', 0)
  const hardwareAccount = account('account-mixed-keystone-0', 0)
  const softwareWallet = wallet('wallet-mixed-software', [softwareAccount])
  const hardwareWallet = wallet('wallet-mixed-keystone', [hardwareAccount], {
    seedPhraseKey: '',
    keySource: 'keystone'
  })
  return {
    id: 'software-and-keystone',
    local: {
      wallet_state: walletState(
        [softwareWallet, hardwareWallet],
        softwareWallet.id,
        softwareAccount.id
      ),
      [`seed_${softwareWallet.id}`]: encryptedEnvelope,
      [`hw_${hardwareWallet.id}`]: encryptedEnvelope
    },
    session: {},
    indexedDb: { databaseVersion: 5, stores: {} },
    expected: { wallets: 2, accounts: 2, keySources: ['software', 'keystone'] }
  }
})()

const partiallyCorrupt = {
  id: 'partially-corrupt-profile',
  local: {
    wallet_state: JSON.stringify({
      state: {
        currentWalletId: 'wallet-corrupt',
        currentAccountId: 'missing-account',
        currentNetwork: 'mainnet',
        wallets: [
          {
            id: 'wallet-corrupt',
            name: 'Corrupt Fixture',
            seedPhraseKey: 'seed_wallet-corrupt',
            accounts: [{ id: 42, derivationIndex: -1 }],
            createdAt: 'not-a-timestamp',
            isPinned: false
          }
        ],
        accountDisplayNames: {}
      },
      version: 0
    }),
    'seed_wallet-corrupt': {
      encryptedData: 'not-valid-base64***',
      salt: '',
      iv: null
    },
    orphan_key: { preserved: true }
  },
  session: {
    session_password: { encryptedData: 'stale-session' }
  },
  indexedDb: {
    databaseVersion: 5,
    stores: {
      walletData: [
        {
          key: 'mainnet_wallet-corrupt',
          metadata: { version: 999, chunked: true, chunkCount: -1 }
        }
      ],
      transactions: [{ key: 'orphan-account-key', records: [{ id: null }] }]
    }
  },
  expected: { wallets: 0, accounts: 0, keySources: [], quarantined: true }
}

const legacyWalletData = (() => {
  const firstAccount = account('legacy-account-0', 0)
  const firstWallet = wallet('legacy-wallet', [firstAccount])
  return {
    id: 'historical-legacy-wallet-data',
    local: {
      walletData: {
        wallets: [firstWallet],
        currentWalletId: firstWallet.id,
        currentAccountId: firstAccount.id,
        network: 'mainnet'
      },
      [`seed_${firstWallet.id}`]: encryptedEnvelope
    },
    session: {},
    indexedDb: { databaseVersion: 3, stores: { walletData: [] } },
    expected: { wallets: 1, accounts: 1, keySources: ['software'], historical: true }
  }
})()

export const V1_MIGRATION_FIXTURES = Object.freeze([
  empty,
  softwareSingle,
  softwareMultiAccount,
  keystone,
  mixedWallets,
  partiallyCorrupt,
  legacyWalletData
])
