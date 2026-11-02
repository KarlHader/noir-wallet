import { test as it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  isIncompleteCommitmentTreeError,
  runWithCommitmentTreeRecovery
} from '../../../src/core/worker/commitment-tree-recovery.ts'

const describe = it.describe

describe('commitment tree recovery', () => {
  it('refreshes cold subtree roots before building a PCZT', async () => {
    let fresh = false
    let refreshes = 0
    let operations = 0

    const result = await runWithCommitmentTreeRecovery({
      isFresh: () => fresh,
      refresh: async () => {
        refreshes += 1
        fresh = true
      },
      operation: async () => {
        operations += 1
        assert.equal(fresh, true)
        return 'pczt'
      }
    })

    assert.equal(result, 'pczt')
    assert.equal(refreshes, 1)
    assert.equal(operations, 1)
  })

  it('refreshes and retries TreeIncomplete once', async () => {
    let refreshes = 0
    let operations = 0

    const result = await runWithCommitmentTreeRecovery({
      isFresh: () => true,
      refresh: async () => {
        refreshes += 1
      },
      operation: async () => {
        operations += 1
        if (operations === 1) {
          throw new Error(
            'Failed to create PCZT for transfer: CommitmentTree(Query(TreeIncomplete([])))'
          )
        }
        return 'txid'
      }
    })

    assert.equal(result, 'txid')
    assert.equal(refreshes, 1)
    assert.equal(operations, 2)
  })

  it('does not retry unrelated transaction failures', async () => {
    const expected = new Error('Failed to create PCZT: InsufficientFunds')
    let refreshes = 0
    let operations = 0

    await assert.rejects(
      runWithCommitmentTreeRecovery({
        isFresh: () => true,
        refresh: async () => {
          refreshes += 1
        },
        operation: async () => {
          operations += 1
          throw expected
        }
      }),
      error => error === expected
    )

    assert.equal(refreshes, 0)
    assert.equal(operations, 1)
  })

  it('matches the WASM error and wraps all PCZT build paths', () => {
    assert.equal(
      isIncompleteCommitmentTreeError(
        'CommitmentTree(Query(TreeIncomplete([(Address { level: Level(0), index: 1 })])))'
      ),
      true
    )

    const worker = readFileSync(
      new URL('../../../src/core/worker/zcash.worker.ts', import.meta.url),
      'utf-8'
    )
    for (const method of [
      'w.pczt_create(',
      'w.pczt_shield_create(',
      'w.oneclick_transfer(',
      'w.oneclick_pczt_shield_dynamic_fee('
    ]) {
      const methodIndex = worker.indexOf(method)
      assert.notEqual(methodIndex, -1)
      const wrapperIndex = worker.lastIndexOf('runWithFreshCommitmentTrees(', methodIndex)
      assert.ok(wrapperIndex !== -1 && methodIndex - wrapperIndex < 1_500)
    }
  })
})
