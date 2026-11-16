const debugLogsEnabled = typeof __DEBUG_LOGS__ !== 'boolean' || __DEBUG_LOGS__
let nextRequestSequence = 0

export function createDebugRequestId(scope: string): string {
  nextRequestSequence += 1
  return `${scope}-${nextRequestSequence}`
}

export function traceDebugStage<T>(
  requestId: string,
  stage: string,
  operation: () => Promise<T>
): Promise<T> {
  if (!debugLogsEnabled) return operation()

  const startedAt = performance.now()
  return operation().then(
    result => {
      console.log(
        `[Timing] ${requestId} ${stage} ok ${Math.round(performance.now() - startedAt)}ms`
      )
      return result
    },
    error => {
      const category = error instanceof Error ? error.name : 'UnknownError'
      console.log(
        `[Timing] ${requestId} ${stage} ${category} ${Math.round(performance.now() - startedAt)}ms`
      )
      throw error
    }
  )
}

export function logDebugTiming(requestId: string, stage: string, startedAt: number): void {
  if (!debugLogsEnabled) return
  console.log(`[Timing] ${requestId} ${stage} ${Math.round(performance.now() - startedAt)}ms`)
}
