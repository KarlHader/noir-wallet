import type { Network } from '@/types'

export interface NoirPublicAccount {
  readonly chain: 'zcash-l2' | 'evm'
  readonly network: Network
  readonly publicKey: string
  readonly signingMode: 'derived' | 'legacy_index0' | 'evm'
  readonly address: string
  readonly mcaId: string | null
  readonly parentContractId: string
  readonly status: 'inactive' | 'activating' | 'active'
  readonly activationId?: string
}

export interface NoirPublicAsset {
  readonly tokenId: string
  readonly symbol: string
  readonly name: string
  readonly decimals: number
  readonly balanceRaw: string | null
  readonly status: 'fresh' | 'stale' | 'unavailable'
  readonly updatedAt?: number
}

export interface NoirPublicAssets {
  readonly account: NoirPublicAccount
  readonly assets: readonly NoirPublicAsset[]
}

export interface NoirPublicFunctionCallRequest {
  readonly FunctionCall: {
    readonly receiver_id: string
    readonly function_calls: readonly {
      readonly method_name: string
      readonly args: string
      readonly gas: string
      readonly deposit: string
    }[]
  }
}

export interface NoirPublicTransactionParams {
  readonly requestId: string
  readonly txRequests: readonly NoirPublicFunctionCallRequest[]
}

export interface NoirPublicTransaction {
  readonly operationId: string
  readonly requestId: string
  readonly status: 'signed' | 'broadcast' | 'confirming' | 'final' | 'failed'
  readonly submissionId?: string
  readonly transactionHash?: string
  readonly anchor?: { readonly status: string; readonly transactionHash?: string }
  readonly error?: string
}
