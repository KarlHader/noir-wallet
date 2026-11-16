import {
  parseTransactionGraph,
  parseTransactionId,
  type TransactionGraph,
  type TransactionId
} from '@/core/transactions/domain'

export interface SessionStorageArea {
  readonly get: (keys: string | null) => Promise<Record<string, unknown>>
  readonly set: (items: Record<string, unknown>) => Promise<void>
  readonly remove: (keys: string | string[]) => Promise<void>
}

interface PendingTransactionRecord {
  readonly transactionId: TransactionId
}

export interface ChromeSessionPendingTransactionStoreOptions<
  RecordValue extends PendingTransactionRecord
> {
  readonly storage: SessionStorageArea
  readonly recordKeyPrefix: string
  readonly reviewGraphKeyPrefix: string
  readonly parseRecord: (value: unknown) => RecordValue
  readonly label: string
  readonly maximumRecords?: number
}

export class ChromeSessionPendingTransactionStore<RecordValue extends PendingTransactionRecord> {
  constructor(private readonly options: ChromeSessionPendingTransactionStoreOptions<RecordValue>) {}

  async get(transactionIdValue: TransactionId): Promise<RecordValue | null> {
    const transactionId = parseTransactionId(transactionIdValue)
    const key = this.recordKey(transactionId)
    const stored = await this.options.storage.get(key)
    const value = stored[key]
    if (value === undefined) return null
    const record = this.options.parseRecord(value)
    if (record.transactionId !== transactionId) {
      throw new Error(`Pending ${this.options.label} transfer storage key mismatch`)
    }
    return record
  }

  async getReviewGraph(transactionIdValue: TransactionId): Promise<TransactionGraph | null> {
    const transactionId = parseTransactionId(transactionIdValue)
    const key = this.reviewGraphKey(transactionId)
    const stored = await this.options.storage.get(key)
    const value = stored[key]
    return value === undefined ? null : this.parseBoundReviewGraph(value, transactionId)
  }

  async list(): Promise<readonly RecordValue[]> {
    const stored = await this.options.storage.get(null)
    const entries = Object.entries(stored).filter(([key]) =>
      key.startsWith(this.options.recordKeyPrefix)
    )
    if (this.options.maximumRecords !== undefined && entries.length > this.options.maximumRecords) {
      throw new Error(`Pending ${this.options.label} transfer capacity exceeded`)
    }
    const records = entries.map(([key, value]) => {
      const record = this.options.parseRecord(value)
      if (this.recordKey(record.transactionId) !== key) {
        throw new Error(`Pending ${this.options.label} transfer storage key mismatch`)
      }
      return record
    })
    records.sort((left, right) => left.transactionId.localeCompare(right.transactionId))
    return Object.freeze(records)
  }

  async clear(): Promise<number> {
    const stored = await this.options.storage.get(null)
    const recordKeys = Object.keys(stored).filter(key =>
      key.startsWith(this.options.recordKeyPrefix)
    )
    const keys = Object.keys(stored).filter(
      key =>
        key.startsWith(this.options.recordKeyPrefix) ||
        key.startsWith(this.options.reviewGraphKeyPrefix)
    )
    if (keys.length > 0) await this.options.storage.remove(keys)
    return recordKeys.length
  }

  async put(value: RecordValue, reviewGraph?: TransactionGraph): Promise<void> {
    const record = this.options.parseRecord(value)
    const entries: Record<string, unknown> = { [this.recordKey(record.transactionId)]: record }
    if (reviewGraph !== undefined) {
      entries[this.reviewGraphKey(record.transactionId)] = this.parseBoundReviewGraph(
        reviewGraph,
        record.transactionId
      )
    }
    await this.options.storage.set(entries)
  }

  async delete(transactionIdValue: TransactionId): Promise<void> {
    const transactionId = parseTransactionId(transactionIdValue)
    await this.options.storage.remove([
      this.recordKey(transactionId),
      this.reviewGraphKey(transactionId)
    ])
  }

  private recordKey(transactionId: TransactionId): string {
    return `${this.options.recordKeyPrefix}${encodeURIComponent(transactionId)}`
  }

  private reviewGraphKey(transactionId: TransactionId): string {
    return `${this.options.reviewGraphKeyPrefix}${encodeURIComponent(transactionId)}`
  }

  private parseBoundReviewGraph(value: unknown, transactionId: TransactionId): TransactionGraph {
    const graph = parseTransactionGraph(value)
    if (graph.root.id !== transactionId) {
      throw new Error(`Pending ${this.options.label} review graph transaction ID mismatch`)
    }
    return graph
  }
}
