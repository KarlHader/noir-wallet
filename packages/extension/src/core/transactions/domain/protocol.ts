import { parseAssetDisplayMetadata, parseAssetId, parseChainId } from '@/core/chains/registry'
import type { AssetDisplayMetadata, AssetId, ChainId } from '@/core/chains/domain'

const RAW_AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,77})$/
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/
const STRING_LIMIT = 512

export interface NearIntentsAssetBinding {
  readonly chainId: ChainId
  readonly assetId: AssetId
  readonly protocolAssetId: string
}

export interface NearIntentsDestinationBinding extends NearIntentsAssetBinding {
  readonly recipient: string
  readonly expectedAmountRaw: string
  readonly minimumAmountRaw: string
}

export interface NearIntentsTransactionBinding {
  readonly schemaVersion: 1
  readonly provider: 'near-intents'
  readonly kind: 'swap' | 'supply'
  readonly depositAddress: string
  readonly refundAddress: string
  readonly expiresAt: number
  readonly origin: NearIntentsAssetBinding
  readonly destination: NearIntentsDestinationBinding
}

export interface RheaSwapAssetBinding {
  readonly chainId: ChainId
  readonly assetId: AssetId
  readonly protocolChainId: string
  readonly protocolAssetId: string
}

export interface RheaSwapDestinationBinding extends RheaSwapAssetBinding {
  readonly recipient: string
  readonly expectedAmountRaw: string
  readonly minimumAmountRaw: string
  readonly metadata?: AssetDisplayMetadata
}

export interface RheaSwapTransactionBinding {
  readonly schemaVersion: 1
  readonly provider: 'rhea-cross-chain-dex'
  readonly kind: 'swap'
  readonly userAction?: 'transfer'
  readonly quoteHandle: string
  readonly executionId: string
  readonly router: string
  readonly sourceTarget: string
  readonly sender: string
  readonly originAmountRaw: string
  readonly expiresAt: number
  readonly isCrossChain: boolean
  readonly origin: RheaSwapAssetBinding
  readonly destination: RheaSwapDestinationBinding
}

export type TransactionProtocolBinding = NearIntentsTransactionBinding | RheaSwapTransactionBinding

export function getTransactionProtocolIntentKind(
  binding: TransactionProtocolBinding
): 'swap' | 'supply' | 'transfer' {
  return binding.provider === 'rhea-cross-chain-dex' && binding.userAction === 'transfer'
    ? 'transfer'
    : binding.kind
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  label: string
): void {
  if (
    Object.keys(value).length !== required.length ||
    required.some(key => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new Error(`${label} has invalid fields`)
  }
}

function parseString(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    value.length > STRING_LIMIT ||
    CONTROL_CHARACTERS.test(value)
  ) {
    throw new Error(`${label} must be a bounded non-empty string`)
  }
  return value
}

function parseRawAmount(value: unknown, label: string): string {
  if (typeof value !== 'string' || !RAW_AMOUNT_PATTERN.test(value)) {
    throw new Error(`${label} must be a base-unit integer`)
  }
  return value
}

function parseAssetBinding(value: unknown, label: string): NearIntentsAssetBinding {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  assertExactKeys(value, ['chainId', 'assetId', 'protocolAssetId'], label)
  const chainId = parseChainId(parseString(value.chainId, `${label}.chainId`)).id
  const assetId = parseAssetId(parseString(value.assetId, `${label}.assetId`)).id
  if (!assetId.startsWith(`${chainId}/`)) {
    throw new Error(`${label} asset does not belong to its chain`)
  }
  return Object.freeze({
    chainId,
    assetId,
    protocolAssetId: parseString(value.protocolAssetId, `${label}.protocolAssetId`)
  })
}

function parseDestinationBinding(value: unknown): NearIntentsDestinationBinding {
  if (!isRecord(value)) throw new Error('Near Intents destination must be an object')
  assertExactKeys(
    value,
    ['chainId', 'assetId', 'protocolAssetId', 'recipient', 'expectedAmountRaw', 'minimumAmountRaw'],
    'Near Intents destination'
  )
  const asset = parseAssetBinding(
    {
      chainId: value.chainId,
      assetId: value.assetId,
      protocolAssetId: value.protocolAssetId
    },
    'Near Intents destination'
  )
  const expectedAmountRaw = parseRawAmount(value.expectedAmountRaw, 'Near Intents expected amount')
  const minimumAmountRaw = parseRawAmount(value.minimumAmountRaw, 'Near Intents minimum amount')
  if (BigInt(minimumAmountRaw) > BigInt(expectedAmountRaw)) {
    throw new Error('Near Intents minimum amount exceeds the expected amount')
  }
  return Object.freeze({
    ...asset,
    recipient: parseString(value.recipient, 'Near Intents recipient'),
    expectedAmountRaw,
    minimumAmountRaw
  })
}

export function parseNearIntentsTransactionBinding(value: unknown): NearIntentsTransactionBinding {
  if (!isRecord(value)) throw new Error('Near Intents binding must be an object')
  assertExactKeys(
    value,
    [
      'schemaVersion',
      'provider',
      'kind',
      'depositAddress',
      'refundAddress',
      'expiresAt',
      'origin',
      'destination'
    ],
    'Near Intents binding'
  )
  if (
    value.schemaVersion !== 1 ||
    value.provider !== 'near-intents' ||
    (value.kind !== 'swap' && value.kind !== 'supply') ||
    !Number.isSafeInteger(value.expiresAt) ||
    (value.expiresAt as number) <= 0
  ) {
    throw new Error('Invalid Near Intents binding')
  }
  return Object.freeze({
    schemaVersion: 1,
    provider: 'near-intents',
    kind: value.kind,
    depositAddress: parseString(value.depositAddress, 'Near Intents deposit address'),
    refundAddress: parseString(value.refundAddress, 'Near Intents refund address'),
    expiresAt: value.expiresAt as number,
    origin: parseAssetBinding(value.origin, 'Near Intents origin'),
    destination: parseDestinationBinding(value.destination)
  })
}

