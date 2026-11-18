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
  BackgroundPortfolioService,
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
  test('excludes unselected cached assets and restores them after enabling', async () => {
    let evmEnabled = false
    let reads = 0
    const portfolio = coordinator({
      isNetworkEnabled: (_scope, family) => family !== 'evm' || evmEnabled,
      evmPortfolios: [
        {
          chainId: evmChainId,
          portfolio: {
            readCachedActiveSource: async () => {
              reads += 1
              return evmSource()
            },
            refreshActiveSource: async () => {
              reads += 1
              return evmSource()
            }
          }
        }
      ]
    })
    const disabled = await portfolio.readCachedActive()
    expect(disabled?.chains.map(item => item.chain.family)).toEqual(['zcash'])
    expect(disabled?.assets.map(item => item.metadata.symbol)).toEqual(['ZEC'])
    expect(reads).toBe(0)
    evmEnabled = true
    const enabled = await portfolio.readCachedActive()
    expect(enabled?.assets.map(item => item.metadata.symbol)).toEqual(['ZEC', 'ETH', 'USDC'])
    expect(reads).toBe(1)
  })

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

  test('returns a selected EVM refresh while another enabled chain is still refreshing', async () => {
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
    let releaseArbitrum
    const slowRefresh = new Promise(resolve => {
      releaseArbitrum = resolve
    })
    let releaseEthereum
    const ethereumRefresh = new Promise(resolve => {
      releaseEthereum = resolve
    })
    let ethereum = evmSource('loading')
    let arbitrum = null
    let requestedArbitrum = false
    let ethereumRefreshes = 0
    const coordinator = new UnifiedPortfolioCoordinator({
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
            readCachedActiveSource: async () => ethereum,
            refreshActiveSource: async () => {
              ethereumRefreshes += 1
              await ethereumRefresh
              ethereum = evmSource()
              return ethereum
            }
          }
        },
        {
          chainId: arbitrumChainId,
          portfolio: {
            readCachedActiveSource: async () => arbitrum,
            refreshActiveSource: async () => {
              requestedArbitrum = true
              await slowRefresh
              arbitrum = arbitrumSource
              return arbitrum
            }
          }
        }
      ],
      readZcashState: () => ({ balance: null, status: 'loading', updatedAt: 0 })
    })
    const scope = { network: 'mainnet', generationId, keyDomainId, accountId, runtimeKey: 'rpc-1' }
    const service = new BackgroundPortfolioService({
      coordinator,
      readScope: async () => scope,
      enrich: async model => model,
      onUpdated: () => {},
      markStale: async () => {},
      ...emptyInvalidations
    })
    const full = service.refreshActive()
    try {
      await expect.poll(() => requestedArbitrum).toBe(true)
      let selected
      const refresh = service.refreshActive([evmChainId])
      void refresh.then(model => {
        selected = model
      })
      await new Promise(resolve => setImmediate(resolve))
      releaseEthereum()
      await expect
        .poll(() => selected?.chains.find(item => item.chain.id === evmChainId)?.status, {
          timeout: 1000
        })
        .toBe('ready')
      expect(selected.chains.find(item => item.chain.id === zcashChainId)?.status).toBe('loading')
      expect(selected.chains.find(item => item.chain.id === arbitrumChainId)?.status).toBe(
        'loading'
      )
      expect(ethereumRefreshes).toBe(1)
    } finally {
      releaseEthereum()
      releaseArbitrum()
      await full
    }
    const model = await full

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

function serviceModel(scope, refreshed = new Set()) {
  return {
    scope: { keyDomainId: scope.keyDomainId, accountId: scope.accountId },
    chains: ['eip155:1', 'near:mainnet'].map(id => ({
      chain: { id, family: id.startsWith('eip155:') ? 'evm' : 'near' },
      status: refreshed.has(id) ? 'ready' : 'loading',
      assets: refreshed.has(id) ? [{ freshness: 'fresh', updatedAt: 10_000 }] : []
    })),
    assets: []
  }
}

const emptyInvalidations = {
  readInvalidations: async () => [],
  acknowledgeInvalidations: async () => {}
}

