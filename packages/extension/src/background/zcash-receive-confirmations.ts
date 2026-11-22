import { buildAccountKey } from '@/core/wallet/account-scope'
import {
  applyExternalReceiveConfirmations,
  readExternalReceiveConfirmations
} from '@/core/wallet/transparent-history'
import { DedupPromise } from '@/lib/async-utils'
import { loadTransactions, mutateTransactions } from '@/lib/indexed-db'
import { getNetworkConfig } from '@/lib/runtime-network'
import type { Network, Transaction } from '@/types/wallet'

const refreshes = new Map<string, DedupPromise<Transaction[]>>()

export async function refreshZcashReceiveConfirmations(
  network: Network,
  walletId: string,
  accountId: string
): Promise<Transaction[]> {
  const accountKey = buildAccountKey(network, walletId, accountId)
  let refresh = refreshes.get(accountKey)
  if (!refresh) {
    refresh = new DedupPromise()
    refreshes.set(accountKey, refresh)
  }

  try {
    return await refresh.run(async () => {
      const baseUrl = getNetworkConfig(network).nodeRpcUrl
      const transactions = await loadTransactions(accountKey)
      if (!baseUrl) return transactions

      // Bound the whole batch, including the time spent waiting for an RPC slot.
      const observed = await readExternalReceiveConfirmations(
        transactions,
        baseUrl,
        AbortSignal.timeout(8_000)
      )
      if (applyExternalReceiveConfirmations(transactions, observed) === transactions) {
        return loadTransactions(accountKey)
      }

      let changed = false
      const updated = await mutateTransactions(accountKey, current => {
        const next = applyExternalReceiveConfirmations(current, observed)
        changed = next !== current
        return next
      })
      if (changed) {
        void chrome.runtime.sendMessage({ type: 'TRANSACTION_UPDATED', accountKey }).catch(() => {})
      }
      return updated
    })
  } finally {
    if (!refresh.isPending && refreshes.get(accountKey) === refresh) refreshes.delete(accountKey)
  }
}
