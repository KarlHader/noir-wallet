import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  connectionAuthorizesAccount,
  connectionAuthorizesAccountForWalletStatus,
  DAppManager,
  getConnectionAccountRefs,
  getConnectionChainAuthorization,
  connectionHasEvmAuthorization,
  connectionHasEvmAuthorizationForAccount,
  parseStoredDAppConnections,
  pruneDAppChainAuthorizations,
  pruneDAppAccountReferences,
  replaceDAppAuthorization,
  replaceDAppChainAuthorization,
  summarizeDAppPrivateExecutionSupport
} from '../../../src/core/dapp/dapp-manager.ts'

const connectedAt = 1_700_000_000_000

function connection(origin, refs, binding = refs[0]) {
  return {
    id: `dapp-${origin}`,
    name: origin,
    host: origin,
    origin,
    favicon: '',
    connectedAt,
    lastActiveAt: connectedAt,
    boundWalletId: binding?.walletId,
    boundAccountId: binding?.accountId,
    authorizedAccounts: refs
  }
}

test.describe('dApp account reference cleanup', () => {
  test('treats the explicit Account selection as authoritative over a stale binding', () => {
    const selected = { walletId: 'wallet-2', accountId: 'account-2' }
    const stale = connection('https://selection.example', [selected], {
      walletId: 'wallet-1',
      accountId: 'account-1'
    })

    expect(getConnectionAccountRefs(stale)).toEqual([selected])
    expect(connectionAuthorizesAccount(stale, selected)).toBe(true)
    expect(
      connectionAuthorizesAccount(stale, {
        walletId: 'wallet-1',
        accountId: 'account-1'
      })
    ).toBe(false)
  })

  test('uses chain-scoped permissions for wallet connection status without widening legacy access', () => {
    const active = { walletId: 'wallet-1', accountId: 'account-1' }
    const evmOnly = {
      ...connection('https://evm.example', [], undefined),
      chainAuthorizations: [
        {
          chainId: 'eip155:1',
          accounts: [active],
          binding: active
        }
      ]
    }

    expect(connectionAuthorizesAccount(evmOnly, active)).toBe(false)
    expect(connectionAuthorizesAccountForWalletStatus(evmOnly, active)).toBe(true)
    expect(
      connectionAuthorizesAccountForWalletStatus(evmOnly, {
        walletId: 'wallet-2',
        accountId: 'account-2'
      })
    ).toBe(false)
    expect(
      connectionAuthorizesAccountForWalletStatus(
        {
          ...evmOnly,
          chainAuthorizations: [{ ...evmOnly.chainAuthorizations[0], chainId: 'invalid' }]
        },
        active
      )
    ).toBe(false)
  })

  test('summarizes all connected dApps while limiting Private support to EVM origins', () => {
    const active = { walletId: 'wallet-1', accountId: 'account-1' }
    const another = { walletId: 'wallet-2', accountId: 'account-2' }
    const evm = {
      ...connection('https://evm.example', [], undefined),
      chainAuthorizations: [
        { chainId: 'eip155:1', accounts: [active], binding: active },
        { chainId: 'bip122:000000000019d6689c085ae165831e93', accounts: [active], binding: active }
      ]
    }
    const bitcoin = {
      ...connection('https://bitcoin.example', [], undefined),
      chainAuthorizations: [
        { chainId: 'bip122:000000000019d6689c085ae165831e93', accounts: [active], binding: active }
      ]
    }
    const zcash = connection('https://zcash.example', [active])
    const otherAccount = connection('https://other.example', [another])

    expect(
      summarizeDAppPrivateExecutionSupport([evm, bitcoin, zcash, otherAccount], active)
    ).toEqual({ connected: 3, privateCapable: 1, mainOnly: 2 })
  })

  test('replaces the Account selection and binding as one authorization record', () => {
    const first = { walletId: 'wallet-1', accountId: 'account-1' }
    const second = { walletId: 'wallet-2', accountId: 'account-2' }
    const existing = connection('https://replace.example', [first, second], first)
    const replacement = replaceDAppAuthorization(existing, {
      origin: existing.origin,
      id: 'unused-for-existing',
      accounts: [second],
      binding: second,
      now: connectedAt + 1
    })

    expect(replacement).toMatchObject({
      id: existing.id,
      boundWalletId: second.walletId,
      boundAccountId: second.accountId,
      authorizedAccounts: [second],
      lastActiveAt: connectedAt + 1
    })
    expect(connectionAuthorizesAccount(replacement, first)).toBe(false)
  })

  test('rejects empty, duplicate, cross-selection, and non-origin authorization input', () => {
    const account = { walletId: 'wallet-1', accountId: 'account-1' }
    const input = {
      origin: 'https://replace.example',
      id: 'dapp-replace',
      accounts: [account],
      binding: account,
      now: connectedAt
    }

    expect(() => replaceDAppAuthorization(undefined, { ...input, accounts: [] })).toThrow(
      /non-empty/
    )
    expect(() =>
      replaceDAppAuthorization(undefined, { ...input, accounts: [account, account] })
    ).toThrow(/Duplicate/)
    expect(() =>
      replaceDAppAuthorization(undefined, {
        ...input,
        accounts: Array.from({ length: 101 }, (_, index) => ({
          walletId: 'wallet-1',
          accountId: `account-${index}`
        }))
      })
    ).toThrow(/bounded/)
    expect(() =>
      replaceDAppAuthorization(undefined, {
        ...input,
        accounts: [{ walletId: 'wallet-1', accountId: 'a'.repeat(257) }]
      })
    ).toThrow(/reference/)
    expect(() =>
      replaceDAppAuthorization(undefined, {
        ...input,
        binding: { walletId: 'wallet-2', accountId: 'account-2' }
      })
    ).toThrow(/authorized selection/)
    expect(() =>
      replaceDAppAuthorization(undefined, { ...input, origin: 'https://replace.example/path' })
    ).toThrow(/origin/)
    const existing = replaceDAppAuthorization(undefined, input)
    expect(() => replaceDAppAuthorization(existing, { ...input, now: connectedAt - 1 })).toThrow(
      /predates/
    )
    expect(replaceDAppAuthorization(existing, { ...input, now: connectedAt }).lastActiveAt).toBe(
      connectedAt
    )
  })

  test('keeps a valid legacy binding but denies missing or malformed Account associations', () => {
    const legacy = connection('https://legacy.example', [
      { walletId: 'wallet-1', accountId: 'account-1' }
    ])
    delete legacy.authorizedAccounts
    expect(getConnectionAccountRefs(legacy)).toEqual([
      { walletId: 'wallet-1', accountId: 'account-1' }
    ])

    const unbound = connection('https://unbound.example', [], undefined)
    expect(getConnectionAccountRefs(unbound)).toEqual([])
    expect(
      connectionAuthorizesAccount(unbound, {
        walletId: 'wallet-1',
        accountId: 'account-1'
      })
    ).toBe(false)

    const malformed = { ...legacy, authorizedAccounts: ['account-1'] }
    expect(getConnectionAccountRefs(malformed)).toEqual([])
    expect(
      getConnectionAccountRefs({
        ...legacy,
        authorizedAccounts: [
          { walletId: 'wallet-1', accountId: 'account-1' },
          { walletId: 'wallet-2' }
        ]
      })
    ).toEqual([])
    expect(
      getConnectionAccountRefs({
        ...legacy,
        authorizedAccounts: [
          { walletId: 'wallet-1', accountId: 'account-1' },
          { walletId: 'wallet-1', accountId: 'account-1' }
        ]
      })
    ).toEqual([])
    expect(
      getConnectionAccountRefs({
        ...legacy,
        authorizedAccounts: undefined,
        boundWalletId: 1
      })
    ).toEqual([])
  })

  test('disconnects a dApp whose only authorized account was removed', () => {
    const result = pruneDAppAccountReferences(
      [connection('https://one.example', [{ walletId: 'wallet-1', accountId: 'account-1' }])],
      { walletId: 'wallet-1', accountId: 'account-1' }
    )

    expect(result.connections).toEqual([])
    expect(result.affectedOrigins).toEqual(['https://one.example'])
    expect(result.disconnectedOrigins).toEqual(['https://one.example'])
  })

  test('rebinds to a remaining authorized account without widening permission', () => {
    const remaining = { walletId: 'wallet-2', accountId: 'account-2' }
    const result = pruneDAppAccountReferences(
      [
        connection('https://multi.example', [
          { walletId: 'wallet-1', accountId: 'account-1' },
          remaining
        ])
      ],
      { walletId: 'wallet-1', accountId: 'account-1' }
    )

    expect(result.connections).toHaveLength(1)
    expect(result.connections[0]).toMatchObject({
      boundWalletId: remaining.walletId,
      boundAccountId: remaining.accountId,
      authorizedAccounts: [remaining]
    })
    expect(result.disconnectedOrigins).toEqual([])
  })

  test('removes every reference for a deleted wallet and preserves unrelated dApps', () => {
    const untouched = connection('https://untouched.example', [
      { walletId: 'wallet-2', accountId: 'account-2' }
    ])
    const result = pruneDAppAccountReferences(
      [
        connection('https://wallet.example', [
          { walletId: 'wallet-1', accountId: 'account-1' },
          { walletId: 'wallet-1', accountId: 'account-2' }
        ]),
        untouched
      ],
      { walletId: 'wallet-1' }
    )

    expect(result.connections).toEqual([untouched])
    expect(result.disconnectedOrigins).toEqual(['https://wallet.example'])
  })

  test('does not mutate source connection records', () => {
    const source = [
      connection('https://immutable.example', [
        { walletId: 'wallet-1', accountId: 'account-1' },
        { walletId: 'wallet-2', accountId: 'account-2' }
      ])
    ]
    const before = structuredClone(source)
    pruneDAppAccountReferences(source, {
      walletId: 'wallet-1',
      accountId: 'account-1'
    })
    expect(source).toEqual(before)
  })

  test('stores released chain permissions by canonical chain without widening Zcash authorization', () => {
    const zcashAccount = { walletId: 'wallet-zec', accountId: 'account-zec' }
    const evmAccount = { walletId: 'wallet-evm', accountId: 'account-evm' }
    const existing = connection('https://permissions.example', [zcashAccount])
    const replacement = replaceDAppChainAuthorization(existing, {
      origin: existing.origin,
      id: 'unused-for-existing',
      chainId: 'eip155:1',
      accounts: [evmAccount],
      binding: evmAccount,
      now: connectedAt + 1
    })

    expect(getConnectionAccountRefs(replacement)).toEqual([zcashAccount])
    expect(getConnectionChainAuthorization(replacement, 'eip155:1')).toEqual({
      chainId: 'eip155:1',
      accounts: [evmAccount],
      binding: evmAccount
    })
    const bitcoinAccount = { walletId: 'wallet-btc', accountId: 'account-btc' }
    const withBitcoin = replaceDAppChainAuthorization(replacement, {
      origin: replacement.origin,
      id: 'unused-for-existing',
      chainId: 'bip122:000000000019d6689c085ae165831e93',
      accounts: [bitcoinAccount],
      binding: bitcoinAccount,
      now: connectedAt + 2
    })
    expect(
      getConnectionChainAuthorization(withBitcoin, 'bip122:000000000019d6689c085ae165831e93')
    ).toEqual({
      chainId: 'bip122:000000000019d6689c085ae165831e93',
      accounts: [bitcoinAccount],
      binding: bitcoinAccount
    })
    expect(() => getConnectionChainAuthorization(withBitcoin, 'bip122:0000')).toThrow(
      /released provider chain/
    )
    const withSolana = replaceDAppChainAuthorization(withBitcoin, {
      origin: withBitcoin.origin,
      id: 'unused-for-existing',
      chainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      accounts: [evmAccount],
      binding: evmAccount,
      now: connectedAt + 3
    })
    const withNear = replaceDAppChainAuthorization(withSolana, {
      origin: withSolana.origin,
      id: 'unused-for-existing',
      chainId: 'near:testnet',
      accounts: [evmAccount],
      binding: evmAccount,
      now: connectedAt + 4
    })
    expect(getConnectionChainAuthorization(withNear, 'near:testnet')?.binding).toEqual(evmAccount)
    expect(
      getConnectionChainAuthorization(withNear, 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1')?.binding
    ).toEqual(evmAccount)
    const withSolanaMainnet = replaceDAppChainAuthorization(withNear, {
      origin: withNear.origin,
      id: 'unused-for-existing',
      chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      accounts: [evmAccount],
      binding: evmAccount,
      now: connectedAt + 5
    })
    const withNearMainnet = replaceDAppChainAuthorization(withSolanaMainnet, {
      origin: withSolanaMainnet.origin,
      id: 'unused-for-existing',
      chainId: 'near:mainnet',
      accounts: [evmAccount],
      binding: evmAccount,
      now: connectedAt + 6
    })
    expect(getConnectionChainAuthorization(withNearMainnet, 'near:mainnet')?.binding).toEqual(
      evmAccount
    )
    expect(
      getConnectionChainAuthorization(withNearMainnet, 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')
        ?.binding
    ).toEqual(evmAccount)
  })

  test('replaces one EVM chain authorization and rejects malformed bindings', () => {
    const first = { walletId: 'wallet-1', accountId: 'account-1' }
    const second = { walletId: 'wallet-2', accountId: 'account-2' }
    const initial = replaceDAppChainAuthorization(undefined, {
      origin: 'https://chain.example',
      id: 'chain-example',
      chainId: 'eip155:1',
      accounts: [first],
      binding: first,
      now: connectedAt
    })
    const replacement = replaceDAppChainAuthorization(initial, {
      origin: initial.origin,
      id: 'unused',
      chainId: 'eip155:1',
      accounts: [second],
      binding: second,
      now: connectedAt + 1
    })

    expect(replacement.chainAuthorizations).toHaveLength(1)
    expect(getConnectionChainAuthorization(replacement, 'eip155:1')?.binding).toEqual(second)
    expect(() =>
      replaceDAppChainAuthorization(initial, {
        origin: initial.origin,
        id: 'unused',
        chainId: 'eip155:1',
        accounts: [first],
        binding: second,
        now: connectedAt + 1
      })
    ).toThrow(/authorized selection/)
    expect(() =>
      replaceDAppChainAuthorization(initial, {
        origin: initial.origin,
        id: initial.id,
        chainId: 'eip155:1',
        accounts: [first],
        binding: first,
        now: connectedAt - 1
      })
    ).toThrow(/predates/)
  })

  test('prunes EVM permissions independently and keeps the remaining chain binding valid', () => {
    const first = { walletId: 'wallet-1', accountId: 'account-1' }
    const second = { walletId: 'wallet-2', accountId: 'account-2' }
    const chainOnly = replaceDAppChainAuthorization(undefined, {
      origin: 'https://evm-only.example',
      id: 'evm-only',
      chainId: 'eip155:1',
      accounts: [first, second],
      binding: first,
      now: connectedAt
    })
    const result = pruneDAppAccountReferences([chainOnly], first)

    expect(result.disconnectedOrigins).toEqual([])
    expect(result.affectedOrigins).toEqual([chainOnly.origin])
    expect(getConnectionChainAuthorization(result.connections[0], 'eip155:1')).toEqual({
      chainId: 'eip155:1',
      accounts: [second],
      binding: second
    })
  })

  test('removes permissions for a deleted custom EVM network without widening other scopes', () => {
    const zcashAccount = { walletId: 'wallet-zec', accountId: 'account-zec' }
    const evmAccount = { walletId: 'wallet-evm', accountId: 'account-evm' }
    const customChain = replaceDAppChainAuthorization(
      connection('https://custom-chain.example', [zcashAccount]),
      {
        origin: 'https://custom-chain.example',
        id: 'custom-chain',
        chainId: 'eip155:31337',
        accounts: [evmAccount],
        binding: evmAccount,
        now: connectedAt
      }
    )
    const withEthereum = replaceDAppChainAuthorization(customChain, {
      origin: customChain.origin,
      id: 'unused',
      chainId: 'eip155:1',
      accounts: [evmAccount],
      binding: evmAccount,
      now: connectedAt + 1
    })

    const result = pruneDAppChainAuthorizations([withEthereum], ['eip155:31337'])
    expect(result.affectedOrigins).toEqual([withEthereum.origin])
    expect(result.disconnectedOrigins).toEqual([])
    expect(getConnectionAccountRefs(result.connections[0])).toEqual([zcashAccount])
    expect(getConnectionChainAuthorization(result.connections[0], 'eip155:31337')).toBeNull()
    expect(getConnectionChainAuthorization(result.connections[0], 'eip155:1')).not.toBeNull()

    const chainOnly = replaceDAppChainAuthorization(undefined, {
      origin: 'https://custom-only.example',
      id: 'custom-only',
      chainId: 'eip155:31337',
      accounts: [evmAccount],
      binding: evmAccount,
      now: connectedAt
    })
    expect(pruneDAppChainAuthorizations([chainOnly], ['eip155:31337'])).toMatchObject({
      connections: [],
      disconnectedOrigins: [chainOnly.origin]
    })
  })

  test('parses stored permissions exactly and isolates malformed or duplicate origins', () => {
    const account = { walletId: 'wallet-1', accountId: 'account-1' }
    const valid = replaceDAppChainAuthorization(undefined, {
      origin: 'https://valid.example',
      id: 'valid',
      title: 'Valid dApp',
      favicon: '',
      chainId: 'eip155:1',
      accounts: [account],
      binding: account,
      now: connectedAt
    })
    const zcashOnly = {
      id: 'zcash-only',
      name: 'Zcash only',
      host: 'zcash.example',
      origin: 'https://zcash.example',
      favicon: '',
      connectedAt,
      lastActiveAt: connectedAt,
      boundWalletId: account.walletId,
      boundAccountId: account.accountId
    }

    expect(
      parseStoredDAppConnections([
        valid,
        zcashOnly,
        { ...valid, origin: 'https://valid.example', unknown: true },
        { ...valid, id: 'duplicate' },
        { ...valid, id: 'wrong-host', origin: 'https://wrong.example' },
        { ...valid, id: 'incomplete-binding', boundWalletId: 'wallet-1' },
        { ...valid, id: 'time-travel', lastActiveAt: connectedAt - 1 }
      ])
    ).toEqual([zcashOnly])
    expect(parseStoredDAppConnections({})).toEqual([])
    expect(parseStoredDAppConnections(Array.from({ length: 257 }, () => valid))).toEqual([])
  })

  test('detects only validated EVM chain authorizations', () => {
    const account = { walletId: 'wallet-1', accountId: 'account-1' }
    const evm = replaceDAppChainAuthorization(undefined, {
      origin: 'https://evm.example',
      id: 'evm',
      chainId: 'eip155:1',
      accounts: [account],
      binding: account,
      now: connectedAt
    })
    const bitcoin = replaceDAppChainAuthorization(undefined, {
      origin: 'https://bitcoin.example',
      id: 'bitcoin',
      chainId: 'bip122:000000000019d6689c085ae165831e93',
      accounts: [account],
      binding: account,
      now: connectedAt
    })

    expect(connectionHasEvmAuthorization(evm)).toBe(true)
    expect(connectionHasEvmAuthorization(bitcoin)).toBe(false)
    expect(connectionHasEvmAuthorization({ ...evm, chainAuthorizations: [{}] })).toBe(false)
    expect(connectionHasEvmAuthorizationForAccount(evm, account)).toBe(true)
    expect(
      connectionHasEvmAuthorizationForAccount(evm, {
        walletId: 'wallet-1',
        accountId: 'account-2'
      })
    ).toBe(false)
    expect(connectionHasEvmAuthorizationForAccount(bitcoin, account)).toBe(false)
    expect(
      connectionHasEvmAuthorizationForAccount({ ...evm, chainAuthorizations: [{}] }, account)
    ).toBe(false)
  })

  test('serializes concurrent chain grants without losing either authorization', async () => {
    let stored
    let setCalls = 0
    let releaseFirstWrite
    const firstWrite = new Promise(resolve => {
      releaseFirstWrite = resolve
    })
    const storage = {
      get: async () => ({ connectedDApps: stored }),
      set: async items => {
        setCalls += 1
        if (setCalls === 1) await firstWrite
        stored = structuredClone(items.connectedDApps)
      }
    }
    const manager = new DAppManager(storage)
    const account = { walletId: 'wallet-1', accountId: 'account-1' }

    const ethereum = manager.setChainAuthorizedAccounts(
      'https://concurrent.example',
      { title: 'Concurrent dApp' },
      'eip155:1',
      [account],
      account
    )
    const bitcoin = manager.setChainAuthorizedAccounts(
      'https://concurrent.example',
      { title: 'Concurrent dApp' },
      'bip122:000000000019d6689c085ae165831e93',
      [account],
      account
    )

    await expect.poll(() => setCalls).toBe(1)
    releaseFirstWrite()
    await Promise.all([ethereum, bitcoin])

    expect(setCalls).toBe(2)
    expect(stored).toHaveLength(1)
    expect(stored[0].chainAuthorizations.map(item => item.chainId)).toEqual([
      'eip155:1',
      'bip122:000000000019d6689c085ae165831e93'
    ])
  })

  test('does not publish an authorization in memory when persistence fails', async () => {
    let shouldFail = true
    let stored = {}
    const storage = {
      get: async () => structuredClone(stored),
      set: async items => {
        if (shouldFail) throw new Error('storage unavailable')
        stored = structuredClone({ ...stored, ...items })
      }
    }
    const manager = new DAppManager(storage)
    const account = { walletId: 'wallet-1', accountId: 'account-1' }

    await expect(
      manager.setChainAuthorizedAccounts(
        'https://failed-write.example',
        {},
        'eip155:1',
        [account],
        account
      )
    ).rejects.toThrow('storage unavailable')
    await expect(manager.getConnection('https://failed-write.example')).resolves.toBeNull()

    shouldFail = false
    await manager.setChainAuthorizedAccounts(
      'https://recovered-write.example',
      {},
      'eip155:1',
      [account],
      account
    )
    await expect(manager.getConnection('https://recovered-write.example')).resolves.toMatchObject({
      origin: 'https://recovered-write.example'
    })
  })

  test('keeps a site connected after an approved EVM switch and page reload', async () => {
    let stored
    const storage = {
      get: async () => ({ connectedDApps: stored }),
      set: async items => {
        stored = structuredClone(items.connectedDApps)
      }
    }
    const manager = new DAppManager(storage)
    const origin = 'https://connected.example'
    const account = { walletId: 'wallet-1', accountId: 'account-1' }
    const otherAccount = { walletId: 'wallet-2', accountId: 'account-2' }
    await manager.setChainAuthorizedAccounts(origin, {}, 'eip155:1', [account], account)
    await manager.setChainAuthorizedAccounts(
      'https://other.example',
      {},
      'eip155:1',
      [otherAccount],
      otherAccount
    )

    await manager.carryEvmAuthorizationToChain(origin, 'eip155:1', 'eip155:56')
    const reloaded = new DAppManager(storage)
    await expect(reloaded.getChainAuthorization(origin, 'eip155:56')).resolves.toEqual({
      chainId: 'eip155:56',
      accounts: [account],
      binding: account
    })
    await expect(
      reloaded.getChainAuthorization('https://other.example', 'eip155:56')
    ).resolves.toBeNull()

    await reloaded.setChainAuthorizedAccounts(
      origin,
      {},
      'eip155:137',
      [otherAccount],
      otherAccount
    )
    await reloaded.carryEvmAuthorizationToChain(origin, 'eip155:1', 'eip155:137')
    await expect(reloaded.getChainAuthorization(origin, 'eip155:137')).resolves.toEqual({
      chainId: 'eip155:137',
      accounts: [otherAccount],
      binding: otherAccount
    })
    await reloaded.carryEvmAuthorizationToChain(
      'https://unconnected.example',
      'eip155:1',
      'eip155:56'
    )
    await expect(reloaded.getConnection('https://unconnected.example')).resolves.toBeNull()
  })

  test('adds a wallet-side account only to an existing EVM grant', async () => {
    let stored
    const storage = {
      get: async () => ({ connectedDApps: stored }),
      set: async items => {
        stored = structuredClone(items.connectedDApps)
      }
    }
    const manager = new DAppManager(storage)
    const origin = 'https://wallet-connect.example'
    const previous = { walletId: 'wallet-1', accountId: 'account-1' }
    const active = { walletId: 'wallet-1', accountId: 'account-2' }
    await manager.setChainAuthorizedAccounts(origin, {}, 'eip155:1', [previous], previous)
    await manager.setChainAuthorizedAccounts(origin, {}, 'eip155:56', [previous], previous)

    await manager.addEvmAuthorizedAccount(origin, 'eip155:1', active)
    const reloaded = new DAppManager(storage)
    await expect(reloaded.getChainAuthorization(origin, 'eip155:1')).resolves.toEqual({
      chainId: 'eip155:1',
      accounts: [previous, active],
      binding: active
    })
    await expect(reloaded.getChainAuthorization(origin, 'eip155:56')).resolves.toEqual({
      chainId: 'eip155:56',
      accounts: [previous],
      binding: previous
    })
    await expect(reloaded.getAuthorizedAccounts(origin)).resolves.toEqual([])
    await expect(reloaded.addEvmAuthorizedAccount(origin, 'eip155:137', active)).rejects.toThrow(
      'Reconnect from the site to update this network permission'
    )
    await expect(reloaded.getChainAuthorization(origin, 'eip155:137')).resolves.toBeNull()
    await expect(
      reloaded.addEvmAuthorizedAccount(origin, 'bip122:000000000019d6689c085ae165831e93', active)
    ).rejects.toThrow('Wallet-side account connection requires an EVM network')
  })

  test('removes only legacy Zcash authorization and preserves chain-scoped permissions', async () => {
    let stored
    const storage = {
      get: async () => ({ connectedDApps: stored }),
      set: async items => {
        stored = structuredClone(items.connectedDApps)
      }
    }
    const manager = new DAppManager(storage)
    const zcashAccount = { walletId: 'wallet-zec', accountId: 'account-zec' }
    const evmAccount = { walletId: 'wallet-evm', accountId: 'account-evm' }
    const origin = 'https://mixed-permissions.example'

    await manager.setAuthorizedAccounts(origin, {}, [zcashAccount], zcashAccount)
    await manager.setChainAuthorizedAccounts(origin, {}, 'eip155:1', [evmAccount], evmAccount)
    await manager.removeLegacyAuthorization(origin)

    const remaining = await manager.getConnection(origin)
    expect(getConnectionAccountRefs(remaining)).toEqual([])
    expect(getConnectionChainAuthorization(remaining, 'eip155:1')).toEqual({
      chainId: 'eip155:1',
      accounts: [evmAccount],
      binding: evmAccount
    })
    expect(stored).toEqual([remaining])
  })

  test('deletes a Zcash-only connection and publishes no partial revoke on storage failure', async () => {
    let stored
    let shouldFail = false
    const storage = {
      get: async () => ({ connectedDApps: stored }),
      set: async items => {
        if (shouldFail) throw new Error('storage unavailable')
        stored = structuredClone(items.connectedDApps)
      }
    }
    const manager = new DAppManager(storage)
    const account = { walletId: 'wallet-zec', accountId: 'account-zec' }
    const origin = 'https://zcash-revoke.example'
    await manager.setAuthorizedAccounts(origin, {}, [account], account)

    shouldFail = true
    await expect(manager.removeLegacyAuthorization(origin)).rejects.toThrow('storage unavailable')
    await expect(manager.getAuthorizedAccounts(origin)).resolves.toEqual([account])

    shouldFail = false
    await manager.removeLegacyAuthorization(origin)
    await expect(manager.getConnection(origin)).resolves.toBeNull()
    expect(stored).toEqual([])
  })
})
