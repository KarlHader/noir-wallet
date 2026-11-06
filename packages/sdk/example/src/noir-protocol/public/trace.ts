export type TraceMethod =
  | 'createSession'
  | 'getSession'
  | 'revokeSession'
  | 'wallet_sessionChanged'
  | 'chainChanged'
  | 'selectPublicAccount'
  | 'switchEvmChain'
  | 'getPublicKey'
  | 'signMessage'
  | 'accountsChanged'
  | 'activatePublicAccount'
  | 'getPublicAssets'
  | 'sendPublicTransaction'
  | 'getPublicTransaction'

export interface TraceEntry {
  sequence: number
  callId?: number
  at: string
  method: TraceMethod
  outcome: 'started' | 'success' | 'error' | 'event'
  elapsedMs?: number
  code?: number
  status?: string
}

export function errorCode(cause: unknown): number | undefined {
  if (!cause || typeof cause !== 'object' || !('code' in cause)) return undefined
  const code = cause.code
  return typeof code === 'number' && Number.isInteger(code) ? code : undefined
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Request failed'
}

export function publicConnectErrorMessage(cause: unknown): string {
  return errorCode(cause) === 5101
    ? 'This wallet build does not support Noir Protocol Public. Load the extension paired with this demo and refresh the page.'
    : errorMessage(cause)
}

export function exportTrace(entries: TraceEntry[], walletVersion?: string): void {
  const build = typeof __PUBLIC_DEMO_BUILD__ === 'undefined' ? null : __PUBLIC_DEMO_BUILD__
  const safeVersion = (value: string | undefined) =>
    value && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,32})?(?:\+[0-9A-Za-z.-]{1,32})?$/.test(value)
      ? value
      : 'unknown'
  const revision =
    build?.revision && /^(?:[a-f0-9]{7,40}(?:-local)?|local)$/i.test(build.revision)
      ? build.revision
      : 'unknown'
  const safeStatus = (value: string | undefined) =>
    value &&
    [
      'inactive',
      'activating',
      'active',
      'disconnected',
      'signed',
      'broadcast',
      'confirming',
      'final',
      'failed'
    ].includes(value)
      ? value
      : undefined
  const document = {
    schema: 'noir-public-demo-trace-v1',
    build: {
      exampleVersion: safeVersion(build?.exampleVersion),
      sdkVersion: safeVersion(build?.sdkVersion),
      walletVersion: safeVersion(walletVersion),
      revision
    },
    entries: entries.map(entry => ({
      sequence: entry.sequence,
      ...(entry.callId === undefined ? {} : { callId: entry.callId }),
      at: entry.at,
      method: entry.method,
      outcome: entry.outcome,
      ...(entry.elapsedMs === undefined ? {} : { elapsedMs: entry.elapsedMs }),
      ...(entry.code === undefined ? {} : { code: entry.code }),
      ...(safeStatus(entry.status) === undefined ? {} : { status: safeStatus(entry.status) })
    }))
  }
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' })
  )
  const link = window.document.createElement('a')
  link.href = url
  link.download = 'noir-public-trace.json'
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
