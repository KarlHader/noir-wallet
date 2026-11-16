import { parseAccountId, parseAccountIndex } from '@/core/accounts/domain'
import { parseCredentialRef, parseKeyDomainId } from '@/core/keyring/domain'
import { parseStorageV2Snapshot } from '@/infrastructure/persistence/schema'
import {
  STORAGE_V2_SCHEMA_VERSION,
  type StorageV2GenerationId,
  type StorageV2Snapshot,
  type StorageV2SourceFingerprint
} from '@/ports/repositories'

export const LEGACY_WALLET_DATA_KEY = 'walletData' as const
export const LEGACY_WALLET_DATA_MIGRATION_KEY = 'legacy_wallet_data_migration_v1' as const
export const V1_WALLET_STATE_KEY = 'wallet_state' as const

const MAX_V1_WALLETS = 100
const MAX_V1_ACCOUNTS = 2_000

export type V1WalletSource = 'wallet_state' | 'walletData' | 'none'
export type V1DiscoveryStatus = 'empty' | 'ready' | 'quarantined'
export type V1KeySource = 'software' | 'keystone' | 'ledger'

export interface V1DiscoveredAccount {
  readonly id: string
  readonly displayName: string
  readonly accountIndex: number
  readonly birthdayHeight: number
  readonly addresses: Readonly<{
    readonly transparent: string
    readonly shielded: string
    readonly fullUnified?: string
    readonly transparentAddressIndex?: number
  }>
  readonly createdAt: number
}

export interface V1DiscoveredWallet {
  readonly id: string
  readonly displayName: string
  readonly keySource: V1KeySource
  readonly credentialStorageKey: string
  readonly createdAt: number
  readonly accounts: readonly V1DiscoveredAccount[]
}

export interface V1MetadataDiscovery {
  readonly status: V1DiscoveryStatus
  readonly source: V1WalletSource
  readonly currentWalletId: string | null
  readonly currentAccountId: string | null
  readonly wallets: readonly V1DiscoveredWallet[]
  readonly issues: readonly string[]
}

export interface LegacyWalletDataMigrationRecord {
  readonly schemaVersion: 1
  readonly sourceKey: typeof LEGACY_WALLET_DATA_KEY
  readonly targetKey: typeof V1_WALLET_STATE_KEY
  readonly status: 'staged' | 'retained' | 'quarantined'
  readonly sourceFingerprint: string
  readonly discoveredAt: number
  readonly verifiedAt?: number
  readonly reason?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parsePersistedState(value: unknown): Record<string, unknown> | null {
  let envelope: unknown = value
  if (typeof value === 'string') {
    if (value.length > 8 * 1024 * 1024) return null
    try {
      envelope = JSON.parse(value)
    } catch {
      return null
    }
  }
  return isRecord(envelope) && isRecord(envelope.state) ? envelope.state : null
}

function parseNonEmptyString(value: unknown, maxLength = 512): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value &&
    value.length <= maxLength
    ? value
    : null
}

function parseTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function parseWallets(
  walletsValue: unknown,
  accountDisplayNamesValue: unknown,
  local: Readonly<Record<string, unknown>>
): { wallets: readonly V1DiscoveredWallet[]; issues: readonly string[] } {
  const issues: string[] = []
  if (!Array.isArray(walletsValue) || walletsValue.length > MAX_V1_WALLETS) {
    return { wallets: [], issues: ['wallets-invalid'] }
  }
  const accountDisplayNames = isRecord(accountDisplayNamesValue) ? accountDisplayNamesValue : {}
  const wallets: V1DiscoveredWallet[] = []
  const walletIds = new Set<string>()
  let accountCount = 0

  for (const [walletPosition, walletValue] of walletsValue.entries()) {
    if (!isRecord(walletValue)) {
      issues.push(`wallet-${walletPosition}-invalid`)
      continue
    }
    const id = parseNonEmptyString(walletValue.id)
    const displayName = parseNonEmptyString(walletValue.name, 128)
    const createdAt = parseTimestamp(walletValue.createdAt)
    const keySource =
      walletValue.keySource === undefined || walletValue.keySource === 'software'
        ? 'software'
        : walletValue.keySource === 'keystone'
          ? 'keystone'
          : walletValue.keySource === 'ledger'
            ? 'ledger'
            : null
    if (
      !id ||
      !displayName ||
      createdAt === null ||
      !keySource ||
      !Array.isArray(walletValue.accounts)
    ) {
      issues.push(`wallet-${walletPosition}-invalid`)
      continue
    }
    if (walletIds.has(id)) {
      issues.push(`wallet-${walletPosition}-duplicate-id`)
      continue
    }
    walletIds.add(id)

    const credentialStorageKey = keySource === 'software' ? `seed_${id}` : `hw_${id}`
    if (!Object.prototype.hasOwnProperty.call(local, credentialStorageKey)) {
      issues.push(`wallet-${id}-credential-missing`)
    }

    const accounts: V1DiscoveredAccount[] = []
    const accountIds = new Set<string>()
    const accountIndexes = new Set<number>()
    for (const [accountPosition, accountValue] of walletValue.accounts.entries()) {
      accountCount += 1
      if (accountCount > MAX_V1_ACCOUNTS || !isRecord(accountValue)) {
        issues.push(`wallet-${id}-account-${accountPosition}-invalid`)
        continue
      }
      const accountId = parseNonEmptyString(accountValue.id)
      const accountIndex =
        typeof accountValue.derivationIndex === 'number' &&
        Number.isSafeInteger(accountValue.derivationIndex) &&
        accountValue.derivationIndex >= 0
          ? accountValue.derivationIndex
          : null
      const accountName = parseNonEmptyString(accountValue.name, 128)
      const birthdayHeight = parseTimestamp(accountValue.birthdayHeight)
      const addresses = isRecord(accountValue.addresses) ? accountValue.addresses : null
      const transparent = parseNonEmptyString(addresses?.transparent, 4_096)
      const shielded = parseNonEmptyString(addresses?.shielded, 4_096)
      const fullUnified =
        addresses?.fullUnified === undefined
          ? undefined
          : parseNonEmptyString(addresses.fullUnified, 4_096)
      const transparentAddressIndex =
        typeof addresses?.transparentAddressIndex === 'number' &&
        Number.isSafeInteger(addresses.transparentAddressIndex) &&
        addresses.transparentAddressIndex >= 0 &&
        addresses.transparentAddressIndex <= 0x7fffffff
          ? addresses.transparentAddressIndex
          : undefined
      if (
        !accountId ||
        accountIndex === null ||
        !accountName ||
        birthdayHeight === null ||
        !transparent ||
        !shielded ||
        (addresses?.fullUnified !== undefined && !fullUnified) ||
        accountIds.has(accountId) ||
        accountIndexes.has(accountIndex)
      ) {
        issues.push(`wallet-${id}-account-${accountPosition}-invalid`)
        continue
      }
      accountIds.add(accountId)
      accountIndexes.add(accountIndex)
      const overrideName = parseNonEmptyString(accountDisplayNames[`${id}_${accountId}`], 128)
      accounts.push(
        Object.freeze({
          id: accountId,
          displayName: overrideName ?? accountName,
          accountIndex,
          birthdayHeight,
          addresses: Object.freeze({
            transparent,
            shielded,
            ...(typeof fullUnified === 'string' ? { fullUnified } : {}),
            ...(transparentAddressIndex === undefined ? {} : { transparentAddressIndex })
          }),
          createdAt
        })
      )
    }

    wallets.push(
      Object.freeze({
        id,
        displayName,
        keySource,
        credentialStorageKey,
        createdAt,
        accounts: Object.freeze(accounts)
      })
    )
  }

  return { wallets: Object.freeze(wallets), issues: Object.freeze(issues) }
}

