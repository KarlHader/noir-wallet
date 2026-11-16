import type { ActivityItem, ActivityScope } from '@/core/activity'
import { parseAssetId, parseChainId } from '@/core/chains/registry'

import type {
  SolanaAddressSignature,
  SolanaReadRpc,
  SolanaTransactionSummary
} from './solana-rpc-types'

const SIGNATURES_PER_ADDRESS = 8
const MAXIMUM_TOKEN_ADDRESSES = 12
const MAXIMUM_TRANSACTIONS = 24
const TRANSACTION_CONCURRENCY = 3

export interface SolanaActivityHistorySource {
  readonly readAddressActivity: (
    input: ReadSolanaAddressActivityInput
  ) => Promise<readonly ActivityItem[]>
}

export interface ReadSolanaAddressActivityInput {
  readonly scope: ActivityScope
  readonly address: string
  readonly knownFinalizedSignatures?: readonly string[]
  readonly untilSignature?: string
}

export interface SolanaActivityHistorySourceConfig {
  readonly chainId: string
  readonly rpc: Pick<
    SolanaReadRpc,
    'getTokenAccountsByOwner' | 'getSignaturesForAddress' | 'getTransactionSummary'
  >
  readonly now?: () => number
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value
}

function primaryDelta(summary: SolanaTransactionSummary): {
  readonly assetId: string
  readonly amountRaw: string
  readonly signedAmount: bigint
} | null {
  if (summary.tokenDeltas.length === 1) {
    const token = summary.tokenDeltas[0]
    const signedAmount = BigInt(token.amountRaw)
    return {
      assetId: token.mint,
      amountRaw: absolute(signedAmount).toString(),
      signedAmount
    }
  }
  if (summary.tokenDeltas.length > 1) return null
  const nativeDelta = BigInt(summary.nativeDeltaRaw)
  if (nativeDelta === 0n || summary.failed) return null
  const fee = BigInt(summary.feeRaw)
  const amount =
    nativeDelta < 0n && absolute(nativeDelta) > fee
      ? absolute(nativeDelta) - fee
      : absolute(nativeDelta)
  if (amount === 0n) return null
  return { assetId: 'native', amountRaw: amount.toString(), signedAmount: nativeDelta }
}

function mapActivityItem(
  scope: ActivityScope,
  address: string,
  chainId: ReturnType<typeof parseChainId>['id'],
  signature: SolanaAddressSignature,
  summary: SolanaTransactionSummary,
  now: () => number
): ActivityItem {
  const delta = primaryDelta(summary)
  const status = summary.failed
    ? ('failed' as const)
    : signature.status === 'finalized'
      ? ('final' as const)
      : ('confirming' as const)
  const timestamp = summary.blockTime === null ? now() : summary.blockTime * 1_000
  const id = `rpc:solana:${summary.signature}`
  const assetId =
    delta?.assetId === 'native'
      ? parseAssetId(`${chainId}/slip44:501`).id
      : delta
        ? parseAssetId(`${chainId}/token:${delta.assetId}`).id
        : undefined
  const direction = delta
    ? delta.signedAmount > 0n
      ? ('incoming' as const)
      : ('outgoing' as const)
    : ('contract' as const)
  return Object.freeze({
    id,
    source: 'rpc' as const,
    scope,
    kind: delta ? ('transfer' as const) : ('contract-call' as const),
    status,
    snapshot: Object.freeze({
      schemaVersion: 1 as const,
      direction,
      ...(delta && assetId
        ? { primaryAmount: Object.freeze({ assetId, amountRaw: delta.amountRaw }) }
        : {}),
      ...(direction === 'outgoing'
        ? { sender: Object.freeze({ chainId, address }) }
        : direction === 'incoming'
          ? { recipient: Object.freeze({ chainId, address }) }
          : {})
    }),
    segments: Object.freeze([
      Object.freeze({
        id: `${id}:origin`,
        role: 'origin' as const,
        target: Object.freeze({ kind: 'onchain' as const, chainId }),
        status,
        evidence: Object.freeze({
          transactionHash: summary.signature,
          blockHeight: summary.slot
        }),
        ...(summary.failed ? { failureCode: 'reverted' as const } : {})
      })
    ]),
    completeness: 'partial' as const,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(summary.failed ? { failureCode: 'reverted' as const } : {})
  })
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  operation: (value: T) => Promise<R>
): Promise<readonly R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex++
      results[index] = await operation(values[index])
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(TRANSACTION_CONCURRENCY, values.length) }, () => worker())
  )
  return Object.freeze(results)
}

export function createSolanaActivityHistorySource(
  config: SolanaActivityHistorySourceConfig
): SolanaActivityHistorySource {
  const chain = parseChainId(config.chainId)
  if (chain.namespace !== 'solana') throw new Error('Solana history requires a Solana chain ID')
  const now = config.now ?? Date.now
  return Object.freeze({
    readAddressActivity: async (input: ReadSolanaAddressActivityInput) => {
      const knownFinalizedSignatures = new Set(input.knownFinalizedSignatures ?? [])
      const tokenResults = await Promise.all([
        config.rpc.getTokenAccountsByOwner(input.address, 'legacy'),
        config.rpc.getTokenAccountsByOwner(input.address, 'token2022')
      ])
      const tokenAddresses = tokenResults
        .flatMap(result => result.accounts)
        .sort(
          (left, right) =>
            Number(BigInt(right.amountRaw) > 0n) - Number(BigInt(left.amountRaw) > 0n) ||
            left.mint.localeCompare(right.mint) ||
            left.accountAddress.localeCompare(right.accountAddress)
        )
        .slice(0, MAXIMUM_TOKEN_ADDRESSES)
        .map(account => account.accountAddress)
      const historyAddresses = Object.freeze([input.address, ...new Set(tokenAddresses)])
      const signatureResults = await mapWithConcurrency(historyAddresses, address =>
        config.rpc.getSignaturesForAddress(address, SIGNATURES_PER_ADDRESS, input.untilSignature)
      )
      const signatures = [
        ...new Map(
          signatureResults
            .flat()
            .sort((left, right) => right.slot - left.slot)
            .map(signature => [signature.signature, signature] as const)
        ).values()
      ].slice(0, MAXIMUM_TRANSACTIONS)
      const unseenSignatures = signatures.filter(
        signature => !knownFinalizedSignatures.has(signature.signature)
      )
      const summaries = await mapWithConcurrency(unseenSignatures, signature =>
        config.rpc.getTransactionSummary(signature.signature, input.address)
      )
      return Object.freeze(
        summaries.flatMap((summary, index) =>
          summary
            ? [
                mapActivityItem(
                  input.scope,
                  input.address,
                  chain.id,
                  unseenSignatures[index],
                  summary,
                  now
                )
              ]
            : []
        )
      )
    }
  })
}
