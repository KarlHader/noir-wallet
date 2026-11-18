import { test } from 'node:test'
import { expect } from '@playwright/test'

import { BackgroundMultichainSessionDAppHandler } from '../../../src/background/multichain-session-dapp-handler.ts'
import { selectDAppSessionAccounts } from '../../../src/background/dapp-session-accounts.ts'
import { DAppManager } from '../../../src/core/dapp/dapp-manager.ts'

const ethereum = 'eip155:1'
const zcash = 'bip122:00040fe8ec8471911baa1db1266ea15d'
const bitcoin = 'bip122:000000000019d6689c085ae165831e93'
const custom = 'eip155:4663'
const reference = { walletId: 'wallet-1', accountId: 'account-1' }
const address = '0x1111111111111111111111111111111111111111'

function proposal(scope = { chainId: ethereum, chainName: 'Ethereum', iconChain: 'eth' }) {
  return {
    ...scope,
    accounts: [
      {
        id: 'account-1',
        label: 'Account 1',
        address,
        reference,
        required: true
      }
    ],
    preselectedIds: ['account-1'],
    activeReference: reference,
    activeAddress: address
  }
}

function createHandler({
  selectedIds = ['account-1'],
  prepareProposal = proposal,
  activeChainIds,
  manager,
  readFirstPartySnapshot,
  readTokenList,
  openTokenManager,
  bitcoinEnabled = false,
  executionAccounts = [address]
} = {}) {
  let stored = null
  let revision = 0
  const approvals = []
  const events = []
  const invocations = []
  let approveConnection = true
  const handler = new BackgroundMultichainSessionDAppHandler({
    network: 'mainnet',
    readTokenList,
    openTokenManager,
    ...(activeChainIds === undefined ? {} : { activeChainIds }),
    ...(readFirstPartySnapshot === undefined ? {} : { readFirstPartySnapshot }),
    evmNetworks: [ethereum, custom].map(chainId => ({
      networkMode: 'mainnet',
      chainId,
      numericChainId: Number(chainId.split(':')[1]),
      networkName: 'mainnet',
      displayName: 'Ethereum',
      iconChain: 'eth',
      nativeCurrency: {
        name: 'Ether',
        symbol: 'ETH',
        decimals: 18,
        slip44Reference: '60'
      },
      rpcUrl: 'https://rpc.example',
      explorerUrl: 'https://explorer.example'
    })),
    manager: manager ?? {
      canAutoConnectSession: async () => false,
      getAllConnections: async () => [],
      getCaip25Session: async () => stored,
      getAuthorizationRevision: async () => revision,
      setCaip25Session: async (_origin, _tab, authorizations, session, _zcash, expected) => {
        expect(expected).toBe(revision)
        expect(authorizations).toEqual(
          session.scopes.map(scope => ({
            chainId: scope.chainId,
            accounts: [reference],
            binding: reference
          }))
        )
        stored = session
        return ++revision
      }
    },
    approval: {
      requestExternalApproval: async (_origin, action, data) => {
        approvals.push({ action, data })
        return {
          approved: approveConnection,
          requestId: 'approval-1',
          selectedScopes: { evm: selectedIds }
        }
      },
      broadcastProviderEvent: async (...args) => {
        events.push(args)
      },
      cancelPendingApprovals: () => 0
    },
    zcash: {
      prepareSessionAccountSelection: async () => proposal(),
      resolveSessionAccountSelection: async (value, ids) => selectDAppSessionAccounts(value, ids),
      getSessionAccounts: async () => [],
      revokeAllPermissions: async () => {
        stored = null
      }
    },
    evm: {
      prepareSessionAccountSelection: async (_origin, scope) => prepareProposal(scope),
      resolveSessionAccountSelection: async (value, ids) => selectDAppSessionAccounts(value, ids),
      getSessionAccounts: async () => executionAccounts,
      getCaip2ChainId: () => ethereum
    },
    bitcoin: {
      prepareSessionAccountSelection: async () => proposal(),
      resolveSessionAccountSelection: async (value, ids) => selectDAppSessionAccounts(value, ids),
      getSessionAccounts: async () => []
    },
    bitcoinEnabled,
    solana: null,
    near: null,
    dispatch: async (...args) => {
      invocations.push(args)
      return 'invoked'
    }
  })
  return {
    handler,
    approvals,
    events,
    invocations,
    getStored: () => stored,
    setStored: session => {
      stored = session
    },
    getRevision: () => revision,
    setApproveConnection: approved => {
      approveConnection = approved
    }
  }
}

