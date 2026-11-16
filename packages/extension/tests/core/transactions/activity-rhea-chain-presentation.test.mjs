import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  getActivitySwapPresentation,
  resolveActivityChainMetadata
} from '../../../src/popup/components/transaction/multichain-activity-presentation.ts'

function activity(destinationChainId) {
  return {
    kind: 'swap',
    source: 'transaction-graph',
    snapshot: {
      primaryAmount: {
        assetId: 'eip155:42161/erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831',
        amountRaw: '1000000'
      },
      counterAmount: { assetId: `${destinationChainId}/rhea:nep245%3Av2%5F1`, amountRaw: '1000000' }
    },
    segments: []
  }
}

test('RHEA fallback asset IDs show a registered EVM network without relabeling the asset', () => {
  const metadata = new Map([
    ['eip155:42161', { displayName: 'Arbitrum', iconAlias: 'arbitrum' }],
    ['eip155:56', { displayName: 'BNB Chain', iconAlias: 'bsc' }]
  ])
  const known = getActivitySwapPresentation(activity('rhea:56'), new Map(), metadata)
  assert.equal(known.destinationNetwork, 'BNB Chain')
  assert.equal(known.destinationChainIconAlias, 'bsc')
  assert.equal(known.destination, undefined)
  assert.equal(resolveActivityChainMetadata('rhea:56', metadata)?.displayName, 'BNB Chain')

  const unknown = getActivitySwapPresentation(activity('rhea:999999'), new Map(), metadata)
  assert.equal(unknown.destinationNetwork, 'Unknown network')
  assert.equal(resolveActivityChainMetadata('rhea:999999', metadata), undefined)
})
