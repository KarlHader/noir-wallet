export const SOLANA_RPC_ERROR_CODES = Object.freeze([
  'cancelled',
  'timeout',
  'network-unavailable',
  'rate-limited',
  'unauthorized',
  'invalid-response',
  'chain-mismatch',
  'rpc-error'
] as const)

export type SolanaRpcErrorCode = (typeof SOLANA_RPC_ERROR_CODES)[number]

export class SolanaRpcError extends Error {
  readonly code: SolanaRpcErrorCode

  constructor(code: SolanaRpcErrorCode, message: string) {
    super(message)
    this.name = 'SolanaRpcError'
    this.code = code
  }
}

export class SolanaSimulationError extends SolanaRpcError {
  readonly contextSlot: number
  readonly unitsConsumed: number

  constructor(contextSlot: number, unitsConsumed: number) {
    super('rpc-error', 'Solana transaction simulation failed')
    this.name = 'SolanaSimulationError'
    this.contextSlot = contextSlot
    this.unitsConsumed = unitsConsumed
  }
}

export interface SolanaRpcClientConfig {
  readonly chainId: string
  readonly rpcUrl: string
  readonly timeoutMs?: number
  readonly maximumResponseBytes?: number
}

export interface SolanaLatestBlockhash {
  readonly contextSlot: number
  readonly blockhash: string
  readonly lastValidBlockHeight: number
}

export interface SolanaNativeBalanceResult {
  readonly contextSlot: number
  readonly amountRaw: string
}

export interface SolanaMessageFeeResult {
  readonly contextSlot: number
  readonly feeLamports: string
}

export interface SolanaSimulationResult {
  readonly contextSlot: number
  readonly unitsConsumed: number
}

export const SOLANA_TOKEN_PROGRAMS = Object.freeze({
  legacy: Object.freeze({
    name: 'spl-token',
    programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
  }),
  token2022: Object.freeze({
    name: 'spl-token-2022',
    programId: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
  })
} as const)

export type SolanaTokenProgram = keyof typeof SOLANA_TOKEN_PROGRAMS

export interface SolanaTokenAccountBalance {
  readonly accountAddress: string
  readonly program: SolanaTokenProgram
  readonly mint: string
  readonly owner: string
  readonly state: 'uninitialized' | 'initialized' | 'frozen'
  readonly isNative: boolean
  readonly amountRaw: string
  readonly decimals: number
}

export interface SolanaTokenAccountsResult {
  readonly contextSlot: number
  readonly accounts: readonly SolanaTokenAccountBalance[]
}

export interface SolanaAddressSignature {
  readonly signature: string
  readonly slot: number
  readonly blockTime: number | null
  readonly status: 'confirmed' | 'finalized' | 'failed'
}

export interface SolanaTransactionTokenDelta {
  readonly mint: string
  readonly amountRaw: string
  readonly decimals: number
}

export interface SolanaTransactionSummary {
  readonly signature: string
  readonly slot: number
  readonly blockTime: number | null
  readonly failed: boolean
  readonly feeRaw: string
  readonly nativeDeltaRaw: string
  readonly tokenDeltas: readonly SolanaTransactionTokenDelta[]
}

export interface SolanaAddressLookupTable {
  readonly address: string
  readonly contextSlot: number
  readonly deactivationSlot: string
  readonly lastExtendedSlot: string
  readonly lastExtendedStartIndex: number
  readonly authority: string | null
  readonly addresses: readonly string[]
}

export type SolanaSignatureStatus =
  | { readonly status: 'unknown'; readonly contextSlot: number }
  | {
      readonly status: 'processed' | 'confirmed' | 'finalized' | 'failed'
      readonly contextSlot: number
      readonly slot: number
      readonly confirmations: number | null
    }

export type SolanaRpcCommitment = 'processed' | 'confirmed' | 'finalized'

export interface SolanaBroadcastOptions {
  readonly preflightCommitment?: SolanaRpcCommitment
  readonly minContextSlot?: number
  readonly skipPreflight?: boolean
  readonly maxRetries?: number
}

export interface SolanaReadRpc {
  readonly assertExpectedChain: (signal?: AbortSignal) => Promise<void>
  readonly getBalance: (address: string, signal?: AbortSignal) => Promise<string>
  readonly getBalanceSnapshot: (
    address: string,
    signal?: AbortSignal
  ) => Promise<SolanaNativeBalanceResult>
  readonly getLatestBlockhash: (signal?: AbortSignal) => Promise<SolanaLatestBlockhash>
  readonly getBlockHeight: (signal?: AbortSignal) => Promise<number>
  readonly getFeeForMessage: (
    messageBase64: string,
    signal?: AbortSignal
  ) => Promise<SolanaMessageFeeResult>
  readonly simulateTransaction: (
    transactionBase64: string,
    signal?: AbortSignal
  ) => Promise<SolanaSimulationResult>
  readonly getTokenAccountsByOwner: (
    owner: string,
    program: SolanaTokenProgram,
    signal?: AbortSignal
  ) => Promise<SolanaTokenAccountsResult>
  readonly getTokenAccountsByMints: (
    owner: string,
    mints: readonly string[],
    signal?: AbortSignal
  ) => Promise<SolanaTokenAccountsResult>
  readonly getSignaturesForAddress: (
    address: string,
    limit: number,
    until?: string,
    signal?: AbortSignal
  ) => Promise<readonly SolanaAddressSignature[]>
  readonly getTransactionSummary: (
    signature: string,
    owner: string,
    signal?: AbortSignal
  ) => Promise<SolanaTransactionSummary | null>
  readonly getAddressLookupTable: (
    address: string,
    signal?: AbortSignal
  ) => Promise<SolanaAddressLookupTable | null>
  readonly getSignatureStatus: (
    signature: string,
    signal?: AbortSignal
  ) => Promise<SolanaSignatureStatus>
}

export interface SolanaBroadcastRpc {
  readonly broadcastSignedTransaction: (
    transactionBase64: string,
    signal?: AbortSignal,
    options?: SolanaBroadcastOptions
  ) => Promise<string>
}
