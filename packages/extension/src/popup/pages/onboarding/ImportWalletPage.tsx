import { useMemo, useState, useRef, KeyboardEvent } from 'react'
import { Input } from '../../components/ui/input'
import { Button } from '../../components/ui/button'
import { PageHeader } from '../../components/common/PageHeader'
import { useNavigate } from '../../provider/Router'
import { useOnboardingStore } from '@/store/onboarding-store'
import { validateEnglishMnemonicWords } from '@/core/wallet/mnemonic-validation'

export function ImportWalletPage() {
  const { navigate } = useNavigate()
  const {
    mnemonicWordCount,
    importedSeedPhrase,
    setImportedSeedPhrase,
    setBirthdayHeight,
    setImportZcashHistorySelection,
    error
  } = useOnboardingStore()

  const [words, setWords] = useState<string[]>(() => {
    const importedWords = importedSeedPhrase.trim().split(/\s+/).filter(Boolean)
    return importedWords.length === mnemonicWordCount
      ? importedWords
      : Array(mnemonicWordCount).fill('')
  })
  const inputRefs = useRef<(HTMLInputElement | null)[]>([])
  const [validationError, setValidationError] = useState<string | null>(null)
  const mnemonicValidation = useMemo(
    () => validateEnglishMnemonicWords(words, mnemonicWordCount),
    [mnemonicWordCount, words]
  )
  const invalidWordIndexes = useMemo(
    () => new Set(mnemonicValidation.invalidWordIndexes),
    [mnemonicValidation.invalidWordIndexes]
  )
  const handleWordChange = (index: number, value: string) => {
    setValidationError(null)
    setImportedSeedPhrase('')

    if (value.includes(' ')) {
      const pastedWords = value.trim() ? value.trim().split(/\s+/) : []
      if (index + pastedWords.length > mnemonicWordCount) {
        setValidationError(`Recovery phrase must contain exactly ${mnemonicWordCount} words.`)
        return
      }
      const newWordsFromPaste = [...words]
      pastedWords.forEach((word, i) => {
        newWordsFromPaste[index + i] = word.toLowerCase()
      })
      setWords(newWordsFromPaste)

      const nextIndex = Math.min(index + pastedWords.length, mnemonicWordCount - 1)
      inputRefs.current[nextIndex]?.focus()
      return
    }

    const newWords = [...words]
    newWords[index] = value.trim().toLowerCase()
    setWords(newWords)
  }

  const handleKeyDown = (index: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !words[index] && index > 0) {
      inputRefs.current[index - 1]?.focus()
    }
    if (e.key === ' ' && words[index] && index < mnemonicWordCount - 1) {
      e.preventDefault()
      inputRefs.current[index + 1]?.focus()
    }
  }

  const handleContinue = async () => {
    if (mnemonicValidation.invalidWordIndexes.length > 0) {
      setValidationError('Highlighted words are not in the BIP-39 English word list.')
      return
    }

    if (!mnemonicValidation.isValid) {
      setValidationError('Recovery phrase checksum is invalid. Check the words and their order.')
      return
    }

    const seedPhrase = mnemonicValidation.phrase
    if (seedPhrase) {
      setImportedSeedPhrase(seedPhrase)
      setBirthdayHeight(undefined)
      setImportZcashHistorySelection(null)
      navigate('/onboarding/import-zcash-history')
    }
  }

  const isAllFilled = words.every(word => word.trim() !== '')

  return (
    <div className="page-container">
      <PageHeader title="Import Secret Recovery Phrase" showBack />
      <div className="page-content px-5 py-6">
        <div className="mb-6">
          <div className="flex items-center gap-1.5 text-sm text-muted">
            <span>Enter your {mnemonicWordCount}-word Secret Recovery Phrase</span>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3 mb-6">
          {words.map((word, index) => (
            <div key={index}>
              <Input
                ref={el => {
                  inputRefs.current[index] = el
                }}
                type="text"
                value={word}
                onChange={e => handleWordChange(index, e.target.value)}
                onKeyDown={e => handleKeyDown(index, e)}
                aria-invalid={invalidWordIndexes.has(index)}
                placeholder=""
                className="w-full h-[52px] text-sm rounded-xl px-3 pl-8"
                startContent={<span className="text-sm text-muted">{index + 1}.</span>}
                classNames={{
                  startContent: 'left-3'
                }}
              />
            </div>
          ))}
        </div>
        {(validationError || error) && (
          <p className="text-sm text-destructive mb-4">{validationError || error}</p>
        )}
      </div>
      <div className="page-footer">
        <Button onClick={handleContinue} disabled={!isAllFilled} className="w-full h-[45px]">
          Continue
        </Button>
      </div>
    </div>
  )
}
