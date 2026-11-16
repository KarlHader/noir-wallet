import { keySourceSupportsChainFamily, resolveKeyDomain } from '@/core/accounts/application'
import type { Account, Address, ChainAccount } from '@/core/accounts/domain'
import type { ChainDefinition } from '@/core/chains/registry'
import type { AccountRef } from '@/core/dapp/dapp-manager'
import { formatWalletNameAtIndex, getAccountDisplayName } from '@/lib/format'
import type { StorageV2ReadRepository, StorageV2Snapshot } from '@/ports/repositories'
import type { KeyDomainSource } from '@/core/keyring/domain'
import type { AccountNetworkFamily } from '@/core/wallet/account-network-selection'
import { isStoredAccountNetworkEnabledForSource } from '@/lib/wallet-metadata-storage'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'

type DAppAccountCatalogRepository = Pick<
  StorageV2ReadRepository,
  'getActivePointer' | 'getSnapshot'
>

export interface DAppChainAccountDescriptor {
  readonly id: string
  readonly label: string
  readonly reference: AccountRef
  readonly address: string
  readonly messageSigningSupported?: boolean
}

interface DAppChainAccountAddressContext {
  readonly account: Account
  readonly chainAccount: ChainAccount
  readonly addresses: readonly Address[]
  readonly snapshot: StorageV2Snapshot
}

interface ListDAppChainAccountsOptions {
  readonly repository: DAppAccountCatalogRepository
  readonly chainId: string
  readonly family: ChainDefinition['family']
  readonly isNetworkEnabled?: (
    source: KeyDomainSource,
    walletId: string,
    accountId: string,
    family: AccountNetworkFamily,
    chainId: string
  ) => boolean | Promise<boolean>
  readonly resolveAddress: (
    context: DAppChainAccountAddressContext
  ) => string | null | Promise<string | null>
}

export async function filterEnabledDAppContext<
  T extends {
    readonly chainAccount: ChainAccount
    readonly keyDomainSource: KeyDomainSource
  }
>(context: T | null, family: AccountNetworkFamily): Promise<T | null> {
  if (!context) return null
  return (await isStoredAccountNetworkEnabledForSource(
    context.keyDomainSource,
    context.chainAccount.scope.keyDomainId,
    context.chainAccount.scope.accountId,
    DEFAULT_NETWORK,
    family,
    context.chainAccount.scope.chainId
  ))
    ? context
    : null
}

export const isDAppNetworkEnabled = (
  source: KeyDomainSource,
  walletId: string,
  accountId: string,
  family: AccountNetworkFamily,
  chainId: string
): Promise<boolean> =>
  isStoredAccountNetworkEnabledForSource(
    source,
    walletId,
    accountId,
    DEFAULT_NETWORK,
    family,
    chainId
  )

function descriptorId(reference: AccountRef): string {
  return JSON.stringify([reference.walletId, reference.accountId])
}

export async function listDAppChainAccounts(
  options: ListDAppChainAccountsOptions
): Promise<readonly DAppChainAccountDescriptor[]> {
  const pointer = await options.repository.getActivePointer()
  if (!pointer) return Object.freeze([])
  const snapshot = await options.repository.getSnapshot(pointer.generationId)
  if (!snapshot) throw new Error('Active Storage V2 generation is missing')
  if (
    snapshot.manifest.status !== 'verified' ||
    snapshot.manifest.generationId !== pointer.generationId ||
    snapshot.manifest.sourceFingerprint !== pointer.sourceFingerprint
  ) {
    throw new Error('Active Storage V2 generation does not match its pointer')
  }

  const descriptors: DAppChainAccountDescriptor[] = []
  const keyDomainOrder = [...snapshot.keyDomains].sort(
    (left, right) =>
      left.createdAt - right.createdAt || String(left.id).localeCompare(String(right.id))
  )
  for (const account of snapshot.accounts) {
    const keyDomain = resolveKeyDomain(snapshot.keyDomains, account.keyDomainId)
    if (!keySourceSupportsChainFamily(keyDomain.source, options.family)) continue
    const candidates = snapshot.chainAccounts.filter(
      chainAccount =>
        chainAccount.scope.keyDomainId === account.keyDomainId &&
        chainAccount.scope.accountId === account.id &&
        chainAccount.scope.chainId === options.chainId
    )
    if (candidates.length === 0) continue
    if (candidates.length !== 1) {
      throw new Error(`${account.displayName} has ambiguous ${options.family} ChainAccounts`)
    }
    if (
      options.isNetworkEnabled &&
      !(await options.isNetworkEnabled(
        keyDomain.source,
        account.keyDomainId,
        account.id,
        options.family,
        options.chainId
      ))
    ) {
      continue
    }
    const chainAccount = candidates[0]
    const address = await options.resolveAddress({
      account,
      chainAccount,
      addresses: snapshot.addresses.filter(item => item.chainAccountId === chainAccount.id),
      snapshot
    })
    if (!address) continue
    const reference = Object.freeze({
      walletId: String(account.keyDomainId),
      accountId: String(account.id)
    })
    descriptors.push(
      Object.freeze({
        id: descriptorId(reference),
        label: `${formatWalletNameAtIndex(
          keyDomain.displayName,
          keyDomainOrder.findIndex(item => item.id === keyDomain.id)
        )} · ${getAccountDisplayName(
          String(account.keyDomainId),
          String(account.id),
          account.displayName,
          {}
        )}`,
        reference,
        address,
        ...(options.family === 'solana'
          ? {
              messageSigningSupported:
                keyDomain.source.kind === 'software' || keyDomain.source.kind === 'private-key'
            }
          : {})
      })
    )
  }
  return Object.freeze(descriptors)
}
