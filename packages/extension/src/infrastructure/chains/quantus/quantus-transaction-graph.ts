import type { ChainAccountId } from '@/core/accounts/domain'
import { parseQuantusAddress } from '@/core/chains/quantus'
import { parseChainId, type AssetRegistry } from '@/core/chains/registry'
import {
  parseTransactionGraph,
  type TransactionAccountScope,
  type TransactionGraph,
  type TransactionId,
  type TransactionSegmentId
} from '@/core/transactions/domain'
import type { QuantusTransferPrepareRequest } from '../../keyring/multichain/signing-adapter-quantus'

export const QUANTUS_NATIVE_SLIP44_REFERENCE = '189189' as const

function readCanonicalAmount(value: string, label: string): string {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error(`Invalid Quantus ${label}`)
  return value
}

export interface CreateQuantusTransferGraphInput {
  readonly request: QuantusTransferPrepareRequest
  readonly senderAddress: string
  readonly amountRaw: string
  readonly feeLimitRaw: string
  readonly scope: TransactionAccountScope
  readonly transactionId: TransactionId
  readonly segmentId: TransactionSegmentId
  readonly assets: AssetRegistry
  readonly createdAt: number
  readonly chainAccountId?: ChainAccountId
}

/**
 * One on-chain origin segment for a native QTC/PLK transfer. The fee limit is
 * the reviewed ceiling, because the exact fee is only known after signing.
 */
export function createQuantusTransferGraph(
  input: CreateQuantusTransferGraphInput
): TransactionGraph {
  const chainId = parseChainId(input.request.chainId)
  if (chainId.namespace !== 'quantus') {
    throw new Error('Quantus transfer graph requires a Quantus chain')
  }
  if (input.request.chainId !== chainId.id) {
    throw new Error('Quantus transfer graph requires a canonical chain ID')
  }
  const amountRaw = readCanonicalAmount(input.amountRaw, 'amount')
  const feeLimitRaw = readCanonicalAmount(input.feeLimitRaw, 'fee ceiling')
  const senderAddress = parseQuantusAddress(input.senderAddress, 'Quantus sender')
  const recipient = parseQuantusAddress(input.request.toAddress, 'Quantus recipient')
  const nativeAssetId = `${chainId.id}/slip44:${QUANTUS_NATIVE_SLIP44_REFERENCE}`
  const nativeAsset = input.assets.get(nativeAssetId)
  if (
    !nativeAsset ||
    nativeAsset.asset.chainId !== chainId.id ||
    nativeAsset.asset.kind !== 'native' ||
    nativeAsset.metadata.decimals !== 12
  ) {
    throw new Error('Invalid Quantus native asset definition')
  }

  return parseTransactionGraph({
    root: {
      id: input.transactionId,
      scope: input.scope,
      kind: 'transfer',
      status: 'prepared',
      segmentIds: [input.segmentId],
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      revision: 0,
      intent: {
        schemaVersion: 1,
        direction: senderAddress === recipient ? 'self' : 'outgoing',
        primaryAmount: { assetId: nativeAsset.asset.id, amountRaw },
        feeLimit: { assetId: nativeAsset.asset.id, amountRaw: feeLimitRaw },
        sender: { chainId: chainId.id, address: senderAddress },
        recipient: { chainId: chainId.id, address: recipient }
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
        evidence: { requiredConfirmations: 1 },
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        revision: 0
      }
    ]
  })
}
