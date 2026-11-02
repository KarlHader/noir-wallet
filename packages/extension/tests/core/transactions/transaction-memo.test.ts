import { test } from 'node:test'
import { expect } from '@playwright/test'
import { detectZcashAddressType, sanitizeMemoForRecipient } from '../../../src/lib/zcash-memo'

test.describe('ZIP-321 memo rules', () => {
  test('removes memos from mainnet and testnet transparent recipients', () => {
    expect(sanitizeMemoForRecipient('t1transparent', 'Lending Supply')).toBeUndefined()
    expect(sanitizeMemoForRecipient('t2transparent', 'Lending Supply')).toBeUndefined()
    expect(sanitizeMemoForRecipient('t3transparent', 'Swap ZEC → NEAR')).toBeUndefined()
    expect(sanitizeMemoForRecipient('tmtransparent', 'Lending Supply')).toBeUndefined()
    expect(sanitizeMemoForRecipient('tex1transparent', 'Private memo')).toBeUndefined()
    expect(sanitizeMemoForRecipient('textest1transparent', 'Private memo')).toBeUndefined()
  })

  test('preserves memos for shielded and unified recipients', () => {
    expect(sanitizeMemoForRecipient('u1shielded', 'Private memo')).toBe('Private memo')
    expect(sanitizeMemoForRecipient('utest1shielded', 'Private memo')).toBe('Private memo')
    expect(sanitizeMemoForRecipient('zs1shielded', 'Private memo')).toBe('Private memo')
    expect(sanitizeMemoForRecipient('ztestsaplingshielded', 'Private memo')).toBe('Private memo')
  })

  test('classifies mainnet and testnet shielded address prefixes', () => {
    expect(detectZcashAddressType('u1shielded')).toBe('shielded')
    expect(detectZcashAddressType('utest1shielded')).toBe('shielded')
    expect(detectZcashAddressType('zs1shielded')).toBe('shielded')
    expect(detectZcashAddressType('ztestsaplingshielded')).toBe('shielded')
    expect(detectZcashAddressType('tmtransparent')).toBe('transparent')
    expect(detectZcashAddressType('tex1transparent')).toBe('transparent')
    expect(detectZcashAddressType('textest1transparent')).toBe('transparent')
  })
})