export function discoverV1Metadata(local: Readonly<Record<string, unknown>>): V1MetadataDiscovery {
  const walletState = parsePersistedState(local[V1_WALLET_STATE_KEY])
  const legacy = isRecord(local[LEGACY_WALLET_DATA_KEY]) ? local[LEGACY_WALLET_DATA_KEY] : null
  const source: V1WalletSource = Array.isArray(walletState?.wallets)
    ? 'wallet_state'
    : Array.isArray(legacy?.wallets)
      ? 'walletData'
      : 'none'
  if (source === 'none') {
    return Object.freeze({
      status: 'empty',
      source,
      currentWalletId: null,
      currentAccountId: null,
      wallets: Object.freeze([]),
      issues: Object.freeze([])
    })
  }

  const sourceValue = source === 'wallet_state' ? walletState! : legacy!
  const { wallets, issues } = parseWallets(
    sourceValue.wallets,
    sourceValue.accountDisplayNames,
    local
  )
  const currentWalletId = parseNonEmptyString(sourceValue.currentWalletId)
  const currentAccountId = parseNonEmptyString(sourceValue.currentAccountId)
  const issueList = [...issues]
  if (currentWalletId && !wallets.some(wallet => wallet.id === currentWalletId)) {
    issueList.push('current-wallet-missing')
  }
  if (
    currentAccountId &&
    !wallets.some(wallet => wallet.accounts.some(account => account.id === currentAccountId))
  ) {
    issueList.push('current-account-missing')
  }

  return Object.freeze({
    status: issueList.length > 0 ? 'quarantined' : wallets.length === 0 ? 'empty' : 'ready',
    source,
    currentWalletId,
    currentAccountId,
    wallets,
    issues: Object.freeze(issueList)
  })
}

export function buildStorageV2MetadataStage(
  discovery: V1MetadataDiscovery,
  input: {
    readonly generationId: StorageV2GenerationId
    readonly sourceFingerprint: StorageV2SourceFingerprint
    readonly createdAt: number
  }
): StorageV2Snapshot {
  if (discovery.status !== 'ready') {
    throw new Error(`V1 metadata is not ready to stage: ${discovery.status}`)
  }

  const keyDomains = discovery.wallets.map(wallet => ({
    id: parseKeyDomainId(wallet.id),
    credentialRef: parseCredentialRef(`v1-local:${wallet.credentialStorageKey}`),
    source:
      wallet.keySource !== 'software'
        ? ({
            kind: 'hardware',
            vendor: wallet.keySource,
            firmwareProfile: wallet.keySource === 'ledger' ? 'zcash' : 'cypherpunk',
            capabilities: ['zcash']
          } as const)
        : ({ kind: 'software' } as const),
    displayName: wallet.displayName,
    createdAt: wallet.createdAt
  }))
  const accounts = discovery.wallets.flatMap(wallet =>
    wallet.accounts.map(account => ({
      id: parseAccountId(account.id),
      keyDomainId: parseKeyDomainId(wallet.id),
      accountIndex: parseAccountIndex(account.accountIndex),
      displayName: account.displayName,
      createdAt: account.createdAt
    }))
  )
  const snapshot = {
    manifest: {
      schemaVersion: STORAGE_V2_SCHEMA_VERSION,
      generationId: input.generationId,
      status: 'staged' as const,
      sourceFingerprint: input.sourceFingerprint,
      mainKeyDomainId: keyDomains[0]?.id,
      ...(discovery.currentWalletId && discovery.currentAccountId
        ? {
            activeAccount: {
              keyDomainId: parseKeyDomainId(discovery.currentWalletId),
              accountId: parseAccountId(discovery.currentAccountId)
            }
          }
        : {}),
      counts: {
        keyDomains: keyDomains.length,
        accounts: accounts.length,
        chainAccounts: 0,
        addresses: 0
      },
      createdAt: input.createdAt
    },
    keyDomains,
    accounts,
    chainAccounts: [],
    addresses: []
  }
  return parseStorageV2Snapshot(snapshot)
}

export function createLegacyWalletStateEnvelope(
  legacy: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  const wallets = Array.isArray(legacy.wallets) ? legacy.wallets : []
  const accountDisplayNames = isRecord(legacy.accountDisplayNames) ? legacy.accountDisplayNames : {}
  return Object.freeze({
    state: {
      currentWalletId: typeof legacy.currentWalletId === 'string' ? legacy.currentWalletId : null,
      currentAccountId:
        typeof legacy.currentAccountId === 'string' ? legacy.currentAccountId : null,
      currentNetwork: legacy.network === 'testnet' ? 'testnet' : 'mainnet',
      zecPrice: 0,
      wallets,
      accountDisplayNames
    },
    version: 0
  })
}
