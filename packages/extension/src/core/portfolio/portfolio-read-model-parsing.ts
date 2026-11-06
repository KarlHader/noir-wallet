import { parseAccountId, parseChainAccountId } from '@/core/accounts/domain'
import type { AssetRegistry, ChainRegistry } from '@/core/chains/registry'
import { parseAssetId } from '@/core/chains/registry'
import { parseKeyDomainId } from '@/core/keyring/domain'
import {
  PORTFOLIO_READ_ERROR_CODES,
  PORTFOLIO_READ_LIMITS,
  type ConfidentialPortfolioView,
  type PortfolioAssetView,
  type PortfolioBalanceView,
  type PortfolioChainView,
  type PortfolioReadErrorCode,
  type PortfolioReadModel,
  type PortfolioViewStatus
} from './portfolio-types'

const VIEW_STATUSES = new Set<PortfolioViewStatus>([
  'empty',
  'loading',
  'ready',
  'partial',
  'error'
])
const CHAIN_VIEW_STATUSES = new Set<Exclude<PortfolioViewStatus, 'empty'>>([
  'loading',
  'ready',
  'partial',
  'error'
])
const ERROR_CODES = new Set<PortfolioReadErrorCode>(PORTFOLIO_READ_ERROR_CODES)

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`)
  }
  return value as Record<string, unknown>
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
  label: string
): void {
  const allowed = new Set([...required, ...optional])
  if (
    required.some(key => !Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some(key => !allowed.has(key))
  ) {
    throw new Error(`${label} has invalid fields`)
  }
}

function canonicalValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => canonicalValuesEqual(item, right[index]))
    )
  }
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    return false
  }
  const leftRecord = readRecord(left, 'Canonical value')
  const rightRecord = readRecord(right, 'Canonical value')
  const leftKeys = Object.keys(leftRecord)
  const rightKeys = Object.keys(rightRecord)
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      key =>
        Object.prototype.hasOwnProperty.call(rightRecord, key) &&
        canonicalValuesEqual(leftRecord[key], rightRecord[key])
    )
  )
}

function readRawAmount(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    value.length > PORTFOLIO_READ_LIMITS.rawAmountDigits
  ) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

function readTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Invalid ${label}`)
  }
  return value as number
}

function readBoundedString(value: unknown, label: string, limit: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > limit ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  ) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

