import type { PortfolioReadModel } from '@/core/portfolio'
import { decodeFunctionData, parseAbi } from 'viem'
import { parseZcashAddress } from '@/core/address-book/address-book'
import { isZecToken, type SwapToken } from '@/core/services/intents-api'
import { getEvmNetworkConfigs } from '@/config/networks'
import { resolveIntentsEvmAssets } from '@/core/services/intents-evm-assets'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import {
  RHEA_SWAP_CHAIN_CATALOG,
  type RheaSwapQuoteView,
  type RheaSwapQuoteRequest,
  type RheaSwapReviewView,
  type RheaSwapToken
} from '@/core/services/rhea-swap'
import { createInitialProductChainRegistry } from '@/core/chains/registry'
import { safeBig } from '@/lib/big'
import {
  parseAmount,
  formatBaseUnitAmount,
  formatBaseUnitDecimalAmount,
  parseDisplayUnitAmount
} from '@/lib/number-format'

import {
  resolveWalletOwnedQuoteAsset,
  resolveWalletQuoteReceiveTarget,
  type PreparedQuoteDepositTransfer,
  type WalletOwnedQuoteAsset
} from '@/popup/services/quote-deposit-transfer-client'
import type { AdditionalReceiveTargetsView } from '@/popup/services/receive-targets-client'
import type { FundingSource, Network } from '@/types'
import type { ShieldSwapZecSourceKind } from '@/popup/services/shield-swap-zec-sources'
import { isRheaSwapQuoteFresh } from '@/core/services/rhea-swap/rhea-swap-quote-validity'
import { resolveAccountAvailableRaw } from '@/popup/services/transfer-availability'
import {
  filterCrossChainSendDestinations,
  type CrossChainSendCapabilities
} from '@/popup/services/cross-chain-send-assets'

const ERC20_TRANSFER_ABI = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)'
])

export function resolveSwapRecipientChainId(
  token: RheaSwapToken | null,
  network: Network
): string | null {
  if (!token) return null
  const descriptor = RHEA_SWAP_CHAIN_CATALOG.find(chain => chain.apiChainId === token.rheaChainId)
  if (!descriptor) return null
  if (/^\d+$/.test(descriptor.apiChainId)) return `eip155:${descriptor.apiChainId}`
  return (
    createInitialProductChainRegistry(network)
      .list()
      .find(chain => chain.family === descriptor.walletFamily)?.id ?? null
  )
}

export function resolveManagedSwapRecipient(input: {
  readonly address: string
  readonly zcashAddresses?: Readonly<{ shielded: string; transparent: string }>
  readonly walletAddress?: string
  readonly privateAddress?: string
  readonly isEvm: boolean
}): 'shielded' | 'transparent' | 'main' | 'private' | null {
  if (!input.address) return null
  if (input.zcashAddresses) {
    if (input.address === input.zcashAddresses.shielded) return 'shielded'
    if (input.address === input.zcashAddresses.transparent) return 'transparent'
    return null
  }
  const matches = (candidate: string | undefined) =>
    candidate &&
    (input.isEvm
      ? candidate.toLowerCase() === input.address.toLowerCase()
      : candidate === input.address)
  if (matches(input.walletAddress)) return 'main'
  if (input.isEvm && matches(input.privateAddress)) return 'private'
  return null
}

export function resolveSwapRefreshChainId(
  token: RheaSwapToken | null,
  receiveTargets: AdditionalReceiveTargetsView | null
): string | undefined {
  if (!token || isZecToken(token)) return undefined
  return receiveTargets?.targets.find(target =>
    target.kind === 'evm'
      ? target.chain.id === `eip155:${token.rheaChainId}`
      : target.kind === token.rheaChainId ||
        (target.kind === 'bitcoin' && token.rheaChainId === 'btc')
  )?.chain.id
}

export {
  getRheaSwapQuoteDeadline,
  isRheaSwapQuoteFresh
} from '@/core/services/rhea-swap/rhea-swap-quote-validity'

export function hasSwapQuoteTermsChanged(
  previous: RheaSwapQuoteView,
  next: RheaSwapQuoteView
): boolean {
  return (
    previous.estimatedOut !== next.estimatedOut ||
    previous.minAmountOut !== next.minAmountOut ||
    previous.router !== next.router ||
    previous.recipient !== next.recipient
  )
}