test('token metadata and manager require the current authorized account and reject context changes', async () => {
  let snapshot = { identity: 'one', activeReference: reference }
  let reads = 0
  let opens = 0
  let changeDuringRead = false
  const metadata = [
    {
      assetId: 'eip155:1/slip44:60',
      chainId: ethereum,
      contractAddress: null,
      symbol: 'ETH',
      decimals: 18,
      enabled: true
    }
  ]
  const { handler } = createHandler({
    readFirstPartySnapshot: async () => snapshot,
    readTokenList: async scope => {
      reads++
      expect(scope).toEqual({
        keyDomainId: reference.walletId,
        accountId: reference.accountId,
        chainIds: [ethereum]
      })
      if (changeDuringRead) snapshot = { ...snapshot, identity: 'changed' }
      return metadata
    },
    openTokenManager: async () => {
      opens++
    }
  })
  const origin = 'https://dapp.example'
  for (const method of ['wallet_getTokenList', 'wallet_openTokenManager']) {
    await expect(handler.request({ method }, origin, {})).rejects.toMatchObject({ code: 4100 })
  }
  expect(reads).toBe(0)
  expect(opens).toBe(0)
  await handler.request(
    {
      method: 'wallet_createSession',
      params: { scopes: { [ethereum]: { methods: ['eth_accounts'], notifications: [] } } }
    },
    origin,
    {}
  )
  await expect(handler.request({ method: 'wallet_getTokenList' }, origin, {})).resolves.toEqual(
    metadata
  )
  await expect(
    handler.request({ method: 'wallet_openTokenManager' }, origin, {})
  ).resolves.toBeNull()
  expect(opens).toBe(1)
  snapshot = { ...snapshot, activeReference: { walletId: 'other', accountId: 'other' } }
  await expect(
    handler.request({ method: 'wallet_getTokenList' }, origin, {})
  ).rejects.toMatchObject({ code: 4100 })
  expect(reads).toBe(1)
  snapshot = { identity: 'one', activeReference: reference }
  changeDuringRead = true
  await expect(
    handler.request({ method: 'wallet_getTokenList' }, origin, {})
  ).rejects.toMatchObject({ code: 4100 })
})

test('creates one shared EVM approval while preserving atomic chain scopes and methods', async () => {
  const {
    handler,
    approvals,
    events,
    invocations,
    getStored,
    setStored,
    getRevision,
    setApproveConnection
  } = createHandler()

  const session = await handler.request(
    {
      method: 'wallet_createSession',
      params: {
        scopes: {
          [ethereum]: {
            methods: ['eth_accounts'],
            notifications: ['wallet_sessionChanged']
          },
          [custom]: {
            methods: ['eth_accounts'],
            notifications: []
          }
        }
      }
    },
    'https://dapp.example',
    {
      title: 'Example',
      favIconUrl: 'https://dapp.example/icon.png',
      pageUrl: 'https://dapp.example/swap'
    }
  )

  expect(approvals).toHaveLength(1)
  expect(approvals[0].data.favicon).toBe('https://dapp.example/icon.png')
  expect(approvals[0].data.faviconPageUrl).toBe('https://dapp.example/swap')
  expect(approvals[0].data.scopes).toHaveLength(1)
  expect(approvals[0].data.scopes[0]).toMatchObject({ chainId: 'evm', chainName: 'EVM' })
  expect(approvals[0].data.scopes[0].accounts[0].accountKey).toBe(
    JSON.stringify([reference.walletId, reference.accountId])
  )
  expect(approvals[0].data.scopes[0].networks.map(network => network.chainId)).toEqual([
    ethereum,
    custom
  ])
  expect(session.scopes[ethereum].accounts).toEqual([`${ethereum}:${address}`])
  expect(session.scopes[custom].accounts).toEqual([`${custom}:${address}`])
  expect(getStored().scopes.map(scope => scope.accounts)).toEqual([[reference], [reference]])
  expect(getStored().scopes.map(scope => scope.methods)).toEqual([
    ['eth_accounts'],
    ['eth_accounts']
  ])
  expect(events.at(-1).slice(0, 3)).toEqual([
    'https://dapp.example',
    'multichain',
    'wallet_sessionChanged'
  ])

  const previousSession = getStored()
  setStored({
    ...previousSession,
    scopes: [
      ...previousSession.scopes,
      { chainId: bitcoin, methods: ['getAccounts'], notifications: [] }
    ]
  })
  setApproveConnection(false)
  await expect(handler.reconnect('https://dapp.example')).rejects.toMatchObject({ code: 4001 })
  expect(getStored().scopes.map(scope => scope.chainId)).toEqual([ethereum, custom, bitcoin])
  expect(getRevision()).toBe(1)
  setApproveConnection(true)
  await handler.reconnect('https://dapp.example')
  expect(approvals).toHaveLength(3)
  expect(getStored()).toEqual(previousSession)
  expect(getRevision()).toBe(2)
  expect(approvals[2].data.scopes).toHaveLength(1)
  expect(approvals[2].data.scopes[0].chainId).toBe('evm')

  await expect(
    handler.request(
      {
        method: 'wallet_invokeMethod',
        params: { scope: ethereum, request: { method: 'eth_accounts' } }
      },
      'https://dapp.example',
      {}
    )
  ).resolves.toBe('invoked')
  expect(invocations).toHaveLength(1)
  expect(invocations[0][4]).toBe(ethereum)

  await expect(
    handler.request(
      {
        method: 'wallet_invokeMethod',
        params: { scope: ethereum, request: { method: 'eth_sendTransaction', params: [] } }
      },
      'https://dapp.example',
      {}
    )
  ).rejects.toMatchObject({ code: 4100 })

  await expect(
    handler.request(
      {
        method: 'wallet_invokeMethod',
        params: { scope: 'eip155:999', request: { method: 'eth_accounts' } }
      },
      'https://dapp.example',
      {}
    )
  ).rejects.toMatchObject({ code: 4100 })
  setStored({ scopes: [{ chainId: bitcoin, methods: ['getAccounts'], notifications: [] }] })
  await expect(handler.reconnect('https://dapp.example')).rejects.toMatchObject({ code: 5100 })
  expect(approvals).toHaveLength(3)
  expect(getStored().scopes[0].chainId).toBe(bitcoin)
})

