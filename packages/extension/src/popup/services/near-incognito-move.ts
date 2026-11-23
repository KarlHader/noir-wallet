import { getRheaSwapQuoteDeadline } from '@/core/services/rhea-swap/rhea-swap-quote-validity'
import { parseRheaSwapTransactionBinding } from '@/core/transactions/domain'
import {
  NEAR_DIRECT_RHEA_TOKEN_LIST_CHAIN_ID,
  NEAR_MOVE_DEPOSIT_ADDRESS,
  NEAR_MOVE_UNAVAILABLE,
  nearDirectCatalogToken,
  nearDirectQuoteAsset
} from '@/core/chains/near/near-incognito-move'
import { rheaSwapClient } from './rhea-swap-client'

export interface NearDirectMoveSigning {
  readonly quoteHandle: string
  readonly payloadFingerprint: string
}

/**
 * Same-chain RHEA quote. A private source is signed as pea-near-transaction by
 * the NEAR batch coordinator when the sender is the persisted PEA.
 */
export async function prepareNearDirectMove(input: {
  readonly chainId: string
  readonly assetId: string
  readonly asset: {
    readonly id: string
    readonly chainId: string
    readonly kind: string
    readonly reference?: string
  }
  readonly amountRaw: string
  readonly sender: string
  readonly recipient: string
  readonly executionMode: 'main' | 'private'
}): Promise<NearDirectMoveSigning> {
  const quoteAsset = nearDirectQuoteAsset(input.asset)
  const catalog = quoteAsset
    ? await rheaSwapClient
        .listTokens({
          direction: 'from',
          tokenListChainIds: [NEAR_DIRECT_RHEA_TOKEN_LIST_CHAIN_ID]
        })
        .catch(() => null)
    : null
  const token = quoteAsset ? nearDirectCatalogToken(catalog?.tokens ?? [], quoteAsset) : null
  if (!token) throw new Error(NEAR_MOVE_UNAVAILABLE)
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
    const review = await rheaSwapClient.prepare(quote.quoteHandle)
    if (review.execution.kind !== 'near-transaction-batch') {
      throw new Error(NEAR_MOVE_DEPOSIT_ADDRESS)
    }
    const binding = parseRheaSwapTransactionBinding({
      schemaVersion: 1,
      provider: 'rhea-cross-chain-dex',
      kind: 'swap',
      quoteHandle: quote.quoteHandle,
      executionId: review.executionId,
      router: review.router,
      sourceTarget: review.execution.target ?? input.sender,
      sender: input.sender,
      originAmountRaw: review.amountIn,
      expiresAt: getRheaSwapQuoteDeadline(quote),
      isCrossChain: true,
      origin: {
        chainId: input.chainId,
        assetId: input.assetId,
        protocolChainId: token.rheaChainId,
        protocolAssetId: token.assetId
      },
      destination: {
        chainId: input.chainId,
        assetId: input.assetId,
        protocolChainId: token.rheaChainId,
        protocolAssetId: token.assetId,
        recipient: quote.recipient,
        expectedAmountRaw: review.estimatedOut,
        minimumAmountRaw: review.minAmountOut
      }
    })
    const prepared = await rheaSwapClient.prepareNearTransactionBatch(quote.quoteHandle, binding)
    return Object.freeze({
      quoteHandle: quote.quoteHandle,
      payloadFingerprint: prepared.payloadFingerprint
    })
  } catch (error) {
    await rheaSwapClient.discard(quote.quoteHandle).catch(() => {})
    throw error
  }
}

export function confirmNearDirectMove(
  quoteHandle: string,
  payloadFingerprint: string
): Promise<unknown> {
  return rheaSwapClient.confirmNearTransactionBatch(quoteHandle, payloadFingerprint)
}

export async function cancelNearDirectMove(quoteHandle: string): Promise<void> {
  await rheaSwapClient.cancelNearTransactionBatch(quoteHandle).catch(() => {})
}