export function isAcceptedSwapReview(input: {
  readonly quote: RheaSwapQuoteView | null
  readonly review: RheaSwapReviewView | null
  readonly acceptedHandle: string | null
  readonly quoteKey: string | null
  readonly requestKey: string | null | undefined
  readonly now?: number
}): boolean {
  const { quote, review, acceptedHandle, quoteKey, requestKey } = input
  return Boolean(
    quote &&
    review &&
    acceptedHandle === quote.quoteHandle &&
    review.quoteHandle === quote.quoteHandle &&
    quoteKey &&
    quoteKey === requestKey &&
    isRheaSwapQuoteFresh(quote, input.now)
  )
}

export function resolveShieldDomainZecFundingSource(input: {
  readonly ordinarySwapRequested: boolean
  readonly shieldZecSource: ShieldSwapZecSourceKind | null
  readonly isZecSource: boolean
  readonly selectedFundingSource: FundingSource
  readonly publicPrivacySendRequested?: boolean
}): FundingSource {
  if (input.publicPrivacySendRequested && input.isZecSource) return 'transparent'
  if (
    input.ordinarySwapRequested &&
    input.shieldZecSource === 'native-shielded' &&
    input.isZecSource
  ) {
    return 'shielded'
  }
  if (input.ordinarySwapRequested && input.isZecSource) return 'transparent'
  return input.selectedFundingSource
}

export function shieldConfidentialSwapActive(input: {
  readonly shieldSwapSelected: boolean
  readonly shieldZecSource: ShieldSwapZecSourceKind | null
}): boolean {
  return input.shieldSwapSelected && input.shieldZecSource !== 'native-shielded'
}

export function resolveSwapReviewAction(input: {
  readonly isZecSource: boolean
  readonly hasDepositAddress: boolean
  readonly hasSigningReview: boolean
  readonly hasPreparedTransfer: boolean
}): 'zcash-transfer' | 'wallet-signing' | 'wallet-transfer' | 'unavailable' {
  if (input.hasSigningReview) return 'wallet-signing'
  if (input.isZecSource) return input.hasDepositAddress ? 'zcash-transfer' : 'unavailable'
  if (input.hasPreparedTransfer) return 'wallet-transfer'
  return 'unavailable'
}

export function resolveSwapSourceExecutionTarget(input: {
  readonly review: RheaSwapReviewView
  readonly prepared: PreparedQuoteDepositTransfer | null
  readonly tokenIn: SwapToken
  readonly approvalPending: boolean
}): { readonly label: 'Deposit address' | 'Contract'; readonly address: string } | null {
  const { review, prepared, tokenIn, approvalPending } = input
  if (!prepared || approvalPending || !review.execution.target) return null
  if (prepared.family === 'bitcoin' && review.execution.kind === 'bitcoin-transfer') {
    return { label: 'Deposit address', address: review.execution.target }
  }
  if (prepared.family !== 'evm' || review.execution.kind !== 'evm-transaction') return null
  const summary = prepared.review.review.summary
  if (summary.schema !== 'evm.transaction.v1') return null
  const target = summary.fields.to
  if (!target || target.toLowerCase() !== review.execution.target.toLowerCase()) return null
  if (summary.fields.calldata.byteLength === 0 && summary.fields.valueWei === review.amountIn) {
    return { label: 'Deposit address', address: target }
  }
  if (tokenIn.contractAddress?.toLowerCase() === target.toLowerCase()) {
    const calldata = summary.fields.calldata
    if (
      summary.fields.valueWei === '0' &&
      calldata.encoding === 'hex' &&
      calldata.byteLength === 68 &&
      /^0xa9059cbb[0-9a-fA-F]{128}$/.test(calldata.value)
    ) {
      try {
        const transfer = decodeFunctionData({
          abi: ERC20_TRANSFER_ABI,
          data: calldata.value as `0x${string}`
        })
        if (transfer.args[1].toString() === review.amountIn) {
          return { label: 'Deposit address', address: transfer.args[0] }
        }
      } catch {
        // Keep the verified contract target when calldata cannot be decoded.
      }
    }
    return { label: 'Contract', address: target }
  }
  return null
}

export function resolveSwapStatusPollingProvider(input: {
  readonly depositAddress?: string
  readonly rheaQuoteHandle?: string
}): 'near-intents' | 'rhea-swap' | null {
  if (input.rheaQuoteHandle) return 'rhea-swap'
  return input.depositAddress ? 'near-intents' : null
}

