import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import {
  connectionAuthorizesAccount,
  DAppManager,
  parseStoredDAppConnection
} from '../../../src/core/dapp/dapp-manager.ts'
import { initializeEvmSiteNetworks } from '../../../src/background/wallet-dapp-evm-networks.ts'

const require = createRequire(import.meta.url)
const typescript = require('typescript')

const origin = 'https://connected.example'
const account = { walletId: 'wallet-1', accountId: 'account-1' }

test('EVM network consent is origin-scoped, persistent, and cleared by EVM revocation', async () => {
  const { manager, storage } = managerFixture()
  const otherOrigin = 'https://other.example'
  await manager.setEvmAuthorizedAccounts(origin, {}, [account], account)
  await manager.setEvmAuthorizedAccounts(otherOrigin, {}, [account], account)
  assert.equal(await manager.getEvmNetworkState(origin), null)
  await assert.rejects(
    manager.setEvmActiveChain(origin, 'eip155:56', { approve: false, expectedActiveChainId: null }),
    /network permission/
  )
  await manager.setEvmActiveChain(origin, 'eip155:1', {
    approve: true,
    expectedActiveChainId: null
  })
  await manager.setEvmActiveChain(origin, 'eip155:56', {
    approve: true,
    expectedActiveChainId: 'eip155:1'
  })
  await manager.setEvmActiveChain(origin, 'eip155:1', {
    approve: false,
    expectedActiveChainId: 'eip155:56'
  })
  await assert.rejects(
    manager.setEvmActiveChain(origin, 'eip155:137', {
      approve: false,
      expectedActiveChainId: 'eip155:1'
    }),
    /network permission/
  )
  await assert.rejects(
    manager.setEvmActiveChain(origin, 'eip155:56', {
      approve: false,
      expectedActiveChainId: null
    }),
    /network changed/
  )
  const reloaded = new DAppManager(storage)
  assert.deepEqual(await reloaded.getEvmNetworkState(origin), {
    activeChainId: 'eip155:1',
    approvedChainIds: ['eip155:1', 'eip155:56']
  })
  assert.equal(await reloaded.getEvmNetworkState(otherOrigin), null)
  await reloaded.removeEvmAuthorization(origin)
  assert.equal(await new DAppManager(storage).getEvmNetworkState(origin), null)
  await assert.rejects(
    reloaded.setEvmActiveChain(origin, 'eip155:56', { approve: false }),
    /network permission/
  )
})

test('a stale EVM network approval cannot survive revoke and reconnect', async () => {
  const { manager } = managerFixture()
  await manager.setEvmAuthorizedAccounts(origin, {}, [account], account)
  const expectedRevision = await manager.getAuthorizationRevision(origin)
  await manager.removeEvmAuthorization(origin)
  await manager.setEvmAuthorizedAccounts(origin, {}, [account], account)
  await assert.rejects(
    manager.setEvmActiveChain(origin, 'eip155:56', {
      approve: true,
      expectedActiveChainId: null,
      expectedRevision
    }),
    /authorization changed/
  )
  assert.equal(await manager.getEvmNetworkState(origin), null)
})

test('legacy grants allow only their explicitly reviewed EVM networks', async () => {
  const { manager, storage } = managerFixture()
  await manager.setChainAuthorizedAccounts(origin, {}, 'eip155:1', [account], account)
  assert.deepEqual(await manager.getEvmNetworkState(origin), {
    activeChainId: 'eip155:1',
    approvedChainIds: ['eip155:1']
  })
  await assert.rejects(
    manager.setEvmActiveChain(origin, 'eip155:56', { approve: false }),
    /network permission/
  )
  await manager.setEvmActiveChain(origin, 'eip155:1', { approve: false })
  await manager.removeChainAuthorization(origin, 'eip155:1')
  assert.equal(await new DAppManager(storage).getEvmNetworkState(origin), null)
})

