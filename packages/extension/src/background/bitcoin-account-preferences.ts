import type { Network } from '@/types'
import type { BitcoinSupportedAddressType } from '@/core/chains/bitcoin'
import { parseBitcoinAddressType } from '@/infrastructure/chains/bitcoin'

export const BITCOIN_ACCOUNT_PREFERENCES_STORAGE_KEY = 'bitcoin_account_preferences_v1'
export const DEFAULT_BITCOIN_ADDRESS_TYPE: BitcoinSupportedAddressType = 'p2wpkh'

const SCHEMA_VERSION = 1
const MAXIMUM_SELECTIONS = 256

interface BitcoinAccountPreferenceScope {
  readonly network: Network
  readonly keyDomainId: string
  readonly accountId: string
}

interface BitcoinAccountPreferencesRecord {
  readonly schemaVersion: typeof SCHEMA_VERSION
  readonly selections: Readonly<Record<string, BitcoinSupportedAddressType>>
}

type BitcoinAccountPreferencesStorage = Pick<chrome.storage.StorageArea, 'get' | 'set'>

function scopeKey(scope: BitcoinAccountPreferenceScope): string {
  if (
    (scope.network !== 'mainnet' && scope.network !== 'testnet') ||
    typeof scope.keyDomainId !== 'string' ||
    scope.keyDomainId.length === 0 ||
    scope.keyDomainId.length > 256 ||
    typeof scope.accountId !== 'string' ||
    scope.accountId.length === 0 ||
    scope.accountId.length > 256
  ) {
    throw new Error('Invalid Bitcoin account preference scope')
  }
  return JSON.stringify([scope.network, scope.keyDomainId, scope.accountId])
}

function parseRecord(value: unknown): BitcoinAccountPreferencesRecord {
  if (value === undefined) {
    return Object.freeze({ schemaVersion: SCHEMA_VERSION, selections: Object.freeze({}) })
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error('Invalid Bitcoin account preferences')
  }
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).length !== 2 ||
    record.schemaVersion !== SCHEMA_VERSION ||
    typeof record.selections !== 'object' ||
    record.selections === null ||
    Array.isArray(record.selections) ||
    Object.getPrototypeOf(record.selections) !== Object.prototype
  ) {
    throw new Error('Invalid Bitcoin account preferences')
  }
  const entries = Object.entries(record.selections)
  if (entries.length > MAXIMUM_SELECTIONS) {
    throw new Error('Too many Bitcoin account preferences')
  }
  const selections = Object.fromEntries(
    entries.map(([key, addressType]) => {
      if (key.length === 0 || key.length > 1_024) {
        throw new Error('Invalid Bitcoin account preference key')
      }
      return [key, parseBitcoinAddressType(addressType)]
    })
  )
  return Object.freeze({ schemaVersion: SCHEMA_VERSION, selections: Object.freeze(selections) })
}

export class BitcoinAccountPreferencesRepository {
  private mutation: Promise<void> = Promise.resolve()
  private readonly storage: BitcoinAccountPreferencesStorage

  constructor(storage?: BitcoinAccountPreferencesStorage) {
    this.storage = storage ?? chrome.storage.local
  }

  async get(scope: BitcoinAccountPreferenceScope): Promise<BitcoinSupportedAddressType> {
    await this.mutation
    const key = scopeKey(scope)
    const stored = await this.storage.get(BITCOIN_ACCOUNT_PREFERENCES_STORAGE_KEY)
    return (
      parseRecord(stored[BITCOIN_ACCOUNT_PREFERENCES_STORAGE_KEY]).selections[key] ??
      DEFAULT_BITCOIN_ADDRESS_TYPE
    )
  }

  async set(
    scope: BitcoinAccountPreferenceScope,
    addressTypeValue: unknown
  ): Promise<BitcoinSupportedAddressType> {
    const key = scopeKey(scope)
    const addressType = parseBitcoinAddressType(addressTypeValue)
    const operation = this.mutation.then(async () => {
      const stored = await this.storage.get(BITCOIN_ACCOUNT_PREFERENCES_STORAGE_KEY)
      const current = parseRecord(stored[BITCOIN_ACCOUNT_PREFERENCES_STORAGE_KEY])
      const selections = { ...current.selections, [key]: addressType }
      if (Object.keys(selections).length > MAXIMUM_SELECTIONS) {
        throw new Error('Too many Bitcoin account preferences')
      }
      await this.storage.set({
        [BITCOIN_ACCOUNT_PREFERENCES_STORAGE_KEY]: {
          schemaVersion: SCHEMA_VERSION,
          selections
        }
      })
    })
    this.mutation = operation.catch(() => {})
    await operation
    return addressType
  }
}

let productionRepository: BitcoinAccountPreferencesRepository | null = null

export function getBitcoinAccountPreferences(): BitcoinAccountPreferencesRepository {
  productionRepository ??= new BitcoinAccountPreferencesRepository()
  return productionRepository
}
