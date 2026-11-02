import { parseAccountId, type AccountId } from '@/core/accounts/domain'
import { parseSupportedBitcoinAddress } from '@/core/chains/bitcoin'
import { parseNearAccountId } from '@/core/chains/near'
import { parseSolanaPublicKey } from '@/core/chains/solana'
import {
  createBuildAddressGatedChainRegistry,
  createInitialProductChainRegistry,
  type AddressGatedChainRegistry,
  type ChainDefinition
} from '@/core/chains/registry'
import { parseKeyDomainId, type KeyDomainId } from '@/core/keyring/domain'
import {
  parseHardwareCredentialMetadata,
  type HardwareCredentialMetadata
} from '@/core/keyring/domain'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { getZcashAccountIndexFromPath } from '@/lib/zcash-derivation'
import { resolveEvmNetworkCatalog } from '@/core/chains/evm-runtime-config'
import { getActiveChainEndpointSettings } from '@/core/chains/chain-endpoint-settings'
import { parseStorageV2GenerationId } from '@/infrastructure/persistence/schema'
import type { StorageV2GenerationId } from '@/ports/repositories'

const ADDRESS_PRIVACY = new Set(['transparent', 'shielded', 'mixed'])

export interface AccountNetworkAddressView {
  readonly value: string
  readonly scheme: string
  readonly privacy: 'transparent' | 'shielded' | 'mixed'
  readonly preferredForReceive: boolean
}

export interface AccountNetworkView {
  readonly chain: ChainDefinition
  readonly addresses: readonly AccountNetworkAddressView[]
  readonly accountDerivationPath?: string
  readonly privateExecutionAddress?: string
}

export interface AccountNetworksView {
  readonly walletId: KeyDomainId
  readonly walletDisplayName: string
  readonly walletCreatedAt?: number
  readonly walletSource:
    | Readonly<{ readonly kind: 'software' }>
    | Readonly<{
        readonly kind: 'private-key'
        readonly chainFamily: 'eip155' | 'bip122' | 'solana' | 'near'
        readonly bitcoinNetwork?: 'mainnet' | 'testnet'
      }>
    | Readonly<{ readonly kind: 'hardware'; readonly hardware: HardwareCredentialMetadata }>
  readonly accountId: AccountId
  readonly accountDisplayName: string
  readonly accountIndex: number
  readonly active: boolean
  readonly networks: readonly AccountNetworkView[]
}

export interface AccountNetworksCatalogView {
  readonly generationId: StorageV2GenerationId
  readonly accounts: readonly AccountNetworksView[]
}

export type AccountNetworksRuntimeMessenger = (
  message: Readonly<Record<string, unknown>>
) => Promise<unknown>

