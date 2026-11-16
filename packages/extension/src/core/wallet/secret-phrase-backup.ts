import type { WalletItem } from '@/types'

export interface WalletBackupVerification {
  readonly wordIndices: readonly [number, number]
  readonly words: readonly [string, string]
}

const LEGACY_CREATION_START = Date.parse('2026-09-24T00:00:00+08:00')

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function getWalletsNeedingSecretPhraseBackup(wallets: readonly WalletItem[]): WalletItem[] {
  return wallets
    .filter(wallet => {
      if (
        (wallet.keySource !== undefined && wallet.keySource !== 'software') ||
        wallet.secretPhraseOrigin === 'imported' ||
        isPositiveSafeInteger(wallet.secretPhraseCreationRevision) ||
        isPositiveSafeInteger(wallet.secretPhraseBackupVerifiedAt)
      ) {
        return false
      }
      if (wallet.secretPhraseOrigin === 'created') return true
      // Legacy metadata has no reliable provenance. Preserve its existing reminder
      // eligibility without inventing either an import origin or backup verification.
      if (
        !Number.isSafeInteger(wallet.createdAt) ||
        wallet.createdAt < LEGACY_CREATION_START ||
        !/^Wallet \d{13}$/.test(wallet.name)
      )
        return false
      const primary = wallet.accounts.filter(account => account.derivationIndex === 0)
      return primary.length === 1 && primary[0].name === 'Account 1'
    })
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
}

export function matchesWalletBackupWords(
  phraseWords: readonly string[],
  verification: unknown
): boolean {
  if (!verification || typeof verification !== 'object') return false
  if (!('wordIndices' in verification) || !('words' in verification)) return false
  const { wordIndices, words } = verification
  if (!Array.isArray(wordIndices) || !Array.isArray(words)) return false
  if (wordIndices.length !== 2 || words.length !== 2) return false
  if (
    !wordIndices.every(
      index => Number.isInteger(index) && index >= 0 && index < phraseWords.length
    ) ||
    wordIndices[0] === wordIndices[1] ||
    !words.every(word => typeof word === 'string' && /^\S+$/.test(word.trim()))
  ) {
    return false
  }
  return words.every(
    (word, index) => word.trim().toLowerCase() === phraseWords[wordIndices[index]].toLowerCase()
  )
}
