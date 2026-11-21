import { test } from 'node:test'
import { expect } from '@playwright/test'
import { summarizePortfolioFiat } from '../../../src/popup/services/portfolio-prices.ts'
import { getActivityTransactionReferences } from '../../../src/popup/services/activity-transaction-references.ts'
import { shouldWarnSmallTransfer } from '../../../src/popup/services/activity-small-transfer-warning.ts'
import { getActivityAddressAlias } from '../../../src/popup/services/activity-address-alias.ts'
import {
  getHomeAssetBreakdown,
  hasCompletePortfolioTotal,
  resolveHomeAssetDomainDisplay,
  resolveHomeCachedTotal,
  resolveHomePortfolioTotalStatus
} from '../../../src/popup/services/home-asset-breakdown.ts'
import {
  getAssetDomainRaw,
  projectPortfolioForDomain,
  selectHomeActionSource,
  summarizeAssetDomainsUsd,
  summarizeKnownShieldFiat
} from '../../../src/popup/services/asset-domains.ts'
import {
  buildPortfolioDisplay,
  getMergedZecProviderBalances,
  getPortfolioChainSection,
  projectPortfolioForChains
} from '../../../src/popup/services/portfolio-presentation.ts'
import {
  getNearConfidentialChainId,
  getNearConfidentialIconChain,
  listStandaloneNearConfidentialHoldings,
  resolveConfidentialDetailAssetId,
  resolveNearConfidentialZecHolding,
  withNearConfidentialZecChain
} from '../../../src/popup/services/near-confidential-holdings.ts'
import {
  getAssetDetailCategories,
  sumZcashDetailBalanceRaw
} from '../../../src/popup/services/asset-detail-balance.ts'
import { resolveShieldZcashVaultEntry } from '../../../src/popup/services/shield-zcash-entry.ts'

test('Zcash Shield requires the active V2 account source and network capability', () => {
  const previousFlags = globalThis.__ENABLED_CHAIN_FEATURE_FLAGS__
  globalThis.__ENABLED_CHAIN_FEATURE_FLAGS__ = ['chain.zcash']
  try {
    const input = {
      network: 'mainnet',
      enabledFlags: ['chain.zcash'],
      hasPortfolioZcash: false
    }
    expect(resolveShieldZcashVaultEntry({ ...input, walletSource: null }).showVaultCard).toBe(false)
    expect(
      resolveShieldZcashVaultEntry({
        ...input,
        walletSource: { kind: 'private-key', chainFamily: 'eip155' }
      }).showVaultCard
    ).toBe(false)
    expect(
      resolveShieldZcashVaultEntry({
        ...input,
        walletSource: { kind: 'software' }
      }).canEnableZcash
    ).toBe(true)
    expect(
      resolveShieldZcashVaultEntry({
        ...input,
        walletSource: {
          kind: 'hardware',
          hardware: { vendor: 'ledger', firmwareProfile: 'multi-coin', capabilities: ['evm'] }
        }
      }).showVaultCard
    ).toBe(false)
  } finally {
    globalThis.__ENABLED_CHAIN_FEATURE_FLAGS__ = previousFlags
  }
})

test('Confidential chain badges follow asset identity instead of a token symbol', () => {
  expect(
    getNearConfidentialIconChain({
      protocolAssetId: 'nep141:zec.omft.near',
      symbol: 'ZEC'
    })
  ).toBe('zec')
  expect(
    getNearConfidentialIconChain({
      protocolAssetId: 'nep141:eth.omft.near',
      symbol: 'ETH'
    })
  ).toBe('eth')
  expect(
    getNearConfidentialIconChain({
      protocolAssetId: 'nep141:unrelated.near',
      symbol: 'ZEC',
      chainId: 'eip155:42161'
    })
  ).toBe('arbitrum')
  expect(
    getNearConfidentialChainId({
      protocolAssetId: 'nep141:unrelated.near',
      symbol: 'ZEC'
    })
  ).toBeNull()
})

test('Home action source follows the selected balance domain', () => {
  const evm = {
    asset: { id: 'eip155:1/slip44:60', chainId: 'eip155:1' },
    balance: {
      totalRaw: '100',
      mainRaw: '0',
      privateRaw: '100',
      privateOnchainRaw: '80',
      confidentialRaw: '20'
    }
  }
  const zcash = {
    asset: {
      id: 'bip122:00040fe8ec8471911baa1db1266ea15d/slip44:133',
      chainId: 'bip122:00040fe8ec8471911baa1db1266ea15d'
    },
    balance: { totalRaw: '10', transparentRaw: '4', shieldedRaw: '6' }
  }
  const model = {
    assets: [evm, zcash],
    chains: [
      {
        chain: {
          id: evm.asset.chainId,
          family: 'evm',
          capabilities: { transaction: { status: 'available' } }
        }
      },
      {
        chain: {
          id: zcash.asset.chainId,
          family: 'zcash',
          capabilities: { transaction: { status: 'available' } }
        }
      }
    ]
  }
  expect(selectHomeActionSource(model, 'public', 'send')?.asset.asset.id).toBe(zcash.asset.id)
  expect(selectHomeActionSource(model, 'public', 'swap')?.asset.asset.id).toBe(zcash.asset.id)
  expect(selectHomeActionSource(model, 'private', 'swap')?.asset.asset.id).toBe(evm.asset.id)
  expect(selectHomeActionSource({ ...model, assets: [zcash] }, 'private', 'swap')).toBeNull()
})