test('stored EVM network consent rejects malformed or widened state', () => {
  const connection = {
    id: 'stored',
    name: 'Stored',
    host: 'connected.example',
    origin,
    favicon: '',
    connectedAt: 1,
    lastActiveAt: 1,
    evmAuthorization: { accounts: [account], binding: account }
  }
  for (const evmNetworkState of [
    { activeChainId: 'eip155:1', approvedChainIds: ['eip155:56'] },
    { activeChainId: 'eip155:1', approvedChainIds: ['eip155:1', 'eip155:1'] },
    { activeChainId: 'eip155:01', approvedChainIds: ['eip155:01'] },
    {
      activeChainId: 'eip155:1',
      approvedChainIds: Array.from({ length: 17 }, (_, i) => `eip155:${i + 1}`)
    }
  ]) {
    assert.throws(
      () => parseStoredDAppConnection({ ...connection, evmNetworkState }),
      /EVM network state|EVM network chain ID/
    )
  }
})

function managerFixture() {
  const values = new Map()
  let failWrites = false
  const storage = {
    async get(keys) {
      return Object.fromEntries(
        (Array.isArray(keys) ? keys : [keys])
          .filter(key => values.has(key))
          .map(key => [key, structuredClone(values.get(key))])
      )
    },
    async set(items) {
      if (failWrites) throw new Error('storage unavailable')
      for (const [key, value] of Object.entries(items)) values.set(key, structuredClone(value))
    }
  }
  return {
    manager: new DAppManager(storage),
    storage,
    values,
    setFailWrites: value => {
      failWrites = value
    }
  }
}

function balanceHandlerFixture(manager) {
  const first = {
    id: account.accountId,
    name: 'First',
    addresses: { transparent: 't-first', shielded: 'zs-first' }
  }
  const second = {
    id: 'account-2',
    name: 'Second',
    addresses: { transparent: 't-second', shielded: 'zs-second' }
  }
  const wallet = { id: account.walletId, name: 'Wallet', accounts: [first, second] }
  const state = {
    currentWalletId: wallet.id,
    currentAccountId: first.id,
    currentNetwork: 'mainnet',
    wallets: [wallet],
    accountDisplayNames: {},
    getAccount(walletId, accountId) {
      return this.wallets
        .find(item => item.id === walletId)
        ?.accounts.find(item => item.id === accountId)
    }
  }
  const runtime = {
    locked: false,
    isLocked() {
      return this.locked
    },
    getCurrentAccount() {
      return state.getAccount(state.currentWalletId, state.currentAccountId)
    }
  }
  const balance = {
    transparent: '1',
    shielded: '2',
    total: '3',
    spendable: '2',
    available: '2'
  }
  const source = readFileSync(
    new URL('../../../src/background/dapp-handler.ts', import.meta.url),
    'utf8'
  )
  const { outputText } = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022
    }
  })
  const module = { exports: {} }
  const dependencies = {
    '../core/dapp/dapp-manager': { dappManager: manager, connectionAuthorizesAccount },
    '@/core/dapp/first-party-policy': { shouldAutoConnectDApp: () => false },
    './zcash-wallet-runtime': { backgroundZcashWalletRuntime: runtime },
    './sync-scheduler': { syncScheduler: { requestPassiveSync() {} } },
    '@/store/wallet-store': { useWalletStore: { getState: () => state } },
    '@/store/account-data-store': {
      useAccountDataStore: { getState: () => ({ getBalance: () => balance }) }
    },
    '@/config/wallet': { WALLET_CONFIG: { SYNC: { DAPP_BALANCE_SYNC_STALE_MS: 30_000 } } },
    '@/lib/format': {
      getAccountDisplayName: (_walletId, _accountId, name) => name,
      formatWalletName: item => item.name
    },
    '@/core/zcash/wallet-rpc-errors': { isRetryableWalletRpcError: () => false }
  }
  new Function('require', 'module', 'exports', outputText)(
    specifier => dependencies[specifier] ?? {},
    module,
    module.exports
  )
  return { handler: new module.exports.DAppHandler(), state, runtime, balance }
}

