import {
  applyLocalZcashActivityWrite,
  type LocalZcashActivityWrite
} from '../../../core/wallet/local-zcash-activity.ts'
import { mutateTransactions } from '../../../lib/indexed-db.ts'
import type { Transaction } from '../../../types/wallet.ts'

export async function writeLocalZcashActivity(
  accountKey: string,
  write: LocalZcashActivityWrite,
  options: { signal?: AbortSignal; isActive?: () => boolean } = {}
) {
  let previous: Transaction[] = []
  let newWasmTransactionCount = 0
  const transactions = await mutateTransactions(
    accountKey,
    current => {
      previous = current
      if (options.isActive && !options.isActive()) return current
      const result = applyLocalZcashActivityWrite(current, write)
      newWasmTransactionCount = result.newWasmTransactionCount ?? 0
      return result.transactions
    },
    options.signal
  )
  return { transactions, previous, changed: transactions !== previous, newWasmTransactionCount }
}
