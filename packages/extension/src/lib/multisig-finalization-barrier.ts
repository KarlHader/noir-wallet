export interface FinalizationBarrierScope {
  readonly network: 'mainnet' | 'testnet'
  readonly walletId: string
}

export interface FinalizationBarrierRecord extends FinalizationBarrierScope {
  readonly version: 1
  readonly accountId: string
  readonly reviewId: string
  readonly sessionId: string
  readonly token: string
}

export interface FinalizationBarrierStorage {
  read(key: string): Promise<unknown>
  write(key: string, value: FinalizationBarrierRecord): Promise<void>
  remove(key: string): Promise<void>
  runExclusive<T>(key: string, operation: () => Promise<T>): Promise<T>
}

const PREFIX = 'noir_multisig_finalization_barrier_v1'

function barrierKey(scope: FinalizationBarrierScope): string {
  if (
    (scope.network !== 'mainnet' && scope.network !== 'testnet') ||
    typeof scope.walletId !== 'string' ||
    scope.walletId.length === 0 ||
    scope.walletId.length > 512
  )
    throw new Error('Invalid multisig finalization barrier scope')
  return `${PREFIX}:${scope.network}:${scope.walletId}`
}

function isExactMarker(value: unknown, marker: FinalizationBarrierRecord): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    Object.keys(record).length === 7 &&
    record.version === marker.version &&
    record.network === marker.network &&
    record.walletId === marker.walletId &&
    record.accountId === marker.accountId &&
    record.reviewId === marker.reviewId &&
    record.sessionId === marker.sessionId &&
    record.token === marker.token
  )
}

const browserStorage: FinalizationBarrierStorage = {
  async read(key) {
    return (await chrome.storage.local.get(key))[key]
  },
  async write(key, value) {
    await chrome.storage.local.set({ [key]: value })
  },
  async remove(key) {
    await chrome.storage.local.remove(key)
  },
  async runExclusive(key, operation) {
    if (!navigator.locks?.request)
      throw new Error('Multisig finalization barrier lock is unavailable')
    return navigator.locks.request(key, operation)
  }
}

export async function beginFinalizationBarrier(
  scope: FinalizationBarrierScope & { accountId: string; reviewId: string; sessionId: string },
  token: string,
  storage: FinalizationBarrierStorage = browserStorage
): Promise<FinalizationBarrierRecord> {
  const key = barrierKey(scope)
  if (
    typeof scope.accountId !== 'string' ||
    scope.accountId.length === 0 ||
    scope.accountId.length > 512 ||
    typeof scope.reviewId !== 'string' ||
    scope.reviewId.length === 0 ||
    scope.reviewId.length > 512 ||
    typeof scope.sessionId !== 'string' ||
    scope.sessionId.length === 0 ||
    scope.sessionId.length > 512 ||
    typeof token !== 'string' ||
    token.length === 0 ||
    token.length > 128
  )
    throw new Error('Invalid multisig finalization barrier owner')
  const marker: FinalizationBarrierRecord = Object.freeze({
    version: 1,
    network: scope.network,
    walletId: scope.walletId,
    accountId: scope.accountId,
    reviewId: scope.reviewId,
    sessionId: scope.sessionId,
    token
  })
  await storage.runExclusive(key, async () => {
    if ((await storage.read(key)) !== undefined)
      throw new Error('Multisig finalization is pending recovery')
    await storage.write(key, marker)
    if (!isExactMarker(await storage.read(key), marker))
      throw new Error('Multisig finalization barrier readback failed')
  })
  return marker
}

export async function clearFinalizationBarrier(
  marker: FinalizationBarrierRecord,
  storage: FinalizationBarrierStorage = browserStorage
): Promise<void> {
  const key = barrierKey(marker)
  await storage.runExclusive(key, async () => {
    if (!isExactMarker(await storage.read(key), marker))
      throw new Error('Multisig finalization barrier changed')
    await storage.remove(key)
    if ((await storage.read(key)) !== undefined)
      throw new Error('Multisig finalization barrier removal readback failed')
  })
}

export async function assertFinalizationBarrierOwned(
  marker: FinalizationBarrierRecord,
  storage: FinalizationBarrierStorage = browserStorage
): Promise<void> {
  const key = barrierKey(marker)
  await storage.runExclusive(key, async () => {
    if (!isExactMarker(await storage.read(key), marker))
      throw new Error('Multisig finalization barrier owner mismatch')
  })
}

export async function assertFinalizationBarrierCleared(
  scope: FinalizationBarrierScope,
  storage: FinalizationBarrierStorage = browserStorage
): Promise<void> {
  if (await hasFinalizationBarrier(scope, storage))
    throw new Error('Multisig finalization is pending recovery')
}

export async function hasFinalizationBarrier(
  scope: FinalizationBarrierScope,
  storage: FinalizationBarrierStorage = browserStorage
): Promise<boolean> {
  const key = barrierKey(scope)
  return storage.runExclusive(key, async () => (await storage.read(key)) !== undefined)
}
