import type { TransactionAccountScope } from '@/core/transactions/domain'
import type { Network } from '@/types'

export interface RheaSwapZcashSyncDependencies {
  readonly getNetwork: () => Network
  readonly accountExists: (walletId: string, accountId: string) => boolean
  readonly getActiveScope: () => {
    readonly network: Network
    readonly walletId: string | null
    readonly accountId: string | null
  }
  readonly markNeedsCatchUp: (walletId: string, accountId: string) => Promise<void>
  readonly catchUp: (walletId: string, accountId: string) => Promise<unknown>
  readonly onCatchUpError: (error: unknown) => void
}

export async function prepareRheaSwapZcashDestinationCatchUp(
  scope: TransactionAccountScope,
  dependencies: RheaSwapZcashSyncDependencies
): Promise<void> {
  if (
    dependencies.getNetwork() !== 'mainnet' ||
    dependencies.getActiveScope().network !== 'mainnet'
  ) {
    throw new Error('RHEA Swap Zcash catch-up requires Mainnet')
  }

  const walletId = scope.keyDomainId
  const accountId = scope.accountId
  if (!dependencies.accountExists(walletId, accountId)) return

  await dependencies.markNeedsCatchUp(walletId, accountId)

  const active = dependencies.getActiveScope()
  if (
    dependencies.getNetwork() !== 'mainnet' ||
    active.network !== 'mainnet' ||
    active.walletId !== walletId ||
    active.accountId !== accountId ||
    !dependencies.accountExists(walletId, accountId)
  ) {
    return
  }

  void dependencies.catchUp(walletId, accountId).catch(dependencies.onCatchUpError)
}