test('small incoming warning requires an unfamiliar full source and a known small value', () => {
  const chainId = 'eip155:1'
  const assetId = 'eip155:1/slip44:60'
  const sender = { chainId, address: '0x1111111111111111111111111111111111111111' }
  const item = {
    id: 'small-receipt',
    kind: 'receive',
    createdAt: 2,
    snapshot: {
      direction: 'incoming',
      sender,
      primaryAmount: { assetId, amountRaw: '10000000000000' }
    }
  }
  const input = {
    item,
    history: [item],
    ownedAddresses: [],
    contactAddresses: [],
    assetMetadata: new Map([[assetId, { metadata: { decimals: 18 } }]]),
    prices: { quotes: [{ assetId, priceUsd: '1000', freshness: 'fresh' }] }
  }
  expect(shouldWarnSmallTransfer(input)).toBe(true)
  expect(shouldWarnSmallTransfer({ ...input, ownedAddresses: [sender] })).toBe(false)
  expect(shouldWarnSmallTransfer({ ...input, contactAddresses: [sender] })).toBe(false)
  expect(
    shouldWarnSmallTransfer({
      ...input,
      history: [
        {
          createdAt: 1,
          snapshot: { direction: 'outgoing', recipient: sender }
        },
        item
      ]
    })
  ).toBe(false)
  expect(shouldWarnSmallTransfer({ ...input, prices: null })).toBe(false)
  expect(
    shouldWarnSmallTransfer({
      ...input,
      prices: { quotes: [{ assetId, priceUsd: '1000', freshness: 'stale' }] }
    })
  ).toBe(false)
  expect(
    shouldWarnSmallTransfer({
      ...input,
      item: {
        ...item,
        snapshot: { ...item.snapshot, primaryAmount: { assetId, amountRaw: '0' } }
      },
      prices: null
    })
  ).toBe(true)
})

test('NEAR Intents alias requires the exact treasury address on a supported chain', () => {
  const treasury = '0x2CfF890f0378a11913B6129B2E97417a2c302680'
  expect(getActivityAddressAlias('eip155:42161', treasury)).toBe('NEAR Intents')
  expect(getActivityAddressAlias('eip155:11155111', treasury)).toBeNull()
  expect(getActivityAddressAlias('eip155:42161', treasury.slice(0, -1) + '1')).toBeNull()
  expect(getActivityAddressAlias('eip155:42161', treasury.slice(0, 10))).toBeNull()
})

test('NEAR Confidential ZEC stays separate from on-chain ZEC and inside its account and network', () => {
  const assetId = 'bip122:00040fe8ec8471911baa1db1266ea15d/slip44:133'
  const asset = {
    asset: { id: assetId, chainId: 'bip122:00040fe8ec8471911baa1db1266ea15d' },
    metadata: { decimals: 8, symbol: 'ZEC' },
    balance: { totalRaw: '0', transparentRaw: '0', shieldedRaw: '0' }
  }
  const model = {
    scope: { keyDomainId: 'wallet-a', accountId: 'account-a' },
    assets: [asset],
    confidential: {
      status: 'ready',
      assets: [
        {
          tokenId: 'private-zec',
          protocolAssetId: 'nep141:zec.omft.near',
          assetId,
          chainId: asset.asset.chainId,
          availableRaw: '125000000',
          decimals: 8
        }
      ]
    }
  }
  const input = { model, network: 'mainnet', walletId: 'wallet-a', accountId: 'account-a', assetId }
  expect(resolveNearConfidentialZecHolding(input)).toEqual({
    assetId,
    protocolAssetId: 'nep141:zec.omft.near',
    availableRaw: '125000000',
    amount: '1.25'
  })
  expect(getAssetDetailCategories(asset, model, false).raw).toMatchObject({
    all: '0',
    public: '0',
    shield: '0'
  })
  expect(sumZcashDetailBalanceRaw('300000000', '125000000')).toBe('425000000')
  expect(sumZcashDetailBalanceRaw('300000000', null)).toBeNull()
  expect(
    resolveNearConfidentialZecHolding({
      ...input,
      model: { ...model, confidential: { status: 'ready', assets: [] } }
    })?.availableRaw
  ).toBe('0')
  expect(resolveNearConfidentialZecHolding({ ...input, accountId: 'account-b' })).toBeNull()
  expect(resolveNearConfidentialZecHolding({ ...input, network: 'testnet' })).toBeNull()
  expect(
    resolveNearConfidentialZecHolding({
      ...input,
      model: {
        ...model,
        confidential: {
          ...model.confidential,
          assets: [{ ...model.confidential.assets[0], protocolAssetId: 'nep141:other.near' }]
        }
      }
    })
  ).toBeNull()
})

test('Home keeps native and Confidential ZEC as separate balances', () => {
  const assetId = 'bip122:00040fe8ec8471911baa1db1266ea15d/slip44:133'
  const chainId = 'bip122:00040fe8ec8471911baa1db1266ea15d'
  const asset = {
    asset: { id: assetId, chainId },
    metadata: { decimals: 8, symbol: 'ZEC' },
    balance: {
      totalRaw: '300000000',
      transparentRaw: '100000000',
      shieldedRaw: '200000000',
      availableRaw: '250000000',
      pendingRaw: '0'
    }
  }
  const model = {
    scope: { keyDomainId: 'wallet-a', accountId: 'account-a' },
    assets: [asset],
    chains: [{ chain: { id: chainId, family: 'zcash' }, assets: [asset] }],
    confidential: {
      status: 'ready',
      assets: [
        {
          tokenId: 'private-zec',
          protocolAssetId: 'nep141:zec.omft.near',
          assetId,
          chainId,
          availableRaw: '125000000',
          decimals: 8
        }
      ]
    }
  }
  const confidential = listStandaloneNearConfidentialHoldings(model, model, null)
  expect(confidential).toHaveLength(1)
  expect(confidential[0].entry.asset.protocolAssetId).toBe('nep141:zec.omft.near')
  expect(confidential[0].entry.asset.availableRaw).toBe('125000000')
  expect(confidential[0].chain.chain.id).toBe(chainId)
  expect(model.assets[0].balance.totalRaw).toBe('300000000')
  expect(getAssetDomainRaw(model.assets[0], 'public')).toBe('100000000')
  expect(getAssetDomainRaw(model.assets[0], 'shield')).toBe('200000000')
})

