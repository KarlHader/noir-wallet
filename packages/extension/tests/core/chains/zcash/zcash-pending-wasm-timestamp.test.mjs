import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeTransactionsWithWasmHistory } from '../../../../src/core/wallet/transparent-history.ts'

function pendingWasmTransaction(timestamp = 0) {
  return {
    id: `wasm_${'a'.repeat(64)}`,
    txHash: 'a'.repeat(64),
    type: 'receive',
    status: 'pending',
    amount: '1',
    to: '',
    from: '',
    fromType: 'shielded',
    timestamp,
    network: 'mainnet'
  }
}

test('a pending WASM transaction keeps its first-seen time across history refreshes', () => {
  const first = mergeTransactionsWithWasmHistory([], [pendingWasmTransaction()], [])
  const firstSeen = first.transactions[0].timestamp
  assert.ok(firstSeen > 0)

  const refreshed = mergeTransactionsWithWasmHistory(
    first.transactions,
    [pendingWasmTransaction()],
    []
  )
  assert.equal(refreshed.transactions.length, 1)
  assert.equal(refreshed.transactions[0].timestamp, firstSeen)

  const mined = mergeTransactionsWithWasmHistory(
    refreshed.transactions,
    [{ ...pendingWasmTransaction(123_000), status: 'success' }],
    []
  )
  assert.equal(mined.transactions[0].timestamp, 123_000)
})
