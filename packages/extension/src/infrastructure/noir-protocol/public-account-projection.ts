import type { NoirPublicAccount } from '@/core/services/noir-protocol/public/types'
import type { Network } from '@/types'
import { WALLET_STATE_KEY } from '@/lib/wallet-metadata-storage'

const PREFIX = 'public-account-v1:'
const ACCOUNT_DATA_LOCK = 'noir-account-data'

export interface NoirPublicProjectionScope {
  readonly walletId: string
  readonly accountId: string
  readonly network: Network
}

function key(scope: NoirPublicProjectionScope, parent: string): string {
  return `${PREFIX}${JSON.stringify([scope.network, scope.walletId, scope.accountId, parent])}`
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
    !Array.isArray(metadata?.state?.wallets) ||
    (deletedWallets !== undefined && !Array.isArray(deletedWallets)) ||
    (deletedAccounts !== undefined && !Array.isArray(deletedAccounts)) ||
    deletedWallets?.includes(scope.walletId) ||
    deletedAccounts?.includes(`${scope.network}_${scope.walletId}_${scope.accountId}`)
  )
    return false
  return metadata.state.wallets.some(
    (wallet: { id?: unknown; accounts?: unknown }) =>
      wallet.id === scope.walletId &&
      Array.isArray(wallet.accounts) &&
      wallet.accounts.some((item: { id?: unknown }) => item.id === scope.accountId)
  )
}

export async function readPublicAccountProjection(
  scope: NoirPublicProjectionScope,
  parent: string
): Promise<NoirPublicAccount | null> {
  const storageKey = key(scope, parent)
  const value: unknown = (await chrome.storage.local.get(storageKey))[storageKey]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Partial<NoirPublicAccount>
  if (
    record.chain !== 'zcash-l2' ||
    record.network !== scope.network ||
    record.parentContractId !== parent ||
    typeof record.publicKey !== 'string' ||
    !/^04[0-9a-f]{128}$/.test(record.publicKey) ||
    typeof record.address !== 'string' ||
    record.address.length > 128 ||
    (record.mcaId !== null && (typeof record.mcaId !== 'string' || record.mcaId.length > 64)) ||
    !['inactive', 'activating', 'active'].includes(record.status ?? '') ||
    (record.activationId !== undefined && typeof record.activationId !== 'string')
  )
    return null
  return {
    chain: 'zcash-l2',
    network: scope.network,
    parentContractId: parent,
    publicKey: record.publicKey,
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
    await chrome.storage.local.set({ [key(scope, account.parentContractId)]: account })
  })
}

export async function deletePublicAccountProjections(
  walletId?: string,
  accountId?: string
): Promise<void> {
  await withPublicAccountDataLock(async () => {
    const saved = await chrome.storage.local.get(null)
    const keys = Object.keys(saved).filter(storageKey => {
      if (!storageKey.startsWith(PREFIX)) return false
      if (!walletId) return true
      try {
        const parts: unknown = JSON.parse(storageKey.slice(PREFIX.length))
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
