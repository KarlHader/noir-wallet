export const BITCOIN_RPC_ERROR_CODES = Object.freeze([
  'cancelled',
  'timeout',
  'network-unavailable',
  'rate-limited',
  'unauthorized',
  'not-found',
  'invalid-response',
  'chain-mismatch',
  'rpc-error'
] as const)

export type BitcoinRpcErrorCode = (typeof BITCOIN_RPC_ERROR_CODES)[number]

export class BitcoinRpcError extends Error {
  readonly code: BitcoinRpcErrorCode
  readonly retryAfterMs?: number

  constructor(code: BitcoinRpcErrorCode, message: string, retryAfterMs?: number) {
    super(message)
    this.name = 'BitcoinRpcError'
    this.code = code
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs
  }
}
