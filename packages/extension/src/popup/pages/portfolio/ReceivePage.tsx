import { useSearchParams } from 'react-router-dom'
import { AddressesList } from '@/popup/pages/account/AddressesList'
import { PageHeader } from '@/popup/components/common/PageHeader'
import { Transfer } from '@/popup/pages/transactions/Transfer'
import { useWalletStore } from '@/store/wallet-store'

export function ReceivePage() {
  const [params] = useSearchParams()
  const walletId = useWalletStore(state => state.currentWalletId)
  const accountId = useWalletStore(state => state.currentAccountId)

  if (params.get('mode') !== 'shield') return <AddressesList receive />

  const accountChanged =
    (params.has('walletId') && params.get('walletId') !== walletId) ||
    (params.has('accountId') && params.get('accountId') !== accountId)
  if (accountChanged)
    return (
      <div className="page-container">
        <PageHeader title="Receive" showBack />
        <p role="status" className="px-4 py-6 text-center text-sm text-muted">
          {walletId && accountId ? 'Account changed. Reopen Receive.' : 'Loading account...'}
        </p>
      </div>
    )

  return <Transfer />
}
