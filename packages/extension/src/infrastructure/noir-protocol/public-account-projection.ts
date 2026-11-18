import type { NoirPublicAccount } from '@/core/services/noir-protocol/public/types'
import type { Network } from '@/types'
import { WALLET_STATE_KEY } from '@/lib/wallet-metadata-storage'
import { IndexedDbStorageV2Repository } from '@/infrastructure/persistence/repositories'

const PREFIX = 'protocol-account-v2:'
const LEGACY_PREFIX = 'public-account-v1:'
const ACCOUNT_DATA_LOCK = 'noir-account-data'

export interface NoirPublicProjectionScope {
  readonly walletId: string
  readonly accountId: string
  readonly network: Network
}

function key(
  scope: NoirPublicProjectionScope,
  parent: string,
  chain: 'zcash-l2' | 'evm' = 'zcash-l2'
): string {
  return `${PREFIX}${JSON.stringify([
    scope.network,
    scope.walletId,
    scope.accountId,
    parent,
    ...(chain === 'evm' ? ['evm'] : [])
  ])}`
}

export async function withPublicAccountDataLock<T>(operation: () => Promise<T>): Promise<T> {
  if (!navigator.locks)
    return Promise.reject(new Error('Account data storage coordination is unavailable'))
  return await navigator.locks.request(ACCOUNT_DATA_LOCK, operation)
}

export async function isRetainedPublicAccount(scope: NoirPublicProjectionScope): Promise<boolean> {
  const saved = await chrome.storage.local.get([
    WALLET_STATE_KEY,
    'wallet_deleted_ids',
    'wallet_deleted_account_keys'
  ])
  const metadata =
    typeof saved[WALLET_STATE_KEY] === 'string'
      ? JSON.parse(saved[WALLET_STATE_KEY])
      : saved[WALLET_STATE_KEY]
  const deletedWallets = saved.wallet_deleted_ids
  const deletedAccounts = saved.wallet_deleted_account_keys
  if (
    (deletedWallets !== undefined && !Array.isArray(deletedWallets)) ||
    (deletedAccounts !== undefined && !Array.isArray(deletedAccounts)) ||
    deletedWallets?.includes(scope.walletId) ||
    deletedAccounts?.includes(`${scope.network}_${scope.walletId}_${scope.accountId}`)
  )
    return false
  if (
    Array.isArray(metadata?.state?.wallets) &&
    metadata.state.wallets.some(
      (wallet: { id?: unknown; accounts?: unknown }) =>
        wallet.id === scope.walletId &&
        Array.isArray(wallet.accounts) &&
        wallet.accounts.some((item: { id?: unknown }) => item.id === scope.accountId)
    )
  )
    return true
  const storage = new IndexedDbStorageV2Repository()
  const pointer = await storage.getActivePointer()
  if (!pointer) return false
  const snapshot = await storage.getSnapshot(pointer.generationId)
  return (
    snapshot?.manifest.status === 'verified' &&
    snapshot.manifest.sourceFingerprint === pointer.sourceFingerprint &&
    snapshot.accounts.some(
      account => account.id === scope.accountId && account.keyDomainId === scope.walletId
    )
  )
}

export async function readPublicAccountProjection(
  scope: NoirPublicProjectionScope,
  parent: string,
  chain: 'zcash-l2' | 'evm' = 'zcash-l2'
): Promise<NoirPublicAccount | null> {
  const storageKey = key(scope, parent, chain)
  const value: unknown = (await chrome.storage.local.get(storageKey))[storageKey]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Partial<NoirPublicAccount>
  if (
    (record.chain === 'evm'
      ? record.signingMode !== 'evm' ||
        typeof record.publicKey !== 'string' ||
        typeof record.address !== 'string' ||
        !/^0x[0-9a-f]{40}$/.test(record.publicKey) ||
        record.address !== record.publicKey
      : record.chain !== 'zcash-l2' ||
        (record.signingMode !== 'derived' && record.signingMode !== 'legacy_index0') ||
        typeof record.publicKey !== 'string' ||
        !/^04[0-9a-f]{128}$/.test(record.publicKey)) ||
    record.network !== scope.network ||
    record.chain !== chain ||
    record.parentContractId !== parent ||
    typeof record.address !== 'string' ||
    record.address.length > 128 ||
    (record.mcaId !== null && (typeof record.mcaId !== 'string' || record.mcaId.length > 64)) ||
    !['inactive', 'activating', 'active'].includes(record.status ?? '') ||
    (record.activationId !== undefined && typeof record.activationId !== 'string')
  )
    return null
  return {
    chain: record.chain!,
    network: scope.network,
    parentContractId: parent,
    publicKey: record.publicKey!,
    signingMode: record.signingMode!,
    address: record.address,
    mcaId: record.mcaId,
    status: record.status!,
    ...(record.activationId ? { activationId: record.activationId } : {})
  }
}

export async function writePublicAccountProjection(
  scope: NoirPublicProjectionScope,
  account: NoirPublicAccount
): Promise<void> {
  await withPublicAccountDataLock(async () => {
    // Match the balance cache lock order. Never take the metadata lock while
    // holding the cache lock; removal persists metadata before clearing caches.
    if (!(await isRetainedPublicAccount(scope))) return
    await chrome.storage.local.set({
      [key(scope, account.parentContractId, account.chain)]: account
    })
  })
}

export async function deletePublicAccountProjections(
  walletId?: string,
  accountId?: string
): Promise<void> {
  await withPublicAccountDataLock(async () => {
    const saved = await chrome.storage.local.get(null)
    const keys = Object.keys(saved).filter(storageKey => {
      const prefix = storageKey.startsWith(PREFIX) ? PREFIX : LEGACY_PREFIX
      if (!storageKey.startsWith(prefix)) return false
      if (!walletId) return true
      try {
        const parts: unknown = JSON.parse(storageKey.slice(prefix.length))
        return (
          Array.isArray(parts) &&
          parts[1] === walletId &&
          (accountId === undefined || parts[2] === accountId)
        )
      } catch {
        return false
      }
    })
    if (keys.length) await chrome.storage.local.remove(keys)
  })
}
