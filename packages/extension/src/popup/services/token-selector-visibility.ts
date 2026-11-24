import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { calculateTokenFiatValue, parseTokenBalanceDecimal } from './token-balance-format'

export interface TokenPickerBalance {
  readonly availableRaw?: string
  readonly amount?: string | null
  readonly symbol: string
  readonly isNative?: boolean
  readonly pinned?: boolean
  readonly pinOrder?: number
  readonly decimals: number
  readonly priceUsd?: string | number | null
  readonly valueUsd?: string | null
}

export type TokenPickerPolicy = 'all' | 'grouped' | 'grouped-source' | 'funded' | 'withdrawal'

function balanceAmount(asset: TokenPickerBalance): string | null {
  return asset.availableRaw === undefined
    ? (asset.amount ?? null)
    : formatBaseUnitDecimalAmount(asset.availableRaw, asset.decimals)
}

export function hasTokenPickerBalance(asset: TokenPickerBalance): boolean {
  return parseTokenBalanceDecimal(balanceAmount(asset))?.gt(0) === true
}

export function isExtraTokenPickerAsset(asset: TokenPickerBalance): boolean {
  return (
    !asset.pinned &&
    asset.pinOrder === undefined &&
    !asset.isNative &&
    !hasTokenPickerBalance(asset) &&
    !['USDT', 'USDC'].includes(asset.symbol.toUpperCase())
  )
}

export function sortTokenPickerRows<Row>(
  rows: readonly Row[],
  getAsset: (row: Row) => TokenPickerBalance,
  policy: TokenPickerPolicy
): Row[] {
  const fundedOnly = policy === 'funded' || policy === 'withdrawal'
  return rows
    .map(row => {
      const asset = getAsset(row)
      const amount = balanceAmount(asset)
      const available = parseTokenBalanceDecimal(amount)?.gt(0) === true
      const value = available
        ? parseTokenBalanceDecimal(
            asset.valueUsd ?? calculateTokenFiatValue(amount, asset.priceUsd)
          )
        : null
      return {
        row,
        available,
        value: value?.gt(0) ? value : null,
        pinOrder: fundedOnly ? Infinity : (asset.pinOrder ?? (asset.pinned ? 0 : Infinity))
      }
    })
    .filter(entry => !fundedOnly || entry.available)
    .sort((left, right) => {
      if (left.pinOrder !== right.pinOrder) return left.pinOrder - right.pinOrder
      if (left.available !== right.available) return left.available ? -1 : 1
      if (left.value && right.value) return right.value.cmp(left.value)
      return Number(Boolean(right.value)) - Number(Boolean(left.value))
    })
    .map(entry => entry.row)
}
