import { InlineError } from '@/popup/components/common/InlineError'
import { Button } from '../../components/ui/button'
import { PageHeader } from '../../components/common/PageHeader'
import WalletIcon from '@/images/wallet-icon.svg'
import { useNavigate } from '../../provider/Router'
import { useOnboardingStore } from '@/store/onboarding-store'
import { useBetaInviteBinding } from '../../hooks/useBetaInviteBinding'

export function CongratulationsPage() {
  const { replace } = useNavigate()
  const { flowMode, mode, dappRequestId, reset } = useOnboardingStore()
  const { status, changeCode, error, busy, activate } = useBetaInviteBinding()
  const activationPending = status.required && status.state.phase !== 'activated'

  const handleComplete = async () => {
    if (activationPending) return
    reset()

    // If onboarding was triggered by dApp connection, redirect to approval page
    if (dappRequestId) {
      // Redirect to approval page where user can manually approve the connection
      replace(`/approval?requestId=${dappRequestId}`)
      return
    }

    // Normal onboarding flow
    if (flowMode === 'addWallet') {
      replace('/account-list')
    } else {
      replace('/')
    }
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
          {mode === 'import'
            ? 'Your wallet is ready. Accounts for every supported network were restored from this recovery phrase.'
            : 'Your wallet is ready. You can now securely receive, store, and send digital assets.'}
        </p>
      </div>

      <div className="px-5 pb-5">
        {error && (
          <div className="mb-3 space-y-2">
            <InlineError message={error} onRetry={() => void activate()} retrying={busy} />
            <Button variant="ghost" onClick={changeCode} disabled={busy} className="w-full h-10">
              Use another code
            </Button>
          </div>
        )}
        {!error && (
          <Button
            onClick={handleComplete}
            disabled={activationPending || busy}
            isLoading={busy}
            className="w-full h-[45px]"
          >
            Got it
          </Button>
        )}
      </div>
    </div>
  )
}
