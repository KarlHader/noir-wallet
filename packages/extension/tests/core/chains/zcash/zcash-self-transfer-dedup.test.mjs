import { test } from 'node:test'
import { expect } from '@playwright/test'

import { ZCASH_CHAIN_IDS } from '../../../../src/core/chains/registry/chain-ids.ts'
import { mergeTransactionsWithTransparentReceives } from '../../../../src/core/wallet/transparent-history.ts'
import { buildActivityReadModel } from '../../../../src/core/activity/index.ts'
import { mapZcashV1TransactionToActivityItem } from '../../../../src/infrastructure/activity/zcash-v1-activity-source.ts'
import { filterActivityItems } from '../../../../src/popup/services/activity-list-model.ts'

function transaction(overrides) {
  return {
    id: 'tx_send',
    txHash: 'self-transfer',
    status: 'success',
    type: 'send',
    amount: '0.001',
    to: 't1wallet',
    from: 'u1wallet',
    fromType: 'shielded',
    fee: '0.0001',
    timestamp: 2,
    network: 'mainnet',
    ...overrides
  }
}

test('shows a Shield send and its observed transparent receive in their own Activity modes', () => {
  const selfSend = transaction({})
  const receivedSide = transaction({
    id: 'rpc_treceive_self-transfer',
    type: 'receive',
    from: '',
    fromType: 'transparent',
    amount: '0.0009'
  })

  const history = mergeTransactionsWithTransparentReceives([selfSend], [receivedSide])
  const scope = { keyDomainId: 'wallet:activity', accountId: 'account:activity' }
  const { items } = buildActivityReadModel({
    scope,
    localGraphs: [],
    supplementalItems: history.map(entry => mapZcashV1TransactionToActivityItem(entry, scope))
  })
  const byDomain = domain =>
    filterActivityItems({ items, domain, selectedChainIds: [ZCASH_CHAIN_IDS.mainnet] })

  expect(byDomain('shield').map(item => item.id)).toEqual([selfSend.id])
  expect(byDomain('public')).toMatchObject([
    {
      id: receivedSide.id,
      kind: 'receive',
      snapshot: { direction: 'incoming', primaryAmount: { amountRaw: '90000' } }
    }
  ])
})

test('preserves the transparent receive side of an Unshield transaction', () => {
  const unshield = transaction({ type: 'unshield' })
  const receivedSide = transaction({
    id: 'rpc_treceive_self-transfer',
    type: 'receive',
    from: '',
    fromType: 'transparent'
  })

  expect(mergeTransactionsWithTransparentReceives([unshield], [receivedSide])).toEqual([
    unshield,
    receivedSide
  ])
})