function parseConfidentialView(value: unknown): ConfidentialPortfolioView {
  const record = readRecord(value, 'Confidential portfolio')
  assertExactKeys(record, ['status', 'assets'], [], 'Confidential portfolio')
  if (record.status !== 'ready' && record.status !== 'unavailable') {
    throw new Error('Invalid Confidential portfolio status')
  }
  if (
    !Array.isArray(record.assets) ||
    record.assets.length > PORTFOLIO_READ_LIMITS.balancesPerSource
  ) {
    throw new Error('Invalid Confidential portfolio assets')
  }
  if (record.status === 'unavailable' && record.assets.length !== 0) {
    throw new Error('Unavailable Confidential portfolio cannot contain balances')
  }
  const seen = new Set<string>()
  const entries = record.assets.map(value => {
    const item = readRecord(value, 'Confidential portfolio asset')
    assertExactKeys(
      item,
      ['tokenId', 'protocolAssetId', 'availableRaw'],
      [
        'assetId',
        'chainId',
        'blockchain',
        'symbol',
        'name',
        'decimals',
        'iconUrl',
        'priceUsd',
        'priceUpdatedAt'
      ],
      'Confidential portfolio asset'
    )
    const tokenId = readBoundedString(item.tokenId, 'Confidential token ID', 512)
    const protocolAssetId = readBoundedString(
      item.protocolAssetId,
      'Confidential protocol asset ID',
      512
    )
    const availableRaw = readRawAmount(item.availableRaw, 'Confidential available balance')
    if (availableRaw === '0' || seen.has(protocolAssetId)) {
      throw new Error('Duplicate or empty Confidential portfolio asset')
    }
    seen.add(protocolAssetId)
    const assetId =
      item.assetId === undefined
        ? undefined
        : parseAssetId(readBoundedString(item.assetId, 'Confidential asset ID', 512)).id
    const chainId =
      item.chainId === undefined
        ? undefined
        : readBoundedString(item.chainId, 'Confidential chain ID', 128)
    if ((assetId && !chainId) || (assetId && !assetId.startsWith(`${chainId}/`))) {
      throw new Error('Confidential asset chain does not match its asset ID')
    }
    const decimals = item.decimals === undefined ? undefined : item.decimals
    if (
      decimals !== undefined &&
      (!Number.isSafeInteger(decimals) || (decimals as number) < 0 || (decimals as number) > 255)
    ) {
      throw new Error('Invalid Confidential asset decimals')
    }
    const iconUrl =
      item.iconUrl === undefined
        ? undefined
        : readBoundedString(item.iconUrl, 'Confidential icon URL', 2048)
    if (iconUrl && !iconUrl.startsWith('https://')) throw new Error('Invalid Confidential icon URL')
    const priceUsd =
      item.priceUsd === undefined
        ? undefined
        : readBoundedString(item.priceUsd, 'Confidential USD price', 128)
    if (priceUsd && (!/^(0|[1-9]\d*)(\.\d+)?$/.test(priceUsd) || Number(priceUsd) <= 0)) {
      throw new Error('Invalid Confidential USD price')
    }
    const priceUpdatedAt =
      item.priceUpdatedAt === undefined
        ? undefined
        : readBoundedString(item.priceUpdatedAt, 'Confidential price timestamp', 64)
    if (
      (priceUsd === undefined) !== (priceUpdatedAt === undefined) ||
      (priceUpdatedAt && !Number.isFinite(Date.parse(priceUpdatedAt)))
    ) {
      throw new Error('Invalid Confidential price timestamp')
    }
    return Object.freeze({
      tokenId,
      protocolAssetId,
      availableRaw,
      ...(assetId === undefined ? {} : { assetId }),
      ...(chainId === undefined ? {} : { chainId }),
      ...(item.blockchain === undefined
        ? {}
        : { blockchain: readBoundedString(item.blockchain, 'Confidential blockchain', 64) }),
      ...(item.symbol === undefined
        ? {}
        : { symbol: readBoundedString(item.symbol, 'Confidential symbol', 64) }),
      ...(item.name === undefined
        ? {}
        : { name: readBoundedString(item.name, 'Confidential name', 128) }),
      ...(decimals === undefined ? {} : { decimals: decimals as number }),
      ...(iconUrl === undefined ? {} : { iconUrl }),
      ...(priceUsd === undefined ? {} : { priceUsd }),
      ...(priceUpdatedAt === undefined ? {} : { priceUpdatedAt })
    })
  })
  return Object.freeze({ status: record.status, assets: Object.freeze(entries) })
}

function parseBalanceView(value: unknown): PortfolioBalanceView {
  const record = readRecord(value, 'Portfolio balance view')
  assertExactKeys(
    record,
    ['totalRaw', 'spendableRaw', 'availableRaw', 'pendingRaw'],
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
    ],
    'Portfolio balance view'
  )
  const totalRaw = readRawAmount(record.totalRaw, 'Portfolio total balance')
  const mainRaw =
    record.mainRaw === undefined
      ? undefined
      : readRawAmount(record.mainRaw, 'Portfolio Main balance')
  const privateRaw =
    record.privateRaw === undefined
      ? undefined
      : readRawAmount(record.privateRaw, 'Portfolio Private balance')
  const privateOnchainRaw =
    record.privateOnchainRaw === undefined
      ? undefined
      : readRawAmount(record.privateOnchainRaw, 'Portfolio Private on-chain balance')
  const confidentialRaw =
    record.confidentialRaw === undefined
      ? undefined
      : readRawAmount(record.confidentialRaw, 'Portfolio Confidential balance')
  if (
    (mainRaw === undefined) !== (privateRaw === undefined) ||
    (mainRaw !== undefined &&
      privateRaw !== undefined &&
      BigInt(mainRaw) + BigInt(privateRaw) !== BigInt(totalRaw)) ||
    (privateOnchainRaw === undefined) !== (confidentialRaw === undefined) ||
    (privateOnchainRaw !== undefined &&
      confidentialRaw !== undefined &&
      privateRaw !== undefined &&
      BigInt(privateOnchainRaw) + BigInt(confidentialRaw) !== BigInt(privateRaw))
  ) {
    throw new Error('Portfolio account balance breakdown is inconsistent')
  }
  return Object.freeze({
    totalRaw,
    spendableRaw: readRawAmount(record.spendableRaw, 'Portfolio spendable balance'),
    availableRaw: readRawAmount(record.availableRaw, 'Portfolio available balance'),
    pendingRaw: readRawAmount(record.pendingRaw, 'Portfolio pending balance'),
    ...(record.shieldableRaw === undefined
      ? {}
      : { shieldableRaw: readRawAmount(record.shieldableRaw, 'Portfolio shieldable balance') }),
    ...(record.shieldedRaw === undefined
      ? {}
      : { shieldedRaw: readRawAmount(record.shieldedRaw, 'Portfolio shielded balance') }),
    ...(record.transparentRaw === undefined
      ? {}
      : { transparentRaw: readRawAmount(record.transparentRaw, 'Portfolio transparent balance') }),
    ...(record.shieldedPendingRaw === undefined
      ? {}
      : {
          shieldedPendingRaw: readRawAmount(
            record.shieldedPendingRaw,
            'Portfolio shielded pending balance'
          )
        }),
    ...(record.transparentPendingRaw === undefined
      ? {}
      : {
          transparentPendingRaw: readRawAmount(
            record.transparentPendingRaw,
            'Portfolio transparent pending balance'
          )
        }),
    ...(mainRaw === undefined ? {} : { mainRaw }),
    ...(privateRaw === undefined ? {} : { privateRaw }),
    ...(privateOnchainRaw === undefined ? {} : { privateOnchainRaw }),
    ...(confidentialRaw === undefined ? {} : { confidentialRaw })
  })
}