test('background Portfolio joins overlapping chain refreshes and leaves fresh automatic reads cached', async () => {
  const scope = {
    network: 'mainnet',
    generationId,
    keyDomainId,
    accountId,
    runtimeKey: 'rpc-1'
  }
  const refreshed = new Set()
  const requests = []
  const published = []
  const coordinator = {
    readCachedActive: async () => serviceModel(scope, refreshed),
    refreshActive: chainIds =>
      new Promise(resolve =>
        requests.push({
          chainIds,
          resolve: () => {
            for (const id of chainIds) refreshed.add(id)
            resolve(serviceModel(scope, refreshed))
          }
        })
      )
  }
  const service = new BackgroundPortfolioService({
    coordinator,
    readScope: async () => scope,
    enrich: async model => model,
    onUpdated: model => published.push(model),
    markStale: async () => {},
    ...emptyInvalidations,
    now: () => 10_000
  })

  const partial = service.refreshActive(['eip155:1'])
  const full = service.refreshActive()
  await new Promise(resolve => setImmediate(resolve))
  expect(requests.map(request => request.chainIds)).toEqual([['eip155:1'], ['near:mainnet']])
  requests.forEach(request => request.resolve())
  await Promise.all([partial, full])
  expect(published).toHaveLength(1)
  await service.refreshActive(undefined, { automatic: true })
  expect(requests).toHaveLength(2)
})

test(
  'background Portfolio returns cache and starts a queued chain while another chain is busy',
  { timeout: 2_000 },
  async () => {
    const scope = { network: 'mainnet', generationId, keyDomainId, accountId, runtimeKey: 'rpc-1' }
    const refreshed = new Set()
    let finishRefresh
    let startRefresh
    const started = new Promise(resolve => {
      startRefresh = resolve
    })
    const service = new BackgroundPortfolioService({
      coordinator: {
        readCachedActive: async () => serviceModel(scope, refreshed),
        refreshActive: (chainIds, { claimChainRefresh, onChainRefreshed }) =>
          new Promise(resolve => {
            if (chainIds.length === 1) {
              expect(chainIds).toEqual(['eip155:1'])
              expect(claimChainRefresh('eip155:1')).toBe(true)
              refreshed.add('eip155:1')
              onChainRefreshed('eip155:1', serviceModel(scope, refreshed).chains[0])
              resolve(serviceModel(scope, refreshed))
              return
            }
            expect(chainIds).toEqual(['eip155:1', 'near:mainnet'])
            expect(claimChainRefresh('near:mainnet')).toBe(true)
            finishRefresh = () => {
              expect(claimChainRefresh('eip155:1')).toBe(false)
              refreshed.add('near:mainnet')
              resolve(serviceModel(scope, refreshed))
            }
            startRefresh()
          })
      },
      readScope: async () => scope,
      enrich: async model => model,
      onUpdated: () => {},
      markStale: async () => {},
      ...emptyInvalidations
    })

    const fullRefresh = service.refreshActive()
    await started
    try {
      await expect(service.readCachedActive()).resolves.toMatchObject({
        scope: { keyDomainId, accountId }
      })
      await expect(service.refreshActive(['eip155:1'])).resolves.toMatchObject({
        chains: [{ status: 'ready' }, { status: 'loading' }]
      })
    } finally {
      finishRefresh()
      await fullRefresh
    }
  }
)

test('background Portfolio discards a refresh after the active account changes', async () => {
  const oldScope = {
    network: 'mainnet',
    generationId,
    keyDomainId,
    accountId,
    runtimeKey: 'rpc-1'
  }
  let activeScope = oldScope
  let finish
  const published = []
  const service = new BackgroundPortfolioService({
    coordinator: {
      readCachedActive: async () => serviceModel(oldScope),
      refreshActive: async () =>
        new Promise(resolve => {
          finish = resolve
        })
    },
    readScope: async () => activeScope,
    enrich: async model => model,
    onUpdated: model => published.push(model),
    markStale: async () => {},
    ...emptyInvalidations,
    now: () => 10_000
  })
  const refresh = service.refreshActive(['eip155:1'])
  await new Promise(resolve => setImmediate(resolve))
  activeScope = { ...oldScope, accountId: 'account:other' }
  finish(serviceModel(oldScope, new Set(['eip155:1'])))
  await expect(refresh).resolves.toBeNull()
  expect(published).toHaveLength(0)
})

