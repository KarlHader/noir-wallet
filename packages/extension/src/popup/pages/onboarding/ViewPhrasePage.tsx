import { InlineError } from '@/popup/components/common/InlineError'
import { useState, useEffect } from 'react'
import { Button } from '../../components/ui/button'
import { PageHeader } from '../../components/common/PageHeader'
import { SeedPhraseDisplay } from '../../components/seed-phrase/SeedPhraseDisplay'
import { LabeledCheckbox } from '../../components/common/LabeledCheckbox'
import { CopyToast, useCopyToClipboard } from '../../components/common/CopyToast'
import { useNavigate } from '../../provider/Router'
import { useOnboardingStore } from '@/store/onboarding-store'
import { Skeleton } from '../../components/ui/skeleton'

export function ViewPhrasePage() {
  const { navigate } = useNavigate()
  const {
    seedPhrase,
    mnemonicWordCount,
    acknowledgedWarning,
    setAcknowledgedWarning,
    generateSeedPhrase,
    refreshVerificationChallenge,
    isLoading,
    error
  } = useOnboardingStore()

  const [isBlurred, setIsBlurred] = useState(true)
  const { copyToClipboard, showToast } = useCopyToClipboard()

  useEffect(() => {
    if (seedPhrase.length === 0) {
      // generateSeedPhrase is now async
      generateSeedPhrase()
    }
  }, []) // Remove generateSeedPhrase from deps to avoid re-triggering

  const handleNext = () => {
    refreshVerificationChallenge()
    navigate('/onboarding/confirm-phrase')
  }

  // Show loading state while WASM is being loaded
  if (isLoading) {
    return (
      <div className="page-container">
        <PageHeader showBack />
        <div role="status" aria-label="Loading recovery phrase" className="flex-1 px-5 pt-3">
          <div className="space-y-2">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-[82%]" />
          </div>
          <div className="mt-5 grid grid-cols-3 gap-2 rounded-xl border border-border p-3">
            {Array.from({ length: mnemonicWordCount }, (_, index) => (
              <Skeleton key={index} className="h-8 rounded-lg" />
            ))}
          </div>
          <div className="mt-6 flex justify-center">
            <Skeleton className="h-5 w-28" />
          </div>
        </div>
        <div className="px-5 pb-5">
          <Skeleton className="h-[45px] rounded-lg" />
        </div>
      </div>
    )
  }

  // Show error if WASM loading failed
  if (error) {
    return (
      <div className="page-container">
        <PageHeader showBack />
        <div className="flex-1 flex items-center justify-center px-5">
          <InlineError className="w-full" message={error} onRetry={() => generateSeedPhrase()} />
        </div>
      </div>
    )
  }

  return (
    <div className="page-container">
      <CopyToast show={showToast} />
      <PageHeader title="View Secret Phrase" showBack />

      <div className="flex-1 px-5 pt-3 overflow-y-auto">
        <p className="text-sm text-muted mb-4">
          Store these {mnemonicWordCount} words securely to restore your wallet anytime. Sharing
          your seed phrase may cause you to lose your assets.
        </p>

        <div className="relative mb-4">
          <SeedPhraseDisplay
            words={seedPhrase}
            blurred={isBlurred}
            onReveal={() => setIsBlurred(false)}
            onCopy={() => copyToClipboard(seedPhrase.join(' '))}
          />
        </div>
      </div>

      <div className="px-5 pt-4 pb-5 space-y-4">
        <div className="flex justify-center">
          <LabeledCheckbox
            checked={acknowledgedWarning}
            onChange={setAcknowledgedWarning}
            label="I have saved it"
          />
        </div>
        <Button onClick={handleNext} disabled={!acknowledgedWarning} className="w-full h-[45px]">
          Next
        </Button>
      </div>
    </div>
  )
}