export function getPreparedSwapNetworkFee(
  prepared: PreparedQuoteDepositTransfer | null
): { readonly amount: string; readonly symbol: string } | null {
  if (!prepared) return null
  const summary = prepared.review.review.summary
  if (prepared.family === 'evm' && summary.schema === 'evm.transaction.v1') {
    return Object.freeze({
      amount: formatBaseUnitAmount(
        summary.fields.maximumFeeWei,
        prepared.source.networkFeeAsset.metadata.decimals
      ),
      symbol: prepared.source.networkFeeAsset.metadata.symbol
    })
  }
  if (prepared.family === 'bitcoin' && summary.schema === 'bitcoin.psbt.v1') {
    return Object.freeze({
      amount: formatBaseUnitAmount(
        summary.fields.feeSats,
        prepared.source.networkFeeAsset.metadata.decimals
      ),
      symbol: prepared.source.networkFeeAsset.metadata.symbol
    })
  }
  if (prepared.family === 'solana' || prepared.family === 'near') {
    const amountRaw = prepared.review.graph.root.intent?.feeLimit?.amountRaw
    if (amountRaw === undefined) return null
    return Object.freeze({
      amount: formatBaseUnitAmount(amountRaw, prepared.source.networkFeeAsset.metadata.decimals),
      symbol: prepared.source.networkFeeAsset.metadata.symbol
    })
  }
  return null
}

export function isPreparedSwapFeeUnaffordable(
  prepared: PreparedQuoteDepositTransfer | null
): boolean {
  if (prepared?.family !== 'evm') return false
  const summary = prepared.review.review.summary
  if (summary.schema !== 'evm.transaction.v1') return false
  const requiredRaw = BigInt(summary.fields.valueWei) + BigInt(summary.fields.maximumFeeWei)
  return requiredRaw > BigInt(prepared.source.networkFeeAsset.balance.availableRaw)
}

function formatSwapTokenPortfolioBalance(
  token: RheaSwapToken,
  portfolio: PortfolioReadModel,
  receiveTargets: AdditionalReceiveTargetsView | null,
  evmExecutionMode: 'main' | 'private'
): string | undefined {
  const owned = receiveTargets && resolveWalletOwnedQuoteAsset(token, portfolio, receiveTargets)
  if (owned) {
    const availableRaw = resolveWalletSwapSourceAvailableRaw(owned, evmExecutionMode)
    if (availableRaw === undefined) return undefined
    return formatBaseUnitDecimalAmount(availableRaw, owned.asset.metadata.decimals)
  }
  const evm = resolveIntentsEvmAssets([token], getEvmNetworkConfigs(DEFAULT_NETWORK))[0]
  if (!evm) return undefined
  const asset = portfolio.assets.find(candidate => candidate.asset.id === evm.assetId)
  if (!asset || asset.metadata.decimals !== token.decimals) return undefined
  if (
    evmExecutionMode === 'private' &&
    asset.balance.privateOnchainRaw === undefined &&
    asset.balance.privateRaw === undefined
  )
    return undefined
  const availableRaw = resolveAccountAvailableRaw(asset.balance, evmExecutionMode)
  return formatBaseUnitDecimalAmount(availableRaw, asset.metadata.decimals)
}

export function buildWalletSwapSourceBalances(input: {
  readonly tokens: readonly RheaSwapToken[]
  readonly portfolio: PortfolioReadModel | null
  readonly receiveTargets: AdditionalReceiveTargetsView | null
  readonly zcashAvailable: string
  readonly evmExecutionMode: 'main' | 'private'
}): ReadonlyMap<string, string> {
  const balances = new Map<string, string>()
  for (const token of input.tokens) {
    if (isZecToken(token)) {
      balances.set(token.assetId, input.zcashAvailable)
      continue
    }
    if (!input.portfolio) continue
    const formatted = formatSwapTokenPortfolioBalance(
      token,
      input.portfolio,
      input.receiveTargets,
      input.evmExecutionMode
    )
    if (formatted !== undefined) balances.set(token.assetId, formatted)
  }
  return balances
}

