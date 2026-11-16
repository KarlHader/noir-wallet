import { Button } from '../../components/ui/button'
import { PageHeader } from '../../components/common/PageHeader'
import { useNavigate } from '../../provider/Router'
import { useOnboardingStore } from '@/store/onboarding-store'
import { Icon } from '@iconify/react'

export function SecureWalletPage() {
  const { navigate } = useNavigate()
  const { mnemonicWordCount, generateSeedPhrase, isLoading, error } = useOnboardingStore()

  const handleNext = async () => {
    await generateSeedPhrase()
    // Only navigate if no error
    if (!useOnboardingStore.getState().error) {
      navigate('/onboarding/view-phrase')
    }
  }

  return (
    <div className="page-container">
      <PageHeader title="Secure your wallet" showBack />

      <div className="flex-1 px-5 pt-4">
        <div className="text-base text-muted leading-relaxed space-y-4">
          <p>Secure your assets — back up your Secret Recovery Phrase now.</p>
          <p>
            On the next screen, you'll see your {mnemonicWordCount}-word Secret Recovery Phrase.
          </p>
          <div className="rounded-xl border border-danger/30 bg-danger/[0.08] p-4">
            <div className="mb-3 flex items-center gap-2 text-danger/90">
              <Icon icon="lucide:shield-alert" width={17} height={17} />
              <span className="text-sm font-semibold">Protect your recovery phrase</span>
            </div>
            <ul className="list-disc space-y-2 pl-5 text-foreground/80 marker:text-danger/70">
              <li>
                <strong>Store it safely:</strong> Write it down and keep it in a secure location.
              </li>
              <li>
                <strong>Never share it:</strong> Anyone with this phrase gains permanent access to
                your assets. No official or support agent will ever ask for it.
              </li>
            </ul>
          </div>
        </div>

        {error && <p className="text-danger text-sm mt-4">{error}</p>}
      </div>

      <div className="px-5 pb-5">
        <Button
          onClick={handleNext}
          disabled={isLoading}
          className="w-full h-[45px]"
          isLoading={isLoading}
        >
          Start backup
        </Button>
      </div>
    </div>
  )
}
