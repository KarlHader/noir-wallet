import { sha256 } from '@noble/hashes/sha2'
import { bytesToBase64, bytesToHex } from '@/lib/bytes'
import { parseKeyDomainId } from '@/core/keyring/domain/key-domain'
import { parseAccountId } from '@/core/accounts/domain/account'
import { deleteWalletDbPrefix, loadWalletDb, saveWalletDb } from './indexed-db'

interface SnapshotScope {
  network: 'mainnet' | 'testnet'
  walletId: string
  accountId: string
  txId: string
}
interface SaveSnapshot extends SnapshotScope {
  chunks: readonly Uint8Array[]
}
interface VerifySnapshot extends SnapshotScope {
  snapshotSha256: string
}
interface SnapshotStorage {
  loadWalletDb(key: string): Promise<Uint8Array | null>
  saveWalletDb(key: string, chunks: Uint8Array[]): Promise<unknown>
  deleteWalletDbPrefix(prefix: string): Promise<void>
}

const FAIL = 'Multisig transaction snapshot is unavailable'

function lockName(scope: Pick<SnapshotScope, 'network' | 'walletId'>): string {
  return `noir-multisig-snapshot:${scope.network}_${scope.walletId}`
}

function snapshotKey(scope: SnapshotScope): string {
  const walletId = parseKeyDomainId(scope.walletId)
  const accountId = parseAccountId(scope.accountId)
  if (
    (scope.network !== 'mainnet' && scope.network !== 'testnet') ||
    !/^[A-Za-z0-9-]{1,128}$/.test(walletId) ||
    !/^[0-9a-f]{64}$/.test(scope.txId)
  )
    throw new Error(FAIL)
  return `${scope.network}_${walletId}_multisig.${bytesToBase64(new TextEncoder().encode(accountId)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.${scope.txId}`
}

function snapshotPrefix(
  scope: Omit<SnapshotScope, 'txId'> | Pick<SnapshotScope, 'network' | 'walletId'>
): string {
  const walletId = parseKeyDomainId(scope.walletId)
  if (
    (scope.network !== 'mainnet' && scope.network !== 'testnet') ||
    !/^[A-Za-z0-9-]{1,128}$/.test(walletId)
  )
    throw new Error(FAIL)
  const walletPrefix = `${scope.network}_${walletId}_multisig.`
  if (!('accountId' in scope)) return walletPrefix
  const accountId = parseAccountId(scope.accountId)
  return `${walletPrefix}${bytesToBase64(new TextEncoder().encode(accountId)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.`
}

function digest(chunks: readonly Uint8Array[]): string {
  const hash = sha256.create()
  for (const chunk of chunks) hash.update(chunk)
  return bytesToHex(hash.digest())
}

function matchesChunks(readback: Uint8Array, chunks: readonly Uint8Array[]): boolean {
  let offset = 0
  for (const chunk of chunks) {
    if (offset + chunk.length > readback.length) return false
    for (let index = 0; index < chunk.length; index++)
      if (readback[offset + index] !== chunk[index]) return false
    offset += chunk.length
  }
  return offset === readback.length
}

export function createMultisigSnapshotStore(storage: SnapshotStorage) {
  return {
    async saveVerifiedMultisigSnapshot(input: SaveSnapshot): Promise<{ snapshotSha256: string }> {
      const key = snapshotKey(input)
      if (
        !Array.isArray(input.chunks) ||
        input.chunks.length === 0 ||
        input.chunks.some(chunk => !(chunk instanceof Uint8Array) || chunk.length === 0)
      )
        throw new Error(FAIL)
      if (!navigator.locks) throw new Error(FAIL)
      return navigator.locks.request(lockName(input), async () => {
        if (await storage.loadWalletDb(key)) throw new Error(FAIL)
        const expectedSha256 = digest(input.chunks)
        await storage.saveWalletDb(key, [...input.chunks])
        const readback = await storage.loadWalletDb(key)
        if (
          !readback ||
          digest([readback]) !== expectedSha256 ||
          !matchesChunks(readback, input.chunks)
        )
          throw new Error(FAIL)
        return { snapshotSha256: expectedSha256 }
      })
    },
    async verifyMultisigSnapshot(input: VerifySnapshot): Promise<void> {
      const key = snapshotKey(input)
      if (!/^[0-9a-f]{64}$/.test(input.snapshotSha256)) throw new Error(FAIL)
      const snapshot = await storage.loadWalletDb(key)
      if (!snapshot || digest([snapshot]) !== input.snapshotSha256) throw new Error(FAIL)
    },
    async deleteProtectedMultisigSnapshotsForAccount(
      scope: Omit<SnapshotScope, 'txId'>
    ): Promise<void> {
      const prefix = snapshotPrefix(scope)
      if (!navigator.locks) throw new Error(FAIL)
      await navigator.locks.request(lockName(scope), async () => {
        await storage.deleteWalletDbPrefix(prefix)
      })
    },
    async deleteProtectedMultisigSnapshotsForWallet(
      scope: Pick<SnapshotScope, 'network' | 'walletId'>
    ): Promise<void> {
      const prefix = snapshotPrefix({ network: scope.network, walletId: scope.walletId })
      if (!navigator.locks) throw new Error(FAIL)
      await navigator.locks.request(lockName(scope), async () => {
        await storage.deleteWalletDbPrefix(prefix)
      })
    }
  }
}

const walletSnapshotStore = createMultisigSnapshotStore({
  loadWalletDb,
  saveWalletDb,
  deleteWalletDbPrefix
})
export const saveVerifiedMultisigSnapshot = walletSnapshotStore.saveVerifiedMultisigSnapshot
export const verifyMultisigSnapshot = walletSnapshotStore.verifyMultisigSnapshot
export const deleteProtectedMultisigSnapshotsForAccount =
  walletSnapshotStore.deleteProtectedMultisigSnapshotsForAccount
export const deleteProtectedMultisigSnapshotsForWallet =
  walletSnapshotStore.deleteProtectedMultisigSnapshotsForWallet