export class AccountNetworksClientError extends Error {
  constructor(
    readonly code: 'invalid-response' | 'unavailable',
    message: string
  ) {
    super(message)
    this.name = 'AccountNetworksClientError'
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

function parseAddress(value: unknown, chain: ChainDefinition): AccountNetworkAddressView {
  const address = readRecord(value, 'Account network Address')
  assertExactKeys(
    address,
    ['value', 'scheme', 'privacy', 'preferredForReceive'],
    'Account network Address'
  )
  if (
    typeof address.value !== 'string' ||
    address.value.length === 0 ||
    address.value.length > 512 ||
    typeof address.scheme !== 'string' ||
    !chain.capabilities.address.addressSchemes.includes(address.scheme) ||
    typeof address.privacy !== 'string' ||
    !ADDRESS_PRIVACY.has(address.privacy) ||
    typeof address.preferredForReceive !== 'boolean'
  ) {
    throw new Error('Invalid Account network Address')
  }

  if (chain.family === 'evm') {
    if (address.scheme !== 'evm' || !/^0x[0-9a-fA-F]{40}$/.test(address.value)) {
      throw new Error('Invalid EVM Account network Address')
    }
  } else if (chain.family === 'bitcoin') {
    const addressTypes = {
      'bitcoin-p2pkh': 'p2pkh',
      'bitcoin-p2sh-p2wpkh': 'p2sh-p2wpkh',
      'bitcoin-p2wpkh': 'p2wpkh',
      'bitcoin-p2tr': 'p2tr'
    } as const
    const addressType = addressTypes[address.scheme as keyof typeof addressTypes]
    if (!addressType) {
      throw new Error('Invalid Bitcoin Account network Address scheme')
    }
    parseSupportedBitcoinAddress(address.value, chain.id, addressType)
  } else if (chain.family === 'zcash') {
    const shieldedPrefix = chain.network.kind === 'mainnet' ? 'u1' : 'utest1'
    const transparentPrefix = chain.network.kind === 'mainnet' ? 't1' : 'tm'
    const validShielded =
      address.scheme === 'zcash-shielded-unified' && address.value.startsWith(shieldedPrefix)
    const validTransparent =
      address.scheme === 'zcash-transparent-p2pkh' && address.value.startsWith(transparentPrefix)
    if (!validShielded && !validTransparent) {
      throw new Error('Invalid Zcash Account network Address')
    }
  } else if (chain.family === 'solana') {
    if (address.scheme !== 'solana') {
      throw new Error('Invalid Solana Account network Address scheme')
    }
    parseSolanaPublicKey(address.value)
  } else if (chain.family === 'near') {
    if (address.scheme !== 'near') {
      throw new Error('Invalid NEAR Account network Address scheme')
    }
    parseNearAccountId(address.value)
  } else {
    throw new Error('Unsupported Account network family')
  }

  return Object.freeze({
    value: address.value,
    scheme: address.scheme,
    privacy: address.privacy as AccountNetworkAddressView['privacy'],
    preferredForReceive: address.preferredForReceive
  })
}

function parseNetwork(value: unknown, chains: AddressGatedChainRegistry): AccountNetworkView {
  const network = readRecord(value, 'Account network')
  const hasPrivateExecutionAddress = Object.prototype.hasOwnProperty.call(
    network,
    'privateExecutionAddress'
  )
  const hasAccountDerivationPath = Object.prototype.hasOwnProperty.call(
    network,
    'accountDerivationPath'
  )
  assertExactKeys(
    network,
    [
      'chainId',
      'addresses',
      ...(hasPrivateExecutionAddress ? ['privateExecutionAddress'] : []),
      ...(hasAccountDerivationPath ? ['accountDerivationPath'] : [])
    ],
    'Account network'
  )
  if (typeof network.chainId !== 'string' || !Array.isArray(network.addresses)) {
    throw new Error('Invalid Account network')
  }
  if (network.addresses.length === 0 || network.addresses.length > 8) {
    throw new Error('Invalid Account network Address count')
  }
  const chain = chains.resolve(network.chainId)
  if (
    hasAccountDerivationPath &&
    (chain.family !== 'zcash' ||
      getZcashAccountIndexFromPath(
        chain.network.kind === 'mainnet' ? 'mainnet' : 'testnet',
        network.accountDerivationPath
      ) === null)
  ) {
    throw new Error('Invalid Zcash account derivation path')
  }
  const addresses = network.addresses.map(address => parseAddress(address, chain))
  if (new Set(addresses.map(address => address.value)).size !== addresses.length) {
    throw new Error('Duplicate Account network Address')
  }
  if (!addresses.some(address => address.preferredForReceive)) {
    throw new Error('Account network has no preferred receive Address')
  }
  let privateExecutionAddress: string | undefined
  if (hasPrivateExecutionAddress) {
    const rawPrivateExecutionAddress = network.privateExecutionAddress
    if (
      chain.family !== 'evm' ||
      typeof rawPrivateExecutionAddress !== 'string' ||
      !/^0x[0-9a-fA-F]{40}$/.test(rawPrivateExecutionAddress) ||
      addresses.some(
        address => address.value.toLowerCase() === rawPrivateExecutionAddress.toLowerCase()
      )
    ) {
      throw new Error('Invalid Confidential address')
    }
    privateExecutionAddress = rawPrivateExecutionAddress
  }
  return Object.freeze({
    chain,
    addresses: Object.freeze(addresses),
    ...(hasAccountDerivationPath
      ? { accountDerivationPath: network.accountDerivationPath as string }
      : {}),
    ...(privateExecutionAddress === undefined ? {} : { privateExecutionAddress })
  })
}

function parseCatalog(
  value: unknown,
  chains: AddressGatedChainRegistry
): AccountNetworksCatalogView | null {
  try {
    const response = readRecord(value, 'Account networks response')
    if (Object.prototype.hasOwnProperty.call(response, 'error')) {
      assertExactKeys(response, ['error'], 'Account networks error response')
      if (response.error !== 'Account networks unavailable') {
        throw new Error('Invalid Account networks error')
      }
      throw new AccountNetworksClientError('unavailable', 'Account networks are unavailable')
    }
    assertExactKeys(response, ['result'], 'Account networks result response')
    if (response.result === null) return null

    const catalog = readRecord(response.result, 'Account networks catalog')
    assertExactKeys(catalog, ['generationId', 'accounts'], 'Account networks catalog')
    if (!Array.isArray(catalog.accounts) || catalog.accounts.length > 100) {
      throw new Error('Invalid Account networks catalog size')
    }

    const accountKeys = new Set<string>()
    const accounts = catalog.accounts.map(value => {
      const account = readRecord(value, 'Account networks entry')
      assertExactKeys(
        account,
        [
          'walletId',
          'walletDisplayName',
          ...(Object.prototype.hasOwnProperty.call(account, 'walletCreatedAt')
            ? ['walletCreatedAt']
            : []),
          'walletSource',
          'accountId',
          'accountDisplayName',
          'accountIndex',
          'active',
          'networks'
        ],
        'Account networks entry'
      )
      if (!Array.isArray(account.networks) || account.networks.length > 64) {
        throw new Error('Invalid Account network count')
      }
      const walletId = parseKeyDomainId(account.walletId)
      const accountId = parseAccountId(account.accountId)
      if (
        typeof account.walletDisplayName !== 'string' ||
        account.walletDisplayName.length === 0 ||
        account.walletDisplayName.length > 128 ||
        account.walletDisplayName.trim() !== account.walletDisplayName ||
        (account.walletCreatedAt !== undefined &&
          (!Number.isSafeInteger(account.walletCreatedAt) ||
            (account.walletCreatedAt as number) < 0)) ||
        typeof account.accountDisplayName !== 'string' ||
        account.accountDisplayName.length === 0 ||
        account.accountDisplayName.length > 128 ||
        account.accountDisplayName.trim() !== account.accountDisplayName ||
        !Number.isSafeInteger(account.accountIndex) ||
        (account.accountIndex as number) < 0 ||
        typeof account.active !== 'boolean'
      ) {
        throw new Error('Invalid Account networks metadata')
      }
      const source = readRecord(account.walletSource, 'Account network Wallet source')
      let walletSource: AccountNetworksView['walletSource']
      if (source.kind === 'software') {
        assertExactKeys(source, ['kind'], 'Account network Wallet source')
        walletSource = Object.freeze({ kind: 'software' })
      } else if (source.kind === 'private-key') {
        if (source.chainFamily === 'eip155') {
          assertExactKeys(source, ['kind', 'chainFamily'], 'Account network Wallet source')
          walletSource = Object.freeze({ kind: 'private-key', chainFamily: 'eip155' })
        } else if (source.chainFamily === 'solana' || source.chainFamily === 'near') {
          assertExactKeys(source, ['kind', 'chainFamily'], 'Account network Wallet source')
          walletSource = Object.freeze({
            kind: 'private-key',
            chainFamily: source.chainFamily
          })
        } else {
          assertExactKeys(
            source,
            ['kind', 'chainFamily', 'bitcoinNetwork'],
            'Account network Wallet source'
          )
          if (
            source.chainFamily !== 'bip122' ||
            (source.bitcoinNetwork !== 'mainnet' && source.bitcoinNetwork !== 'testnet')
          ) {
            throw new Error('Invalid private-key Wallet source')
          }
          walletSource = Object.freeze({
            kind: 'private-key',
            chainFamily: 'bip122',
            bitcoinNetwork: source.bitcoinNetwork
          })
        }
      } else if (source.kind === 'hardware') {
        assertExactKeys(source, ['kind', 'hardware'], 'Account network Wallet source')
        walletSource = Object.freeze({
          kind: 'hardware',
          hardware: parseHardwareCredentialMetadata(source.hardware)
        })
      } else {
        throw new Error('Invalid Account network Wallet source')
      }
      const key = `${walletId}:${accountId}`
      if (accountKeys.has(key)) throw new Error('Duplicate Account networks entry')
      accountKeys.add(key)

      const networks = account.networks.map(network => parseNetwork(network, chains))
      if (new Set(networks.map(network => network.chain.id)).size !== networks.length) {
        throw new Error('Duplicate Account network chain')
      }
      return Object.freeze({
        walletId,
        walletDisplayName: account.walletDisplayName,
        ...(account.walletCreatedAt === undefined
          ? {}
          : { walletCreatedAt: account.walletCreatedAt as number }),
        walletSource,
        accountId,
        accountDisplayName: account.accountDisplayName,
        accountIndex: account.accountIndex as number,
        active: account.active,
        networks: Object.freeze(networks)
      })
    })

    if (accounts.filter(account => account.active).length > 1) {
      throw new Error('Account networks catalog has multiple active Accounts')
    }

    return Object.freeze({
      generationId: parseStorageV2GenerationId(catalog.generationId),
      accounts: Object.freeze(accounts)
    })
  } catch (error) {
    if (error instanceof AccountNetworksClientError) throw error
    throw new AccountNetworksClientError('invalid-response', 'Invalid Account networks response')
  }
}

export function createAccountNetworksClient(
  sendMessage: AccountNetworksRuntimeMessenger,
  chains: AddressGatedChainRegistry
) {
  return Object.freeze({
    getCatalog: async (): Promise<AccountNetworksCatalogView | null> => {
      const response = await sendMessage({ type: 'GET_ACCOUNT_NETWORKS' })
      return parseCatalog(response, chains)
    }
  })
}

let productionClient: ReturnType<typeof createAccountNetworksClient> | undefined
let productionRegistryKey = ''

function resolveProductionChains(): AddressGatedChainRegistry {
  const settings = getActiveChainEndpointSettings()
  const catalog = resolveEvmNetworkCatalog(DEFAULT_NETWORK, settings)
  const custom = catalog.filter(network => network.source === 'custom')
  return createBuildAddressGatedChainRegistry(
    createInitialProductChainRegistry(DEFAULT_NETWORK, custom)
  )
}

export const accountNetworksClient = Object.freeze({
  getCatalog: () => {
    const registryKey = JSON.stringify(getActiveChainEndpointSettings())
    if (!productionClient || productionRegistryKey !== registryKey) {
      productionClient = createAccountNetworksClient(
        message => chrome.runtime.sendMessage(message),
        resolveProductionChains()
      )
      productionRegistryKey = registryKey
    }
    return productionClient.getCatalog()
  }
})
