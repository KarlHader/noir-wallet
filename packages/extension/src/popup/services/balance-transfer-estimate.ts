import type { PortfolioAssetView, PortfolioChainView } from '@/core/portfolio'
import {
  NEAR_DIRECT_RHEA_TOKEN_LIST_CHAIN_ID,
  nearDirectCatalogToken,
  nearDirectQuoteAsset
} from '@/core/chains/near/near-incognito-move'
import { resolveRheaPrivateTransferToken, type RheaSwapQuoteMode } from '@/core/services/rhea-swap'
import { preferWalletEvmQuoteToken, toWalletEvmQuoteToken } from './token-address-discovery'
import type { ConfidentialFundingPreview } from '@/core/services/confidential-funding'
import {
  formatBaseUnitDecimalAmount,
  formatDecimalAmount,
  formatFeeAmount
} from '@/lib/number-format'
import { evmWalletClient, type EvmFeeEstimate } from './evm-wallet-client'
import { rheaSwapClient } from './rhea-swap-client'
import { requiredRheaEvmApproval } from './rhea-evm-approval'
import { CONFIDENTIAL_QUOTED_FEE_UNREPRESENTABLE_ERROR } from '@/background/confidential-funding-api'
import { formatIntentsConfirmationTime } from './confirmation-time-format'
import { readSwapErrorReason } from './swap-quote-error-message'

const BRIDGE_MINIMUM_RAW = /amount is too low for bridge,?\s*try at least ([0-9]+)/i

export function formatTransferQuoteMinimumError(
  error: string,
  decimals: number,
  symbol: string
): string | null {
  if (error === CONFIDENTIAL_QUOTED_FEE_UNREPRESENTABLE_ERROR) {
    return CONFIDENTIAL_QUOTED_FEE_UNREPRESENTABLE_ERROR
  }
  const match = BRIDGE_MINIMUM_RAW.exec(readSwapErrorReason(error))
  if (!match) return null
  const amount = formatFeeAmount(formatBaseUnitDecimalAmount(match[1]!, decimals))
  return `Minimum transfer amount is ${amount} ${symbol}.`
}

export interface BalanceTransferEstimate {
  readonly expiresAt: number
  readonly routeFeeRaw: string | null
  readonly sourceNetworkFee?: {
    readonly raw: string
    readonly symbol: string
    readonly decimals: number
  }
  /** Native yocto that must remain outside a direct NEAR amount. Not part of the displayed fee. */
  readonly nativeHoldRaw?: string
  readonly time: string
}

const DIRECT_MAXIMUM_MINUTES = 5
const CLUSTER_MAXIMUM_MINUTES = 10 + 2 // Batch execution and arrival allowance.

function formatTransferTime(seconds: number | undefined, maximumMinutes: number): string {
  const range = formatIntentsConfirmationTime(seconds, maximumMinutes)
  return range === '—' ? `Up to ${maximumMinutes} min` : range
}

function routeFee(amountRaw: string, outputRaw: string): string | null {
  const difference = BigInt(amountRaw) - BigInt(outputRaw)
  return difference.toString()
}

export function clusterTransferEstimate(
  amountRaw: string,
  preview: ConfidentialFundingPreview
): BalanceTransferEstimate {
  return {
    expiresAt: preview.expiresAt,
    routeFeeRaw: routeFee(amountRaw, preview.amountOutRaw),
    time: formatTransferTime(preview.timeEstimateSeconds, CLUSTER_MAXIMUM_MINUTES)
  }
}

