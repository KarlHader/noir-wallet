import type { PortfolioAssetView, PortfolioChainView } from '@/core/portfolio'
import { resolveRheaPrivateTransferToken, type RheaSwapToken } from '@/core/services/rhea-swap'
import type { EvmFeeSelection } from '@/infrastructure/chains/evm'
import type { BitcoinSupportedAddressType } from '@/core/chains/bitcoin'
import {
  quoteDepositTransferClient,
  type QuoteDepositMaximum,
  type WalletOwnedQuoteAsset
} from './quote-deposit-transfer-client'
import { rheaSwapClient } from './rhea-swap-client'
import { EvmWalletClientError } from './evm-wallet-client'

export function createNativeTransferSource(input: {
  readonly asset: PortfolioAssetView
  readonly chain: PortfolioChainView
  readonly availableRaw: string
  readonly sender: string
  readonly bitcoinAddressType?: BitcoinSupportedAddressType
}): WalletOwnedQuoteAsset {
  const asset = {
    ...input.asset,
    balance: { ...input.asset.balance, availableRaw: input.availableRaw }
  }
  const base = {
    asset,
    networkFeeAsset: asset,
    chain: input.chain,
    refundAddress: input.sender,
    sourceAssetId: asset.asset.id
  }
  const family = input.chain.chain.family
  if (family === 'bitcoin')
    return { ...base, family, bitcoinAddressType: input.bitcoinAddressType ?? 'p2wpkh' }
  if (family === 'evm' || family === 'solana' || family === 'near') return { ...base, family }
  throw new Error('Unsupported transfer source')
}

export function resolveTransferSpendableRaw(
  balanceRaw: string,
  maximumRaw: string | null,
  isNative: boolean
): string | null {
  if (!isNative) return balanceRaw
  if (maximumRaw === null) return balanceRaw
  if (!/^(0|[1-9][0-9]*)$/.test(maximumRaw) || BigInt(maximumRaw) > BigInt(balanceRaw)) {
    throw new Error('Invalid maximum transfer amount')
  }
  return maximumRaw
}

/** A local proposal for Max when fee services are unavailable. Preparation still validates the fee. */
export function fallbackTransferMaximum(source: WalletOwnedQuoteAsset): QuoteDepositMaximum {
  const available = BigInt(source.asset.balance.availableRaw)
  const decimals = source.asset.metadata.decimals
  const base = 10n ** BigInt(decimals)
  const fixedReserve =
    source.family === 'evm'
      ? base / 1000n
      : source.family === 'solana'
        ? base / 100n
        : source.family === 'near'
          ? base / 10n
          : 10_000n
  const proposedReserve = fixedReserve > available / 20n ? fixedReserve : available / 20n
  const reserve = proposedReserve < available / 2n ? proposedReserve : available / 2n
  const amount = available > reserve ? available - reserve : 0n
  return {
    amountRaw: amount.toString(),
    networkFeeRaw: reserve.toString(),
    networkFeeSymbol: source.networkFeeAsset.metadata.symbol,
    networkFeeDecimals: source.networkFeeAsset.metadata.decimals
  }
}

export function isTransferAmountSpendable(
  amountRaw: string | null,
  spendableRaw: string | null
): boolean {
  return (
    amountRaw !== null &&
    spendableRaw !== null &&
    BigInt(amountRaw) > 0n &&
    BigInt(amountRaw) <= BigInt(spendableRaw)
  )
}

export async function estimateNativeTransferMaximum(
  input: {
    readonly source: WalletOwnedQuoteAsset
    readonly recipient: string
    readonly feeSelection?: EvmFeeSelection
    readonly feeTier?: 'low' | 'standard' | 'fast'
    readonly executionMode?: 'main' | 'private'
  },
  client: Pick<typeof quoteDepositTransferClient, 'estimateMaximum'> = quoteDepositTransferClient
) {
  return client.estimateMaximum({
    source: input.source,
    depositAddress: input.recipient,
    feeSelection: input.feeSelection,
    feeTier: input.feeTier,
    executionMode: input.executionMode
  })
}

