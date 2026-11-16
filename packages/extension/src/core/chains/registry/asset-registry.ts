import type { Asset, AssetDisplayMetadata, AssetId, AssetKind, ChainId } from '@/core/chains/domain'
import type { ChainDefinition, ChainRegistry } from './chain-registry'
import type { ChainFamily } from './capabilities'
import { assertAssetNamespace, assertAssetReference, createAssetId, parseAssetId } from './asset-id'
import { parseChainId } from './caip2'

export type AssetSource = 'bundled' | 'protocol' | 'user-added' | 'discovered'
export type AssetVerification = 'trusted' | 'user-approved' | 'unverified' | 'blocked'

export interface AssetRegistryEntry {
  readonly asset: Asset
  readonly metadata: AssetDisplayMetadata
  readonly source: AssetSource
  readonly verification: AssetVerification
}

export interface AssetDefinitionInput {
  readonly chainId: string
  readonly namespace: string
  readonly reference: string
  readonly kind: AssetKind
  readonly metadata: AssetDisplayMetadata
  readonly source: AssetSource
  readonly verification: AssetVerification
}

export interface AssetReferenceValidator {
  readonly chainFamily: ChainFamily
  readonly namespace: string
  readonly normalize: (reference: string, chain: ChainDefinition) => string
}

export interface AssetRegistry {
  readonly list: (chainId?: ChainId) => readonly AssetRegistryEntry[]
  readonly listQuarantined: (chainId?: ChainId) => readonly AssetRegistryEntry[]
  readonly get: (assetId: string) => AssetRegistryEntry | undefined
  readonly resolve: (assetId: string) => AssetRegistryEntry
  readonly inspect: (assetId: string) => AssetRegistryEntry | undefined
}

const DISPLAY_CONTROL_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/
const MAX_ASSET_NAME_CODE_POINTS = 128
const MAX_ASSET_SYMBOL_CODE_POINTS = 32
const MAX_ASSET_DECIMALS = 255
const MAX_ASSET_ICON_URL_LENGTH = 2_048
const ASSET_KINDS = new Set<AssetKind>(['native', 'token'])
const ASSET_SOURCES = new Set<AssetSource>(['bundled', 'protocol', 'user-added', 'discovered'])
const ASSET_VERIFICATIONS = new Set<AssetVerification>([
  'trusted',
  'user-approved',
  'unverified',
  'blocked'
])

export const EVM_ERC20_REFERENCE_VALIDATOR = Object.freeze<AssetReferenceValidator>({
  chainFamily: 'evm',
  namespace: 'erc20',
  normalize: reference => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(reference) || /^0x0{40}$/i.test(reference)) {
      throw new Error('Invalid ERC-20 contract address')
    }
    return reference.toLowerCase()
  }
})

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function isBase58PublicKey(value: string): boolean {
  if (value.length === 0 || value.length > 44) return false
  const bytes = [0]
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character)
    if (digit < 0) return false
    let carry = digit
    for (let index = 0; index < bytes.length; index += 1) {
      carry += bytes[index] * 58
      bytes[index] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  let leadingZeroBytes = 0
  while (value[leadingZeroBytes] === '1') leadingZeroBytes += 1
  const significantBytes = bytes.length === 1 && bytes[0] === 0 ? 0 : bytes.length
  return leadingZeroBytes + significantBytes === 32
}

export const SOLANA_TOKEN_REFERENCE_VALIDATOR = Object.freeze<AssetReferenceValidator>({
  chainFamily: 'solana',
  namespace: 'token',
  normalize: reference => {
    if (!isBase58PublicKey(reference)) throw new Error('Invalid Solana token mint')
    return reference
  }
})

export const NEAR_NEP141_REFERENCE_VALIDATOR = Object.freeze<AssetReferenceValidator>({
  chainFamily: 'near',
  namespace: 'nep141',
  normalize: reference => {
    const decoded = reference.replace(/%5f/gi, '_')
    if (
      decoded.length < 2 ||
      decoded.length > 64 ||
      !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(decoded)
    ) {
      throw new Error('Invalid NEAR fungible token contract ID')
    }
    return decoded.replace(/_/g, '%5F')
  }
})

function validatorKey(chainFamily: ChainFamily, namespace: string): string {
  return `${chainFamily}/${namespace}`
}

