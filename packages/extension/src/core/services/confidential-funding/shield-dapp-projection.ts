import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import type { ConfidentialPortfolioView } from '@/core/portfolio'
import { getZcashChainId } from '@/core/chains/registry'
import type { SwapToken } from '@/core/services/intents-api'
import type { IntentsManagedAsset } from '@/core/services/intents-managed-assets'
import type { Network } from '@/types'
import type { ConfidentialPortfolioAssetMapping } from './confidential-funding-portfolio'

export interface ShieldDappBalance {
  readonly symbol: string
  readonly chainId: string
  readonly chainName: string
  readonly assetId: string
  readonly amount: string
}

/** Public balance rows for a dApp. Amounts are decimal strings, not raw base units. */
export function projectShieldDappBalances(
  view: ConfidentialPortfolioView,
  chainNameFor: (chainId: string) => string
): readonly ShieldDappBalance[] {
  const rows = view.assets.map(asset => {
    const chainId = asset.chainId ?? ''
    const amount =
      asset.decimals === undefined
        ? asset.availableRaw
        : formatBaseUnitDecimalAmount(asset.availableRaw, asset.decimals)
    return Object.freeze({
      symbol: asset.symbol && asset.symbol.length > 0 ? asset.symbol : asset.protocolAssetId,
      chainId,
      chainName: chainId.length > 0 ? chainNameFor(chainId) : '',
      assetId: asset.assetId ?? asset.protocolAssetId,
      amount
    })
  })
  rows.sort((left, right) => {
    const leftKey = `${left.symbol}:${left.chainName}`
    const rightKey = `${right.symbol}:${right.chainName}`
    if (leftKey < rightKey) return -1
    if (leftKey > rightKey) return 1
    return 0
  })
  return Object.freeze(rows)
}

export interface ShieldDappChain {
  readonly chainId: string
  readonly name: string
}

export interface ShieldDappToken {
  readonly chainId: string
  readonly assetId: string
  readonly symbol: string
  readonly decimals: number
}

/**
 * Destination chain keeps the source token. A shared identity wins over the
 * symbol. Without an identity, the symbol is used only when it is unique.
 */
export function selectShieldSameTokenAsset(input: {
  readonly sourceAssetId: string
  readonly sourceSymbol: string
  readonly destinationChainId: string
  readonly tokens: readonly ShieldDappToken[]
  readonly identityFor: (assetId: string) => string | null
}): ShieldDappToken | null {
  const onChain = input.tokens.filter(token => token.chainId === input.destinationChainId)
  const source = onChain.find(token => token.assetId === input.sourceAssetId)
  if (source) return source
  const sourceIdentity = input.identityFor(input.sourceAssetId)
  if (sourceIdentity) {
    const matches = onChain.filter(token => input.identityFor(token.assetId) === sourceIdentity)
    return matches.length === 1 ? matches[0] : null
  }
  const symbols = onChain.filter(token => token.symbol === input.sourceSymbol)
  return symbols.length === 1 ? symbols[0] : null
}

interface CatalogAsset {
  readonly asset: {
    readonly chainId: string
    readonly kind: string
  }
  readonly metadata: {
    readonly decimals: number
  }
}

