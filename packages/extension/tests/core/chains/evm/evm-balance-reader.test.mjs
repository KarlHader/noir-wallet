import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  createAssetRegistry,
  createEvmBitcoinChainRegistry,
  getBundledEvmAssetDefinitions,
  parseChainId
} from '../../../../src/core/chains/registry/index.ts'
import {
  EvmRpcError,
  readEvmPortfolioSource
} from '../../../../src/infrastructure/chains/evm/index.ts'

const chainId = parseChainId('eip155:1').id
const chains = createEvmBitcoinChainRegistry('mainnet')
const assets = createAssetRegistry(chains, getBundledEvmAssetDefinitions('mainnet'))
const account = {
  id: 'chain-account:evm:0',
  scope: {
    keyDomainId: 'key-domain:0',
    accountId: 'account:0',
    chainId
  },
  derivation: { scheme: 'bip44', path: "m/44'/60'/0'/0/0" },
  identity: {
    kind: 'account-identifier',
    value: '0x1111111111111111111111111111111111111111'
  },
  createdAt: 1_700_000_000_000
}

function rpc(overrides = {}) {
  return {
    assertExpectedChain: async () => {},
    getNativeBalance: async () => '1000000000000000000',
    getErc20Balance: async () => '2000000',
    ...overrides
  }
}

async function captureError(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected promise to reject')
}

test.describe('EVM portfolio source reader', () => {
  test('reads technically validated auto-detected ERC-20 balances without promoting them to trusted assets', async () => {
    const contract = `0x${'2'.repeat(40)}`
    const registry = createAssetRegistry(chains, [
      ...getBundledEvmAssetDefinitions('mainnet'),
      {
        chainId,
        namespace: 'erc20',
        reference: contract,
        kind: 'token',
        metadata: { name: 'Tether USD', symbol: 'USDT', decimals: 6 },
        source: 'discovered',
        verification: 'unverified'
      }
    ])
    expect(registry.get(`${chainId}/erc20:${contract}`)).toBeUndefined()
    const source = await readEvmPortfolioSource({
      chainId,
      chainAccount: account,
      assets: registry,
      rpc: rpc({
        getErc20Balance: async address => (address === contract ? '3000000' : '2000000')
      }),
      now: () => 100
    })
    expect(source.balances).toContainEqual({
      assetId: `${chainId}/erc20:${contract}`,
      totalRaw: '3000000',
      spendableRaw: '3000000',
      availableRaw: '3000000',
      pendingRaw: '0',
      updatedAt: 100
    })
  })

  test('reads native ETH and trusted ERC-20 balances for a MetaMask-compatible account', async () => {
    const calls = []
    const source = await readEvmPortfolioSource({
      chainId,
      chainAccount: account,
      assets,
      rpc: rpc({
        assertExpectedChain: async () => calls.push('probe'),
        getNativeBalance: async address => {
          calls.push(['native', address])
          return '1000000000000000000'
        },
        getErc20Balance: async (contract, address) => {
          calls.push(['erc20', contract, address])
          return '2000000'
        }
      }),
      now: () => 1_800_000_000_000
    })

    expect(source.status).toBe('ready')
    expect(source.balances).toEqual([
      {
        assetId: 'eip155:1/slip44:60',
        totalRaw: '1000000000000000000',
        spendableRaw: '1000000000000000000',
        availableRaw: '1000000000000000000',
        pendingRaw: '0',
        updatedAt: 1_800_000_000_000
      },
      {
        assetId: 'eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        totalRaw: '2000000',
        spendableRaw: '2000000',
        availableRaw: '2000000',
        pendingRaw: '0',
        updatedAt: 1_800_000_000_000
      }
    ])
    expect(calls[0]).toBe('probe')
    expect(calls.slice(1)).toEqual(
      expect.arrayContaining([
        ['native', account.identity.value],
        ['erc20', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', account.identity.value]
      ])
    )
  })

  test('preserves successful balances when one asset is rate limited', async () => {
    const source = await readEvmPortfolioSource({
      chainId,
      chainAccount: account,
      assets,
      rpc: rpc({
        getErc20Balance: async () => {
          throw new EvmRpcError('rate-limited', 'limited')
        }
      }),
      now: () => 100
    })

    expect(source).toMatchObject({
      status: 'error',
      errorCode: 'rate-limited'
    })
    expect(source.balances.map(balance => balance.assetId)).toEqual(['eip155:1/slip44:60'])
  })

  test('reads an imported EVM private-key account without pretending it has an HD path', async () => {
    const imported = {
      ...account,
      derivation: { scheme: 'imported', path: 'm' }
    }
    const source = await readEvmPortfolioSource({
      chainId,
      chainAccount: imported,
      assets,
      rpc: rpc(),
      now: () => 100
    })

    expect(source).toMatchObject({
      status: 'ready',
      chainAccount: { derivation: { scheme: 'imported', path: 'm' } }
    })
  })

  test('rejects non-canonical balance amounts from an adapter', async () => {
    const source = await readEvmPortfolioSource({
      chainId,
      chainAccount: account,
      assets,
      rpc: rpc({ getNativeBalance: async () => '01' }),
      now: () => 100
    })

    expect(source).toMatchObject({ status: 'error', errorCode: 'invalid-response' })
    expect(source.balances.map(balance => balance.assetId)).toEqual([
      'eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
    ])
  })

  test('fails closed before balance calls when endpoint chain validation fails', async () => {
    let balanceCalls = 0
    const source = await readEvmPortfolioSource({
      chainId,
      chainAccount: account,
      assets,
      rpc: rpc({
        assertExpectedChain: async () => {
          throw new EvmRpcError('chain-mismatch', 'wrong chain')
        },
        getNativeBalance: async () => {
          balanceCalls += 1
          return '1'
        }
      })
    })

    expect(source).toMatchObject({
      status: 'error',
      balances: [],
      errorCode: 'invalid-response'
    })
    expect(balanceCalls).toBe(0)
  })

  test('rejects invalid derivation paths and propagates cancellation', async () => {
    await expect(
      readEvmPortfolioSource({
        chainId,
        chainAccount: {
          ...account,
          derivation: { scheme: 'bip44', path: "m/44'/60'/01'/0/0" }
        },
        assets,
        rpc: rpc()
      })
    ).rejects.toThrow(/Invalid EVM ChainAccount/)

    const cancellationError = await captureError(
      readEvmPortfolioSource({
        chainId,
        chainAccount: account,
        assets,
        rpc: rpc({
          assertExpectedChain: async () => {
            throw new EvmRpcError('cancelled', 'cancelled')
          }
        })
      })
    )
    expect(cancellationError).toBeInstanceOf(EvmRpcError)
    expect(cancellationError.code).toBe('cancelled')
  })
})
