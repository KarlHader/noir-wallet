import { useSearchParams } from 'react-router-dom'
import { AddressesList } from '@/popup/pages/account/AddressesList'
import { PageHeader } from '@/popup/components/common/PageHeader'
import { InlineError } from '@/popup/components/common/InlineError'
import { ListSkeleton } from '@/popup/components/ui/skeleton'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import { resolveEffectiveActiveAccountIdentity } from '@/popup/lib/effective-active-account'
import { DepositWithdraw } from '@/popup/pages/transactions/DepositWithdraw'
import { useWalletStore } from '@/store/wallet-store'

export function Receive() {
  const [params] = useSearchParams()
  const walletId = params.get('walletId')
  const accountId = params.get('accountId')
  if (params.get('mode') !== 'shield') {
    return walletId === null && accountId === null ? (
      <ActivePublicReceive />
    ) : (
      <AddressesList receive />
    )
  }
  if (walletId === null && accountId === null) return <DepositWithdraw receiveEntry />
  return <BoundShieldReceive walletId={walletId} accountId={accountId} />
}

function ActivePublicReceive() {
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const { activeAccount, loading, error, contextChanging, refresh } = useActiveAccountNetworks()
  const effective = resolveEffectiveActiveAccountIdentity({
    currentWalletId,
    currentAccountId,
    nativeAccount: activeAccount
  })
  if (effective && !contextChanging) {
    return (
      <AddressesList
        key={`${effective.walletId}:${effective.accountId}`}
        receive
        receiveAccount={effective}
      />
    )
  }

  return (
    <div className="page-container">
      <PageHeader title="Address" showBack />
      <div className="px-4 py-6 text-center text-sm text-muted">
        {error ? (
          <InlineError message="Unable to load account addresses." onRetry={() => void refresh()} />
        ) : loading || contextChanging ? (
          <ListSkeleton rows={4} label="Loading addresses" card />
        ) : (
          <p role="status">No account available</p>
        )}
      </div>
    </div>
  )
}

function BoundShieldReceive({
  walletId,
  accountId
}: {
  readonly walletId: string | null
  readonly accountId: string | null
}) {
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const { activeAccount, loading, error, contextChanging, refresh } = useActiveAccountNetworks()
  const effective = resolveEffectiveActiveAccountIdentity({
    currentWalletId,
    currentAccountId,
    nativeAccount: activeAccount
  })
  const accountChanged =
    effective !== null &&
    ((walletId !== null && walletId !== effective.walletId) ||
      (accountId !== null && accountId !== effective.accountId))
  if (effective && !accountChanged && !contextChanging) return <DepositWithdraw receiveEntry />

  const accountLoading = !error && !accountChanged && (loading || contextChanging)
  return (
    <div className="page-container">
      <PageHeader title="Receive" showBack />
      <div className="px-4 py-6 text-center text-sm text-muted">
        {accountChanged ? (
          <p role="status">Account changed. Reopen Receive.</p>
        ) : accountLoading ? (
          <p role="status">Loading account...</p>
        ) : (
          <InlineError message="Could not load the account." onRetry={() => void refresh()} />
        )}
      </div>
    </div>
  )
}
