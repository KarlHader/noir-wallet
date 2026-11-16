import type {
  V1DiscoveredWallet,
  V1MetadataDiscovery
} from '@/infrastructure/persistence/migrations'
import { bytesToHex } from '@/lib/bytes'
import {
  type CredentialRepository,
  type CredentialSetRecord,
  type CredentialTransactionJournal,
  type CredentialTransactionPhase,
  type EncryptedCredentialEnvelopeRecord,
  type StorageV2Repository,
  type StorageV2Snapshot
} from '@/ports/repositories'
import { parseRawEncryptedVault } from '../multichain/raw-wallet-engine'
import { CompatibilityWorkerHost } from './compatibility-worker-host'
import type { CompatibilityWorkerResult } from './compatibility-worker-protocol'
import type { RetainedV1EnvelopeStorage } from './retained-v1-password-change'
import type { RetainedV1MigrationChainProfile } from './retained-v1-migration-coordinator'

export interface CompatibilityPasswordChangePort {
  migrate(
    input: Parameters<CompatibilityWorkerHost['migrate']>[0],
    timeoutMs?: number
  ): Promise<CompatibilityWorkerResult>
}

export interface CredentialPasswordChangeInput {
  readonly discovery: V1MetadataDiscovery
  readonly credentialEnvelopes: Readonly<Record<string, unknown>>
  readonly currentPassword: string
  readonly newPassword: string
  readonly chains: RetainedV1MigrationChainProfile
}

export interface CredentialPasswordChangeResult {
  readonly status: 'committed' | 'recovered'
  readonly generationId: string
  readonly transactionId: string
  readonly changedKeyDomainIds: readonly string[]
}

export interface CredentialPasswordChangeCoordinatorOptions {
  readonly credentialRepository: CredentialRepository
  readonly storageRepository: StorageV2Repository
  readonly compatibilityWorker?: CompatibilityPasswordChangePort
  readonly retainedV1Storage?: RetainedV1EnvelopeStorage
  readonly now?: () => number
}

export interface PreparedPasswordChange {
  readonly wallet: PasswordChangeWallet
  readonly sourceSet: CredentialSetRecord
  readonly targetSet: CredentialSetRecord
  readonly engineEnvelopes: readonly EncryptedCredentialEnvelopeRecord[]
}

export interface PasswordChangeWallet {
  readonly id: string
  readonly source: 'software' | 'private-key' | 'hardware'
  readonly retainedV1: V1DiscoveredWallet | null
}

export function assertPasswordChangeCredentialInventorySupported(
  discovery: V1MetadataDiscovery,
  snapshot: StorageV2Snapshot
): void {
  if (discovery.status !== 'ready' && discovery.status !== 'empty') {
    throw new Error(`V1 password-change metadata is not ready: ${discovery.status}`)
  }
  const discovered = new Map(discovery.wallets.map(wallet => [wallet.id, wallet]))
  if (
    discovered.size !== discovery.wallets.length ||
    discovery.wallets.some(wallet => {
      const keyDomain = snapshot.keyDomains.find(item => item.id === wallet.id)
      return (
        keyDomain === undefined ||
        (wallet.keySource === 'software') !== (keyDomain.source.kind === 'software')
      )
    }) ||
    snapshot.keyDomains.some(keyDomain => {
      const wallet = discovered.get(keyDomain.id)
      if (wallet) return false
      return (
        keyDomain.source.kind === 'software' ||
        (keyDomain.source.kind === 'private-key' &&
          !keyDomain.id.startsWith('wallet:private-key-v2:')) ||
        (keyDomain.source.kind === 'hardware' && !isNativeHardwareWalletId(keyDomain.id))
      )
    })
  ) {
    throw new Error('V1 and Storage V2 password-change Wallet inventories differ')
  }
}

export type SoftwareCredentialSetRecord = CredentialSetRecord & {
  readonly manifest: Extract<CredentialSetRecord['manifest'], { readonly source: 'software' }>
}

const TEXT_ENCODER = new TextEncoder()

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', TEXT_ENCODER.encode(value))
  return bytesToHex(new Uint8Array(digest))
}

