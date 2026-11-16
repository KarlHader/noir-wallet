import type { AssetDisplayMetadata } from '@/core/chains/domain'
import type { AssetDefinitionInput, ChainRegistry } from '@/core/chains/registry'
import { createUserEvmAssetCandidate, normalizeUserEvmAssetIdentity } from './user-evm-asset'

export interface DetectedEvmAssetRecord {
  readonly assetId: string
  readonly chainId: string
  readonly contractAddress: `0x${string}`
  readonly metadata: AssetDisplayMetadata
  readonly detectedAt: number
  readonly lastSeenAt: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function readTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${label}`)
  return value as number
}

export function createDetectedEvmAssetRecord(
  chains: ChainRegistry,
  input: {
    readonly chainId: string
    readonly contractAddress: string
    readonly metadata: unknown
    readonly detectedAt: number
    readonly lastSeenAt: number
  }
): DetectedEvmAssetRecord {
  const identity = normalizeUserEvmAssetIdentity(chains, input)
  const detectedAt = readTimestamp(input.detectedAt, 'detected EVM Token timestamp')
  const lastSeenAt = readTimestamp(input.lastSeenAt, 'detected EVM Token last-seen timestamp')
  if (lastSeenAt < detectedAt) throw new Error('Detected EVM Token timestamps are inconsistent')
  const candidate = createUserEvmAssetCandidate(chains, {
    ...identity,
    metadata: input.metadata,
    inspectedAt: detectedAt
  })
  return Object.freeze({
    ...identity,
    metadata: candidate.metadata,
    detectedAt,
    lastSeenAt
  })
}

export function parseDetectedEvmAssetRecord(
  chains: ChainRegistry,
  value: unknown
): DetectedEvmAssetRecord {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 6 ||
    typeof value.assetId !== 'string' ||
    typeof value.chainId !== 'string' ||
    typeof value.contractAddress !== 'string'
  ) {
    throw new Error('Invalid detected EVM Token')
  }
  const record = createDetectedEvmAssetRecord(chains, {
    chainId: value.chainId,
    contractAddress: value.contractAddress,
    metadata: value.metadata,
    detectedAt: readTimestamp(value.detectedAt, 'detected EVM Token timestamp'),
    lastSeenAt: readTimestamp(value.lastSeenAt, 'detected EVM Token last-seen timestamp')
  })
  if (record.assetId !== value.assetId)
    throw new Error('Detected EVM Token identity is not canonical')
  return record
}

export function detectedEvmAssetToDefinition(record: DetectedEvmAssetRecord): AssetDefinitionInput {
  return Object.freeze({
    chainId: record.chainId,
    namespace: 'erc20',
    reference: record.contractAddress,
    kind: 'token',
    metadata: record.metadata,
    source: 'discovered',
    verification: 'unverified'
  })
}
