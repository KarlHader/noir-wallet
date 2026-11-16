import { parseAccountId, type AccountId } from '@/core/accounts/domain'
import {
  parseSupportedBitcoinAddress,
  type BitcoinSupportedAddressType
} from '@/core/chains/bitcoin'
import { parseBitcoinAddressType } from '@/infrastructure/chains/bitcoin'
import { parseNearAccountId } from '@/core/chains/near'
import { parseSolanaPublicKey } from '@/core/chains/solana'
import {
  createBuildAddressGatedChainRegistry,
  createInitialProductChainRegistry,
  type AddressGatedChainRegistry,
  type ChainDefinition
} from '@/core/chains/registry'
import { parseKeyDomainId, type KeyDomainId } from '@/core/keyring/domain'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { parseStorageV2GenerationId } from '@/infrastructure/persistence/schema'
import type { StorageV2GenerationId } from '@/ports/repositories'
import { getActiveChainEndpointSettings } from '@/core/chains/chain-endpoint-settings'
import { resolveEvmNetworkCatalog } from '@/core/chains/evm-runtime-config'

export type AdditionalReceiveTargetView =
  | Readonly<{ chain: ChainDefinition; kind: 'evm'; address: string }>
  | Readonly<{
      chain: ChainDefinition
      kind: 'bitcoin'
      address: string
      addressType: BitcoinSupportedAddressType
    }>
  | Readonly<{ chain: ChainDefinition; kind: 'solana' | 'near'; address: string }>

export interface AdditionalReceiveTargetsView {
  readonly generationId: StorageV2GenerationId
  readonly keyDomainId: KeyDomainId
  readonly accountId: AccountId
  readonly targets: readonly AdditionalReceiveTargetView[]
}

export type ReceiveTargetsRuntimeMessenger = (
  message: Readonly<Record<string, unknown>>
) => Promise<unknown>

export class ReceiveTargetsClientError extends Error {
  constructor(
    readonly code: 'invalid-response' | 'unavailable',
    message: string
  ) {
    super(message)
    this.name = 'ReceiveTargetsClientError'
  }
}

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
  keys: readonly string[],
  label: string
): void {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new Error(`${label} has invalid fields`)
  }
}

function parseTarget(
  value: unknown,
  chains: AddressGatedChainRegistry
): AdditionalReceiveTargetView {
  const target = readRecord(value, 'Receive target')
  if (typeof target.chainId !== 'string' || typeof target.address !== 'string') {
    throw new Error('Receive target has invalid values')
  }
  const chain = chains.resolve(target.chainId)
  if (target.kind === 'evm') {
    assertExactKeys(target, ['chainId', 'kind', 'address'], 'Receive target')
    if (chain.family !== 'evm' || !/^0x[0-9a-fA-F]{40}$/.test(target.address)) {
      throw new Error('Invalid EVM receive target')
    }
    return Object.freeze({ chain, kind: 'evm', address: target.address })
  }
  if (target.kind === 'bitcoin') {
    assertExactKeys(target, ['chainId', 'kind', 'address', 'addressType'], 'Receive target')
    if (chain.family !== 'bitcoin') throw new Error('Invalid Bitcoin receive target chain')
    const addressType = parseBitcoinAddressType(target.addressType)
    return Object.freeze({
      chain,
      kind: 'bitcoin',
      addressType,
      address: parseSupportedBitcoinAddress(target.address, chain.id, addressType)
    })
  }
  if (target.kind === 'solana') {
    assertExactKeys(target, ['chainId', 'kind', 'address'], 'Receive target')
    if (chain.family !== 'solana') throw new Error('Invalid Solana receive target chain')
    return Object.freeze({ chain, kind: 'solana', address: parseSolanaPublicKey(target.address) })
  }
  if (target.kind === 'near') {
    assertExactKeys(target, ['chainId', 'kind', 'address'], 'Receive target')
    if (chain.family !== 'near') throw new Error('Invalid NEAR receive target chain')
    return Object.freeze({ chain, kind: 'near', address: parseNearAccountId(target.address) })
  }
  throw new Error('Unsupported receive target kind')
}

function parseResponse(
  value: unknown,
  expected: { readonly keyDomainId: KeyDomainId; readonly accountId: AccountId },
  chains: AddressGatedChainRegistry
): AdditionalReceiveTargetsView | null {
  try {
    const response = readRecord(value, 'Receive targets response')
    if (Object.prototype.hasOwnProperty.call(response, 'error')) {
      assertExactKeys(response, ['error'], 'Receive targets error response')
      if (response.error !== 'Receive targets unavailable') {
        throw new Error('Invalid receive targets error')
      }
      throw new ReceiveTargetsClientError('unavailable', 'Additional networks are unavailable')
    }
    assertExactKeys(response, ['result'], 'Receive targets result response')
    if (response.result === null) return null
    const result = readRecord(response.result, 'Receive targets result')
    assertExactKeys(
      result,
      ['generationId', 'keyDomainId', 'accountId', 'targets'],
      'Receive targets result'
    )
    const keyDomainId = parseKeyDomainId(result.keyDomainId)
    const accountId = parseAccountId(result.accountId)
    if (keyDomainId !== expected.keyDomainId || accountId !== expected.accountId) {
      throw new Error('Receive targets do not match the active Account')
    }
    if (!Array.isArray(result.targets) || result.targets.length > chains.list().length) {
      throw new Error('Invalid receive target list')
    }
    const targets = result.targets.map(target => parseTarget(target, chains))
    const chainIds = new Set(targets.map(target => target.chain.id))
    if (chainIds.size !== targets.length) throw new Error('Duplicate receive target chain')
    return Object.freeze({
      generationId: parseStorageV2GenerationId(result.generationId),
      keyDomainId,
      accountId,
      targets: Object.freeze(targets)
    })
  } catch (error) {
    if (error instanceof ReceiveTargetsClientError) throw error
    throw new ReceiveTargetsClientError('invalid-response', 'Invalid receive targets response')
  }
}

export function createReceiveTargetsClient(
  sendMessage: ReceiveTargetsRuntimeMessenger,
  chains?: AddressGatedChainRegistry
) {
  return Object.freeze({
    getAdditionalTargets: async (scope: {
      readonly keyDomainId: string
      readonly accountId: string
    }): Promise<AdditionalReceiveTargetsView | null> => {
      const expected = Object.freeze({
        keyDomainId: parseKeyDomainId(scope.keyDomainId),
        accountId: parseAccountId(scope.accountId)
      })
      const response = await sendMessage({
        type: 'GET_ADDITIONAL_RECEIVE_TARGETS',
        walletId: expected.keyDomainId,
        accountId: expected.accountId
      })
      return parseResponse(response, expected, chains ?? resolveProductionChains())
    }
  })
}

function resolveProductionChains(): AddressGatedChainRegistry {
  const catalog = resolveEvmNetworkCatalog(DEFAULT_NETWORK, getActiveChainEndpointSettings())
  return createBuildAddressGatedChainRegistry(
    createInitialProductChainRegistry(
      DEFAULT_NETWORK,
      catalog.filter(network => network.source === 'custom')
    )
  )
}

export const receiveTargetsClient = createReceiveTargetsClient(message =>
  chrome.runtime.sendMessage(message)
)
