import { test } from 'node:test'
import { expect } from '@playwright/test'

import { mergeActivityAssetMetadata } from '../../../src/popup/components/transaction/activity-asset-metadata.ts'

const chainId = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const assetId = `${chainId}/token:${mint}`

test('uses Portfolio metadata for dynamically discovered Solana Activity assets', () => {
  const portfolioAsset = Object.freeze({
    asset: Object.freeze({
      id: assetId,
      chainId,
      namespace: 'token',
      reference: mint,
      kind: 'token'
    }),
    metadata: Object.freeze({ name: 'USD Coin', symbol: 'USDC', decimals: 6 }),
    source: 'protocol',
    balance: Object.freeze({
      totalRaw: '60876028',
      spendableRaw: '60876028',
      availableRaw: '60876028',
      pendingRaw: '0'
    }),
    chainAccountIds: Object.freeze([]),
    freshness: 'fresh',
    updatedAt: 1
  })
  const portfolio = Object.freeze({
    scope: Object.freeze({ keyDomainId: 'wallet-domain', accountId: 'account-1' }),
    status: 'ready',
    chains: Object.freeze([]),
    assets: Object.freeze([portfolioAsset]),
    ignoredAssetCount: 0
  })

  const metadata = mergeActivityAssetMetadata([], portfolio)

  expect(metadata.get(assetId)).toMatchObject({
    asset: { id: assetId },
    metadata: { symbol: 'USDC', decimals: 6 }
  })
})

test('uses Portfolio metadata to format received rNEAR Activity amounts', () => {
  const rnearAssetId = 'near:mainnet/nep141:lst.rhealab.near'
  const portfolioAsset = Object.freeze({
    asset: Object.freeze({
      id: rnearAssetId,
      chainId: 'near:mainnet',
      namespace: 'nep141',
      reference: 'lst.rhealab.near',
      kind: 'token'
    }),
    metadata: Object.freeze({ name: 'rNEAR', symbol: 'rNEAR', decimals: 24 }),
    source: 'protocol',
    balance: Object.freeze({
      totalRaw: '200000000000000000000000',
      spendableRaw: '200000000000000000000000',
      availableRaw: '200000000000000000000000',
      pendingRaw: '0'
    }),
    chainAccountIds: Object.freeze([]),
    freshness: 'fresh',
    updatedAt: 1
  })
  const portfolio = Object.freeze({
    scope: Object.freeze({ keyDomainId: 'wallet-domain', accountId: 'account-1' }),
    status: 'ready',
    chains: Object.freeze([]),
    assets: Object.freeze([portfolioAsset]),
    ignoredAssetCount: 0
  })

  expect(mergeActivityAssetMetadata([], portfolio).get(rnearAssetId)).toMatchObject({
    metadata: { symbol: 'rNEAR', decimals: 24 }
  })
})
