import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveAccountIdForRemoval } from '../../../src/background/account-removal-account-id.ts'

test('account removal uses only a mapping for the same derivation index', async () => {
  assert.equal(
    await resolveAccountIdForRemoval({ wasmAccountId: 7, hdIndex: 10 }, 10, async () => {
      throw new Error('lookup should not run')
    }),
    7
  )
  assert.equal(
    await resolveAccountIdForRemoval({ wasmAccountId: 7, hdIndex: 9 }, 10, async () => 12),
    12
  )
})

test('dirty optional ID lookup cannot stop authoritative account removal', async () => {
  assert.equal(
    await resolveAccountIdForRemoval(undefined, 10, async () => {
      throw new Error('WALLET_DIRTY: in-memory wallet stale after abort')
    }),
    null
  )
  assert.equal(await resolveAccountIdForRemoval(undefined, 10), null)
  await assert.rejects(
    resolveAccountIdForRemoval(undefined, 10, async () => {
      throw new Error('Worker unavailable')
    }),
    /Worker unavailable/
  )
})
