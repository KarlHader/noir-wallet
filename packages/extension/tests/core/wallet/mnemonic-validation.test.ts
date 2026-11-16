import { test } from 'node:test'
import { expect } from '@playwright/test'
import { entropyToMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'
import { validateEnglishMnemonicWords } from '../../../src/core/wallet/mnemonic-validation'

const validPhrase24 = `${Array(23).fill('abandon').join(' ')} art`
const validPhrase12 = `${Array(11).fill('abandon').join(' ')} about`

test.describe('Recovery phrase validation', () => {
  test('accepts a valid 24-word BIP-39 phrase', () => {
    const result = validateEnglishMnemonicWords(validPhrase24.split(' '), 24)

    expect(result.isValid).toBe(true)
    expect(result.invalidWordIndexes).toEqual([])
  })

  test('accepts a valid 12-word BIP-39 phrase', () => {
    const result = validateEnglishMnemonicWords(validPhrase12.split(' '), 12)

    expect(result.isValid).toBe(true)
    expect(result.invalidWordIndexes).toEqual([])
  })

  test('identifies words outside the English BIP-39 word list', () => {
    const words = validPhrase24.split(' ')
    words[7] = 'abandn'

    const result = validateEnglishMnemonicWords(words, 24)

    expect(result.isValid).toBe(false)
    expect(result.invalidWordIndexes).toEqual([7])
  })

  test('rejects an invalid checksum even when every word is in the word list', () => {
    const words = validPhrase24.split(' ')
    words[23] = 'ability'

    const result = validateEnglishMnemonicWords(words, 24)

    expect(result.isValid).toBe(false)
    expect(result.invalidWordIndexes).toEqual([])
  })

  test('rejects an invalid 12-word checksum', () => {
    const words = validPhrase12.replace(/about$/, 'ability').split(' ')
    const result = validateEnglishMnemonicWords(words, 12)

    expect(result.isValid).toBe(false)
    expect(result.invalidWordIndexes).toEqual([])
  })

  test('rejects valid BIP-39 lengths outside the selected 12 or 24 words', () => {
    const validPhrase15 = entropyToMnemonic(new Uint8Array(20), wordlist)

    expect(validateEnglishMnemonicWords(validPhrase15.split(' '), 12).isValid).toBe(false)
    expect(validateEnglishMnemonicWords(validPhrase15.split(' '), 24).isValid).toBe(false)
    expect(validateEnglishMnemonicWords(validPhrase24.split(' '), 12).isValid).toBe(false)
  })
})
