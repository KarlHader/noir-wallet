import { Button } from '../../components/ui/button'
import { PageHeader } from '../../components/common/PageHeader'
import { MnemonicWordCountSelector } from '../../components/onboarding/MnemonicWordCountSelector'
import { useNavigate } from '../../provider/Router'
import { useOnboardingStore } from '@/store/onboarding-store'
import { OnboardingAccountNameField } from '../../components/onboarding/OnboardingAccountNameField'
import { getAccountNameValidationError } from '@/core/wallet/account-name'

export function ImportWordCountPage() {
  const { navigate } = useNavigate()
  const { mnemonicWordCount, setMnemonicWordCount, accountName, setAccountName } =
    useOnboardingStore()
  const accountNameError = getAccountNameValidationError(accountName)

  return (
    <div className="page-container">
      <PageHeader title="Import wallet" showBack />

      <div className="page-content pt-6">
        <div className="mt-1">
          <OnboardingAccountNameField value={accountName} onChange={setAccountName} />
        </div>

        <div className="mt-5 pb-2">
          <p className="text-sm text-muted mb-3">Recovery phrase length</p>
          <MnemonicWordCountSelector value={mnemonicWordCount} onChange={setMnemonicWordCount} />
        </div>
      </div>

      <div className="page-footer">
        <Button
          onClick={() => navigate('/onboarding/import')}
          disabled={Boolean(accountNameError)}
          className="w-full h-[45px]"
        >
          Continue
        </Button>
      </div>
    </div>
  )
}