function parseRheaAssetBinding(value: unknown, label: string): RheaSwapAssetBinding {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  assertExactKeys(value, ['chainId', 'assetId', 'protocolChainId', 'protocolAssetId'], label)
  const chainId = parseChainId(parseString(value.chainId, `${label}.chainId`)).id
  const assetId = parseAssetId(parseString(value.assetId, `${label}.assetId`)).id
  if (!assetId.startsWith(`${chainId}/`))
    throw new Error(`${label} asset does not belong to its chain`)
  return Object.freeze({
    chainId,
    assetId,
    protocolChainId: parseString(value.protocolChainId, `${label}.protocolChainId`),
    protocolAssetId: parseString(value.protocolAssetId, `${label}.protocolAssetId`)
  })
}

function parseRheaDestinationBinding(value: unknown): RheaSwapDestinationBinding {
  if (!isRecord(value)) throw new Error('RHEA Swap destination must be an object')
  assertExactKeys(
    value,
    [
      'chainId',
      'assetId',
      'protocolChainId',
      'protocolAssetId',
      'recipient',
      'expectedAmountRaw',
      'minimumAmountRaw',
      ...(value.metadata === undefined ? [] : ['metadata'])
    ],
    'RHEA Swap destination'
  )
  const asset = parseRheaAssetBinding(
    {
      chainId: value.chainId,
      assetId: value.assetId,
      protocolChainId: value.protocolChainId,
      protocolAssetId: value.protocolAssetId
    },
    'RHEA Swap destination'
  )
  const expectedAmountRaw = parseRawAmount(value.expectedAmountRaw, 'RHEA Swap expected amount')
  const minimumAmountRaw = parseRawAmount(value.minimumAmountRaw, 'RHEA Swap minimum amount')
  if (BigInt(minimumAmountRaw) > BigInt(expectedAmountRaw)) {
    throw new Error('RHEA Swap minimum amount exceeds the expected amount')
  }
  return Object.freeze({
    ...asset,
    recipient: parseString(value.recipient, 'RHEA Swap recipient'),
    expectedAmountRaw,
    minimumAmountRaw,
    ...(value.metadata === undefined ? {} : { metadata: parseAssetDisplayMetadata(value.metadata) })
  })
}

export function parseRheaSwapTransactionBinding(value: unknown): RheaSwapTransactionBinding {
  if (!isRecord(value)) throw new Error('RHEA Swap binding must be an object')
  assertExactKeys(
    value,
    [
      'schemaVersion',
      'provider',
      'kind',
      'quoteHandle',
      'executionId',
      'router',
      'sourceTarget',
      'sender',
      'originAmountRaw',
      'expiresAt',
      'isCrossChain',
      'origin',
      'destination',
      ...(value.userAction === undefined ? [] : ['userAction'])
    ],
    'RHEA Swap binding'
  )
  if (
    value.schemaVersion !== 1 ||
    value.provider !== 'rhea-cross-chain-dex' ||
    value.kind !== 'swap' ||
    (value.userAction !== undefined && value.userAction !== 'transfer') ||
    !Number.isSafeInteger(value.expiresAt) ||
    (value.expiresAt as number) <= 0 ||
    typeof value.isCrossChain !== 'boolean'
  ) {
    throw new Error('Invalid RHEA Swap binding')
  }
  return Object.freeze({
    schemaVersion: 1,
    provider: 'rhea-cross-chain-dex',
    kind: 'swap',
    ...(value.userAction === undefined ? {} : { userAction: 'transfer' as const }),
    quoteHandle: parseString(value.quoteHandle, 'RHEA Swap quote handle'),
    executionId: parseString(value.executionId, 'RHEA Swap execution ID'),
    router: parseString(value.router, 'RHEA Swap router'),
    sourceTarget: parseString(value.sourceTarget, 'RHEA Swap source target'),
    sender: parseString(value.sender, 'RHEA Swap sender'),
    originAmountRaw: parseRawAmount(value.originAmountRaw, 'RHEA Swap input amount'),
    expiresAt: value.expiresAt as number,
    isCrossChain: value.isCrossChain,
    origin: parseRheaAssetBinding(value.origin, 'RHEA Swap origin'),
    destination: parseRheaDestinationBinding(value.destination)
  })
}

export function parseTransactionProtocolBinding(value: unknown): TransactionProtocolBinding {
  if (!isRecord(value)) throw new Error('Transaction protocol binding must be an object')
  return value.provider === 'rhea-cross-chain-dex'
    ? parseRheaSwapTransactionBinding(value)
    : parseNearIntentsTransactionBinding(value)
}

export function assertNearIntentsTransferBinding(input: {
  readonly binding: NearIntentsTransactionBinding
  readonly chainId: string
  readonly assetId: string
  readonly recipient: string
  readonly amountRaw: string
  readonly now: number
}): NearIntentsTransactionBinding {
  const binding = parseNearIntentsTransactionBinding(input.binding)
  if (
    binding.origin.chainId !== input.chainId ||
    binding.origin.assetId !== input.assetId ||
    binding.depositAddress !== input.recipient ||
    !RAW_AMOUNT_PATTERN.test(input.amountRaw) ||
    binding.expiresAt <= input.now
  ) {
    throw new Error('Near Intents binding does not match the source transfer')
  }
  return binding
}
