import test from 'node:test'
import assert from 'node:assert/strict'

const storage = {
  get: async () => ({}),
  set: async () => {},
  remove: async () => {}
}
globalThis.chrome = {
  storage: { local: storage, session: storage, onChanged: { addListener: () => {} } }
}
const { buildVisibleAccountList, hasAccountMenuAddAction } =
  await import('../../../src/popup/services/account-list-model.ts')

const wallet = {
  id: 'wallet-1',
  name: 'Main Wallet',
  createdAt: 100,
  accounts: [
    {
      id: 'account-1',
      name: 'Savings',
      addresses: { shielded: 'u1legacy-shielded', transparent: 't1legacy-transparent' },
      isPinned: true,
      isHidden: false
    },
    {
      id: 'account-2',
      name: 'Reserve',
      addresses: { shielded: 'u1hidden-shielded', transparent: 't1hidden-transparent' },
      isPinned: false,
      isHidden: true
    }
  ]
}

const catalogAccount = {
  walletId: 'wallet-1',
  accountId: 'account-1',
  accountDisplayName: 'Savings',
  accountIndex: 0,
  walletDisplayName: 'Main Wallet',
  walletSource: { kind: 'software' },
  networks: [
    {
      chain: { displayName: 'Ethereum', family: 'evm' },
      addresses: [{ value: '0xPublicAddress' }],
      privateExecutionAddress: '0xPrivateExecutionAddress'
    },
    {
      chain: { displayName: 'BNB Chain', family: 'evm' },
      addresses: [{ value: '0xpublicaddress' }],
      privateExecutionAddress: '0xPrivateExecutionAddress'
    },
    {
      chain: { displayName: 'Bitcoin', family: 'bitcoin' },
      addresses: [{ value: 'bc1qBitcoinAddress' }]
    },
    {
      chain: { displayName: 'Zcash', family: 'zcash' },
      addresses: [{ value: 'u1legacy-shielded' }, { value: 't1legacy-transparent' }]
    }
  ]
}

function list(searchQuery, nativeAccounts = [catalogAccount]) {
  return buildVisibleAccountList({
    wallets: [wallet],
    accountDisplayNames: { 'wallet-1_account-1': 'Renamed Savings' },
    nativeAccounts,
    searchQuery
  })
}

test('searches current catalog public, private execution, Bitcoin, and Zcash addresses on the retained account', () => {
  for (const query of [
    '0xPUBLICADDRESS',
    'privateexecution',
    'bitcoinaddress',
    'u1legacy-shielded',
    't1legacy-transparent',
    'renamed savings'
  ]) {
    const result = list(query)
    assert.deepEqual([...result.filteredAccountKeys], ['wallet-1:account-1'], query)
    assert.deepEqual(
      result.pinnedAccounts.map(account => account.id),
      ['account-1'],
      query
    )
    assert.equal(result.nativeAccounts.length, 0, query)
  }
  const addresses = list('').filteredAccounts[0].addresses
  assert.equal(addresses.length, 5)
  assert.deepEqual(
    [...list('main wallet').filteredAccountKeys],
    ['wallet-1:account-1', 'wallet-1:account-2']
  )
  assert.equal(list('privateexecution', []).filteredAccounts.length, 0)
})

test('preserves hidden accounts and does not duplicate catalog accounts already retained by the wallet', () => {
  const hiddenCatalogAccount = {
    ...catalogAccount,
    accountId: 'account-2',
    networks: [
      {
        chain: { displayName: 'Ethereum', family: 'evm' },
        addresses: [{ value: '0xHiddenPublic' }]
      }
    ]
  }
  const result = list('hiddenpublic', [catalogAccount, hiddenCatalogAccount])
  assert.deepEqual([...result.filteredAccountKeys], ['wallet-1:account-2'])
  assert.deepEqual(
    result.hiddenAccounts.map(account => account.id),
    ['account-2']
  )
  assert.equal(result.pinnedAccounts.length, 0)
  assert.equal(result.nativeAccounts.length, 0)
  assert.equal(list('').nativeAccounts.length, 0)
})

