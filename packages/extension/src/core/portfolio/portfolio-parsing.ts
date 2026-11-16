import {
  PORTFOLIO_READ_ERROR_CODES,
  PORTFOLIO_READ_LIMITS,
  type PortfolioBalanceSnapshot,
  type PortfolioReadErrorCode,
  type PortfolioSourceStatus
} from './portfolio-types'

export interface PortfolioSourceState {
  readonly status: PortfolioSourceStatus
  readonly balances: readonly PortfolioBalanceSnapshot[]
  readonly errorCode?: PortfolioReadErrorCode
}

const PORTFOLIO_SOURCE_STATUSES = new Set<PortfolioSourceStatus>(['loading', 'ready', 'error'])
const PORTFOLIO_ERROR_CODES = new Set<PortfolioReadErrorCode>(PORTFOLIO_READ_ERROR_CODES)
const RAW_AMOUNT_PATTERN = new RegExp(
  `^(0|[1-9][0-9]{0,${PORTFOLIO_READ_LIMITS.rawAmountDigits - 1}})$`
)

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional])
  return (
    required.every(key => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every(key => allowed.has(key))
  )
}

function parseRawAmount(value: unknown, label: string): string {
  if (typeof value !== 'string' || !RAW_AMOUNT_PATTERN.test(value)) {
    throw new Error(`${label} must be a bounded base-unit integer`)
  }
  return value
}

function parseTimestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  return value
}

