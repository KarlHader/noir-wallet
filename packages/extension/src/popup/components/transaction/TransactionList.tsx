import { useMemo, useEffect, useRef } from 'react'
import { Icon } from '@iconify/react'
import { useAccountDataStore, buildAccountKey } from '@/store/account-data-store'
import { TokenIcon } from '../tokens/TokenIcon'
import { useWalletStore } from '@/store/wallet-store'
import { getCrossChainCompletionStatus } from '@/lib/cross-chain-transaction'
import { ListSkeleton } from '../ui/skeleton'
import { useIntentsProgress } from '../../hooks/useIntentsProgress'
import { getTransactionStatusToneClassName } from '@/lib/transaction-status-presentation'
import { recheckPendingTransaction } from '@/popup/services/pending-transaction-recheck'
import { buildTransactionDateGroups } from '@/popup/services/transaction-list-model'
import type { AssetDomain } from '@/popup/services/asset-domains'

interface TransactionListProps {
  network: 'mainnet' | 'testnet'
  domain?: AssetDomain
  onItemClick?: (txId: string) => void
}

/**
 * Displays transaction history grouped by date
 */
export function TransactionList({ network, domain = 'all', onItemClick }: TransactionListProps) {
  const transactions = useAccountDataStore(state => state.getCurrentTransactions())
  const reloadTransactions = useAccountDataStore(state => state.reloadTransactions)
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const accountKey =
    currentWalletId && currentAccountId
      ? buildAccountKey(network, currentWalletId, currentAccountId)
      : null
  const hasTransactionCache = useAccountDataStore(state =>
    accountKey ? state.transactionsCache.has(accountKey) : true
  )
  const intentsProgress = useIntentsProgress(accountKey ?? undefined)
  const isSyncing = useAccountDataStore(state =>
    currentWalletId ? state.getWalletSyncState(network, currentWalletId).isSyncing : false
  )
  const recheckedRef = useRef(false)

  useEffect(() => {
    recheckedRef.current = false

    if (currentAccountId && currentWalletId) {
      const currentNetwork = useWalletStore.getState().currentNetwork
      const accountKey = buildAccountKey(currentNetwork, currentWalletId, currentAccountId)
      reloadTransactions(accountKey).catch(console.error)
    }
  }, [currentWalletId, currentAccountId, reloadTransactions, isSyncing])

  useEffect(() => {
    if (recheckedRef.current) return
    const backgroundRecheckTxs = transactions.filter(
      tx =>
        tx.network === network &&
        (tx.status === 'pending' ||
          tx.status === 'confirming' ||
          tx.status === 'relay_confirmed' ||
          (tx.status === 'failed' &&
            !tx.id.startsWith('wasm_') &&
            !!tx.txHash?.trim() &&
            (tx.type === 'send' ||
              tx.type === 'shield' ||
              tx.type === 'receive' ||
              tx.type === 'unshield')))
    )
    if (backgroundRecheckTxs.length === 0 || !accountKey) return
    recheckedRef.current = true

    chrome.runtime.sendMessage({ type: 'RECHECK_PENDING_TRANSACTIONS', accountKey }).catch(() => {})

    const { updateTransaction } = useAccountDataStore.getState()
    const foregroundRecheckTxs = backgroundRecheckTxs.filter(
      tx =>
        tx.type !== 'withdraw' &&
        tx.type !== 'claim' &&
        (tx.status === 'pending' ||
          (tx.status === 'relay_confirmed' &&
            getCrossChainCompletionStatus(tx.type, {
              destinationAsset: tx.quoteBinding?.destinationAsset
            }) === 'success'))
    )
    foregroundRecheckTxs.forEach(async tx => {
      try {
        const updates = await recheckPendingTransaction(tx)
        if (updates) {
          await updateTransaction(tx.id, updates)
        }
      } catch {}
    })
  }, [transactions, network, accountKey])

  const groups = useMemo(
    () => buildTransactionDateGroups(transactions, network, intentsProgress, domain),
    [transactions, network, intentsProgress, domain]
  )

  if (!hasTransactionCache && groups.length === 0) {
    return <ListSkeleton rows={3} label="Loading transactions" className="px-5" />
  }

  if (groups.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted">
        <Icon icon="lucide:inbox" width={48} height={48} className="mb-4 opacity-50" />
        <p className="text-sm">No transactions yet</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {groups.map(group => (
        <div key={group.date}>
          <p className="text-xs text-muted mb-2 px-5">{group.date}</p>
          <div className="space-y-2">
            {group.items.map(tx => (
              <button
                key={tx.id}
                onClick={() => onItemClick?.(tx.id)}
                className="w-full flex items-center justify-between py-3 px-5 hover:bg-white/5 transition-colors cursor-pointer"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="relative size-8 rounded-full bg-foreground/10 flex items-center justify-center">
                    <Icon
                      icon={
                        tx.type === 'receive' || tx.type === 'withdraw' || tx.type === 'claim'
                          ? 'radix-icons:arrow-bottom-left'
                          : 'lucide:send'
                      }
                      className="size-4 text-foreground"
                    />
                    <TokenIcon
                      symbol="ZEC"
                      nativeChain="zcash"
                      size={12}
                      className="absolute bottom-0 right-0 rounded-full"
                    />
                  </div>
                  <div className="min-w-0 text-left">
                    <p className="truncate font-medium">
                      {tx.type === 'receive'
                        ? 'Received'
                        : tx.type === 'shield'
                          ? 'Shielded'
                          : tx.type === 'unshield'
                            ? 'Unshielded'
                            : tx.type === 'swap'
                              ? 'Swap'
                              : tx.type === 'supply'
                                ? 'Supply'
                                : tx.type === 'withdraw'
                                  ? 'Withdraw'
                                  : tx.type === 'claim'
                                    ? 'Claim'
                                    : 'Sent'}{' '}
                      ZEC
                    </p>
                    <p
                      className={`truncate text-xs ${getTransactionStatusToneClassName(tx.statusTone)}`}
                      title={
                        tx.intentsProgress
                          ? `Deposit: ${tx.intentsProgress.depositAddress}\nUpdated: ${new Date(
                              tx.intentsProgress.lastStatusChangeAt
                            ).toLocaleString()}`
                          : tx.statusDescription
                      }
                    >
                      {tx.status}
                    </p>
                  </div>
                </div>
                <p className="ml-3 shrink-0 font-medium">{tx.amount}</p>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
