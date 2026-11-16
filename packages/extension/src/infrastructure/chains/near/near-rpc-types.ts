export const NEAR_RPC_ERROR_CODES = Object.freeze([
  'cancelled',
  'timeout',
  'network-unavailable',
  'rate-limited',
  'unauthorized',
  'invalid-response',
  'chain-mismatch',
  'account-not-found',
  'access-key-not-found',
  'transaction-not-found',
  'rpc-error'
] as const)

export type NearRpcErrorCode = (typeof NEAR_RPC_ERROR_CODES)[number]

export class NearRpcError extends Error {
  readonly code: NearRpcErrorCode

  constructor(code: NearRpcErrorCode, message: string) {
    super(message)
    this.name = 'NearRpcError'
    this.code = code
  }
}

export interface NearRpcClientConfig {
  readonly chainId: string
  readonly rpcUrl: string
  readonly timeoutMs?: number
  readonly maximumResponseBytes?: number
}

export interface NearAccountSnapshot {
  readonly accountId: string
  readonly amountRaw: string
  readonly lockedRaw: string
  readonly storageUsage: number
  readonly codeHash: string
  readonly blockHash: string
  readonly blockHeight: number
}

export type NearAccessKeyPermission =
  | { readonly kind: 'full-access' }
  | {
      readonly kind: 'function-call'
      readonly allowanceRaw: string | null
      readonly receiverId: string
      readonly methodNames: readonly string[]
    }

export interface NearAccessKeySnapshot {
  readonly accountId: string
  readonly publicKey: string
  readonly nonce: string
  readonly permission: NearAccessKeyPermission
  readonly blockHash: string
  readonly blockHeight: number
}

export interface NearFinalBlockSnapshot {
  readonly hash: string
  readonly height: number
  readonly timestampNanosec: string
  readonly gasPriceRaw: string
}

export interface NearGasCostComponents {
  readonly executionGas: string
  readonly sendNotSirGas: string
  readonly sendSirGas: string
}

export interface NearNativeTransferCostConfig {
  readonly chainId: string
  readonly minGasPurchasePriceRaw: string
  readonly storageAmountPerByteRaw: string
  readonly actionReceiptCreation: NearGasCostComponents
  readonly transfer: NearGasCostComponents
}

export interface NearFungibleTokenBalanceSnapshot {
  readonly contractId: string
  readonly accountId: string
  readonly amountRaw: string
  readonly blockHash: string
  readonly blockHeight: number
}

export type NearTransactionStatus =
  | { readonly status: 'unknown' }
  | { readonly status: 'confirming' }
  | { readonly status: 'final' }
  | { readonly status: 'failed' }

export interface NearReadRpc {
  readonly assertExpectedChain: (signal?: AbortSignal) => Promise<void>
  readonly getAccount: (
    accountId: string,
    signal?: AbortSignal
  ) => Promise<NearAccountSnapshot | null>
  readonly getAccessKey: (
    accountId: string,
    publicKey: string,
    signal?: AbortSignal
  ) => Promise<NearAccessKeySnapshot | null>
  readonly getFinalBlock: (signal?: AbortSignal) => Promise<NearFinalBlockSnapshot>
  readonly getGasPrice: (signal?: AbortSignal) => Promise<string>
  readonly getNativeTransferCostConfig: (
    signal?: AbortSignal
  ) => Promise<NearNativeTransferCostConfig>
  readonly getTransactionStatus: (
    transactionHash: string,
    signerId: string,
    signal?: AbortSignal
  ) => Promise<NearTransactionStatus>
  readonly getFungibleTokenBalance: (
    contractId: string,
    accountId: string,
    signal?: AbortSignal
  ) => Promise<NearFungibleTokenBalanceSnapshot>
  readonly isFungibleTokenAccountRegistered: (
    contractId: string,
    accountId: string,
    signal?: AbortSignal
  ) => Promise<boolean>
}

export interface NearBroadcastRpc {
  readonly broadcastSignedTransaction: (
    transactionBase64: string,
    signal?: AbortSignal
  ) => Promise<string>
}

export interface NearCommitBroadcastRpc {
  readonly broadcastSignedTransactionAndWait: (
    transactionBase64: string,
    signal?: AbortSignal
  ) => Promise<Readonly<Record<string, unknown>>>
}
