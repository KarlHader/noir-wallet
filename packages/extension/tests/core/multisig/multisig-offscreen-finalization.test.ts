import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createMultisigFinalizationExclusion,
  finalizeMultisigWithSnapshot,
  saveAndReadbackMainWalletSnapshot,
  submitMultisigOnce
} from '../../../src/offscreen/multisig-finalization'
import {
  assertFinalizationBarrierCleared,
  beginFinalizationBarrier,
  clearFinalizationBarrier,
  hasFinalizationBarrier,
  type FinalizationBarrierStorage
} from '../../../src/lib/multisig-finalization-barrier'

const receipt = {
  accountId: 'account',
  txId: '12'.repeat(32),
  rawTxSha256: '34'.repeat(32),
  rawTxLen: 2300,
  network: 'testnet' as const
}

const lifecycle = {
  beginBarrier: async () => 'barrier',
  recordReceipt: async () => {},
  recordProtectedSnapshot: async () => {},
  recordDurableFinalization: async () => {},
  assertStable: () => {},
  clearBarrier: async (_marker: string) => {}
}

function barrierStorage() {
  const records = new Map<string, unknown>()
  const storage: FinalizationBarrierStorage = {
    read: async key => records.get(key),
    write: async (key, value) => {
      records.set(key, value)
    },
    remove: async key => {
      records.delete(key)
    },
    runExclusive: async (_key, operation) => operation()
  }
  return { records, storage }
}

test('durable barrier is read back before finalization can begin and is cleared last', async () => {
  const { records, storage } = barrierStorage()
  const scope = {
    network: 'testnet' as const,
    walletId: 'wallet',
    accountId: 'account',
    reviewId: 'review',
    sessionId: 'session'
  }
  const marker = await beginFinalizationBarrier(scope, 'token-1', storage)
  assert.equal(records.size, 1)
  await assert.rejects(assertFinalizationBarrierCleared(scope, storage), /pending/)
  await clearFinalizationBarrier(marker, storage)
  await assertFinalizationBarrierCleared(scope, storage)
})

test('barrier write or readback failure refuses to authorize mutation', async () => {
  const scope = {
    network: 'testnet' as const,
    walletId: 'wallet',
    accountId: 'account',
    reviewId: 'review',
    sessionId: 'session'
  }
  const { storage } = barrierStorage()
  storage.write = async () => {
    throw new Error('storage unavailable')
  }
  await assert.rejects(beginFinalizationBarrier(scope, 'token-1', storage), /storage unavailable/)
  storage.write = async () => {}
  await assert.rejects(beginFinalizationBarrier(scope, 'token-1', storage), /readback/)
})

test('a committed marker remains visible after readback fails across a fresh check', async () => {
  const { records, storage } = barrierStorage()
  const scope = {
    network: 'testnet' as const,
    walletId: 'wallet',
    accountId: 'account',
    reviewId: 'review',
    sessionId: 'session'
  }
  const read = storage.read
  let writes = 0
  storage.write = async (key, value) => {
    records.set(key, value)
    writes++
  }
  storage.read = async key => {
    if (writes > 0) throw new Error('readback unavailable')
    return read(key)
  }
  await assert.rejects(beginFinalizationBarrier(scope, 'token-1', storage), /readback unavailable/)
  storage.read = read
  assert.equal(await hasFinalizationBarrier(scope, storage), true)
})

test('barrier token mismatch cannot remove a replacement or allow restart', async () => {
  const { records, storage } = barrierStorage()
  const scope = {
    network: 'testnet' as const,
    walletId: 'wallet',
    accountId: 'account',
    reviewId: 'review',
    sessionId: 'session'
  }
  const marker = await beginFinalizationBarrier(scope, 'token-1', storage)
  const key = [...records.keys()][0]
  records.set(key, { ...marker, token: 'token-2' })
  await assert.rejects(clearFinalizationBarrier(marker, storage), /changed/)
  await assert.rejects(assertFinalizationBarrierCleared(scope, storage), /pending/)
  assert.equal(records.size, 1)
})

