import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  mapPearlWalletRuntimeError,
  pearlPrepareFailureMessage
} from '../../../../src/background/pearl-wallet-runtime-error.ts'
import { KeyringError } from '../../../../src/core/keyring/protocol/errors.ts'
import {
  PearlRpcError,
  PearlTransactionBuildError
} from '../../../../src/infrastructure/chains/pearl/index.ts'

test('maps Pearl failures to stable errors without leaking details', () => {
  expect(
    mapPearlWalletRuntimeError(new PearlTransactionBuildError('invalid-intent', 'recipient'))
  ).toEqual({ code: 'invalid-request', message: 'The Pearl wallet request is invalid' })
  expect(
    mapPearlWalletRuntimeError(
      new PearlTransactionBuildError('insufficient-funds', 'exact balance')
    )
  ).toEqual({ code: 'insufficient-funds', message: 'The Pearl balance is insufficient' })
  expect(mapPearlWalletRuntimeError(new PearlRpcError('rate-limited', 'private URL'))).toEqual({
    code: 'network-unavailable',
    message: 'The Pearl network is unavailable'
  })
  expect(mapPearlWalletRuntimeError(new PearlRpcError('chain-mismatch', 'private URL'))).toEqual({
    code: 'network-unavailable',
    message: 'The Pearl network is unavailable'
  })
  expect(
    mapPearlWalletRuntimeError(new Error('The active Account has no Pearl ChainAccount'))
  ).toEqual({
    code: 'account-unavailable',
    message: 'The active Account has no Pearl account'
  })
  expect(mapPearlWalletRuntimeError(new Error('Pearl signing request expired'))).toEqual({
    code: 'expired',
    message: 'The Pearl signing request expired'
  })
  expect(mapPearlWalletRuntimeError(new Error('sensitive implementation detail'))).toEqual({
    code: 'request-failed',
    message: 'The Pearl wallet request failed'
  })
})

test('surfaces sanitized Pearl prepare failure details for diagnosis', () => {
  const mapped = mapPearlWalletRuntimeError(new Error('sensitive implementation detail'))
  expect(
    pearlPrepareFailureMessage(
      new Error('Pearl signing summary does not match the prepared PSBT'),
      mapped
    )
  ).toBe('Pearl signing summary does not match the prepared PSBT')
  expect(pearlPrepareFailureMessage(new KeyringError('UNSUPPORTED_PAYLOAD'), mapped)).toBe(
    'The signing payload is not supported.'
  )
  const detailed = new KeyringError('UNSUPPORTED_PAYLOAD')
  Object.defineProperty(detailed, 'detail', {
    value: 'invalid Pearl PSBT: PSBT does not contain an input owned by the selected account'
  })
  expect(pearlPrepareFailureMessage(detailed, mapped)).toBe(
    'invalid Pearl PSBT: PSBT does not contain an input owned by the selected account'
  )
  expect(
    pearlPrepareFailureMessage(
      { name: 'KeyringError', message: 'The keyring response is invalid.', code: 'INVALID_RESPONSE' },
      mapped
    )
  ).toBe('The keyring response is invalid.')
  expect(
    pearlPrepareFailureMessage(
      new Error('Pearl signer tprl1pmw509tys3kulusq5an6sy687evtmjd45hehluh9knn46n2v2gdpscgc7mf'),
      mapped
    )
  ).toBe('Pearl signer [address]')
  expect(pearlPrepareFailureMessage(new Error('sensitive implementation detail'), mapped)).toBe(
    'sensitive implementation detail'
  )
})