test('Zcash balance reads recheck the authorized context after account resolution', async t => {
  for (const change of ['none', 'revoke', 'account', 'lock', 'network']) {
    await t.test(change, async () => {
      const { manager } = managerFixture()
      await manager.setAuthorizedAccounts(origin, {}, [account], account)
      const { handler, state, runtime, balance } = balanceHandlerFixture(manager)
      await handler.initialize()

      let signalResolved
      let releaseResolution
      const resolved = new Promise(resolve => {
        signalResolved = resolve
      })
      const hold = new Promise(resolve => {
        releaseResolution = resolve
      })
      const resolveBalances = handler.resolveAccountBalances.bind(handler)
      handler.resolveAccountBalances = async site => {
        const accounts = await resolveBalances(site)
        signalResolved()
        await hold
        return accounts
      }

      const reading = handler.handleRequest({ method: 'zcash_getBalance', origin })
      await resolved
      try {
        if (change === 'revoke') await manager.removeConnection(origin)
        if (change === 'account') state.currentAccountId = 'account-2'
        if (change === 'lock') runtime.locked = true
        if (change === 'network') state.currentNetwork = 'testnet'
      } finally {
        releaseResolution()
      }

      if (change === 'none') {
        const result = await reading
        assert.equal(result.total, balance.total)
        assert.deepEqual(
          result.accounts.map(item => item.accountId),
          [account.accountId]
        )
      } else {
        await assert.rejects(reading, /Wallet account or site connection changed/)
      }
    })
  }
})

test('explicit revocation survives reload and a stale connect approval cannot restore access', async () => {
  const { manager, storage } = managerFixture()
  await manager.setAuthorizedAccounts(origin, {}, [account], account, { automatic: true })
  assert.deepEqual((await manager.getAuthorization(origin)).accounts, [account])
  const pendingRevision = await manager.getAuthorizationRevision(origin)

  await manager.removeConnection(origin)
  const reloaded = new DAppManager(storage)
  assert.equal(await reloaded.isRevoked(origin), true)
  assert.equal(await reloaded.canAutoConnect(origin), false)
  assert.deepEqual(await reloaded.getAuthorizedAccounts(origin), [])
  await assert.rejects(
    reloaded.setAuthorizedAccounts(origin, {}, [account], account, { automatic: true }),
    /Site authorization changed/
  )
  await assert.rejects(
    reloaded.setAuthorizedAccounts(origin, {}, [account], account, {
      expectedRevision: pendingRevision
    }),
    /Site authorization changed/
  )

  const reconnectRevision = await reloaded.getAuthorizationRevision(origin)
  await reloaded.setAuthorizedAccounts(origin, {}, [account], account, {
    expectedRevision: reconnectRevision
  })
  assert.equal(await reloaded.isRevoked(origin), false)
  assert.deepEqual(await reloaded.getAuthorizedAccounts(origin), [account])

  await reloaded.clearConnections()
  const afterModeChange = new DAppManager(storage)
  assert.equal(await afterModeChange.isRevoked(origin), true)
  assert.deepEqual(await afterModeChange.getAuthorizedAccounts(origin), [])
})

