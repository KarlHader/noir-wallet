import {
  applyLocalZcashActivityWrite,
  type LocalZcashActivityWrite
} from '../../../core/wallet/local-zcash-activity.ts'
import { mutateTransactions } from '../../../lib/indexed-db.ts'
import type { Transaction } from '../../../types/wallet.ts'
import type { TransactionRepository } from '../../../ports/repositories/transaction-repository'
import type { IndexedDbTransactionRepository } from './indexed-db-transaction-repository'

type GraphWriteMethods = Pick<
  TransactionRepository,
  'create' | 'applySegmentEvent' | 'backfillConfidentialEvmOrigin'
> &
  Pick<IndexedDbTransactionRepository, 'backfillRheaWithdrawActivity'>

type GraphWriteKind = keyof GraphWriteMethods
type GraphWrite<Kind extends GraphWriteKind = GraphWriteKind> = {
  [Action in Kind]: [
    kind: Action,
    repository: Pick<GraphWriteMethods, Action>,
    ...input: Parameters<GraphWriteMethods[Action]>
  ]
}[Kind]
type LegacyWrite = [
  kind: 'legacy-zcash',
  accountKey: string,
  write: LocalZcashActivityWrite,
  options?: { signal?: AbortSignal; isActive?: () => boolean }
]

export function writeLocalActivity(...write: LegacyWrite): ReturnType<typeof writeLegacyActivity>
export function writeLocalActivity(
  ...write: GraphWrite<'create'>
): ReturnType<GraphWriteMethods['create']>
export function writeLocalActivity(
  ...write: GraphWrite<'applySegmentEvent'>
): ReturnType<GraphWriteMethods['applySegmentEvent']>
export function writeLocalActivity(
  ...write: GraphWrite<'backfillConfidentialEvmOrigin'>
): ReturnType<GraphWriteMethods['backfillConfidentialEvmOrigin']>
export function writeLocalActivity(
  ...write: GraphWrite<'backfillRheaWithdrawActivity'>
): ReturnType<GraphWriteMethods['backfillRheaWithdrawActivity']>
export function writeLocalActivity(...write: LegacyWrite | GraphWrite) {
  switch (write[0]) {
    case 'legacy-zcash':
      return writeLegacyActivity(write[1], write[2], write[3])
    case 'create':
      return write[1].create(write[2])
    case 'applySegmentEvent':
      return write[1].applySegmentEvent(write[2])
    case 'backfillConfidentialEvmOrigin':
      return write[1].backfillConfidentialEvmOrigin(write[2])
    case 'backfillRheaWithdrawActivity':
      return write[1].backfillRheaWithdrawActivity(write[2], write[3], write[4], write[5], write[6])
  }
}

async function writeLegacyActivity(
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