function compareCodePoint(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/**
 * Shield funding candidates already used by the wallet: managed EVM tokens,
 * plus mapped native EVM assets and ZEC. Route quotes are not evaluated here.
 */
export function projectShieldDappCatalog(input: {
  readonly tokens: readonly SwapToken[]
  readonly managedAssets: readonly IntentsManagedAsset[]
  readonly mappings: readonly ConfidentialPortfolioAssetMapping[]
  readonly assets: { readonly get: (assetId: string) => CatalogAsset | undefined }
  readonly network: Network
  readonly acceptChain: (chainId: string) => boolean
  readonly chainNameFor: (chainId: string) => string
}): Readonly<{ chains: readonly ShieldDappChain[]; tokens: readonly ShieldDappToken[] }> {
  const tokenById = new Map(input.tokens.map(token => [token.assetId, token]))
  const zcashChainId = getZcashChainId(input.network)
  const seen = new Set<string>()
  const rows: ShieldDappToken[] = []
  const push = (row: ShieldDappToken, protocolAssetId: string) => {
    if (seen.has(protocolAssetId) || !input.acceptChain(row.chainId)) return
    if (!Number.isInteger(row.decimals) || row.decimals < 0 || row.decimals > 255) return
    if (row.symbol.trim().length === 0 || row.assetId.length === 0 || row.chainId.length === 0) {
      return
    }
    seen.add(protocolAssetId)
    rows.push(
      Object.freeze({
        chainId: row.chainId,
        assetId: row.assetId,
        symbol: row.symbol.trim(),
        decimals: row.decimals
      })
    )
  }
  for (const managed of input.managedAssets) {
    if (managed.management !== 'evm') continue
    const token = tokenById.get(managed.protocolAssetId)
    if (!token || token.decimals !== managed.decimals || token.blockchain !== managed.blockchain) {
      continue
    }
    push(
      {
        chainId: managed.chainId,
        assetId: managed.assetId,
        symbol: token.symbol,
        decimals: token.decimals
      },
      managed.protocolAssetId
    )
  }
  for (const mapping of input.mappings) {
    const entry = input.assets.get(mapping.assetId)
    const token = tokenById.get(mapping.protocolAssetId)
    if (
      !entry ||
      entry.asset.kind !== 'native' ||
      !(entry.asset.chainId.startsWith('eip155:') || entry.asset.chainId === zcashChainId) ||
      !token ||
      token.decimals !== entry.metadata.decimals
    ) {
      continue
    }
    push(
      {
        chainId: entry.asset.chainId,
        assetId: mapping.assetId,
        symbol: token.symbol,
        decimals: token.decimals
      },
      mapping.protocolAssetId
    )
  }
  rows.sort((left, right) => {
    const symbol = compareCodePoint(left.symbol, right.symbol)
    if (symbol !== 0) return symbol
    const chain = compareCodePoint(left.chainId, right.chainId)
    if (chain !== 0) return chain
    return compareCodePoint(left.assetId, right.assetId)
  })
  const chains = [...new Set(rows.map(row => row.chainId))]
    .sort(compareCodePoint)
    .map(chainId => Object.freeze({ chainId, name: input.chainNameFor(chainId) }))
  return Object.freeze({ chains: Object.freeze(chains), tokens: Object.freeze(rows) })
}

export function projectShieldDappQuote(input: {
  readonly action: 'receive' | 'transfer'
  readonly amountRaw: string
  readonly amountOutRaw: string
  readonly sourceDecimals: number
  readonly destinationDecimals: number
  readonly sameAsset: boolean
  readonly expiresAt: number
  readonly source: Readonly<{ chainId: string; assetId: string; symbol: string }>
  readonly destination: Readonly<{ chainId: string; assetId: string; symbol: string }>
}): Readonly<{
  layer: 'near-confidential'
  action: 'receive' | 'transfer'
  amount: string
  fee: string
  expectedReceive: string
  expiresAt: number
  source: Readonly<{ chainId: string; assetId: string; symbol: string }>
  destination: Readonly<{ chainId: string; assetId: string; symbol: string }>
}> {
  const inputRaw = BigInt(input.amountRaw)
  const outputRaw = BigInt(input.amountOutRaw)
  const feeRaw = input.sameAsset && inputRaw > outputRaw ? (inputRaw - outputRaw).toString() : '0'
  const feeDecimals = input.sameAsset ? input.sourceDecimals : input.destinationDecimals
  return Object.freeze({
    layer: 'near-confidential',
    action: input.action,
    amount: formatBaseUnitDecimalAmount(input.amountRaw, input.sourceDecimals),
    fee: formatBaseUnitDecimalAmount(feeRaw, feeDecimals),
    expectedReceive: formatBaseUnitDecimalAmount(input.amountOutRaw, input.destinationDecimals),
    expiresAt: input.expiresAt,
    source: Object.freeze({ ...input.source }),
    destination: Object.freeze({ ...input.destination })
  })
}

export type ShieldDappOperationStatus =
  | 'awaiting-approval'
  | 'needs-auth'
  | 'authorized'
  | 'signing'
  | 'submitting'
  | 'processing'
  | 'awaiting-payment'
  | 'pending-refund'
  | 'ready'
  | 'partial'
  | 'refunded'
  | 'failed'
  | 'expired'
  | 'cancelled'
  | 'unknown'
  | 'unavailable'

export interface ShieldDappStatusProjection {
  readonly status: ShieldDappOperationStatus
  readonly providerStatus?: string
}

export interface ShieldDappOperationAsset {
  readonly chainId: string
  readonly assetId: string
  readonly symbol?: string
  readonly amount?: string
}

export interface ShieldDappOperationReferences {
  readonly transactionHashes?: readonly string[]
  readonly orderId?: string
}

export interface ShieldDappOperationDetails {
  readonly source?: ShieldDappOperationAsset
  readonly destination?: ShieldDappOperationAsset
  readonly references?: ShieldDappOperationReferences
  readonly depositAddress?: string
  readonly depositMemo?: string
}

export interface ShieldDappOperationReport {
  readonly id: string
  readonly layer: 'near-confidential'
  readonly action?: 'receive' | 'transfer'
  readonly status: ShieldDappOperationStatus
  readonly providerStatus?: string
  readonly source?: ShieldDappOperationAsset
  readonly destination?: ShieldDappOperationAsset
  readonly references?: ShieldDappOperationReferences
  readonly depositAddress?: string
  readonly depositMemo?: string
}

const SHIELD_REFUND_IN_PROGRESS = 'PENDING_REFUND'
const SHIELD_SIGNING_PHASES = new Set(['deposit-signed', 'deposit-confirming', 'signing-withdraws'])
const SHIELD_PLAN_TERMINAL = new Set([
  'ready',
  'partial',
  'refunded',
  'failed',
  'expired',
  'cancelled'
])
const SHIELD_DEPOSIT_TERMINAL = new Set(['ready', 'refunded', 'failed'])

function shieldProtocolStatus(value: string | undefined): string {
  return value?.trim().toUpperCase() ?? ''
}

function shieldStatusProjection(
  status: ShieldDappOperationStatus,
  providerStatus: string | undefined
): ShieldDappStatusProjection {
  const text = providerStatus?.trim() ?? ''
  return Object.freeze(text.length > 0 ? { status, providerStatus: text } : { status })
}

/**
 * Public status for a stored confidential plan.
 * Internal phase names stay in the wallet. PENDING_REFUND is pending only before a terminal phase.
 */
export function projectShieldDappPlanStatus(plan: {
  readonly phase: string
  readonly backendStatus?: string
  readonly errorStatus?: string
}): ShieldDappStatusProjection {
  const providerStatus = plan.backendStatus ?? plan.errorStatus
  if (
    shieldProtocolStatus(plan.backendStatus) === SHIELD_REFUND_IN_PROGRESS &&
    !SHIELD_PLAN_TERMINAL.has(plan.phase)
  ) {
    return shieldStatusProjection('pending-refund', providerStatus)
  }
  if (plan.phase === 'prepared') return Object.freeze({ status: 'awaiting-approval' })
  if (plan.phase === 'needs-auth') return Object.freeze({ status: 'needs-auth' })
  if (plan.phase === 'authorized') return Object.freeze({ status: 'authorized' })
  if (SHIELD_SIGNING_PHASES.has(plan.phase))
    return shieldStatusProjection('signing', providerStatus)
  switch (plan.phase) {
    case 'submitting':
      return shieldStatusProjection('submitting', providerStatus)
    case 'processing':
      return shieldStatusProjection('processing', providerStatus)
    case 'partial':
      return shieldStatusProjection('partial', providerStatus)
    case 'ready':
      return shieldStatusProjection('ready', providerStatus)
    case 'refunded':
      return shieldStatusProjection('refunded', providerStatus)
    case 'failed':
      return shieldStatusProjection('failed', providerStatus)
    case 'expired':
      return shieldStatusProjection('expired', providerStatus)
    case 'cancelled':
      return shieldStatusProjection('cancelled', providerStatus)
    default:
      return shieldStatusProjection('unknown', providerStatus)
  }
}

/**
 * Public status for an external Shield deposit.
 * A protocol EXPIRED observation stays on awaiting-payment.
 */
export function projectShieldDappDepositStatus(record: {
  readonly phase: string
  readonly providerStatus?: string
}): ShieldDappStatusProjection {
  const providerStatus = record.providerStatus
  if (
    shieldProtocolStatus(providerStatus) === SHIELD_REFUND_IN_PROGRESS &&
    !SHIELD_DEPOSIT_TERMINAL.has(record.phase)
  ) {
    return shieldStatusProjection('pending-refund', providerStatus)
  }
  switch (record.phase) {
    case 'awaiting-payment':
      return shieldStatusProjection('awaiting-payment', providerStatus)
    case 'processing':
      return shieldStatusProjection('processing', providerStatus)
    case 'ready':
      return shieldStatusProjection('ready', providerStatus)
    case 'refunded':
      return shieldStatusProjection('refunded', providerStatus)
    case 'failed':
      return shieldStatusProjection('failed', providerStatus)
    default:
      return shieldStatusProjection('unknown', providerStatus)
  }
}

export function shieldDappPlanAction(plan: {
  readonly operation?: 'deposit' | 'withdraw' | 'cluster' | 'swap' | 'confidential-transfer'
  readonly sourceDomain?: 'public' | 'private' | 'shield'
  readonly destinationDomain?: 'public' | 'private' | 'shield'
}): 'receive' | 'transfer' {
  if (plan.operation === 'deposit') return 'receive'
  if (
    plan.operation === 'withdraw' ||
    plan.operation === 'swap' ||
    plan.operation === 'cluster' ||
    plan.operation === 'confidential-transfer'
  ) {
    return 'transfer'
  }
  if (plan.destinationDomain === 'shield' && plan.sourceDomain !== 'shield') return 'receive'
  return 'transfer'
}

function shieldPublicId(value: string | undefined, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    !/\s/.test(value)
  )
}

