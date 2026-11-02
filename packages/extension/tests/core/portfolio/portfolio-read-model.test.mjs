import { test } from 'node:test'
import { expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

import {
  createAssetRegistry,
  createChainRegistry,
  createFeatureGatedChainRegistry
} from '../../../src/core/chains/registry/index.ts'
import {
  PORTFOLIO_READ_LIMITS,
  buildPortfolioReadModel,
  parsePortfolioReadModel
} from '../../../src/core/portfolio/index.ts'

const availableCapabilities = {
  address: {
    status: 'available',
    addressSchemes: ['identity'],
    derivationSchemes: ['bip44'],
    supportsRotation: false,
    supportsChange: false
  },
  signing: {
    status: 'available',
    transactionFormats: ['transaction'],
    messageFormats: ['message']
  },
  transaction: {
    status: 'available',
    model: 'account',
    actions: ['native-transfer', 'token-transfer']
  }
}

const zcashId = 'bip122:00040fe8ec8471911baa1db1266ea15d'
const ethereumId = 'eip155:1'

const baseChains = createChainRegistry([
  {
    id: zcashId,
    family: 'zcash',
    network: { kind: 'mainnet', name: 'mainnet' },
    displayName: 'Zcash',
    featureFlag: 'chain.zcash',
    capabilities: availableCapabilities
  },
  {
    id: ethereumId,
    family: 'evm',
    network: { kind: 'mainnet', name: 'mainnet' },
    displayName: 'Ethereum',
    featureFlag: 'chain.evm',
    capabilities: availableCapabilities
  }
])
const visibleChains = createFeatureGatedChainRegistry(baseChains, ['chain.zcash', 'chain.evm'])

const usdcReference = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const spamReference = '0x1111111111111111111111111111111111111111'
const assetRegistry = createAssetRegistry(baseChains, [
  {
    chainId: zcashId,
    namespace: 'slip44',
    reference: '133',
    kind: 'native',
    metadata: { name: 'Zcash', symbol: 'ZEC', decimals: 8 },
    source: 'bundled',
    verification: 'trusted'
  },
  {
    chainId: ethereumId,
    namespace: 'slip44',
    reference: '60',
    kind: 'native',
    metadata: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    source: 'bundled',
    verification: 'trusted'
  },
  {
    chainId: ethereumId,
    namespace: 'erc20',
    reference: usdcReference,
    kind: 'token',
    metadata: { name: 'USD Coin', symbol: 'USDC', decimals: 6 },
    source: 'bundled',
    verification: 'trusted'
  },
  {
    chainId: ethereumId,
    namespace: 'erc20',
    reference: spamReference,
    kind: 'token',
    metadata: {
      name: 'Claim Reward',
      symbol: 'USDC',
      decimals: 18
    },
    source: 'discovered',
    verification: 'unverified'
  }
])

const scope = {
  keyDomainId: 'key-domain:1',
  accountId: 'account:1'
}

function chainAccount(chainId, id = `chain-account:${chainId}`) {
  return {
    id,
    scope: { ...scope, chainId },
    derivation: { scheme: 'test', path: 'm/0' },
    identity: { kind: 'account-identifier', value: 'public-only' },
    createdAt: 1_700_000_000_000
  }
}

function balance(assetId, overrides = {}) {
  return {
    assetId,
    totalRaw: '1000',
    spendableRaw: '800',
    availableRaw: '700',
    pendingRaw: '100',
    updatedAt: 1_700_000_000_000,
    ...overrides
  }
}

function source(chainId, status, balances = [], overrides = {}) {
  return {
    chainAccount: chainAccount(chainId),
    status,
    balances,
    ...(status === 'error' ? { errorCode: 'network-unavailable' } : {}),
    ...overrides
  }
}

test.describe('Portfolio read model', () => {
  test('builds chain and asset views while preserving Zcash facets and held detected Tokens', () => {
    const model = buildPortfolioReadModel(
      scope,
      [
        source(zcashId, 'ready', [
          balance(`${zcashId}/slip44:133`, {
            shieldableRaw: '200',
            shieldedRaw: '700',
            transparentRaw: '300'
          })
        ]),
        source(ethereumId, 'error', [
          balance(`${ethereumId}/erc20:${usdcReference}`),
          balance(`${ethereumId}/erc20:${spamReference}`)
        ])
      ],
      visibleChains,
      assetRegistry
    )

    expect(model.status).toBe('partial')
    expect(model.chains.map(chain => chain.status)).toEqual(['ready', 'partial'])
    expect(model.assets.map(asset => asset.metadata.symbol)).toEqual(['ZEC', 'USDC', 'USDC'])
    expect(model.assets[0].balance).toEqual({
      totalRaw: '1000',
      spendableRaw: '800',
      availableRaw: '700',
      pendingRaw: '100',
      shieldableRaw: '200',
      shieldedRaw: '700',
      transparentRaw: '300'
    })
    expect(model.assets[0].freshness).toBe('fresh')
    expect(model.assets[1].freshness).toBe('stale')
    expect(model.chains[1].errorCodes).toEqual(['network-unavailable'])
    expect(model.ignoredAssetCount).toBe(0)
  })

  test('does not surface a previously detected Token after its verified on-chain balance reaches zero', () => {
    const model = buildPortfolioReadModel(
      scope,
      [
        source(ethereumId, 'ready', [
          balance(`${ethereumId}/slip44:60`),
          balance(`${ethereumId}/erc20:${spamReference}`, {
            totalRaw: '0',
            spendableRaw: '0',
            availableRaw: '0',
            pendingRaw: '0'
          })
        ])
      ],
      visibleChains,
      assetRegistry
    )

    expect(model.assets.map(asset => asset.asset.id)).toEqual([`${ethereumId}/slip44:60`])
  })

  test('strictly decodes a serialized read model against trusted chain and asset registries', () => {
    const model = buildPortfolioReadModel(
      scope,
      [
        source(zcashId, 'ready', [balance(`${zcashId}/slip44:133`, { shieldableRaw: '200' })]),
        source(ethereumId, 'ready', [balance(`${ethereumId}/slip44:60`)])
      ],
      visibleChains,
      assetRegistry
    )

    expect(parsePortfolioReadModel(structuredClone(model), visibleChains, assetRegistry)).toEqual(
      model
    )
  })

  test('keeps exact Main and Private balances while exposing their combined total', () => {
    const model = buildPortfolioReadModel(
      scope,
      [
        source(ethereumId, 'ready', [
          balance(`${ethereumId}/slip44:60`, {
            totalRaw: '1500',
            spendableRaw: '1500',
            availableRaw: '1500',
            pendingRaw: '0',
            mainRaw: '1000',
            privateRaw: '500'
          })
        ])
      ],
      visibleChains,
      assetRegistry
    )

    expect(model.assets[0].balance).toEqual({
      totalRaw: '1500',
      spendableRaw: '1500',
      availableRaw: '1500',
      pendingRaw: '0',
      mainRaw: '1000',
      privateRaw: '500'
    })
    expect(parsePortfolioReadModel(structuredClone(model), visibleChains, assetRegistry)).toEqual(
      model
    )

    const invalid = structuredClone(model)
    invalid.assets[0].balance.privateRaw = '499'
    invalid.chains[0].assets[0].balance.privateRaw = '499'
    expect(() => parsePortfolioReadModel(invalid, visibleChains, assetRegistry)).toThrow(
      /breakdown/
    )
  })

  test('rejects spoofed metadata, inconsistent top-level assets, and non-canonical balances', () => {
    const model = buildPortfolioReadModel(
      scope,
      [source(ethereumId, 'ready', [balance(`${ethereumId}/slip44:60`)])],
      visibleChains,
      assetRegistry
    )
    const spoofedMetadata = structuredClone(model)
    spoofedMetadata.chains[0].assets[0].metadata.symbol = 'FAKE'
    expect(() => parsePortfolioReadModel(spoofedMetadata, visibleChains, assetRegistry)).toThrow(
      /validated registry/
    )

    const inconsistentAssets = structuredClone(model)
    inconsistentAssets.assets = []
    expect(() => parsePortfolioReadModel(inconsistentAssets, visibleChains, assetRegistry)).toThrow(
      /do not match/
    )

    const invalidBalance = structuredClone(model)
    invalidBalance.chains[0].assets[0].balance.totalRaw = '01'
    expect(() => parsePortfolioReadModel(invalidBalance, visibleChains, assetRegistry)).toThrow(
      /total balance/
    )
  })

  test('derives empty, loading, ready, and error states deterministically', () => {
    expect(buildPortfolioReadModel(scope, [], visibleChains, assetRegistry).status).toBe('empty')
    expect(
      buildPortfolioReadModel(scope, [source(zcashId, 'loading')], visibleChains, assetRegistry)
        .status
    ).toBe('loading')
    expect(
      buildPortfolioReadModel(scope, [source(zcashId, 'ready')], visibleChains, assetRegistry)
        .status
    ).toBe('ready')
    expect(
      buildPortfolioReadModel(scope, [source(zcashId, 'error')], visibleChains, assetRegistry)
        .status
    ).toBe('error')
  })

  test('hides disabled chains even when an adapter supplies balances', () => {
    const zcashOnly = createFeatureGatedChainRegistry(baseChains, ['chain.zcash'])
    const model = buildPortfolioReadModel(
      scope,
      [source(ethereumId, 'ready', [balance(`${ethereumId}/slip44:60`)])],
      zcashOnly,
      assetRegistry
    )

    expect(model.status).toBe('empty')
    expect(model.chains).toEqual([])
    expect(model.assets).toEqual([])
  })

  test('rejects scope, chain, duplicate, amount, and raw-error mismatches', () => {
    expect(() =>
      buildPortfolioReadModel(
        scope,
        [
          source(zcashId, 'ready', [], {
            chainAccount: {
              ...chainAccount(zcashId),
              scope: {
                ...scope,
                accountId: 'account:other',
                chainId: zcashId
              }
            }
          })
        ],
        visibleChains,
        assetRegistry
      )
    ).toThrow(/requested Account scope/)
    expect(() =>
      buildPortfolioReadModel(
        scope,
        [source(zcashId, 'ready', [balance(`${ethereumId}/slip44:60`)])],
        visibleChains,
        assetRegistry
      )
    ).toThrow(/does not match/)
    expect(() =>
      buildPortfolioReadModel(
        scope,
        [
          source(zcashId, 'ready', [
            balance(`${zcashId}/slip44:133`),
            balance(`${zcashId}/slip44:133`)
          ])
        ],
        visibleChains,
        assetRegistry
      )
    ).toThrow(/Duplicate Portfolio asset/)
    expect(() =>
      buildPortfolioReadModel(
        scope,
        [
          source(zcashId, 'ready', [
            balance(`${zcashId}/slip44:133`, {
              totalRaw: '10',
              spendableRaw: '9',
              availableRaw: '10'
            })
          ])
        ],
        visibleChains,
        assetRegistry
      )
    ).toThrow(/facets/)
    expect(() =>
      buildPortfolioReadModel(
        scope,
        [
          source(zcashId, 'error', [], {
            error: new Error('private RPC token')
          })
        ],
        visibleChains,
        assetRegistry
      )
    ).toThrow(/Portfolio source/)
  })

  test('enforces resource limits before aggregating adapter data', () => {
    expect(() =>
      buildPortfolioReadModel(
        scope,
        [
          source(zcashId, 'ready', [
            balance(`${zcashId}/slip44:133`, {
              totalRaw: '1'.repeat(PORTFOLIO_READ_LIMITS.rawAmountDigits + 1)
            })
          ])
        ],
        visibleChains,
        assetRegistry
      )
    ).toThrow(/bounded base-unit/)
    expect(() =>
      buildPortfolioReadModel(
        scope,
        Array.from({ length: PORTFOLIO_READ_LIMITS.sources + 1 }, (_, index) =>
          source(zcashId, 'loading', [], {
            chainAccount: chainAccount(zcashId, `chain-account:${index}`)
          })
        ),
        visibleChains,
        assetRegistry
      )
    ).toThrow(/allowed limit/)
  })

  test('remains a pure read model without browser, UI, RPC, or key access', () => {
    const sourceCode = readFileSync(
      new URL('../../../src/core/portfolio/portfolio-read-model.ts', import.meta.url),
      'utf8'
    )

    expect(sourceCode).not.toMatch(
      /chrome\.|from ['"]react|fetch\(|WebSocket|wasm|privateKey|seedPhrase|zcash-wallet-runtime/i
    )
  })
})
