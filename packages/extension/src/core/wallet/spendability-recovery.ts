export const SPENDABILITY_SYNC_IN_PROGRESS_MESSAGE =
  'Wallet sync is still in progress. Please try again when it finishes.'
export const SPENDABILITY_REPAIR_STARTED_MESSAGE =
  'Wallet balance metadata is being refreshed. Please try again after sync finishes.'
export const SPENDABILITY_RESTART_REQUIRED_MESSAGE =
  'Wallet balance metadata is still unavailable. Restart the extension and try again.'

export async function runWithSpendabilityRecovery<T>(options: {
  operation: () => Promise<T>
  isMetadataError: (error: unknown) => boolean
  isSyncing: () => Promise<boolean>
  waitForSyncIdle: () => Promise<boolean>
  recover: () => Promise<void>
}): Promise<T> {
  let stableFailures = 0
  const startedDuringSync = await options.isSyncing()
  try {
    return await options.operation()
  } catch (error) {
    if (!options.isMetadataError(error)) throw error
    stableFailures = startedDuringSync || (await options.isSyncing()) ? 0 : 1
  }

  for (let retry = 0; retry < 4 && stableFailures < 2; retry++) {
    if (await options.isSyncing()) {
      stableFailures = 0
      if (!(await options.waitForSyncIdle())) {
        throw new Error(SPENDABILITY_SYNC_IN_PROGRESS_MESSAGE)
      }
    }
    try {
      return await options.operation()
    } catch (error) {
      if (!options.isMetadataError(error)) throw error
      stableFailures = (await options.isSyncing()) ? 0 : stableFailures + 1
    }
  }
  if (stableFailures < 2) throw new Error(SPENDABILITY_SYNC_IN_PROGRESS_MESSAGE)
  await options.recover()
  throw new Error(SPENDABILITY_REPAIR_STARTED_MESSAGE)
}

export async function runSpendabilitySnapshotRefresh(options: {
  hasAttempted: () => boolean
  hasPersistedSnapshot: () => Promise<boolean>
  markAttempted: () => void
  clearAttempt: () => void
  reloadPersistedSnapshot: () => Promise<void>
  startCatchUpSync: () => void | Promise<void>
}): Promise<void> {
  if (options.hasAttempted() || !(await options.hasPersistedSnapshot())) {
    throw new Error(SPENDABILITY_RESTART_REQUIRED_MESSAGE)
  }
  options.markAttempted()
  try {
    await options.reloadPersistedSnapshot()
    await options.startCatchUpSync()
  } catch (error) {
    options.clearAttempt()
    throw error
  }
}
