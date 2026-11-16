import type { PortfolioAssetView, PortfolioChainView } from '@/core/portfolio'
import { resolveRheaPrivateTransferToken } from '@/core/services/rhea-swap'
import type { ConfidentialFundingPreview } from '@/core/services/confidential-funding'
import { formatBaseUnitDecimalAmount, formatFeeAmount } from '@/lib/number-format'
import { evmWalletClient, type EvmFeeEstimate } from './evm-wallet-client'
import { rheaSwapClient } from './rhea-swap-client'
import { requiredRheaEvmApproval } from './rhea-evm-approval'
import { formatConfirmationTime } from './confirmation-time-format'

export interface MoveMethodEstimate {
  readonly expiresAt: number
  readonly routeFeeRaw: string | null
  readonly sourceNetworkFee?: {
    readonly raw: string
    readonly symbol: string
    readonly decimals: number
  }
  readonly time: string
  readonly timeScope: 'Network only' | 'Excl. scheduling'
}

function routeFee(amountRaw: string, outputRaw: string): string | null {
  const difference = BigInt(amountRaw) - BigInt(outputRaw)
  return difference.toString()
}

export function clusterMoveEstimate(
  amountRaw: string,
  preview: ConfidentialFundingPreview
): MoveMethodEstimate {
  const seconds = preview.timeEstimateSeconds
  return {
    expiresAt: preview.expiresAt,
    routeFeeRaw: routeFee(amountRaw, preview.amountOutRaw),
    ...(preview.sourceNetworkFee ? { sourceNetworkFee: preview.sourceNetworkFee } : {}),
    time: formatConfirmationTime(
      seconds ? { minimumSeconds: seconds, maximumSeconds: seconds } : null
    ),
    timeScope: 'Excl. scheduling'
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
  const catalog = await rheaSwapClient.listTokens({
    direction: 'from',
    tokenListChainIds: [Number(match[1])]
  })
  input.signal.throwIfAborted()
  const token = resolveRheaPrivateTransferToken(
    catalog.tokens,
    input.asset.asset.kind === 'token' ? input.asset.asset.reference : null
  )
  if (!token || token.decimals !== input.asset.metadata.decimals)
    throw new Error('Move route unavailable')
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
    const result: MoveMethodEstimate = {
      expiresAt: Math.min(quote.expiresAt ?? Infinity, Date.now() + 30_000),
      routeFeeRaw: routeFee(input.amountRaw, quote.estimatedOut),
      time: '—',
      timeScope: 'Network only'
    }
    // A route quote remains useful when RPC cannot estimate its source gas.
    try {
      const review = await rheaSwapClient.prepare(quote.quoteHandle)
      input.signal.throwIfAborted()
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
      const fee = fees[0]!
      const confirmation = await evmWalletClient
        .getConfirmationEstimate({
          chainId: fee.chainId,
          maxFeePerGasWei: fee.maxFeePerGasWei,
          maxPriorityFeePerGasWei: fee.maxPriorityFeePerGasWei
        })
        .catch(() => null)
      const confirmations = calls.length
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
          : {}),
        time: formatConfirmationTime(
          confirmation
            ? {
                minimumSeconds: confirmation.minimumSeconds * confirmations,
                maximumSeconds: confirmation.maximumSeconds * confirmations
              }
            : null
        )
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
    detail: gas ? `+ ~${format(gas.raw, gas.decimals)} ${gas.symbol}` : '+ network fee'
  }
}
