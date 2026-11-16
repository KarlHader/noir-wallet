import { test } from 'node:test'
import { expect } from '@playwright/test'
import { TimeoutError } from '../../../src/lib/async-utils.ts'
import { encodeWorkerRpcError, decodeWorkerRpcError } from '../../../src/core/worker/rpc-errors.ts'
import { toHardwarePcztError } from '../../../src/core/zcash/hardware-pczt.ts'
import { TransactionSubmissionUnknownError } from '../../../src/core/zcash/transfer-result.ts'

test('preserves uncertain hardware submission outcomes across both JSON message hops', () => {
  for (const pending of [
    new TimeoutError('Broadcast outcome unknown'),
    new TransactionSubmissionUnknownError('synthetic-tx', 'Submission outcome unknown')
  ]) {
    expect(toHardwarePcztError('prove-send', pending)).toBe(pending)
    const offscreenResponse = JSON.parse(
      JSON.stringify(encodeWorkerRpcError(toHardwarePcztError('prove-send', pending)))
    )
    const backgroundError = decodeWorkerRpcError(offscreenResponse)
    const popupResponse = JSON.parse(JSON.stringify(encodeWorkerRpcError(backgroundError)))
    const popupError = decodeWorkerRpcError(popupResponse)
    expect(popupError).toBeInstanceOf(pending.constructor)
    expect(popupError.message).toBe(pending.message)
    if (pending instanceof TransactionSubmissionUnknownError)
      expect(popupError.txId).toBe(pending.txId)
  }
})

test('keeps definite errors separate from unknown timeout outcomes', () => {
  const error = decodeWorkerRpcError(
    JSON.parse(JSON.stringify(encodeWorkerRpcError(new Error('User rejected signing'))))
  )
  expect(error).not.toBeInstanceOf(TimeoutError)
  expect(error.message).toBe('User rejected signing')
})
