import { useMemo } from 'react'
import { Button } from '../../components/ui/button'
import { PageHeader } from '../../components/common/PageHeader'
import { WordTag } from '../../components/seed-phrase/WordTag'
import { useNavigate } from '../../provider/Router'
import { useOnboardingStore } from '@/store/onboarding-store'
import { shuffleVerificationWordOptions } from '../../utils/recovery-phrase-confirmation'

export function ConfirmPhrasePage() {
  const { navigate } = useNavigate()
  const {
    flowMode,
    seedPhrase,
    verificationIndices,
    selectedVerificationWords,
    error,
    isLoading,
    selectVerificationWord,
    verifySeedPhrase,
    createWallet,
    addWallet
  } = useOnboardingStore()

  const shuffledWordOptions = useMemo(() => {
    if (seedPhrase.length === 0 || verificationIndices.length !== 2) return []
    return shuffleVerificationWordOptions(seedPhrase, verificationIndices)
  }, [seedPhrase, verificationIndices])

  const ordinalSuffix = (n: number) => {
    const s = ['th', 'st', 'nd', 'rd']
    const v = n % 100
    return n + (s[(v - 20) % 10] || s[v] || s[0])
  }

  const handleNext = async () => {
    if (verifySeedPhrase()) {
      if (flowMode === 'addWallet') {
        const success = await addWallet()
        if (success) {
          navigate('/onboarding/congratulations')
        }
      } else {
        const success = await createWallet()
        if (success) {
          navigate('/onboarding/congratulations')
        }
      }
    }
  }

  return (
    <div className="page-container">
      <PageHeader title="Confirm Recovery Phrase" showBack />

      <div className="flex-1 px-5 pt-3 overflow-y-auto">
        <p className="text-sm text-muted mb-4">
          Select the{' '}
          <span className="text-primary font-medium">
            {ordinalSuffix(verificationIndices[0] + 1)}
          </span>{' '}
          and{' '}
          <span className="text-primary font-medium">
            {ordinalSuffix(verificationIndices[1] + 1)}
          </span>{' '}
          words.
        </p>

        <div className="flex flex-wrap gap-2">
          {shuffledWordOptions.map(option => (
            <WordTag
              key={option.optionId}
              word={option.word}
              selected={selectedVerificationWords.some(
                selected => selected.optionId === option.optionId
              )}
              onClick={() => !isLoading && selectVerificationWord(option)}
            />
          ))}
        </div>

        {selectedVerificationWords.length > 0 && (
          <div className="mt-4 p-3 bg-card rounded-lg">
            <p className="text-sm text-muted mb-2">Selected words:</p>
            <div className="flex gap-2">
              {selectedVerificationWords.map((option, index) => (
                <span key={option.optionId} className="text-foreground font-mono">
                  {ordinalSuffix(verificationIndices[index] + 1)}: {option.word}
                </span>
              ))}
            </div>
          </div>
        )}

        {error && <p className="mt-4 text-sm text-danger">{error}</p>}

        {isLoading && (
          <div className="mt-4 flex items-center gap-2 text-muted">
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary"></div>
            <span className="text-sm">Creating wallet...</span>
          </div>
        )}
      </div>

      <div className="px-5 pb-5">
        <Button
          onClick={handleNext}
          disabled={selectedVerificationWords.length !== 2 || isLoading}
          className="w-full h-[45px]"
        >
          {isLoading ? 'Creating...' : 'Confirm'}
        </Button>
      </div>
    </div>
  )
}
