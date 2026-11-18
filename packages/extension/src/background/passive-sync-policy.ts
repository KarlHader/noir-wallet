export interface RoutineScanState {
  currentHeight: number
  networkHeight: number
  lastCompletedAt?: number
  lastStartedAt?: number
  now: number
  minBlockGap: number
  maxStaleMs: number
  minIntervalMs: number
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

export function shouldStartRoutineScan(state: RoutineScanState): boolean {
  if (!Number.isSafeInteger(state.networkHeight) || state.networkHeight <= 0) return false
  if (state.lastStartedAt !== undefined && state.now - state.lastStartedAt < state.minIntervalMs)
    return false
  const gap = Math.max(0, state.networkHeight - Math.max(0, state.currentHeight))
  const stale =
    state.lastCompletedAt === undefined || state.now - state.lastCompletedAt >= state.maxStaleMs
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