test('disposing the background Portfolio rejects a pending refresh and disables its runtime', async () => {
  const scope = { network: 'mainnet', generationId, keyDomainId, accountId, runtimeKey: 'rpc-1' }
  let finish
  let active = true
  const published = []
  const service = new BackgroundPortfolioService({
    coordinator: {
      readCachedActive: async () => serviceModel(scope),
      refreshActive: async () =>
        new Promise(resolve => {
          finish = resolve
        })
    },
    readScope: async () => (active ? scope : null),
    enrich: async model => model,
    onUpdated: model => published.push(model),
    onDispose: () => {
      active = false
    },
    markStale: async () => {},
    ...emptyInvalidations
  })
  const refresh = service.refreshActive(['eip155:1'])
  await new Promise(resolve => setImmediate(resolve))
  service.dispose()
  service.dispose()
  finish(serviceModel(scope, new Set(['eip155:1'])))
  await expect(refresh).resolves.toBeNull()
  await expect(service.readCachedActive()).resolves.toBeNull()
  expect(published).toHaveLength(0)
})

test('background Portfolio retains cached balances and backs off after a failed automatic refresh', async () => {
  const scope = { network: 'mainnet', generationId, keyDomainId, accountId, runtimeKey: 'rpc-1' }
  const cached = serviceModel(scope)
  let now = 10_000
  let requests = 0
  let published = 0
  const service = new BackgroundPortfolioService({
    coordinator: {
      readCachedActive: async () => cached,
      refreshActive: async () => {
        requests += 1
        throw new Error('RPC unavailable')
      }
    },
    readScope: async () => scope,
    enrich: async model => model,
    onUpdated: () => {
      published += 1
    },
    markStale: async () => {},
    ...emptyInvalidations,
    now: () => now
  })

  await expect(service.refreshActive(['eip155:1'], { automatic: true })).resolves.toEqual(cached)
  await expect(service.refreshActive(['eip155:1'], { automatic: true })).resolves.toEqual(cached)
  expect({ requests, published }).toEqual({ requests: 1, published: 0 })
  now += 10_001
  await service.refreshActive(['eip155:1'], { automatic: true })
  expect(requests).toBe(2)
})

test('background Portfolio rechecks confirmed-empty chains after the automatic TTL', async () => {
  const scope = { network: 'mainnet', generationId, keyDomainId, accountId, runtimeKey: 'rpc-1' }
  const empty = {
    scope: { keyDomainId, accountId },
    chains: [{ chain: { id: 'eip155:1', family: 'evm' }, status: 'ready', assets: [] }],
    assets: []
  }
  let now = 10_000
  let requests = 0
  const service = new BackgroundPortfolioService({
    coordinator: {
      readCachedActive: async () => empty,
      refreshActive: async () => {
        requests += 1
        return empty
      }
    },
    readScope: async () => scope,
    enrich: async model => model,
    onUpdated: () => {},
    markStale: async () => {},
    ...emptyInvalidations,
    now: () => now
  })
  await service.refreshActive(undefined, { automatic: true })
  await service.refreshActive(undefined, { automatic: true })
  expect(requests).toBe(1)
  now += 60_000
  await service.refreshActive(undefined, { automatic: true })
  expect(requests).toBe(2)
})

test('background Portfolio refreshes again when an invalidation arrives during an older request', async () => {
  const scope = { network: 'mainnet', generationId, keyDomainId, accountId, runtimeKey: 'rpc-1' }
  const refreshed = new Set()
  const requests = []
  const published = []
  let marker = null
  const service = new BackgroundPortfolioService({
    coordinator: {
      readCachedActive: async () => serviceModel(scope, refreshed),
      refreshActive: chainIds =>
        new Promise(resolve =>
          requests.push({
            chainIds,
            resolve: () => {
              if (requests.length > 1) refreshed.add(chainIds[0])
              resolve(serviceModel(scope, refreshed))
            }
          })
        )
    },
    readScope: async () => scope,
    enrich: async model => model,
    onUpdated: model => published.push(model),
    markStale: async () => {
      marker = { chainId: 'eip155:1', domain: 'chain', revision: 1, invalidatedAt: 9_000 }
    },
    readInvalidations: async () => (marker ? [marker] : []),
    acknowledgeInvalidations: async (_scope, markers) => {
      if (marker?.revision === markers[0]?.revision) marker = null
    },
    now: () => 10_000
  })

  const old = service.refreshActive(['eip155:1'])
  await new Promise(resolve => setImmediate(resolve))
  const invalidating = service.invalidate(scope, ['eip155:1'])
  await new Promise(resolve => setImmediate(resolve))
  requests[0].resolve()
  await new Promise(resolve => setImmediate(resolve))
  expect(requests.map(request => request.chainIds)).toEqual([['eip155:1'], ['eip155:1']])
  requests[1].resolve()
  await Promise.all([old, invalidating])
  expect(marker).toBeNull()
  expect(published).toHaveLength(1)
})