test('Shield merges only same-chain ZEC providers in token and network views', () => {
  const chainId = 'bip122:00040fe8ec8471911baa1db1266ea15d'
  const assetId = `${chainId}/slip44:133`
  const evmChainId = 'eip155:56'
  const evmAssetId = `${evmChainId}/erc20:0x1111111111111111111111111111111111111111`
  const native = {
    asset: { id: assetId, chainId, kind: 'native' },
    metadata: { decimals: 8, symbol: 'ZEC', name: 'Zcash' },
    source: 'bundled',
    balance: {
      totalRaw: '300000000',
      transparentRaw: '100000000',
      shieldedRaw: '200000000',
      pendingRaw: '0'
    }
  }
  const otherChain = {
    asset: { id: evmAssetId, chainId: evmChainId, kind: 'token' },
    metadata: { decimals: 8, symbol: 'ZEC', name: 'ZEC on BNB' },
    source: 'bundled',
    balance: {
      totalRaw: '500000000',
      mainRaw: '0',
      privateRaw: '500000000',
      privateOnchainRaw: '0',
      confidentialRaw: '500000000',
      pendingRaw: '0'
    }
  }
  const model = {
    scope: { keyDomainId: 'wallet-a', accountId: 'account-a' },
    status: 'ready',
    assets: [native, otherChain],
    chains: [
      {
        chain: { id: chainId, family: 'zcash', displayName: 'Zcash' },
        status: 'ready',
        assets: [native],
        errorCodes: []
      },
      {
        chain: { id: evmChainId, family: 'evm', displayName: 'BNB Chain' },
        status: 'ready',
        assets: [otherChain],
        errorCodes: []
      }
    ],
    confidential: {
      status: 'ready',
      assets: [
        {
          tokenId: 'private-zec',
          protocolAssetId: 'nep141:zec.omft.near',
          assetId,
          chainId,
          availableRaw: '125000000',
          decimals: 8,
          symbol: 'ZEC'
        }
      ]
    }
  }
  const input = {
    model: projectPortfolioForDomain(model, 'shield'),
    sourceModel: model,
    network: 'mainnet',
    domain: 'shield',
    sourcePrices: null,
    selectedChainIds: null,
    enabledFlags: ['chain.zcash', 'chain.evm']
  }
  const display = buildPortfolioDisplay(input)
  expect(display.confidentialZec?.amount).toBe('1.25')
  expect(display.separateConfidential).toHaveLength(0)
  const groups = display.primaryAssetGroups
  expect(groups.map(group => group.representativeAssetId).sort()).toEqual(
    [assetId, evmAssetId].sort()
  )
  const zecGroup = groups.find(group => group.representativeAssetId === assetId)
  expect(zecGroup.entries[0].asset.balance.totalRaw).toBe('200000000')
  expect(getMergedZecProviderBalances(zecGroup.entries, display.confidentialZec, 'shield')).toEqual(
    [
      { provider: 'Zcash Shield', amount: '2' },
      { provider: 'NEAR Confidential', amount: '1.25' }
    ]
  )
  expect(
    getMergedZecProviderBalances(zecGroup.entries, display.confidentialZec, 'public')
  ).toBeNull()
  expect(
    getMergedZecProviderBalances(
      groups.find(group => group.representativeAssetId === evmAssetId).entries,
      display.confidentialZec,
      'shield'
    )
  ).toBeNull()
  const zcashSection = getPortfolioChainSection(
    display.sortedChains.find(chain => chain.chain.id === chainId),
    display.prices,
    display.visibleConfidential,
    display.confidentialZec
  )
  expect(zcashSection.primaryAssets).toHaveLength(1)
  expect(zcashSection.separateHoldings).toHaveLength(0)
  expect(zcashSection.primaryAssets[0].balance.totalRaw).toBe('200000000')

  const confidentialOnly = {
    ...model,
    assets: [otherChain],
    chains: model.chains.slice(1)
  }
  const onlyProjected = projectPortfolioForDomain(confidentialOnly, 'shield')
  const onlyDisplay = buildPortfolioDisplay({
    ...input,
    model: withNearConfidentialZecChain(onlyProjected, 'mainnet'),
    sourceModel: confidentialOnly
  })
  const onlyGroup = onlyDisplay.primaryAssetGroups.find(
    group => group.representativeAssetId === assetId
  )
  expect(onlyGroup).toBeDefined()
  expect(
    getMergedZecProviderBalances(onlyGroup.entries, onlyDisplay.confidentialZec, 'shield')
  ).toBeNull()
})

