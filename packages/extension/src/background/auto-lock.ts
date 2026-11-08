export const WALLET_AUTO_LOCK_ALARM = 'wallet-auto-lock'
const AUTO_LOCK_RETRY_MS = 60_000

export interface AutoLockCoordinatorOptions {
  readonly readLastActivityTime: () => Promise<number | null>
  readonly readAutoLockMs: () => Promise<number>
  readonly hasUnlockSession: () => Promise<boolean>
  readonly hasUnlockedRuntime: () => boolean
  readonly lockOrphanedRuntime: () => Promise<'active' | 'locked'>
  readonly lock: () => Promise<'active' | 'locked'>
  readonly scheduleAlarm: (when: number) => Promise<void>
  readonly clearAlarm: () => Promise<void>
  readonly now?: () => number
}

export type AutoLockReconcileResult = 'disabled' | 'locked' | 'no-session' | 'scheduled'

export class AutoLockCoordinator {
  private readonly now: () => number
  private inFlight: Promise<AutoLockReconcileResult> | null = null
  private reconcileRequested = false

  constructor(private readonly options: AutoLockCoordinatorOptions) {
    this.now = options.now ?? Date.now
  }

  reconcile(): Promise<AutoLockReconcileResult> {
    this.reconcileRequested = true
    if (this.inFlight) return this.inFlight
    const operation = this.drainReconcileRequests().finally(() => {
      if (this.inFlight === operation) this.inFlight = null
    })
    this.inFlight = operation
    return operation
  }

  private async drainReconcileRequests(): Promise<AutoLockReconcileResult> {
    let result: AutoLockReconcileResult = 'no-session'
    while (this.reconcileRequested) {
      this.reconcileRequested = false
      result = await this.reconcileOnce()
    }
    return result
  }

  private async reconcileOnce(): Promise<AutoLockReconcileResult> {
    const autoLockMs = await this.options.readAutoLockMs()
    if (!Number.isSafeInteger(autoLockMs) || autoLockMs < 0) {
      throw new Error('Invalid auto-lock duration')
    }
    const [lastActivityTime, hasUnlockSession] = await Promise.all([
      this.options.readLastActivityTime(),
      this.options.hasUnlockSession()
    ])
    if (!hasUnlockSession) {
      if (this.options.hasUnlockedRuntime()) {
        let result: 'active' | 'locked'
        try {
          result = await this.options.lockOrphanedRuntime()
        } catch (error) {
          await this.options.scheduleAlarm(this.now() + AUTO_LOCK_RETRY_MS)
          throw error
        }
        if (result === 'active') {
          this.reconcileRequested = true
          return 'no-session'
        }
        await this.options.clearAlarm()
        return 'locked'
      }
      await this.options.clearAlarm()
      return 'no-session'
    }
    if (autoLockMs === 0) {
      await this.options.clearAlarm()
      return 'disabled'
    }
    if (lastActivityTime === null) {
      await this.options.clearAlarm()
      return 'no-session'
    }
    if (!Number.isSafeInteger(lastActivityTime) || lastActivityTime < 0) {
      throw new Error('Invalid last activity timestamp')
    }

    const deadline = lastActivityTime + autoLockMs
    if (!Number.isSafeInteger(deadline)) {
      throw new Error('Invalid auto-lock deadline')
    }
    if (deadline <= this.now()) {
      let result: 'active' | 'locked'
      try {
        result = await this.options.lock()
      } catch (error) {
        await this.options.scheduleAlarm(this.now() + AUTO_LOCK_RETRY_MS)
        throw error
      }
      if (result === 'active') {
        this.reconcileRequested = true
        return 'scheduled'
      }
      await this.options.clearAlarm()
      return 'locked'
    }

    await this.options.scheduleAlarm(deadline)
    return 'scheduled'
  }
}
