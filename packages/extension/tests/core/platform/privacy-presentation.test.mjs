import { test } from 'node:test'
import { expect } from '@playwright/test'
import { getConfidentialTransferEstimate } from '../../../src/config/intents.ts'
import { summarizePortfolioFiat } from '../../../src/popup/components/portfolio/portfolio-prices.ts'
import { getActivityTransactionReferences } from '../../../src/popup/services/activity-transaction-references.ts'
import {
  getHomeAssetBreakdown,
  hasCompletePortfolioTotal,
  resolveHomePortfolioTotalStatus
} from '../../../src/popup/services/home-asset-breakdown.ts'
import {
  getAssetDomainRaw,
  projectPortfolioForDomain,
  summarizeAssetDomainsUsd,
  summarizeKnownShieldFiat
} from '../../../src/popup/services/asset-domains.ts'

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

test('Home renders available valuations during partial refreshes instead of an endless skeleton', () => {
  const model = { scope: { keyDomainId: 'wallet-a', accountId: 'account-a' }, status: 'ready' }
  const fiat = { pricedAssetCount: 1, missingAssetCount: 0, staleAssetCount: 0 }
  const status = (candidate, load = 'ready', prices = 'ready', summary = fiat) =>
    resolveHomePortfolioTotalStatus(candidate, load, prices, 'wallet-a', 'account-a', summary)
  expect(status(model)).toBe('ready')
  expect(status({ ...model, status: 'partial' })).toBe('partial')
  expect(status({ ...model, status: 'error' })).toBe('partial')
  expect(status(model, 'loading', 'loading')).toBe('partial')
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
  expect(status(model, 'ready', 'error', { ...fiat, missingAssetCount: 1 })).toBe('unavailable')
  expect(status({ ...model, status: 'partial' }, 'ready', 'ready')).toBe('unavailable')
  expect(status(model, 'ready', 'error')).toBe('ready')
  expect(status({ ...model, status: 'empty' }, 'ready', 'error')).toBe('ready')
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
      { chain: { id: evmAsset.asset.chainId }, assets: [evmAsset] },
      { chain: { id: zcashAsset.asset.chainId }, assets: [zcashAsset] }
    ]
  }
  const prices = {
    quotes: [
      { assetId: evmAsset.asset.id, priceUsd: '2', freshness: 'fresh' },
      { assetId: zcashAsset.asset.id, priceUsd: '3', freshness: 'fresh' }
    ]
  }
  const multichainFiat = {
    totalUsd: '230',
    mainUsd: '112',
    privateUsd: '118',
    pricedAssetCount: 2,
    missingAssetCount: 0,
    staleAssetCount: 0
  }
  const input = {
    multichainEnabled: true,
    liveMultichainTotal: true,
    multichainFiat,
    portfolio: model,
    prices,
    zcashBalance: null,
    zecPrice: 0
  }
  expect(getHomeAssetBreakdown(input)).toEqual({
    publicUsd: '112',
    shieldUsd: '58',
    shieldUsdPartial: false,
    privateUsd: '60'
  })
  expect(summarizeAssetDomainsUsd(model, prices)).toEqual({
    publicUsd: '112',
    shieldUsd: '58',
    shieldUsdPartial: false,
    privateUsd: '60'
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
    shieldUsd: '108',
    shieldUsdPartial: false,
    privateUsd: '60'
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
    shieldUsd: '114',
    shieldUsdPartial: false,
    privateUsd: '60'
  })
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
      portfolio: independent,
      multichainFiat: summarizePortfolioFiat(independent, prices)
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
  expect(getAssetDomainRaw({ ...evmAsset, balance: { totalRaw: '100' } }, 'public')).toBeNull()
  expect(getHomeAssetBreakdown({ ...input, liveMultichainTotal: false })).toBeNull()
  expect(
    getHomeAssetBreakdown({
      ...input,
      multichainEnabled: false,
      zcashBalance: { transparent: '2', shielded: '3', total: '5' },
      zecPrice: 4
    })
  ).toEqual({
    publicUsd: '8',
    shieldUsd: '12',
    shieldUsdPartial: false,
    privateUsd: '0'
  })
})

test('confidential transfer timing is configured by chain family', () => {
  expect(getConfidentialTransferEstimate('eip155:1')).toBe('3-5 min')
  expect(getConfidentialTransferEstimate('eip155:42161')).toBe('3-5 min')
  expect(getConfidentialTransferEstimate('bip122:example')).toBeNull()
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
      label: 'Destination Hash',
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
})
