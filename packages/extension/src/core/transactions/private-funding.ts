import { formatBaseUnitDecimalAmount } from '../../lib/number-format.ts'

const RAW_AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,77})$/
const PRICE_PATTERN = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:e([+-]?[0-9]+))?$/i
const MAX_RAW_AMOUNT = (1n << 256n) - 1n
const ADDITIONAL_GAS_RESERVE_COUNT = 4n
const PRIVATE_GAS_RESERVE_USD = 5n

interface PrivateFundingAsset {
  readonly assetId: string
  readonly decimals: number
  readonly price: string | number
}

interface DecimalRatio {
  readonly numerator: bigint
  readonly denominator: bigint
}

function isValidRawAmount(value: string): boolean {
  return (
    typeof value === 'string' && RAW_AMOUNT_PATTERN.test(value) && BigInt(value) <= MAX_RAW_AMOUNT
  )
}

function isValidAssetId(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/\s/.test(value)
}

function isValidDecimals(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 255
}

function parsePositivePrice(value: string | number): DecimalRatio | null {
  if (typeof value === 'number' && (!Number.isFinite(value) || value <= 0)) return null
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const text = String(value)
  if (text.length === 0 || text.length > 512) return null
  const match = PRICE_PATTERN.exec(text)
  if (!match) return null
  const numerator = BigInt(`${match[1]}${match[2] ?? ''}`)
  if (numerator <= 0n) return null
  const exponent = match[3] === undefined ? 0 : Number(match[3])
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 512) return null
  const scale = (match[2]?.length ?? 0) - exponent
  return scale >= 0
    ? { numerator, denominator: 10n ** BigInt(scale) }
    : { numerator: numerator * 10n ** BigInt(-scale), denominator: 1n }
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator
}

export function calculateSuggestedPrivateGasFundingRaw(
  shortfallRaw: string,
  maximumGasCostRaw: string,
  options?: { readonly decimals: number; readonly nativePriceUsd: string | null }
): string | null {
  if (!isValidRawAmount(shortfallRaw) || !isValidRawAmount(maximumGasCostRaw)) return null
  const shortfall = BigInt(shortfallRaw)
  const maximumGasCost = BigInt(maximumGasCostRaw)
  if (shortfall <= 0n) return null

  let priceFloor = 0n
  if (options) {
    if (!isValidDecimals(options.decimals)) return null
    if (options.nativePriceUsd !== null) {
      const price = parsePositivePrice(options.nativePriceUsd)
      if (!price) return null
      priceFloor = ceilDiv(
        PRIVATE_GAS_RESERVE_USD * 10n ** BigInt(options.decimals) * price.denominator,
        price.numerator
      )
    }
  }
  if (maximumGasCost === 0n && priceFloor === 0n) return null
  const feeBudget = shortfall + maximumGasCost * ADDITIONAL_GAS_RESERVE_COUNT
  const suggested = feeBudget > priceFloor ? feeBudget : priceFloor
  return suggested <= MAX_RAW_AMOUNT ? suggested.toString() : null
}

export function calculatePrivateFundingSourceAmount(input: {
  readonly suggestedOutputRaw: string
  readonly source: PrivateFundingAsset
  readonly destination: PrivateFundingAsset
}): string | null {
  const { suggestedOutputRaw, source, destination } = input
  if (
    !isValidRawAmount(suggestedOutputRaw) ||
    BigInt(suggestedOutputRaw) <= 0n ||
    !isValidDecimals(source.decimals) ||
    !isValidDecimals(destination.decimals) ||
    !isValidAssetId(source.assetId) ||
    !isValidAssetId(destination.assetId)
  ) {
    return null
  }

  const outputRaw = BigInt(suggestedOutputRaw)
  if (source.assetId === destination.assetId) {
    return source.decimals === destination.decimals
      ? formatBaseUnitDecimalAmount(outputRaw, source.decimals)
      : null
  }

  const sourcePrice = parsePositivePrice(source.price)
  const destinationPrice = parsePositivePrice(destination.price)
  if (!sourcePrice || !destinationPrice) return null
  const sourceRaw = ceilDiv(
    outputRaw *
      destinationPrice.numerator *
      sourcePrice.denominator *
      10n ** BigInt(source.decimals),
    destinationPrice.denominator * sourcePrice.numerator * 10n ** BigInt(destination.decimals)
  )
  return sourceRaw <= MAX_RAW_AMOUNT
    ? formatBaseUnitDecimalAmount(sourceRaw, source.decimals)
    : null
}
