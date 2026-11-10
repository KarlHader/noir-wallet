import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  parsePearlChainRequest,
  parsePearlMessageRequest,
  parsePearlNetworkRequest,
  parsePearlPsbtsRequest,
  parsePearlPsbtRequest,
  parsePearlPushTransactionRequest,
  parsePearlSendRequest
} from '../../../../src/core/dapp/pearl-provider.ts'

test.describe('Pearl dApp provider policy', () => {
  test('accepts exact integer-satoshi sends and bounded fee rates', () => {
    expect(parsePearlSendRequest(['prl1recipient', 1000])).toEqual({
      intent: {
        recipient: 'prl1recipient',
        amount: { mode: 'exact', valueSats: '1000' }
      }
    })
    expect(parsePearlSendRequest(['prl1recipient', 1000, { feeRate: 2 }])).toMatchObject({
      feeRateSatsPerVbyte: 2
    })
    expect(() => parsePearlSendRequest(['prl1recipient', 1000, { feeRate: 0 }])).toThrow(/feeRate/)
    expect(() => parsePearlSendRequest(['prl1recipient', 0])).toThrow(/positive safe integer/)
    expect(() => parsePearlSendRequest(['prl1recipient', 329])).toThrow(/at least 330/)
  })

  test('defaults Noir message signing to BIP-322 and rejects legacy ECDSA', () => {
    expect(parsePearlMessageRequest(['hello'])).toMatchObject({ displayMessage: 'hello' })
    expect(parsePearlMessageRequest(['hello']).message).toEqual(new TextEncoder().encode('hello'))
    expect(() => parsePearlMessageRequest(['hello', 'ecdsa'])).toThrow(/BIP-322/)
  })

  test('accepts bounded PSBT hex and standard auto-finalization options', () => {
    expect(parsePearlPsbtRequest(['70736274ff00'])).toEqual({
      psbtHex: '70736274ff00',
      autoFinalized: true
    })
    expect(parsePearlPsbtRequest(['70736274FF00', { autoFinalized: false }])).toEqual({
      psbtHex: '70736274ff00',
      autoFinalized: false
    })
    expect(parsePearlPsbtsRequest([['70736274ff00'], [{ autoFinalized: false }]])).toEqual([
      { psbtHex: '70736274ff00', autoFinalized: false }
    ])
    expect(() => parsePearlPsbtsRequest([['70736274ff00'], []])).toThrow(/match/)
    expect(() => parsePearlPsbtRequest(['00'])).toThrow(/canonical hexadecimal/)
  })

  test('parses fixed-network requests only', () => {
    expect(parsePearlNetworkRequest(['mainnet'])).toBe('mainnet')
    expect(parsePearlChainRequest([{ enum: 'PEARL_TESTNET' }])).toBe('PEARL_TESTNET')
    expect(() => parsePearlNetworkRequest(['signet'])).toThrow(/mainnet or testnet/)
    expect(() => parsePearlChainRequest([{ enum: 'PEARL_MAINNET', name: 'extra' }])).toThrow(
      /chain enum/
    )
  })

  test('accepts only a bounded raw transaction object for pushTx', () => {
    expect(parsePearlPushTransactionRequest([{ rawtx: '00'.repeat(10) }])).toBe('00'.repeat(10))
    expect(() =>
      parsePearlPushTransactionRequest([{ rawtx: '00'.repeat(10), network: 'mainnet' }])
    ).toThrow(/only/)
    expect(() => parsePearlPushTransactionRequest([{ rawtx: 'xyz' }])).toThrow(/hexadecimal/)
  })
})
