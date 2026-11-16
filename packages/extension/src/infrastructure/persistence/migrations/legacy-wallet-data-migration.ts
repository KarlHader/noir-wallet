import {
  LEGACY_WALLET_DATA_KEY,
  LEGACY_WALLET_DATA_MIGRATION_KEY,
  V1_WALLET_STATE_KEY,
  createLegacyWalletStateEnvelope,
  discoverV1Metadata,
  type LegacyWalletDataMigrationRecord,
  type V1MetadataDiscovery
} from './v1-metadata-discovery'
import { bytesToHex } from '@/lib/bytes'

export interface LegacyWalletDataMigrationStorage {
  getAll(): Promise<Readonly<Record<string, unknown>>>
  set(values: Readonly<Record<string, unknown>>): Promise<void>
}

export interface LegacyWalletDataMigrationResult {
  readonly status: 'not-needed' | 'retained' | 'quarantined'
  readonly targetWritten: boolean
  readonly reason?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function fingerprintV1Source(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
}

function createRecord(
  status: LegacyWalletDataMigrationRecord['status'],
  sourceFingerprint: string,
  discoveredAt: number,
  reason: string,
  verifiedAt?: number
): LegacyWalletDataMigrationRecord {
  return Object.freeze({
    schemaVersion: 1,
    sourceKey: LEGACY_WALLET_DATA_KEY,
    targetKey: V1_WALLET_STATE_KEY,
    status,
    sourceFingerprint,
    discoveredAt,
    ...(verifiedAt === undefined ? {} : { verifiedAt }),
    reason
  })
}

function hasStagedRecord(value: unknown, sourceFingerprint: string): boolean {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    value.sourceKey === LEGACY_WALLET_DATA_KEY &&
    value.targetKey === V1_WALLET_STATE_KEY &&
    value.status === 'staged' &&
    value.sourceFingerprint === sourceFingerprint
  )
}

function getRetainedRecordReason(value: unknown, sourceFingerprint: string): string | undefined {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.sourceKey !== LEGACY_WALLET_DATA_KEY ||
    value.targetKey !== V1_WALLET_STATE_KEY ||
    value.status !== 'retained' ||
    value.sourceFingerprint !== sourceFingerprint ||
    typeof value.verifiedAt !== 'number' ||
    typeof value.reason !== 'string'
  ) {
    return undefined
  }
  return value.reason
}

function discoveriesMatch(source: V1MetadataDiscovery, target: V1MetadataDiscovery): boolean {
  if (source.status !== 'ready' || target.status !== 'ready') return false
  if (
    source.currentWalletId !== target.currentWalletId ||
    source.currentAccountId !== target.currentAccountId ||
    source.wallets.length !== target.wallets.length
  ) {
    return false
  }

  return source.wallets.every((wallet, walletIndex) => {
    const targetWallet = target.wallets[walletIndex]
    return (
      targetWallet !== undefined &&
      wallet.id === targetWallet.id &&
      wallet.displayName === targetWallet.displayName &&
      wallet.keySource === targetWallet.keySource &&
      wallet.credentialStorageKey === targetWallet.credentialStorageKey &&
      wallet.createdAt === targetWallet.createdAt &&
      wallet.accounts.length === targetWallet.accounts.length &&
      wallet.accounts.every((account, accountIndex) => {
        const targetAccount = targetWallet.accounts[accountIndex]
        return (
          targetAccount !== undefined &&
          account.id === targetAccount.id &&
          account.displayName === targetAccount.displayName &&
          account.accountIndex === targetAccount.accountIndex &&
          account.birthdayHeight === targetAccount.birthdayHeight &&
          account.addresses.transparent === targetAccount.addresses.transparent &&
          account.addresses.shielded === targetAccount.addresses.shielded &&
          account.addresses.fullUnified === targetAccount.addresses.fullUnified &&
          account.createdAt === targetAccount.createdAt
        )
      })
    )
  })
}

function discoverLegacySource(local: Readonly<Record<string, unknown>>): V1MetadataDiscovery {
  return discoverV1Metadata({
    ...local,
    [V1_WALLET_STATE_KEY]: undefined
  })
}

