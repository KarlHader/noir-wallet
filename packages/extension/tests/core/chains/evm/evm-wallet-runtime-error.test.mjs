import { test } from 'node:test'
import { expect } from '@playwright/test'

import { mapEvmWalletRuntimeError } from '../../../../src/background/evm-wallet-runtime-error.ts'
import {
  EvmRpcError,
  EvmTransactionError
} from '../../../../src/infrastructure/chains/evm/index.ts'

test.describe('EVM wallet runtime error mapping', () => {
  test('maps typed and known lifecycle failures to stable non-sensitive errors', () => {
    expect(
      mapEvmWalletRuntimeError(new EvmTransactionError('invalid-intent', 'raw detail'))
    ).toEqual({
      code: 'invalid-request',
      message: 'The EVM wallet request is invalid'
    })
    expect(
      mapEvmWalletRuntimeError(new EvmTransactionError('insufficient-funds', 'raw detail'))
    ).toEqual({
      code: 'insufficient-funds',
      message: 'The EVM balance is insufficient'
    })
    expect(
      mapEvmWalletRuntimeError(
        new EvmTransactionError('insufficient-funds', 'private balance detail', {
          requiredNativeBalanceRaw: '1043863666000',
          availableNativeBalanceRaw: '1000000000000',
          shortfallRaw: '43863666000',
          maximumGasCostRaw: '200000000000',
          transactionValueRaw: '843863666000'
        })
      )
    ).toEqual({
      code: 'insufficient-funds',
      message: 'The EVM balance is insufficient',
      shortfallRaw: '43863666000'
    })
    expect(
      mapEvmWalletRuntimeError(
        new EvmTransactionError('simulation-failed', 'private revert detail')
      )
    ).toEqual({
      code: 'simulation-failed',
      message: 'The EVM transaction failed simulation'
    })
    expect(mapEvmWalletRuntimeError(new EvmRpcError('timeout', 'secret endpoint detail'))).toEqual({
      code: 'network-unavailable',
      message: 'The EVM network is unavailable'
    })
    expect(
      mapEvmWalletRuntimeError(new Error('The active Account has no EVM ChainAccount'))
    ).toEqual({
      code: 'account-unavailable',
      message: 'The active Account has no EVM account'
    })
    expect(mapEvmWalletRuntimeError(new Error('EVM signing request expired'))).toEqual({
      code: 'expired',
      message: 'The EVM signing request expired'
    })
    expect(
      mapEvmWalletRuntimeError(
        new Error('Wallet locked and no attested credential session is available')
      )
    ).toEqual({
      code: 'wallet-locked',
      message: 'Wallet is locked'
    })
  })

  test('does not expose unknown internal failures', () => {
    expect(mapEvmWalletRuntimeError(new Error('private RPC response body'))).toEqual({
      code: 'request-failed',
      message: 'The EVM wallet request failed'
    })
    expect(mapEvmWalletRuntimeError('not-an-error')).toEqual({
      code: 'request-failed',
      message: 'The EVM wallet request failed'
    })
  })
})
