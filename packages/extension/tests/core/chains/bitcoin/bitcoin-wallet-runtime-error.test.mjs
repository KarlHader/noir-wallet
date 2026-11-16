import { test } from 'node:test'
import { expect } from '@playwright/test'

import { mapBitcoinWalletRuntimeError } from '../../../../src/background/bitcoin-wallet-runtime-error.ts'
import {
  BitcoinRpcError,
  BitcoinTransactionBuildError
} from '../../../../src/infrastructure/chains/bitcoin/index.ts'

test('maps Bitcoin failures to stable errors without leaking details', () => {
  expect(
    mapBitcoinWalletRuntimeError(new BitcoinTransactionBuildError('invalid-intent', 'recipient'))
  ).toEqual({ code: 'invalid-request', message: 'The Bitcoin wallet request is invalid' })
  expect(
    mapBitcoinWalletRuntimeError(
      new BitcoinTransactionBuildError('insufficient-funds', 'exact balance')
    )
  ).toEqual({ code: 'insufficient-funds', message: 'The Bitcoin balance is insufficient' })
  expect(mapBitcoinWalletRuntimeError(new BitcoinRpcError('rate-limited', 'private URL'))).toEqual({
    code: 'network-unavailable',
    message: 'The Bitcoin network is unavailable'
  })
  expect(
    mapBitcoinWalletRuntimeError(new Error('The active Account has no Bitcoin ChainAccount'))
  ).toEqual({
    code: 'account-unavailable',
    message: 'The active Account has no Bitcoin account'
  })
  expect(mapBitcoinWalletRuntimeError(new Error('Bitcoin signing request expired'))).toEqual({
    code: 'expired',
    message: 'The Bitcoin signing request expired'
  })
  expect(mapBitcoinWalletRuntimeError(new Error('sensitive implementation detail'))).toEqual({
    code: 'request-failed',
    message: 'The Bitcoin wallet request failed'
  })
})
