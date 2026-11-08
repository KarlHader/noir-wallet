import type { PortfolioReadModel } from '@/core/portfolio'
import type { RheaSwapToken } from '@/core/services/rhea-swap'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import {
  resolveWalletOwnedQuoteAsset,
  resolveWalletSwapSourceToken,
  selectWalletOwnedQuoteAssetExecution
} from '@/popup/services/quote-deposit-transfer-client'
import type { AdditionalReceiveTargetsView } from '@/popup/services/receive-targets-client'
import {
  buildLiveSwapQuoteRequest,
  isConfidentialSwapDestinationSupported
} from '@/popup/services/swap-page-model'

export function resolvePublicPrivateSendQuotePair(input: {
  readonly assetId: string
  readonly chainId: string
  readonly sender: string
  readonly portfolio: PortfolioReadModel
  readonly receiveTargets: AdditionalReceiveTargetsView
  readonly sourceTokens: readonly RheaSwapToken[]
  readonly destinationTokens: readonly RheaSwapToken[]
}): Readonly<{
  sourceToken: RheaSwapToken
  destinationToken: RheaSwapToken
}> | null {
  const requested = resolveWalletSwapSourceToken(
    input.assetId,
    input.sourceTokens,
    input.portfolio,
    input.receiveTargets
  )
  const sourceToken = input.sourceTokens.find(
    token => token.assetId === requested?.assetId && token.blockchain === requested.blockchain
  )
  if (!sourceToken) return null
  const source = resolveWalletOwnedQuoteAsset(sourceToken, input.portfolio, input.receiveTargets)
  const publicSource = source
    ? selectWalletOwnedQuoteAssetExecution(source, 'main', undefined, true)
    : null
  if (
    publicSource?.family !== 'evm' ||
    publicSource.asset.asset.id !== input.assetId ||
    publicSource.chain.chain.id !== input.chainId ||
    publicSource.refundAddress.toLowerCase() !== input.sender.toLowerCase()
  ) {
    return null
  }
  const destinationToken = input.destinationTokens.find(
    token =>
      token.assetId === sourceToken.assetId &&
      token.blockchain === sourceToken.blockchain &&
      token.rheaChainId === sourceToken.rheaChainId &&
      token.rheaAddress === sourceToken.rheaAddress &&
      token.decimals === sourceToken.decimals &&
      isConfidentialSwapDestinationSupported(token)
  )
  return destinationToken ? Object.freeze({ sourceToken, destinationToken }) : null
}

export interface PublicPrivateSendPreviewIdentity {
  readonly network: 'mainnet' | 'testnet'
  readonly walletId: string
  readonly accountId: string
  readonly endpointKey: string
  readonly portfolioWalletId: string
  readonly portfolioAccountId: string
  readonly assetId: string
  readonly assetReference: string
  readonly assetDecimals: number
  readonly chainId: string
  readonly sender: string
  readonly recipient: string
  readonly amountRaw: string
  readonly slippage: number
  readonly feeSelectionKey: string
}

export function createPublicPrivateSendPreviewKey(
  input: PublicPrivateSendPreviewIdentity
): string | null {
  if (
    input.network !== 'mainnet' ||
    !input.walletId ||
    !input.accountId ||
    input.portfolioWalletId !== input.walletId ||
    input.portfolioAccountId !== input.accountId ||
    !input.assetId ||
    !input.assetReference ||
    !input.chainId ||
    !input.sender ||
    !/^0x[0-9a-fA-F]{40}$/.test(input.recipient) ||
    !/^[1-9]\d*$/.test(input.amountRaw) ||
    !Number.isInteger(input.assetDecimals) ||
    input.assetDecimals < 0 ||
    !Number.isFinite(input.slippage)
  ) {
    return null
  }
  return JSON.stringify([
    input.network,
    input.walletId,
    input.accountId,
    input.endpointKey,
    input.assetId,
    input.assetReference,
    input.assetDecimals,
    input.chainId,
    input.sender.toLowerCase(),
    input.recipient,
    input.amountRaw,
    input.slippage,
    input.feeSelectionKey
  ])
}

export function buildPublicPrivateSendPreviewRequest(
  input: PublicPrivateSendPreviewIdentity & {
    readonly amount: string
    readonly sourceToken: RheaSwapToken
    readonly destinationToken: RheaSwapToken
  }
) {
  if (
    input.network !== 'mainnet' ||
    !input.walletId ||
    !input.accountId ||
    input.sourceToken.assetId !== input.destinationToken.assetId ||
    input.sourceToken.rheaChainId !== input.destinationToken.rheaChainId ||
    input.sourceToken.rheaAddress !== input.destinationToken.rheaAddress ||
    input.sourceToken.decimals !== input.destinationToken.decimals ||
    !isConfidentialSwapDestinationSupported(input.destinationToken)
  ) {
    return null
  }
  const quote = buildLiveSwapQuoteRequest({
    tokenIn: input.sourceToken,
    tokenOut: input.destinationToken,
    amountIn: input.amount,
    slippage: input.slippage,
    refundAddress: input.sender,
    recipientAddress: input.recipient,
    confidentiality: 'basic',
    blocked: false
  })
  const key = createPublicPrivateSendPreviewKey(input)
  if (!quote || !key || quote.amount !== input.amountRaw) return null
  return Object.freeze({
    key,
    amountRaw: quote.amount,
    request: quote.request
  })
}

export function getPublicPrivateSendRouteCost(input: {
  readonly amountInRaw: string
  readonly estimatedOutRaw: string
  readonly decimals: number
}): string | null {
  if (!/^\d+$/.test(input.amountInRaw) || !/^\d+$/.test(input.estimatedOutRaw)) return null
  const difference = BigInt(input.amountInRaw) - BigInt(input.estimatedOutRaw)
  if (difference < 0n) return null
  return formatBaseUnitDecimalAmount(difference.toString(), input.decimals)
}
