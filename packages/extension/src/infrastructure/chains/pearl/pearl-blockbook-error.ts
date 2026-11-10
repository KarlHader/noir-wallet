export const PEARL_RPC_ERROR_CODES = Object.freeze([
  'invalid-response',
  'network-unavailable',
  'not-found',
  'unauthorized',
  'rate-limited',
  'chain-mismatch'
] as const)

export type PearlRpcErrorCode = (typeof PEARL_RPC_ERROR_CODES)[number]

export class PearlRpcError extends Error {
  readonly code: PearlRpcErrorCode
  readonly retryAfterMs?: number

  constructor(code: PearlRpcErrorCode, message: string, retryAfterMs?: number) {
    super(message)
    this.name = 'PearlRpcError'
    this.code = code
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs
  }
}
