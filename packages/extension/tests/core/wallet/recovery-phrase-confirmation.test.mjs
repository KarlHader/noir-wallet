import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  selectDifferentVerificationIndices,
  selectVerificationIndices,
  shuffleVerificationWordOptions
} from '../../../src/popup/utils/recovery-phrase-confirmation.ts'
import {
  getWalletsNeedingSecretPhraseBackup,
  matchesWalletBackupWords
} from '../../../src/core/wallet/secret-phrase-backup.ts'

test.describe('Recovery phrase confirmation', () => {
  test('selects exactly two distinct, ordered positions for 12 and 24 words', () => {
    expect(selectVerificationIndices(12, 2, upperExclusive => upperExclusive - 1)).toEqual([0, 11])
    expect(selectVerificationIndices(24, 2, () => 0)).toEqual([0, 1])
  })

  test('keeps repeated words as separately selectable options', () => {
    const options = shuffleVerificationWordOptions(['same', 'middle', 'same'], [0, 2], () => 0)
    expect(options).toHaveLength(3)
    expect(options.filter(option => option.word === 'same')).toHaveLength(2)
    expect(options.some(option => option.word === 'middle')).toBe(false)
    expect(
      options
        .filter(option => option.word === 'same')
        .map(option => option.optionId)
        .sort()
    ).toEqual([0, 2])
  })

  test('reveals only challenged phrase words among distinct distractors', () => {
    const words = [
      'abandon',
      'ability',
      'able',
      'about',
      'above',
      'absent',
      'absorb',
      'abstract',
      'absurd',
      'abuse',
      'access',
      'accident'
    ]
    const options = shuffleVerificationWordOptions(words, [2, 8], () => 0)
    expect(options).toHaveLength(words.length)
    expect(
      options
        .filter(option => words.includes(option.word))
        .map(option => option.optionId)
        .sort((a, b) => a - b)
    ).toEqual([2, 8])
    expect(new Set(options.map(option => option.word)).size).toBe(options.length)
    expect(options.filter(option => option.optionId < 0)).toHaveLength(words.length - 2)
  })

  test('changes the requested positions when the confirmation page is revisited', () => {
    expect(selectDifferentVerificationIndices(12, [0, 1], 2, () => 0)).toEqual([0, 2])
    expect(selectDifferentVerificationIndices(12, [0, 11], 2, upper => upper - 1)).toEqual([0, 1])
  })

  test('rejects invalid ranges and random indexes', () => {
    expect(() => selectVerificationIndices(1, 2, () => 0)).toThrow(/range/i)
    expect(() => selectVerificationIndices(12, 2, upperExclusive => upperExclusive)).toThrow(
      /out-of-range/i
    )
    expect(() => shuffleVerificationWordOptions(['one', 'two'], [0, 1], () => -1)).toThrow(
      /out-of-range/i
    )
    expect(() => shuffleVerificationWordOptions(['one', 'two'], [0, 0])).toThrow(/range/i)
  })
})

test.describe('Wallet backup verification', () => {
  const legacyWallet = {
    id: 'legacy-generated',
    name: 'Wallet 1791000000000',
    seedPhraseKey: 'seed_legacy-generated',
    createdAt: 1791000000000,
    isPinned: false,
    accounts: [{ id: 'primary', name: 'Account 1', derivationIndex: 0 }]
  }

  test('reminds only the identifiable unverified generated software wallets', () => {
    expect(
      getWalletsNeedingSecretPhraseBackup([
        legacyWallet,
        { ...legacyWallet, id: 'explicit-import', secretPhraseOrigin: 'imported' },
        {
          ...legacyWallet,
          id: 'renamed-created',
          name: 'Daily wallet',
          secretPhraseOrigin: 'created'
        },
        { ...legacyWallet, id: 'new-v2', secretPhraseCreationRevision: 1 },
        { ...legacyWallet, id: 'verified', secretPhraseBackupVerifiedAt: 1791000000001 },
        { ...legacyWallet, id: 'keystone', keySource: 'keystone' },
        { ...legacyWallet, id: 'private-key', keySource: 'private-key' },
        {
          ...legacyWallet,
          id: 'imported',
          accounts: [{ id: 'primary', name: 'Imported Account', derivationIndex: 0 }]
        }
      ]).map(wallet => wallet.id)
    ).toEqual(['legacy-generated', 'renamed-created'])
  })

  test('checks both positions, even when the phrase repeats a word', () => {
    const words = ['same', 'middle', 'same']
    expect(
      matchesWalletBackupWords(words, { wordIndices: [0, 1], words: ['same', 'middle'] })
    ).toBe(true)
    expect(matchesWalletBackupWords(words, { wordIndices: [0, 1], words: ['same', 'same'] })).toBe(
      false
    )
    expect(matchesWalletBackupWords(words, { wordIndices: [0, 0], words: ['same', 'same'] })).toBe(
      false
    )
    expect(
      matchesWalletBackupWords(words, { wordIndices: [0, 3], words: ['same', 'middle'] })
    ).toBe(false)
  })
})