test('searches addresses and PEA for catalog-only accounts without changing name and network search', () => {
  const native = {
    ...catalogAccount,
    walletId: 'native-wallet',
    accountId: 'native-account'
  }
  for (const query of [
    '0xpublicaddress',
    'privateexecution',
    'bitcoinaddress',
    'Savings',
    'Ethereum'
  ]) {
    const result = list(query, [native])
    assert.deepEqual(
      result.nativeAccounts.map(account => account.accountId),
      ['native-account'],
      query
    )
  }
  assert.equal(list('missing', [native]).nativeAccounts.length, 0)
})

test('orders retained and imported wallets by creation time across sources', () => {
  const retained = {
    ...wallet,
    accounts: [{ ...wallet.accounts[0], isPinned: false }]
  }
  const earlyNative = {
    ...catalogAccount,
    walletId: 'native-early',
    accountId: 'native-early-account',
    walletCreatedAt: 50
  }
  const lateNative = {
    ...catalogAccount,
    walletId: 'native-late',
    accountId: 'native-late-account',
    walletCreatedAt: 150
  }
  const result = buildVisibleAccountList({
    wallets: [retained],
    accountDisplayNames: {},
    nativeAccounts: [lateNative, catalogAccount, earlyNative],
    searchQuery: ''
  })
  assert.deepEqual(
    result.regularEntries.map(entry => entry.walletId),
    ['native-early', 'wallet-1', 'native-late']
  )

  const legacy = buildVisibleAccountList({
    wallets: [retained],
    accountDisplayNames: {},
    nativeAccounts: [lateNative, { ...earlyNative, walletCreatedAt: undefined }],
    searchQuery: ''
  })
  assert.deepEqual(
    legacy.regularEntries.map(entry => entry.walletId),
    ['wallet-1', 'native-late', 'native-early']
  )
})

test('omits empty wallet groups while preserving a wallet-specific Add Account action for pinned or hidden accounts', () => {
  const first = { ...wallet, accounts: [{ ...wallet.accounts[0], isPinned: true }] }
  const second = {
    ...wallet,
    id: 'wallet-2',
    name: 'Second Wallet',
    createdAt: 200,
    accounts: [{ ...wallet.accounts[1], isHidden: true }]
  }
  const result = buildVisibleAccountList({
    wallets: [first, second],
    accountDisplayNames: {},
    nativeAccounts: [],
    searchQuery: ''
  })
  assert.deepEqual(result.regularEntries, [])
  assert.deepEqual(
    result.pinnedAccounts.map(account => account.walletId),
    ['wallet-1']
  )
  assert.deepEqual(
    result.hiddenAccounts.map(account => account.walletId),
    ['wallet-2']
  )
  const firstAction = result.walletAddAccountActions.get(first.id)
  assert.equal(hasAccountMenuAddAction(first, firstAction), true)
  assert.equal(hasAccountMenuAddAction(second, result.walletAddAccountActions.get(second.id)), true)
  assert.equal(hasAccountMenuAddAction(first, undefined), false)
  assert.equal(hasAccountMenuAddAction(second, firstAction), false)
  assert.equal(
    hasAccountMenuAddAction(
      { ...first, accounts: [{ ...first.accounts[0], isPinned: false }] },
      firstAction
    ),
    false
  )

  const search = buildVisibleAccountList({
    wallets: [first, second],
    accountDisplayNames: {},
    nativeAccounts: [],
    searchQuery: 'Savings'
  })
  assert.deepEqual(search.regularEntries, [])
  assert.deepEqual(
    search.pinnedAccounts.map(account => account.walletId),
    ['wallet-1']
  )
  assert.deepEqual(search.hiddenAccounts, [])
})