test('Public authorization metadata survives reload without restoring revoked or automatic access', async () => {
  const { manager, storage } = managerFixture()
  const revokedOrigin = 'https://revoked.example'
  const publicOrigin = 'https://public.example'
  const unreviewedOrigin = 'https://unreviewed.example'
  const legacyOrigin = 'https://legacy.example'
  await manager.setAuthorizedAccounts(origin, {}, [account], account)
  await storage.set({
    dapp_authorization_state: {
      [origin]: { revision: 3, mode: 'approved', publicExplicit: true },
      [revokedOrigin]: { revision: 4, mode: 'revoked', publicExplicit: true },
      [publicOrigin]: { revision: 5, publicExplicit: true },
      [unreviewedOrigin]: { revision: 6, mode: 'unreviewed' },
      [legacyOrigin]: { revision: 7 }
    }
  })
  const restored = new DAppManager(storage)
  await restored.initialize()
  assert.deepEqual(await restored.getAuthorization(origin), { revision: 3, accounts: [account] })
  assert.equal(await restored.isRevoked(revokedOrigin), true)
  assert.equal(await restored.canAutoConnect(revokedOrigin), false)
  assert.equal(await restored.canAutoConnect(publicOrigin), false)
  assert.deepEqual(await restored.getAuthorizedAccounts(publicOrigin), [])
  assert.equal(await restored.canAutoConnect(unreviewedOrigin), true)
  assert.equal(await restored.canAutoConnect(legacyOrigin), true)
  await assert.rejects(
    restored.setAuthorizedAccounts(publicOrigin, {}, [account], account, { automatic: true }),
    /Site authorization changed/
  )
  await assert.rejects(
    restored.setAuthorizedAccounts(unreviewedOrigin, {}, [account], account, {
      expectedRevision: 5
    }),
    /Site authorization changed/
  )
  await restored.setAuthorizedAccounts(unreviewedOrigin, {}, [account], account, {
    automatic: true,
    expectedRevision: 6
  })
  await restored.setAuthorizedAccounts(publicOrigin, {}, [account], account, {
    expectedRevision: 5
  })
  await restored.removeConnection(publicOrigin)
  const { dapp_authorization_state: persisted } = await storage.get('dapp_authorization_state')
  assert.deepEqual(persisted[publicOrigin], { revision: 6, mode: 'revoked', publicExplicit: true })
  const reloaded = new DAppManager(storage)
  assert.equal(await reloaded.canAutoConnect(publicOrigin), false)
  assert.equal(await reloaded.isRevoked(revokedOrigin), true)
  assert.deepEqual(await reloaded.getAuthorizedAccounts(unreviewedOrigin), [account])
})

test('an existing browser favicon data URL does not erase approved connections on reload', async () => {
  const { manager, storage } = managerFixture()
  const favicon = `data:image/png;base64,${'a'.repeat(20_000)}`
  await manager.setAuthorizedAccounts(origin, {}, [account], account)
  const { connectedDApps } = await storage.get('connectedDApps')
  await storage.set({ connectedDApps: [{ ...connectedDApps[0], favicon }] })

  const restored = new DAppManager(storage)
  const [connection] = await restored.getAllConnections()
  assert.equal(connection?.favicon, favicon)
  assert.deepEqual(await restored.getAuthorizedAccounts(origin), [account])

  await storage.set({
    connectedDApps: [
      { ...connectedDApps[0], favicon: `data:image/png;base64,${'a'.repeat(300_000)}` }
    ]
  })
  const oversizedLegacy = new DAppManager(storage)
  assert.equal((await oversizedLegacy.getAllConnections())[0]?.favicon, `${origin}/favicon.ico`)
  assert.deepEqual(await oversizedLegacy.getAuthorizedAccounts(origin), [account])
  await oversizedLegacy.removeConnection(origin)
  const disconnected = new DAppManager(storage)
  assert.deepEqual(await disconnected.getAllConnections(), [])
  assert.equal(await disconnected.isRevoked(origin), true)
})

