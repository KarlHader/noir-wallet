export type AccountDataWriterRole = 'background' | 'document'

type Entries = Record<string, unknown>

export interface AccountDataSnapshot {
  version: number
  state: {
    balances: Entries
    syncStates: Entries
    portfolioValues: Entries
  }
}

export interface AccountDataPersistencePorts {
  read: () => Promise<unknown>
  write: (snapshot: AccountDataSnapshot) => Promise<void>
  remove: () => Promise<void>
  withLock: <T>(operation: () => Promise<T>) => Promise<T>
  isAccountActive: (accountKey: string) => Promise<boolean>
  isEntryDeleted?: (key: string) => Promise<boolean>
  migrate: (state: unknown, version: number) => unknown
}

export interface AccountDataDeletion {
  accountKeys?: readonly string[]
  syncKeys?: readonly string[]
  reset?: boolean
}

const FIELDS = ['balances', 'syncStates', 'portfolioValues'] as const
type Field = (typeof FIELDS)[number]
type Change = { field: Field; key: string; value?: unknown; remove: boolean }

function record(value: unknown): Entries {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Entries) : {}
}

function snapshot(value: unknown, version: number): AccountDataSnapshot {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  const root = record(parsed)
  const state = record(root.state)
  return {
    version: typeof root.version === 'number' ? root.version : version,
    state: {
      balances: { ...record(state.balances) },
      syncStates: { ...record(state.syncStates) },
      portfolioValues: { ...record(state.portfolioValues) }
    }
  }
}

function changes(before: AccountDataSnapshot, after: AccountDataSnapshot): Change[] {
  const result: Change[] = []
  for (const field of FIELDS) {
    const previous = before.state[field]
    const next = after.state[field]
    for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
      if (!Object.prototype.hasOwnProperty.call(next, key)) {
        result.push({ field, key, remove: true })
      } else if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) {
        result.push({ field, key, value: next[key], remove: false })
      }
    }
  }
  return result
}

function isNewerPortfolioValue(incoming: unknown, current: unknown): boolean {
  const nextTime = record(incoming).updatedAt
  const currentTime = record(current).updatedAt
  return (
    typeof nextTime === 'number' &&
    Number.isSafeInteger(nextTime) &&
    (typeof currentTime !== 'number' || nextTime >= currentTime)
  )
}

/** A document mirrors balances and sync state in memory; the service worker owns their disk writes. */
export function createAccountDataPersistence(
  role: AccountDataWriterRole,
  version: number,
  ports: AccountDataPersistencePorts
) {
  let submitted = snapshot(null, version)
  let queue: Promise<void> = Promise.resolve()

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const task = queue.then(operation)
    queue = task.then(
      () => {},
      () => {}
    )
    return task
  }

  return {
    getItem(_key: string): Promise<AccountDataSnapshot | null> {
      return enqueue(() =>
        ports.withLock(async () => {
          const raw = await ports.read()
          submitted = snapshot(raw, version)
          return raw == null
            ? null
            : ((typeof raw === 'string' ? JSON.parse(raw) : raw) as AccountDataSnapshot)
        })
      )
    },

    setItem(_key: string, value: AccountDataSnapshot): Promise<void> {
      const next = snapshot(value, version)
      return enqueue(async () => {
        const delta = changes(submitted, next)
        const needsMigration = role === 'background' && submitted.version < version
        submitted = next
        if (
          role === 'document' &&
          !delta.some(change => change.field === 'portfolioValues' && !change.remove)
        ) {
          return
        }
        if (delta.length === 0 && !needsMigration) return
        await ports.withLock(async () => {
          const current = snapshot(await ports.read(), version)
          let changed = false
          if (role === 'background' && current.version < version) {
            current.state = snapshot(
              { version, state: ports.migrate(current.state, current.version) },
              version
            ).state
            changed = true
          }
          for (const change of delta) {
            if (role === 'document' && (change.field !== 'portfolioValues' || change.remove)) {
              continue
            }
            const values = current.state[change.field]
            if (change.remove) {
              if (
                role === 'background' &&
                Object.prototype.hasOwnProperty.call(values, change.key)
              ) {
                delete values[change.key]
                changed = true
              }
              continue
            }
            if (change.field === 'portfolioValues' && role === 'document') {
              if (!(await ports.isAccountActive(change.key))) continue
              if (!isNewerPortfolioValue(change.value, values[change.key])) continue
            }
            if (role === 'background' && (await ports.isEntryDeleted?.(change.key))) continue
            values[change.key] = change.value
            changed = true
          }
          if (changed) {
            if (role === 'background') current.version = version
            await ports.write(current)
          }
        })
      })
    },

    removeItem(_key: string): Promise<void> {
      if (role === 'document') return queue
      return enqueue(() =>
        ports.withLock(async () => {
          submitted = snapshot(null, version)
          await ports.remove()
        })
      )
    },

    deleteEntries(deletion: AccountDataDeletion): Promise<void> {
      if (role !== 'background')
        return Promise.reject(new Error('Account data deletion requires the service worker'))
      return enqueue(() =>
        ports.withLock(async () => {
          if (deletion.reset) {
            submitted = snapshot(null, version)
            await ports.write(submitted)
            return
          }
          const current = snapshot(await ports.read(), version)
          for (const key of deletion.accountKeys ?? []) {
            delete current.state.balances[key]
            delete current.state.syncStates[key]
            delete current.state.portfolioValues[key]
          }
          for (const key of deletion.syncKeys ?? []) delete current.state.syncStates[key]
          await ports.write(current)
        })
      )
    },

    awaitWrites(): Promise<void> {
      return queue
    }
  }
}