function shieldDisplayAmount(
  amountRaw: string | undefined,
  decimals: number | undefined
): string | undefined {
  if (amountRaw === undefined || decimals === undefined) return undefined
  try {
    return formatBaseUnitDecimalAmount(amountRaw, decimals)
  } catch {
    return undefined
  }
}

function shieldOperationAsset(
  input:
    | {
        readonly chainId?: string
        readonly assetId?: string
        readonly amountRaw?: string
        readonly symbol?: string
        readonly decimals?: number
      }
    | undefined
): ShieldDappOperationAsset | undefined {
  if (!input || !shieldPublicId(input.chainId, 128) || !shieldPublicId(input.assetId, 256)) {
    return undefined
  }
  const amount = shieldDisplayAmount(input.amountRaw, input.decimals)
  const symbol =
    typeof input.symbol === 'string' &&
    input.symbol.trim() === input.symbol &&
    input.symbol.length > 0 &&
    input.symbol.length <= 32
      ? input.symbol
      : undefined
  return Object.freeze({
    chainId: input.chainId,
    assetId: input.assetId,
    ...(symbol ? { symbol } : {}),
    ...(amount !== undefined ? { amount } : {})
  })
}

/**
 * Positive same-decimals quote difference. A cross-decimal raw subtraction is not a fee.
 */
