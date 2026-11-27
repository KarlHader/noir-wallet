import bs58check from 'bs58check'
import { encodeFunctionData, erc20Abi, isAddress, type Address } from 'viem'
import {
  isNoirPublicConfidentialTransferReferral,
  NOIR_SWAP_REFERRAL,
  ZEC_ZCASH_ASSET
} from '@/config/intents'
import { parseZcashAddress } from '@/core/address-book/address-book'
import { getEvmRouteAssetIdentity } from '@/core/chains/cross-chain-asset-group'
import { fetchSwapTokens, type SwapToken } from '@/core/services/intents-api'
import { isDeprecatedIntentsToken } from '@/core/services/intents-evm-assets'
import { confidentialQuoteAppFeeBps } from '@/core/services/confidential-funding'
import type { OneClickOrder, OneClickViewer } from '@/core/services/near-intents/one-click-order'
import { isEvmNativeQuoteAddress, resolveRheaSwapCanonicalAssetId } from '@/core/services/rhea-swap'
import type { PublicConfidentialBuildScope } from '@/core/services/rhea-swap/rhea-swap-catalog-client'
import {
  getRheaSwapTokenRouteAddress,
  isPrivateWithdrawPurpose,
  publicConfidentialRefundViewer,
  RHEA_SWAP_CHAIN_CATALOG
} from '@/core/services/rhea-swap/rhea-swap-model'
import { ONE_CLICK_CONFIDENTIAL_BRIDGE } from '@/core/services/rhea-swap/rhea-swap-protocol'
import type {
  AssetRef,
  Quote,
  QuoteRequest,
  SwapBuildDataRaw,
  SwapQuoteDataRaw
} from '@/core/services/rhea-swap/rhea-swap-protocol'
import {
  parseConfidentialOneClickStatus,
  type ConfidentialFundingApi
} from './confidential-funding-api'
import type { queryOneClickOrderStatus, resolveZcashOneClickViewer } from './one-click-status'

const ROUTER = 'nearintents'
export type ResolvePrivateWithdrawRefundAddress = (
  scope: Pick<PublicConfidentialBuildScope, 'walletId' | 'accountId'>
) => Promise<string>

function resolveAsset(asset: AssetRef, tokens: readonly SwapToken[]): SwapToken {
  const evm = /^[1-9]\d*$/.test(asset.chain)
  const identity = evm
    ? getEvmRouteAssetIdentity(
        `eip155:${asset.chain}`,
        asset.address,
        isEvmNativeQuoteAddress(asset.chain, asset.address)
      )
    : null
  const canonicalId = identity && `${identity.chainId}/${identity.namespace}:${identity.reference}`
  const blockchain = RHEA_SWAP_CHAIN_CATALOG.find(
    chain => chain.apiChainId === asset.chain
  )?.blockchain
  const matches = tokens.filter(token => {
    if (
      isDeprecatedIntentsToken(token) ||
      (asset.decimals !== undefined && token.decimals !== asset.decimals)
    )
      return false
    if (asset.chain === 'zcash') return token.assetId === ZEC_ZCASH_ASSET && asset.address === 'zec'
    if (evm)
      return canonicalId !== null && resolveRheaSwapCanonicalAssetId(token.assetId) === canonicalId
    return (
      token.blockchain === blockchain &&
      (asset.address === token.assetId ||
        asset.address === token.contractAddress ||
        (!token.contractAddress &&
          asset.address ===
            getRheaSwapTokenRouteAddress({
              rheaChainId: asset.chain,
              rheaAddress: token.assetId,
              isNative: true
            })))
    )
  })
  if (matches.length !== 1) throw new Error('Confidential transfer asset is unavailable')
  return matches[0]!
}

export class PublicConfidentialTransfer {
  constructor(
    private readonly api: Pick<ConfidentialFundingApi, 'quote'>,
    private readonly queryStatus: typeof queryOneClickOrderStatus,
    private readonly getTokens: () => Promise<readonly SwapToken[]> = fetchSwapTokens,
    private readonly resolveZcashViewer?: typeof resolveZcashOneClickViewer,
    private readonly resolvePrivateWithdrawRefundAddress?: ResolvePrivateWithdrawRefundAddress
  ) {}