export function resolveWalletSwapSourceAvailableRaw(
  source: WalletOwnedQuoteAsset,
  evmExecutionMode: 'main' | 'private'
): string | undefined {
  if (source.family !== 'evm') return source.asset.balance.availableRaw
  if (
    evmExecutionMode === 'private' &&
    source.asset.balance.privateOnchainRaw === undefined &&
    source.asset.balance.privateRaw === undefined
  )
    return undefined
  return resolveAccountAvailableRaw(source.asset.balance, evmExecutionMode)
}

export function resolveSwapSelectorBalanceMode(input: {
  readonly purpose: 'in' | 'out'
  readonly sourceMode: 'main' | 'private'
  readonly destinationMode: 'main' | 'private'
  readonly isPrivateFunding: boolean
  readonly externalRecipient: boolean
}): 'main' | 'private' | null {
  if (input.purpose === 'in') return input.isPrivateFunding ? 'main' : input.sourceMode
  if (input.externalRecipient) return null
  return input.isPrivateFunding ? 'private' : input.destinationMode
}

export function isSwapSourceAmountInsufficient(input: {
  readonly isZecSource: boolean
  readonly amount: string
  readonly amountRaw: string | null
  readonly sourceAvailableRaw: string | null
  readonly sourceSelected: boolean
  readonly zcashAvailable: string
}): boolean {
  if (input.isZecSource) return safeBig(input.amount || '0').gt(input.zcashAvailable)
  if (input.sourceAvailableRaw === null)
    return input.sourceSelected && safeBig(input.amount || '0').gt(0)
  return input.amountRaw !== null && BigInt(input.amountRaw) > BigInt(input.sourceAvailableRaw)
}

export function resolveSwapExecutionSourceMode(input: {
  readonly requestedMode: 'main' | 'private'
  readonly isPrivateFunding: boolean
  readonly sourceFamily: WalletOwnedQuoteAsset['family'] | null
  readonly privateSourceAvailable: boolean
}): 'main' | 'private' {
  if (input.isPrivateFunding) return 'main'
  return input.requestedMode === 'private' &&
    input.sourceFamily === 'evm' &&
    input.privateSourceAvailable
    ? 'private'
    : 'main'
}

export function filterConfidentialFundingSourceTokens(
  tokens: readonly RheaSwapToken[],
  portfolio: PortfolioReadModel | null,
  receiveTargets: AdditionalReceiveTargetsView | null
): readonly RheaSwapToken[] {
  if (!portfolio || !receiveTargets) return []
  return tokens.filter(token => {
    if (isZecToken(token)) return false
    return resolveWalletOwnedQuoteAsset(token, portfolio, receiveTargets)?.family === 'evm'
  })
}

export function isConfidentialSwapDestinationSupported(token: RheaSwapToken): boolean {
  return (
    token.sources?.some(source =>
      ['nearintents', 'preswap-nearintents'].includes(source.toLowerCase())
    ) ?? false
  )
}

export function filterSwapDestinationTokens(
  tokens: readonly RheaSwapToken[],
  confidentiality: 'basic' | undefined
): readonly RheaSwapToken[] {
  return confidentiality === 'basic'
    ? tokens.filter(isConfidentialSwapDestinationSupported)
    : tokens
}

export function isPrivateSwapDestinationSupported(
  token: RheaSwapToken,
  portfolio: PortfolioReadModel | null,
  receiveTargets: AdditionalReceiveTargetsView | null,
  privateExecutionAddresses: ReadonlyMap<string, string>,
  mode: 'main' | 'private' = 'private',
  zcashAddresses?: Readonly<{ shielded: string; transparent: string }>
): boolean {
  if (!portfolio || !isConfidentialSwapDestinationSupported(token)) return false
  if (isZecToken(token)) return Boolean(zcashAddresses?.shielded && zcashAddresses.transparent)
  const target = resolveWalletQuoteReceiveTarget(token, portfolio, receiveTargets)
  if (target?.kind !== 'evm') return false
  if (mode === 'main') return /^0x[0-9a-fA-F]{40}$/.test(target.address)
  const privateAddress = privateExecutionAddresses.get(target.chain.id)
  return Boolean(
    privateAddress &&
    /^0x[0-9a-fA-F]{40}$/.test(privateAddress) &&
    privateAddress.toLowerCase() !== target.address.toLowerCase()
  )
}

