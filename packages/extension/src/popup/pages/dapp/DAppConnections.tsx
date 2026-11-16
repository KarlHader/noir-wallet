import { PageHeader } from '@/popup/components/common/PageHeader'
import { DAppConnectionModal } from '@/popup/components/dapp/DAppConnectionModal'
import { useLocation } from '@/popup/provider/Router'

export function DAppConnections() {
  const { search } = useLocation()
  const privateMode = new URLSearchParams(search).get('mode') === 'private'
  return (
    <div className="page-container" data-wallet-mode={privateMode ? 'private' : 'public'}>
      <PageHeader title="DApps Connection" showBack />
      <DAppConnectionModal />
    </div>
  )
}