test('Native Zcash sessions reject Public methods, including methods retained in old sessions', async () => {
  let stored = {
    scopes: [{ chainId: zcash, methods: ['zcash_getPublicAssets'], notifications: [] }]
  }
  const dispatched = []
  const handler = new BackgroundMultichainSessionDAppHandler({
    network: 'mainnet',
    evmNetworks: [],
    manager: {
      getAllConnections: async () => [],
      getCaip25Session: async () => stored,
      getAuthorizationRevision: async () => 0,
      setCaip25Session: async () => {
        throw new Error('Unexpected commit')
      }
    },
    approval: {
      requestExternalApproval: async () => {
        throw new Error('Unexpected approval')
      }
    },
    zcash: {
      prepareSessionAccountSelection: async () =>
        proposal({ chainId: zcash, chainName: 'Zcash', iconChain: 'zec' }),
      getSessionAccounts: async () => [address]
    },
    evm: {},
    bitcoin: {},
    solana: null,
    near: null,
    dispatch: async (...args) => {
      dispatched.push(args)
    }
  })
  const origin = 'https://dapp.example'
  for (const method of [
    'zcash_getPublicAccount',
    'zcash_activatePublicAccount',
    'zcash_getPublicAssets',
    'zcash_sendPublicTransaction',
    'zcash_getPublicTransaction'
  ]) {
    await expect(
      handler.request(
        {
          method: 'wallet_createSession',
          params: { scopes: { [zcash]: { methods: [method], notifications: [] } } }
        },
        origin,
        {}
      )
    ).rejects.toMatchObject({ code: 5101 })
    stored = { scopes: [{ chainId: zcash, methods: [method], notifications: [] }] }
    await expect(handler.reconnect(origin)).rejects.toMatchObject({ code: 5101 })
    const legacySession = await handler.request({ method: 'wallet_getSession' }, origin, {})
    expect(legacySession.scopes[zcash].methods).toEqual([])
    await expect(
      handler.request(
        {
          method: 'wallet_invokeMethod',
          params: { scope: zcash, request: { method } }
        },
        origin,
        {}
      )
    ).rejects.toMatchObject({ code: 4100 })
  }
  expect(dispatched).toEqual([])
})

