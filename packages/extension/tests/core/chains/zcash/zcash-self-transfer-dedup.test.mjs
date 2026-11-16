import { test } from 'node:test'
import { expect } from '@playwright/test'

import { mergeTransactionsWithTransparentReceives } from '../../../../src/core/wallet/transparent-history.ts'
import {
  isDuplicateWasmRow,
  localShieldedSendHashSet,
  localTxHashSet
} from '../../../../src/lib/tx-history-dedup.ts'

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

test('keeps one row when a shielded send is also indexed as a transparent receive', () => {
  const selfSend = transaction({})
  const receivedSide = transaction({
    id: 'rpc_treceive_self-transfer',
    type: 'receive',
    from: '',
    fromType: 'transparent'
  })

  expect(mergeTransactionsWithTransparentReceives([selfSend], [receivedSide])).toEqual([selfSend])
})

test('suppresses only an exact transparent receive for a locally-created shielded send', () => {
  const selfSend = transaction({})
  const wasmReceive = transaction({
    id: 'wasm_self-transfer',
    type: 'receive',
    from: '',
    fromType: 'transparent'
  })
  const unrelated = transaction({
    id: 'wasm_external',
    txHash: 'external',
    type: 'receive',
    from: '',
    fromType: 'transparent'
  })
  const allHashes = localTxHashSet([selfSend])
  const shieldedSendHashes = localShieldedSendHashSet([selfSend])

  expect(isDuplicateWasmRow(wasmReceive, allHashes, shieldedSendHashes)).toBe(true)
  expect(isDuplicateWasmRow(unrelated, allHashes, shieldedSendHashes)).toBe(false)
})

test('suppresses the transparent receive side of an Unshield transaction', () => {
  const unshield = transaction({ type: 'unshield' })
  const receivedSide = transaction({
    id: 'rpc_treceive_self-transfer',
    type: 'receive',
    from: '',
    fromType: 'transparent'
  })

  expect(mergeTransactionsWithTransparentReceives([unshield], [receivedSide])).toEqual([unshield])
})
