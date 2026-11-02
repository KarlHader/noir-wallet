import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeTxHash,
  isMultiStepZcashSend,
  isTransparentReceive,
  localTxHashSet,
  isDuplicateWasmRow
} from '../../../src/lib/tx-history-dedup.ts'

function tx(overrides) {
  return {
    id: 'tx_1',
    txHash: 'ABC',
    status: 'pending',
    type: 'send',
    amount: '1',
    to: 't1',
    from: 't1',
    fromType: 'shielded',
    fee: '0',
    timestamp: 0,
    network: 'mainnet',
    ...overrides
  }
}

test('normalizeTxHash trims and lowercases, tolerates null/undefined', () => {
  assert.equal(normalizeTxHash('  ABc123  '), 'abc123')
  assert.equal(normalizeTxHash(null), '')
  assert.equal(normalizeTxHash(undefined), '')
  assert.equal(normalizeTxHash(''), '')
})

test('isTransparentReceive only matches transparent receives', () => {
  assert.equal(isTransparentReceive(tx({ type: 'receive', fromType: 'transparent' })), true)
  assert.equal(isTransparentReceive(tx({ type: 'receive', fromType: 'shielded' })), false)
  assert.equal(isTransparentReceive(tx({ type: 'send', fromType: 'transparent' })), false)
})

test('isMultiStepZcashSend requires an ordered Zcash funding and payment chain', () => {
  const multiStep = tx({
    txHash: 'PAYMENT_HASH',
    chainHashes: [
      { chain: 'Zcash', hash: 'FUNDING_HASH' },
      { chain: 'zcash', hash: 'payment_hash' }
    ]
  })

  assert.equal(isMultiStepZcashSend(multiStep), true)
  assert.equal(isMultiStepZcashSend({ ...multiStep, type: 'receive' }), false)
  assert.equal(
    isMultiStepZcashSend({
      ...multiStep,
      chainHashes: [...multiStep.chainHashes, { chain: 'Near', hash: 'near_hash' }]
    }),
    false
  )
  assert.equal(isMultiStepZcashSend({ ...multiStep, txHash: 'different_hash' }), false)
})

test('localTxHashSet collects lowercased hashes of local records only', () => {
  const set = localTxHashSet([
    tx({ id: 'tx_a', txHash: 'HASH1', type: 'swap' }),
    tx({ id: 'tx_b', txHash: '  hash2 ' }),
    tx({ id: 'wasm_HASH1', txHash: 'HASH1', type: 'send' }),
    tx({ id: 'tx_empty', txHash: '   ' })
  ])
  assert.deepEqual([...set].sort(), ['hash1', 'hash2'])
})

test('localTxHashSet includes Zcash multi-step hashes but ignores other chains', () => {
  const set = localTxHashSet([
    tx({
      id: 'tx_tex',
      txHash: 'PAYMENT_HASH',
      chainHashes: [
        { chain: ' Zcash ', hash: ' FUNDING_HASH ' },
        { chain: 'Zcash', hash: 'PAYMENT_HASH' },
        { chain: 'Near', hash: 'NEAR_HASH' }
      ]
    })
  ])

  assert.deepEqual([...set].sort(), ['funding_hash', 'payment_hash'])
})

test('isDuplicateWasmRow drops a wasm send that matches a local record', () => {
  const local = localTxHashSet([tx({ id: 'tx_swap', txHash: 'HASH1', type: 'swap' })])
  assert.equal(
    isDuplicateWasmRow(tx({ id: 'wasm_hash1', txHash: 'hash1', type: 'send' }), local),
    true
  )
})

test('isDuplicateWasmRow matches regardless of hash casing', () => {
  const local = localTxHashSet([tx({ id: 'tx_swap', txHash: 'hash1', type: 'swap' })])
  assert.equal(
    isDuplicateWasmRow(tx({ id: 'wasm_HASH1', txHash: 'HASH1', type: 'send' }), local),
    true
  )
})

test('isDuplicateWasmRow keeps a wasm send with no local counterpart', () => {
  const local = localTxHashSet([tx({ id: 'tx_swap', txHash: 'hash1', type: 'swap' })])
  assert.equal(
    isDuplicateWasmRow(tx({ id: 'wasm_other', txHash: 'other', type: 'send' }), local),
    false
  )
})

test('isDuplicateWasmRow never drops a local (non-wasm) record', () => {
  const local = localTxHashSet([tx({ id: 'tx_swap', txHash: 'hash1', type: 'swap' })])
  assert.equal(
    isDuplicateWasmRow(tx({ id: 'tx_swap', txHash: 'hash1', type: 'swap' }), local),
    false
  )
})

test('isDuplicateWasmRow never drops a transparent receive', () => {
  const local = localTxHashSet([tx({ id: 'tx_recv', txHash: 'hash1', type: 'receive' })])
  const wasmReceive = tx({
    id: 'wasm_hash1',
    txHash: 'hash1',
    type: 'receive',
    fromType: 'transparent'
  })
  assert.equal(isDuplicateWasmRow(wasmReceive, local), false)
})

test('scenario: persisted wasm send self-heals once local swap has the hash', () => {
  const existing = [
    tx({ id: 'tx_swap', txHash: 'HASH1', type: 'swap' }),
    tx({ id: 'wasm_hash1', txHash: 'hash1', type: 'send' })
  ]
  const local = localTxHashSet(existing)
  const preserved = existing.filter(t => !isDuplicateWasmRow(t, local))
  assert.deepEqual(
    preserved.map(t => t.id),
    ['tx_swap']
  )
})

test('scenario: empty local hash does not falsely dedup a wasm send', () => {
  const existing = [
    tx({ id: 'tx_swap', txHash: '', type: 'swap' }),
    tx({ id: 'wasm_hash1', txHash: 'hash1', type: 'send' })
  ]
  const local = localTxHashSet(existing)
  const preserved = existing.filter(t => !isDuplicateWasmRow(t, local))
  assert.deepEqual(
    preserved.map(t => t.id),
    ['tx_swap', 'wasm_hash1']
  )
})