export async function estimateRheaRouteMaximum(
  input: {
    readonly source: WalletOwnedQuoteAsset
    readonly tokenIn: RheaSwapToken
    readonly tokenOut: RheaSwapToken
    readonly recipient: string
    readonly confidential: boolean
    readonly executionMode: 'main' | 'private'
    readonly feeTier?: 'low' | 'standard' | 'fast'
    readonly slippageBps?: number
  },
  dependencies: {
    readonly rhea: Pick<
      typeof rheaSwapClient,
      'quote' | 'prepare' | 'getEvmTransactionPlan' | 'discard'
    >
    readonly transfer: Pick<typeof quoteDepositTransferClient, 'estimateMaximum'>
  } = { rhea: rheaSwapClient, transfer: quoteDepositTransferClient }
) {
  let probe = BigInt(input.source.asset.balance.availableRaw) / 2n
  if (probe <= 0n) throw new Error('The source wallet balance does not cover the network fee')
  const assetRef = (token: RheaSwapToken) => ({
    chain: token.rheaChainId,
    address: token.rheaAddress,
    symbol: token.symbol,
    decimals: token.decimals,
    isNative: token.isNative
  })
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const quote = await dependencies.rhea.quote({
      fromChain: input.tokenIn.rheaChainId,
      toChain: input.tokenOut.rheaChainId,
      tokenIn: assetRef(input.tokenIn),
      tokenOut: assetRef(input.tokenOut),
      amountIn: probe.toString(),
      sender: input.source.refundAddress,
      recipient: input.recipient,
      slippageBps: input.slippageBps ?? 100,
      ...(input.confidential ? { confidentiality: 'basic' as const } : {})
    })
    try {
      const review = await dependencies.rhea.prepare(quote.quoteHandle)
      if (review.execution.kind === 'evm-signature') {
        return {
          amountRaw: input.source.asset.balance.availableRaw,
          networkFeeRaw: '0',
          networkFeeDecimals: input.source.asset.metadata.decimals,
          networkFeeSymbol: input.source.asset.metadata.symbol
        }
      }
      if (!review.execution.target) throw new Error('The route has no origin transaction target')
      const plan =
        input.source.family === 'evm' && review.execution.kind === 'evm-transaction'
          ? await dependencies.rhea.getEvmTransactionPlan(quote.quoteHandle)
          : null
      if (plan?.approval) throw new Error('A native transfer cannot require a token approval')
      return await dependencies.transfer.estimateMaximum({
        source: input.source,
        depositAddress: review.execution.target,
        executionMode: input.executionMode,
        feeTier: input.feeTier,
        ...(plan ? { evmTransaction: plan.transaction, quotedAmountRaw: review.amountIn } : {})
      })
    } catch (error) {
      if (
        !(error instanceof EvmWalletClientError) ||
        error.code !== 'insufficient-funds' ||
        attempt === 3 ||
        probe <= 1n
      )
        throw error
      // Re-quote the smaller amount so calldata and value remain bound to the same route.
      probe /= 2n
    } finally {
      await dependencies.rhea.discard(quote.quoteHandle)
    }
  }
  throw new Error('Unable to estimate the route maximum')
}

export async function estimateConfidentialTransferMaximum(input: {
  readonly asset: PortfolioAssetView
  readonly chain: PortfolioChainView
  readonly availableRaw: string
  readonly sender: string
  readonly recipient: string
  readonly executionMode: 'main' | 'private'
}) {
  const catalog = await rheaSwapClient.listTokens({
    direction: 'from',
    tokenListChainIds: [Number(input.chain.chain.id.split(':')[1])]
  })
  const token = resolveRheaPrivateTransferToken(
    catalog.tokens,
    input.asset.asset.kind === 'native' ? null : input.asset.asset.reference
  )
  if (!token) throw new Error('Confidential transfer is unavailable for this asset')
  return estimateRheaRouteMaximum({
    source: createNativeTransferSource(input),
    tokenIn: token,
    tokenOut: token,
    recipient: input.recipient,
    confidential: true,
    executionMode: input.executionMode
  })
}
