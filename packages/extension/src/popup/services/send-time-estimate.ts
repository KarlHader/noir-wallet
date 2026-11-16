import { FEE_TIERS } from '@/config/fee'
import type { NetworkFeeTier } from '@/core/transactions/domain'
import { bitcoinFeeTargetBlocks } from '@/infrastructure/chains/bitcoin/bitcoin-fee-tier'
import { formatConfirmationTime } from './confirmation-time-format'

export function estimateZcashSendTime(): string {
  return FEE_TIERS.find(tier => tier.id === 'standard')?.etaHint ?? '—'
}

export function estimateBitcoinSendTime(tier: NetworkFeeTier): string {
  // Fee tiers target inclusion within a number of blocks; ten minutes is a block-time average.
  const seconds = bitcoinFeeTargetBlocks(tier) * 600
  return formatConfirmationTime({ minimumSeconds: seconds, maximumSeconds: seconds })
}

export function estimateConfidentialSendTime(
  quoteSeconds: number | undefined,
  chainConfirmationTime = '—'
): string {
  const quoted =
    quoteSeconds !== undefined && Number.isSafeInteger(quoteSeconds)
      ? formatConfirmationTime({ minimumSeconds: quoteSeconds, maximumSeconds: quoteSeconds })
      : '—'
  if (quoted !== '—') return quoted
  return chainConfirmationTime === '—' ? '—' : `${chainConfirmationTime}+`
}
