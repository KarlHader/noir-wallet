import { PearlProviderError } from '@/core/dapp/pearl-provider'
import { keySourceSupportsChainFamily, resolveKeyDomain } from '@/core/accounts/application'
import { parseAccountId } from '@/core/accounts/domain'
import {
  getBitcoinChainId,
  getPearlChainId,
  getZcashChainId,
  parseChainId
} from '@/core/chains/registry'
import { parseKeyDomainId } from '@/core/keyring/domain'
import {
  loadActivePearlDiscoveryContext,
  type PearlDiscoveryStorageRepository
} from '@/infrastructure/chains/pearl'
import type { NetworkAccountMetadataInput } from '@/infrastructure/keyring/network-account-metadata-coordinator'
import type { DerivedPearlAddress } from '@/core/chains/pearl'
import type { AccountAddresses, Network } from '@/types'
import type { DerivedBitcoinAddress } from '@/core/chains/bitcoin'

export interface EnsureActiveSoftwarePearlNetworkAccountOptions {
  readonly network: Network
  readonly storageRepository: PearlDiscoveryStorageRepository
  readonly hasUnlockSession: () => Promise<boolean>
  readonly synchronizeSoftwareWalletNetworkMetadata: () => Promise<void>
  readonly synchronizeNetworkAccountMetadata: (
    values: readonly NetworkAccountMetadataInput[]
  ) => Promise<unknown>
  readonly deriveBitcoinAddress: (
    keyDomainId: string,
    input: {
      readonly chainId: string
      readonly addressType: 'p2wpkh'
      readonly accountIndex: number
      readonly change: boolean
      readonly addressIndex: number
    }
  ) => Promise<DerivedBitcoinAddress>
  readonly derivePearlAddress: (
    keyDomainId: string,
    input: {
      readonly chainId: string
      readonly accountIndex: number
      readonly change: boolean
      readonly addressIndex: number
    }
  ) => Promise<DerivedPearlAddress>
}

function readZcashAddresses(
  snapshot: {
    readonly chainAccounts: readonly {
      readonly id: string
      readonly scope: {
        readonly keyDomainId: string
        readonly accountId: string
        readonly chainId: string
      }
    }[]
    readonly addresses: readonly {
      readonly chainAccountId: string
      readonly scheme: string
      readonly value: string
    }[]
  },
  keyDomainId: string,
  accountId: string,
  zcashChainId: string
): AccountAddresses | null {
  const chainAccount = snapshot.chainAccounts.find(
    candidate =>
      candidate.scope.keyDomainId === keyDomainId &&
      candidate.scope.accountId === accountId &&
      candidate.scope.chainId === zcashChainId
  )
  if (!chainAccount) return null
  const addresses = snapshot.addresses.filter(address => address.chainAccountId === chainAccount.id)
  const transparent = addresses.find(address => address.scheme === 'zcash-transparent-p2pkh')?.value
  const shielded = addresses.find(address => address.scheme === 'zcash-shielded-unified')?.value
  const fullUnified = addresses.find(address => address.scheme === 'zcash-full-unified')?.value
  if (!transparent || !shielded) return null
  return Object.freeze({
    transparent,
    shielded,
    ...(fullUnified === undefined ? {} : { fullUnified })
  })
}

