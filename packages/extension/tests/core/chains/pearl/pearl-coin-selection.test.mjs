import { test } from 'node:test'
import { expect } from '@playwright/test'

import { parseChainId } from '../../../../src/core/chains/registry/index.ts'
import {
  PearlTransactionBuildError,
  selectPearlCoins,
  selectPearlFeeRate
} from '../../../../src/infrastructure/chains/pearl/index.ts'
import { estimatePearlVbytes } from '../../../../src/infrastructure/chains/pearl/pearl-transaction-model.ts'

const MAINNET = parseChainId('bip122:a18d3093b7ff618f0cdd073fa3d10374').id
const RECEIVE_ADDRESS = 'prl1pqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'
const PUBLIC_KEY = `0x02${'1'.repeat(64)}`

function spendable(transactionDigit, valueSats, overrides = {}) {
  return {
    chainId: MAINNET,
    addressScheme: 'pearl_p2tr',
    accountIndex: 0,
    change: false,
    addressIndex: 0,
    address: RECEIVE_ADDRESS,
    derivationPath: "m/86'/808276'/0'/0/0",
    publicKey: PUBLIC_KEY,
    transactionId: transactionDigit.repeat(64),
    outputIndex: 0,
    valueSats,
    blockHeight: 1,
    ...overrides
  }
}

test('selects a conservative Pearl fee target and rounds up fractional rates', () => {
  expect(selectPearlFeeRate({ 1: 4.2, 3: 3.1, 12: 1.1 }, 6)).toEqual({
    requestedTargetBlocks: 6,
    sourceTargetBlocks: 3,
    satsPerVbyte: 4
  })
  expect(selectPearlFeeRate({ 12: 1.1 }, 6)).toEqual({
    requestedTargetBlocks: 6,
    sourceTargetBlocks: 12,
    satsPerVbyte: 2
  })
  expect(() => selectPearlFeeRate({})).toThrow(
    expect.objectContaining({ code: 'fee-estimate-unavailable' })
  )
})

test('selects Pearl coins for an exact amount and for max', () => {
  const utxos = [spendable('a', '100000'), spendable('b', '50000')]
  const exact = selectPearlCoins({
    chainId: MAINNET,
    accountIndex: 0,
    recipient: RECEIVE_ADDRESS,
    amount: { mode: 'exact', valueSats: '20000' },
    feeRateSatsPerVbyte: 2,
    utxos
  })
  expect(exact.amountSats).toBe('20000')
  expect(BigInt(exact.feeSats)).toBeGreaterThan(0n)
  expect(exact.selectedUtxos.length).toBe(1)

  const max = selectPearlCoins({
    chainId: MAINNET,
    accountIndex: 0,
    recipient: RECEIVE_ADDRESS,
    amount: { mode: 'max' },
    feeRateSatsPerVbyte: 2,
    utxos: [spendable('c', '25000')]
  })
  const expectedFee = estimatePearlVbytes(1, false) * 2n
  expect(max.amountSats).toBe((25000n - expectedFee).toString())
  expect(max.changeSats).toBe('0')
  expect(max.feeSats).toBe(expectedFee.toString())
})

test('rejects Pearl selections that cannot cover the fee', () => {
  expect(() =>
    selectPearlCoins({
      chainId: MAINNET,
      accountIndex: 0,
      recipient: RECEIVE_ADDRESS,
      amount: { mode: 'exact', valueSats: '20000' },
      feeRateSatsPerVbyte: 2,
      utxos: [spendable('d', '100')]
    })
  ).toThrow(PearlTransactionBuildError)
})