test('Home domain projection keeps pending balances on their own networks', () => {
  const evmChain = { chain: { id: 'eip155:1', family: 'evm' }, status: 'ready', assets: [] }
  const zcashChain = {
    chain: { id: 'bip122:00040fe8ec8471911baa1db1266ea15d', family: 'zcash' },
    status: 'loading',
    assets: []
  }
  const model = { status: 'partial', assets: [], chains: [evmChain, zcashChain] }
  const privateModel = projectPortfolioForDomain(model, 'private')
  expect(privateModel.chains.map(chain => chain.chain.id)).toEqual([evmChain.chain.id])
  expect(privateModel.status).toBe('ready')
  expect(projectPortfolioForDomain(model, 'public').chains.map(chain => chain.chain.id)).toEqual([
    evmChain.chain.id,
    zcashChain.chain.id
  ])
  expect(projectPortfolioForDomain(model, 'shield').chains.map(chain => chain.chain.id)).toEqual([
    evmChain.chain.id,
    zcashChain.chain.id
  ])
  expect(projectPortfolioForDomain({ ...model, chains: [zcashChain] }, 'private')).toMatchObject({
    status: 'empty',
    chains: []
  })
  expect(
    projectPortfolioForDomain(
      { ...model, chains: [{ ...evmChain, status: 'loading' }, zcashChain] },
      'private'
    ).status
  ).toBe('loading')
})

test('Public-only EVM accounts do not expose empty Private or Shield source rows', () => {
  const asset = {
    asset: { id: 'eip155:1/erc20:0x1111111111111111111111111111111111111111', chainId: 'eip155:1' },
    source: 'user-added',
    balance: { totalRaw: '200', mainRaw: '200', privateRaw: '0', pendingRaw: '0' }
  }
  const model = {
    status: 'ready',
    assets: [asset],
    chains: [{ chain: { id: 'eip155:1', family: 'evm' }, status: 'ready', assets: [asset] }]
  }
  expect(
    projectPortfolioForDomain(model, 'public', { evmPrivateAvailable: false }).assets
  ).toHaveLength(1)
  expect(
    projectPortfolioForDomain(model, 'shield', { evmPrivateAvailable: false }).assets
  ).toHaveLength(0)
  expect(
    projectPortfolioForDomain(model, 'private', { evmPrivateAvailable: false }).assets
  ).toHaveLength(0)
  expect(
    projectPortfolioForDomain(model, 'shield', { evmPrivateAvailable: true }).assets
  ).toHaveLength(1)
})

test('Home total requires a complete current-account Portfolio and ready prices', () => {
  const model = { scope: { keyDomainId: 'wallet-a', accountId: 'account-a' }, status: 'ready' }
  const fiat = { missingAssetCount: 0, staleAssetCount: 0 }
  const complete = (candidate, priceStatus, walletId, accountId, summary = fiat) =>
    hasCompletePortfolioTotal(candidate, priceStatus, walletId, accountId, summary)
  expect(complete(model, 'ready', 'wallet-a', 'account-a')).toBe(true)
  expect(complete({ ...model, status: 'partial' }, 'ready', 'wallet-a', 'account-a')).toBe(false)
  expect(complete({ ...model, status: 'loading' }, 'ready', 'wallet-a', 'account-a')).toBe(false)
  expect(complete(model, 'error', 'wallet-a', 'account-a')).toBe(false)
  expect(complete(model, 'ready', 'wallet-a', 'account-b')).toBe(false)
  expect(complete(model, 'ready', 'wallet-b', 'account-a')).toBe(false)
  expect(complete(model, 'ready', 'wallet-a', 'account-a', { ...fiat, missingAssetCount: 1 })).toBe(
    false
  )
  expect(complete(model, 'ready', 'wallet-a', 'account-a', { ...fiat, staleAssetCount: 1 })).toBe(
    false
  )
})

test('Home shows only a scoped complete cached total until a current valuation is available', () => {
  const values = new Map([
    ['mainnet_wallet-a_account-a', {
      valuationBasis: 'wallet-assets-v2', totalUsd: '12.5', updatedAt: 1, complete: true
    }],
    ['mainnet_wallet-a_account-b', {
      valuationBasis: 'wallet-assets-v2', totalUsd: '99', updatedAt: 1, complete: false
    }]
  ])
  const cached = (network, walletId, accountId, selectedChains) =>
    resolveHomeCachedTotal(values, network, walletId, accountId, selectedChains)
  expect(cached('mainnet', 'wallet-a', 'account-a')).toBe('12.5')
  expect(cached('mainnet', 'wallet-a', 'account-b')).toBeNull()
  expect(cached('testnet', 'wallet-a', 'account-a')).toBeNull()
  expect(cached('mainnet', 'wallet-b', 'account-a')).toBeNull()
  expect(cached('mainnet', 'wallet-a', 'account-a', ['eip155:1'])).toBeNull()

  const base = {
    portfolio: null, walletId: 'wallet-a', accountId: 'account-a',
    loadStatus: 'loading', settled: false, priceStatus: 'loading',
    totalStatus: 'loading', fiat: { totalUsd: '0' }, breakdown: null,
    cachedTotalUsd: cached('mainnet', 'wallet-a', 'account-a')
  }
  const initial = resolveHomeAssetDomainDisplay(base)
  expect(initial.totals).toEqual({ all: '12.5', public: null, shield: null, private: null })
  expect(initial.loading.all).toBe(false)
  expect(resolveHomeAssetDomainDisplay({ ...base, cachedTotalUsd: null }).loading.all).toBe(true)
  expect(resolveHomeAssetDomainDisplay({
    ...base, totalStatus: 'ready', fiat: { totalUsd: '7' }
  }).totals.all).toBe('7')
})

