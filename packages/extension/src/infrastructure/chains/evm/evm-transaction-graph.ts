import type { ChainAccountId } from '@/core/accounts/domain'
import { parseAssetId, parseChainId, type AssetRegistry } from '@/core/chains/registry'
import {
  parseTransactionGraph,
  type TransactionAccountScope,
  type TransactionGraph,
  type TransactionId,
  type TransactionSegmentId
} from '@/core/transactions/domain'
import type { PreparedEvmTransfer } from './evm-transaction-builder'
import { isErc20ApproveCalldata } from './evm-contract-call-classification'
import {
  bindNearIntentsTransactionGraph,
  bindRheaSwapTransactionGraph,
  type NearIntentsGraphSegmentIds,
  type NearIntentsTransactionBinding,
  type RheaSwapTransactionBinding
} from '@/core/transactions/domain'

export interface CreateEvmTransferGraphInput {
  readonly prepared: PreparedEvmTransfer
  readonly scope: TransactionAccountScope
  readonly transactionId: TransactionId
  readonly segmentId: TransactionSegmentId
  readonly assets: AssetRegistry
  readonly chainAccountId?: ChainAccountId
  readonly nearIntents?: Readonly<{
    binding: NearIntentsTransactionBinding
    segmentIds: NearIntentsGraphSegmentIds
  }>
  readonly rheaSwap?: Readonly<{
    binding: RheaSwapTransactionBinding
    segmentIds: NearIntentsGraphSegmentIds
  }>
}

function maximumNetworkFeeRaw(prepared: PreparedEvmTransfer): string {
  const { gasLimit, maxFeePerGas } = prepared.transaction
  if (!/^[1-9][0-9]{0,19}$/.test(gasLimit) || !/^(0|[1-9][0-9]{0,19})$/.test(maxFeePerGas)) {
    throw new Error('Invalid prepared EVM fee limit')
  }
  return (BigInt(gasLimit) * BigInt(maxFeePerGas)).toString()
}

function resolveFeeAssetId(input: CreateEvmTransferGraphInput) {
  const feeAsset = input.assets
    .list(input.prepared.chainId)
    .find(entry => entry.asset.kind === 'native' && entry.asset.namespace === 'slip44')
  if (!feeAsset) throw new Error('EVM native fee asset is not listed')
  return feeAsset.asset.id
}

export function classifyEvmContractCall(prepared: PreparedEvmTransfer) {
  if (prepared.kind !== 'contract-call') return null
  if (isErc20ApproveCalldata(prepared.transaction.input)) {
    return Object.freeze({ kind: 'approve' as const })
  }
  return Object.freeze({ kind: 'contract-call' as const })
}

export function createEvmTransferGraph(input: CreateEvmTransferGraphInput): TransactionGraph {
  const chainId = parseChainId(input.prepared.chainId)
  if (chainId.namespace !== 'eip155') {
    throw new Error('EVM transfer graph requires an EVM chain')
  }
  const assetId = parseAssetId(input.prepared.assetId)
  const listed = input.assets.get(assetId.id)
  const inspected =
    input.prepared.kind === 'erc20-transfer' ? input.assets.inspect(assetId.id) : undefined
  const asset =
    listed ??
    (inspected?.verification === 'unverified' &&
    inspected.asset.kind === 'token' &&
    inspected.asset.namespace === 'erc20'
      ? inspected
      : undefined)
  if (assetId.chainId !== chainId.id || !asset) {
    throw new Error('EVM transfer graph asset does not match its chain')
  }
  const isContractCall = input.prepared.kind === 'contract-call'
  const isCancel = input.prepared.kind === 'cancel' || input.prepared.kind === 'nonce-recovery'
  const contractCall = classifyEvmContractCall(input.prepared)
  if ((isContractCall || isCancel) && asset.asset.namespace !== 'slip44') {
    throw new Error('EVM contract call value must use the native asset')
  }
  if (input.nearIntents && input.rheaSwap) {
    throw new Error('EVM transfer graph cannot bind multiple protocols')
  }
  if (isContractCall && input.nearIntents) {
    throw new Error('EVM contract calls cannot bind a Near Intents transfer')
  }
  const direction = isCancel
    ? ('self' as const)
    : isContractCall
      ? ('contract' as const)
      : input.prepared.from.toLowerCase() === input.prepared.recipient.toLowerCase()
        ? ('self' as const)
        : ('outgoing' as const)
  const feeAssetId = resolveFeeAssetId(input)
  const createdAt = input.prepared.createdAt

  const graph = parseTransactionGraph({
    root: {
      id: input.transactionId,
      scope: {
        keyDomainId: input.scope.keyDomainId,
        accountId: input.scope.accountId
      },
      kind: isCancel ? 'cancel' : (contractCall?.kind ?? 'transfer'),
      status: 'prepared',
      segmentIds: [input.segmentId],
      createdAt,
      updatedAt: createdAt,
      revision: 0,
      intent: {
        schemaVersion: 1,
        direction,
        ...((isContractCall || isCancel) && input.prepared.amountRaw === '0'
          ? {}
          : {
              primaryAmount: {
                assetId: assetId.id,
                amountRaw: input.prepared.amountRaw,
                ...(asset.source === 'user-added' ? { metadata: asset.metadata } : {})
              }
            }),
        feeLimit: {
          assetId: feeAssetId,
          amountRaw: maximumNetworkFeeRaw(input.prepared)
        },
        sender: {
          chainId: chainId.id,
          address: input.prepared.from
        },
        recipient: {
          chainId: chainId.id,
          address: input.prepared.recipient
        },
        evm: {
          schemaVersion: 1,
          nonce: input.prepared.transaction.nonce,
          maxFeePerGasWei: input.prepared.transaction.maxFeePerGas,
          maxPriorityFeePerGasWei: input.prepared.transaction.maxPriorityFeePerGas,
          gasLimit: input.prepared.transaction.gasLimit,
          ...(input.prepared.transaction.input.length >= 10
            ? { methodSelector: input.prepared.transaction.input.slice(0, 10).toLowerCase() }
            : {})
        }
      }
    },
    segments: [
      {
        id: input.segmentId,
        transactionId: input.transactionId,
        role: 'origin',
        target: {
          kind: 'onchain',
          chainId: chainId.id,
          ...(input.chainAccountId === undefined ? {} : { chainAccountId: input.chainAccountId })
        },
        status: 'prepared',
        requiredForFinality: true,
        dependsOn: [],
        createdAt,
        updatedAt: createdAt,
        revision: 0
      }
    ]
  })
  if (input.nearIntents) {
    return bindNearIntentsTransactionGraph({
      graph,
      binding: input.nearIntents.binding,
      segmentIds: input.nearIntents.segmentIds,
      now: createdAt
    })
  }
  return input.rheaSwap
    ? bindRheaSwapTransactionGraph({
        graph,
        binding: input.rheaSwap.binding,
        segmentIds: input.rheaSwap.segmentIds,
        now: createdAt
      })
    : graph
}
