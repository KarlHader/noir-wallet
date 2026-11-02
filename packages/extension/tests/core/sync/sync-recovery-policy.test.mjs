import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  runSpendabilitySnapshotRefresh,
  runWithSpendabilityRecovery,
  SPENDABILITY_REPAIR_STARTED_MESSAGE,
  SPENDABILITY_RESTART_REQUIRED_MESSAGE
} from '../../../src/core/wallet/spendability-recovery.ts'
import {
  computePassiveSyncDelayMinutes,
  shouldRequestPeriodicSync,
  shouldResumeInterruptedSync
} from '../../../src/background/passive-sync-policy.ts'
import { shouldMarkSyncJobInterrupted } from '../../../src/lib/sync-job-store.ts'

const metadataError = () => new Error('WALLET_SPENDABILITY_INCONSISTENT')

test('spendability metadata retries through an active scan without resetting persistence', async () => {
  let calls = 0
  let recovered = false
  const result = await runWithSpendabilityRecovery({
    operation: async () => {
      if (++calls === 1) throw metadataError()
      return 42
    },
    isMetadataError: error => String(error).includes('WALLET_SPENDABILITY_INCONSISTENT'),
    isSyncing: async () => calls === 0,
    waitForSyncIdle: async () => true,
    recover: async () => {
      recovered = true
    }
  })
  assert.equal(result, 42)
  assert.equal(calls, 2)
  assert.equal(recovered, false)
})

test('stable spendability metadata failure reloads a snapshot once and requests catch-up', async () => {
  let attempted = false
  let reloads = 0
  let catchUps = 0
  await assert.rejects(
    runWithSpendabilityRecovery({
      operation: async () => {
        throw metadataError()
      },
      isMetadataError: error => String(error).includes('WALLET_SPENDABILITY_INCONSISTENT'),
      isSyncing: async () => false,
      waitForSyncIdle: async () => true,
      recover: () =>
        runSpendabilitySnapshotRefresh({
          hasAttempted: () => attempted,
          hasPersistedSnapshot: async () => true,
          markAttempted: () => {
            attempted = true
          },
          clearAttempt: () => {
            attempted = false
          },
          reloadPersistedSnapshot: async () => {
            reloads++
          },
          startCatchUpSync: () => {
            catchUps++
          }
        })
    }),
    { message: SPENDABILITY_REPAIR_STARTED_MESSAGE }
  )
  assert.equal(reloads, 1)
  assert.equal(catchUps, 1)
  assert.equal(attempted, true)
  await assert.rejects(
    runSpendabilitySnapshotRefresh({
      hasAttempted: () => attempted,
      hasPersistedSnapshot: async () => true,
      markAttempted: () => {},
      clearAttempt: () => {},
      reloadPersistedSnapshot: async () => {},
      startCatchUpSync: () => {}
    }),
    { message: SPENDABILITY_RESTART_REQUIRED_MESSAGE }
  )
})

test('locked passive sync needs a snapshot and sufficient chain gap or staleness', () => {
  const state = {
    isSchedulerRunning: false,
    isWalletUiOpen: false,
    hasPendingTransactions: false,
    isWalletLocked: true,
    hasPersistedSnapshot: true,
    currentHeight: 100,
    networkHeight: 105,
    lastSyncTime: 1_000,
    now: 2_000,
    minBlockGap: 10,
    maxStaleMs: 10_000
  }
  assert.equal(shouldRequestPeriodicSync(state), false)
  assert.equal(
    shouldRequestPeriodicSync({ ...state, hasPersistedSnapshot: false, networkHeight: 120 }),
    false
  )
  assert.equal(shouldRequestPeriodicSync({ ...state, networkHeight: 110 }), true)
  assert.equal(shouldRequestPeriodicSync({ ...state, now: 11_001 }), true)
  assert.equal(shouldRequestPeriodicSync({ ...state, hasPendingTransactions: true }), true)
  assert.equal(shouldRequestPeriodicSync({ ...state, isSchedulerRunning: true }), false)
})

test('passive retry delay is bounded and budgeted jobs do not resume at startup', () => {
  assert.equal(
    computePassiveSyncDelayMinutes({
      baseMinutes: 30,
      jitterMinutes: 5,
      maxMinutes: 120,
      failureCount: 8,
      randomUnit: 1
    }),
    120
  )
  assert.equal(
    shouldResumeInterruptedSync({
      now: 2_000,
      updatedAt: 1_000,
      maxAgeMs: 10_000,
      resumeOnStartup: false
    }),
    false
  )
})

test('pending balance settlement alone does not classify a durable sync as interrupted', () => {
  const state = {
    snapshotFailed: false,
    flushFailed: false,
    finalPersistFailed: false,
    skippedFinalPersist: false,
    hasPendingJournal: false,
    hasPendingBalanceSettlement: true
  }
  assert.equal(shouldMarkSyncJobInterrupted(state), false)
  assert.equal(shouldMarkSyncJobInterrupted({ ...state, finalPersistFailed: true }), true)
  assert.equal(shouldMarkSyncJobInterrupted({ ...state, flushFailed: true }), true)
  assert.equal(
    shouldMarkSyncJobInterrupted({ ...state, skippedFinalPersist: true, hasPendingJournal: true }),
    true
  )
})