test('shared EVM authorization projects onto custom chains and revokes without removing Zcash', async () => {
  const { manager, storage, setFailWrites } = managerFixture()
  const other = { walletId: 'wallet-2', accountId: 'account-2' }
  await manager.setAuthorizedAccounts(origin, {}, [account], account)
  await manager.setEvmAuthorizedAccounts(origin, {}, [account, other], other)
  assert.deepEqual(await manager.getChainAuthorization(origin, 'eip155:31337'), {
    chainId: 'eip155:31337',
    accounts: [account, other],
    binding: other
  })
  assert.deepEqual((await new DAppManager(storage).getEvmAuthorization(origin))?.accounts, [
    account,
    other
  ])

  setFailWrites(true)
  await assert.rejects(manager.removeEvmAuthorization(origin), /storage unavailable/)
  assert.deepEqual((await manager.getEvmAuthorization(origin))?.accounts, [account, other])
  setFailWrites(false)
  const staleRevision = await manager.getAuthorizationRevision(origin)
  await manager.removeEvmAuthorization(origin)
  assert.equal(await manager.getEvmAuthorization(origin), null)
  assert.equal(await manager.getChainAuthorization(origin, 'eip155:1'), null)
  assert.deepEqual(await manager.getAuthorizedAccounts(origin), [account])
  assert.equal(await manager.getAuthorizationRevision(origin), staleRevision + 1)
  await assert.rejects(
    manager.setEvmAuthorizedAccounts(origin, {}, [other], other, staleRevision),
    /authorization changed/
  )
  await assert.rejects(
    manager.setCaip25Session(
      origin,
      {},
      [{ chainId: 'eip155:1', accounts: [other], binding: other }],
      { scopes: [{ chainId: 'eip155:1', methods: ['eth_accounts'], notifications: [] }] },
      undefined,
      staleRevision
    ),
    /authorization changed/
  )
})

test('ordinary EVM reconnect clears old EVM session scopes', async () => {
  const { manager } = managerFixture()
  const other = { walletId: 'wallet-2', accountId: 'account-2' }
  await manager.setCaip25Session(
    origin,
    {},
    [
      { chainId: 'eip155:1', accounts: [account], binding: account },
      { chainId: 'eip155:56', accounts: [account], binding: account }
    ],
    {
      scopes: [
        { chainId: 'eip155:1', methods: ['eth_accounts'], notifications: [] },
        { chainId: 'eip155:56', methods: ['eth_accounts'], notifications: [] }
      ]
    }
  )
  assert.deepEqual((await manager.getCaip25Session(origin))?.scopes[0].accounts, [account])
  await manager.setEvmAuthorizedAccounts(origin, {}, [other], other)
  assert.deepEqual(await manager.getChainAuthorization(origin, 'eip155:1'), {
    chainId: 'eip155:1',
    accounts: [other],
    binding: other
  })
  assert.deepEqual(await manager.getChainAuthorization(origin, 'eip155:137'), {
    chainId: 'eip155:137',
    accounts: [other],
    binding: other
  })
  assert.equal(await manager.getCaip25Session(origin), null)
  await assert.rejects(
    manager.setCaip25Session(
      origin,
      {},
      [
        { chainId: 'eip155:1', accounts: [account], binding: account },
        { chainId: 'eip155:56', accounts: [other], binding: other }
      ],
      {
        scopes: [
          { chainId: 'eip155:1', methods: ['eth_accounts'], notifications: [] },
          { chainId: 'eip155:56', methods: ['eth_accounts'], notifications: [] }
        ]
      }
    ),
    /shared Account selection/
  )
})

test('ordinary EVM reconnect preserves explicitly granted legacy network consent', async () => {
  const { manager, storage } = managerFixture()
  const other = { walletId: 'wallet-2', accountId: 'account-2' }
  await manager.setChainAuthorizedAccounts(origin, {}, 'eip155:56', [account], account)
  assert.deepEqual(await manager.getEvmNetworkState(origin), {
    activeChainId: 'eip155:56',
    approvedChainIds: ['eip155:56']
  })
  await manager.setEvmAuthorizedAccounts(origin, {}, [other], other)
  assert.deepEqual(await new DAppManager(storage).getEvmNetworkState(origin), {
    activeChainId: 'eip155:56',
    approvedChainIds: ['eip155:56']
  })
  await assert.rejects(
    manager.setEvmActiveChain(origin, 'eip155:1', { approve: false }),
    /network permission/
  )
})

