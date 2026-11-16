import { DedupPromise } from '../lib/async-utils.ts'
import { normalizeTxHash } from '../lib/tx-history-dedup.ts'
import { buildAccountKey } from '../core/wallet/account-scope.ts'
import type { Network, Transaction } from '../types/wallet.ts'

interface RecoveryDependencies {
  isActive(network: Network, walletId: string, accountId: string): boolean
  getOwnedAddresses(walletId: string): ReadonlySet<string>
  load(accountKey: string): Promise<Transaction[]>
  lookup(
    transactions: Transaction[],
    ownedAddresses: ReadonlySet<string>,
    network: Network,
    accountKey: string,
    signal: AbortSignal
  ): Promise<Map<string, string>>
  mutate(
    accountKey: string,
    update: (current: Transaction[]) => Transaction[],
    signal: AbortSignal
  ): Promise<unknown>
  notify(accountKey: string): Promise<void>
}

/** Account-scoped background lookups must stop when their runtime context is invalidated. */
export class TransactionRecipientRecovery {
  private readonly inFlight = new Map<
    string,
    {
      walletId: string
      accountId: string
      operation: DedupPromise<void>
      controller: AbortController
    }
  >()

  constructor(private readonly dependencies: RecoveryDependencies) {}

  cancel(walletId?: string, accountId?: string): void {
    for (const [key, recovery] of this.inFlight) {
      if (
        !walletId ||
        (recovery.walletId === walletId && (!accountId || recovery.accountId === accountId))
      ) {
        recovery.controller.abort()
        this.inFlight.delete(key)
      }
    }
  }

  async recover(network: Network, walletId: string, accountId: string): Promise<void> {
    const active = () => this.dependencies.isActive(network, walletId, accountId)
    if (!active()) return
    const accountKey = buildAccountKey(network, walletId, accountId)
    let recovery = this.inFlight.get(accountKey)
    if (!recovery) {
      recovery = {
        walletId,
        accountId,
        operation: new DedupPromise<void>(),
        controller: new AbortController()
      }
      this.inFlight.set(accountKey, recovery)
    }
    const signal = recovery.controller.signal
    try {
      await recovery.operation.run(async () => {
        const transactions = await this.dependencies.load(accountKey)
        if (signal.aborted || !active()) return
        const recipients = await this.dependencies.lookup(
          transactions,
          this.dependencies.getOwnedAddresses(walletId),
          network,
          accountKey,
          signal
        )
        if (recipients.size === 0 || signal.aborted || !active()) return
        const originalAmounts = new Map(
          transactions
            .filter(transaction => transaction.type === 'send' && !transaction.to)
            .map(transaction => [normalizeTxHash(transaction.txHash), transaction.amount])
        )
        let changed = false
        await this.dependencies.mutate(
          accountKey,
          current => {
            if (signal.aborted || !active()) return current
            return current.map(transaction => {
              const hash = normalizeTxHash(transaction.txHash)
              if (
                transaction.type !== 'send' ||
                transaction.to ||
                originalAmounts.get(hash) !== transaction.amount
              )
                return transaction
              const recipient = recipients.get(hash)
              if (!recipient) return transaction
              changed = true
              return { ...transaction, to: recipient }
            })
          },
          signal
        )
        if (changed && !signal.aborted && active()) await this.dependencies.notify(accountKey)
      })
    } catch (error) {
      if (!signal.aborted) throw error
    } finally {
      if (!recovery.operation.isPending && this.inFlight.get(accountKey) === recovery) {
        this.inFlight.delete(accountKey)
      }
    }
  }
}