export function shieldSameDecimalsQuoteDifferenceRaw(
  sourceAmountRaw: string,
  expectedOutputRaw: string,
  sameDecimals: boolean
): string | null {
  if (!sameDecimals) return null
  if (!/^(0|[1-9][0-9]*)$/.test(sourceAmountRaw) || !/^(0|[1-9][0-9]*)$/.test(expectedOutputRaw)) {
    return null
  }
  const difference = BigInt(sourceAmountRaw) - BigInt(expectedOutputRaw)
  return difference > 0n ? difference.toString() : null
}

/**
 * Public source, destination, and transaction references for one stored Shield operation.
 * Amounts are decimal strings. Missing decimals, chains, or hashes are omitted.
 */
export function projectShieldDappOperationDetails(input: {
  readonly source?: {
    readonly chainId?: string
    readonly assetId?: string
    readonly amountRaw?: string
    readonly symbol?: string
    readonly decimals?: number
  }
  readonly destination?: {
    readonly chainId?: string
    readonly assetId?: string
    readonly amountRaw?: string
    readonly symbol?: string
    readonly decimals?: number
  }
  readonly transactionHashes?: readonly string[]
  readonly orderId?: string
}): ShieldDappOperationDetails {
  const source = shieldOperationAsset(input.source)
  const destination = shieldOperationAsset(input.destination)
  const transactionHashes = Object.freeze([
    ...new Set((input.transactionHashes ?? []).filter(hash => shieldPublicId(hash, 256)))
  ])
  const orderId = shieldPublicId(input.orderId, 128) ? input.orderId : undefined
  const references =
    transactionHashes.length > 0 || orderId
      ? Object.freeze({
          ...(transactionHashes.length > 0 ? { transactionHashes } : {}),
          ...(orderId ? { orderId } : {})
        })
      : undefined
  return Object.freeze({
    ...(source ? { source } : {}),
    ...(destination ? { destination } : {}),
    ...(references ? { references } : {})
  })
}

export function shieldDappOperationReport(
  id: string,
  action: 'receive' | 'transfer' | undefined,
  projection: ShieldDappStatusProjection,
  details?: ShieldDappOperationDetails
): ShieldDappOperationReport {
  return Object.freeze({
    id,
    layer: 'near-confidential',
    ...(action ? { action } : {}),
    status: projection.status,
    ...(projection.providerStatus ? { providerStatus: projection.providerStatus } : {}),
    ...(details?.source ? { source: details.source } : {}),
    ...(details?.destination ? { destination: details.destination } : {}),
    ...(details?.references ? { references: details.references } : {}),
    ...(details?.depositAddress ? { depositAddress: details.depositAddress } : {}),
    ...(details?.depositMemo ? { depositMemo: details.depositMemo } : {})
  })
}

export function unknownShieldDappOperation(id: string): ShieldDappOperationReport {
  return Object.freeze({
    id,
    layer: 'near-confidential',
    status: 'unknown'
  })
}