export function encodeVault(value: unknown): Uint8Array {
  return TEXT_ENCODER.encode(JSON.stringify(parseRawEncryptedVault(value)))
}

export function decodeVault(value: Uint8Array) {
  try {
    return parseRawEncryptedVault(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value))
    )
  } catch {
    throw new Error('Invalid staged Multichain credential envelope')
  }
}

export function assertAdvanced(status: string, label: string): void {
  if (status !== 'advanced' && status !== 'already-applied') {
    throw new Error(`${label} failed: ${status}`)
  }
}

export function nextJournal(
  journal: CredentialTransactionJournal,
  phase: CredentialTransactionPhase,
  updatedAt: number
): CredentialTransactionJournal {
  return Object.freeze({
    ...journal,
    phase,
    revision: journal.revision + 1,
    updatedAt: Math.max(journal.updatedAt, updatedAt)
  })
}

export function softwareWalletsForSnapshot(
  discovery: V1MetadataDiscovery,
  snapshot: StorageV2Snapshot
): readonly V1DiscoveredWallet[] {
  if (discovery.status !== 'ready') {
    throw new Error(`V1 password-change metadata is not ready: ${discovery.status}`)
  }
  const walletsById = new Map(
    discovery.wallets
      .filter(wallet => wallet.keySource === 'software')
      .map(wallet => [wallet.id, wallet])
  )
  const softwareKeyDomains = snapshot.keyDomains.filter(
    keyDomain => keyDomain.source.kind === 'software'
  )
  if (
    walletsById.size !== softwareKeyDomains.length ||
    softwareKeyDomains.some(keyDomain => !walletsById.has(keyDomain.id))
  ) {
    throw new Error('V1 and Storage V2 software Wallet inventories differ')
  }
  return Object.freeze(softwareKeyDomains.map(keyDomain => walletsById.get(keyDomain.id)!))
}

export function walletsForPasswordChange(
  discovery: V1MetadataDiscovery,
  snapshot: StorageV2Snapshot
): readonly PasswordChangeWallet[] {
  assertPasswordChangeCredentialInventorySupported(discovery, snapshot)
  const wallets = new Map(discovery.wallets.map(wallet => [wallet.id, wallet]))
  return Object.freeze(
    snapshot.keyDomains.map(keyDomain => {
      const wallet = wallets.get(keyDomain.id)
      return Object.freeze({
        id: keyDomain.id,
        source: keyDomain.source.kind,
        retainedV1: wallet ?? null
      })
    })
  )
}

export function assertAccountAnchors(
  snapshot: StorageV2Snapshot,
  wallet: V1DiscoveredWallet,
  result: CompatibilityWorkerResult,
  chains: RetainedV1MigrationChainProfile
): void {
  if (result.accounts.length !== wallet.accounts.length) {
    throw new Error('Compatibility Worker returned an incomplete Account set')
  }
  for (const account of wallet.accounts) {
    const storedAccount = snapshot.accounts.find(
      item => item.keyDomainId === wallet.id && item.accountIndex === account.accountIndex
    )
    const derived = result.accounts.find(item => item.accountIndex === account.accountIndex)
    if (!storedAccount || !derived) throw new Error('Password-change Account anchor is missing')

    for (const [engine, chainId] of [
      ['zcash', chains.zcashChainId],
      ['evm', chains.evmChainId],
      ['bitcoin', chains.bitcoinChainId]
    ] as const) {
      const stored = snapshot.chainAccounts.find(
        item => item.scope.accountId === storedAccount.id && item.scope.chainId === chainId
      )
      const actual = derived[engine]
      if (
        !stored ||
        actual.chainId !== chainId ||
        actual.identity !== stored.identity.value ||
        actual.derivationPath !== stored.derivation.path
      ) {
        throw new Error(`Password-change ${engine} verification anchor mismatch`)
      }
    }
  }
}

export function workerAccounts(wallet: V1DiscoveredWallet) {
  return wallet.accounts.map(account => ({
    accountIndex: account.accountIndex,
    expectedZcash: account.addresses
  }))
}
import { isNativeHardwareWalletId } from '@/core/wallet/native-hardware-identity'
