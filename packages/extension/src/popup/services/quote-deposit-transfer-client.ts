import type { PortfolioAssetView, PortfolioChainView, PortfolioReadModel } from '@/core/portfolio'
import type { EvmFeeSelection } from '@/infrastructure/chains/evm'
import type { NetworkFeeTier, TransactionGraph } from '@/core/transactions/domain'
import {
  parseNearIntentsTransactionBinding,
  parseRheaSwapTransactionBinding,
  type NearIntentsTransactionBinding,
  type RheaSwapTransactionBinding
} from '@/core/transactions/domain'
import type { QuoteResult, SwapToken } from '@/core/services/intents-api'
import type { SupplyQuoteResult } from '@/core/services/lending-supply-quote'
import type {
  RheaSwapQuoteView,
  RheaSwapEvmCallView,
  RheaSwapReviewView,
  RheaSwapToken
} from '@/core/services/rhea-swap'
import {
  getRheaSwapQuoteDeadline,
  resolveRheaSwapCanonicalAssetId
} from '@/core/services/rhea-swap'
import {
  getAssetProtocolSourceMappings,
  type AssetProtocolSourceMapping
} from '@/core/prices/asset-market-mappings'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { getEvmNetworkConfigs } from '@/config/networks'
import {
  createAssetId,
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions,
  parseAssetDisplayMetadata,
  parseAssetId,
  parseChainId
} from '@/core/chains/registry'
import type {
  AdditionalReceiveTargetView,
  AdditionalReceiveTargetsView
} from './receive-targets-client'
import type {
  EvmTransferApprovalResult,
  EvmTransferReview,
  EvmWalletClient
} from './evm-wallet-client'
import { evmWalletClient } from './evm-wallet-client'
import type {
  BitcoinTransferReview,
  BitcoinTransferApprovalResult,
  BitcoinWalletClient
} from './bitcoin-wallet-client'
import { bitcoinWalletClient } from './bitcoin-wallet-client'
import {
  resolveIntentsEvmAssets,
  resolveIntentsEvmChainId
} from '@/core/services/intents-evm-assets'
import type { BitcoinSupportedAddressType } from '@/core/chains/bitcoin'
import { resolveIntentsWalletAsset } from '@/core/services/intents-wallet-assets'
import {
  solanaWalletClient,
  type SolanaTransferReview,
  type SolanaTransferSubmission,
  type SolanaWalletClient
} from './solana-wallet-client'
import {
  nearWalletClient,
  type NearTransferReview,
  type NearTransferSubmission,
  type NearWalletClient
} from './near-wallet-client'
import type { NearLendingSupplyBinding } from '@/core/services/lending-near-supply'

export type QuoteDepositSourceFamily = 'evm' | 'bitcoin' | 'solana' | 'near'
export type QuoteDepositExecutionMode = 'main' | 'private'

interface WalletOwnedQuoteAssetBase {
  readonly sourceAssetId: string
  readonly asset: PortfolioAssetView
  readonly networkFeeAsset: PortfolioAssetView
  readonly chain: PortfolioChainView
  readonly refundAddress: string
}

export type WalletOwnedQuoteAsset = Readonly<
  | (WalletOwnedQuoteAssetBase & { readonly family: 'evm' })
  | (WalletOwnedQuoteAssetBase & { readonly family: 'solana' })
  | (WalletOwnedQuoteAssetBase & { readonly family: 'near' })
  | (WalletOwnedQuoteAssetBase & {
      readonly family: 'bitcoin'
      readonly bitcoinAddressType: BitcoinSupportedAddressType
    })
>

export type PreparedQuoteDepositTransfer =
  | Readonly<{
      family: 'evm'
      source: WalletOwnedQuoteAsset
      review: EvmTransferReview
    }>
  | Readonly<{
      family: 'bitcoin'
      source: WalletOwnedQuoteAsset
      review: BitcoinTransferReview
    }>
  | Readonly<{ family: 'solana'; source: WalletOwnedQuoteAsset; review: SolanaTransferReview }>
  | Readonly<{ family: 'near'; source: WalletOwnedQuoteAsset; review: NearTransferReview }>

export type QuoteDepositTransferSubmission =
  | Readonly<{ family: 'evm'; value: EvmTransferApprovalResult }>
  | Readonly<{ family: 'bitcoin'; value: BitcoinTransferApprovalResult }>
  | Readonly<{ family: 'solana'; value: SolanaTransferSubmission }>
  | Readonly<{ family: 'near'; value: NearTransferSubmission }>