test('Home renders available valuations during partial refreshes instead of an endless skeleton', () => {
  const model = { scope: { keyDomainId: 'wallet-a', accountId: 'account-a' }, status: 'ready' }
  const fiat = { pricedAssetCount: 1, missingAssetCount: 0, staleAssetCount: 0 }
  const status = (candidate, load = 'ready', prices = 'ready', summary = fiat) =>
    resolveHomePortfolioTotalStatus(candidate, load, prices, 'wallet-a', 'account-a', summary)
  expect(status(model)).toBe('ready')
  expect(status({ ...model, status: 'partial' })).toBe('partial')
  expect(status({ ...model, status: 'error' })).toBe('partial')
  expect(status(model, 'loading', 'loading')).toBe('partial')
  expect(
    status(
      {
        ...model,
        status: 'loading',
        chains: [{ status: 'loading', assets: [] }],
        confidential: { status: 'ready', assets: [] }
      },
      'loading',
      'loading',
      { ...fiat, pricedAssetCount: 0 }
    )
  ).toBe('partial')
  expect(status(model, 'ready', 'error', { ...fiat, staleAssetCount: 1 })).toBe('partial')
  expect(status(model, 'ready', 'ready', { ...fiat, missingAssetCount: 1 })).toBe('partial')
  expect(status({ ...model, scope: { ...model.scope, accountId: 'account-b' } })).toBe(
    'unavailable'
  )
})

test('Home distinguishes an initial load, an unavailable valuation and a confirmed zero balance', () => {
  const model = { scope: { keyDomainId: 'wallet-a', accountId: 'account-a' }, status: 'ready' }
  const fiat = { pricedAssetCount: 0, missingAssetCount: 0, staleAssetCount: 0 }
  const status = (candidate, load, prices, summary = fiat) =>
    resolveHomePortfolioTotalStatus(candidate, load, prices, 'wallet-a', 'account-a', summary)
  expect(status(null, 'loading', 'ready')).toBe('loading')
  expect(status(null, 'error', 'ready')).toBe('unavailable')
  expect(status(model, 'ready', 'loading', { ...fiat, missingAssetCount: 1 })).toBe('loading')
  expect(status(model, 'ready', 'error', { ...fiat, missingAssetCount: 1 })).toBe('ready')
  expect(status({ ...model, status: 'partial' }, 'ready', 'ready')).toBe('unavailable')
  expect(
    status(
      {
        ...model,
        status: 'partial',
        chains: [
          { status: 'ready', assets: [] },
          { status: 'loading', assets: [] }
        ]
      },
      'loading',
      'loading'
    )
  ).toBe('partial')
  expect(
    status(
      {
        ...model,
        status: 'partial',
        chains: [{ status: 'ready', assets: [{ balance: { totalRaw: '1' } }] }]
      },
      'ready',
      'ready',
      { ...fiat, missingAssetCount: 1 }
    )
  ).toBe('partial')
  expect(status(model, 'ready', 'error')).toBe('ready')
  expect(status({ ...model, status: 'empty' }, 'ready', 'error')).toBe('ready')
  expect(
    status(
      {
        ...model,
        chains: [{ status: 'ready', assets: [] }],
        confidential: { status: 'unavailable', assets: [] }
      },
      'ready',
      'ready',
      { ...fiat, missingAssetCount: 1 }
    )
  ).toBe('partial')
  expect(
    status(
      { ...model, status: 'empty', confidential: { status: 'unavailable', assets: [] } },
      'ready',
      'ready',
      { ...fiat, missingAssetCount: 1 }
    )
  ).toBe('unavailable')
})

