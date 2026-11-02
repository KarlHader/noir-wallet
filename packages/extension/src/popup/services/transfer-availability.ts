import Big, { safeBig } from '@/lib/big'

import { ZEC_DECIMALS } from '@/config/wallet'
import { formatBaseUnitAmount, formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { resolveTransferSpendableRaw } from './transfer-maximum'
import { getFundingBalance } from '@/core/wallet/funding-balance'
import type { FundingSource, ZcashBalance } from '@/types/wallet'

type AccountBalance = Readonly<{
  availableRaw: string
  mainRaw?: string
  privateRaw?: string
  privateOnchainRaw?: string
  confidentialRaw?: string
}>

export function resolveAccountAvailableRaw(
  balance: AccountBalance | undefined,
  mode: 'main' | 'private'
): string {
  if (!balance) return '0'
  return mode === 'private'
    ? (balance.privateOnchainRaw ?? balance.privateRaw ?? '0')
    : (balance.mainRaw ?? balance.availableRaw)
}

export function resolveEvmAccountAvailability(
  balance: AccountBalance,
  decimals: number,
  privateAddress: string | undefined
) {
  const privateRaw = balance.privateOnchainRaw ?? balance.privateRaw
  return {
    privateSourceAvailable: Boolean(
      privateAddress && balance.mainRaw !== undefined && balance.privateRaw !== undefined
    ),
    mainDisplay: formatBaseUnitAmount(resolveAccountAvailableRaw(balance, 'main'), decimals),
    privateDisplay:
      privateRaw === undefined ? undefined : formatBaseUnitAmount(privateRaw, decimals),
    confidentialDisplay:
      balance.confidentialRaw === undefined || BigInt(balance.confidentialRaw) === 0n
        ? undefined
        : formatBaseUnitAmount(balance.confidentialRaw, decimals)
  }
}

export function resolvePortfolioTransferAvailability(input: {
  readonly balanceRaw: string
  readonly decimals: number
  readonly isNative: boolean
  readonly maximumRaw: string | null
}): Readonly<{ amountRaw: string; display: string; label: 'Balance' | 'Available' }> {
  const amountRaw =
    resolveTransferSpendableRaw(input.balanceRaw, input.maximumRaw, input.isNative) ??
    input.balanceRaw
  return {
    amountRaw,
    display: formatBaseUnitDecimalAmount(amountRaw, input.decimals),
    label: input.isNative && input.maximumRaw === null ? 'Balance' : 'Available'
  }
}

/** Account available reserves the Standard fee; raw funding balances reserve none. */
export function resolveZcashTransferAvailability(input: {
  readonly availableBalance: string
  readonly selectedFeeZats: number
  readonly standardFeeZats: number
  readonly feeAlreadyReservedZats?: number
  readonly maximumAmount?: string | null
}): Readonly<{ amount: string; fallbackAmount: string }> {
  const reservedFeeZats = input.feeAlreadyReservedZats ?? input.standardFeeZats
  const feeDeltaZats = Math.max(0, input.selectedFeeZats - reservedFeeZats)
  const fallback = safeBig(input.availableBalance || '0').minus(
    formatBaseUnitDecimalAmount(String(feeDeltaZats), ZEC_DECIMALS)
  )
  const fallbackAmount = (fallback.gt(0) ? fallback : safeBig(0))
    .round(ZEC_DECIMALS, Big.roundDown)
    .toFixed()
  const amount = input.maximumAmount ?? fallbackAmount
  return {
    amount: safeBig(amount).round(ZEC_DECIMALS, Big.roundDown).toFixed(),
    fallbackAmount
  }
}

export function resolveZcashFundingAvailability(input: {
  readonly balance: ZcashBalance | null | undefined
  readonly fundingSource: FundingSource
  readonly selectedFeeZats: number
  readonly standardFeeZats: number
  readonly maximumAmount?: string | null
}): Readonly<{ amount: string; fallbackAmount: string }> {
  return resolveZcashTransferAvailability({
    availableBalance: getFundingBalance(input.balance, input.fundingSource).available,
    selectedFeeZats: input.selectedFeeZats,
    standardFeeZats: input.standardFeeZats,
    feeAlreadyReservedZats: 0,
    maximumAmount: input.maximumAmount
  })
}
