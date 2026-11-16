import { formatBaseUnitDecimalAmount } from '@/lib/number-format'

export function getSendRouteCostFromAmounts(input: {
  readonly amountInRaw: string
  readonly estimatedOutRaw: string
  readonly decimals: number
  readonly outputDecimals?: number
  readonly clampNegative?: boolean
}): string | null {
  if (!/^\d+$/.test(input.amountInRaw) || !/^\d+$/.test(input.estimatedOutRaw)) return null
  const outputDecimals = input.outputDecimals ?? input.decimals
  if (
    !Number.isSafeInteger(input.decimals) ||
    !Number.isSafeInteger(outputDecimals) ||
    input.decimals < 0 ||
    outputDecimals < 0 ||
    input.decimals > 255 ||
    outputDecimals > 255
  )
    return null
  const scale = Math.max(input.decimals, outputDecimals)
  const amountIn = BigInt(input.amountInRaw) * 10n ** BigInt(scale - input.decimals)
  const amountOut = BigInt(input.estimatedOutRaw) * 10n ** BigInt(scale - outputDecimals)
  const difference = amountIn - amountOut
  if (difference < 0n) return input.clampNegative ? '0' : null
  return formatBaseUnitDecimalAmount(difference.toString(), scale)
}
