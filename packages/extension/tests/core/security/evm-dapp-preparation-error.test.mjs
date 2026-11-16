import assert from 'node:assert/strict'
import test from 'node:test'
import { mapEvmTransactionPreparationError } from '../../../src/background/evm-dapp-handler.ts'
import { toEip1193ErrorShape } from '../../../src/core/dapp/eip1193.ts'
import { EvmTransactionError } from '../../../src/infrastructure/chains/evm/evm-transaction-builder.ts'

test('known insufficient funds remains actionable at the EVM provider boundary', () => {
  const failure = new EvmTransactionError('insufficient-funds', 'internal balance detail')
  assert.deepEqual(toEip1193ErrorShape(mapEvmTransactionPreparationError(failure)), {
    code: -32000,
    message: 'Insufficient funds for the transaction and network fee.'
  })
})

test('other preparation errors retain the generic provider response', () => {
  for (const failure of [
    new EvmTransactionError('simulation-failed', 'internal simulation detail'),
    new Error('internal error')
  ]) {
    assert.equal(mapEvmTransactionPreparationError(failure), failure)
    assert.deepEqual(toEip1193ErrorShape(failure), {
      code: -32603,
      message: 'Noir Wallet could not complete the request.'
    })
  }
})