export function filterSelectableSwapDestinationTokens(input: {
  readonly tokens: readonly RheaSwapToken[]
  readonly confidentiality: 'basic' | undefined
  readonly crossChainSendRequested: boolean
  readonly sourceToken: RheaSwapToken | null
  readonly capabilities: CrossChainSendCapabilities
}): readonly RheaSwapToken[] {
  const available = filterSwapDestinationTokens(input.tokens, input.confidentiality)
  return input.crossChainSendRequested
    ? filterCrossChainSendDestinations(input.sourceToken, available, input.capabilities)
    : available
}

export function isValidSwapZcashRecipient(address: string, network: Network): boolean {
  try {
    parseZcashAddress(address, network)
    return true
  } catch {
    return false
  }
}

export function resolveScopedSwapZcashRecipient(
  selection: Readonly<{ scope: string | null; address: string }>,
  activeScope: string | null,
  network: Network
): Readonly<{ address: string; error: string | null }> {
  const address = activeScope && selection.scope === activeScope ? selection.address : ''
  return Object.freeze({
    address,
    error:
      address && !isValidSwapZcashRecipient(address, network)
        ? 'Enter a valid Zcash address.'
        : null
  })
}

export function resolveLockedWalletSwapSourceToken(input: {
  readonly requestedToken: RheaSwapToken | null
  readonly sourceTokens: readonly RheaSwapToken[]
  readonly walletSourceTokens: readonly RheaSwapToken[]
}): RheaSwapToken | null {
  if (!input.requestedToken) return null
  const walletSourceIds = new Set(input.walletSourceTokens.map(token => token.assetId))
  return (
    input.sourceTokens.find(
      token =>
        walletSourceIds.has(token.assetId) &&
        token.assetId === input.requestedToken?.assetId &&
        token.rheaChainId === input.requestedToken.rheaChainId &&
        token.rheaAddress === input.requestedToken.rheaAddress
    ) ?? null
  )
}

export function resolveConfidentialFundingDestinationToken(input: {
  readonly tokens: readonly RheaSwapToken[]
  readonly destinationChain: string | null
  readonly destinationAsset: string | null
  readonly portfolio: PortfolioReadModel | null
  readonly receiveTargets: AdditionalReceiveTargetsView | null
}): RheaSwapToken | null {
  const { portfolio } = input
  if (!portfolio) return null
  return (
    input.tokens.find(token => {
      if (String(token.rheaChainId) !== input.destinationChain) return false
      if (!isConfidentialSwapDestinationSupported(token)) return false
      const destination = resolveWalletOwnedQuoteAsset(token, portfolio, input.receiveTargets)
      if (destination?.family !== 'evm') return false
      return input.destinationAsset
        ? token.assetId === input.destinationAsset ||
            destination.asset.asset.id === input.destinationAsset
        : token.isNative
    }) ?? null
  )
}

export function resolvePreferredSwapSourceAssetId(
  tokens: readonly RheaSwapToken[],
  portfolio: PortfolioReadModel | null,
  receiveTargets: AdditionalReceiveTargetsView | null,
  preferFiatBalance = false
): string | undefined {
  const zcash = tokens.find(isZecToken)
  if (!preferFiatBalance && zcash) return zcash.assetId
  const walletOwnedSources = tokens.map(token => ({
    token,
    source:
      portfolio && receiveTargets
        ? resolveWalletOwnedQuoteAsset(token, portfolio, receiveTargets)
        : null
  }))
  const now = Date.now()
  const valued = preferFiatBalance
    ? walletOwnedSources
        .map(({ token, source }) => {
          const price = Number(token.price)
          const updatedAt = token.priceUpdatedAt ? Date.parse(token.priceUpdatedAt) : NaN
          const balance = source
            ? Number(
                formatBaseUnitDecimalAmount(
                  resolveAccountAvailableRaw(source.asset.balance, 'private'),
                  source.asset.metadata.decimals
                )
              )
            : 0
          return {
            token,
            value:
              Number.isFinite(price) &&
              price > 0 &&
              Number.isFinite(updatedAt) &&
              updatedAt <= now &&
              now - updatedAt <= 86_400_000 &&
              Number.isFinite(balance) &&
              balance > 0
                ? price * balance
                : 0
          }
        })
        .sort((left, right) => right.value - left.value)
    : []
  if (valued[0]?.value > 0) return valued[0].token.assetId
  return (
    walletOwnedSources.find(candidate => candidate.source?.asset.asset.kind === 'native')?.token
      .assetId ?? tokens[0]?.assetId
  )
}

