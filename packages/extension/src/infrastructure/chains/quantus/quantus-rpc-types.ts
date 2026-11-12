export const QUANTUS_RPC_ERROR_CODES = Object.freeze([
  'cancelled',
  'timeout',
  'network-unavailable',
  'unauthorized',
  'rate-limited',
  'invalid-response',
  'bad-signature',
  'rpc-error',
  'chain-mismatch'
] as const)

export type QuantusRpcErrorCode = (typeof QUANTUS_RPC_ERROR_CODES)[number]

export class QuantusRpcError extends Error {
  readonly code: QuantusRpcErrorCode

  constructor(code: QuantusRpcErrorCode, message: string) {
    super(message)
    this.name = 'QuantusRpcError'
    this.code = code
  }
}

export interface QuantusRpcClientConfig {
  readonly chainId: string
  readonly rpcUrl: string
  readonly timeoutMs?: number
  readonly maximumResponseBytes?: number
}

export interface QuantusAccountInfo {
  readonly free: bigint
  readonly reserved: bigint
  readonly nonce: number
}

export interface QuantusRuntimeVersion {
  readonly specVersion: number
  readonly transactionVersion: number
}

export interface QuantusBlock {
  readonly extrinsics: readonly string[]
}

export interface QuantusMetadata {
  /** Hex-encoded runtime metadata (`0x6d657461...`). */
  readonly hex: string
  /** Metadata container version read from the encoded header. */
  readonly version: number
}

export interface QuantusReadRpc {
  readonly assertExpectedChain: (signal?: AbortSignal) => Promise<void>
  readonly getGenesisHash: (signal?: AbortSignal) => Promise<string>
  readonly getBestHead: (signal?: AbortSignal) => Promise<string>
  readonly getFinalizedHead: (signal?: AbortSignal) => Promise<string>
  readonly getBlockHash: (number: number, signal?: AbortSignal) => Promise<string>
  readonly getBlock: (hash: string, signal?: AbortSignal) => Promise<QuantusBlock>
  readonly getPendingExtrinsics: (signal?: AbortSignal) => Promise<readonly string[]>
  readonly getEventsStorage: (blockHash: string, signal?: AbortSignal) => Promise<string | null>
  /** Raw fee in the smallest unit, returned as a canonical decimal string. This is not a submission. */
  readonly queryFee: (signedExtrinsicHex: string, signal?: AbortSignal) => Promise<string>
  readonly getHeader: (
    hash?: string,
    signal?: AbortSignal
  ) => Promise<Readonly<{ readonly parentHash: string; readonly number: number }>>
  readonly getAccountInfo: (address: string, signal?: AbortSignal) => Promise<QuantusAccountInfo>
  readonly getSystemAccountNextIndex: (address: string, signal?: AbortSignal) => Promise<number>
  readonly getRuntimeVersion: (signal?: AbortSignal) => Promise<QuantusRuntimeVersion>
  readonly getMetadata: (signal?: AbortSignal) => Promise<QuantusMetadata>
}

export interface QuantusBroadcastRpc {
  readonly submitExtrinsic: (extrinsicHex: string, signal?: AbortSignal) => Promise<string>
}