  async quote(
    request: QuoteRequest,
    signal?: AbortSignal,
    scope?: PublicConfidentialBuildScope
  ): Promise<SwapQuoteDataRaw> {
    const { origin, destination } = await this.resolveAssets(request, signal)
    const result = await this.requestQuote(
      request,
      origin.assetId,
      destination.assetId,
      { dry: true },
      scope,
      signal
    )
    return {
      bestQuote: {
        router: ROUTER,
        estimatedOut: result.quote.amountOut,
        minAmountOut: result.quote.minAmountOut,
        appFeeBps: confidentialQuoteAppFeeBps(result),
        expiresAt: Date.parse(result.quote.deadline),
        bridge: {
          provider: ONE_CLICK_CONFIDENTIAL_BRIDGE,
          originAsset: origin.assetId,
          destinationAsset: destination.assetId
        }
      }
    }
  }

  async build(
    quote: Quote,
    signal?: AbortSignal,
    scope?: PublicConfidentialBuildScope
  ): Promise<SwapBuildDataRaw> {
    const { request, bridge } = quote.buildContext
    const { origin, destination } = await this.resolveAssets(quote, signal)
    if (
      typeof bridge !== 'object' ||
      bridge === null ||
      !('originAsset' in bridge) ||
      bridge.originAsset !== origin.assetId ||
      !('destinationAsset' in bridge) ||
      bridge.destinationAsset !== destination.assetId
    ) {
      throw new Error('Confidential transfer assets changed. Get a new quote.')
    }
    const directViewer = isPrivateWithdrawPurpose(scope?.purpose)
      ? undefined
      : publicConfidentialRefundViewer(quote.fromChain, request.sender, scope?.purpose)
    const refundScheme =
      quote.fromChain === 'zcash' ? parseZcashAddress(request.sender, 'mainnet').scheme : undefined
    const viewer =
      directViewer ??
      (scope && (refundScheme === 'zcash-full-unified' || refundScheme === 'zcash-sapling')
        ? await this.resolveZcashViewer?.(
            { network: 'mainnet', walletId: scope.walletId, accountId: scope.accountId },
            request.sender,
            'shielded'
          )
        : undefined)
    const result = await this.requestQuote(
      {
        ...quote,
        sender: request.sender,
        recipient: request.recipient,
        confidentiality: request.confidentiality,
        slippageBps: request.slippage ?? 0,
        extensions: { referral: request.referral }
      },
      origin.assetId,
      destination.assetId,
      { dry: false, viewer: viewer ?? null },
      scope,
      signal
    )
    const { amountIn, amountOut, minAmountOut, depositAddress, depositMemo, timeEstimate } =
      result.quote
    if (depositMemo || !depositAddress)
      throw new Error('Unsupported confidential deposit instructions')
    const zcash = quote.fromChain === 'zcash'
    const tx = zcash
      ? this.zcashTransfer(depositAddress, amountIn)
      : this.evmTransfer(quote.tokenIn, depositAddress, amountIn, request.sender)
    return {
      router: ROUTER,
      chainType: zcash ? 'zcash' : 'evm',
      isCrossChain: quote.fromChain !== quote.toChain,
      fromChain: quote.fromChain,
      toChain: quote.toChain,
      tokenIn: { ...quote.tokenIn, symbol: origin.symbol, decimals: origin.decimals },
      tokenOut: { ...quote.tokenOut, symbol: destination.symbol, decimals: destination.decimals },
      amountIn,
      estimatedOut: amountOut,
      minAmountOut,
      deposit: {
        depositAddress,
        ...(result.oneClickOrder?.viewer ? { viewer: result.oneClickOrder.viewer } : {}),
        timeEstimate
      },
      tx
    }
  }

