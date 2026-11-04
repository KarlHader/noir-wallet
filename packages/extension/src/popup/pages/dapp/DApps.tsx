import { Icon } from '@iconify/react'
import { PageHeader } from '@/popup/components/common/PageHeader'
import { DAppConnectionModal } from '@/popup/components/dapp/DAppConnectionModal'
import { useLocation, useNavigate } from '@/popup/provider/Router'
import { ZKNOIR_LENDING_URL } from '@/core/dapp/first-party-policy'
import { toast } from '@/store/toast-store'
import { useWalletStore } from '@/store/wallet-store'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import { isZcashHardwareKeySource } from '@/core/wallet/hardware-wallet-data'

export function DAppConnections() {
  const { search } = useLocation()
  const navigate = useNavigate()
  const privateMode = new URLSearchParams(search).get('mode') === 'private'
  return (
    <div className="page-container" data-wallet-mode={privateMode ? 'private' : 'public'}>
      <PageHeader
        title="DApps Connection"
        showBack
        action={{
          ariaLabel: 'Explore dApps',
          icon: <Icon icon="lucide:layout-grid" width={18} height={18} />,
          onClick: () => navigate.navigate(`/dapps?mode=${privateMode ? 'private' : 'public'}`)
        }}
      />
      <DAppConnectionModal />
    </div>
  )
}

export function DApps() {
  const { search } = useLocation()
  const navigate = useNavigate()
  const privateMode = new URLSearchParams(search).get('mode') === 'private'
  const network = useWalletStore(state => state.currentNetwork)
  const wallet = useWalletStore(state => state.getCurrentWallet())
  const { activeAccount } = useActiveAccountNetworks()
  const lendingAvailable =
    network === 'mainnet' &&
    Boolean(activeAccount || wallet) &&
    activeAccount?.walletSource.kind !== 'hardware' &&
    !isZcashHardwareKeySource(wallet?.keySource)
  return (
    <div className="page-container" data-wallet-mode={privateMode ? 'private' : 'public'}>
      <PageHeader title="dApps" showBack />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-3">
        <button
          type="button"
          disabled={!lendingAvailable}
          title={!lendingAvailable ? 'Lending unavailable for this account' : undefined}
          className="flex min-h-[68px] w-full items-center gap-3 text-left disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() =>
            void chrome.tabs
              .create({ url: ZKNOIR_LENDING_URL })
              .catch(() => toast.error('Unable to open RHEA'))
          }
        >
          <span className="flex size-9 items-center justify-center rounded-lg bg-wallet-surface text-primary">
            <Icon icon="lucide:landmark" width={20} height={20} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-base">RHEA Lending</span>
            <span className="block text-xs text-muted">Supply and borrow</span>
          </span>
          <Icon icon="lucide:arrow-up-right" width={16} height={16} className="text-muted" />
        </button>
        {lendingAvailable && (
          <button
            type="button"
            onClick={() => navigate.navigate('/?tab=lending')}
            className="ml-12 mb-6 text-sm text-primary hover:underline"
          >
            My positions
          </button>
        )}
        <button
          type="button"
          className="flex min-h-[60px] w-full items-center gap-3 border-t border-border text-left"
          onClick={() =>
            navigate.navigate(`/dapp-connections?mode=${privateMode ? 'private' : 'public'}`)
          }
        >
          <Icon icon="lucide:globe" width={20} height={20} className="text-muted" />
          <span className="flex-1 text-sm">Connected dApps</span>
          <Icon icon="lucide:chevron-right" width={16} height={16} className="text-muted" />
        </button>
      </div>
    </div>
  )
}
