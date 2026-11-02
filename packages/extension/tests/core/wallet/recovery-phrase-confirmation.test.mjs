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
    const options = shuffleVerificationWordOptions(['same', 'middle', 'same'], () => 0)
    expect(options.map(option => option.word).sort()).toEqual(['middle', 'same', 'same'])
    expect(
      options
        .filter(option => option.word === 'same')
        .map(option => option.optionId)
        .sort()
    ).toEqual([0, 2])
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
    expect(() => shuffleVerificationWordOptions(['one', 'two'], () => -1)).toThrow(/out-of-range/i)
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
    ).toEqual(['legacy-generated'])
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
