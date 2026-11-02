import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  getFundingBalance,
  getFundingAmountError
} from '../../../../src/core/wallet/funding-balance.ts'
import {
  getFundingSourceOptions,
  getFundingSourceUnavailableReason
} from '../../../../src/core/wallet/funding-source.ts'
import {
  resolveZcashFundingAvailability,
  resolveZcashTransferAvailability
} from '../../../../src/popup/services/transfer-availability.ts'

const balance = {
  shielded: '2',
  transparent: '3',
  spendable: '1',
  available: '0.9996',
  confirmed: { shielded: '1', transparent: '2.5' },
  pending: { shielded: '0.5', transparent: '0.5', total: '1' }
}

describe('Zcash funding amount validation', () => {
  test('offers confirmed balances for both sources while keeping Keystone transparent funding disabled', () => {
    const addresses = { shielded: 'u1test', transparent: 't1test' }
    const options = getFundingSourceOptions(balance, addresses, 'software')
    assert.deepEqual(
      options.map(({ type, available, pending, disabledReason }) => ({
        type,
        available,
        pending,
        disabledReason
      })),
      [
        { type: 'shielded', available: '1', pending: '0.5', disabledReason: undefined },
        { type: 'transparent', available: '2.5', pending: '0.5', disabledReason: undefined }
      ]
    )
    assert.equal(getFundingSourceUnavailableReason('ledger', 'transparent'), undefined)
    assert.equal(getFundingSourceUnavailableReason('keystone', 'shielded'), undefined)
    assert.ok(getFundingSourceOptions(balance, addresses, 'keystone')[1].disabledReason)
    assert.ok(
      getFundingSourceOptions(balance, { shielded: 'u1test' }, 'software')[1].disabledReason
    )
  })

  test('reserves the full fee for transparent funds and uses the destination-specific Max when ready', () => {
    const transparent = getFundingBalance(balance, 'transparent')
    const estimate = {
      availableBalance: transparent.available,
      selectedFeeZats: 60000,
      standardFeeZats: 15000,
      feeAlreadyReservedZats: 0
    }
    const fallback = resolveZcashTransferAvailability(estimate)
    assert.equal(fallback.amount, '2.4994')
    assert.equal(getFundingAmountError('2.5', transparent, fallback.amount), 'fee')
    assert.equal(getFundingAmountError('2.6', transparent, fallback.amount), 'pending')
    assert.equal(
      resolveZcashTransferAvailability({ ...estimate, maximumAmount: '2.4988' }).amount,
      '2.4988'
    )
    assert.equal(
      resolveZcashTransferAvailability({ ...estimate, availableBalance: '0.0001' }).amount,
      '0'
    )
    assert.equal(
      resolveZcashTransferAvailability({
        availableBalance: balance.available,
        selectedFeeZats: 60000,
        standardFeeZats: 15000
      }).amount,
      '0.99915'
    )
  })

  test('Send and Swap Max fallbacks use only the selected confirmed pool and reserve the fee once', () => {
    const mixed = { ...balance, available: '3.49985' }
    const estimate = { balance: mixed, selectedFeeZats: 60000, standardFeeZats: 15000 }
    const shielded = resolveZcashFundingAvailability({ ...estimate, fundingSource: 'shielded' })
    const transparent = resolveZcashFundingAvailability({
      ...estimate,
      fundingSource: 'transparent'
    })
    assert.deepEqual(shielded, { amount: '0.9994', fallbackAmount: '0.9994' })
    assert.deepEqual(transparent, { amount: '2.4994', fallbackAmount: '2.4994' })
    assert.equal(getFundingAmountError(shielded.amount, getFundingBalance(mixed, 'shielded')), null)
    assert.equal(
      resolveZcashFundingAvailability({
        ...estimate,
        fundingSource: 'shielded',
        maximumAmount: '0.9988'
      }).amount,
      '0.9988'
    )
    assert.equal(
      resolveZcashFundingAvailability({
        ...estimate,
        fundingSource: 'transparent',
        maximumAmount: '2.4988'
      }).amount,
      '2.4988'
    )
    assert.equal(
      resolveZcashFundingAvailability({ ...estimate, balance: null, fundingSource: 'shielded' })
        .amount,
      '0'
    )
  })

  test('accepts only selectable funds from the selected source', () => {
    const shielded = getFundingBalance(balance, 'shielded')
    const transparent = getFundingBalance(balance, 'transparent')
    assert.equal(getFundingAmountError('1', shielded), null)
    assert.equal(getFundingAmountError('1.00000001', shielded), 'pending')
    assert.equal(getFundingAmountError('1.5', shielded), 'pending')
    assert.equal(getFundingAmountError('1.50000001', shielded), 'insufficient')
    assert.equal(getFundingAmountError('2.5', transparent), null)
    assert.equal(getFundingAmountError('2.50000001', transparent), 'pending')
    assert.equal(getFundingAmountError('3.00000001', transparent), 'insufficient')
  })

  test('enforces destination-specific Max without reducing displayed Available', () => {
    const source = getFundingBalance(balance, 'shielded')
    assert.equal(getFundingAmountError('0.99985', source, '0.99985'), null)
    assert.equal(getFundingAmountError('0.99985001', source, '0.99985'), 'fee')
    assert.equal(getFundingAmountError('1', source, null), null)
    assert.equal(source.available, '1')
    assert.equal(balance.available, '0.9996')
  })

  test('does not permit pending funds when Max is newer than the available cache', () => {
    const source = getFundingBalance(balance, 'shielded')
    assert.equal(getFundingAmountError('1.2', source, '1.49985'), 'pending')
    assert.equal(getFundingAmountError('2', source, '1.99985'), 'insufficient')
  })

  test('does not classify other unavailable holdings as pending', () => {
    const source = getFundingBalance({ ...balance, pending: { shielded: '0' } }, 'shielded')
    assert.equal(getFundingAmountError('1.1', source), 'insufficient')
    assert.equal(
      getFundingAmountError('0.00000001', getFundingBalance(null, 'shielded')),
      'insufficient'
    )
    assert.equal(getFundingAmountError('', getFundingBalance(null, 'shielded')), null)
    assert.equal(getFundingAmountError('0.00000001', source, '0'), 'fee')
  })

  test('keeps legacy caches conservative until a fresh WASM summary arrives', () => {
    const legacy = {
      shielded: '20',
      transparent: '10',
      spendable: '1',
      shieldable: '0.1',
      available: '0.9996',
      pending: { shielded: '0.5', transparent: '0.2' }
    }
    assert.deepEqual(getFundingBalance(legacy, 'shielded'), { available: '0', pending: '0.5' })
    assert.deepEqual(getFundingBalance(legacy, 'transparent'), { available: '0', pending: '0.2' })
    assert.equal(getFundingAmountError('20', getFundingBalance(legacy, 'shielded')), 'insufficient')
    assert.equal(getFundingBalance({ shielded: '20' }, 'shielded').available, '0')
  })
})