export interface QuoteDepositMaximum {
  readonly amountRaw: string
  readonly networkFeeRaw: string
  readonly networkFeeSymbol: string
  readonly networkFeeDecimals: number
}

export interface QuoteDepositTransferClient {
  readonly estimateMaximum: (input: {
    readonly source: WalletOwnedQuoteAsset
    readonly depositAddress: string
    readonly feeTier?: NetworkFeeTier
    readonly feeSelection?: EvmFeeSelection
    readonly executionMode?: QuoteDepositExecutionMode
    readonly nearLendingSupplyBinding?: NearLendingSupplyBinding
    readonly evmTransaction?: RheaSwapEvmCallView
    readonly quotedAmountRaw?: string
  }) => Promise<QuoteDepositMaximum>
  readonly prepare: (input: {
    readonly source: WalletOwnedQuoteAsset
    readonly depositAddress: string
    readonly amountRaw: string
    readonly nearIntentsBinding?: NearIntentsTransactionBinding
    readonly nearLendingSupplyBinding?: NearLendingSupplyBinding
    readonly rheaSwapBinding?: RheaSwapTransactionBinding
    readonly feeTier?: NetworkFeeTier
    readonly executionMode?: QuoteDepositExecutionMode
  }) => Promise<PreparedQuoteDepositTransfer>
  readonly approve: (
    prepared: PreparedQuoteDepositTransfer
  ) => Promise<QuoteDepositTransferSubmission>
  readonly reject: (prepared: PreparedQuoteDepositTransfer) => Promise<TransactionGraph>
}

type NearIntentsQuote = NonNullable<NonNullable<QuoteResult['quoteSuccessResult']>['quote']>

export function createRheaSwapBinding(input: {
  readonly source: WalletOwnedQuoteAsset
  readonly destinationAssetId: string
  readonly destinationChainId: string
  readonly tokenIn: RheaSwapToken
  readonly tokenOut: RheaSwapToken
  readonly quote: RheaSwapQuoteView
  readonly review: RheaSwapReviewView
  readonly confidentiality?: 'basic'
  readonly userAction?: 'transfer'
}): RheaSwapTransactionBinding {
  const sourceTarget =
    input.review.execution.kind === 'evm-signature' ||
    input.review.execution.kind === 'solana-transaction'
      ? input.source.refundAddress
      : input.review.execution.target
  if (!sourceTarget) {
    throw new Error('RHEA Swap did not provide a source-chain transaction target')
  }
  let destinationMetadata
  try {
    destinationMetadata = parseAssetDisplayMetadata({
      name: input.tokenOut.symbol,
      symbol: input.tokenOut.symbol,
      decimals: input.tokenOut.decimals
    })
  } catch {
    // Catalog labels outside wallet display limits must not block a valid quote.
  }
  return parseRheaSwapTransactionBinding({
    schemaVersion: 1,
    provider: 'rhea-cross-chain-dex',
    kind: 'swap',
    ...(input.userAction === undefined ? {} : { userAction: input.userAction }),
    quoteHandle: input.quote.quoteHandle,
    executionId: input.review.executionId,
    router: input.review.router,
    sourceTarget,
    sender: input.source.refundAddress,
    originAmountRaw: input.review.amountIn,
    expiresAt: getRheaSwapQuoteDeadline(input.quote),
    // Confidential settlement still crosses the Intents boundary when the
    // source and destination assets are on the same chain.
    isCrossChain: input.review.isCrossChain || input.confidentiality === 'basic',
    origin: {
      chainId: input.source.chain.chain.id,
      assetId: input.source.asset.asset.id,
      protocolChainId: input.tokenIn.rheaChainId,
      protocolAssetId: input.tokenIn.assetId
    },
    destination: {
      chainId: input.destinationChainId,
      assetId: input.destinationAssetId,
      protocolChainId: input.tokenOut.rheaChainId,
      protocolAssetId: input.tokenOut.assetId,
      recipient: input.quote.recipient,
      expectedAmountRaw: input.quote.estimatedOut,
      minimumAmountRaw: input.quote.minAmountOut,
      ...(destinationMetadata ? { metadata: destinationMetadata } : {})
    }
  })
}