test('an older incomplete barrier record still blocks wallet restore', async () => {
  const { records, storage } = barrierStorage()
  const scope = { network: 'testnet' as const, walletId: 'wallet' }
  records.set('noir_multisig_finalization_barrier_v1:testnet:wallet', {
    version: 1,
    ...scope,
    accountId: 'account',
    token: 'old-token'
  })
  assert.equal(await hasFinalizationBarrier(scope, storage), true)
  await assert.rejects(assertFinalizationBarrierCleared(scope, storage), /pending/)
})

test('finalization returns only after exact wallet snapshot is saved and read back', async () => {
  const events: string[] = []
  const chunks = [Uint8Array.from([1, 2]), Uint8Array.from([3])]
  const result = await finalizeMultisigWithSnapshot(
    { walletId: 'wallet', accountId: 'account', network: 'testnet' },
    {
      ...lifecycle,
      beginBarrier: async () => {
        events.push('barrier-and-readback')
        return 'barrier'
      },
      finalize: async () => {
        events.push('finalize')
        return receipt
      },
      recordReceipt: async () => {
        events.push('receipt-and-readback')
      },
      snapshot: async () => {
        events.push('snapshot')
        return chunks
      },
      saveVerifiedSnapshot: async input => {
        assert.deepEqual(input, {
          walletId: 'wallet',
          accountId: 'account',
          network: 'testnet',
          txId: receipt.txId,
          chunks
        })
        events.push('protect-and-readback')
        return { snapshotSha256: '56'.repeat(32) }
      },
      recordProtectedSnapshot: async () => {
        events.push('protected-metadata-and-readback')
      },
      saveVerifiedMainSnapshot: async input => {
        assert.deepEqual(input, {
          walletId: 'wallet',
          accountId: 'account',
          network: 'testnet',
          chunks
        })
        events.push('main-and-readback')
      },
      recordDurableFinalization: async () => {
        events.push('durable-metadata-and-readback')
      },
      clearBarrier: async () => {
        events.push('barrier-clear-and-readback')
      }
    }
  )
  assert.deepEqual(events, [
    'barrier-and-readback',
    'finalize',
    'receipt-and-readback',
    'snapshot',
    'protect-and-readback',
    'protected-metadata-and-readback',
    'main-and-readback',
    'durable-metadata-and-readback',
    'barrier-clear-and-readback'
  ])
  assert.deepEqual(result, { ...receipt, snapshotSha256: '56'.repeat(32) })
})

test('failed snapshot readback cannot produce a finalization receipt', async () => {
  let cleared = false
  await assert.rejects(
    finalizeMultisigWithSnapshot(
      { walletId: 'wallet', accountId: 'account', network: 'testnet' },
      {
        ...lifecycle,
        clearBarrier: async () => {
          cleared = true
        },
        finalize: async () => receipt,
        snapshot: async () => [Uint8Array.of(1)],
        saveVerifiedSnapshot: async () => {
          throw new Error('readback mismatch')
        },
        saveVerifiedMainSnapshot: async () => {}
      }
    ),
    /readback mismatch/
  )
  assert.equal(cleared, false)
})

test('failed main wallet readback cannot produce a finalization receipt', async () => {
  let cleared = false
  await assert.rejects(
    finalizeMultisigWithSnapshot(
      { walletId: 'wallet', accountId: 'account', network: 'testnet' },
      {
        ...lifecycle,
        clearBarrier: async () => {
          cleared = true
        },
        finalize: async () => receipt,
        snapshot: async () => [Uint8Array.of(1)],
        saveVerifiedSnapshot: async () => ({ snapshotSha256: '56'.repeat(32) }),
        saveVerifiedMainSnapshot: async () => {
          throw new Error('main readback mismatch')
        }
      }
    ),
    /main readback mismatch/
  )
  assert.equal(cleared, false)
})

test('finalization excludes concurrent work for only its own wallet', async () => {
  const exclusion = createMultisigFinalizationExclusion()
  let release!: () => void
  const hold = new Promise<void>(resolve => {
    release = resolve
  })
  const pending = exclusion.run('wallet-a', () => hold)
  assert.equal(exclusion.isBusy('wallet-a'), true)
  assert.equal(exclusion.isBusy('wallet-b'), false)
  await assert.rejects(
    exclusion.run('wallet-a', async () => {}),
    /already in progress/
  )
  await exclusion.run('wallet-b', async () => {})
  release()
  await pending
  assert.equal(exclusion.isBusy('wallet-a'), false)
})