function parseAssetView(
  value: unknown,
  assets: AssetRegistry,
  expectedChainId?: string
): PortfolioAssetView {
  const record = readRecord(value, 'Portfolio asset view')
  assertExactKeys(
    record,
    ['asset', 'metadata', 'balance', 'chainAccountIds', 'freshness', 'updatedAt'],
    ['source'],
    'Portfolio asset view'
  )
  const assetRecord = readRecord(record.asset, 'Portfolio asset')
  if (typeof assetRecord.id !== 'string') throw new Error('Invalid Portfolio asset ID')
  const assetId = parseAssetId(assetRecord.id)
  const canonical = assets.inspect(assetId.id)
  if (
    !canonical ||
    canonical.verification === 'blocked' ||
    (record.source !== undefined && record.source !== canonical.source) ||
    (expectedChainId !== undefined && canonical.asset.chainId !== expectedChainId) ||
    !canonicalValuesEqual(assetRecord, canonical.asset) ||
    !canonicalValuesEqual(record.metadata, canonical.metadata)
  ) {
    throw new Error('Portfolio asset does not match the validated registry')
  }
  if (
    !Array.isArray(record.chainAccountIds) ||
    record.chainAccountIds.length === 0 ||
    record.chainAccountIds.length > PORTFOLIO_READ_LIMITS.sources
  ) {
    throw new Error('Invalid Portfolio ChainAccount references')
  }
  const chainAccountIds = record.chainAccountIds.map(value => parseChainAccountId(value))
  if (new Set(chainAccountIds).size !== chainAccountIds.length) {
    throw new Error('Duplicate Portfolio ChainAccount reference')
  }
  if (record.freshness !== 'fresh' && record.freshness !== 'stale') {
    throw new Error('Invalid Portfolio asset freshness')
  }
  return Object.freeze({
    asset: canonical.asset,
    metadata: canonical.metadata,
    source: canonical.source,
    balance: parseBalanceView(record.balance),
    chainAccountIds: Object.freeze(chainAccountIds),
    freshness: record.freshness,
    updatedAt: readTimestamp(record.updatedAt, 'Portfolio asset timestamp')
  })
}

