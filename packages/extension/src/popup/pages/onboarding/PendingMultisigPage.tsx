import { Button } from '@/popup/components/ui/button'
import { PageHeader } from '@/popup/components/common/PageHeader'
import { useNavigate } from '@/popup/provider/Router'
import { openMultisigCreateTab } from '@/lib/multisig-tab'
import { useWalletStore } from '@/store/wallet-store'
import { useEffect } from 'react'

export function PendingMultisigPage() {
  const { navigate, replace } = useNavigate()
  const walletId = useWalletStore(state => state.currentWalletId)
  const network = useWalletStore(state => state.currentNetwork)
  const wallet = useWalletStore(state =>
    state.wallets.find(item => item.id === state.currentWalletId)
  )
  const accountId = wallet?.pendingFirstAccountId
  const onSetupNetwork = wallet?.pendingFirstAccountNetwork === network

  useEffect(() => {
    if (!accountId) replace('/')
  }, [accountId, replace])

  if (!walletId || !accountId) return null

  return (
    <div className="page-container">
      <PageHeader title="Multisig setup" />
      <div className="flex flex-1 flex-col items-center justify-center px-5 text-center">
        <h1 className="text-lg font-semibold">Finish your first account</h1>
        <div className="mt-3 text-sm text-muted">
          {onSetupNetwork
            ? `Continue device setup to activate ${wallet.pendingFirstAccountName ?? 'your multisig account'}.`
            : 'Switch back to the network where you started this multisig setup.'}
        </div>
      </div>
      <div className="px-5 pb-5">
        {onSetupNetwork ? (
          <Button
            className="w-full h-[45px]"
            onClick={() => openMultisigCreateTab({ walletId, accountId })}
          >
            Continue multisig setup
          </Button>
        ) : (
          <Button className="w-full h-[45px]" onClick={() => navigate('/developer-settings')}>
            Network settings
          </Button>
        )}
      </div>
    </div>
  )
}
