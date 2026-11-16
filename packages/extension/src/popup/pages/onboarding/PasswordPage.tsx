import { PasswordForm } from '../../components/common/PasswordForm'
import { useNavigate } from '../../provider/Router'
import { useOnboardingStore } from '@/store/onboarding-store'

export function PasswordPage() {
  const { navigate, goBack } = useNavigate()
  const { setPassword } = useOnboardingStore()

  const handleSubmit = async (data: { new: string }) => {
    // Store the password
    setPassword(data.new)
    // Navigate to next step
    navigate('/onboarding/create-word-count')
  }

  const handleBack = () => {
    goBack()
  }

  return (
    <PasswordForm
      mode="create"
      title="Create Password"
      description="This password is used to unlock your wallet. We cannot reset this password. If you lose it, you'll need to restore your wallet using your Secret Recovery Phrase."
      submitText="Create"
      showTerms={true}
      onSubmit={handleSubmit}
      onBack={handleBack}
    />
  )
}
