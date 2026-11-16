import { resolveKeyDomain } from '@/core/accounts/application'
import type { KeyDomainSource } from '@/core/keyring/domain'
import type { AccountNetworkFamily } from '@/core/wallet/account-network-selection'
import type { TransactionAccountScope } from '@/core/transactions/domain'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { isStoredAccountNetworkEnabledForSource } from '@/lib/wallet-metadata-storage'
import type { StorageV2ReadRepository } from '@/ports/repositories'

interface TransferAccountContext {
  readonly chainAccount: {
    readonly scope: {
      readonly keyDomainId: string
      readonly accountId: string
      readonly chainId: string
    }
  }
  readonly keyDomainSource: KeyDomainSource
}

export async function requireSelectedTransferNetwork<Context extends TransferAccountContext>(
  context: Context | null,
  family: AccountNetworkFamily
): Promise<Context | null> {
  if (!context) return null
  const { keyDomainId, accountId } = context.chainAccount.scope
  if (
    !(await isStoredAccountNetworkEnabledForSource(
      context.keyDomainSource,
      keyDomainId,
      accountId,
      DEFAULT_NETWORK,
      family,
      context.chainAccount.scope.chainId
    ))
  ) {
    throw new Error('The active Account has not enabled this network')
  }
  return context
}

export async function isSelectedTransferScope(
  repository: Pick<StorageV2ReadRepository, 'getActivePointer' | 'getSnapshot'>,
  scope: TransactionAccountScope,
  family: AccountNetworkFamily
): Promise<boolean> {
  const pointer = await repository.getActivePointer()
  if (!pointer) return false
  const snapshot = await repository.getSnapshot(pointer.generationId)
  if (!snapshot) return false
  if (
    snapshot.manifest.status !== 'verified' ||
    snapshot.manifest.generationId !== pointer.generationId ||
    snapshot.manifest.sourceFingerprint !== pointer.sourceFingerprint
  ) {
    throw new Error('Active Storage V2 generation does not match its pointer')
  }
  const account = snapshot.accounts.find(
    item => item.keyDomainId === scope.keyDomainId && item.id === scope.accountId
  )
  if (!account) return false
  const source = resolveKeyDomain(snapshot.keyDomains, scope.keyDomainId).source
  return isStoredAccountNetworkEnabledForSource(
    source,
    scope.keyDomainId,
    scope.accountId,
    DEFAULT_NETWORK,
    family
  )
}
