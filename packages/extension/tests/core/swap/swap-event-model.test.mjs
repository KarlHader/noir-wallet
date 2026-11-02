import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  resolveSwapAnalyticsAction,
  resolveSwapAnalyticsContext
} from '../../../src/popup/services/swap-event-model.ts'

const ordinary = {
  privateTransferRequested: false,
  privateBalanceTransferRequested: false,
  crossChainSendRequested: false,
  isPrivateFunding: false
}

test('Swap page only reports actual swaps to the Swap funnel', () => {
  assert.deepEqual(resolveSwapAnalyticsAction(ordinary), {
    isTransfer: false,
    kind: 'private-transfer'
  })
  for (const route of [
    { privateTransferRequested: true },
    { privateBalanceTransferRequested: true },
    { isPrivateFunding: true }
  ]) {
    assert.deepEqual(resolveSwapAnalyticsAction({ ...ordinary, ...route }), {
      isTransfer: true,
      kind: 'private-transfer'
    })
  }
  assert.deepEqual(resolveSwapAnalyticsAction({ ...ordinary, crossChainSendRequested: true }), {
    isTransfer: true,
    kind: 'transfer'
  })
})

test('Swap analytics uses the actual source chain and route direction', () => {
  const base = {
    isTransfer: false,
    executionSourceMode: 'main',
    sourceBlockchain: 'eth',
    sourceChainId: '1'
  }
  assert.deepEqual(
    resolveSwapAnalyticsContext({
      ...base,
      destinationBlockchain: 'zec',
      destinationChainId: 'zcash'
    }),
    { chain: 'evm', direction: 'other_to_zec' }
  )
  assert.deepEqual(
    resolveSwapAnalyticsContext({ ...base, destinationBlockchain: 'eth', destinationChainId: '1' }),
    { chain: 'evm', direction: 'same_chain' }
  )
  assert.deepEqual(
    resolveSwapAnalyticsContext({
      ...base,
      destinationBlockchain: 'base',
      destinationChainId: '8453'
    }),
    { chain: 'evm', direction: 'cross_chain' }
  )
  assert.deepEqual(
    resolveSwapAnalyticsContext({
      ...base,
      sourceBlockchain: 'zec',
      sourceChainId: 'zcash',
      destinationChainId: '1'
    }),
    { chain: 'zcash', direction: 'zec_to_other' }
  )
  assert.deepEqual(
    resolveSwapAnalyticsContext({
      ...base,
      sourceBlockchain: 'btc',
      sourceChainId: 'btc',
      destinationChainId: '1'
    }),
    { chain: 'bitcoin', direction: 'cross_chain' }
  )
})

test('Public and confidential transfers report their execution funding source', () => {
  const base = {
    sourceFamily: 'evm',
    sourceBlockchain: 'eth',
    destinationBlockchain: 'eth',
    sourceChainId: '1',
    destinationChainId: '1',
    isTransfer: true
  }
  assert.deepEqual(resolveSwapAnalyticsContext({ ...base, executionSourceMode: 'main' }), {
    chain: 'evm',
    direction: 'same_chain',
    fundingSource: 'main'
  })
  assert.deepEqual(resolveSwapAnalyticsContext({ ...base, executionSourceMode: 'private' }), {
    chain: 'evm',
    direction: 'same_chain',
    fundingSource: 'private'
  })
})
