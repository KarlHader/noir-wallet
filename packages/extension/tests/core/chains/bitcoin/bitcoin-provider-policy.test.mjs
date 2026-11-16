import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  parseBitcoinChainRequest,
  parseBitcoinMessageRequest,
  parseBitcoinNetworkRequest,
  parseBitcoinPsbtsRequest,
  parseBitcoinPsbtRequest,
  parseBitcoinPushTransactionRequest,
  parseBitcoinSendRequest
} from '../../../../src/core/dapp/bitcoin-provider.ts'

test.describe('Bitcoin dApp provider policy', () => {
  test('accepts exact integer-satoshi sends and bounded fee rates', () => {
    expect(parseBitcoinSendRequest(['bc1qrecipient', 42])).toEqual({
      intent: {
        recipient: 'bc1qrecipient',
        amount: { mode: 'exact', valueSats: '42' }
      }
    })
    expect(parseBitcoinSendRequest(['bc1qrecipient', 42, { feeRate: 2 }])).toMatchObject({
      feeRateSatsPerVbyte: 2
    })
    expect(() => parseBitcoinSendRequest(['bc1qrecipient', 42, { feeRate: 0 }])).toThrow(/feeRate/)
    expect(() => parseBitcoinSendRequest(['bc1qrecipient', 0])).toThrow(/positive safe integer/)
  })

  test('defaults Noir message signing to BIP-322 and rejects legacy ECDSA', () => {
    expect(parseBitcoinMessageRequest(['hello'])).toMatchObject({ displayMessage: 'hello' })
    expect(parseBitcoinMessageRequest(['hello']).message).toEqual(new TextEncoder().encode('hello'))
    expect(() => parseBitcoinMessageRequest(['hello', 'ecdsa'])).toThrow(/BIP-322/)
  })

  test('accepts bounded PSBT hex and standard auto-finalization options', () => {
    expect(parseBitcoinPsbtRequest(['70736274ff00'])).toEqual({
      psbtHex: '70736274ff00',
      autoFinalized: true
    })
    expect(parseBitcoinPsbtRequest(['70736274FF00', { autoFinalized: false }])).toEqual({
      psbtHex: '70736274ff00',
      autoFinalized: false
    })
    expect(parseBitcoinPsbtsRequest([['70736274ff00'], [{ autoFinalized: false }]])).toEqual([
      { psbtHex: '70736274ff00', autoFinalized: false }
    ])
    expect(() => parseBitcoinPsbtsRequest([['70736274ff00'], []])).toThrow(/match/)
    expect(() => parseBitcoinPsbtRequest(['00'])).toThrow(/canonical hexadecimal/)
  })

  test('parses fixed-network requests only', () => {
    expect(parseBitcoinNetworkRequest(['livenet'])).toBe('livenet')
    expect(parseBitcoinChainRequest([{ enum: 'BITCOIN_TESTNET' }])).toBe('BITCOIN_TESTNET')
    expect(() => parseBitcoinNetworkRequest(['signet'])).toThrow(/livenet or testnet/)
    expect(() => parseBitcoinChainRequest([{ enum: 'BITCOIN_MAINNET', name: 'extra' }])).toThrow(
      /chain enum/
    )
  })

  test('accepts only a bounded raw transaction object for pushTx', () => {
    expect(parseBitcoinPushTransactionRequest([{ rawtx: '00'.repeat(10) }])).toBe('00'.repeat(10))
    expect(() =>
      parseBitcoinPushTransactionRequest([{ rawtx: '00'.repeat(10), network: 'mainnet' }])
    ).toThrow(/only/)
    expect(() => parseBitcoinPushTransactionRequest([{ rawtx: 'xyz' }])).toThrow(/hexadecimal/)
  })
})
