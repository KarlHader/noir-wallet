export interface HardwareSignSuccessResult {
  requestId: string
  status: 'success'
  txHash: string
  accountKey: string
  amount: string
  transactionId?: string
  completedAt: number
}

export interface HardwareSignStoppedResult {
  requestId: string
  status: 'cancelled' | 'timeout'
  error: string
  completedAt: number
}

export type HardwareSignResult = HardwareSignSuccessResult | HardwareSignStoppedResult

const RESULT_PREFIX = 'hw_sign_result_'
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

function resultKey(requestId: string): string {
  return RESULT_PREFIX + requestId
}

function parseHardwareSignResult(value: unknown, requestId: string): HardwareSignResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  const allowedKeys = new Set([
    'requestId',
    'status',
    'txHash',
    'accountKey',
    'amount',
    'transactionId',
    'error',
    'completedAt'
  ])
  if (
    Object.keys(candidate).some(key => !allowedKeys.has(key)) ||
    candidate.requestId !== requestId ||
    typeof candidate.completedAt !== 'number' ||
    !Number.isSafeInteger(candidate.completedAt)
  ) {
    return null
  }

  if (candidate.status === 'success') {
    if (
      candidate.error !== undefined ||
      typeof candidate.txHash !== 'string' ||
      candidate.txHash.length === 0 ||
      candidate.txHash.length > 256 ||
      typeof candidate.accountKey !== 'string' ||
      candidate.accountKey.length === 0 ||
      candidate.accountKey.length > 512 ||
      typeof candidate.amount !== 'string' ||
      candidate.amount.length === 0 ||
      candidate.amount.length > 256 ||
      (candidate.transactionId !== undefined &&
        (typeof candidate.transactionId !== 'string' || candidate.transactionId.length > 256))
    ) {
      return null
    }
    return {
      requestId,
      status: 'success',
      txHash: candidate.txHash,
      accountKey: candidate.accountKey,
      amount: candidate.amount,
      ...(typeof candidate.transactionId === 'string'
        ? { transactionId: candidate.transactionId }
        : {}),
      completedAt: candidate.completedAt
    }
  }

  if (
    (candidate.status === 'cancelled' || candidate.status === 'timeout') &&
    candidate.txHash === undefined &&
    candidate.accountKey === undefined &&
    candidate.amount === undefined &&
    candidate.transactionId === undefined &&
    typeof candidate.error === 'string' &&
    candidate.error.length <= 1_024
  ) {
    return {
      requestId,
      status: candidate.status,
      error: candidate.error,
      completedAt: candidate.completedAt
    }
  }

  return null
}

export async function publishHardwareSignResult(result: HardwareSignSuccessResult): Promise<void> {
  await chrome.storage.session.set({ [resultKey(result.requestId)]: result })
}

async function readHardwareSignResult(requestId: string): Promise<HardwareSignResult | null> {
  const key = resultKey(requestId)
  const stored = await chrome.storage.session.get(key)
  return parseHardwareSignResult(stored[key], requestId)
}

/** Wait for one side-panel signing request, including tab close and timeout. */
export function waitForHardwareSignResult({
  requestId,
  tabId,
  timeoutMs = DEFAULT_TIMEOUT_MS
}: {
  requestId: string
  tabId: number
  timeoutMs?: number
}): Promise<HardwareSignResult> {
  const key = resultKey(requestId)

  return new Promise(resolve => {
    let settled = false

    const cleanup = () => {
      clearTimeout(timer)
      chrome.storage.onChanged.removeListener(onStorageChanged)
      chrome.tabs.onRemoved.removeListener(onTabRemoved)
    }

    const finish = (result: HardwareSignResult) => {
      if (settled) return
      settled = true
      cleanup()
      void chrome.storage.session.remove(key).catch(() => {})
      resolve(result)
    }

    const onStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string
    ) => {
      if (areaName !== 'session') return
      const result = parseHardwareSignResult(changes[key]?.newValue, requestId)
      if (result) finish(result)
    }

    const onTabRemoved = (removedTabId: number) => {
      if (removedTabId !== tabId) return
      void readHardwareSignResult(requestId)
        .then(result =>
          finish(
            result ?? {
              requestId,
              status: 'cancelled',
              error: 'Hardware signing was cancelled',
              completedAt: Date.now()
            }
          )
        )
        .catch(() =>
          finish({
            requestId,
            status: 'cancelled',
            error: 'Hardware signing was cancelled',
            completedAt: Date.now()
          })
        )
    }

    const timer = setTimeout(() => {
      finish({
        requestId,
        status: 'timeout',
        error: 'Hardware signing timed out',
        completedAt: Date.now()
      })
      chrome.tabs.remove(tabId).catch(() => {})
    }, timeoutMs)

    chrome.storage.onChanged.addListener(onStorageChanged)
    chrome.tabs.onRemoved.addListener(onTabRemoved)

    void readHardwareSignResult(requestId)
      .then(result => {
        if (result) finish(result)
      })
      .catch(() => {})
  })
}
