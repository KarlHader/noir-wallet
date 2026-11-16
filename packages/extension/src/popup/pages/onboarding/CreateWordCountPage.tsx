import { Button } from '../../components/ui/button'
import { PageHeader } from '../../components/common/PageHeader'
import { MnemonicWordCountSelector } from '../../components/onboarding/MnemonicWordCountSelector'
import { useNavigate } from '../../provider/Router'
import { useOnboardingStore } from '@/store/onboarding-store'
import { OnboardingAccountNameField } from '../../components/onboarding/OnboardingAccountNameField'
import { getAccountNameValidationError } from '@/core/wallet/account-name'
import { getDefaultImportNetworkFamilies } from '@/core/wallet/account-network-selection'
import { availableSoftwareAccountFamilies } from '@/popup/services/account-network-selection-client'
import { AccountNetworkFamilyChoices } from '@/popup/components/account/AccountNetworkFamilyChoices'

export function CreateWordCountPage() {
  const { navigate } = useNavigate()
  const {
    mnemonicWordCount,
    setMnemonicWordCount,
    accountName,
    setAccountName,
    selectedNetworkFamilies,
    setSelectedNetworkFamilies
  } = useOnboardingStore()
  const accountNameError = getAccountNameValidationError(accountName)
  const availableFamilies = availableSoftwareAccountFamilies()
  const selected =
    selectedNetworkFamilies ?? getDefaultImportNetworkFamilies(mnemonicWordCount, availableFamilies)

  return (
    <div className="page-container">
      <PageHeader title="Create wallet" showBack />

      <div className="page-content pt-6">
        <div className="mt-1">
          <OnboardingAccountNameField
            value={accountName}
            onChange={setAccountName}
            label="First account name"
          />
        </div>

        <div className="mt-5 pb-2">
          <p className="text-sm text-muted mb-3">Recovery phrase length</p>
          <p className="mb-3 text-sm leading-relaxed text-muted">
            Your Secret Recovery Phrase restores every account in this wallet.
          </p>
          <MnemonicWordCountSelector value={mnemonicWordCount} onChange={setMnemonicWordCount} />
        </div>

        <div className="mt-5 pb-5">
          <h2 className="mb-2 text-sm text-muted">Networks</h2>
          <AccountNetworkFamilyChoices
            availableFamilies={availableFamilies}
            selectedFamilies={selected}
            onChange={setSelectedNetworkFamilies}
          />
        </div>
      </div>

      <div className="page-footer">
        <Button
          onClick={() => {
            setSelectedNetworkFamilies(selected)
            navigate('/onboarding/secure-wallet')
          }}
          disabled={Boolean(accountNameError) || selected.length === 0}
          className="w-full h-[45px]"
        >
          Continue
        </Button>
      </div>
    </div>
  )
}
