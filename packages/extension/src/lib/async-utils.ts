/**
 * Async utility classes for handling common patterns
 * in concurrent operations, initialization, and readiness tracking
 */

/**
 * Prevents concurrent execution of async operations.
 * Multiple callers will wait for the same promise instead of
 * starting duplicate operations.
 *
 * @example
 * ```typescript
 * const initDedup = new DedupPromise<void>()
 *
 * async function initialize() {
 *   await initDedup.run(async () => {
 *     await expensiveInitialization()
 *   })
 * }
 *
 * // Call 1 starts initialization
 * initialize()
 * // Call 2 waits for Call 1 (no duplicate work)
 * initialize()
 * ```
 */
export class DedupPromise<T> {
  private pending: Promise<T> | null = null
  private rejectPending: ((reason: Error) => void) | null = null

  async run(operation: () => Promise<T>, onComplete?: (result: T) => void): Promise<T> {
    if (this.pending) {
      return await this.pending
    }

    const promise = new Promise<T>((resolve, reject) => {
      this.rejectPending = err => reject(err)
      operation()
        .then(result => {
          onComplete?.(result)
          resolve(result)
        })
        .catch(reject)
    }).finally(() => {
      if (this.pending === promise) {
        this.pending = null
      }
      this.rejectPending = null
    })

    this.pending = promise
    return await promise
  }

  get isPending(): boolean {
    return this.pending !== null
  }

  reset(): void {
    this.abort()
  }

  abort(reason?: Error): void {
    if (this.rejectPending) {
      this.rejectPending(reason ?? new Error('DedupPromise aborted'))
      this.rejectPending = null
    }
    this.pending = null
  }
}

/** Runs each task after the previous task settles, including after failures. */
export class SerialTaskQueue {
  private tail: Promise<void> = Promise.resolve()

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.catch(() => {}).then(operation)
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

/**
 * Promise-based readiness flag that allows waiting for
 * a condition to be marked as ready.
 *
 * @example
 * ```typescript
 * const accountReady = new ReadyFlag()
 *
 * // Mark ready when condition met
 * async function loadAccount() {
 *   await fetchAccountData()
 *   accountReady.markReady() // ✅ Signal ready
 * }
 *
 * // Wait for ready before proceeding
 * async function useAccount() {
 *   await accountReady.wait() // ⏳ Blocks until ready
 *   // Account is guaranteed ready here
 * }
 * ```
 */
export class ReadyFlag {
  private isReady = false
  private promise!: Promise<void>
  private resolve!: () => void

  constructor() {
    this.reset()
  }

  /**
   * Mark as ready and resolve all waiting promises
   */
  markReady(): void {
    if (!this.isReady) {
      this.isReady = true
      this.resolve()
    }
  }

  /**
   * Wait until marked ready. Returns immediately if already ready.
   */
  async wait(): Promise<void> {
    if (this.isReady) return
    await this.promise
  }

  /**
   * Check if currently ready
   */
  get ready(): boolean {
    return this.isReady
  }

  /**
   * Reset to not-ready state (useful for re-initialization)
   */
  reset(): void {
    this.isReady = false
    this.promise = new Promise<void>(resolve => {
      this.resolve = resolve
    })
  }
}

/**
 * Identifies the latest attempt in a replaceable async flow.
 * Invalidated attempts may finish, but must not update current UI state.
 */
export class LatestAttempt {
  private currentId = 0

  begin(): number {
    this.currentId += 1
    return this.currentId
  }

  invalidate(): void {
    this.currentId += 1
  }

  isCurrent(attemptId: number): boolean {
    return attemptId === this.currentId
  }
}

/**
 * Thrown by {@link withTimeout} when an operation exceeds its deadline.
 */
export class TimeoutError extends Error {
  constructor(message = 'Operation timed out') {
    super(message)
    this.name = 'TimeoutError'
  }
}

/** Ends a polling delay early on cancellation; the caller handles the abort. */
export function waitForDelayOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal?.addEventListener('abort', finish, { once: true })
  })
}

/**
 * Rejects with {@link TimeoutError} if `operation` does not settle within `ms`.
 *
 * The underlying promise is not cancellable: it keeps running after a timeout,
 * so the caller owns recovery (e.g. recreating a stuck worker). The timer is
 * always cleared once either side settles to avoid leaks.
 */
export function withTimeout<T>(operation: Promise<T>, ms: number, label?: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(`${label ?? 'operation'} timed out after ${ms}ms`))
    }, ms)
  })
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}