test('Native Zcash approval aborts on intervening authorization changes', async () => {
  let revision = 3
  let changeDuringApproval = false
  let changeDuringSessionNotification = false
  let readsSinceCommit = 0
  let stored = null
  let approvalData
  let broadcasts = 0
  const committedRevisions = []
  const handler = new BackgroundMultichainSessionDAppHandler({
    network: 'mainnet',
    evmNetworks: [],
    manager: {
      getAllConnections: async () => [],
      getCaip25Session: async () => {
        readsSinceCommit += 1
        if (changeDuringSessionNotification && readsSinceCommit === 2) revision += 1
        return stored
      },
      getAuthorizationRevision: async () => revision,
      setCaip25Session: async (_origin, _tab, _authorizations, session, _zcash, expected) => {
        committedRevisions.push(expected)
        stored = session
        readsSinceCommit = 0
        return ++revision
      }
    },
    approval: {
      requestExternalApproval: async (_origin, _action, data) => {
        approvalData = data
        if (changeDuringApproval) revision += 1
        return { approved: true, selectedScopes: { [zcash]: ['account-1'] } }
      },
      broadcastProviderEvent: async () => {
        broadcasts += 1
      }
    },
    zcash: {
      prepareSessionAccountSelection: async () =>
        proposal({ chainId: zcash, chainName: 'Zcash', iconChain: 'zec' }),
      resolveSessionAccountSelection: async value =>
        selectDAppSessionAccounts(value, ['account-1']),
      getSessionAccounts: async () => [address]
    },
    evm: {},
    bitcoin: {},
    solana: null,
    near: null,
    dispatch: async () => null
  })
  const request = () =>
    handler.request(
      {
        method: 'wallet_createSession',
        params: { scopes: { [zcash]: { methods: ['zcash_getAccounts'], notifications: [] } } }
      },
      'https://dapp.example',
      {}
    )
  await expect(request()).resolves.toMatchObject({ scopes: { [zcash]: {} } })
  expect(approvalData.linksIdentities).toBeUndefined()
  expect(committedRevisions).toEqual([3])
  expect(broadcasts).toBe(1)
  changeDuringApproval = true
  await expect(handler.reconnect('https://dapp.example')).rejects.toMatchObject({ code: 4100 })
  expect(committedRevisions).toEqual([3])
  changeDuringApproval = false
  changeDuringSessionNotification = true
  await expect(request()).rejects.toMatchObject({ code: 4100 })
  expect(committedRevisions).toEqual([3, 5])
  expect(broadcasts).toBe(1)
})

test('multichain Connect grants only networks supported by the active account', async () => {
  const zcash = 'bip122:00040fe8ec8471911baa1db1266ea15d'
  const bitcoin = 'bip122:000000000019d6689c085ae165831e93'
  const { handler, approvals, getStored } = createHandler({
    activeChainIds: async () => [ethereum]
  })
  const origin = 'https://dapp.example'
  const request = scopes =>
    handler.request({ method: 'wallet_createSession', params: { scopes } }, origin, {})
  const session = await request({
    [zcash]: { methods: ['zcash_getAccounts'], notifications: [] },
    [ethereum]: { methods: ['eth_accounts'], notifications: [] },
    [custom]: { methods: ['eth_accounts'], notifications: [] },
    [bitcoin]: { methods: ['getAccounts'], notifications: [] },
    'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': { methods: ['getAccounts'], notifications: [] },
    'near:mainnet': { methods: ['getAccounts'], notifications: [] }
  })
  expect(Object.keys(session.scopes)).toEqual([ethereum])
  expect(getStored().scopes.map(scope => scope.chainId)).toEqual([ethereum])
  expect(approvals).toHaveLength(1)
  expect(approvals[0].data.scopes.map(scope => scope.chainId)).toEqual(['evm'])
  await expect(
    handler.request(
      {
        method: 'wallet_invokeMethod',
        params: { scope: zcash, request: { method: 'zcash_getAccounts' } }
      },
      origin,
      {}
    )
  ).rejects.toMatchObject({ code: 4100 })
  await expect(
    request({ [zcash]: { methods: ['zcash_getAccounts'], notifications: [] } })
  ).rejects.toMatchObject({ code: 5100 })
  await expect(
    request({ [ethereum]: { methods: ['zcash_getAccounts'], notifications: [] } })
  ).rejects.toMatchObject({ code: 5101 })
  expect(approvals).toHaveLength(1)
  expect(getStored().scopes.map(scope => scope.chainId)).toEqual([ethereum])
})