export function parsePortfolioBalanceSnapshot(value: unknown): PortfolioBalanceSnapshot {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ['assetId', 'totalRaw', 'spendableRaw', 'availableRaw', 'pendingRaw', 'updatedAt'],
      [
        'shieldableRaw',
        'shieldedRaw',
        'transparentRaw',
        'shieldedPendingRaw',
        'transparentPendingRaw',
        'mainRaw',
        'privateRaw',
        'privateOnchainRaw',
        'confidentialRaw'
      ]
    ) ||
    typeof value.assetId !== 'string' ||
    value.assetId.length === 0 ||
    value.assetId.trim() !== value.assetId ||
    value.assetId.length > 512
  ) {
    throw new Error('Invalid Portfolio balance')
  }
  const totalRaw = parseRawAmount(value.totalRaw, 'totalRaw')
  const spendableRaw = parseRawAmount(value.spendableRaw, 'spendableRaw')
  const availableRaw = parseRawAmount(value.availableRaw, 'availableRaw')
  const pendingRaw = parseRawAmount(value.pendingRaw, 'pendingRaw')
  const shieldableRaw =
    value.shieldableRaw === undefined
      ? undefined
      : parseRawAmount(value.shieldableRaw, 'shieldableRaw')
  const shieldedRaw =
    value.shieldedRaw === undefined ? undefined : parseRawAmount(value.shieldedRaw, 'shieldedRaw')
  const transparentRaw =
    value.transparentRaw === undefined
      ? undefined
      : parseRawAmount(value.transparentRaw, 'transparentRaw')
  const shieldedPendingRaw =
    value.shieldedPendingRaw === undefined
      ? undefined
      : parseRawAmount(value.shieldedPendingRaw, 'shieldedPendingRaw')
  const transparentPendingRaw =
    value.transparentPendingRaw === undefined
      ? undefined
      : parseRawAmount(value.transparentPendingRaw, 'transparentPendingRaw')
  const mainRaw = value.mainRaw === undefined ? undefined : parseRawAmount(value.mainRaw, 'mainRaw')
  const privateRaw =
    value.privateRaw === undefined ? undefined : parseRawAmount(value.privateRaw, 'privateRaw')
  const privateOnchainRaw =
    value.privateOnchainRaw === undefined
      ? undefined
      : parseRawAmount(value.privateOnchainRaw, 'privateOnchainRaw')
  const confidentialRaw =
    value.confidentialRaw === undefined
      ? undefined
      : parseRawAmount(value.confidentialRaw, 'confidentialRaw')
  const total = BigInt(totalRaw)
  const spendable = BigInt(spendableRaw)
  if (
    spendable > total ||
    BigInt(availableRaw) > spendable ||
    BigInt(pendingRaw) > total ||
    (shieldableRaw !== undefined && BigInt(shieldableRaw) > total) ||
    (shieldedRaw !== undefined && BigInt(shieldedRaw) > total) ||
    (transparentRaw !== undefined && BigInt(transparentRaw) > total) ||
    (shieldedPendingRaw !== undefined &&
      shieldedRaw !== undefined &&
      BigInt(shieldedPendingRaw) > BigInt(shieldedRaw)) ||
    (transparentPendingRaw !== undefined &&
      transparentRaw !== undefined &&
      BigInt(transparentPendingRaw) > BigInt(transparentRaw)) ||
    (mainRaw === undefined) !== (privateRaw === undefined) ||
    (mainRaw !== undefined &&
      privateRaw !== undefined &&
      BigInt(mainRaw) + BigInt(privateRaw) !== total) ||
    (privateOnchainRaw === undefined) !== (confidentialRaw === undefined) ||
    (privateOnchainRaw !== undefined &&
      confidentialRaw !== undefined &&
      privateRaw !== undefined &&
      BigInt(privateOnchainRaw) + BigInt(confidentialRaw) !== BigInt(privateRaw))
  ) {
    throw new Error('Portfolio balance facets are inconsistent')
  }
  return Object.freeze({
    assetId: value.assetId,
    totalRaw,
    spendableRaw,
    availableRaw,
    pendingRaw,
    ...(shieldableRaw === undefined ? {} : { shieldableRaw }),
    ...(shieldedRaw === undefined ? {} : { shieldedRaw }),
    ...(transparentRaw === undefined ? {} : { transparentRaw }),
    ...(shieldedPendingRaw === undefined ? {} : { shieldedPendingRaw }),
    ...(transparentPendingRaw === undefined ? {} : { transparentPendingRaw }),
    ...(mainRaw === undefined ? {} : { mainRaw }),
    ...(privateRaw === undefined ? {} : { privateRaw }),
    ...(privateOnchainRaw === undefined ? {} : { privateOnchainRaw }),
    ...(confidentialRaw === undefined ? {} : { confidentialRaw }),
    updatedAt: parseTimestamp(value.updatedAt, 'balance.updatedAt')
  })
}

export function parsePortfolioSourceState(value: unknown): PortfolioSourceState {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['status', 'balances'], ['errorCode']) ||
    typeof value.status !== 'string' ||
    !PORTFOLIO_SOURCE_STATUSES.has(value.status as PortfolioSourceStatus) ||
    !Array.isArray(value.balances) ||
    value.balances.length > PORTFOLIO_READ_LIMITS.balancesPerSource
  ) {
    throw new Error('Invalid Portfolio source state')
  }
  const status = value.status as PortfolioSourceStatus
  let errorCode: PortfolioReadErrorCode | undefined
  if (status === 'error') {
    if (
      typeof value.errorCode !== 'string' ||
      !PORTFOLIO_ERROR_CODES.has(value.errorCode as PortfolioReadErrorCode)
    ) {
      throw new Error('Invalid Portfolio source error state')
    }
    errorCode = value.errorCode as PortfolioReadErrorCode
  } else if (value.errorCode !== undefined) {
    throw new Error('Invalid Portfolio source error state')
  }
  const balances = Object.freeze(value.balances.map(parsePortfolioBalanceSnapshot))
  if (new Set(balances.map(balance => balance.assetId)).size !== balances.length) {
    throw new Error('Duplicate Portfolio asset balance')
  }
  return Object.freeze({
    status,
    balances,
    ...(errorCode === undefined ? {} : { errorCode })
  })
}
