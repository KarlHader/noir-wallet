import { test } from 'node:test'
import { expect } from '@playwright/test'

import { parseChainId } from '../../../../src/core/chains/registry/index.ts'
import {
  BitcoinTransactionBuildError,
  collectBitcoinSpendableUtxos,
  selectBitcoinCoins,
  selectBitcoinFeeRate
} from '../../../../src/infrastructure/chains/bitcoin/index.ts'

const MAINNET = parseChainId('bip122:000000000019d6689c085ae165831e93').id
const RECEIVE_ADDRESS = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
const TAPROOT_ADDRESS = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr'
const PUBLIC_KEY = `0x02${'1'.repeat(64)}`

function observation(utxos, overrides = {}) {
  return {
    derived: {
      chainId: MAINNET,
      addressType: 'p2wpkh',
      accountIndex: 0,
      change: false,
      addressIndex: 0,
      address: RECEIVE_ADDRESS,
      addressScheme: 'bitcoin-p2wpkh',
      derivationScheme: 'bip84',
      derivationPath: "m/84'/0'/0'/0/0",
      publicKey: PUBLIC_KEY,
      ...overrides
    },
    activity: {
      confirmedTransactionCount: 1,
      mempoolTransactionCount: 0,
      used: true
    },
    utxos
  }
}

function discoveredUtxo(transactionDigit, valueRaw, status = { confirmed: true, blockHeight: 1 }) {
  return {
    transactionId: transactionDigit.repeat(64),
    outputIndex: 0,
    valueRaw,
    status
  }
}

function spendable(transactionDigit, valueSats, overrides = {}) {
  return {
    chainId: MAINNET,
    addressType: 'p2wpkh',
    accountIndex: 0,
    change: false,
    addressIndex: 0,
    address: RECEIVE_ADDRESS,
    derivationPath: "m/84'/0'/0'/0/0",
    publicKey: PUBLIC_KEY,
    transactionId: transactionDigit.repeat(64),
    outputIndex: 0,
    valueSats,
    blockHeight: 1,
    ...overrides
  }
}

test('selects a conservative available Bitcoin fee target and rounds up fractional rates', () => {
  expect(selectBitcoinFeeRate({ 1: 4.2, 3: 3.1, 12: 1.1 }, 6)).toEqual({
    requestedTargetBlocks: 6,
    sourceTargetBlocks: 3,
    satsPerVbyte: 4
  })
  expect(selectBitcoinFeeRate({ 12: 1.1 }, 6)).toEqual({
    requestedTargetBlocks: 6,
    sourceTargetBlocks: 12,
    satsPerVbyte: 2
  })
  expect(() => selectBitcoinFeeRate({})).toThrow(
    expect.objectContaining({ code: 'fee-estimate-unavailable' })
  )
  expect(() => selectBitcoinFeeRate({ 1: 10_001 })).toThrow(
    expect.objectContaining({ code: 'invalid-intent' })
  )
})

test('collects confirmed UTXOs only from the active address in deterministic order', () => {
  const p2tr = observation([discoveredUtxo('d', '90000')], {
    addressType: 'p2tr',
    address: TAPROOT_ADDRESS,
    addressScheme: 'bitcoin-p2tr',
    derivationScheme: 'bip86',
    derivationPath: "m/86'/0'/0'/0/0"
  })
  const selected = collectBitcoinSpendableUtxos(
    [
      observation([
        discoveredUtxo('a', '50000'),
        discoveredUtxo('b', '100000'),
        discoveredUtxo('c', '200000', { confirmed: false })
      ]),
      observation([discoveredUtxo('e', '80000')], {
        addressIndex: 3,
        derivationPath: "m/84'/0'/0'/0/3"
      }),
      observation([discoveredUtxo('f', '70000')], {
        change: true,
        addressIndex: 0,
        derivationPath: "m/84'/0'/0'/1/0"
      }),
      p2tr
    ],
    'p2wpkh'
  )

  expect(selected.map(utxo => utxo.valueSats)).toEqual(['100000', '50000'])
  expect(selected.every(utxo => utxo.addressType === 'p2wpkh')).toBe(true)
  expect(Object.isFrozen(selected)).toBe(true)
  expect(Object.isFrozen(selected[0])).toBe(true)
  expect(collectBitcoinSpendableUtxos([p2tr], 'p2tr')).toMatchObject([
    { addressType: 'p2tr', valueSats: '90000', derivationPath: "m/86'/0'/0'/0/0" }
  ])
})

test('rejects duplicate confirmed outpoints instead of double-counting Bitcoin funds', () => {
  const duplicate = discoveredUtxo('a', '50000')
  expect(() =>
    collectBitcoinSpendableUtxos([observation([duplicate]), observation([duplicate])], 'p2wpkh')
  ).toThrow(expect.objectContaining({ code: 'invalid-intent' }))
})

