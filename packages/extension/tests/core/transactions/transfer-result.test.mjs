import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseTransferEstimate,
  parseTransferResult,
  requireSuccessfulTransfer
} from '../../../src/core/zcash/transfer-result.ts'

describe('unified transfer results', () => {
  it('accepts a multi-step estimate and returns its total fee', () => {
    const estimate = parseTransferEstimate({
      amountZats: '50000',
      feeZats: '25000',
      marginalFeeZats: '5000',
      transactionCount: 2,
      stepFeesZats: ['15000', '10000']
    })

    assert.equal(estimate.feeZats, '25000')
    assert.throws(
      () =>
        parseTransferEstimate({
          amountZats: '50000',
          feeZats: '15000',
          marginalFeeZats: '5000',
          transactionCount: 2,
          stepFeesZats: ['15000', '10000']
        }),
      /fee total/
    )
  })

  it('rejects a WASM estimate that changes the confirmed marginal fee', () => {
    const estimate = {
      amountZats: '10000',
      feeZats: '2000',
      marginalFeeZats: '1000',
      transactionCount: 1,
      stepFeesZats: ['2000']
    }
    assert.equal(parseTransferEstimate(estimate, 1000).marginalFeeZats, '1000')
    assert.throws(() => parseTransferEstimate(estimate, 4000), /confirmed network fee/)
    assert.throws(
      () => parseTransferEstimate({ ...estimate, marginalFeeZats: '0' }),
      /Invalid transfer estimate/
    )
  })

  it('uses the final transaction while retaining all submitted hashes', () => {
    const result = parseTransferResult({
      status: 'success',
      txIds: ['shield-tx', 'payment-tx'],
      finalTxId: 'payment-tx',
      transactions: [
        { txId: 'shield-tx', status: 'submitted' },
        { txId: 'payment-tx', status: 'submitted' }
      ]
    })

    const successful = requireSuccessfulTransfer(result)
    assert.equal(successful.txHash, 'payment-tx')
    assert.deepEqual(Array.from(successful.txHashes), ['shield-tx', 'payment-tx'])
  })

  it('rejects partial submission without inviting an immediate retry', () => {
    const result = parseTransferResult({
      status: 'partial',
      txIds: ['shield-tx', 'payment-tx'],
      finalTxId: 'payment-tx',
      transactions: [
        { txId: 'shield-tx', status: 'submitted' },
        {
          txId: 'payment-tx',
          status: 'rejected',
          errorCode: -26,
          errorMessage: 'payment rejected'
        }
      ]
    })

    assert.throws(
      () => requireSuccessfulTransfer(result),
      /Wait for wallet sync before retrying.*shield-tx/
    )
  })
})
