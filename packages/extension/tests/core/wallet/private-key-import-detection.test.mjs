import { test } from 'node:test'
import { expect } from '@playwright/test'

import { detectPrivateKeyImport } from '../../../src/core/keyring/application/private-key-import-detection.ts'

const HEX_KEY = '00'.repeat(31) + '01'

test.describe('private-key import detection', () => {
  test('detects Bitcoin compressed WIF without asking for a network', () => {
    expect(detectPrivateKeyImport('KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn')).toEqual({
      chainFamily: 'bip122',
      format: 'bitcoin-wif',
      ambiguous: false
    })
  })

  test('detects prefixed EVM hex and treats plain hex as an explicit EVM default', () => {
    expect(detectPrivateKeyImport(`0x${HEX_KEY}`)).toEqual({
      chainFamily: 'eip155',
      format: 'evm-prefixed-hex',
      ambiguous: false
    })
    expect(detectPrivateKeyImport(HEX_KEY)).toEqual({
      chainFamily: 'eip155',
      format: 'ambiguous-hex',
      ambiguous: true
    })
  })

  test('detects Solana JSON/Base58 and prefixed NEAR Ed25519 keys', () => {
    expect(detectPrivateKeyImport(JSON.stringify(Array.from({ length: 32 }, (_, i) => i)))).toEqual(
      {
        chainFamily: 'solana',
        format: 'solana-json',
        ambiguous: false
      }
    )
    expect(detectPrivateKeyImport('2'.repeat(44))).toEqual({
      chainFamily: 'solana',
      format: 'solana-base58',
      ambiguous: false
    })
    expect(detectPrivateKeyImport(`ed25519:${'3'.repeat(44)}`)).toEqual({
      chainFamily: 'near',
      format: 'near-ed25519',
      ambiguous: false
    })
  })

  test('does not claim invalid or incomplete input belongs to a network', () => {
    expect(detectPrivateKeyImport('')).toBeNull()
    expect(detectPrivateKeyImport('0x1234')).toBeNull()
    expect(detectPrivateKeyImport('not-a-private-key')).toBeNull()
  })
})
