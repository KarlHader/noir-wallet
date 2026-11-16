export interface PassiveSyncState {
  now: number
  lastSyncTime: number | null
  maxAgeMs: number
  isSchedulerRunning: boolean
}

export interface PeriodicSyncActivityState {
  isSchedulerRunning: boolean
  isWalletUiOpen: boolean
  hasPendingTransactions: boolean
  isWalletLocked: boolean
  hasPersistedSnapshot: boolean
  currentHeight: number
  networkHeight: number | null
  lastSyncTime: number | null
  now: number
  minBlockGap: number
  maxStaleMs: number
}

export interface PassiveSyncDelayOptions {
  baseMinutes: number
  jitterMinutes: number
  maxMinutes: number
  failureCount: number
  randomUnit: number
}

export interface InterruptedSyncResumeState {
  now: number
  updatedAt: number
  maxAgeMs: number
  resumeOnStartup?: boolean
}

export function shouldSchedulePassiveSync(state: PassiveSyncState): boolean {
  if (state.isSchedulerRunning) return false
  if (state.lastSyncTime === null) return true
  return state.now - state.lastSyncTime >= state.maxAgeMs
}

export function shouldRequestPeriodicSync(state: PeriodicSyncActivityState): boolean {
  if (state.isSchedulerRunning) return false
  if (state.isWalletLocked && !state.hasPersistedSnapshot) return false
  if (state.isWalletUiOpen || state.hasPendingTransactions) return true
  if (state.networkHeight === null || state.networkHeight <= 0) return false
  const gap = Math.max(0, state.networkHeight - Math.max(0, state.currentHeight))
  const stale = state.lastSyncTime === null || state.now - state.lastSyncTime >= state.maxStaleMs
  return gap >= state.minBlockGap || stale
}

export function computePassiveSyncDelayMinutes(options: PassiveSyncDelayOptions): number {
  const multiplier = 2 ** Math.max(0, Math.floor(options.failureCount))
  const base = Math.min(options.maxMinutes, options.baseMinutes * multiplier)
  const random = Math.min(1, Math.max(0, options.randomUnit))
  const jitter = (random * 2 - 1) * Math.max(0, options.jitterMinutes)
  return Math.max(1, Math.min(options.maxMinutes, base + jitter))
}

export function shouldResumeInterruptedSync(state: InterruptedSyncResumeState): boolean {
  return state.resumeOnStartup !== false && state.now - state.updatedAt < state.maxAgeMs
}