test('removing a custom chain drops its session scope but retains the shared EVM grant', async () => {
  const { manager } = managerFixture()
  await manager.setEvmAuthorizedAccounts(origin, {}, [account], account)
  await manager.setEvmActiveChain(origin, 'eip155:56', { approve: true })
  await manager.setCaip25Session(
    origin,
    {},
    [
      { chainId: 'eip155:1', accounts: [account], binding: account },
      { chainId: 'eip155:31337', accounts: [account], binding: account }
    ],
    {
      scopes: [
        { chainId: 'eip155:1', methods: ['eth_accounts'], notifications: [] },
        { chainId: 'eip155:31337', methods: ['eth_accounts'], notifications: [] }
      ]
    }
  )
  assert.deepEqual(await manager.getEvmNetworkState(origin), {
    activeChainId: 'eip155:56',
    approvedChainIds: ['eip155:56', 'eip155:1', 'eip155:31337']
  })
  const result = await manager.removeChainAuthorizations(['eip155:31337'])
  assert.deepEqual(result.affectedOrigins, [origin])
  assert.deepEqual(
    (await manager.getCaip25Session(origin))?.scopes.map(scope => scope.chainId),
    ['eip155:1']
  )
  assert.deepEqual((await manager.getEvmAuthorization(origin))?.accounts, [account])
  assert.deepEqual(await manager.getEvmNetworkState(origin), {
    activeChainId: 'eip155:56',
    approvedChainIds: ['eip155:56', 'eip155:1']
  })

  await manager.setEvmActiveChain(origin, 'eip155:31337', { approve: true })
  const consentOnly = await manager.removeChainAuthorizations(['eip155:31337'])
  assert.deepEqual(consentOnly.affectedOrigins, [origin])
  assert.equal(
    (await manager.getEvmNetworkState(origin))?.approvedChainIds.includes('eip155:31337'),
    false
  )
})

test('removing the only approved EVM chain does not approve the fallback chain on reload', async () => {
  const { manager, storage } = managerFixture()
  await manager.setEvmAuthorizedAccounts(origin, {}, [account], account)
  await manager.setEvmActiveChain(origin, 'eip155:31337', { approve: true })
  await manager.removeChainAuthorizations(['eip155:31337'])

  const reloaded = new DAppManager(storage)
  await initializeEvmSiteNetworks(reloaded, 'eip155:1')
  assert.deepEqual(await reloaded.getEvmAuthorization(origin), {
    accounts: [account],
    binding: account
  })
  assert.equal(await reloaded.getEvmNetworkState(origin), null)
  assert.equal(await reloaded.getChainAuthorization(origin, 'eip155:1'), null)
  await assert.rejects(
    reloaded.setEvmActiveChain(origin, 'eip155:1', { approve: false }),
    /network permission/
  )
  await reloaded.setEvmAuthorizedAccounts(origin, {}, [account], account)
  await reloaded.setEvmActiveChain(origin, 'eip155:1', { approve: true })
  assert.deepEqual(await reloaded.getChainAuthorization(origin, 'eip155:1'), {
    chainId: 'eip155:1',
    accounts: [account],
    binding: account
  })
})

test('identical legacy EVM grants migrate with their session account snapshot', async () => {
  const { storage, values, setFailWrites } = managerFixture()
  values.set('connectedDApps', [
    {
      id: 'legacy',
      name: 'Legacy',
      host: 'connected.example',
      origin,
      favicon: '',
      connectedAt: 1,
      lastActiveAt: 1,
      chainAuthorizations: [
        { chainId: 'eip155:1', accounts: [account], binding: account },
        { chainId: 'eip155:56', accounts: [account], binding: account }
      ],
      caip25Session: {
        scopes: [{ chainId: 'eip155:1', methods: ['eth_accounts'], notifications: [] }]
      }
    }
  ])
  const manager = new DAppManager(storage)
  setFailWrites(true)
  await assert.rejects(manager.getEvmAuthorization(origin), /storage unavailable/)
  assert.equal(values.get('connectedDApps')[0].evmAuthorization, undefined)
  setFailWrites(false)
  assert.deepEqual((await manager.getEvmAuthorization(origin))?.accounts, [account])
  assert.deepEqual(values.get('connectedDApps')[0].caip25Session.scopes[0].accounts, [account])
  assert.deepEqual(values.get('connectedDApps')[0].chainAuthorizations, [])
  assert.deepEqual(await manager.getEvmNetworkState(origin), {
    activeChainId: 'eip155:1',
    approvedChainIds: ['eip155:1', 'eip155:56']
  })
})

