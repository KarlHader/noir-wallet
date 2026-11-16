import { validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'
import type { MnemonicWordCount } from '@/config/wallet'

const englishWords = new Set(wordlist)

export interface MnemonicValidation {
  phrase: string
  invalidWordIndexes: number[]
  isValid: boolean
}

export function validateEnglishMnemonicWords(
  words: string[],
  expectedWordCount: MnemonicWordCount
): MnemonicValidation {
  const normalizedWords = words.map(word => word.trim().toLowerCase())
  const invalidWordIndexes = normalizedWords.flatMap((word, index) =>
    word && !englishWords.has(word) ? [index] : []
  )
  const phrase = normalizedWords.join(' ')

  return {
    phrase,
    invalidWordIndexes,
    isValid:
      normalizedWords.length === expectedWordCount &&
      normalizedWords.every(Boolean) &&
      invalidWordIndexes.length === 0 &&
      validateMnemonic(phrase, wordlist)
  }
}
