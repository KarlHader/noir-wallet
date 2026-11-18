import type { PortfolioAssetView, PortfolioChainView } from '@/core/portfolio'
import { resolveRheaPrivateTransferToken } from '@/core/services/rhea-swap'
import { preferWalletEvmQuoteToken } from './token-address-discovery'
import type { ConfidentialFundingPreview } from '@/core/services/confidential-funding'
import { formatBaseUnitDecimalAmount, formatFeeAmount } from '@/lib/number-format'
import { evmWalletClient, type EvmFeeEstimate } from './evm-wallet-client'
import { rheaSwapClient } from './rhea-swap-client'
import { requiredRheaEvmApproval } from './rhea-evm-approval'
import { formatIntentsConfirmationTime } from './confirmation-time-format'

export interface MoveMethodEstimate {
  readonly expiresAt: number
  readonly routeFeeRaw: string | null
  readonly sourceNetworkFee?: {
    readonly raw: string
    readonly symbol: string
    readonly decimals: number
  }
  readonly time: string
}

const DIRECT_MAXIMUM_MINUTES = 5
const CLUSTER_MAXIMUM_MINUTES = 10 + 2 // Batch execution and arrival allowance.

function formatMoveTime(seconds: number | undefined, maximumMinutes: number): string {
  const range = formatIntentsConfirmationTime(seconds, maximumMinutes)
  return range === '—' ? `Up to ${maximumMinutes} min` : range
}

function routeFee(amountRaw: string, outputRaw: string): string | null {
  const difference = BigInt(amountRaw) - BigInt(outputRaw)
  return difference.toString()
}

export function clusterMoveEstimate(
  amountRaw: string,
  preview: ConfidentialFundingPreview
): MoveMethodEstimate {
  return {
    expiresAt: preview.expiresAt,
    routeFeeRaw: routeFee(amountRaw, preview.amountOutRaw),
    time: formatMoveTime(preview.timeEstimateSeconds, CLUSTER_MAXIMUM_MINUTES)
  }
}

export async function estimateDirectMove(input: {
  readonly asset: PortfolioAssetView
  readonly chain: PortfolioChainView
  readonly nativeFeeAsset: PortfolioAssetView | null
  readonly amountRaw: string
  readonly sender: string
  readonly recipient: string
  readonly executionMode: 'main' | 'private'
  readonly signal: AbortSignal
}): Promise<MoveMethodEstimate> {
  const match = /^eip155:([1-9][0-9]*)$/.exec(input.chain.chain.id)
  if (!match) throw new Error('Unsupported Move network')
  const catalog = await rheaSwapClient
    .listTokens({ direction: 'from', tokenListChainIds: [Number(match[1])] })
    .catch(() => null)
  input.signal.throwIfAborted()
  const catalogToken = resolveRheaPrivateTransferToken(
    catalog?.tokens ?? [],
    input.asset.asset.kind === 'token' ? input.asset.asset.reference : null
  )
  const token = preferWalletEvmQuoteToken(input.asset, catalogToken)
  if (!token) throw new Error('Move source asset could not be mapped to a quote token')
  const asset = {
    chain: token.rheaChainId,
    address: token.rheaAddress,
    symbol: token.symbol,
    decimals: token.decimals,
    isNative: token.isNative
  }
  const quote = await rheaSwapClient.quote(
    {
      fromChain: token.rheaChainId,
      toChain: token.rheaChainId,
      tokenIn: asset,
      tokenOut: asset,
      amountIn: input.amountRaw,
      sender: input.sender,
      recipient: input.recipient,
      slippageBps: 100,
      confidentiality: 'basic'
    },
    input.executionMode === 'private' ? 'private-transfer' : 'confidential-funding'
  )
  try {
    input.signal.throwIfAborted()
    let result: MoveMethodEstimate = {
      expiresAt: Math.min(quote.expiresAt ?? Infinity, Date.now() + 30_000),
      routeFeeRaw: routeFee(input.amountRaw, quote.estimatedOut),
      time: formatMoveTime(undefined, DIRECT_MAXIMUM_MINUTES)
    }
    // A route quote remains useful when RPC cannot estimate its source gas.
    try {
      const review = await rheaSwapClient.prepare(quote.quoteHandle)
      input.signal.throwIfAborted()
      result = {
        ...result,
        time: formatMoveTime(review.timeEstimateSeconds, DIRECT_MAXIMUM_MINUTES)
      }
      if (review.execution.kind !== 'evm-transaction') return result
      const plan = await rheaSwapClient.getEvmTransactionPlan(quote.quoteHandle)
      input.signal.throwIfAborted()
      const approval = await requiredRheaEvmApproval({
        approval: plan.approval,
        chainId: input.chain.chain.id,
        owner: input.sender,
        executionMode: input.executionMode,
        getTokenAllowance: evmWalletClient.getTokenAllowance
      })
      const calls = [...(approval ? [approval.transaction] : []), plan.transaction]
      const fees: EvmFeeEstimate[] = []
      for (const call of calls) {
        input.signal.throwIfAborted()
        fees.push(
          await evmWalletClient.estimateContractCallFee(
            {
              chainId: input.chain.chain.id,
              contractAddress: call.to,
              valueRaw: call.value,
              calldata: call.data
            },
            { executionMode: input.executionMode }
          )
        )
      }
      input.signal.throwIfAborted()
      return {
        ...result,
        ...(input.nativeFeeAsset
          ? {
              sourceNetworkFee: {
                raw: fees.reduce((sum, item) => sum + BigInt(item.maximumFeeWei), 0n).toString(),
                symbol: input.nativeFeeAsset.metadata.symbol,
                decimals: input.nativeFeeAsset.metadata.decimals
              }
            }
          : {})
      }
    } catch {
      input.signal.throwIfAborted()
      return result
    }
  } finally {
    await rheaSwapClient.discard(quote.quoteHandle).catch(() => {})
  }
}

export function formatMoveMethodFee(
  estimate: MoveMethodEstimate | null,
  asset: PortfolioAssetView | null
): { value: string; detail: string | null } {
  if (!estimate || !asset || estimate.routeFeeRaw === null) return { value: '—', detail: null }
  const gas = estimate.sourceNetworkFee
  const format = (raw: string, decimals: number) => {
    const value = BigInt(raw)
    return `${value < 0n ? '-' : ''}${formatFeeAmount(formatBaseUnitDecimalAmount(value < 0n ? -value : value, decimals))}`
  }
  if (gas && asset.asset.kind === 'native')
    return {
      value: `~${format((BigInt(estimate.routeFeeRaw) + BigInt(gas.raw)).toString(), asset.metadata.decimals)} ${asset.metadata.symbol}`,
      detail: null
    }
  return {
    value: `~${format(estimate.routeFeeRaw, asset.metadata.decimals)} ${asset.metadata.symbol}`,
    detail: gas ? `+\u00a0~${format(gas.raw, gas.decimals)} ${gas.symbol}` : '+ network fee'
  }
}
