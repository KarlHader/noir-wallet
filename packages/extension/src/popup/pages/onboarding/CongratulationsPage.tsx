import { Button } from '../../components/ui/button'
import { PageHeader } from '../../components/common/PageHeader'
import WalletIcon from '@/images/wallet-icon.svg'
import { useNavigate } from '../../provider/Router'
import { useOnboardingStore } from '@/store/onboarding-store'

export function CongratulationsPage() {
  const { replace } = useNavigate()
  const { dappRequestId, reset } = useOnboardingStore()

  const handleComplete = async () => {
    reset()

    // If onboarding was triggered by dApp connection, redirect to approval page
    if (dappRequestId) {
      // Redirect to approval page where user can manually approve the connection
      replace(`/approval?requestId=${dappRequestId}`)
      return
    }

    replace('/')
  }

  return (
    <div className="page-container">
      <PageHeader />

      <div className="flex-1 flex flex-col items-center justify-center px-5">
        <div className="mb-8">
          <img src={WalletIcon} alt="Wallet" />
        </div>

        <h1 className="text-lg font-semibold text-center mb-3">Congratulations!</h1>

        <p className="text-base text-muted text-center leading-relaxed">
          Your wallet is ready. You can now securely send, receive, and store digital assets.
        </p>
      </div>

      <div className="px-5 pb-5">
        <Button onClick={handleComplete} className="w-full h-[45px]">
          Got it
        </Button>
      </div>
    </div>
  )
}
