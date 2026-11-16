import type { Account, Address, ChainAccount } from '@/core/accounts/domain'
import {
  hasAvailableAddressCapability,
  hasCompleteChainCapabilities,
  type AddressGatedChainRegistry,
  type ChainRegistry,
  type ChainDefinition,
  type ReleaseGatedChainRegistry
} from '@/core/chains/registry'
import type { StorageV2GenerationId, StorageV2ReadRepository } from '@/ports/repositories'
import { createWalletSetCatalog, type WalletSetCatalog } from './wallet-set-catalog'
import {
  keySourceSupportsAddressFamily,
  keySourceSupportsChainFamily,
  resolveKeyDomain
} from './key-source-chain-policy'

type ActiveWalletSetRepository = Pick<StorageV2ReadRepository, 'getActivePointer' | 'getSnapshot'>

export interface AvailableChainAccount {
  readonly chain: ChainDefinition
  readonly chainAccount: ChainAccount
  readonly addresses: readonly Address[]
}

export interface ActiveWalletSetSnapshot {
  readonly generationId: StorageV2GenerationId
  readonly catalog: WalletSetCatalog
  readonly activeAccount: Account | null
  readonly availableChainAccounts: readonly AvailableChainAccount[]
}

export interface LoadActiveWalletSetInput {
  readonly repository: ActiveWalletSetRepository
  readonly chainRegistry: ReleaseGatedChainRegistry
}

export interface LoadActiveReceiveWalletSetInput {
  readonly repository: ActiveWalletSetRepository
  readonly chainRegistry: AddressGatedChainRegistry
}

function requireAvailableChainAccount(
  chain: ChainDefinition,
  chainAccount: ChainAccount,
  addresses: readonly Address[]
): AvailableChainAccount {
  if (!chain.capabilities.address.derivationSchemes.includes(chainAccount.derivation.scheme)) {
    throw new Error('Active ChainAccount uses an unavailable derivation scheme')
  }
  if (addresses.length === 0 || !addresses.some(address => address.preferredForReceive)) {
    throw new Error('Active ChainAccount has no preferred receive Address')
  }
  for (const address of addresses) {
    if (!chain.capabilities.address.addressSchemes.includes(address.scheme)) {
      throw new Error('Active ChainAccount uses an unavailable Address scheme')
    }
  }
  return Object.freeze({
    chain,
    chainAccount,
    addresses: Object.freeze([...addresses])
  })
}

async function loadActiveWalletSetForCapability(
  input: Readonly<{
    repository: ActiveWalletSetRepository
    chainRegistry: ChainRegistry
    isAvailable: (chain: ChainDefinition) => boolean
    sourceSupports: (
      source: Parameters<typeof keySourceSupportsChainFamily>[0],
      family: ChainDefinition['family']
    ) => boolean
  }>
): Promise<ActiveWalletSetSnapshot | null> {
  const pointer = await input.repository.getActivePointer()
  if (!pointer) return null

  const snapshot = await input.repository.getSnapshot(pointer.generationId)
  if (!snapshot) throw new Error('Active Storage V2 generation is missing')
  if (
    snapshot.manifest.status !== 'verified' ||
    snapshot.manifest.generationId !== pointer.generationId ||
    snapshot.manifest.sourceFingerprint !== pointer.sourceFingerprint
  ) {
    throw new Error('Active Storage V2 generation does not match its pointer')
  }

  const catalog = createWalletSetCatalog({
    keyDomains: snapshot.keyDomains,
    accounts: snapshot.accounts,
    mainKeyDomainId: snapshot.manifest.mainKeyDomainId ?? null,
    activeAccount: snapshot.manifest.activeAccount ?? null
  })
  const activeSelection = catalog.activeAccount
  const activeAccount = activeSelection
    ? (catalog.accounts.find(account => account.id === activeSelection.accountId) ?? null)
    : null
  const activeKeyDomain = activeSelection
    ? resolveKeyDomain(snapshot.keyDomains, activeSelection.keyDomainId)
    : null

  const availableChainAccounts = activeSelection
    ? snapshot.chainAccounts.flatMap(chainAccount => {
        if (
          chainAccount.scope.keyDomainId !== activeSelection.keyDomainId ||
          chainAccount.scope.accountId !== activeSelection.accountId
        ) {
          return []
        }
        const chain = input.chainRegistry.get(chainAccount.scope.chainId)
        if (
          !chain ||
          !activeKeyDomain ||
          !input.sourceSupports(activeKeyDomain.source, chain.family) ||
          !input.isAvailable(chain)
        ) {
          return []
        }
        const addresses = snapshot.addresses.filter(
          address => address.chainAccountId === chainAccount.id
        )
        return [requireAvailableChainAccount(chain, chainAccount, addresses)]
      })
    : []

  return Object.freeze({
    generationId: pointer.generationId,
    catalog,
    activeAccount,
    availableChainAccounts: Object.freeze(availableChainAccounts)
  })
}

export function loadActiveWalletSet(
  input: LoadActiveWalletSetInput
): Promise<ActiveWalletSetSnapshot | null> {
  return loadActiveWalletSetForCapability({
    ...input,
    isAvailable: hasCompleteChainCapabilities,
    sourceSupports: keySourceSupportsChainFamily
  })
}

export function loadActiveReceiveWalletSet(
  input: LoadActiveReceiveWalletSetInput
): Promise<ActiveWalletSetSnapshot | null> {
  return loadActiveWalletSetForCapability({
    ...input,
    isAvailable: hasAvailableAddressCapability,
    sourceSupports: keySourceSupportsAddressFamily
  })
}