function readBitcoinAddress(
  snapshot: {
    readonly chainAccounts: readonly {
      readonly id: string
      readonly scope: {
        readonly keyDomainId: string
        readonly accountId: string
        readonly chainId: string
      }
      readonly derivation: { readonly scheme: string; readonly path: string }
    }[]
    readonly addresses: readonly {
      readonly chainAccountId: string
      readonly scheme: string
      readonly value: string
      readonly derivation?: { readonly scheme: string; readonly path: string }
    }[]
  },
  keyDomainId: string,
  accountId: string,
  bitcoinChainId: string,
  accountIndex: number
): DerivedBitcoinAddress | null {
  const chainAccount = snapshot.chainAccounts.find(
    candidate =>
      candidate.scope.keyDomainId === keyDomainId &&
      candidate.scope.accountId === accountId &&
      candidate.scope.chainId === bitcoinChainId
  )
  if (!chainAccount) return null
  const address =
    snapshot.addresses.find(
      candidate =>
        candidate.chainAccountId === chainAccount.id &&
        candidate.scheme === 'bitcoin-p2wpkh' &&
        (candidate.derivation?.path?.endsWith('/0/0') ?? false)
    ) ??
    snapshot.addresses.find(
      candidate =>
        candidate.chainAccountId === chainAccount.id && candidate.scheme === 'bitcoin-p2wpkh'
    )
  if (!address) return null
  const coinType = bitcoinChainId.endsWith('000000000019d6689c085ae165831e93') ? 0 : 1
  return Object.freeze({
    chainId: parseChainId(bitcoinChainId).id,
    addressType: 'p2wpkh' as const,
    accountIndex,
    change: false,
    addressIndex: 0,
    address: address.value,
    addressScheme: 'bitcoin-p2wpkh' as const,
    derivationScheme: 'bip84' as const,
    derivationPath: address.derivation?.path ?? `m/84'/${coinType}'/${accountIndex}'/0/0`,
    // Existing Bitcoin ChainAccounts are matched by identity address; these
    // fields are only required to satisfy the shared metadata input shape.
    publicKey: `0x02${'11'.repeat(32)}`,
    masterFingerprint: '0x12345678'
  })
}

function describeActivePearlGap(
  snapshot: {
    readonly keyDomains: readonly {
      readonly id: string
      readonly source: { readonly kind: string }
    }[]
    readonly chainAccounts: readonly {
      readonly scope: {
        readonly chainId: string
        readonly keyDomainId: string
        readonly accountId: string
      }
    }[]
    readonly manifest: {
      readonly activeAccount?: { readonly keyDomainId: string; readonly accountId: string }
    }
  },
  pearlChainId: string
): string {
  const active = snapshot.manifest.activeAccount
  if (!active) return 'no active account'
  const keyDomain = snapshot.keyDomains.find(item => item.id === active.keyDomainId)
  const chainIds = snapshot.chainAccounts
    .filter(
      account =>
        account.scope.keyDomainId === active.keyDomainId &&
        account.scope.accountId === active.accountId
    )
    .map(account => account.scope.chainId)
  return `active=${active.keyDomainId}/${active.accountId}; source=${keyDomain?.source.kind ?? 'missing'}; chains=${chainIds.join(',') || 'none'}; want=${pearlChainId}`
}

/**
 * Ensures the active software Account has a Pearl ChainAccount for the current
 * network. Seeds Pearl from existing Zcash/Bitcoin Storage V2 addresses first,
 * then falls back to the shared software-wallet metadata sync.
 */
