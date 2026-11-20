import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMultisigSnapshotStore } from '../../../src/lib/multisig-transaction-snapshot'
import { installLockEnv } from './helpers/storage-env'

const scope = {
  network: 'testnet' as const,
  walletId: 'wallet',
  accountId: 'account',
  txId: 'ab'.repeat(32)
}

test('protected snapshot reads back exact bytes and cannot be overwritten', async () => {
  const restoreLocks = installLockEnv()
  try {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const snapshots = new Map<string, Uint8Array>()
    const store = createMultisigSnapshotStore({
      loadWalletDb: async key => snapshots.get(key)?.slice() ?? null,
      saveWalletDb: async (key, chunks) =>
        snapshots.set(key, Uint8Array.from(chunks.flatMap(chunk => [...chunk]))),
      deleteWalletDbPrefix: async prefix => {
        for (const key of snapshots.keys()) if (key.startsWith(prefix)) snapshots.delete(key)
      }
    })
    const saved = await store.saveVerifiedMultisigSnapshot({ ...scope, chunks: [bytes] })
    assert.match(saved.snapshotSha256, /^[0-9a-f]{64}$/)
    await store.verifyMultisigSnapshot({ ...scope, snapshotSha256: saved.snapshotSha256 })
    await assert.rejects(store.saveVerifiedMultisigSnapshot({ ...scope, chunks: [bytes] }))
    assert.equal(snapshots.size, 1)
    snapshots.set([...snapshots.keys()][0], new Uint8Array([9, 9, 9, 9]))
    await assert.rejects(
      store.verifyMultisigSnapshot({ ...scope, snapshotSha256: saved.snapshotSha256 })
    )
    await store.deleteProtectedMultisigSnapshotsForAccount(scope)
    assert.equal(snapshots.size, 0)
  } finally {
    restoreLocks()
  }
})

test('a save without exact readback never yields a finalization digest', async () => {
  const restoreLocks = installLockEnv()
  try {
    const store = createMultisigSnapshotStore({
      loadWalletDb: async () => null,
      saveWalletDb: async () => {},
      deleteWalletDbPrefix: async () => {}
    })
    await assert.rejects(
      store.saveVerifiedMultisigSnapshot({ ...scope, chunks: [new Uint8Array([1])] })
    )
  } finally {
    restoreLocks()
  }
})

test('snapshot cleanup is exact by account and wallet', async () => {
  const restoreLocks = installLockEnv()
  try {
    const snapshots = new Map<string, Uint8Array>()
    const store = createMultisigSnapshotStore({
      loadWalletDb: async key => snapshots.get(key)?.slice() ?? null,
      saveWalletDb: async (key, chunks) => snapshots.set(key, Uint8Array.from(chunks[0])),
      deleteWalletDbPrefix: async prefix => {
        for (const key of snapshots.keys()) if (key.startsWith(prefix)) snapshots.delete(key)
      }
    })
    const scopes = [
      scope,
      { ...scope, accountId: 'account-2', txId: 'cd'.repeat(32) },
      { ...scope, walletId: 'wallet-2', txId: 'ef'.repeat(32) }
    ]
    for (const entry of scopes)
      await store.saveVerifiedMultisigSnapshot({ ...entry, chunks: [new Uint8Array([1])] })
    await store.deleteProtectedMultisigSnapshotsForAccount(scope)
    assert.equal(snapshots.size, 2)
    await store.deleteProtectedMultisigSnapshotsForWallet(scope)
    assert.equal(snapshots.size, 1)
    assert.ok([...snapshots.keys()][0].includes('wallet-2'))
  } finally {
    restoreLocks()
  }
})