test('EVM-only revoke advances its revision without consuming Zcash auto-connect', async () => {
  const { manager } = managerFixture()
  const pendingRevision = await manager.getAuthorizationRevision(origin)
  await manager.removeEvmAuthorization(origin)
  assert.equal(await manager.getAuthorizationRevision(origin), pendingRevision + 1)
  assert.equal(await manager.canAutoConnect(origin), true)
  await assert.rejects(
    manager.setEvmAuthorizedAccounts(origin, {}, [account], account, pendingRevision),
    /authorization changed/
  )
  await manager.setAuthorizedAccounts(origin, {}, [account], account, { automatic: true })
  assert.deepEqual(await manager.getAuthorizedAccounts(origin), [account])
  assert.equal(await manager.canAutoConnect(origin), true)
})

test('account deletion cannot widen a CAIP-25 scope to another shared EVM account', async () => {
  const { storage, values } = managerFixture()
  const other = { walletId: 'wallet-2', accountId: 'account-2' }
  values.set('connectedDApps', [
    {
      id: 'scoped',
      name: 'Scoped',
      host: 'connected.example',
      origin,
      favicon: '',
      connectedAt: 1,
      lastActiveAt: 1,
      evmAuthorization: { accounts: [account, other], binding: account },
      caip25Session: {
        scopes: [
          {
            chainId: 'eip155:1',
            accounts: [account],
            methods: ['eth_accounts'],
            notifications: []
          }
        ]
      }
    }
  ])
  const manager = new DAppManager(storage)
  assert.deepEqual((await manager.getChainAuthorization(origin, 'eip155:1'))?.accounts, [account])
  await manager.removeAccountReferences(account.walletId, account.accountId)
  assert.deepEqual((await manager.getEvmAuthorization(origin))?.accounts, [other])
  assert.deepEqual((await manager.getCaip25Session(origin))?.scopes[0].accounts, [])
  assert.equal(await manager.getChainAuthorization(origin, 'eip155:1'), null)
  assert.deepEqual((await manager.getChainAuthorization(origin, 'eip155:56'))?.accounts, [other])
})

test('account deletion retains network consent only for surviving EVM grants', async () => {
  const { manager, storage } = managerFixture()
  const other = { walletId: 'wallet-2', accountId: 'account-2' }
  await manager.setEvmAuthorizedAccounts(origin, {}, [account], account)
  await manager.setChainAuthorizedAccounts(origin, {}, 'eip155:1', [other], other)
  await manager.setEvmActiveChain(origin, 'eip155:56', { approve: true })
  await manager.removeAccountReferences(account.walletId, account.accountId)
  assert.equal(await manager.getEvmAuthorization(origin), null)
  assert.deepEqual(await new DAppManager(storage).getEvmNetworkState(origin), {
    activeChainId: 'eip155:1',
    approvedChainIds: ['eip155:1']
  })
})

