import Big from 'big.js'

export interface AccountPortfolioValueSnapshot {
  readonly valuationBasis: 'wallet-assets-v1' | 'wallet-assets-v2'
  readonly totalUsd: string
  readonly updatedAt: number
  readonly complete: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function parseAccountPortfolioValueSnapshot(
  value: unknown
): AccountPortfolioValueSnapshot | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 4 ||
    (value.valuationBasis !== 'wallet-assets-v1' && value.valuationBasis !== 'wallet-assets-v2') ||
    typeof value.totalUsd !== 'string' ||
    value.totalUsd.length > 129 ||
    !/^(0|[1-9][0-9]{0,63})(?:\.[0-9]{1,64})?$/.test(value.totalUsd) ||
    typeof value.updatedAt !== 'number' ||
    !Number.isSafeInteger(value.updatedAt) ||
    value.updatedAt < 0 ||
    typeof value.complete !== 'boolean'
  ) {
    return null
  }

  try {
    const totalUsd = new Big(value.totalUsd)
    if (totalUsd.lt(0)) return null
    return Object.freeze({
      valuationBasis: value.valuationBasis,
      totalUsd: totalUsd.toFixed(),
      updatedAt: value.updatedAt,
      complete: value.valuationBasis === 'wallet-assets-v2' && value.complete
    })
  } catch {
    return null
  }
}
