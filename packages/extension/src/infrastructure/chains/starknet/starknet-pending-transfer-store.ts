import {
  parseTransactionGraph,
  parseTransactionId,
  type TransactionGraph,
  type TransactionId
} from '@/core/transactions/domain'
import {
  ChromeSessionPendingTransactionStore,
  type SessionStorageArea
} from '@/infrastructure/chains/pending-transaction-store'

export type StarknetPendingPhase =
  | 'awaiting-approval'
  | 'deploy-broadcast'
  | 'invoke-ready'
  | 'invoke-broadcast'
  | 'final'
  | 'failed'

export interface StarknetPendingTransfer {
  readonly schemaVersion: 1
  readonly transactionId: TransactionId
  readonly phase: StarknetPendingPhase
  readonly status: 'pending' | 'final' | 'failed'
  readonly scope: { readonly keyDomainId: string; readonly accountId: string }
  readonly chainId: string
  readonly sender: string
  readonly publicKey: string
  readonly classHash: string
  readonly accountIndex: number
  readonly addressIndex: number
  readonly recipient: string
  readonly assetId: string
  readonly assetReference: string
  readonly feeAssetId: string
  readonly amountRaw: string
  readonly maxFeeRaw: string
  readonly invokeMaxFeeRaw: string
  readonly deployMaxFeeRaw: string | null
  readonly reviewedHash: string
  readonly invokeNonce: string
  readonly deployNonce: string | null
  readonly invokeExecutionHash: string
  readonly deployExecutionHash: string | null
  readonly calls: readonly {
    readonly to: string
    readonly selector: string
    readonly calldata: readonly string[]
  }[]
  readonly invokeBounds: {
    readonly l1Gas: { readonly maxAmount: string; readonly maxPricePerUnit: string }
    readonly l2Gas: { readonly maxAmount: string; readonly maxPricePerUnit: string }
    readonly l1DataGas: { readonly maxAmount: string; readonly maxPricePerUnit: string }
  }
  readonly deployBounds: StarknetPendingTransfer['invokeBounds'] | null
  readonly signedInvoke: Readonly<Record<string, unknown>> | null
  readonly signedDeploy: Readonly<Record<string, unknown>> | null
  readonly invokeHash: string | null
  readonly deployHash: string | null
  readonly broadcastAttempted: boolean
  readonly broadcastAt: number | null
  readonly failureCode: 'reverted' | 'dropped' | 'unknown' | null
  readonly createdAt: number
}

export class ChromeSessionStarknetPendingTransferStore extends ChromeSessionPendingTransactionStore<StarknetPendingTransfer> {
  constructor(storage: SessionStorageArea) {
    super({
      storage,
      recordKeyPrefix: 'starknet-transfer:',
      reviewGraphKeyPrefix: 'starknet-transfer-review:',
      label: 'Starknet',
      maximumRecords: 32,
      parseRecord: parseStarknetPendingTransfer
    })
  }
}

export function parseStarknetPendingTransfer(value: unknown): StarknetPendingTransfer {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Pending Starknet transfer is invalid')
  }
  const record = value as StarknetPendingTransfer
  if (record.schemaVersion !== 1) throw new Error('Pending Starknet transfer is invalid')
  const transactionId = parseTransactionId(record.transactionId)
  if (record.status === 'final' || record.status === 'failed' || record.status === 'pending') {
    return { ...record, transactionId }
  }
  throw new Error('Pending Starknet transfer is invalid')
}

export async function readStarknetReviewGraph(
  store: ChromeSessionStarknetPendingTransferStore,
  transactionId: TransactionId
): Promise<TransactionGraph | null> {
  const graph = await store.getReviewGraph(transactionId)
  if (!graph) return null
  return parseTransactionGraph(graph)
}
