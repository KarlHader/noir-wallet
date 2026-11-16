export const WALLET_PERSISTENCE_QUARANTINE_STORE_NAME = 'walletPersistenceQuarantine'

export const WALLET_PERSISTENCE_QUARANTINE_REASONS = [
  'wasm-health-timeout',
  'wasm-restore-rejected',
  'journal-without-snapshot',
  'journal-replay-aborted',
  'journal-replay-failed',
  'reorg-rewind-failed',
  'unsupported-proto-version'
] as const

export type WalletPersistenceQuarantineReason =
  (typeof WALLET_PERSISTENCE_QUARANTINE_REASONS)[number]

export interface WalletPersistenceQuarantineRecord {
  readonly schemaVersion: 1
  readonly key: string
  readonly network: string
  readonly walletId: string
  readonly snapshotQuarantined: boolean
  readonly journalQuarantined: boolean
  readonly detectedAt: number
  readonly reasons: readonly WalletPersistenceQuarantineReason[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseString(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value
  ) {
    throw new Error(`Invalid quarantine ${label}`)
  }
  return value
}

export function parseWalletPersistenceQuarantineRecord(
  value: unknown
): WalletPersistenceQuarantineRecord {
  if (!isRecord(value)) throw new Error('Invalid wallet persistence quarantine')
  const expectedKeys = [
    'schemaVersion',
    'key',
    'network',
    'walletId',
    'snapshotQuarantined',
    'journalQuarantined',
    'detectedAt',
    'reasons'
  ]
  if (
    Object.keys(value).length !== expectedKeys.length ||
    expectedKeys.some(key => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new Error('Invalid wallet persistence quarantine keys')
  }
  if (
    value.schemaVersion !== 1 ||
    typeof value.snapshotQuarantined !== 'boolean' ||
    typeof value.journalQuarantined !== 'boolean' ||
    (!value.snapshotQuarantined && !value.journalQuarantined) ||
    typeof value.detectedAt !== 'number' ||
    !Number.isSafeInteger(value.detectedAt) ||
    value.detectedAt < 0 ||
    !Array.isArray(value.reasons) ||
    value.reasons.length === 0 ||
    value.reasons.length > WALLET_PERSISTENCE_QUARANTINE_REASONS.length
  ) {
    throw new Error('Invalid wallet persistence quarantine fields')
  }
  const allowedReasons = new Set<string>(WALLET_PERSISTENCE_QUARANTINE_REASONS)
  if (
    value.reasons.some(reason => typeof reason !== 'string' || !allowedReasons.has(reason)) ||
    new Set(value.reasons).size !== value.reasons.length
  ) {
    throw new Error('Invalid wallet persistence quarantine reasons')
  }

  return Object.freeze({
    schemaVersion: 1,
    key: parseString(value.key, 'key'),
    network: parseString(value.network, 'network'),
    walletId: parseString(value.walletId, 'walletId'),
    snapshotQuarantined: value.snapshotQuarantined,
    journalQuarantined: value.journalQuarantined,
    detectedAt: value.detectedAt,
    reasons: Object.freeze(value.reasons as WalletPersistenceQuarantineReason[])
  })
}

export function createWalletPersistenceQuarantineRecord(input: {
  readonly key: string
  readonly network: string
  readonly walletId: string
  readonly reason: WalletPersistenceQuarantineReason
  readonly snapshotQuarantined: boolean
  readonly journalQuarantined: boolean
  readonly detectedAt: number
  readonly existing?: WalletPersistenceQuarantineRecord | null
}): WalletPersistenceQuarantineRecord {
  const reasons = [...(input.existing?.reasons ?? []), input.reason].filter(
    (reason, index, all) => all.indexOf(reason) === index
  )
  return parseWalletPersistenceQuarantineRecord({
    schemaVersion: 1,
    key: input.key,
    network: input.network,
    walletId: input.walletId,
    snapshotQuarantined: input.snapshotQuarantined || input.existing?.snapshotQuarantined === true,
    journalQuarantined: input.journalQuarantined || input.existing?.journalQuarantined === true,
    detectedAt: input.existing?.detectedAt ?? input.detectedAt,
    reasons
  })
}