test('wallet-side CAIP-25 account authorization stays within approved scopes and commits atomically', async () => {
  const { manager, storage, setFailWrites } = managerFixture()
  const next = { walletId: 'wallet-2', accountId: 'account-2' }
  const zcash = 'bip122:00040fe8ec8471911baa1db1266ea15d'
  await manager.setCaip25Session(
    origin,
    {},
    [
      { chainId: 'eip155:1', accounts: [account], binding: account },
      { chainId: 'eip155:56', accounts: [account], binding: account },
      { chainId: zcash, accounts: [account], binding: account }
    ],
    {
      scopes: [
        {
          chainId: 'eip155:1',
          methods: ['eth_accounts'],
          notifications: ['wallet_sessionChanged']
        },
        { chainId: 'eip155:56', methods: ['eth_accounts', 'personal_sign'], notifications: [] },
        { chainId: zcash, methods: ['zcash_getBalance'], notifications: [] }
      ],
      properties: { purpose: 'lending' }
    },
    { accounts: [account], binding: account }
  )
  const before = await manager.getConnection(origin)
  const pendingRevision = await manager.getAuthorizationRevision(origin)
  await assert.rejects(
    manager.addCaip25AuthorizedAccount(origin, ['eip155:137'], next),
    /network permission/
  )
  assert.deepEqual(await manager.getConnection(origin), before)
  setFailWrites(true)
  await assert.rejects(
    manager.addCaip25AuthorizedAccount(origin, ['eip155:1', zcash], next),
    /storage unavailable/
  )
  assert.deepEqual(await manager.getConnection(origin), before)
  assert.equal(await manager.getAuthorizationRevision(origin), pendingRevision)
  setFailWrites(false)
  await manager.addCaip25AuthorizedAccount(origin, ['eip155:1', zcash], next)
  assert.equal(await manager.getAuthorizationRevision(origin), pendingRevision + 1)
  await assert.rejects(
    manager.setCaip25Session(
      origin,
      {},
      [{ chainId: 'eip155:1', accounts: [account], binding: account }],
      { scopes: [{ chainId: 'eip155:1', methods: ['eth_accounts'], notifications: [] }] },
      undefined,
      pendingRevision
    ),
    /authorization changed/
  )
  const reloaded = new DAppManager(storage)
  assert.deepEqual((await reloaded.getChainAuthorization(origin, 'eip155:1'))?.accounts, [
    account,
    next
  ])
  assert.deepEqual((await reloaded.getChainAuthorization(origin, 'eip155:56'))?.accounts, [account])
  assert.deepEqual((await reloaded.getChainAuthorization(origin, 'eip155:137'))?.accounts, [
    account
  ])
  assert.deepEqual((await reloaded.getChainAuthorization(origin, zcash))?.accounts, [account, next])
  assert.deepEqual(await reloaded.getAuthorizedAccounts(origin), [account, next])
  const after = await reloaded.getConnection(origin)
  assert.deepEqual(
    after.caip25Session.scopes.map(scope => scope.methods),
    before.caip25Session.scopes.map(scope => scope.methods)
  )
  assert.deepEqual(
    after.caip25Session.scopes.map(scope => scope.chainId),
    before.caip25Session.scopes.map(scope => scope.chainId)
  )
  assert.deepEqual(after.caip25Session.properties, before.caip25Session.properties)
  assert.deepEqual(after.caip25Session.scopes[0].accounts, [account, next])
  assert.deepEqual(after.caip25Session.scopes[1].accounts, [account])
})

test('revoking legacy Zcash permission does not block an existing EVM session account', async () => {
  const { manager } = managerFixture()
  const next = { walletId: 'wallet-2', accountId: 'account-2' }
  await manager.setCaip25Session(
    origin,
    {},
    [{ chainId: 'eip155:1', accounts: [account], binding: account }],
    { scopes: [{ chainId: 'eip155:1', methods: ['eth_accounts'], notifications: [] }] }
  )
  await manager.removeLegacyAuthorization(origin)
  assert.equal(await manager.isRevoked(origin), true)
  await manager.addCaip25AuthorizedAccount(origin, ['eip155:1'], next)
  assert.deepEqual((await manager.getChainAuthorization(origin, 'eip155:1'))?.accounts, [
    account,
    next
  ])

  const zcash = 'bip122:00040fe8ec8471911baa1db1266ea15d'
  await manager.setCaip25Session(
    origin,
    {},
    [
      { chainId: 'eip155:1', accounts: [account], binding: account },
      { chainId: zcash, accounts: [account], binding: account }
    ],
    {
      scopes: [
        { chainId: 'eip155:1', methods: ['eth_accounts'], notifications: [] },
        { chainId: zcash, methods: ['zcash_getBalance'], notifications: [] }
      ]
    },
    { accounts: [account], binding: account }
  )
  await manager.removeLegacyAuthorization(origin)
  await assert.rejects(
    manager.addCaip25AuthorizedAccount(origin, [zcash], next),
    /Zcash permission/
  )
})
