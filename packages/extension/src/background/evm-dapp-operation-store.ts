import { parseAccountId } from '@/core/accounts/domain'
import { parseKeyDomainId } from '@/core/keyring/domain'
import { parseTransactionId, type TransactionId } from '@/core/transactions/domain'

const STORAGE_KEY_PREFIX = 'evm_dapp_operation:'
const MAX_OPERATIONS = 256

interface SessionStorageArea {
  readonly get: (keys: string | null) => Promise<Record<string, unknown>>
  readonly set: (items: Record<string, unknown>) => Promise<void>
  readonly remove: (keys: string | string[]) => Promise<void>
}

const chromeSessionStorage: SessionStorageArea = {
  get: keys => chrome.storage.session.get(keys),
  set: items => chrome.storage.session.set(items),
  remove: keys => chrome.storage.session.remove(keys)
}

export interface EvmDAppOperationRecord {
  readonly schemaVersion: 1
  readonly transactionId: TransactionId
  readonly keyDomainId: string
  readonly accountId: string
  readonly origin: string
}

function storageKey(transactionId: TransactionId): string {
  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(transactionId)}`
}

function parseOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2_048) throw new Error('Invalid dApp origin')
  const origin = new URL(value)
  if ((origin.protocol !== 'https:' && origin.protocol !== 'http:') || origin.origin !== value) {
    throw new Error('Invalid dApp origin')
  }
  return origin.origin
}

function parseRecord(value: unknown): EvmDAppOperationRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid dApp EVM operation')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('Invalid dApp EVM operation')
  }
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).length !== 5 ||
    record.schemaVersion !== 1 ||
    !Object.prototype.hasOwnProperty.call(record, 'schemaVersion') ||
    !Object.prototype.hasOwnProperty.call(record, 'transactionId') ||
    !Object.prototype.hasOwnProperty.call(record, 'keyDomainId') ||
    !Object.prototype.hasOwnProperty.call(record, 'accountId') ||
    !Object.prototype.hasOwnProperty.call(record, 'origin')
  ) {
    throw new Error('Invalid dApp EVM operation')
  }
  return Object.freeze({
    schemaVersion: 1,
    transactionId: parseTransactionId(record.transactionId),
    keyDomainId: parseKeyDomainId(record.keyDomainId),
    accountId: parseAccountId(record.accountId),
    origin: parseOrigin(record.origin)
  })
}

export class ChromeSessionEvmDAppOperationStore {
  constructor(private readonly storage: SessionStorageArea = chromeSessionStorage) {}

  async put(value: EvmDAppOperationRecord): Promise<void> {
    const record = parseRecord(value)
    await this.storage.set({ [storageKey(record.transactionId)]: record })
  }

  async delete(transactionIdValue: string): Promise<void> {
    const transactionId = parseTransactionId(transactionIdValue)
    await this.storage.remove(storageKey(transactionId))
  }

  async listForScope(
    keyDomainIdValue: string,
    accountIdValue: string
  ): Promise<readonly EvmDAppOperationRecord[]> {
    const keyDomainId = parseKeyDomainId(keyDomainIdValue)
    const accountId = parseAccountId(accountIdValue)
    const stored = await this.storage.get(null)
    const entries = Object.entries(stored).filter(([key]) => key.startsWith(STORAGE_KEY_PREFIX))
    if (entries.length > MAX_OPERATIONS) throw new Error('dApp EVM operation capacity exceeded')
    return Object.freeze(
      entries
        .map(([key, value]) => {
          const record = parseRecord(value)
          if (storageKey(record.transactionId) !== key) {
            throw new Error('dApp EVM operation storage key mismatch')
          }
          return record
        })
        .filter(record => record.keyDomainId === keyDomainId && record.accountId === accountId)
    )
  }
}

export const evmDAppOperationStore = new ChromeSessionEvmDAppOperationStore()
