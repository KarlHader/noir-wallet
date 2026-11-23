import {
  ShieldError,
  type ShieldAction,
  type ShieldLayer,
  type ShieldOperationHandle,
  type ShieldOperationSnapshot,
  type ShieldPublicStatus,
  type ShieldWaitOptions
} from './types'

const PERSISTED_STATUSES = new Set<ShieldPublicStatus>([
  'awaiting-approval',
  'needs-auth',
  'authorized',
  'signing',
  'submitting',
  'processing',
  'awaiting-payment',
  'pending-refund',
  'ready',
  'partial',
  'refunded',
  'failed',
  'expired',
  'cancelled',
  'unknown',
  'unavailable'
])

const WAIT_TERMINAL = new Set<ShieldPublicStatus>([
  'ready',
  'partial',
  'refunded',
  'failed',
  'expired',
  'cancelled',
  'unavailable'
])

export interface ShieldStatusReport {
  readonly id?: unknown
  readonly status?: unknown
  readonly providerStatus?: unknown
  readonly action?: unknown
  readonly layer?: unknown
}

/**
 * Project a wallet status report. Internal phase names and a persisted
 * REJECTED value stay unknown. PENDING_REFUND is the only refund-in-progress
 * signal. An external EXPIRED provider status does not become `expired`
 * while the report is still awaiting payment.
 */
export function projectShieldStatusReport(report: ShieldStatusReport): ShieldPublicStatus {
  const provider =
    typeof report.providerStatus === 'string' ? report.providerStatus.trim().toUpperCase() : ''
  if (provider === 'PENDING_REFUND') return 'pending-refund'
  if (report.status === 'awaiting-payment') return 'awaiting-payment'
  if (report.status === 'rejected' || report.status === 'REJECTED') return 'unknown'
  if (
    typeof report.status === 'string' &&
    PERSISTED_STATUSES.has(report.status as ShieldPublicStatus)
  ) {
    return report.status as ShieldPublicStatus
  }
  return 'unknown'
}

export function snapshotFromReport(
  report: ShieldStatusReport,
  fallback: Readonly<{ id: string; layer: ShieldLayer; action: ShieldAction }>
): ShieldOperationSnapshot {
  const id = typeof report.id === 'string' && report.id.length > 0 ? report.id : fallback.id
  return Object.freeze({
    id,
    layer: fallback.layer,
    action:
      report.action === 'receive' || report.action === 'transfer' ? report.action : fallback.action,
    status: projectShieldStatusReport(report),
    ...(typeof report.providerStatus === 'string' && report.providerStatus.length > 0
      ? { providerStatus: report.providerStatus }
      : {})
  })
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer)
        reject(abortError())
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

function abortError(): ShieldError {
  return new ShieldError(
    'CANCELLED',
    'The Shield wait was cancelled. The operation was not cancelled or resubmitted.'
  )
}

function timeoutError(status: ShieldPublicStatus): ShieldError {
  return new ShieldError(
    'TIMEOUT',
    'The Shield wait timed out. The operation was not cancelled or resubmitted.',
    status
  )
}

export function createShieldOperation(
  initial: ShieldOperationSnapshot,
  readStatus: (id: string) => Promise<ShieldStatusReport>
): ShieldOperationHandle {
  const handle: ShieldOperationHandle = {
    id: initial.id,
    status: initial.status,
    async wait(options: ShieldWaitOptions = {}) {
      const started = Date.now()
      let current = initial
      const timedOut = () =>
        options.timeoutMs !== undefined && Date.now() - started >= options.timeoutMs
      while (!WAIT_TERMINAL.has(current.status)) {
        if (options.signal?.aborted) throw abortError()
        if (timedOut()) throw timeoutError(current.status)
        const remaining =
          options.timeoutMs === undefined
            ? 1000
            : Math.min(1000, Math.max(0, options.timeoutMs - (Date.now() - started)))
        if (remaining === 0) throw timeoutError(current.status)
        await delay(remaining, options.signal)
        if (timedOut()) throw timeoutError(current.status)
        const report = await readStatus(current.id)
        current = snapshotFromReport(report, current)
        handle.status = current.status
      }
      handle.status = current.status
      return current
    }
  }
  return handle
}