export function resolveRheaSwapDestinationIdentity(
  token: RheaSwapToken,
  portfolio: PortfolioReadModel | null
): Readonly<{ chainId: string; assetId: string }> {
  const mapped = portfolio
    ? resolveMappedPortfolioAsset(token, portfolio, protocolSourceMappings)
    : null
  if (mapped) {
    return Object.freeze({
      chainId: mapped.asset.asset.chainId,
      assetId: mapped.asset.asset.id
    })
  }
  const canonicalAssetId = resolveRheaSwapCanonicalAssetId(token.assetId, DEFAULT_NETWORK)
  if (canonicalAssetId) {
    return Object.freeze({
      chainId: parseAssetId(canonicalAssetId).chainId,
      assetId: canonicalAssetId
    })
  }
  const chainId = parseChainId(`rhea:${token.tokenListChainId}`).id
  // URI encoding leaves characters such as underscores bare, but CAIP-19 does not.
  const reference = encodeURIComponent(token.assetId).replace(
    /[!'()*_]/g,
    character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )
  return Object.freeze({
    chainId,
    assetId: createAssetId(chainId, 'rhea', reference)
  })
}

const chains = createInitialProductChainRegistry(DEFAULT_NETWORK)
const assets = createAssetRegistry(
  chains,
  getBundledInitialProductAssetDefinitions(DEFAULT_NETWORK)
)
const protocolSourceMappings = getAssetProtocolSourceMappings(DEFAULT_NETWORK, assets)
function resolveUserEvmPortfolioAsset(
  token: SwapToken,
  portfolio: PortfolioReadModel
): PortfolioAssetView | null {
  if (!token.contractAddress || !/^0x[0-9a-fA-F]{40}$/.test(token.contractAddress)) return null
  const contractAddress = token.contractAddress.toLowerCase()
  const candidates = portfolio.assets.filter(
    candidate =>
      candidate.asset.kind === 'token' &&
      candidate.asset.namespace === 'erc20' &&
      candidate.asset.reference.toLowerCase() === contractAddress &&
      candidate.metadata.decimals === token.decimals
  )
  if (candidates.length === 0) return null
  const resolved = resolveIntentsEvmAssets([token], getEvmNetworkConfigs(DEFAULT_NETWORK))[0]
  if (!resolved) return null
  return (
    candidates.find(
      candidate =>
        candidate.asset.chainId === resolved.chainId &&
        candidate.asset.reference.toLowerCase() === resolved.contractAddress
    ) ?? null
  )
}

function resolveReceiveTarget(
  chain: PortfolioChainView,
  targets: AdditionalReceiveTargetsView | null
): AdditionalReceiveTargetView | null {
  if (!targets) return null
  return targets.targets.find(target => target.chain.id === chain.chain.id) ?? null
}

function receiveTargetsMatchPortfolio(
  portfolio: PortfolioReadModel,
  receiveTargets: AdditionalReceiveTargetsView | null
): receiveTargets is AdditionalReceiveTargetsView {
  return (
    receiveTargets !== null &&
    portfolio.scope.keyDomainId === receiveTargets.keyDomainId &&
    portfolio.scope.accountId === receiveTargets.accountId
  )
}

function resolveMappedPortfolioAsset(
  token: SwapToken,
  portfolio: PortfolioReadModel,
  mappings: readonly AssetProtocolSourceMapping[]
): Pick<WalletOwnedQuoteAsset, 'asset' | 'networkFeeAsset' | 'chain' | 'sourceAssetId'> | null {
  const mapping = mappings.find(candidate => candidate.protocolAssetId === token.assetId)
  const protocolAsset = resolveIntentsWalletAsset(token, DEFAULT_NETWORK)
  const asset = mapping
    ? portfolio.assets.find(candidate => candidate.asset.id === mapping.assetId)
    : protocolAsset
      ? portfolio.assets.find(candidate => candidate.asset.id === protocolAsset.assetId)
      : resolveUserEvmPortfolioAsset(token, portfolio)
  if (!asset || asset.metadata.decimals !== token.decimals) return null
  const chain = portfolio.chains.find(candidate => candidate.chain.id === asset.asset.chainId)
  const supportedFamily =
    chain?.chain.family === 'evm' ||
    chain?.chain.family === 'bitcoin' ||
    chain?.chain.family === 'solana' ||
    chain?.chain.family === 'near'
  if (!chain || !supportedFamily || chain.chain.capabilities.transaction.status !== 'available') {
    return null
  }
  const networkFeeAsset = portfolio.assets.find(
    candidate => candidate.asset.chainId === chain.chain.id && candidate.asset.kind === 'native'
  )
  if (!networkFeeAsset) return null
  return Object.freeze({
    asset,
    networkFeeAsset,
    chain,
    sourceAssetId: token.assetId
  })
}

export function resolveWalletOwnedQuoteAsset(
  token: SwapToken,
  portfolio: PortfolioReadModel,
  receiveTargets: AdditionalReceiveTargetsView | null,
  mappings: readonly AssetProtocolSourceMapping[] = protocolSourceMappings
): WalletOwnedQuoteAsset | null {
  if (!receiveTargetsMatchPortfolio(portfolio, receiveTargets)) {
    return null
  }
  const resolved = resolveMappedPortfolioAsset(token, portfolio, mappings)
  if (!resolved) return null
  const receiveTarget = resolveReceiveTarget(resolved.chain, receiveTargets)
  if (!receiveTarget) return null
  if (resolved.chain.chain.family === 'evm') {
    if (receiveTarget.kind !== 'evm') return null
    return Object.freeze({
      family: 'evm',
      ...resolved,
      refundAddress: receiveTarget.address
    })
  }
  if (resolved.chain.chain.family === 'bitcoin') {
    if (receiveTarget.kind !== 'bitcoin') return null
    return Object.freeze({
      family: 'bitcoin',
      ...resolved,
      refundAddress: receiveTarget.address,
      bitcoinAddressType: receiveTarget.addressType
    })
  }
  if (resolved.chain.chain.family === 'solana' && receiveTarget.kind === 'solana') {
    return Object.freeze({ family: 'solana', ...resolved, refundAddress: receiveTarget.address })
  }
  if (resolved.chain.chain.family === 'near' && receiveTarget.kind === 'near') {
    return Object.freeze({ family: 'near', ...resolved, refundAddress: receiveTarget.address })
  }
  return null
}

function selectEvmBalance(
  asset: PortfolioAssetView,
  mode: QuoteDepositExecutionMode,
  publicOnly: boolean
): PortfolioAssetView | null {
  const selectedRaw =
    mode === 'private'
      ? (asset.balance.privateOnchainRaw ?? asset.balance.privateRaw)
      : (asset.balance.mainRaw ?? (publicOnly ? asset.balance.availableRaw : undefined))
  if (selectedRaw === undefined) return null
  return Object.freeze({
    ...asset,
    balance: Object.freeze({
      ...asset.balance,
      totalRaw: selectedRaw,
      spendableRaw: selectedRaw,
      availableRaw: selectedRaw
    })
  })
}

export function selectWalletOwnedQuoteAssetExecution(
  source: WalletOwnedQuoteAsset,
  mode: QuoteDepositExecutionMode,
  privateExecutionAddress?: string,
  publicOnly = false
): WalletOwnedQuoteAsset | null {
  if (source.family !== 'evm') return mode === 'main' ? source : null
  const asset = selectEvmBalance(source.asset, mode, publicOnly)
  const networkFeeAsset = selectEvmBalance(source.networkFeeAsset, mode, publicOnly)
  if (!asset || !networkFeeAsset) return null
  let refundAddress = source.refundAddress
  if (mode === 'private') {
    if (
      !privateExecutionAddress ||
      !/^0x[0-9a-fA-F]{40}$/.test(privateExecutionAddress) ||
      privateExecutionAddress.toLowerCase() === source.refundAddress.toLowerCase()
    ) {
      return null
    }
    refundAddress = privateExecutionAddress
  }
  return Object.freeze({
    ...source,
    asset,
    networkFeeAsset,
    refundAddress
  })
}

export function resolveWalletQuoteReceiveTarget(
  token: SwapToken,
  portfolio: PortfolioReadModel,
  receiveTargets: AdditionalReceiveTargetsView | null,
  mappings: readonly AssetProtocolSourceMapping[] = protocolSourceMappings
): AdditionalReceiveTargetView | null {
  if (!receiveTargetsMatchPortfolio(portfolio, receiveTargets)) return null

  const mapped = resolveMappedPortfolioAsset(token, portfolio, mappings)
  const protocolAsset = resolveIntentsWalletAsset(token, DEFAULT_NETWORK)
  const chainId =
    mapped?.chain.chain.id ??
    protocolAsset?.chainId ??
    resolveIntentsEvmChainId(token.blockchain, getEvmNetworkConfigs(DEFAULT_NETWORK))
  if (!chainId) return null
  return receiveTargets.targets.find(target => target.chain.id === chainId) ?? null
}

export function resolveWalletSwapSourceToken(
  requestedAssetId: string | null | undefined,
  tokens: readonly SwapToken[],
  portfolio: PortfolioReadModel | null,
  receiveTargets: AdditionalReceiveTargetsView | null,
  mappings: readonly AssetProtocolSourceMapping[] = protocolSourceMappings
): SwapToken | null {
  if (!requestedAssetId) return null
  const mappedProtocolAssetId = mappings.find(
    candidate => candidate.assetId === requestedAssetId
  )?.protocolAssetId
  for (const token of tokens) {
    if (token.assetId === requestedAssetId) return token
    if (token.assetId === mappedProtocolAssetId) return token
    if (!portfolio) continue
    const source = resolveWalletOwnedQuoteAsset(token, portfolio, receiveTargets, mappings)
    if (source?.asset.asset.id === requestedAssetId) return token
  }
  return null
}

export function listWalletSwapSourceTokens<T extends SwapToken>(
  tokens: readonly T[],
  portfolio: PortfolioReadModel | null,
  receiveTargets: AdditionalReceiveTargetsView | null,
  options: {
    readonly includeZcash: boolean
    readonly mappings?: readonly AssetProtocolSourceMapping[]
  }
): readonly T[] {
  const mappings = options.mappings ?? protocolSourceMappings
  return Object.freeze(
    tokens.filter(token => {
      if (token.blockchain === 'zec' || token.blockchain === 'zcash') {
        return options.includeZcash
      }
      return (
        portfolio !== null &&
        resolveWalletOwnedQuoteAsset(token, portfolio, receiveTargets, mappings) !== null
      )
    })
  )
}

export function createNearIntentsSwapBinding(input: {
  readonly source: WalletOwnedQuoteAsset
  readonly destination?: WalletOwnedQuoteAsset
  readonly tokenIn: SwapToken
  readonly tokenOut: SwapToken
  readonly amountInRaw: string
  readonly recipient: string
  readonly quote: NearIntentsQuote
  readonly now?: number
}): NearIntentsTransactionBinding {
  if (
    input.tokenIn.assetId !== input.source.sourceAssetId ||
    input.tokenIn.decimals !== input.source.asset.metadata.decimals ||
    input.quote.amountIn !== input.amountInRaw ||
    input.quote.depositAddress.length === 0
  ) {
    throw new Error('Near Intents quote does not match the wallet source asset')
  }
  const mappedDestination = protocolSourceMappings.find(
    candidate => candidate.protocolAssetId === input.tokenOut.assetId
  )
  const protocolDestination = resolveIntentsWalletAsset(input.tokenOut, DEFAULT_NETWORK)
  const destinationAsset =
    input.destination?.asset ??
    (mappedDestination ? assets.resolve(mappedDestination.assetId) : null)
  const destinationIdentity = destinationAsset
    ? Object.freeze({
        chainId: destinationAsset.asset.chainId,
        assetId: destinationAsset.asset.id,
        decimals: destinationAsset.metadata.decimals
      })
    : protocolDestination
      ? Object.freeze({
          chainId: protocolDestination.chainId,
          assetId: protocolDestination.assetId,
          decimals: input.tokenOut.decimals
        })
      : null
  if (
    !destinationIdentity ||
    (input.destination && input.destination.sourceAssetId !== input.tokenOut.assetId) ||
    destinationIdentity.decimals !== input.tokenOut.decimals
  ) {
    throw new Error('Near Intents destination asset is unavailable or does not match the wallet')
  }
  const expiresAt = Date.parse(input.quote.deadline)
  const now = input.now ?? Date.now()
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    throw new Error('Near Intents quote is expired or has an invalid deadline')
  }
  return parseNearIntentsTransactionBinding({
    schemaVersion: 1,
    provider: 'near-intents',
    kind: 'swap',
    depositAddress: input.quote.depositAddress,
    refundAddress: input.source.refundAddress,
    expiresAt,
    origin: {
      chainId: input.source.chain.chain.id,
      assetId: input.source.asset.asset.id,
      protocolAssetId: input.source.sourceAssetId
    },
    destination: {
      chainId: destinationIdentity.chainId,
      assetId: destinationIdentity.assetId,
      protocolAssetId: input.tokenOut.assetId,
      recipient: input.recipient,
      expectedAmountRaw: input.quote.amountOut,
      minimumAmountRaw: input.quote.minAmountOut
    }
  })
}

