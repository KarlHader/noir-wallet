import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  formatBitcoinInputAddressType,
  isBitcoinBalanceKnown,
  isBitcoinSendAmountValid
} from '../../../../src/popup/pages/transactions/bitcoin-send-display'

function input(scriptType) {
  return { scriptType }
}

test.describe('Bitcoin Send display policy', () => {
  test('labels every released Bitcoin input type from the immutable signing summary', () => {
    expect(formatBitcoinInputAddressType([input('p2pkh')])).toBe('Legacy · BIP-44')
    expect(formatBitcoinInputAddressType([input('p2sh-p2wpkh')])).toBe('Nested SegWit · BIP-49')
    expect(formatBitcoinInputAddressType([input('p2wpkh')])).toBe('Native SegWit · BIP-84')
    expect(formatBitcoinInputAddressType([input('p2tr')])).toBe('Taproot · BIP-86')
  })

  test('does not mislabel empty or mixed-script summaries as BIP-84', () => {
    expect(formatBitcoinInputAddressType([])).toBe('Bitcoin')
    expect(formatBitcoinInputAddressType([input('p2wpkh'), input('p2pkh')])).toBe(
      'Mixed Bitcoin inputs'
    )
  })

  test('allows controller validation while the first Bitcoin balance scan is still loading', () => {
    expect(isBitcoinBalanceKnown(0)).toBe(false)
    expect(isBitcoinBalanceKnown(1)).toBe(true)
    expect(
      isBitcoinSendAmountValid({
        sendMaximum: false,
        amountRaw: '110000',
        availableRaw: '0',
        balanceKnown: false
      })
    ).toBe(true)
    expect(
      isBitcoinSendAmountValid({
        sendMaximum: false,
        amountRaw: '110000',
        availableRaw: '0',
        balanceKnown: true
      })
    ).toBe(false)
  })
})