test('home asset domains count each EVM and Zcash balance once', () => {
  const evmAsset = {
    asset: { id: 'eip155:1/slip44:60', chainId: 'eip155:1', kind: 'native' },
    metadata: { decimals: 0, symbol: 'ETH' },
    balance: {
      totalRaw: '100',
      mainRaw: '50',
      privateRaw: '50',
      privateOnchainRaw: '30',
      confidentialRaw: '20',
      pendingRaw: '0'
    }
  }
  const zcashAsset = {
    asset: {
      id: 'bip122:00040fe8ec8471911baa1db1266ea15d/slip44:133',
      chainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
      kind: 'native'
    },
    metadata: { decimals: 0, symbol: 'ZEC' },
    balance: { totalRaw: '10', transparentRaw: '4', shieldedRaw: '6', pendingRaw: '0' }
  }
  const model = {
    assets: [evmAsset, zcashAsset],
    chains: [
      { chain: { id: evmAsset.asset.chainId, family: 'evm' }, assets: [evmAsset] },
      { chain: { id: zcashAsset.asset.chainId, family: 'zcash' }, assets: [zcashAsset] }
    ]
  }
  const prices = {
    quotes: [
      { assetId: evmAsset.asset.id, priceUsd: '2', freshness: 'fresh' },
      { assetId: zcashAsset.asset.id, priceUsd: '3', freshness: 'fresh' }
    ]
  }
  const input = {
    livePortfolioTotal: true,
    portfolio: model,
    prices
  }
  expect(getHomeAssetBreakdown(input)).toEqual({
    publicUsd: '112',
    publicUsdPartial: false,
    shieldUsd: '58',
    shieldUsdPartial: false,
    privateUsd: '60',
    privateUsdPartial: false
  })
  expect(summarizeAssetDomainsUsd(model, prices)).toEqual({
    publicUsd: '112',
    publicUsdPartial: false,
    shieldUsd: '58',
    shieldUsdPartial: false,
    privateUsd: '60',
    privateUsdPartial: false
  })
  expect(getAssetDomainRaw(evmAsset, 'private')).toBe('30')
  const baseOnly = {
    ...evmAsset,
    balance: { totalRaw: '100', mainRaw: '50', privateRaw: '50' }
  }
  expect(getAssetDomainRaw(baseOnly, 'private')).toBe('50')
  expect(getAssetDomainRaw(baseOnly, 'shield')).toBe('0')
  expect(
    getAssetDomainRaw(
      { ...evmAsset, balance: { ...baseOnly.balance, confidentialRaw: '20' } },
      'private'
    )
  ).toBeNull()
  expect(
    getAssetDomainRaw(
      { ...evmAsset, balance: { ...evmAsset.balance, privateOnchainRaw: '29' } },
      'private'
    )
  ).toBeNull()
  expect(getAssetDomainRaw(zcashAsset, 'shield')).toBe('6')
  expect(getAssetDomainRaw(zcashAsset, 'private')).toBe('0')
  expect(projectPortfolioForDomain(model, 'public').chains[1].assets[0].balance.totalRaw).toBe('4')
  expect(projectPortfolioForDomain(model, 'shield').chains[1].assets[0].balance.totalRaw).toBe('6')
  expect(projectPortfolioForDomain(model, 'private').chains.map(chain => chain.chain.id)).toEqual([
    evmAsset.asset.chainId
  ])
  expect(
    projectPortfolioForDomain(model, 'shield').assets.map(asset => asset.balance.totalRaw)
  ).toEqual(['20', '6'])
  expect(evmAsset.balance.totalRaw).toBe('100')
  expect(zcashAsset.balance.totalRaw).toBe('10')
  const independent = {
    ...model,
    confidential: {
      status: 'ready',
      assets: [
        {
          tokenId: 'private-eth',
          protocolAssetId: 'eth',
          availableRaw: '20',
          assetId: evmAsset.asset.id,
          decimals: 0,
          priceUsd: '2'
        },
        {
          tokenId: 'private-usdc',
          protocolAssetId: 'usdc',
          availableRaw: '50',
          decimals: 0,
          priceUsd: '1',
          priceUpdatedAt: new Date().toISOString()
        }
      ]
    }
  }
  expect(summarizePortfolioFiat(independent, prices)).toMatchObject({
    totalUsd: '280',
    pricedAssetCount: 4,
    missingAssetCount: 0,
    staleAssetCount: 0
  })
  expect(summarizeAssetDomainsUsd(independent, prices)).toEqual({
    publicUsd: '112',
    publicUsdPartial: false,
    shieldUsd: '108',
    shieldUsdPartial: false,
    privateUsd: '60',
    privateUsdPartial: false
  })
  const withConfidentialZec = {
    ...independent,
    confidential: {
      ...independent.confidential,
      assets: [
        ...independent.confidential.assets,
        {
          tokenId: 'private-zec',
          protocolAssetId: 'zec',
          availableRaw: '2',
          assetId: zcashAsset.asset.id,
          decimals: 0
        }
      ]
    }
  }
  expect(summarizePortfolioFiat(withConfidentialZec, prices)).toMatchObject({
    totalUsd: '286',
    missingAssetCount: 0
  })
  expect(summarizeAssetDomainsUsd(withConfidentialZec, prices)).toEqual({
    publicUsd: '112',
    publicUsdPartial: false,
    shieldUsd: '114',
    shieldUsdPartial: false,
    privateUsd: '60',
    privateUsdPartial: false
  })
  const chainScoped = {
    ...withConfidentialZec,
    confidential: {
      ...withConfidentialZec.confidential,
      assets: withConfidentialZec.confidential.assets.map(asset =>
        asset.protocolAssetId === 'usdc' ? { ...asset, chainId: 'eip155:42161' } : asset
      )
    }
  }
  expect(
    projectPortfolioForChains(
      chainScoped,
      model.chains.map(chain => chain.chain.id)
    )
  ).toBe(chainScoped)
  const ethereum = projectPortfolioForChains(chainScoped, [evmAsset.asset.chainId])
  expect(summarizePortfolioFiat(ethereum, prices).totalUsd).toBe('200')
  expect(summarizeAssetDomainsUsd(ethereum, prices)).toEqual({
    publicUsd: '100',
    publicUsdPartial: false,
    shieldUsd: '40',
    shieldUsdPartial: false,
    privateUsd: '60',
    privateUsdPartial: false
  })
  const zcash = projectPortfolioForChains(chainScoped, [zcashAsset.asset.chainId])
  expect(summarizePortfolioFiat(zcash, prices).totalUsd).toBe('36')
  expect(getHomeAssetBreakdown({ ...input, portfolio: zcash })).toEqual({
    publicUsd: '12',
    publicUsdPartial: false,
    shieldUsd: '24',
    shieldUsdPartial: false,
    privateUsd: '0',
    privateUsdPartial: false
  })
  expect(summarizePortfolioFiat(chainScoped, prices).totalUsd).toBe('286')
  const staleCatalog = {
    ...independent,
    confidential: {
      ...independent.confidential,
      assets: independent.confidential.assets.map(asset =>
        asset.tokenId === 'private-usdc'
          ? { ...asset, priceUpdatedAt: '2020-01-01T00:00:00.000Z' }
          : asset
      )
    }
  }
  expect(summarizePortfolioFiat(staleCatalog, prices)).toMatchObject({
    totalUsd: '280',
    staleAssetCount: 1
  })
  expect(
    getHomeAssetBreakdown({
      ...input,
      portfolio: independent
    })
  ).toMatchObject({ shieldUsd: '108' })
  const unavailable = { ...independent, confidential: { status: 'unavailable', assets: [] } }
  expect(summarizePortfolioFiat(unavailable, prices)).toMatchObject({
    totalUsd: '190',
    missingAssetCount: 1
  })
  expect(summarizeAssetDomainsUsd(unavailable, prices)).toMatchObject({
    shieldUsd: '18',
    shieldUsdPartial: true
  })
  expect(
    summarizeKnownShieldFiat({ status: 'unavailable', entries: [], fiat: null }, '18')
  ).toEqual({ usd: '18', partial: true })
  expect(
    summarizeKnownShieldFiat({ status: 'unavailable', entries: [], fiat: null }, null)
  ).toEqual({ usd: null, partial: true })
  const missingPrice = {
    ...independent,
    confidential: {
      ...independent.confidential,
      assets: independent.confidential.assets.map(asset =>
        asset.tokenId === 'private-usdc' ? { ...asset, priceUsd: undefined } : asset
      )
    }
  }
  expect(summarizePortfolioFiat(missingPrice, prices)).toMatchObject({
    totalUsd: '230',
    missingAssetCount: 1
  })
  expect(summarizeAssetDomainsUsd(missingPrice, prices)).toMatchObject({
    shieldUsd: '58',
    shieldUsdPartial: true
  })
  expect(summarizeAssetDomainsUsd({ ...unavailable, assets: [evmAsset] }, prices)).toMatchObject({
    shieldUsd: null,
    shieldUsdPartial: true
  })
  expect(getHomeAssetBreakdown({ ...input, portfolio: null })).toBeNull()
  const unpricedPublicAsset = {
    ...evmAsset,
    asset: { ...evmAsset.asset, id: 'eip155:1/erc20:unpriced' },
    balance: {
      totalRaw: '10',
      mainRaw: '10',
      privateRaw: '0',
      privateOnchainRaw: '0',
      confidentialRaw: '0'
    }
  }
  const withUnpriced = { ...model, assets: [...model.assets, unpricedPublicAsset] }
  expect(summarizePortfolioFiat(withUnpriced, prices)).toMatchObject({
    totalUsd: '230',
    missingAssetCount: 1
  })
  expect(getHomeAssetBreakdown({ ...input, portfolio: withUnpriced })).toEqual({
    publicUsd: '112',
    publicUsdPartial: true,
    shieldUsd: '58',
    shieldUsdPartial: false,
    privateUsd: '60',
    privateUsdPartial: false
  })
  const staleEvmPrices = {
    quotes: prices.quotes.map(quote =>
      quote.assetId === evmAsset.asset.id ? { ...quote, freshness: 'stale' } : quote
    )
  }
  expect(summarizeAssetDomainsUsd(model, staleEvmPrices)).toEqual({
    publicUsd: '112',
    publicUsdPartial: true,
    shieldUsd: '58',
    shieldUsdPartial: true,
    privateUsd: '60',
    privateUsdPartial: true
  })
  expect(summarizeAssetDomainsUsd({ ...model, assets: [unpricedPublicAsset] }, prices)).toEqual({
    publicUsd: null,
    publicUsdPartial: true,
    shieldUsd: '0',
    shieldUsdPartial: false,
    privateUsd: '0',
    privateUsdPartial: false
  })
  expect(
    summarizeAssetDomainsUsd(
      { ...model, assets: [evmAsset, { ...zcashAsset, balance: { totalRaw: '10' } }] },
      prices
    )
  ).toEqual({
    publicUsd: '100',
    publicUsdPartial: true,
    shieldUsd: '40',
    shieldUsdPartial: true,
    privateUsd: '60',
    privateUsdPartial: false
  })
  expect(getAssetDomainRaw({ ...evmAsset, balance: { totalRaw: '100' } }, 'public')).toBeNull()
  expect(getHomeAssetBreakdown({ ...input, livePortfolioTotal: false })).toBeNull()
})

