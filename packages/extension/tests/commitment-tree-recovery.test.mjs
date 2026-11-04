import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isIncompleteCommitmentTreeError,
  runWithCommitmentTreeRecovery
} from '../src/core/worker/commitment-tree-recovery.ts'

describe('commitment tree recovery', () => {
  it('refreshes cold subtree roots before building a PCZT', async () => {
    let fresh = false
    let refreshes = 0
    let operations = 0

    const result = await runWithCommitmentTreeRecovery({
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

  it('scans through the refreshed chain tip before spending on a warm wallet', async () => {
    let tipHeight = 100
    let scannedHeight = 100
    let refreshes = 0

    const result = await runWithCommitmentTreeRecovery({
      refresh: async () => {
        refreshes += 1
        tipHeight = 101
        scannedHeight = tipHeight
      },
      operation: async () => {
        assert.equal(tipHeight, 101)
        assert.equal(scannedHeight, tipHeight)
        return 'transaction'
      }
    })

    assert.equal(result, 'transaction')
    assert.equal(refreshes, 1)
  })

  it('refreshes and retries TreeIncomplete once', async () => {
    let refreshes = 0
    let operations = 0

    const result = await runWithCommitmentTreeRecovery({
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
    assert.equal(refreshes, 2)
    assert.equal(operations, 2)
  })

  it('stops after one TreeIncomplete retry', async () => {
    const expected = new Error('CommitmentTree(Query(TreeIncomplete([])))')
    let refreshes = 0
    let operations = 0

    await assert.rejects(
      runWithCommitmentTreeRecovery({
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

    assert.equal(refreshes, 2)
    assert.equal(operations, 2)
  })

  it('does not retry broadcast failures', async () => {
    const expected = new Error('Broadcast rejected: transaction expired')
    let refreshes = 0
    let operations = 0

    await assert.rejects(
      runWithCommitmentTreeRecovery({
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

    assert.equal(refreshes, 1)
    assert.equal(operations, 1)
  })

  it('does not build when the preflight refresh fails', async () => {
    const expected = new Error('gRPC GetLatestBlock failed')
    let operations = 0

    await assert.rejects(
      runWithCommitmentTreeRecovery({
        refresh: async () => {
          throw expected
        },
        operation: async () => {
          operations += 1
          return 'pczt'
        }
      }),
      error => error === expected
    )

    assert.equal(operations, 0)
  })

  it('does not replay a build when the TreeIncomplete refresh fails', async () => {
    const expected = new Error('gRPC GetLatestBlock failed')
    let refreshes = 0
    let operations = 0

    await assert.rejects(
      runWithCommitmentTreeRecovery({
        refresh: async () => {
          refreshes += 1
          if (refreshes === 2) throw expected
        },
        operation: async () => {
          operations += 1
          throw new Error('CommitmentTree(Query(TreeIncomplete([])))')
        }
      }),
      error => error === expected
    )

    assert.equal(refreshes, 2)
    assert.equal(operations, 1)
  })

  it('recognizes incomplete commitment trees', () => {
    assert.equal(isIncompleteCommitmentTreeError('CommitmentTree(Query(TreeIncomplete([])))'), true)
  })
})
