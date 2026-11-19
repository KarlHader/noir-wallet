import type { PortfolioAssetView, PortfolioChainView } from '@/core/portfolio'
import {
  resolveRheaPrivateTransferToken,
  type RheaSwapQuoteRequest,
  type RheaSwapToken
} from '@/core/services/rhea-swap'
import { preferWalletEvmQuoteToken } from './token-address-discovery'
import type { EvmFeeSelection } from '@/infrastructure/chains/evm'
import type { BitcoinSupportedAddressType } from '@/core/chains/bitcoin'
import {
  quoteDepositTransferClient,
  type QuoteDepositMaximum,
  type WalletOwnedQuoteAsset
} from './quote-deposit-transfer-client'
import { rheaSwapClient } from './rhea-swap-client'
import { EvmWalletClientError } from './evm-wallet-client'
import { parseDisplayUnitAmount } from '@/lib/number-format'

const evmRouteReserves: Readonly<Record<string, string>> = {
  'eip155:1': '0.003',
  'eip155:56': '0.001',
  'eip155:42161': '0.0003',
  'eip155:8453': '0.0003',
  'eip155:10': '0.0003',
  'eip155:137': '0.1',
  'eip155:43114': '0.02',
  'eip155:143': '0.1',
  'eip155:100': '0.01',
  'eip155:9745': '0.05',
  'eip155:196': '0.01',
  'eip155:80094': '0.05',
  'eip155:11155111': '0.003',
  'eip155:97': '0.001',
  'eip155:421614': '0.0003',
  'eip155:84532': '0.0003',
  'eip155:11155420': '0.0003',
  'eip155:80002': '0.1',
  'eip155:43113': '0.02'
}

const nativeRouteReserves = {
  evm: '0.001',
  bitcoin: '0.0001',
  solana: '0.01',
  near: '0.01',
  zcash: '0.0005'
} as const

const USD_PRICE_DECIMALS = 18
const NATIVE_ROUTE_RESERVE_USD = 1n

function resolvePricedNativeRouteReserve(priceUsd: string | null | undefined, decimals: number) {
  if (!priceUsd) return null
  let price: bigint
  try {
    price = BigInt(parseDisplayUnitAmount(priceUsd, USD_PRICE_DECIMALS))
  } catch {
    return null
  }
  if (price === 0n) return null
  const budget = NATIVE_ROUTE_RESERVE_USD * 10n ** BigInt(decimals + USD_PRICE_DECIMALS)
  // Round the reserve up to a whole base unit so Max never rounds it away.
  return (budget + price - 1n) / price
}

export function resolveNativeRouteMaximum(input: {
  readonly family: keyof typeof nativeRouteReserves
  readonly chainId?: string
  readonly availableRaw: string
  readonly decimals: number
  readonly priceUsd?: string | null
}): string {
  const reserve =
    resolvePricedNativeRouteReserve(input.priceUsd, input.decimals) ??
    BigInt(
      parseDisplayUnitAmount(
        (input.family === 'evm' && input.chainId && evmRouteReserves[input.chainId]) ||
          nativeRouteReserves[input.family],
        input.decimals
      )
    )
  const available = BigInt(input.availableRaw)
  return available > reserve ? (available - reserve).toString() : '0'
}

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
    readonly purpose: NonNullable<Parameters<typeof rheaSwapClient.quote>[1]>
    readonly executionMode: 'main' | 'private'
    readonly feeTier?: 'low' | 'standard' | 'fast'
    readonly slippageBps?: number
    readonly quoteMode?: RheaSwapQuoteRequest['quoteMode']
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
    const quote = await dependencies.rhea.quote(
      {
        fromChain: input.tokenIn.rheaChainId,
        toChain: input.tokenOut.rheaChainId,
        tokenIn: assetRef(input.tokenIn),
        tokenOut: assetRef(input.tokenOut),
        amountIn: probe.toString(),
        sender: input.source.refundAddress,
        recipient: input.recipient,
        slippageBps: input.slippageBps ?? 100,
        quoteMode: input.quoteMode ?? 'best-price',
        ...(input.confidential ? { confidentiality: 'basic' as const } : {})
      },
      input.purpose
    )
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
  readonly purpose: 'public-private-send' | 'confidential-funding' | 'private-transfer'
}) {
  const catalog = await rheaSwapClient
    .listTokens({
      direction: 'from',
      tokenListChainIds: [Number(input.chain.chain.id.split(':')[1])]
    })
    .catch(() => null)
  const catalogToken = resolveRheaPrivateTransferToken(
    catalog?.tokens ?? [],
    input.asset.asset.kind === 'native' ? null : input.asset.asset.reference
  )
  const token = preferWalletEvmQuoteToken(input.asset, catalogToken)
  if (!token) throw new Error('Move source asset could not be mapped to a quote token')
  return estimateRheaRouteMaximum({
    source: createNativeTransferSource(input),
    tokenIn: token,
    tokenOut: token,
    recipient: input.recipient,
    confidential: true,
    purpose: input.purpose,
    executionMode: input.executionMode
  })
}
