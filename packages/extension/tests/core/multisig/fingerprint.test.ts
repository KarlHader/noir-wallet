import { test } from 'node:test'
import { expect } from '@playwright/test'
import { deriveMockFingerprint, formatFingerprint } from '../../../src/core/multisig/fingerprint'

test.describe('multisig fingerprint', () => {
  test('formats 24 hex chars into 6 groups of 4 uppercase', () => {
    expect(formatFingerprint('7f2c9a41d0b83e7751cc8a2fdeadbeef')).toBe(
      '7F2C 9A41 D0B8 3E77 51CC 8A2F'
    )
  })

  test('mock fingerprint is deterministic and stage-specific', () => {
    expect(deriveMockFingerprint('group-a', 'final')).toBe(
      deriveMockFingerprint('group-a', 'final')
    )
    expect(deriveMockFingerprint('group-a', 'final')).not.toBe(
      deriveMockFingerprint('group-a', 'r1')
    )
    expect(deriveMockFingerprint('group-a', 'final')).toMatch(/^[0-9a-f]{24}$/)
  })
})