test('network mismatch and malformed finalizer receipts cannot be saved', async () => {
  let reads = 0
  for (const invalid of [
    { ...receipt, network: 'mainnet' },
    { ...receipt, rawTxLen: 0 },
    { ...receipt, accountId: 'other' }
  ]) {
    await assert.rejects(
      finalizeMultisigWithSnapshot(
        { walletId: 'wallet', accountId: 'account', network: 'testnet' },
        {
          ...lifecycle,
          finalize: async () => invalid,
          snapshot: async () => {
            reads++
            return [Uint8Array.of(1)]
          },
          saveVerifiedSnapshot: async () => ({ snapshotSha256: '56'.repeat(32) }),
          saveVerifiedMainSnapshot: async () => {}
        }
      )
    )
  }
  assert.equal(reads, 0)
})

test('barrier failure prevents Worker mutation and Worker failure leaves barrier intact', async () => {
  let finalizations = 0
  let clears = 0
  const scope = { walletId: 'wallet', accountId: 'account', network: 'testnet' as const }
  await assert.rejects(
    finalizeMultisigWithSnapshot(scope, {
      ...lifecycle,
      beginBarrier: async () => {
        throw new Error('marker unavailable')
      },
      finalize: async () => {
        finalizations++
        return receipt
      },
      snapshot: async () => [Uint8Array.of(1)],
      saveVerifiedSnapshot: async () => ({ snapshotSha256: '56'.repeat(32) }),
      saveVerifiedMainSnapshot: async () => {},
      clearBarrier: async () => {
        clears++
      }
    }),
    /marker unavailable/
  )
  assert.equal(finalizations, 0)
  await assert.rejects(
    finalizeMultisigWithSnapshot(scope, {
      ...lifecycle,
      finalize: async () => {
        finalizations++
        throw new Error('wasm trap')
      },
      snapshot: async () => [Uint8Array.of(1)],
      saveVerifiedSnapshot: async () => ({ snapshotSha256: '56'.repeat(32) }),
      saveVerifiedMainSnapshot: async () => {},
      clearBarrier: async () => {
        clears++
      }
    }),
    /wasm trap/
  )
  assert.equal(finalizations, 1)
  assert.equal(clears, 0)
})

test('Worker replacement after snapshot verification cannot clear the barrier', async () => {
  let cleared = 0
  let durable = 0
  await assert.rejects(
    finalizeMultisigWithSnapshot(
      { walletId: 'wallet', accountId: 'account', network: 'testnet' },
      {
        ...lifecycle,
        finalize: async () => receipt,
        snapshot: async () => [Uint8Array.of(1)],
        saveVerifiedSnapshot: async () => ({ snapshotSha256: '56'.repeat(32) }),
        saveVerifiedMainSnapshot: async () => {},
        assertStable: () => {
          throw new Error('STALE_WALLET_RPC: Worker replaced')
        },
        recordDurableFinalization: async () => {
          durable++
        },
        clearBarrier: async () => {
          cleared++
        }
      }
    ),
    /Worker replaced/
  )
  assert.equal(durable, 0)
  assert.equal(cleared, 0)
})

test('main wallet snapshot rejects a stale readback', async () => {
  const chunks = [Uint8Array.of(1, 2), Uint8Array.of(3)]
  let saved = 0
  await assert.rejects(
    saveAndReadbackMainWalletSnapshot('testnet_wallet', chunks, {
      saveWalletDb: async () => {
        saved++
      },
      loadWalletDb: async () => Uint8Array.of(1, 2, 4)
    }),
    /readback failed/
  )
  assert.equal(saved, 1)
})

test('submission errors never trigger a second network call', async () => {
  let calls = 0
  let persisted = 0
  await assert.rejects(
    submitMultisigOnce({
      submit: async () => {
        calls++
        throw new Error('response lost')
      },
      saveMainSnapshot: async () => {
        persisted++
      }
    }),
    /response lost/
  )
  assert.equal(calls, 1)
  assert.equal(persisted, 0)
})
