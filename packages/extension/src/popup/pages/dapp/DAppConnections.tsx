import { PageHeader } from '@/popup/components/common/PageHeader'
import { DAppConnectionModal } from '@/popup/components/dapp/DAppConnectionModal'

export function DAppConnections() {
  return (
    <div className="page-container">
      <PageHeader title="DApps Connection" showBack />
      <DAppConnectionModal />
    </div>
  )
}
