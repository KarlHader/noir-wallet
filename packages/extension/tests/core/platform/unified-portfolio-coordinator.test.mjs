import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  createAssetRegistry,
  createFeatureGatedChainRegistry,
  createInitialProductChainRegistry,
  filterAssetDefinitionsForChains,
  getBundledInitialProductAssetDefinitions,
  getZcashChainId
} from '../../../src/core/chains/registry/index.ts'
import {
  PortfolioCoordinatorError,
  UnifiedPortfolioCoordinator
} from '../../../src/infrastructure/portfolio/index.ts'
import { isPortfolioModelForScope } from '../../../src/popup/services/portfolio-cache.ts'
import { parsePortfolioReadModel } from '../../../src/core/portfolio/index.ts'

const generationId = 'metadata:generation:unified-portfolio'
const keyDomainId = 'wallet:portfolio'
const accountId = 'account:portfolio'
const zcashChainId = getZcashChainId('mainnet')
const evmChainId = 'eip155:1'
const baseChains = createInitialProductChainRegistry('mainnet')
const chains = createFeatureGatedChainRegistry(baseChains, ['chain.zcash', 'chain.evm'])
const assets = createAssetRegistry(
  chains,
  filterAssetDefinitionsForChains(getBundledInitialProductAssetDefinitions('mainnet'), chains)
)

const zcashChainAccount = {
  id: 'chain-account:zcash:portfolio',
  scope: { keyDomainId, accountId, chainId: zcashChainId },
  derivation: { scheme: 'zip32-unified', path: "m/32'/133'/0'" },
  identity: { kind: 'account-identifier', value: 'u1portfolio' },
  createdAt: 1_000
}
const evmChainAccount = {
  id: 'chain-account:evm:portfolio',
  scope: { keyDomainId, accountId, chainId: evmChainId },
  derivation: { scheme: 'bip44', path: "m/44'/60'/0'/0/0" },
  identity: {
    kind: 'account-identifier',
    value: '0x1111111111111111111111111111111111111111'
  },
  createdAt: 1_000
}
const pointer = {
  schemaVersion: 2,
  generationId,
  sourceFingerprint: 'a'.repeat(64),
  committedAt: 1_000
}
const snapshot = {
  manifest: {
    schemaVersion: 2,
    generationId,
    status: 'verified',
    sourceFingerprint: pointer.sourceFingerprint,
    mainKeyDomainId: keyDomainId,
    activeAccount: { keyDomainId, accountId }
  },
  keyDomains: [
    {
      id: keyDomainId,
      credentialRef: 'credential-set:portfolio',
      source: { kind: 'software', mnemonicWordCount: 24 },
      displayName: 'Wallet 1',
      createdAt: 1_000
    }
  ],
  accounts: [
    { id: accountId, keyDomainId, accountIndex: 0, displayName: 'Account 1', createdAt: 1_000 }
  ],
  chainAccounts: [zcashChainAccount, evmChainAccount],
  addresses: [
    {
      id: 'address:zcash:portfolio',
      chainAccountId: zcashChainAccount.id,
      value: zcashChainAccount.identity.value,
      scheme: 'zcash-full-unified',
      purpose: 'receive',
      rotatable: true,
      preferredForReceive: true,
      privacy: 'mixed',
      walletCompatibility: 'limited'
    },
    {
      id: 'address:evm:portfolio',
      chainAccountId: evmChainAccount.id,
      value: evmChainAccount.identity.value,
      scheme: 'evm',
      purpose: 'receive',
      rotatable: false,
      preferredForReceive: true,
      privacy: 'transparent',
      walletCompatibility: 'broad'
    }
  ]
}

function evmSource(status = 'ready') {
  return {
    generationId,
    chainAccount: evmChainAccount,
    source: {
      chainAccount: evmChainAccount,
      status,
      balances: [
        {
          assetId: `${evmChainId}/slip44:60`,
          totalRaw: '1000000000000000000',
          spendableRaw: '1000000000000000000',
          availableRaw: '1000000000000000000',
          pendingRaw: '0',
          updatedAt: 2_000
        },
        {
          assetId: `${evmChainId}/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`,
          totalRaw: '2000000',
          spendableRaw: '2000000',
          availableRaw: '2000000',
          pendingRaw: '0',
          updatedAt: 2_000
        }
      ]
    }
  }
}

