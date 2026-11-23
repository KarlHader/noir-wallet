import { safeBig } from '@/lib/big'
import { formatBaseUnitAmount, formatFiatAmount, parseDisplayUnitAmount } from '@/lib/number-format'
import type { PortfolioAssetView } from '@/core/portfolio'
import type { SolanaTransferReview } from '@/popup/services/solana-wallet-client'
import type { NearTransferReview } from '@/popup/services/near-wallet-client'

export function parseSendAmount(amount: string, decimals: number): string | null {
  try {
    const raw = parseDisplayUnitAmount(amount, decimals)
    return BigInt(raw) > 0n ? raw : null
  } catch {
    return null
  }
}

export function formatSendReviewAmounts(
  amountRaw: string,
  feeRaw: string,
  amountDecimals: number,
  feeDecimals: number,
  native: boolean
) {
  return {
    amount: formatBaseUnitAmount(amountRaw, amountDecimals),
    fee: formatBaseUnitAmount(feeRaw, feeDecimals),
    total: native
      ? formatBaseUnitAmount((BigInt(amountRaw) + BigInt(feeRaw)).toString(), amountDecimals)
      : null
  }
}

export function estimateSolanaFee(review: SolanaTransferReview, chainId: string): string {
  const feeLimit = review.graph.root.intent?.feeLimit
  if (
    feeLimit?.assetId !== `${chainId}/slip44:501` ||
    !/^(?:0|[1-9][0-9]*)$/.test(feeLimit.amountRaw)
  ) {
    throw new Error('Invalid Solana fee estimate')
  }
  return feeLimit.amountRaw
}

export function matchesSolanaReview(
  value: SolanaTransferReview,
  asset: PortfolioAssetView,
  recipient: string,
  amountRaw: string
): boolean {
  const summary = value.review.summary
  const nativeTransfer = summary.fields.instructions.find(
    instruction => instruction.interpretation.kind === 'system-transfer'
  )?.interpretation
  const tokenTransfer = summary.fields.instructions.find(
    instruction => instruction.interpretation.kind === 'spl-token-transfer'
  )?.interpretation
  const associatedAccount = summary.fields.instructions.find(
    instruction => instruction.interpretation.kind === 'associated-token-create-idempotent'
  )?.interpretation
  const transferMatches =
    asset.asset.kind === 'native'
      ? nativeTransfer?.kind === 'system-transfer' &&
        nativeTransfer.to === recipient &&
        nativeTransfer.lamports === amountRaw
      : tokenTransfer?.kind === 'spl-token-transfer' &&
        tokenTransfer.mint === asset.asset.reference &&
        tokenTransfer.amountRaw === amountRaw &&
        associatedAccount?.kind === 'associated-token-create-idempotent' &&
        associatedAccount.owner === recipient

  return (
    summary.schema === 'solana.transaction.v1' &&
    value.graph.root.intent?.primaryAmount?.assetId === asset.asset.id &&
    value.graph.root.intent?.recipient?.address === recipient &&
    transferMatches
  )
}

export function matchesNearReview(
  value: NearTransferReview,
  asset: PortfolioAssetView,
  recipient: string,
  amountRaw: string
): boolean {
  const summary = value.review.summary
  const transfer = summary.fields.actions[0]
  const transferMatches =
    asset.asset.kind === 'native'
      ? transfer?.kind === 'transfer' && transfer.depositYocto === amountRaw
      : transfer?.kind === 'function-call' &&
        transfer.methodName === 'ft_transfer' &&
        summary.fields.receiverId === asset.asset.reference.replace(/%5F/gi, '_')

  return (
    summary.schema === 'near.transaction.v1' &&
    value.graph.root.intent?.primaryAmount?.assetId === asset.asset.id &&
    value.graph.root.intent?.primaryAmount?.amountRaw === amountRaw &&
    value.graph.root.intent?.recipient?.address === recipient &&
    transferMatches
  )
}

export function formatSendFiatValue(
  amount: string,
  priceUsd: string | number | null | undefined
): string | null {
  const normalizedAmount = amount.replace(/,/g, '') || '0'
  const normalizedPrice = String(priceUsd ?? '')
  const decimalPattern = /^(?:\d+(?:\.\d*)?|\.\d+)$/
  if (
    !decimalPattern.test(normalizedAmount) ||
    !decimalPattern.test(normalizedPrice) ||
    safeBig(normalizedPrice).lte(0)
  ) {
    return null
  }
  return formatFiatAmount(safeBig(normalizedAmount).times(normalizedPrice).toFixed(), {
    showSign: true
  })
}
