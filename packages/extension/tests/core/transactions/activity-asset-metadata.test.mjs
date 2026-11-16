import { test } from 'node:test'
import { expect } from '@playwright/test'

import { mergeActivityAssetMetadata } from '../../../src/popup/components/transaction/activity-asset-metadata.ts'
import {
  getActivityDetailTitle,
  getActivityDisplayChanges,
  resolveActivityDisplayAmount
} from '../../../src/popup/components/transaction/multichain-activity-presentation.ts'
import { getActivityInteractionPresentation } from '../../../src/popup/components/transaction/activity-interaction-adapters.ts'

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

test('formats a detected ERC-20 transfer after its balance leaves Portfolio', () => {
  const chainId = 'eip155:80094'
  const contractAddress = `0x${'7'.repeat(40)}`
  const tokenId = `${chainId}/erc20:${contractAddress}`
  const metadata = mergeActivityAssetMetadata([], null, [
    {
      assetId: tokenId,
      chainId,
      contractAddress,
      metadata: { name: 'USD0', symbol: 'USD0', decimals: 6 },
      detectedAt: 1,
      lastSeenAt: 2
    }
  ])
  const amount = { assetId: tokenId, amountRaw: '550431' }
  expect(resolveActivityDisplayAmount(amount, metadata)).toMatchObject({
    symbol: 'USD0',
    formatted: '0.5504'
  })

  const call = {
    kind: 'contract-call',
    source: 'wallet-v2',
    status: 'final',
    snapshot: { direction: 'contract' },
    segments: [
      {
        role: 'origin',
        status: 'final',
        target: { kind: 'onchain', chainId },
        evidence: {
          transactionHash: `0x${'a'.repeat(64)}`,
          assetEffects: {
            source: 'receipt',
            completeness: 'partial',
            changes: [{ ...amount, direction: 'outgoing' }]
          }
        }
      }
    ]
  }
  expect(
    getActivityDetailTitle(call, getActivityInteractionPresentation(call, chainId)?.title)
  ).toBe('Contract interaction')
  expect(getActivityDisplayChanges(call, metadata)).toMatchObject([
    { symbol: 'USD0', value: '0.550431', direction: 'outgoing', isRaw: false }
  ])
})