test('shared EVM selection cannot widen a scope with a narrower account request', async () => {
  const otherAddress = '0x2222222222222222222222222222222222222222'
  const { handler, approvals, getStored } = createHandler({
    selectedIds: ['account-1', 'account-2'],
    prepareProposal: scope => ({
      ...proposal(scope),
      accounts: [
        ...proposal(scope).accounts,
        {
          id: 'account-2',
          label: 'Account 2',
          address: otherAddress,
          reference: { walletId: 'wallet-2', accountId: 'account-2' },
          required: false
        }
      ]
    })
  })
  await expect(
    handler.request(
      {
        method: 'wallet_createSession',
        params: {
          scopes: {
            [ethereum]: { methods: ['eth_accounts'], notifications: [] },
            [custom]: {
              accounts: [`${custom}:${address}`],
              methods: ['eth_accounts'],
              notifications: []
            }
          }
        }
      },
      'https://dapp.example',
      {}
    )
  ).rejects.toMatchObject({ code: 4100 })
  expect(approvals[0].data.scopes[0].accounts.map(account => account.id)).toEqual(['account-1'])
  expect(getStored()).toBeNull()
})

function firstPartyFixture({ executionAccounts, executionMode = 'main' } = {}) {
  const values = new Map()
  let writes = 0
  const manager = new DAppManager({
    get: async keys =>
      Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, values.get(key)])),
    set: async entries => {
      writes++
      for (const [key, value] of Object.entries(entries)) values.set(key, value)
    }
  })
  const other = { walletId: 'wallet-2', accountId: 'account-2' }
  const zcash = 'bip122:00040fe8ec8471911baa1db1266ea15d'
  const bitcoin = 'bip122:000000000019d6689c085ae165831e93'
  const state = {
    snapshot: {
      identity: 'unlocked-generation-1',
      executionMode,
      activeReference: reference,
      accounts: {
        [ethereum]: [{ reference, address }],
        [custom]: [{ reference, address }],
        [zcash]: [{ reference: other, address: 'u1publicfixture' }],
        [bitcoin]: [{ reference: other, address: 'bc1publicfixture' }]
      }
    }
  }
  const options = {
    manager,
    // First-party sessions also include enabled chains belonging to other wallets.
    activeChainIds: async () => [ethereum],
    bitcoinEnabled: true,
    readFirstPartySnapshot: async () => state.snapshot,
    ...(executionAccounts === undefined ? {} : { executionAccounts })
  }
  return {
    ...createHandler(options),
    manager,
    state,
    other,
    zcash,
    bitcoin,
    createAgain: () => createHandler(options).handler,
    getWrites: () => writes
  }
}

test('first-party session reads connect every enabled network and synchronize account changes', async () => {
  for (const origin of ['https://app.zknoir.com', 'https://noirdevelop.refburrow.top']) {
    const { handler, manager, state, other, zcash, bitcoin, approvals, getWrites, createAgain } =
      firstPartyFixture()
    const read = () => handler.request({ method: 'wallet_getSession' }, origin, {})
    const [session, concurrent] = await Promise.all([read(), read()])
    expect(concurrent).toEqual(session)
    expect(Object.keys(session.scopes)).toEqual([zcash, ethereum, custom, bitcoin])
    expect(session.scopes[zcash].accounts).toEqual([`${zcash}:u1publicfixture`])
    expect((await manager.getChainAuthorization(origin, bitcoin)).accounts).toEqual([other])
    expect(approvals).toHaveLength(0)
    const writes = getWrites()
    await read()
    expect(getWrites()).toBe(writes)

    state.snapshot = {
      ...state.snapshot,
      identity: 'unlocked-generation-2',
      accounts: {
        ...state.snapshot.accounts,
        [ethereum]: [
          ...state.snapshot.accounts[ethereum],
          { reference: other, address: '0x2222222222222222222222222222222222222222' }
        ]
      }
    }
    const updated = await read()
    expect(updated.scopes[ethereum].accounts).toHaveLength(2)
    expect((await manager.getEvmAuthorization(origin)).accounts).toEqual([reference, other])
    expect(await createAgain().request({ method: 'wallet_getSession' }, origin, {})).toEqual(
      updated
    )

    state.snapshot = null
    expect(await read()).toBeNull()
    expect(approvals).toHaveLength(0)
  }
})

