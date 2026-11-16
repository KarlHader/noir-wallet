import type { AssetDisplayMetadata } from '@/core/chains/domain'
import {
  createAssetRegistry,
  parseAssetId,
  type AssetDefinitionInput,
  type ChainRegistry
} from '@/core/chains/registry'

export interface UserEvmAssetCandidate {
  readonly assetId: string
  readonly chainId: string
  readonly contractAddress: `0x${string}`
  readonly metadata: AssetDisplayMetadata
  readonly inspectedAt: number
}

export interface UserEvmAssetRecord {
  readonly assetId: string
  readonly chainId: string
  readonly contractAddress: `0x${string}`
  readonly metadata: AssetDisplayMetadata
  readonly source: UserEvmAssetSource
  readonly addedAt: number
}

export type UserEvmAssetSource = 'user-added' | 'intents-catalog'

interface UserEvmAssetIdentityInput {
  readonly chainId: string
  readonly contractAddress: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
  )
}

function readTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${label}`)
  return value as number
}

export function normalizeUserEvmAssetIdentity(
  chains: ChainRegistry,
  input: UserEvmAssetIdentityInput
): Readonly<{
  assetId: string
  chainId: string
  contractAddress: `0x${string}`
}> {
  const chain = chains.resolve(input.chainId)
  if (chain.family !== 'evm') throw new Error('A user EVM Token requires an EVM chain')
  if (
    !/^0x[0-9a-fA-F]{40}$/.test(input.contractAddress) ||
    /^0x0{40}$/i.test(input.contractAddress)
  ) {
    throw new Error('Invalid ERC-20 contract address')
  }
  const contractAddress = input.contractAddress.toLowerCase() as `0x${string}`
  return Object.freeze({
    assetId: `${chain.id}/erc20:${contractAddress}`,
    chainId: chain.id,
    contractAddress
  })
}

function validatedMetadata(
  chains: ChainRegistry,
  identity: ReturnType<typeof normalizeUserEvmAssetIdentity>,
  metadata: unknown
): AssetDisplayMetadata {
  const expectedKeys =
    isRecord(metadata) && metadata.iconUrl !== undefined
      ? ['name', 'symbol', 'decimals', 'iconUrl']
      : ['name', 'symbol', 'decimals']
  if (
    !isRecord(metadata) ||
    !hasExactKeys(metadata, expectedKeys) ||
    typeof metadata.name !== 'string' ||
    typeof metadata.symbol !== 'string' ||
    typeof metadata.decimals !== 'number' ||
    (metadata.iconUrl !== undefined && typeof metadata.iconUrl !== 'string')
  ) {
    throw new Error('Invalid user EVM Token metadata')
  }
  const registry = createAssetRegistry(chains, [
    {
      chainId: identity.chainId,
      namespace: 'erc20',
      reference: identity.contractAddress,
      kind: 'token',
      metadata: {
        name: metadata.name,
        symbol: metadata.symbol,
        decimals: metadata.decimals,
        ...(metadata.iconUrl === undefined ? {} : { iconUrl: metadata.iconUrl })
      },
      source: 'user-added',
      verification: 'user-approved'
    }
  ])
  return registry.resolve(identity.assetId).metadata
}

export function createUserEvmAssetCandidate(
  chains: ChainRegistry,
  input: UserEvmAssetIdentityInput & {
    readonly metadata: unknown
    readonly inspectedAt: number
  }
): UserEvmAssetCandidate {
  const identity = normalizeUserEvmAssetIdentity(chains, input)
  return Object.freeze({
    ...identity,
    metadata: validatedMetadata(chains, identity, input.metadata),
    inspectedAt: readTimestamp(input.inspectedAt, 'user EVM Token inspection timestamp')
  })
}

export function parseUserEvmAssetCandidate(
  chains: ChainRegistry,
  value: unknown
): UserEvmAssetCandidate {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['assetId', 'chainId', 'contractAddress', 'metadata', 'inspectedAt']) ||
    typeof value.assetId !== 'string' ||
    typeof value.chainId !== 'string' ||
    typeof value.contractAddress !== 'string' ||
    !isRecord(value.metadata)
  ) {
    throw new Error('Invalid user EVM Token candidate')
  }
  const candidate = createUserEvmAssetCandidate(chains, {
    chainId: value.chainId,
    contractAddress: value.contractAddress,
    metadata: value.metadata,
    inspectedAt: readTimestamp(value.inspectedAt, 'user EVM Token inspection timestamp')
  })
  if (
    candidate.assetId !== value.assetId ||
    candidate.chainId !== value.chainId ||
    candidate.contractAddress !== value.contractAddress
  ) {
    throw new Error('User EVM Token candidate identity is not canonical')
  }
  return candidate
}

export function createUserEvmAssetRecord(
  chains: ChainRegistry,
  candidate: UserEvmAssetCandidate,
  addedAt: number,
  source: UserEvmAssetSource = 'user-added'
): UserEvmAssetRecord {
  const parsed = parseUserEvmAssetCandidate(chains, candidate)
  if (source !== 'user-added' && source !== 'intents-catalog') {
    throw new Error('Invalid user EVM Token source')
  }
  return Object.freeze({
    assetId: parsed.assetId,
    chainId: parsed.chainId,
    contractAddress: parsed.contractAddress,
    metadata: parsed.metadata,
    source,
    addedAt: readTimestamp(addedAt, 'user EVM Token addition timestamp')
  })
}

export function parseUserEvmAssetRecord(chains: ChainRegistry, value: unknown): UserEvmAssetRecord {
  const expectedKeys =
    isRecord(value) && value.source !== undefined
      ? ['assetId', 'chainId', 'contractAddress', 'metadata', 'source', 'addedAt']
      : ['assetId', 'chainId', 'contractAddress', 'metadata', 'addedAt']
  if (
    !isRecord(value) ||
    !hasExactKeys(value, expectedKeys) ||
    typeof value.assetId !== 'string' ||
    typeof value.chainId !== 'string' ||
    typeof value.contractAddress !== 'string' ||
    !isRecord(value.metadata) ||
    (value.source !== undefined &&
      value.source !== 'user-added' &&
      value.source !== 'intents-catalog')
  ) {
    throw new Error('Invalid stored user EVM Token')
  }
  const identity = normalizeUserEvmAssetIdentity(chains, {
    chainId: value.chainId,
    contractAddress: value.contractAddress
  })
  const asset = parseAssetId(value.assetId)
  if (
    asset.id !== identity.assetId ||
    value.assetId !== identity.assetId ||
    value.chainId !== identity.chainId ||
    value.contractAddress !== identity.contractAddress
  ) {
    throw new Error('Stored user EVM Token identity is not canonical')
  }
  return Object.freeze({
    ...identity,
    metadata: validatedMetadata(chains, identity, value.metadata),
    source: (value.source as UserEvmAssetSource | undefined) ?? 'user-added',
    addedAt: readTimestamp(value.addedAt, 'user EVM Token addition timestamp')
  })
}

export function userEvmAssetToDefinition(record: UserEvmAssetRecord): AssetDefinitionInput {
  const protocolCatalogAsset = record.source === 'intents-catalog'
  return Object.freeze({
    chainId: record.chainId,
    namespace: 'erc20',
    reference: record.contractAddress,
    kind: 'token',
    metadata: record.metadata,
    source: protocolCatalogAsset ? 'discovered' : 'user-added',
    verification: protocolCatalogAsset ? 'unverified' : 'user-approved'
  })
}
