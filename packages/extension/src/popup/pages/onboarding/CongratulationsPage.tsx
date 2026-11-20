import { Button } from '../../components/ui/button'
import { PageHeader } from '../../components/common/PageHeader'
import WalletIcon from '@/images/wallet-icon.svg'
import { useNavigate } from '../../provider/Router'
import { useOnboardingStore } from '@/store/onboarding-store'
import { useWalletStore } from '@/store/wallet-store'
import { Pill } from '@/popup/components/multisig/Pill'
import { isMultisigUiEnabled } from '@/core/multisig/multisig-runtime-policy'
import { openMultisigCreateTab } from '@/lib/multisig-tab'

export function CongratulationsPage() {
  const { replace } = useNavigate()
  const { mode, dappRequestId, reset } = useOnboardingStore()
  // Imported wallets and dApp-triggered onboarding keep the single "Got it" action.
  const showMultisig = isMultisigUiEnabled() && mode === 'create' && !dappRequestId

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

  const handleStartWithMultisig = async () => {
    // Read before handleComplete resets the onboarding store. Adding a wallet leaves the current
    // wallet unchanged, so the created one must come from the store, not from the current wallet.
    const { createdWallet } = useOnboardingStore.getState()
    const { currentWalletId, currentAccountId } = useWalletStore.getState()
    const target =
      createdWallet ??
      (currentWalletId && currentAccountId
        ? { walletId: currentWalletId, accountId: currentAccountId }
        : null)
    // The popup navigates home below; the flow itself runs in the new full tab.
    if (target) openMultisigCreateTab(target)
    await handleComplete()
  }

  return (
    <div className="page-container">
      <PageHeader />

      <div className="flex-1 flex flex-col items-center justify-center px-5">
        <div className="mb-8">
          <img src={WalletIcon} alt="Wallet" />
        </div>

        <h1 className="text-lg font-medium text-center mb-3">Congratulations!</h1>

        <p className="text-xs text-foreground text-center leading-relaxed">
          Your wallet is ready. You can now securely send, receive, and store digital assets.
        </p>
      </div>

      <div className="px-5 pb-5">
        {showMultisig ? (
          <div className="space-y-4">
            <div className="space-y-0.5">
              <Button
                onClick={handleStartWithMultisig}
                className="relative w-full h-[45px] rounded-lg font-bold text-black"
              >
                Start with Multisig
                <span className="absolute right-3 top-1/2 -translate-y-1/2">
                  <Pill tone="suggested">Suggested</Pill>
                </span>
              </Button>
              <div className="rounded-lg bg-primary/10 px-3 py-2 text-xs text-primary text-center">
                <p>Multiple devices. One secure authorization.</p>
                <p>Makes your every transaction more secure.</p>
              </div>
            </div>
            <Button
              variant="outline"
              onClick={handleComplete}
              className="w-full h-[45px] rounded-lg border-primary hover:border-primary"
            >
              Start Directly
            </Button>
            <p className="text-xs text-foreground/70 text-center text-balance">
              Your recovery phrase securely manages all supported blockchain accounts.
            </p>
          </div>
        ) : (
          <Button onClick={handleComplete} className="w-full h-[45px]">
            Got it
          </Button>
        )}
      </div>
    </div>
  )
}