export function createNearIntentsSupplyBinding(input: {
  readonly source: WalletOwnedQuoteAsset
  readonly amountInRaw: string
  readonly mcaId: string
  readonly quote: SupplyQuoteResult
  readonly destinationAsset: string
  readonly now?: number
}): NearIntentsTransactionBinding {
  if (input.quote.amountInRaw !== input.amountInRaw || input.quote.depositAddress.length === 0) {
    throw new Error('RHEA supply quote does not match the wallet source asset')
  }
  const expiresAt = Date.parse(input.quote.deadline)
  const now = input.now ?? Date.now()
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    throw new Error('RHEA supply quote is expired or has an invalid deadline')
  }
  return parseNearIntentsTransactionBinding({
    schemaVersion: 1,
    provider: 'near-intents',
    kind: 'supply',
    depositAddress: input.quote.depositAddress,
    refundAddress: input.source.refundAddress,
    expiresAt,
    origin: {
      chainId: input.source.chain.chain.id,
      assetId: input.source.asset.asset.id,
      protocolAssetId: input.source.sourceAssetId
    },
    destination: {
      chainId: input.source.chain.chain.id,
      assetId: input.source.asset.asset.id,
      protocolAssetId: input.destinationAsset,
      recipient: input.mcaId,
      expectedAmountRaw: input.quote.amountOutRaw,
      minimumAmountRaw: input.quote.minAmountOutRaw
    }
  })
}