test('groups private keys across chain families without merging wallet or account identities', () => {
  const privateKey = (walletId, chainFamily, createdAt) => ({
    ...catalogAccount,
    walletId,
    accountId: 'account-1',
    walletDisplayName: `${chainFamily} import`,
    walletCreatedAt: createdAt,
    walletSource: { kind: 'private-key', chainFamily }
  })
  const imports = [privateKey('evm-key', 'eip155', 200), privateKey('sol-key', 'solana', 50)]
  const input = {
    wallets: [],
    accountDisplayNames: {},
    nativeAccounts: imports,
    searchQuery: ''
  }
  const result = buildVisibleAccountList(input)
  assert.equal(result.regularEntries.length, 1)
  const group = result.regularEntries[0]
  assert.equal(group.kind, 'private-key')
  assert.equal(group.displayName, 'Imported Private Key')
  assert.equal(group.walletId, null)
  assert.equal(group.addAccount, null)
  assert.deepEqual(
    group.accounts.map(item => item.account.walletId),
    ['sol-key', 'evm-key']
  )
  assert.equal(
    buildVisibleAccountList({ ...input, searchQuery: 'Imported Private Key' }).regularEntries[0]
      .accounts.length,
    2
  )
  const filtered = buildVisibleAccountList({ ...input, searchQuery: 'solana import' })
  assert.deepEqual(
    filtered.regularEntries[0].accounts.map(item => item.account.walletId),
    ['sol-key']
  )
  assert.deepEqual(buildVisibleAccountList({ ...input, searchQuery: 'missing' }).regularEntries, [])
})

test('keeps different hardware wallets separate and groups retained and native accounts of one wallet', () => {
  const retained = {
    ...wallet,
    keySource: 'ledger',
    accounts: [{ ...wallet.accounts[0], isPinned: false }]
  }
  const hardware = (walletId, accountId, vendor) => ({
    ...catalogAccount,
    walletId,
    accountId,
    walletDisplayName: 'Custom device name',
    walletSource: {
      kind: 'hardware',
      hardware: { vendor, firmwareProfile: vendor === 'ledger' ? 'multi-app' : 'multi-coin' }
    }
  })
  const native = [
    hardware('wallet-1', 'account-1', 'ledger'),
    hardware('wallet-1', 'account-2', 'ledger'),
    hardware('other-ledger', 'account-1', 'ledger'),
    hardware('keystone', 'account-1', 'keystone')
  ]
  const input = {
    wallets: [retained],
    accountDisplayNames: {},
    nativeAccounts: native,
    searchQuery: ''
  }
  const result = buildVisibleAccountList(input)
  assert.equal(result.regularEntries.length, 3)
  const group = result.regularEntries.find(entry => entry.walletId === 'wallet-1')
  assert.equal(group.displayName, 'Main Wallet')
  assert.equal(group.hardwareVendor, 'ledger')
  assert.equal(group.addAccount, null)
  assert.deepEqual(
    group.accounts.map(item => item.kind),
    ['retained', 'native']
  )
  assert.deepEqual(
    group.accounts.map(item =>
      item.kind === 'retained' ? item.account.id : item.account.accountId
    ),
    ['account-1', 'account-2']
  )
  assert.equal(
    result.regularEntries.find(entry => entry.walletId === 'other-ledger').addAccount,
    null
  )
  assert.equal(result.regularEntries.find(entry => entry.walletId === 'keystone').addAccount, null)
  const filtered = buildVisibleAccountList({ ...input, searchQuery: 'Custom device name' })
  assert.equal(
    filtered.regularEntries.find(entry => entry.walletId === 'wallet-1').accounts.length,
    1
  )
})

test('hardware wallets never expose Add Account for pinned or hidden retained accounts', () => {
  for (const keySource of ['ledger', 'keystone']) {
    const retained = {
      ...wallet,
      keySource,
      accounts: wallet.accounts.map(account => ({ ...account }))
    }
    const result = buildVisibleAccountList({
      wallets: [retained],
      accountDisplayNames: {},
      nativeAccounts: [],
      searchQuery: ''
    })
    assert.equal(result.walletAddAccountActions.has(wallet.id), false)
    assert.equal(result.regularEntries.length, 0)
    assert.equal(
      hasAccountMenuAddAction(retained, { kind: 'software', walletId: wallet.id }),
      false
    )
  }
  const catalogHardware = {
    ...catalogAccount,
    walletSource: {
      kind: 'hardware',
      hardware: { vendor: 'ledger', firmwareProfile: 'multi-app' }
    }
  }
  const catalogResult = buildVisibleAccountList({
    wallets: [wallet],
    accountDisplayNames: {},
    nativeAccounts: [catalogHardware],
    searchQuery: ''
  })
  assert.equal(catalogResult.walletAddAccountActions.has(wallet.id), false)
  assert.equal(catalogResult.regularEntries.length, 0)
})