export async function ensureActiveSoftwarePearlNetworkAccount(
  options: EnsureActiveSoftwarePearlNetworkAccountOptions
): Promise<void> {
  const pearlChainId = parseChainId(getPearlChainId(options.network)).id
  if (await loadActivePearlDiscoveryContext(options.storageRepository, pearlChainId)) return

  if (!(await options.hasUnlockSession())) {
    throw new PearlProviderError(4100, 'Unlock Noir Wallet before connecting this site.')
  }

  const pointer = await options.storageRepository.getActivePointer()
  if (!pointer) {
    throw new PearlProviderError(4100, 'Wallet storage is unavailable for Pearl.')
  }
  const snapshot = await options.storageRepository.getSnapshot(pointer.generationId)
  if (!snapshot) {
    throw new PearlProviderError(4100, 'Active wallet storage is missing for Pearl.')
  }
  const active = snapshot.manifest.activeAccount
  if (!active) {
    throw new PearlProviderError(4100, 'No active account is selected.')
  }
  const keyDomain = resolveKeyDomain(snapshot.keyDomains, active.keyDomainId)
  if (!keySourceSupportsChainFamily(keyDomain.source, 'pearl')) {
    throw new PearlProviderError(
      4100,
      `The active wallet does not support Pearl (${describeActivePearlGap(snapshot, pearlChainId)}).`
    )
  }
  if (keyDomain.source.kind !== 'software') {
    throw new PearlProviderError(
      4100,
      `The active wallet has no Pearl account (${describeActivePearlGap(snapshot, pearlChainId)}).`
    )
  }
  const accounts = snapshot.accounts.filter(
    account => account.id === active.accountId && account.keyDomainId === active.keyDomainId
  )
  if (accounts.length !== 1) {
    throw new PearlProviderError(4100, 'Active account metadata is missing or ambiguous.')
  }
  const account = accounts[0]
  const zcashChainId = parseChainId(getZcashChainId(options.network)).id
  const bitcoinChainId = parseChainId(getBitcoinChainId(options.network)).id
  const zcashAddresses = readZcashAddresses(
    snapshot,
    active.keyDomainId,
    active.accountId,
    zcashChainId
  )

  if (zcashAddresses) {
    try {
      const bitcoin =
        readBitcoinAddress(
          snapshot,
          active.keyDomainId,
          active.accountId,
          bitcoinChainId,
          account.accountIndex
        ) ??
        (await options.deriveBitcoinAddress(active.keyDomainId, {
          chainId: bitcoinChainId,
          addressType: 'p2wpkh',
          accountIndex: account.accountIndex,
          change: false,
          addressIndex: 0
        }))
      const pearl = await options.derivePearlAddress(active.keyDomainId, {
        chainId: pearlChainId,
        accountIndex: account.accountIndex,
        change: false,
        addressIndex: 0
      })
      console.warn('[Pearl] Provisioning Pearl ChainAccount from Storage V2 snapshot', {
        network: options.network,
        pearlChainId,
        accountIndex: account.accountIndex
      })
      await options.synchronizeNetworkAccountMetadata([
        {
          keyDomainId: parseKeyDomainId(active.keyDomainId),
          accountId: parseAccountId(active.accountId),
          accountIndex: account.accountIndex,
          zcashNetwork: options.network,
          zcashChainId,
          zcashAddresses,
          bitcoin,
          pearl
        }
      ])
    } catch (error) {
      console.warn('[Pearl] Snapshot Pearl provisioning failed', error)
      throw new PearlProviderError(
        4100,
        error instanceof Error
          ? `Pearl provisioning failed: ${error.message}`
          : 'Unable to derive a Pearl account for the active wallet.'
      )
    }
    if (await loadActivePearlDiscoveryContext(options.storageRepository, pearlChainId)) return
  }

  try {
    console.warn('[Pearl] Falling back to software wallet network metadata sync', {
      network: options.network,
      pearlChainId
    })
    await options.synchronizeSoftwareWalletNetworkMetadata()
  } catch (error) {
    console.warn('[Pearl] Software wallet network metadata sync failed', error)
    throw new PearlProviderError(
      4100,
      error instanceof Error
        ? `Pearl metadata sync failed: ${error.message}`
        : 'Unable to synchronize software wallet network metadata for Pearl.'
    )
  }

  if (await loadActivePearlDiscoveryContext(options.storageRepository, pearlChainId)) return

  const latestPointer = await options.storageRepository.getActivePointer()
  const latestSnapshot = latestPointer
    ? await options.storageRepository.getSnapshot(latestPointer.generationId)
    : null
  throw new PearlProviderError(
    4100,
    `The active wallet has no Pearl account after provisioning (${
      latestSnapshot
        ? describeActivePearlGap(latestSnapshot, pearlChainId)
        : describeActivePearlGap(snapshot, pearlChainId)
    }).`
  )
}