function assertAmountRaw(value: string): string {
  if (!/^[1-9][0-9]{0,77}$/.test(value)) {
    throw new Error('Quote deposit amount must be a positive base-unit integer')
  }
  return value
}

export function createQuoteDepositTransferClient(options: {
  readonly evm: Pick<
    EvmWalletClient,
    'prepareTransfer' | 'prepareContractCall' | 'approveTransfer' | 'rejectTransfer'
  >
  readonly bitcoin: Pick<
    BitcoinWalletClient,
    'prepareTransfer' | 'approveTransfer' | 'rejectTransfer'
  >
  readonly solana: Pick<
    SolanaWalletClient,
    'prepareTransfer' | 'approveTransfer' | 'rejectTransfer'
  >
  readonly near: Pick<NearWalletClient, 'prepareTransfer' | 'approveTransfer' | 'rejectTransfer'>
}): QuoteDepositTransferClient {
  const client: QuoteDepositTransferClient = {
    estimateMaximum: async input => {
      const availableRaw = BigInt(input.source.asset.balance.availableRaw)
      if (availableRaw <= 0n) throw new Error('The source wallet has no available balance')

      if (input.source.family === 'evm') {
        const isNative = input.source.asset.asset.kind === 'native'
        // A direct native fee probe must still fit when gas consumes most of the balance.
        const probeAmountRaw = isNative ? '1' : availableRaw.toString()
        const prepareOptions = {
          ...(input.feeSelection === undefined ? {} : { feeSelection: input.feeSelection }),
          ...(input.feeTier === undefined ? {} : { feeTier: input.feeTier }),
          ...(input.executionMode === undefined ? {} : { executionMode: input.executionMode })
        }
        const transaction = input.evmTransaction
        const quotedAmountRaw =
          input.quotedAmountRaw === undefined
            ? null
            : BigInt(assertAmountRaw(input.quotedAmountRaw))
        if (
          transaction &&
          (!isNative ||
            `eip155:${transaction.chainId}` !== input.source.chain.chain.id ||
            quotedAmountRaw === null ||
            !/^(0|[1-9][0-9]*)$/.test(transaction.value))
        ) {
          throw new Error('The EVM maximum plan does not match its native source amount')
        }
        const additionalValueRaw =
          transaction && quotedAmountRaw !== null ? BigInt(transaction.value) - quotedAmountRaw : 0n
        if (additionalValueRaw < 0n) {
          throw new Error('The EVM maximum plan does not match its native source amount')
        }
        const review =
          transaction && transaction.data !== '0x'
            ? await options.evm.prepareContractCall(
                {
                  chainId: input.source.chain.chain.id,
                  contractAddress: transaction.to,
                  valueRaw: transaction.value,
                  calldata: transaction.data
                },
                prepareOptions
              )
            : await options.evm.prepareTransfer(
                {
                  assetId: input.source.asset.asset.id,
                  recipient: transaction?.to ?? input.depositAddress,
                  amountRaw: transaction?.value ?? probeAmountRaw
                },
                prepareOptions
              )
        try {
          const summary = review.review.summary
          if (summary.schema !== 'evm.transaction.v1') {
            throw new Error('The EVM maximum estimate has an invalid signing summary')
          }
          const feeRaw = BigInt(summary.fields.maximumFeeWei)
          // Max needs room for a fresh RHEA quote and EVM fee calculation before signing.
          const feeHeadroomRaw = (feeRaw + 3n) / 4n
          const amountRaw = isNative
            ? availableRaw - feeRaw - feeHeadroomRaw - additionalValueRaw
            : availableRaw
          if (amountRaw <= 0n) {
            throw new Error('The source wallet balance does not cover the network fee')
          }
          return Object.freeze({
            amountRaw: amountRaw.toString(),
            networkFeeRaw: feeRaw.toString(),
            networkFeeSymbol: input.source.networkFeeAsset.metadata.symbol,
            networkFeeDecimals: input.source.networkFeeAsset.metadata.decimals
          })
        } finally {
          await options.evm.rejectTransfer(review.graph.root.id)
        }
      }

      if (input.source.family === 'solana' || input.source.family === 'near') {
        const isNative = input.source.asset.asset.kind === 'native'
        const probeAmountRaw = isNative
          ? input.nearLendingSupplyBinding
            ? (availableRaw / 2n > 0n ? availableRaw / 2n : availableRaw).toString()
            : '1'
          : availableRaw.toString()
        const wallet = input.source.family === 'solana' ? options.solana : options.near
        const review = await wallet.prepareTransfer(
          {
            assetId: input.source.asset.asset.id,
            recipient: input.depositAddress,
            amountRaw: probeAmountRaw
          },
          input.source.family === 'near' && input.nearLendingSupplyBinding
            ? { nearLendingSupplyBinding: input.nearLendingSupplyBinding }
            : undefined
        )
        try {
          const maximumFeeRaw =
            'debit' in review
              ? review.debit.maximumFeeRaw
              : review.graph.root.intent?.feeLimit?.amountRaw
          if (maximumFeeRaw === undefined || !/^(0|[1-9][0-9]*)$/.test(maximumFeeRaw))
            throw new Error('The maximum estimate has no valid network fee')
          const feeRaw = BigInt(maximumFeeRaw)
          const summary = review.review.summary
          const reserveRaw = 'debit' in review ? BigInt(review.debit.storageReserveRaw) : 0n
          const actionDepositRaw =
            summary.schema === 'near.transaction.v1'
              ? summary.fields.actions.reduce(
                  (total, action) =>
                    total + (action.kind === 'function-call' ? BigInt(action.depositYocto) : 0n),
                  0n
                )
              : 0n
          const attachedDepositRaw =
            actionDepositRaw > BigInt(probeAmountRaw)
              ? actionDepositRaw - BigInt(probeAmountRaw)
              : 0n
          const amountRaw = isNative
            ? availableRaw - feeRaw - reserveRaw - attachedDepositRaw
            : availableRaw
          if (amountRaw <= 0n) {
            throw new Error('The source wallet balance does not cover the network fee')
          }
          return Object.freeze({
            amountRaw: amountRaw.toString(),
            networkFeeRaw: feeRaw.toString(),
            networkFeeSymbol: input.source.networkFeeAsset.metadata.symbol,
            networkFeeDecimals: input.source.networkFeeAsset.metadata.decimals
          })
        } finally {
          await wallet.rejectTransfer(review.graph.root.id)
        }
      }

      const review = await options.bitcoin.prepareTransfer(
        {
          recipient: input.depositAddress,
          amount: Object.freeze({ mode: 'max' as const })
        },
        {
          bitcoinAddressType: input.source.bitcoinAddressType,
          ...(input.feeTier === undefined ? {} : { feeTier: input.feeTier })
        }
      )
      try {
        const summary = review.review.summary
        const amountRaw = review.graph.root.intent?.primaryAmount?.amountRaw
        if (
          summary.schema !== 'bitcoin.psbt.v1' ||
          amountRaw === undefined ||
          BigInt(amountRaw) <= 0n
        ) {
          throw new Error('The Bitcoin maximum estimate has an invalid signing summary')
        }
        return Object.freeze({
          amountRaw,
          networkFeeRaw: summary.fields.feeSats,
          networkFeeSymbol: input.source.networkFeeAsset.metadata.symbol,
          networkFeeDecimals: input.source.networkFeeAsset.metadata.decimals
        })
      } finally {
        await options.bitcoin.rejectTransfer(review.graph.root.id)
      }
    },
    prepare: async input => {
      const amountRaw = assertAmountRaw(input.amountRaw)
      const bindingCount = [
        input.nearIntentsBinding,
        input.nearLendingSupplyBinding,
        input.rheaSwapBinding
      ].filter(Boolean).length
      if (bindingCount !== 1) {
        throw new Error('Quote deposit transfer requires exactly one protocol binding')
      }
      if (input.rheaSwapBinding && input.source.family !== 'bitcoin') {
        throw new Error('This RHEA Swap execution requires a chain-native coordinator')
      }
      if (input.nearLendingSupplyBinding && input.source.family !== 'near') {
        throw new Error('Direct NEAR Lending Supply requires a NEAR wallet source')
      }
      const nearIntentsBinding = input.nearIntentsBinding
      if (input.source.family === 'evm') {
        if (!nearIntentsBinding) throw new Error('NEAR Intents transaction binding is missing')
        const review = await options.evm.prepareTransfer(
          {
            assetId: input.source.asset.asset.id,
            recipient: input.depositAddress,
            amountRaw
          },
          {
            nearIntentsBinding,
            ...(input.feeTier === undefined ? {} : { feeTier: input.feeTier }),
            ...(input.executionMode === undefined ? {} : { executionMode: input.executionMode })
          }
        )
        return Object.freeze({ family: 'evm' as const, source: input.source, review })
      }
      if (input.source.family === 'solana') {
        if (!nearIntentsBinding) throw new Error('NEAR Intents transaction binding is missing')
        const review = await options.solana.prepareTransfer(
          {
            assetId: input.source.asset.asset.id,
            recipient: input.depositAddress,
            amountRaw
          },
          { nearIntentsBinding }
        )
        return Object.freeze({ family: 'solana' as const, source: input.source, review })
      }
      if (input.source.family === 'near') {
        if (!nearIntentsBinding && !input.nearLendingSupplyBinding) {
          throw new Error('NEAR transfer protocol binding is missing')
        }
        const review = await options.near.prepareTransfer(
          {
            assetId: input.source.asset.asset.id,
            recipient: input.depositAddress,
            amountRaw
          },
          {
            ...(nearIntentsBinding === undefined ? {} : { nearIntentsBinding }),
            ...(input.nearLendingSupplyBinding === undefined
              ? {}
              : { nearLendingSupplyBinding: input.nearLendingSupplyBinding })
          }
        )
        return Object.freeze({ family: 'near' as const, source: input.source, review })
      }
      const review = await options.bitcoin.prepareTransfer(
        {
          recipient: input.depositAddress,
          amount: Object.freeze({ mode: 'exact' as const, valueSats: amountRaw })
        },
        {
          nearIntentsBinding: input.nearIntentsBinding,
          rheaSwapBinding: input.rheaSwapBinding,
          bitcoinAddressType: input.source.bitcoinAddressType,
          ...(input.feeTier === undefined ? {} : { feeTier: input.feeTier })
        }
      )
      return Object.freeze({ family: 'bitcoin' as const, source: input.source, review })
    },
    approve: async prepared => {
      const transactionId = prepared.review.graph.root.id
      const fingerprint = prepared.review.review.payloadFingerprint.digestHex
      if (prepared.family === 'evm') {
        const value = await options.evm.approveTransfer(transactionId, fingerprint)
        return Object.freeze({ family: 'evm' as const, value })
      }
      if (prepared.family === 'solana') {
        const value = await options.solana.approveTransfer(transactionId, fingerprint)
        return Object.freeze({ family: 'solana' as const, value })
      }
      if (prepared.family === 'near') {
        const value = await options.near.approveTransfer(transactionId, fingerprint)
        return Object.freeze({ family: 'near' as const, value })
      }
      const value = await options.bitcoin.approveTransfer(transactionId, fingerprint)
      return Object.freeze({ family: 'bitcoin' as const, value })
    },
    reject: prepared => {
      const transactionId = prepared.review.graph.root.id
      if (prepared.family === 'evm') return options.evm.rejectTransfer(transactionId)
      if (prepared.family === 'bitcoin') return options.bitcoin.rejectTransfer(transactionId)
      if (prepared.family === 'solana') return options.solana.rejectTransfer(transactionId)
      return options.near.rejectTransfer(transactionId)
    }
  }
  return Object.freeze(client)
}

export const quoteDepositTransferClient = createQuoteDepositTransferClient({
  evm: evmWalletClient,
  bitcoin: bitcoinWalletClient,
  solana: solanaWalletClient,
  near: nearWalletClient
})