function discoverWalletStateTarget(local: Readonly<Record<string, unknown>>): V1MetadataDiscovery {
  return discoverV1Metadata({
    ...local,
    [LEGACY_WALLET_DATA_KEY]: undefined
  })
}

async function writeFinalRecord(
  storage: LegacyWalletDataMigrationStorage,
  input: {
    readonly status: 'retained' | 'quarantined'
    readonly sourceFingerprint: string
    readonly discoveredAt: number
    readonly reason: string
    readonly verifiedAt?: number
  }
): Promise<LegacyWalletDataMigrationResult> {
  await storage.set({
    [LEGACY_WALLET_DATA_MIGRATION_KEY]: createRecord(
      input.status,
      input.sourceFingerprint,
      input.discoveredAt,
      input.reason,
      input.verifiedAt
    )
  })
  return Object.freeze({
    status: input.status,
    targetWritten: false,
    reason: input.reason
  })
}

export async function migrateLegacyWalletData(
  storage: LegacyWalletDataMigrationStorage,
  now: () => number = Date.now
): Promise<LegacyWalletDataMigrationResult> {
  const initial = await storage.getAll()
  const legacy = initial[LEGACY_WALLET_DATA_KEY]
  if (!isRecord(legacy) || !Array.isArray(legacy.wallets)) {
    return Object.freeze({ status: 'not-needed', targetWritten: false })
  }

  const discoveredAt = now()
  const sourceFingerprint = await fingerprintV1Source(legacy)
  const sourceDiscovery = discoverLegacySource(initial)
  if (sourceDiscovery.status !== 'ready') {
    return writeFinalRecord(storage, {
      status: 'quarantined',
      sourceFingerprint,
      discoveredAt,
      reason: `source-${sourceDiscovery.status}`
    })
  }

  const targetExists = Object.prototype.hasOwnProperty.call(initial, V1_WALLET_STATE_KEY)
  if (targetExists) {
    const targetDiscovery = discoverWalletStateTarget(initial)
    const retainedReason = getRetainedRecordReason(
      initial[LEGACY_WALLET_DATA_MIGRATION_KEY],
      sourceFingerprint
    )
    if (retainedReason !== undefined && discoveriesMatch(sourceDiscovery, targetDiscovery)) {
      return Object.freeze({
        status: 'retained',
        targetWritten: false,
        reason: retainedReason
      })
    }
    if (
      hasStagedRecord(initial[LEGACY_WALLET_DATA_MIGRATION_KEY], sourceFingerprint) &&
      discoveriesMatch(sourceDiscovery, targetDiscovery)
    ) {
      const verifiedAt = now()
      return writeFinalRecord(storage, {
        status: 'retained',
        sourceFingerprint,
        discoveredAt,
        verifiedAt,
        reason: 'staged-target-verified'
      })
    }
    return writeFinalRecord(storage, {
      status: targetDiscovery.status === 'ready' ? 'retained' : 'quarantined',
      sourceFingerprint,
      discoveredAt,
      reason: targetDiscovery.status === 'ready' ? 'target-preexisting' : 'target-invalid'
    })
  }

  await storage.set({
    [V1_WALLET_STATE_KEY]: createLegacyWalletStateEnvelope(legacy),
    [LEGACY_WALLET_DATA_MIGRATION_KEY]: createRecord(
      'staged',
      sourceFingerprint,
      discoveredAt,
      'awaiting-readback-verification'
    )
  })

  const staged = await storage.getAll()
  const targetDiscovery = discoverWalletStateTarget(staged)
  if (!discoveriesMatch(sourceDiscovery, targetDiscovery)) {
    await storage.set({
      [LEGACY_WALLET_DATA_MIGRATION_KEY]: createRecord(
        'quarantined',
        sourceFingerprint,
        discoveredAt,
        'staged-target-verification-failed'
      )
    })
    return Object.freeze({
      status: 'quarantined',
      targetWritten: true,
      reason: 'staged-target-verification-failed'
    })
  }

  const verifiedAt = now()
  await storage.set({
    [LEGACY_WALLET_DATA_MIGRATION_KEY]: createRecord(
      'retained',
      sourceFingerprint,
      discoveredAt,
      'staged-target-verified',
      verifiedAt
    )
  })
  return Object.freeze({
    status: 'retained',
    targetWritten: true,
    reason: 'staged-target-verified'
  })
}