  async getStatus(
    order: OneClickOrder,
    scope: Readonly<{ walletId: string; accountId: string }>,
    signal?: AbortSignal
  ): Promise<Record<string, unknown> | null> {
    const value = await this.queryStatus({ network: 'mainnet', ...scope, order, signal })
    if (value === null) return null
    const result = parseConfidentialOneClickStatus(value, order.depositAddress, order.depositMemo)
    return { status: result.status, toHash: result.transactionHash }
  }

  private async resolveAssets(
    request: Pick<QuoteRequest, 'tokenIn' | 'tokenOut'>,
    signal?: AbortSignal
  ) {
    const tokens = await this.getTokens()
    signal?.throwIfAborted()
    return {
      origin: resolveAsset(request.tokenIn, tokens),
      destination: resolveAsset(request.tokenOut, tokens)
    }
  }

  private async requestQuote(
    request: QuoteRequest,
    originAsset: string,
    destinationAsset: string,
    ownership: { dry: true } | { dry: false; viewer: OneClickViewer | null },
    scope?: PublicConfidentialBuildScope,
    signal?: AbortSignal
  ) {
    const referral = request.extensions?.referral
    if (
      (!isNoirPublicConfidentialTransferReferral(referral) && referral !== NOIR_SWAP_REFERRAL) ||
      request.confidentiality !== 'basic' ||
      !request.recipient ||
      (!/^[1-9]\d*$/.test(request.fromChain) && request.fromChain !== 'zcash')
    ) {
      throw new Error('Confidential transfer route is invalid')
    }
    const binding = {
      referral,
      originAsset,
      destinationAsset,
      recipient: /^[1-9]\d*$/.test(request.toChain)
        ? request.recipient.toLowerCase()
        : request.recipient,
      amountRaw: request.amountIn,
      depositType: 'ORIGIN_CHAIN',
      recipientType: 'DESTINATION_CHAIN',
      slippageBps: request.slippageBps
    } as const
    if (scope && isPrivateWithdrawPurpose(scope.purpose)) {
      const refundAddress = await this.resolvePrivateWithdrawRefundAddress?.(scope)
      if (!refundAddress || refundAddress.toLowerCase() === request.sender.toLowerCase()) {
        throw new Error('Shield refund account is unavailable')
      }
      signal?.throwIfAborted()
      return this.api.quote(
        {
          ...binding,
          signerId: refundAddress.toLowerCase(),
          dry: ownership.dry,
          refundType: 'CONFIDENTIAL_INTENTS',
          settlement: 'private-withdrawal'
        },
        signal
      )
    }
    return this.api.quote(
      {
        ...binding,
        signerId: request.fromChain === 'zcash' ? request.sender : request.sender.toLowerCase(),
        refundType: 'ORIGIN_CHAIN',
        ...ownership,
        ...(referral === NOIR_SWAP_REFERRAL ? { settlement: 'onchain-transfer' as const } : {})
      },
      signal
    )
  }

  private zcashTransfer(depositAddress: string, amount: string) {
    if (
      !parseZcashAddress(depositAddress, 'mainnet').scheme.startsWith('zcash-transparent-') ||
      bs58check.decodeUnsafe(depositAddress)?.length !== 22
    ) {
      throw new Error('Invalid confidential Zcash deposit address')
    }
    return { kind: 'zcash_transfer', depositAddress, amount, decimals: 8 }
  }

  private evmTransfer(token: AssetRef, depositAddress: string, amount: string, sender: string) {
    if (
      !isAddress(depositAddress) ||
      /^0x0{40}$/i.test(depositAddress) ||
      BigInt(amount) >= 1n << 256n
    ) {
      throw new Error('Invalid confidential EVM deposit instructions')
    }
    const transaction = { chainId: Number(token.chain), from: sender }
    if (isEvmNativeQuoteAddress(token.chain, token.address)) {
      return { ...transaction, to: depositAddress, value: amount, data: '0x' }
    }
    return {
      ...transaction,
      to: token.address,
      value: '0',
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [depositAddress as Address, BigInt(amount)]
      })
    }
  }
}
