import type { ChainId, ChainNamespace, ChainReference } from '@/core/chains/domain'
import type { ChainFeatureFlagValue } from '@/config/multichain-feature-flags'
import { parseChainId } from './caip2'
import type {
  CapabilityStatus,
  ChainCapabilities,
  ChainFamily,
  ChainNetworkKind,
  TransactionAction
} from './capabilities'

export type ChainFeatureFlag = ChainFeatureFlagValue

export interface ChainDefinition {
  readonly id: ChainId
  readonly namespace: ChainNamespace
  readonly reference: ChainReference
  readonly family: ChainFamily
  readonly network: {
    readonly kind: ChainNetworkKind
    readonly name: string
  }
  readonly displayName: string
  readonly featureFlag: ChainFeatureFlag
  readonly capabilities: ChainCapabilities
}

export interface ChainDefinitionInput {
  readonly id: string
  readonly family: ChainFamily
  readonly network: {
    readonly kind: ChainNetworkKind
    readonly name: string
  }
  readonly displayName: string
  readonly featureFlag: ChainFeatureFlag
  readonly capabilities: ChainCapabilities
}

export interface ChainRegistry {
  readonly list: () => readonly ChainDefinition[]
  readonly get: (chainId: ChainId) => ChainDefinition | undefined
  readonly resolve: (chainId: string) => ChainDefinition
}

const CHAIN_FAMILIES = new Set(['zcash', 'evm', 'bitcoin', 'solana', 'tron', 'near'])
const NETWORK_KINDS = new Set(['mainnet', 'testnet', 'devnet', 'custom'])
const CAPABILITY_STATUSES = new Set(['available', 'waiting', 'unsupported'])
const TRANSACTION_MODELS = new Set(['account', 'utxo', 'hybrid-utxo'])
const TRANSACTION_ACTIONS = new Set([
  'native-transfer',
  'token-transfer',
  'contract-call',
  'shield',
  'unshield'
])

function assertNonEmpty(value: string, label: string): void {
  if (value.length === 0 || value.trim() !== value) {
    throw new Error(`${label} must be a non-empty string without surrounding whitespace`)
  }
}

function assertAllowed(value: string, allowed: ReadonlySet<string>, label: string): void {
  if (!allowed.has(value)) throw new Error(`Invalid ${label}: ${value}`)
}

function freezeStrings(values: readonly string[], label: string): readonly string[] {
  const unique = new Set<string>()
  for (const value of values) {
    assertNonEmpty(value, label)
    if (unique.has(value)) throw new Error(`${label} contains duplicate value: ${value}`)
    unique.add(value)
  }
  return Object.freeze([...values])
}

function freezeActions(values: readonly TransactionAction[]): readonly TransactionAction[] {
  for (const value of values) {
    assertAllowed(value, TRANSACTION_ACTIONS, 'transaction action')
  }
  return freezeStrings(values, 'transaction action') as readonly TransactionAction[]
}

function assertCapabilityValues(
  status: CapabilityStatus,
  values: readonly string[],
  label: string
): void {
  if (status === 'available' && values.length === 0) {
    throw new Error(`${label} must declare at least one available value`)
  }
  if (status !== 'available' && values.length > 0) {
    throw new Error(`${label} cannot advertise values while status is ${status}`)
  }
}

export function defineChain(input: ChainDefinitionInput): ChainDefinition {
  const parsed = parseChainId(input.id)
  assertAllowed(input.family, CHAIN_FAMILIES, 'chain family')
  assertAllowed(input.network.kind, NETWORK_KINDS, 'network kind')
  assertAllowed(input.capabilities.address.status, CAPABILITY_STATUSES, 'address status')
  assertAllowed(input.capabilities.signing.status, CAPABILITY_STATUSES, 'signing status')
  assertAllowed(input.capabilities.transaction.status, CAPABILITY_STATUSES, 'transaction status')
  assertAllowed(input.capabilities.transaction.model, TRANSACTION_MODELS, 'transaction model')
  assertNonEmpty(input.network.name, 'network name')
  assertNonEmpty(input.displayName, 'chain display name')
  assertNonEmpty(input.featureFlag, 'chain feature flag')
  if (!/^chain\.[a-z0-9][a-z0-9.-]*$/.test(input.featureFlag)) {
    throw new Error(`Invalid chain feature flag: ${input.featureFlag}`)
  }

  const addressSchemes = freezeStrings(input.capabilities.address.addressSchemes, 'address scheme')
  const derivationSchemes = freezeStrings(
    input.capabilities.address.derivationSchemes,
    'derivation scheme'
  )
  const transactionFormats = freezeStrings(
    input.capabilities.signing.transactionFormats,
    'transaction signing format'
  )
  const messageFormats = freezeStrings(
    input.capabilities.signing.messageFormats,
    'message signing format'
  )
  const transactionActions = freezeActions(input.capabilities.transaction.actions)

  assertCapabilityValues(input.capabilities.address.status, addressSchemes, 'address capability')
  assertCapabilityValues(
    input.capabilities.signing.status,
    [...transactionFormats, ...messageFormats],
    'signing capability'
  )
  assertCapabilityValues(
    input.capabilities.transaction.status,
    transactionActions,
    'transaction capability'
  )

  if (
    input.capabilities.address.status !== 'available' &&
    (derivationSchemes.length > 0 ||
      input.capabilities.address.supportsRotation ||
      input.capabilities.address.supportsChange)
  ) {
    throw new Error(
      `address capability cannot advertise derivation or branch support while status is ${input.capabilities.address.status}`
    )
  }

  if (
    input.capabilities.signing.status === 'available' &&
    input.capabilities.address.status !== 'available'
  ) {
    throw new Error('signing capability requires an available address capability')
  }
  if (
    input.capabilities.transaction.status === 'available' &&
    input.capabilities.signing.status !== 'available'
  ) {
    throw new Error('transaction capability requires an available signing capability')
  }

  return Object.freeze({
    ...parsed,
    family: input.family,
    network: Object.freeze({ ...input.network }),
    displayName: input.displayName,
    featureFlag: input.featureFlag,
    capabilities: Object.freeze({
      address: Object.freeze({
        ...input.capabilities.address,
        addressSchemes,
        derivationSchemes
      }),
      signing: Object.freeze({
        ...input.capabilities.signing,
        transactionFormats,
        messageFormats
      }),
      transaction: Object.freeze({
        ...input.capabilities.transaction,
        actions: transactionActions
      })
    })
  })
}

export function createChainRegistry(definitions: readonly ChainDefinitionInput[]): ChainRegistry {
  const chains = definitions.map(defineChain)
  const byId = new Map<ChainId, ChainDefinition>()

  for (const chain of chains) {
    if (byId.has(chain.id)) {
      throw new Error(`Duplicate chain definition: ${chain.id}`)
    }
    byId.set(chain.id, chain)
  }

  const frozenChains = Object.freeze([...chains])

  return Object.freeze({
    list: () => frozenChains,
    get: (chainId: ChainId) => byId.get(chainId),
    resolve: (chainId: string) => {
      const parsed = parseChainId(chainId)
      const definition = byId.get(parsed.id)
      if (!definition) throw new Error(`Unsupported chain: ${chainId}`)
      return definition
    }
  })
}
