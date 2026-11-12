import type { StarknetFeeEstimate, StarknetReceiptObservation } from './starknet-primitives'

export const STARKNET_RPC_ERROR_CODES = Object.freeze([
  'network-unavailable',
  'timeout',
  'cancelled',
  'invalid-response',
  'rpc-error',
  'contract-not-found',
  'transaction-not-found',
  'entrypoint-not-found'
] as const)

export type StarknetRpcErrorCode = (typeof STARKNET_RPC_ERROR_CODES)[number]

export class StarknetRpcError extends Error {
  readonly code: StarknetRpcErrorCode
  readonly detail: string | undefined

  constructor(code: StarknetRpcErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'StarknetRpcError'
    this.code = code
    this.detail = detail
  }
}

export interface StarknetEventFilter {
  readonly fromBlock: string | { readonly block_number: number }
  readonly toBlock: 'pre_confirmed'
  readonly address: string
  readonly keys: readonly (readonly string[])[]
  readonly continuationToken?: string
  readonly chunkSize: number
}

export interface StarknetRpcEvent {
  readonly fromAddress: string
  readonly keys: readonly string[]
  readonly data: readonly string[]
  readonly blockNumber: number
  readonly transactionHash: string
  readonly eventIndex: string
}

export interface StarknetEventPage {
  readonly events: readonly StarknetRpcEvent[]
  readonly continuationToken?: string
}

export interface StarknetReadRpc {
  getNonce(address: string, signal?: AbortSignal): Promise<bigint>
  getClassHashAt(address: string, signal?: AbortSignal): Promise<string | null>
  call(
    contractAddress: string,
    selector: string,
    calldata: readonly string[],
    signal?: AbortSignal
  ): Promise<readonly string[]>
  estimateFees(
    transactions: readonly Readonly<Record<string, unknown>>[],
    signal?: AbortSignal
  ): Promise<readonly StarknetFeeEstimate[]>
  getTransactionReceipt(hash: string, signal?: AbortSignal): Promise<StarknetReceiptObservation>
  getEvents(filter: StarknetEventFilter, signal?: AbortSignal): Promise<StarknetEventPage>
  getBlockTimestamp(blockNumber: number, signal?: AbortSignal): Promise<number>
}

export interface StarknetBroadcastRpc {
  addInvokeTransaction(
    transaction: Readonly<Record<string, unknown>>,
    signal?: AbortSignal
  ): Promise<string>
  addDeployAccountTransaction(
    transaction: Readonly<Record<string, unknown>>,
    signal?: AbortSignal
  ): Promise<string>
}

export interface StarknetRpcClientConfig {
  readonly chainId: string
  readonly rpcUrl: string
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
}