test('asset detail uses a unique Confidential identity without adding it to the Home row total', () => {
  const asset = {
    asset: { id: 'eip155:1/slip44:60', chainId: 'eip155:1' },
    metadata: { decimals: 0 },
    balance: {
      totalRaw: '100',
      mainRaw: '50',
      privateRaw: '50',
      privateOnchainRaw: '30',
      confidentialRaw: '20'
    }
  }
  const holding = {
    tokenId: 'private-eth',
    assetId: asset.asset.id,
    chainId: asset.asset.chainId,
    decimals: 0,
    availableRaw: '20',
    priceUsd: '3'
  }
  const model = { assets: [asset], confidential: { status: 'ready', assets: [holding] } }
  const categories = getAssetDetailCategories(asset, model, true, '2')
  expect(categories.domains).toEqual(['all', 'public', 'shield', 'private'])
  expect(categories.raw).toEqual({ all: '100', public: '50', shield: '20', private: '30' })
  expect(categories.fiat).toEqual({ all: '200', public: '100', shield: '40', private: '60' })
  expect(getAssetDetailCategories(asset, model, true).fiat).toEqual({
    all: null,
    public: null,
    shield: '60',
    private: null
  })
  expect(
    getAssetDetailCategories(
      asset,
      {
        ...model,
        confidential: { status: 'ready', assets: [{ ...holding, priceUsd: 'invalid' }] }
      },
      true
    ).fiat.shield
  ).toBeNull()
  expect(resolveConfidentialDetailAssetId(model, holding.tokenId)).toBe(asset.asset.id)
  expect(
    resolveConfidentialDetailAssetId(
      {
        ...model,
        confidential: { status: 'ready', assets: [holding, { ...holding, tokenId: 'other' }] }
      },
      holding.tokenId
    )
  ).toBeNull()

  expect(
    getAssetDetailCategories(asset, { confidential: { status: 'unavailable', assets: [] } }, true)
      .raw.shield
  ).toBeNull()
  expect(
    getAssetDetailCategories(asset, { confidential: { status: 'unavailable', assets: [] } }, true)
      .fiat.shield
  ).toBeNull()
  expect(
    getAssetDetailCategories(
      asset,
      { confidential: { status: 'ready', assets: [holding, holding] } },
      true
    ).raw.shield
  ).toBeNull()
  expect(
    getAssetDetailCategories(
      asset,
      { confidential: { status: 'ready', assets: [holding, holding] } },
      true
    ).fiat.shield
  ).toBeNull()
  expect(
    getAssetDetailCategories(
      asset,
      { confidential: { status: 'ready', assets: [{ ...holding, chainId: 'eip155:42161' }] } },
      true
    ).raw.shield
  ).toBeNull()
  expect(
    getAssetDetailCategories(
      { ...asset, balance: { ...asset.balance, confidentialRaw: '0' } },
      { confidential: { status: 'ready', assets: [] } },
      true
    ).raw.shield
  ).toBe('0')
})