function normalizeDisplayValue(value: string, label: string, maximumCodePoints: number): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`)
  }
  const normalized = value.normalize('NFC')
  if (
    normalized.length === 0 ||
    normalized.trim() !== normalized ||
    [...normalized].length > maximumCodePoints ||
    DISPLAY_CONTROL_CHARACTERS.test(normalized)
  ) {
    throw new Error(`Invalid ${label}`)
  }
  return normalized
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value)
  return (
    actual.length === expected.length &&
    expected.every(key => Object.prototype.hasOwnProperty.call(value, key))
  )
}

export function parseAssetDisplayMetadata(value: unknown): AssetDisplayMetadata {
  const expectedKeys =
    isRecord(value) && value.iconUrl !== undefined
      ? ['name', 'symbol', 'decimals', 'iconUrl']
      : ['name', 'symbol', 'decimals']
  if (
    !isRecord(value) ||
    !hasExactKeys(value, expectedKeys) ||
    typeof value.name !== 'string' ||
    typeof value.symbol !== 'string' ||
    typeof value.decimals !== 'number' ||
    (value.iconUrl !== undefined && typeof value.iconUrl !== 'string')
  ) {
    throw new Error('Invalid asset metadata')
  }
  const name = normalizeDisplayValue(value.name, 'asset name', MAX_ASSET_NAME_CODE_POINTS)
  const symbol = normalizeDisplayValue(value.symbol, 'asset symbol', MAX_ASSET_SYMBOL_CODE_POINTS)
  if (
    !Number.isSafeInteger(value.decimals) ||
    value.decimals < 0 ||
    value.decimals > MAX_ASSET_DECIMALS
  ) {
    throw new Error(`Asset decimals must be an integer between 0 and ${MAX_ASSET_DECIMALS}`)
  }
  let iconUrl: string | undefined
  if (value.iconUrl !== undefined) {
    if (value.iconUrl.length === 0 || value.iconUrl.length > MAX_ASSET_ICON_URL_LENGTH) {
      throw new Error('Invalid asset icon URL')
    }
    let parsedIconUrl: URL
    try {
      parsedIconUrl = new URL(value.iconUrl)
    } catch {
      throw new Error('Invalid asset icon URL')
    }
    if (
      parsedIconUrl.protocol !== 'https:' ||
      parsedIconUrl.username.length > 0 ||
      parsedIconUrl.password.length > 0 ||
      parsedIconUrl.hash.length > 0
    ) {
      throw new Error('Invalid asset icon URL')
    }
    iconUrl = parsedIconUrl.toString()
  }
  return Object.freeze({
    name,
    symbol,
    decimals: value.decimals,
    ...(iconUrl ? { iconUrl } : {})
  })
}

function assertSourceVerification(source: AssetSource, verification: AssetVerification): void {
  if (verification === 'blocked') return
  const expected: Record<AssetSource, Exclude<AssetVerification, 'blocked'>> = {
    bundled: 'trusted',
    protocol: 'trusted',
    'user-added': 'user-approved',
    discovered: 'unverified'
  }
  if (verification !== expected[source]) {
    throw new Error(`Asset source ${source} cannot use verification ${verification}`)
  }
}

function normalizeNativeReference(reference: string): string {
  if (!/^(0|[1-9][0-9]{0,127})$/.test(reference)) {
    throw new Error('Invalid SLIP-44 asset reference')
  }
  return reference
}

function createValidatorMap(
  validators: readonly AssetReferenceValidator[]
): ReadonlyMap<string, AssetReferenceValidator> {
  const byKey = new Map<string, AssetReferenceValidator>()
  for (const validator of validators) {
    assertAssetNamespace(validator.namespace)
    const key = validatorKey(validator.chainFamily, validator.namespace)
    if (byKey.has(key)) {
      throw new Error(`Duplicate asset reference validator: ${key}`)
    }
    byKey.set(key, validator)
  }
  return byKey
}

function normalizeReference(
  kind: AssetKind,
  namespace: string,
  reference: string,
  chain: ChainDefinition,
  validators: ReadonlyMap<string, AssetReferenceValidator>
): string {
  if (kind === 'native') {
    if (namespace !== 'slip44') {
      throw new Error('Native assets must use the slip44 namespace')
    }
    return normalizeNativeReference(reference)
  }
  if (namespace === 'slip44') {
    throw new Error('Token assets cannot use the slip44 namespace')
  }
  const validator = validators.get(validatorKey(chain.family, namespace))
  if (!validator) {
    throw new Error(`No asset reference validator for ${chain.family}/${namespace}`)
  }
  const normalized = validator.normalize(reference, chain)
  assertAssetReference(normalized)
  return normalized
}

function defineAsset(
  input: AssetDefinitionInput,
  chains: ChainRegistry,
  validators: ReadonlyMap<string, AssetReferenceValidator>
): AssetRegistryEntry {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      'chainId',
      'namespace',
      'reference',
      'kind',
      'metadata',
      'source',
      'verification'
    ]) ||
    typeof input.chainId !== 'string' ||
    typeof input.namespace !== 'string' ||
    typeof input.reference !== 'string' ||
    !ASSET_KINDS.has(input.kind) ||
    !ASSET_SOURCES.has(input.source) ||
    !ASSET_VERIFICATIONS.has(input.verification)
  ) {
    throw new Error('Invalid asset definition')
  }
  const chain = chains.resolve(input.chainId)
  assertAssetNamespace(input.namespace)
  assertSourceVerification(input.source, input.verification)
  const reference = normalizeReference(
    input.kind,
    input.namespace,
    input.reference,
    chain,
    validators
  )
  const asset = Object.freeze({
    id: createAssetId(chain.id, input.namespace, reference),
    chainId: chain.id,
    namespace: input.namespace,
    reference,
    kind: input.kind
  })
  return Object.freeze({
    asset,
    metadata: parseAssetDisplayMetadata(input.metadata),
    source: input.source,
    verification: input.verification
  })
}

function filterByChain(
  entries: readonly AssetRegistryEntry[],
  chainId?: ChainId
): readonly AssetRegistryEntry[] {
  if (chainId === undefined) return entries
  return Object.freeze(entries.filter(entry => entry.asset.chainId === chainId))
}

export function filterAssetDefinitionsForChains(
  inputs: readonly AssetDefinitionInput[],
  chains: ChainRegistry
): readonly AssetDefinitionInput[] {
  return Object.freeze(
    inputs.filter(input => {
      if (typeof input.chainId !== 'string') {
        throw new Error('Invalid asset definition chain ID')
      }
      return chains.get(parseChainId(input.chainId).id) !== undefined
    })
  )
}

export function createAssetRegistry(
  chains: ChainRegistry,
  inputs: readonly AssetDefinitionInput[],
  referenceValidators: readonly AssetReferenceValidator[] = [
    EVM_ERC20_REFERENCE_VALIDATOR,
    SOLANA_TOKEN_REFERENCE_VALIDATOR,
    NEAR_NEP141_REFERENCE_VALIDATOR
  ]
): AssetRegistry {
  const validators = createValidatorMap(referenceValidators)
  const byId = new Map<AssetId, AssetRegistryEntry>()

  for (const input of inputs) {
    const entry = defineAsset(input, chains, validators)
    if (byId.has(entry.asset.id)) {
      throw new Error(`Duplicate asset definition: ${entry.asset.id}`)
    }
    byId.set(entry.asset.id, entry)
  }

  const listed = Object.freeze(
    [...byId.values()].filter(
      entry => entry.verification === 'trusted' || entry.verification === 'user-approved'
    )
  )
  const quarantined = Object.freeze(
    [...byId.values()].filter(entry => entry.verification === 'unverified')
  )

  const normalizeLookup = (value: string): AssetId => {
    const parsed = parseAssetId(value)
    const chain = chains.resolve(parsed.chainId)
    const kind: AssetKind = parsed.namespace === 'slip44' ? 'native' : 'token'
    const reference = normalizeReference(
      kind,
      parsed.namespace,
      parsed.reference,
      chain,
      validators
    )
    return createAssetId(chain.id, parsed.namespace, reference)
  }

  return Object.freeze({
    list: (chainId?: ChainId) => filterByChain(listed, chainId),
    listQuarantined: (chainId?: ChainId) => filterByChain(quarantined, chainId),
    get: (assetId: string) => {
      const id = normalizeLookup(assetId)
      const entry = byId.get(id)
      return entry?.verification === 'trusted' || entry?.verification === 'user-approved'
        ? entry
        : undefined
    },
    resolve: (assetId: string) => {
      const entry = byId.get(normalizeLookup(assetId))
      if (!entry || (entry.verification !== 'trusted' && entry.verification !== 'user-approved')) {
        throw new Error(`Asset is not listed: ${assetId}`)
      }
      return entry
    },
    inspect: (assetId: string) => byId.get(normalizeLookup(assetId))
  })
}