function coordinator(overrides = {}) {
  const cached = evmSource('loading')
  const refreshed = evmSource('ready')
  return new UnifiedPortfolioCoordinator({
    storageRepository: {
      getActivePointer: async () => pointer,
      getSnapshot: async () => snapshot
    },
    chains,
    assets,
    evmPortfolios: [
      {
        chainId: evmChainId,
        portfolio: {
          readCachedActiveSource: async () => cached,
          refreshActiveSource: async () => refreshed
        }
      }
    ],
    readZcashState: () => ({
      balance: {
        transparent: '0.25',
        shielded: '1.25',
        total: '1.5',
        spendable: '1.2',
        available: '1.19',
        shieldable: '0.2',
        pending: { shielded: '0.05', transparent: '0.01', total: '0.06' }
      },
      status: 'ready',
      updatedAt: 2_000
    }),
    ...overrides
  })
}

test.describe('Unified active Portfolio coordinator', () => {
  test('rejects a retained read model after the visible wallet scope changes', () => {
    const retained = {
      scope: { keyDomainId, accountId }
    }

    expect(isPortfolioModelForScope(retained, keyDomainId, accountId)).toBe(true)
    expect(isPortfolioModelForScope(retained, 'wallet:next', accountId)).toBe(false)
    expect(isPortfolioModelForScope(retained, keyDomainId, 'account:next')).toBe(false)
    expect(isPortfolioModelForScope(retained, null, null)).toBe(false)
  })

  test('reports a bounded stage without exposing repository error details', async () => {
    const failure = new Error('sensitive repository detail')
    const operation = coordinator({
      storageRepository: {
        getActivePointer: async () => {
          throw failure
        },
        getSnapshot: async () => snapshot
      }
    }).readCachedActive()

    const error = await operation.then(
      () => null,
      reason => reason
    )
    expect(error).toBeInstanceOf(PortfolioCoordinatorError)
    expect(error).toMatchObject({
      name: 'PortfolioCoordinatorError',
      message: 'Portfolio active-wallet operation failed',
      stage: 'active-wallet',
      cause: failure
    })
  })

  test('combines authoritative Zcash state with cached and refreshed EVM assets', async () => {
    await expect(coordinator().readCachedActive()).resolves.toMatchObject({
      scope: { keyDomainId, accountId },
      status: 'partial',
      assets: [
        { metadata: { symbol: 'ZEC' }, freshness: 'fresh' },
        { metadata: { symbol: 'ETH' }, freshness: 'stale' },
        { metadata: { symbol: 'USDC' }, freshness: 'stale' }
      ]
    })
    await expect(coordinator().refreshActive()).resolves.toMatchObject({
      status: 'ready',
      chains: [
        { chain: { family: 'zcash' }, status: 'ready' },
        { chain: { family: 'evm' }, status: 'ready' }
      ],
      assets: [
        { metadata: { symbol: 'ZEC' }, balance: { availableRaw: '119000000' } },
        { metadata: { symbol: 'ETH' }, balance: { totalRaw: '1000000000000000000' } },
        { metadata: { symbol: 'USDC' }, balance: { totalRaw: '2000000' } }
      ]
    })
  })

  test('keeps local ZEC visible while an enabled public-chain cache is absent', async () => {
    const uncached = coordinator({
      evmPortfolios: [
        {
          chainId: evmChainId,
          portfolio: {
            readCachedActiveSource: async () => null,
            refreshActiveSource: async () => evmSource('ready')
          }
        }
      ]
    })
    await expect(uncached.readCachedActive()).resolves.toMatchObject({
      scope: { keyDomainId, accountId },
      status: 'partial',
      chains: [
        { chain: { family: 'zcash' }, status: 'ready' },
        { chain: { family: 'evm' }, status: 'loading', assets: [] }
      ],
      assets: [{ metadata: { symbol: 'ZEC' }, balance: { totalRaw: '150000000' } }]
    })
  })

  test('refreshes only the requested public-chain sources', async () => {
    let cachedReads = 0
    let refreshes = 0
    const selective = coordinator({
      evmPortfolios: [
        {
          chainId: evmChainId,
          portfolio: {
            readCachedActiveSource: async () => {
              cachedReads += 1
              return evmSource('loading')
            },
            refreshActiveSource: async () => {
              refreshes += 1
              return evmSource('ready')
            }
          }
        }
      ]
    })

    await expect(selective.refreshActive(['near:mainnet'])).resolves.toMatchObject({
      status: 'partial'
    })
    expect({ cachedReads, refreshes }).toEqual({ cachedReads: 1, refreshes: 0 })

    await expect(selective.refreshActive([evmChainId])).resolves.toMatchObject({ status: 'ready' })
    expect({ cachedReads, refreshes }).toEqual({ cachedReads: 1, refreshes: 1 })
  })

  test('reads every enabled EVM ChainAccount instead of only the active EVM network', async () => {
    const arbitrumChainId = 'eip155:42161'
    const arbitrumChainAccount = {
      ...evmChainAccount,
      id: 'chain-account:evm:arbitrum:portfolio',
      scope: { ...evmChainAccount.scope, chainId: arbitrumChainId }
    }
    const multiEvmSnapshot = {
      ...snapshot,
      chainAccounts: [...snapshot.chainAccounts, arbitrumChainAccount],
      addresses: [
        ...snapshot.addresses,
        {
          ...snapshot.addresses[1],
          id: 'address:evm:arbitrum:portfolio',
          chainAccountId: arbitrumChainAccount.id
        }
      ]
    }
    const arbitrumSource = {
      generationId,
      chainAccount: arbitrumChainAccount,
      source: {
        chainAccount: arbitrumChainAccount,
        status: 'ready',
        balances: [
          {
            assetId: `${arbitrumChainId}/slip44:60`,
            totalRaw: '2000000000000000000',
            spendableRaw: '2000000000000000000',
            availableRaw: '2000000000000000000',
            pendingRaw: '0',
            updatedAt: 2_000
          }
        ]
      }
    }
    const model = await new UnifiedPortfolioCoordinator({
      storageRepository: {
        getActivePointer: async () => pointer,
        getSnapshot: async () => multiEvmSnapshot
      },
      chains,
      assets,
      evmPortfolios: [
        {
          chainId: evmChainId,
          portfolio: {
            readCachedActiveSource: async () => evmSource(),
            refreshActiveSource: async () => evmSource()
          }
        },
        {
          chainId: arbitrumChainId,
          portfolio: {
            readCachedActiveSource: async () => arbitrumSource,
            refreshActiveSource: async () => arbitrumSource
          }
        }
      ],
      readZcashState: () => ({ balance: null, status: 'loading', updatedAt: 0 })
    }).refreshActive()

    expect(model?.chains.map(chain => chain.chain.id)).toEqual([
      zcashChainId,
      evmChainId,
      arbitrumChainId
    ])
    expect(
      model?.assets
        .filter(asset => asset.metadata.symbol === 'ETH')
        .map(asset => asset.balance.totalRaw)
    ).toEqual(['1000000000000000000', '2000000000000000000'])
  })

  test('fails closed when the EVM source races or mismatches the active ChainAccount', async () => {
    await expect(
      coordinator({
        evmPortfolios: [
          {
            chainId: evmChainId,
            portfolio: {
              readCachedActiveSource: async () => ({
                ...evmSource(),
                generationId: 'metadata:generation:next'
              }),
              refreshActiveSource: async () => evmSource()
            }
          }
        ]
      }).readCachedActive()
    ).resolves.toBeNull()

    await expect(
      coordinator({
        evmPortfolios: [
          {
            chainId: evmChainId,
            portfolio: {
              readCachedActiveSource: async () => ({
                ...evmSource(),
                chainAccount: { ...evmChainAccount, id: 'chain-account:evm:wrong' }
              }),
              refreshActiveSource: async () => evmSource()
            }
          }
        ]
      }).readCachedActive()
    ).rejects.toThrow(/active ChainAccount/)
  })

  test('serializes a Zcash and Bitcoin Portfolio through the strict Popup boundary', async () => {
    const bitcoinChainId = 'bip122:000000000019d6689c085ae165831e93'
    const bitcoinChains = createFeatureGatedChainRegistry(baseChains, [
      'chain.zcash',
      'chain.bitcoin'
    ])
    const bitcoinAssets = createAssetRegistry(
      bitcoinChains,
      filterAssetDefinitionsForChains(
        getBundledInitialProductAssetDefinitions('mainnet'),
        bitcoinChains
      )
    )
    const bitcoinChainAccount = {
      id: 'chain-account:bitcoin:portfolio',
      scope: { keyDomainId, accountId, chainId: bitcoinChainId },
      derivation: { scheme: 'bip84', path: "m/84'/0'/0'/0/0" },
      identity: {
        kind: 'account-identifier',
        value: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
      },
      createdAt: 1_000
    }
    const bitcoinSnapshot = {
      ...snapshot,
      chainAccounts: [zcashChainAccount, bitcoinChainAccount],
      addresses: [
        snapshot.addresses[0],
        {
          id: 'address:bitcoin:portfolio',
          chainAccountId: bitcoinChainAccount.id,
          value: bitcoinChainAccount.identity.value,
          scheme: 'bitcoin-p2wpkh',
          purpose: 'receive',
          derivation: { scheme: 'bip84', path: "m/84'/0'/0'/0/0" },
          rotatable: true,
          preferredForReceive: true,
          privacy: 'transparent',
          walletCompatibility: 'broad'
        }
      ]
    }
    const bitcoinSource = {
      generationId,
      chainAccount: bitcoinChainAccount,
      source: {
        chainAccount: bitcoinChainAccount,
        status: 'ready',
        balances: [
          {
            assetId: `${bitcoinChainId}/slip44:0`,
            totalRaw: '100000',
            spendableRaw: '100000',
            availableRaw: '100000',
            pendingRaw: '0',
            updatedAt: 2_000
          }
        ]
      }
    }
    const model = await new UnifiedPortfolioCoordinator({
      storageRepository: {
        getActivePointer: async () => pointer,
        getSnapshot: async () => bitcoinSnapshot
      },
      chains: bitcoinChains,
      assets: bitcoinAssets,
      bitcoinPortfolio: {
        readCachedActiveSource: async () => bitcoinSource,
        refreshActiveSource: async () => bitcoinSource
      },
      readZcashState: () => ({
        balance: null,
        status: 'loading',
        updatedAt: 0
      })
    }).refreshActive()

    expect(model).not.toBeNull()
    expect(
      parsePortfolioReadModel(
        structuredClone(model),
        createInitialProductChainRegistry('mainnet'),
        createAssetRegistry(
          createInitialProductChainRegistry('mainnet'),
          getBundledInitialProductAssetDefinitions('mainnet')
        )
      )
    ).toMatchObject({
      status: 'partial',
      assets: [{ metadata: { symbol: 'BTC' }, balance: { totalRaw: '100000' } }]
    })
  })

  test('renders cached Bitcoin state immediately and publishes the background refresh result', async () => {
    const bitcoinChainId = 'bip122:000000000019d6689c085ae165831e93'
    const releaseChains = createFeatureGatedChainRegistry(baseChains, [
      'chain.zcash',
      'chain.evm',
      'chain.bitcoin'
    ])
    const releaseAssets = createAssetRegistry(
      releaseChains,
      filterAssetDefinitionsForChains(
        getBundledInitialProductAssetDefinitions('mainnet'),
        releaseChains
      )
    )
    const bitcoinChainAccount = {
      id: 'chain-account:bitcoin:non-blocking',
      scope: { keyDomainId, accountId, chainId: bitcoinChainId },
      derivation: { scheme: 'bip84', path: "m/84'/0'/0'/0/0" },
      identity: {
        kind: 'account-identifier',
        value: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
      },
      createdAt: 1_000
    }
    const releaseSnapshot = {
      ...snapshot,
      chainAccounts: [...snapshot.chainAccounts, bitcoinChainAccount],
      addresses: [
        ...snapshot.addresses,
        {
          id: 'address:bitcoin:non-blocking',
          chainAccountId: bitcoinChainAccount.id,
          value: bitcoinChainAccount.identity.value,
          scheme: 'bitcoin-p2wpkh',
          purpose: 'receive',
          derivation: { scheme: 'bip84', path: "m/84'/0'/0'/0/0" },
          rotatable: true,
          preferredForReceive: true,
          privacy: 'transparent',
          walletCompatibility: 'broad'
        }
      ]
    }
    let cachedBitcoinSource = {
      generationId,
      chainAccount: bitcoinChainAccount,
      source: {
        chainAccount: bitcoinChainAccount,
        status: 'loading',
        balances: []
      }
    }
    const refreshedBitcoinSource = {
      ...cachedBitcoinSource,
      source: {
        ...cachedBitcoinSource.source,
        status: 'ready',
        balances: [
          {
            assetId: `${bitcoinChainId}/slip44:0`,
            totalRaw: '1000',
            spendableRaw: '1000',
            availableRaw: '1000',
            pendingRaw: '0',
            updatedAt: 2_000
          }
        ]
      }
    }
    let resolveBitcoinRefresh = () => {}
    const bitcoinRefresh = new Promise(resolve => {
      resolveBitcoinRefresh = () => resolve(refreshedBitcoinSource)
    })
    let backgroundRefreshStarted = false
    let backgroundRefreshSettled = false
    const coordinator = new UnifiedPortfolioCoordinator({
      storageRepository: {
        getActivePointer: async () => pointer,
        getSnapshot: async () => releaseSnapshot
      },
      chains: releaseChains,
      assets: releaseAssets,
      evmPortfolios: [
        {
          chainId: evmChainId,
          portfolio: {
            readCachedActiveSource: async () => evmSource('loading'),
            refreshActiveSource: async () => evmSource('ready')
          }
        }
      ],
      bitcoinPortfolio: {
        readCachedActiveSource: async () => cachedBitcoinSource,
        refreshActiveSource: async () => {
          backgroundRefreshStarted = true
          return bitcoinRefresh
        }
      },
      onBackgroundBitcoinRefreshSettled: source => {
        backgroundRefreshSettled = source === refreshedBitcoinSource
      },
      readZcashState: () => ({ balance: null, status: 'loading', updatedAt: 0 })
    })

    const cachedModel = await coordinator.readCachedActive()
    expect(backgroundRefreshStarted).toBe(false)
    expect(cachedModel).toMatchObject({
      status: 'partial',
      chains: [
        { chain: { family: 'zcash' }, status: 'loading', assets: [] },
        { chain: { family: 'evm' }, status: 'partial' },
        { chain: { family: 'bitcoin' }, status: 'loading' }
      ]
    })

    const refreshingModel = await coordinator.refreshActive()
    expect(backgroundRefreshStarted).toBe(true)
    expect(refreshingModel).toMatchObject({
      status: 'partial',
      chains: [
        { chain: { family: 'zcash' }, status: 'loading', assets: [] },
        { chain: { family: 'evm' }, status: 'ready' },
        { chain: { family: 'bitcoin' }, status: 'loading' }
      ]
    })

    resolveBitcoinRefresh()
    await expect.poll(() => backgroundRefreshSettled).toBe(true)
    await expect(coordinator.readCachedActive()).resolves.toMatchObject({
      status: 'partial',
      chains: [
        { chain: { family: 'zcash' }, status: 'loading', assets: [] },
        { chain: { family: 'evm' }, status: 'partial' },
        {
          chain: { family: 'bitcoin' },
          status: 'ready',
          assets: [{ balance: { totalRaw: '1000' } }]
        }
      ]
    })

    cachedBitcoinSource = {
      ...refreshedBitcoinSource,
      source: {
        ...refreshedBitcoinSource.source,
        balances: [
          {
            ...refreshedBitcoinSource.source.balances[0],
            totalRaw: '2000',
            spendableRaw: '2000',
            availableRaw: '2000',
            updatedAt: 3_000
          }
        ]
      }
    }
    await expect(coordinator.readCachedActive()).resolves.toMatchObject({
      chains: [
        { chain: { family: 'zcash' } },
        { chain: { family: 'evm' } },
        {
          chain: { family: 'bitcoin' },
          assets: [{ balance: { totalRaw: '2000' } }]
        }
      ]
    })
  })
})