test('Activity details show the outgoing hash before destination settlement', () => {
  const sourceHash = `0x${'a'.repeat(64)}`
  const destinationHash = `0x${'b'.repeat(64)}`
  const outgoingHash = `0x${'c'.repeat(64)}`
  const references = getActivityTransactionReferences({
    snapshot: { sender: { chainId: 'eip155:1', address: '0xsource' } },
    segments: [
      {
        id: 'destination',
        role: 'destination',
        target: { kind: 'onchain', chainId: 'eip155:42161' },
        evidence: { transactionHash: destinationHash }
      },
      {
        id: 'origin',
        role: 'origin',
        target: { kind: 'protocol', provider: 'Confidential Intents' },
        evidence: { transactionHash: sourceHash }
      }
    ]
  })
  expect(references).toEqual([
    {
      id: 'origin',
      label: 'Outgoing Hash',
      hash: sourceHash,
      chainId: null
    },
    {
      id: 'destination',
      label: 'Destination Hash',
      hash: destinationHash,
      chainId: 'eip155:42161'
    }
  ])
  expect(
    getActivityTransactionReferences({
      segments: [
        { id: 'origin', role: 'origin', target: { kind: 'relay', provider: 'Signed Order' } },
        {
          id: 'destination',
          role: 'destination',
          target: { kind: 'onchain', chainId: 'eip155:1' },
          evidence: { transactionHash: destinationHash }
        }
      ]
    })
  ).toEqual([
    {
      id: 'destination',
      label: 'Transaction Hash',
      hash: destinationHash,
      chainId: 'eip155:1'
    }
  ])
  expect(
    getActivityTransactionReferences({
      segments: [
        {
          id: 'origin',
          role: 'origin',
          target: { kind: 'onchain', chainId: 'eip155:1' },
          evidence: { transactionHash: outgoingHash }
        }
      ]
    })
  ).toEqual([
    {
      id: 'origin',
      label: 'Transaction Hash',
      hash: outgoingHash,
      chainId: 'eip155:1'
    }
  ])
  expect(
    getActivityTransactionReferences({
      segments: [
        {
          id: 'origin',
          role: 'origin',
          target: { kind: 'onchain', chainId: 'eip155:1' },
          evidence: { transactionHash: outgoingHash }
        },
        {
          id: 'relay',
          role: 'relay',
          target: { kind: 'protocol', provider: 'Confidential Intents' },
          evidence: { transactionHash: `0x${'C'.repeat(64)}` }
        }
      ]
    })
  ).toEqual([
    {
      id: 'origin',
      label: 'Transaction Hash',
      hash: outgoingHash,
      chainId: 'eip155:1'
    }
  ])
  expect(
    getActivityTransactionReferences({
      segments: [
        {
          id: 'origin',
          role: 'origin',
          target: { kind: 'onchain', chainId: 'eip155:1' },
          evidence: { transactionHash: outgoingHash }
        },
        {
          id: 'relay',
          role: 'relay',
          target: { kind: 'protocol', provider: 'Confidential Intents' },
          evidence: { transactionHash: outgoingHash }
        },
        {
          id: 'destination',
          role: 'destination',
          target: { kind: 'onchain', chainId: 'eip155:42161' },
          evidence: { transactionHash: outgoingHash }
        }
      ]
    })
  ).toEqual([
    { id: 'origin', label: 'Outgoing Hash', hash: outgoingHash, chainId: 'eip155:1' },
    { id: 'destination', label: 'Destination Hash', hash: outgoingHash, chainId: 'eip155:42161' }
  ])
  expect(
    getActivityTransactionReferences({
      segments: [
        {
          id: 'origin',
          role: 'origin',
          target: { kind: 'protocol', provider: 'Confidential Intents' },
          evidence: { transactionHash: outgoingHash }
        },
        {
          id: 'relay',
          role: 'relay',
          target: { kind: 'onchain', chainId: 'eip155:1' },
          evidence: { transactionHash: outgoingHash }
        }
      ]
    })
  ).toEqual([{ id: 'relay', label: 'Transaction Hash', hash: outgoingHash, chainId: 'eip155:1' }])
  const base58Hash = '3s'.repeat(32)
  const differentlyCasedBase58Hash = '3S'.repeat(32)
  expect(
    getActivityTransactionReferences({
      segments: [
        {
          id: 'origin',
          role: 'origin',
          target: { kind: 'onchain', chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' },
          evidence: { transactionHash: base58Hash }
        },
        {
          id: 'relay',
          role: 'relay',
          target: { kind: 'protocol', provider: 'Confidential Intents' },
          evidence: { transactionHash: differentlyCasedBase58Hash }
        }
      ]
    })
  ).toEqual([
    {
      id: 'origin',
      label: 'Outgoing Hash',
      hash: base58Hash,
      chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
    },
    { id: 'relay', label: 'Relay Hash', hash: differentlyCasedBase58Hash, chainId: null }
  ])
})
