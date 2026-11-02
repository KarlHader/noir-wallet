import { test } from 'node:test'
import { expect } from '@playwright/test'
import { isZnsName, normalizeZnsName } from '../../../src/lib/zns'

test.describe('ZNS name input', () => {
  test('detects bare names and supported suffixes', () => {
    expect(isZnsName('alice')).toBe(true)
    expect(isZnsName('ALICE')).toBe(true)
    expect(isZnsName('alice.zec')).toBe(true)
    expect(isZnsName('ALICE.ZEC')).toBe(true)
    expect(isZnsName('alice.zcash')).toBe(true)
    expect(isZnsName('ALICE.ZCASH')).toBe(true)
    expect(isZnsName('my-name_123.zcash')).toBe(true)
    expect(isZnsName('  alice.zcash  ')).toBe(true)
  })

  test('does not match regular addresses', () => {
    expect(isZnsName('u1qqlzrf9abc...')).toBe(false)
    expect(isZnsName('t1Rv4eNkJ...')).toBe(false)
    expect(isZnsName('utest1abc...')).toBe(false)
    expect(isZnsName(`t1${'a'.repeat(33)}`)).toBe(false)
    expect(isZnsName(`tm${'a'.repeat(33)}`)).toBe(false)
    expect(isZnsName('')).toBe(false)
  })

  test('does not match partial suffixes or invalid bare names', () => {
    expect(isZnsName('alice.zc')).toBe(false)
    expect(isZnsName('alice-name')).toBe(false)
  })

  test('normalizes all supported forms to the same name', () => {
    expect(normalizeZnsName('ZECHARIAH')).toBe('zechariah')
    expect(normalizeZnsName('ZECHARIAH.ZEC')).toBe('zechariah')
    expect(normalizeZnsName('ZECHARIAH.ZCASH')).toBe('zechariah')
  })
})