test('prefers the smallest sufficient single UTXO and creates BIP-84 change', () => {
  const selection = selectBitcoinCoins({
    chainId: MAINNET,
    accountIndex: 0,
    addressType: 'p2wpkh',
    recipient: RECEIVE_ADDRESS,
    amount: { mode: 'exact', valueSats: '50000' },
    feeRateSatsPerVbyte: 2,
    utxos: [spendable('a', '100000'), spendable('b', '60000'), spendable('c', '40000')]
  })

  expect(selection).toMatchObject({
    selectedTotalSats: '60000',
    amountSats: '50000',
    feeSats: '284',
    changeSats: '9716',
    estimatedVbytes: 142
  })
  expect(selection.selectedUtxos.map(utxo => utxo.transactionId)).toEqual(['b'.repeat(64)])
})

test('folds sub-dust change into the fee and combines inputs only when one is insufficient', () => {
  const withoutChange = selectBitcoinCoins({
    chainId: MAINNET,
    accountIndex: 0,
    addressType: 'p2wpkh',
    recipient: RECEIVE_ADDRESS,
    amount: { mode: 'exact', valueSats: '50000' },
    feeRateSatsPerVbyte: 2,
    utxos: [spendable('a', '50500')]
  })
  expect(withoutChange).toMatchObject({
    feeSats: '500',
    changeSats: '0',
    estimatedVbytes: 111
  })

  const combined = selectBitcoinCoins({
    chainId: MAINNET,
    accountIndex: 0,
    addressType: 'p2wpkh',
    recipient: RECEIVE_ADDRESS,
    amount: { mode: 'exact', valueSats: '50000' },
    feeRateSatsPerVbyte: 2,
    utxos: [spendable('b', '30000'), spendable('c', '25000')]
  })
  expect(combined).toMatchObject({
    selectedTotalSats: '55000',
    feeSats: '422',
    changeSats: '4578',
    estimatedVbytes: 211
  })
})

test('spends the selected address-type balance without change for Max', () => {
  const selection = selectBitcoinCoins({
    chainId: MAINNET,
    accountIndex: 0,
    addressType: 'p2wpkh',
    recipient: TAPROOT_ADDRESS,
    amount: { mode: 'max' },
    feeRateSatsPerVbyte: 2,
    utxos: [spendable('a', '100000'), spendable('b', '50000')]
  })

  expect(selection).toMatchObject({
    recipientAddressType: 'p2tr',
    selectedTotalSats: '150000',
    amountSats: '149616',
    feeSats: '384',
    changeSats: '0',
    estimatedVbytes: 192
  })

  const taprootSelection = selectBitcoinCoins({
    chainId: MAINNET,
    accountIndex: 0,
    addressType: 'p2tr',
    recipient: RECEIVE_ADDRESS,
    amount: { mode: 'max' },
    feeRateSatsPerVbyte: 2,
    utxos: [
      spendable('c', '100000', {
        addressType: 'p2tr',
        address: TAPROOT_ADDRESS,
        derivationPath: "m/86'/0'/0'/0/0"
      })
    ]
  })
  expect(taprootSelection).toMatchObject({
    addressType: 'p2tr',
    amountSats: '99798',
    feeSats: '202',
    estimatedVbytes: 101
  })
})

test('fails closed for dust, insufficient funds, account mixing, and duplicate inputs', () => {
  const base = {
    chainId: MAINNET,
    accountIndex: 0,
    addressType: 'p2wpkh',
    recipient: RECEIVE_ADDRESS,
    feeRateSatsPerVbyte: 2
  }
  const capture = callback => {
    try {
      callback()
      return null
    } catch (error) {
      return error
    }
  }

  expect(
    capture(() =>
      selectBitcoinCoins({
        ...base,
        amount: { mode: 'exact', valueSats: '293' },
        utxos: [spendable('a', '100000')]
      })
    )
  ).toMatchObject({ code: 'invalid-intent' })
  expect(
    capture(() =>
      selectBitcoinCoins({
        ...base,
        amount: { mode: 'max' },
        utxos: [spendable('a', '100000')],
        unexpected: true
      })
    )
  ).toMatchObject({ code: 'invalid-intent' })
  expect(
    capture(() =>
      selectBitcoinCoins({
        ...base,
        amount: { mode: 'exact', valueSats: '100000' },
        utxos: [spendable('a', '100000')]
      })
    )
  ).toMatchObject({ code: 'insufficient-funds' })
  expect(
    capture(() =>
      selectBitcoinCoins({
        ...base,
        amount: null,
        utxos: [spendable('a', '100000')]
      })
    )
  ).toMatchObject({ code: 'invalid-intent' })
  expect(
    capture(() =>
      selectBitcoinCoins({
        ...base,
        amount: { mode: 'max' },
        utxos: [spendable('a', '100000', { accountIndex: 1 })]
      })
    )
  ).toMatchObject({ code: 'invalid-intent' })
  const duplicate = spendable('a', '100000')
  const duplicateError = capture(() =>
    selectBitcoinCoins({
      ...base,
      amount: { mode: 'max' },
      utxos: [duplicate, duplicate]
    })
  )
  expect(duplicateError).toBeInstanceOf(BitcoinTransactionBuildError)
  expect(duplicateError).toMatchObject({ code: 'invalid-intent' })
  expect(
    capture(() =>
      selectBitcoinCoins({
        ...base,
        amount: { mode: 'max' },
        utxos: [{ ...duplicate, unexpected: true }]
      })
    )
  ).toMatchObject({ code: 'invalid-intent' })
})