test('official Connect all skips connection approval while third-party Connect retains it', async () => {
  const { handler, manager, approvals, zcash } = firstPartyFixture()
  const request = {
    method: 'wallet_createSession',
    params: {
      properties: { application: 'Official application' },
      scopes: {
        [ethereum]: { methods: ['eth_accounts'], notifications: [] }
      }
    }
  }
  const origin = 'https://noirdevelop.refburrow.top'
  const [, session] = await Promise.all([
    handler.request({ method: 'wallet_getSession' }, origin, {}),
    handler.request(request, origin, {})
  ])
  expect(session.properties).toEqual({ application: 'Official application' })
  expect(session.scopes[zcash].accounts).toHaveLength(1)
  expect(approvals).toHaveLength(0)
  expect(await manager.canAutoConnectSession(origin)).toBe(true)
  expect(
    await handler.request({ method: 'wallet_getSession' }, 'https://untrusted.example', {})
  ).toBeNull()
  await handler.request(request, 'https://untrusted.example', {})
  expect(approvals).toHaveLength(1)
})

test('first-party auto-connect cannot grant Public methods without approval', async () => {
  const { handler, manager, approvals } = firstPartyFixture()
  const origin = 'https://app.zknoir.com'
  const method = 'noir_getPublicAssets'
  const invoke = () =>
    handler.request(
      {
        method: 'wallet_invokeMethod',
        params: { scope: ethereum, request: { method } }
      },
      origin,
      {}
    )
  const automatic = await handler.request({ method: 'wallet_getSession' }, origin, {})
  expect(automatic.scopes[ethereum].methods).not.toContain(method)
  await expect(invoke()).rejects.toMatchObject({ code: 4100 })
  expect(approvals).toHaveLength(0)

  const approved = await handler.request(
    {
      method: 'wallet_createSession',
      params: { scopes: { [ethereum]: { methods: [method], notifications: [] } } }
    },
    origin,
    {}
  )
  expect(approved.scopes[ethereum].methods).toEqual([method])
  expect((await manager.getCaip25Session(origin)).scopes[0].methods).toEqual([method])
  expect(approvals).toHaveLength(1)
})

test('automatic refresh preserves chain revocation and declines changed or locked snapshots', async () => {
  const { handler, manager, bitcoin, state, approvals } = firstPartyFixture()
  const origin = 'https://app.zknoir.com'
  await handler.request({ method: 'wallet_getSession' }, origin, {})
  await manager.removeChainAuthorization(origin, bitcoin)
  const retained = await handler.request({ method: 'wallet_getSession' }, origin, {})
  expect(retained.scopes[bitcoin]).toBeUndefined()
  expect(await manager.getChainAuthorization(origin, bitcoin)).toBeNull()
  await manager.removeConnection(origin)
  const snapshot = state.snapshot
  state.snapshot = null
  expect(await handler.request({ method: 'wallet_getSession' }, origin, {})).toBeNull()
  expect(await manager.getCaip25Session(origin)).toBeNull()
  state.snapshot = snapshot
  const restored = await handler.request({ method: 'wallet_getSession' }, origin, {})
  expect(restored).toBeNull()
  expect(await manager.isRevoked(origin)).toBe(true)
  expect(await manager.canAutoConnectSession(origin)).toBe(false)
  const reconnected = await handler.request(
    {
      method: 'wallet_createSession',
      params: { scopes: { [ethereum]: { methods: ['eth_accounts'], notifications: [] } } }
    },
    origin,
    {}
  )
  expect(approvals).toHaveLength(1)
  expect(reconnected.scopes[ethereum].accounts).toHaveLength(1)
  expect(await manager.canAutoConnectSession(origin)).toBe(false)

  const fresh = firstPartyFixture()
  let reads = 0
  const changed = createHandler({
    manager: fresh.manager,
    readFirstPartySnapshot: async () => ({ ...state.snapshot, identity: `changed-${reads++}` })
  }).handler
  expect(await changed.request({ method: 'wallet_getSession' }, origin, {})).toBeNull()
  expect(await fresh.manager.getCaip25Session(origin)).toBeNull()
})

test('first-party sessions retain the current Private EVM identity without a Main fallback', async () => {
  const privateAddress = '0x3333333333333333333333333333333333333333'
  for (const executionAccounts of [[privateAddress], [], [address]]) {
    const { handler } = firstPartyFixture({ executionAccounts, executionMode: 'private' })
    const session = await handler.request(
      { method: 'wallet_getSession' },
      'https://app.zknoir.com',
      {}
    )
    for (const chainId of [ethereum, custom]) {
      expect(session.scopes[chainId].accounts).toEqual(
        executionAccounts[0] === privateAddress ? [`${chainId}:${privateAddress}`] : []
      )
    }
  }
})
