import {
  applyDashDiscoveryProgress,
  applyDashDiscoveryRefresh,
  dashAccountKey,
  dashScopeKey,
  DASH_DISCOVERY_DATABASE,
  hasExactKeys,
  isRecord,
  parseDashCheckpoint,
  parseDashDiscoveryScope,
  parseDashObservation,
  parseDashTimestamp,
  type DashDiscoveryProgress,
  type DashDiscoveryRefresh,
  type DashDiscoveryRepository,
  type DashDiscoveryScope,
  type DashDiscoveryState
} from './dash-discovery-model'

const DISCOVERY_STORE = 'discovery'
const INPUT_STORE = 'input-reservations'
const CHANGE_STORE = 'change-reservations'
const BY_ACCOUNT = 'byAccount'

export { DASH_DISCOVERY_DATABASE }

export interface IndexedDbDashDiscoveryRepositoryOptions {
  readonly databaseName?: string
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Dash discovery request failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('Dash discovery transaction failed'))
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Dash discovery transaction aborted'))
  })
}

export function openDashDiscoveryDatabase(databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, DASH_DISCOVERY_DATABASE.version)
    request.onerror = () =>
      reject(request.error ?? new Error('Dash discovery database open failed'))
    request.onblocked = () => reject(new Error('Dash discovery database open is blocked'))
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(DISCOVERY_STORE)) {
        const discovery = database.createObjectStore(DISCOVERY_STORE, { keyPath: 'scopeKey' })
        discovery.createIndex(BY_ACCOUNT, 'accountKey', { unique: false })
      }
      if (!database.objectStoreNames.contains(INPUT_STORE)) {
        const inputs = database.createObjectStore(INPUT_STORE, { keyPath: 'reservationKey' })
        inputs.createIndex(BY_ACCOUNT, 'accountKey', { unique: false })
        inputs.createIndex('byScope', 'scopeKey', { unique: false })
        inputs.createIndex('byOutpoint', 'outpointKeys', { unique: true, multiEntry: true })
      }
      if (!database.objectStoreNames.contains(CHANGE_STORE)) {
        const change = database.createObjectStore(CHANGE_STORE, { keyPath: 'reservationKey' })
        change.createIndex(BY_ACCOUNT, 'accountKey', { unique: false })
        change.createIndex('byScope', 'scopeKey', { unique: false })
      }
    }
    request.onsuccess = () => resolve(request.result)
  })
}

async function runDatabase<T>(
  databaseName: string,
  mode: IDBTransactionMode,
  operation: (transaction: IDBTransaction) => Promise<T>
): Promise<T> {
  const database = await openDashDiscoveryDatabase(databaseName)
  try {
    const transaction = database.transaction([DISCOVERY_STORE, INPUT_STORE, CHANGE_STORE], mode)
    const result = await operation(transaction)
    await transactionDone(transaction)
    return result
  } finally {
    database.close()
  }
}

function restoreState(value: unknown): DashDiscoveryState {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'scopeKey', 'accountKey', 'state']) ||
    value.schemaVersion !== 1 ||
    !isRecord(value.state) ||
    !Array.isArray(value.state.observations)
  ) {
    throw new Error('Stored Dash discovery state is invalid')
  }
  const scope = parseDashDiscoveryScope({
    chainAccount: value.state.chainAccount as DashDiscoveryScope['chainAccount'],
    accountIndex: value.state.accountIndex as DashDiscoveryScope['accountIndex']
  })
  if (
    value.scopeKey !== dashScopeKey(scope) ||
    value.accountKey !== dashAccountKey(scope.chainAccount.scope)
  ) {
    throw new Error('Stored Dash discovery state crossed accounts')
  }
  if (value.state.network !== scope.network || value.state.imported !== scope.imported) {
    throw new Error('Stored Dash discovery network does not match the account')
  }
  return Object.freeze({
    ...scope,
    checkpoint: parseDashCheckpoint(value.state.checkpoint, scope),
    observations: Object.freeze(
      value.state.observations.map(observation => parseDashObservation(observation, scope))
    ),
    updatedAt: parseDashTimestamp(value.state.updatedAt)
  })
}

function storedRecord(state: DashDiscoveryState) {
  const scopeKey = dashScopeKey(state)
  return Object.freeze({
    schemaVersion: 1 as const,
    scopeKey,
    accountKey: dashAccountKey(state.chainAccount.scope),
    state
  })
}

