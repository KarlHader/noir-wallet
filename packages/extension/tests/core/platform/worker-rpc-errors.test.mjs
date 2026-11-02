import { test } from 'node:test'
import { expect } from '@playwright/test'
import { TimeoutError } from '../../../src/lib/async-utils.ts'
import { encodeWorkerRpcError, decodeWorkerRpcError } from '../../../src/core/worker/rpc-errors.ts'

test('preserves an unknown transaction timeout across both JSON message hops', () => {
  const offscreenResponse = JSON.parse(
    JSON.stringify(encodeWorkerRpcError(new TimeoutError('Broadcast outcome unknown')))
  )
  const backgroundError = decodeWorkerRpcError(offscreenResponse)
  const popupResponse = JSON.parse(JSON.stringify(encodeWorkerRpcError(backgroundError)))
  const popupError = decodeWorkerRpcError(popupResponse)
  expect(popupError).toBeInstanceOf(TimeoutError)
  expect(popupError.message).toBe('Broadcast outcome unknown')
})

test('keeps definite errors separate from unknown timeout outcomes', () => {
  const error = decodeWorkerRpcError(
    JSON.parse(JSON.stringify(encodeWorkerRpcError(new Error('User rejected signing'))))
  )
  expect(error).not.toBeInstanceOf(TimeoutError)
  expect(error.message).toBe('User rejected signing')
})
