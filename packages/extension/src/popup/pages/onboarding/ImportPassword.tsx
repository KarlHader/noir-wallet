import { PasswordForm } from '../../components/auth/PasswordForm'
import { useNavigate } from '../../provider/Router'
import { useOnboardingStore } from '@/store/onboarding-store'

export function ImportPassword() {
  const { navigate, goBack } = useNavigate()
  const { setPassword, importWallet } = useOnboardingStore()

  const handleSubmit = async (data: { new: string }) => {
    setPassword(data.new)
    const success = await importWallet()
    if (success) {
      navigate('/onboarding/congratulations')
    } else {
      const error = useOnboardingStore.getState().error
      throw new Error(error || 'Failed to import wallet')
    }
  }

  const handleBack = () => {
    goBack()
  }

  return (
    <PasswordForm
      mode="import"
      title="Create Password"
      description="Create a password to unlock your wallet. We cannot recover this password."
      submitText="Import Wallet"
      showTerms={true}
      onSubmit={handleSubmit}
      onBack={handleBack}
    />
  )
}