function parseChainView(
  value: unknown,
  chains: ChainRegistry,
  assets: AssetRegistry
): PortfolioChainView {
  const record = readRecord(value, 'Portfolio chain view')
  assertExactKeys(record, ['chain', 'status', 'assets', 'errorCodes'], [], 'Portfolio chain view')
  const chainRecord = readRecord(record.chain, 'Portfolio chain')
  if (typeof chainRecord.id !== 'string') throw new Error('Invalid Portfolio chain ID')
  const chain = chains.resolve(chainRecord.id)
  if (!canonicalValuesEqual(chainRecord, chain)) {
    throw new Error('Portfolio chain does not match the trusted registry')
  }
  if (
    typeof record.status !== 'string' ||
    !CHAIN_VIEW_STATUSES.has(record.status as Exclude<PortfolioViewStatus, 'empty'>)
  ) {
    throw new Error('Invalid Portfolio chain status')
  }
  const status = record.status as Exclude<PortfolioViewStatus, 'empty'>
  if (!Array.isArray(record.assets) || record.assets.length > PORTFOLIO_READ_LIMITS.balancesTotal) {
    throw new Error('Invalid Portfolio chain assets')
  }
  const parsedAssets = record.assets.map(asset => parseAssetView(asset, assets, chain.id))
  if (new Set(parsedAssets.map(asset => asset.asset.id)).size !== parsedAssets.length) {
    throw new Error('Duplicate Portfolio chain asset')
  }
  if ((status === 'loading' || status === 'error') && parsedAssets.length > 0) {
    throw new Error(`Portfolio ${status} chain cannot contain assets`)
  }
  if (status === 'ready' && parsedAssets.some(asset => asset.freshness !== 'fresh')) {
    throw new Error('Ready Portfolio chain cannot contain stale assets')
  }
  if (
    !Array.isArray(record.errorCodes) ||
    record.errorCodes.length > PORTFOLIO_READ_ERROR_CODES.length
  ) {
    throw new Error('Invalid Portfolio chain error codes')
  }
  const errorCodes = record.errorCodes.map(value => {
    if (typeof value !== 'string' || !ERROR_CODES.has(value as PortfolioReadErrorCode)) {
      throw new Error('Invalid Portfolio chain error code')
    }
    return value as PortfolioReadErrorCode
  })
  if (new Set(errorCodes).size !== errorCodes.length) {
    throw new Error('Duplicate Portfolio chain error code')
  }
  return Object.freeze({
    chain,
    status,
    assets: Object.freeze(parsedAssets),
    errorCodes: Object.freeze(errorCodes)
  })
}

function deriveStatus(chains: readonly PortfolioChainView[]): PortfolioViewStatus {
  if (chains.length === 0) return 'empty'
  if (chains.every(chain => chain.status === 'ready')) return 'ready'
  if (chains.every(chain => chain.status === 'loading')) return 'loading'
  if (chains.every(chain => chain.status === 'error')) return 'error'
  return 'partial'
}

export function parsePortfolioReadModel(
  value: unknown,
  chains: ChainRegistry,
  assets: AssetRegistry
): PortfolioReadModel {
  const record = readRecord(value, 'Portfolio read model')
  assertExactKeys(
    record,
    ['scope', 'status', 'chains', 'assets', 'ignoredAssetCount'],
    ['confidential'],
    'Portfolio read model'
  )
  const scope = readRecord(record.scope, 'Portfolio scope')
  assertExactKeys(scope, ['keyDomainId', 'accountId'], [], 'Portfolio scope')
  if (
    typeof record.status !== 'string' ||
    !VIEW_STATUSES.has(record.status as PortfolioViewStatus)
  ) {
    throw new Error('Invalid Portfolio status')
  }
  if (!Array.isArray(record.chains) || record.chains.length > PORTFOLIO_READ_LIMITS.sources) {
    throw new Error('Invalid Portfolio chains')
  }
  const parsedChains = record.chains.map(chain => parseChainView(chain, chains, assets))
  if (new Set(parsedChains.map(chain => chain.chain.id)).size !== parsedChains.length) {
    throw new Error('Duplicate Portfolio chain')
  }
  const derivedStatus = deriveStatus(parsedChains)
  if (record.status !== derivedStatus) {
    throw new Error('Portfolio status does not match its chain states')
  }
  if (!Array.isArray(record.assets) || record.assets.length > PORTFOLIO_READ_LIMITS.balancesTotal) {
    throw new Error('Invalid Portfolio assets')
  }
  const flattenedAssets = parsedChains.flatMap(chain => chain.assets)
  const topLevelAssets = record.assets.map(asset => parseAssetView(asset, assets))
  if (
    topLevelAssets.length !== flattenedAssets.length ||
    topLevelAssets.some((asset, index) => !canonicalValuesEqual(asset, flattenedAssets[index]))
  ) {
    throw new Error('Portfolio assets do not match the chain views')
  }
  if (
    !Number.isSafeInteger(record.ignoredAssetCount) ||
    (record.ignoredAssetCount as number) < 0 ||
    (record.ignoredAssetCount as number) > PORTFOLIO_READ_LIMITS.balancesTotal
  ) {
    throw new Error('Invalid ignored Portfolio asset count')
  }
  return Object.freeze({
    scope: Object.freeze({
      keyDomainId: parseKeyDomainId(scope.keyDomainId),
      accountId: parseAccountId(scope.accountId)
    }),
    status: derivedStatus,
    chains: Object.freeze(parsedChains),
    assets: Object.freeze(topLevelAssets),
    ignoredAssetCount: record.ignoredAssetCount as number,
    ...(record.confidential === undefined
      ? {}
      : { confidential: parseConfidentialView(record.confidential) })
  })
}