test('background Portfolio requires a new Bitcoin scan before acknowledging its marker', async () => {
  const scope = {
    network: 'mainnet',
    generationId,
    keyDomainId,
    accountId,
    runtimeKey: 'rpc-1'
  }
  const chainId = 'bip122:000000000019d6689c085ae165831e93'
  const marker = { chainId, domain: 'chain', revision: 1, invalidatedAt: 9_000 }
  const requests = []
  const acknowledged = []
  let refreshed = false
  const model = () => ({
    scope: { keyDomainId, accountId },
    chains: [
      {
        chain: { id: chainId, family: 'bitcoin' },
        status: refreshed ? 'ready' : 'loading',
        assets: []
      }
    ],
    assets: []
  })
  const service = new BackgroundPortfolioService({
    coordinator: {
      readCachedActive: async () => model(),
      refreshActive: async (chainIds, options) => {
        requests.push({ chainIds, options })
        refreshed = true
        return model()
      }
    },
    readScope: async () => scope,
    enrich: async value => value,
    onUpdated: () => {},
    markStale: async () => {},
    readInvalidations: async () => (acknowledged.length ? [] : [marker]),
    acknowledgeInvalidations: async (_scope, markers) => acknowledged.push(...markers)
  })

  await service.refreshActive([chainId])
  expect(requests).toMatchObject([
    {
      chainIds: [chainId],
      options: { awaitBitcoin: true, requireNewBitcoinScan: true }
    }
  ])
  expect(acknowledged).toEqual([marker])
})

test('background Portfolio retains a chain marker after a partial refresh', async () => {
  const scope = {
    network: 'mainnet',
    generationId,
    keyDomainId,
    accountId,
    runtimeKey: 'rpc-1'
  }
  const marker = { chainId: 'eip155:1', domain: 'chain', revision: 1, invalidatedAt: 9_000 }
  let partial = false
  let requests = 0
  let published = 0
  const model = () => ({
    scope: { keyDomainId, accountId },
    chains: [
      {
        chain: { id: 'eip155:1', family: 'evm' },
        status: partial ? 'partial' : 'loading',
        assets: partial ? [{ freshness: 'fresh', updatedAt: 10_000 }] : []
      }
    ],
    assets: []
  })
  const service = new BackgroundPortfolioService({
    coordinator: {
      readCachedActive: async () => model(),
      refreshActive: async () => {
        requests += 1
        partial = true
        return model()
      }
    },
    readScope: async () => scope,
    enrich: async value => value,
    onUpdated: () => {
      published += 1
    },
    markStale: async () => {},
    readInvalidations: async () => [marker],
    acknowledgeInvalidations: async () => {
      throw new Error('Partial refresh acknowledged')
    },
    now: () => 10_000
  })

  await service.refreshActive(['eip155:1'], { automatic: true })
  await service.refreshActive(['eip155:1'], { automatic: true })
  expect({ requests, published }).toEqual({ requests: 1, published: 1 })
})

test('targeted Confidential invalidation refreshes its projection through an existing session', async () => {
  const scope = { network: 'mainnet', generationId, keyDomainId, accountId, runtimeKey: 'rpc-1' }
  const marker = {
    chainId: 'near:mainnet',
    domain: 'confidential',
    revision: 1,
    invalidatedAt: 9_000
  }
  const model = {
    ...serviceModel(scope, new Set(['near:mainnet', 'eip155:1'])),
    confidential: { status: 'ready', freshness: 'stale', updatedAt: 8_000, assets: [] }
  }
  const enrichModes = []
  const acknowledged = []
  let networkRefreshes = 0
  const service = new BackgroundPortfolioService({
    coordinator: {
      readCachedActive: async () => model,
      refreshActive: async () => {
        networkRefreshes += 1
        return model
      }
    },
    readScope: async () => scope,
    enrich: async (base, refresh) => {
      enrichModes.push(refresh)
      return refresh === true
        ? { ...base, confidential: { ...base.confidential, freshness: 'fresh', updatedAt: 10_000 } }
        : base
    },
    onUpdated: () => {},
    markStale: async () => {},
    readInvalidations: async () => [marker],
    acknowledgeInvalidations: async (_scope, markers) => {
      acknowledged.push(...markers)
    },
    now: () => 10_000
  })

  await service.refreshActive(['near:mainnet'], { automatic: true })
  expect(enrichModes).toEqual([false, true])
  expect(networkRefreshes).toBe(0)
  expect(acknowledged).toEqual([marker])
})
