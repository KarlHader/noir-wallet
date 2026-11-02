import { test } from 'node:test'
import { expect } from '@playwright/test'

import { mergeConfidentialBalancesIntoPortfolio } from '../../../src/core/services/confidential-funding/confidential-funding-portfolio.ts'

test('keeps Confidential balances out of directly spendable on-chain balances', () => {
  const asset = {
    asset: { id: 'eip155:1/erc20:0x1111111111111111111111111111111111111111' },
    metadata: { decimals: 6, symbol: 'USDC' },
    source: 'bundled',
    balance: {
      totalRaw: '150',
      spendableRaw: '150',
      availableRaw: '150',
      pendingRaw: '0',
      mainRaw: '100',
      privateRaw: '50'
    },
    chainAccountIds: [],
    freshness: 'fresh',
    updatedAt: 1
  }
  const model = {
    scope: { keyDomainId: 'wallet:one', accountId: 'account:one' },
    status: 'ready',
    assets: [asset],
    chains: [{ chain: { id: 'eip155:1' }, status: 'ready', assets: [asset], errorCodes: [] }],
    ignoredAssetCount: 0
  }
  const merged = mergeConfidentialBalancesIntoPortfolio(
    model,
    [{ assetId: asset.asset.id, protocolAssetId: 'nep141:usdc.omft.near' }],
    [{ tokenId: 'nep141:usdc.omft.near', available: '25' }]
  )
  expect(merged.assets[0].balance).toMatchObject({
    totalRaw: '175',
    spendableRaw: '150',
    availableRaw: '150',
    mainRaw: '100',
    privateRaw: '75',
    privateOnchainRaw: '50',
    confidentialRaw: '25'
  })
})