export function buildLiveSwapQuoteRequest(input: {
  readonly tokenIn: RheaSwapToken | null
  readonly tokenOut: RheaSwapToken | null
  readonly amountIn: string
  readonly slippage: number
  readonly quoteMode?: RheaSwapQuoteRequest['quoteMode']
  readonly refundAddress: string
  readonly recipientAddress: string
  readonly privateRecipientAddress?: string
  readonly confidentiality?: 'basic'
  readonly zcashFundingSource?: 'transparent' | 'shielded'
  readonly blocked: boolean
}): Readonly<{
  key: string
  scopeKey: string
  amount: string
  slippageTolerance: number
  confidentiality?: 'basic'
  request: RheaSwapQuoteRequest
}> | null {
  if (
    !input.tokenIn ||
    !input.tokenOut ||
    !input.amountIn ||
    safeBig(input.amountIn).lte(0) ||
    !input.refundAddress ||
    !input.recipientAddress ||
    (input.privateRecipientAddress !== undefined &&
      input.recipientAddress.toLowerCase() !== input.privateRecipientAddress.toLowerCase()) ||
    input.blocked
  ) {
    return null
  }
  try {
    const amount = parseDisplayUnitAmount(input.amountIn, input.tokenIn.decimals)
    if (BigInt(amount) <= 0n) return null
    const slippageTolerance = Math.round(input.slippage * 100)
    const request: RheaSwapQuoteRequest = {
      fromChain: input.tokenIn.rheaChainId,
      toChain: input.tokenOut.rheaChainId,
      tokenIn: {
        chain: input.tokenIn.rheaChainId,
        address: input.tokenIn.rheaAddress,
        symbol: input.tokenIn.symbol,
        decimals: input.tokenIn.decimals,
        isNative: input.tokenIn.isNative
      },
      tokenOut: {
        chain: input.tokenOut.rheaChainId,
        address: input.tokenOut.rheaAddress,
        symbol: input.tokenOut.symbol,
        decimals: input.tokenOut.decimals,
        isNative: input.tokenOut.isNative
      },
      amountIn: amount,
      slippageBps: slippageTolerance,
      quoteMode: input.quoteMode ?? 'best-price',
      sender: input.refundAddress,
      recipient: input.recipientAddress,
      ...(input.confidentiality === undefined ? {} : { confidentiality: input.confidentiality })
    }
    return Object.freeze({
      scopeKey: JSON.stringify([
        input.tokenIn.assetId,
        input.tokenOut.assetId,
        input.zcashFundingSource ?? null,
        { ...request, amountIn: undefined }
      ]),
      key: JSON.stringify([
        input.tokenIn.assetId,
        input.tokenOut.assetId,
        input.zcashFundingSource ?? null,
        request
      ]),
      amount,
      slippageTolerance,
      request,
      ...(input.confidentiality === undefined ? {} : { confidentiality: input.confidentiality })
    })
  } catch {
    return null
  }
}

export interface SwapQuoteRefreshTarget {
  readonly scopeKey: string
  readonly amount: string
}

export function createSwapQuoteRefreshTarget(
  request: ReturnType<typeof buildLiveSwapQuoteRequest>,
  amount?: { readonly decimal: string; readonly decimals: number }
): SwapQuoteRefreshTarget | null {
  if (!request) return null
  return {
    scopeKey: request.scopeKey,
    amount: amount ? parseAmount(amount.decimal, amount.decimals) : request.amount
  }
}

export function isSwapQuoteRefreshReady(
  target: SwapQuoteRefreshTarget | null,
  request: ReturnType<typeof buildLiveSwapQuoteRequest>,
  receivedQuoteKey: string | null
): boolean {
  return (
    target !== null &&
    request !== null &&
    request.key === receivedQuoteKey &&
    target.scopeKey === request.scopeKey &&
    target.amount === request.amount
  )
}

/** Skip auto-focus when the user is already editing another text control. */
export function shouldDeferSwapAmountFocus(activeElement: Element | null): boolean {
  if (!activeElement || activeElement === document.body) return false
  const tag = activeElement.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return activeElement.getAttribute('contenteditable') === 'true'
}