export async function estimateDirectTransfer(input: {
  readonly asset: PortfolioAssetView
  readonly chain: PortfolioChainView
  readonly destinationAsset?: PortfolioAssetView
  readonly nativeFeeAsset: PortfolioAssetView | null
  readonly amountRaw: string
  readonly sender: string
  readonly recipient: string
  readonly executionMode: 'main' | 'private'
  readonly slippageBps: number
  readonly quoteMode: RheaSwapQuoteMode
  readonly signal: AbortSignal
}): Promise<BalanceTransferEstimate> {
  if (input.chain.chain.family === 'near') return estimateNearDirectTransfer(input)
  const match = /^eip155:([1-9][0-9]*)$/.exec(input.chain.chain.id)
  if (!match || input.asset.asset.chainId !== input.chain.chain.id) {
    throw new Error('This network does not support the transfer')
  }
  const catalog = await rheaSwapClient
    .listTokens({ direction: 'from', tokenListChainIds: [Number(match[1])] })
    .catch(() => null)
  input.signal.throwIfAborted()
  const catalogToken = resolveRheaPrivateTransferToken(
    catalog?.tokens ?? [],
    input.asset.asset.kind === 'token' ? input.asset.asset.reference : null
  )
  const token = preferWalletEvmQuoteToken(input.asset, catalogToken)
  if (!token) throw new Error('This asset is unavailable for the transfer')
  const destination = input.destinationAsset ? toWalletEvmQuoteToken(input.destinationAsset) : token
  if (!destination || (input.destinationAsset && destination.rheaChainId === token.rheaChainId)) {
    throw new Error('This destination is unavailable for the transfer')
  }
  const asset = (item: typeof token) => ({
    chain: item.rheaChainId,
    address: item.rheaAddress,
    symbol: item.symbol,
    decimals: item.decimals,
    isNative: item.isNative
  })
  const quote = await rheaSwapClient.quote(
    {
      fromChain: token.rheaChainId,
      toChain: destination.rheaChainId,
      tokenIn: asset(token),
      tokenOut: asset(destination),
      amountIn: input.amountRaw,
      sender: input.sender,
      recipient: input.recipient,
      slippageBps: input.slippageBps,
      quoteMode: input.quoteMode,
      confidentiality: 'basic'
    },
    input.executionMode === 'private'
      ? input.destinationAsset
        ? 'private-cross-chain-withdraw'
        : 'private-transfer'
      : 'public-private-move'
  )
  try {
    input.signal.throwIfAborted()
    if (input.destinationAsset) {
      const review = await rheaSwapClient.prepare(quote.quoteHandle)
      input.signal.throwIfAborted()
      if (
        !review.isCrossChain ||
        review.quoteHandle !== quote.quoteHandle ||
        review.recipient.toLowerCase() !== input.recipient.toLowerCase() ||
        review.fromChain !== token.rheaChainId ||
        review.toChain !== destination.rheaChainId ||
        review.execution.chain !== token.rheaChainId ||
        (review.execution.kind !== 'evm-transaction' && review.execution.kind !== 'evm-signature')
      ) {
        throw new Error('Cross-chain transfer execution is unavailable')
      }
      if (input.executionMode === 'private') {
        if (review.execution.kind !== 'evm-transaction')
          throw new Error('Cross-chain transfer execution is unavailable')
        const plan = await rheaSwapClient.getEvmTransactionPlan(quote.quoteHandle)
        input.signal.throwIfAborted()
        if (
          plan.quoteHandle !== review.quoteHandle ||
          plan.executionId !== review.executionId ||
          String(plan.transaction.chainId) !== token.rheaChainId ||
          (plan.transaction.from !== null &&
            plan.transaction.from.toLowerCase() !== input.sender.toLowerCase())
        )
          throw new Error('Cross-chain transfer execution is unavailable')
      }
      return {
        expiresAt: Math.min(quote.expiresAt ?? Infinity, Date.now() + 30_000),
        routeFeeRaw: null,
        time: formatTransferTime(review.timeEstimateSeconds, DIRECT_MAXIMUM_MINUTES)
      }
    }
    let result: BalanceTransferEstimate = {
      expiresAt: Math.min(quote.expiresAt ?? Infinity, Date.now() + 30_000),
      routeFeeRaw: routeFee(input.amountRaw, quote.estimatedOut),
      time: formatTransferTime(undefined, DIRECT_MAXIMUM_MINUTES)
    }
    // A route quote remains useful when RPC cannot estimate its source gas.
    try {
      const review = await rheaSwapClient.prepare(quote.quoteHandle)
      input.signal.throwIfAborted()
      result = {
        ...result,
        time: formatTransferTime(review.timeEstimateSeconds, DIRECT_MAXIMUM_MINUTES)
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

async function estimateNearDirectTransfer(
  input: Parameters<typeof estimateDirectTransfer>[0]
): Promise<BalanceTransferEstimate> {
  if (input.chain.chain.id !== 'near:mainnet') {
    throw new Error('This network does not support the transfer')
  }
  const quoteAsset = nearDirectQuoteAsset(input.asset.asset)
  if (!quoteAsset) throw new Error('This asset is unavailable for the transfer')
  const catalog = await rheaSwapClient
    .listTokens({ direction: 'from', tokenListChainIds: [NEAR_DIRECT_RHEA_TOKEN_LIST_CHAIN_ID] })
    .catch(() => null)
  input.signal.throwIfAborted()
  const token = nearDirectCatalogToken(catalog?.tokens ?? [], quoteAsset)
  if (!token) throw new Error('This asset is unavailable for the transfer')
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
    input.executionMode === 'private' ? 'private-transfer' : 'public-private-move'
  )
  try {
    input.signal.throwIfAborted()
    let nativeHoldRaw: string | undefined
    if (input.asset.asset.kind === 'native') {
      await rheaSwapClient.prepare(quote.quoteHandle)
      input.signal.throwIfAborted()
      nativeHoldRaw = await rheaSwapClient.readNearDirectNativeHold(quote.quoteHandle, input.sender)
    }
    input.signal.throwIfAborted()
    return {
      expiresAt: Math.min(quote.expiresAt ?? Infinity, Date.now() + 30_000),
      routeFeeRaw: routeFee(input.amountRaw, quote.estimatedOut),
      time: formatTransferTime(undefined, DIRECT_MAXIMUM_MINUTES),
      ...(nativeHoldRaw === undefined ? {} : { nativeHoldRaw })
    }
  } finally {
    await rheaSwapClient.discard(quote.quoteHandle).catch(() => {})
  }
}

export function formatBalanceTransferFee(
  estimate: BalanceTransferEstimate | null,
  asset: PortfolioAssetView | null
): { value: string; detail: string | null } {
  if (!estimate || !asset || estimate.routeFeeRaw === null) return { value: '—', detail: null }
  const gas = estimate.sourceNetworkFee
  const format = (raw: string, decimals: number, native = false) => {
    const value = BigInt(raw)
    const amount = formatBaseUnitDecimalAmount(value < 0n ? -value : value, decimals)
    const display = native
      ? formatDecimalAmount(amount, { maximumFractionDigits: 5 })
      : formatFeeAmount(amount)
    return `${display.startsWith('<') ? '' : '~'}${value < 0n ? '-' : ''}${display}`
  }
  if (gas && asset.asset.kind === 'native') {
    const total = BigInt(estimate.routeFeeRaw) + BigInt(gas.raw)
    return {
      value: `${format(total.toString(), asset.metadata.decimals, true)} ${asset.metadata.symbol}`,
      detail: null
    }
  }
  return {
    value:
      asset.asset.kind === 'native'
        ? `${format(estimate.routeFeeRaw, asset.metadata.decimals, true)} ${asset.metadata.symbol}`
        : format(estimate.routeFeeRaw, asset.metadata.decimals),
    detail: gas ? `${format(gas.raw, gas.decimals, true)} ${gas.symbol}` : null
  }
}