async function readState(
  transaction: IDBTransaction,
  scope: DashDiscoveryScope
): Promise<DashDiscoveryState | null> {
  const stored = await requestResult<unknown>(
    transaction.objectStore(DISCOVERY_STORE).get(dashScopeKey(scope))
  )
  if (stored === undefined) return null
  const state = restoreState(stored)
  if (dashScopeKey(state) !== dashScopeKey(scope)) return null
  return state
}

export class IndexedDbDashDiscoveryRepository implements DashDiscoveryRepository {
  private readonly databaseName: string

  constructor(options: IndexedDbDashDiscoveryRepositoryOptions = {}) {
    this.databaseName = options.databaseName ?? DASH_DISCOVERY_DATABASE.name
    if (this.databaseName.length === 0 || this.databaseName.length > 256) {
      throw new Error('Invalid Dash discovery database name')
    }
  }

  get(
    scopeValue: Pick<DashDiscoveryScope, 'chainAccount' | 'accountIndex'>
  ): Promise<DashDiscoveryState | null> {
    const scope = parseDashDiscoveryScope(scopeValue)
    return runDatabase(this.databaseName, 'readonly', transaction => readState(transaction, scope))
  }

  async putProgress(progress: DashDiscoveryProgress): Promise<void> {
    const scope = parseDashDiscoveryScope(progress)
    await runDatabase(this.databaseName, 'readwrite', async transaction => {
      const existing = await readState(transaction, scope)
      const next = applyDashDiscoveryProgress(existing, progress)
      transaction.objectStore(DISCOVERY_STORE).put(storedRecord(next))
    })
  }

  async putRefresh(refresh: DashDiscoveryRefresh): Promise<void> {
    const scope = parseDashDiscoveryScope(refresh)
    await runDatabase(this.databaseName, 'readwrite', async transaction => {
      const existing = await readState(transaction, scope)
      if (!existing) throw new Error('Dash discovery refresh requires persisted state')
      const next = applyDashDiscoveryRefresh(existing, refresh)
      transaction.objectStore(DISCOVERY_STORE).put(storedRecord(next))
    })
  }

  async deleteByAccountScope(scope: {
    readonly chainId: string
    readonly keyDomainId: string
    readonly accountId: string
  }): Promise<number> {
    const accountKey = dashAccountKey(scope)
    return runDatabase(this.databaseName, 'readwrite', async transaction => {
      const index = transaction.objectStore(DISCOVERY_STORE).index(BY_ACCOUNT)
      const records = await requestResult<unknown[]>(index.getAll(accountKey))
      for (const record of records) {
        if (
          !isRecord(record) ||
          record.accountKey !== accountKey ||
          typeof record.scopeKey !== 'string'
        ) {
          throw new Error('Stored Dash discovery account index is invalid')
        }
        transaction.objectStore(DISCOVERY_STORE).delete(record.scopeKey)
      }
      return records.length
    })
  }
}

export class MemoryDashDiscoveryRepository implements DashDiscoveryRepository {
  private readonly states = new Map<string, DashDiscoveryState>()

  async get(
    scopeValue: Pick<DashDiscoveryScope, 'chainAccount' | 'accountIndex'>
  ): Promise<DashDiscoveryState | null> {
    const scope = parseDashDiscoveryScope(scopeValue)
    return this.states.get(dashScopeKey(scope)) ?? null
  }

  async putProgress(progress: DashDiscoveryProgress): Promise<void> {
    const scope = parseDashDiscoveryScope(progress)
    const key = dashScopeKey(scope)
    this.states.set(key, applyDashDiscoveryProgress(this.states.get(key) ?? null, progress))
  }

  async putRefresh(refresh: DashDiscoveryRefresh): Promise<void> {
    const scope = parseDashDiscoveryScope(refresh)
    const key = dashScopeKey(scope)
    const existing = this.states.get(key)
    if (!existing) throw new Error('Dash discovery refresh requires persisted state')
    this.states.set(key, applyDashDiscoveryRefresh(existing, refresh))
  }

  async deleteByAccountScope(scope: {
    readonly chainId: string
    readonly keyDomainId: string
    readonly accountId: string
  }): Promise<number> {
    const accountKey = dashAccountKey(scope)
    let deleted = 0
    for (const [key, state] of this.states) {
      if (dashAccountKey(state.chainAccount.scope) !== accountKey) continue
      this.states.delete(key)
      deleted += 1
    }
    return deleted
  }
}
