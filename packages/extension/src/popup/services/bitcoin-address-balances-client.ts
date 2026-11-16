import { getBitcoinNetworkConfig } from '@/config/networks'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { parseAccountId, type AccountId } from '@/core/accounts/domain'
import type { ChainId } from '@/core/chains/domain'
import {
  BITCOIN_MAXIMUM_ADDRESSES_PER_TARGET,
  parseSupportedBitcoinAddress,
  type BitcoinSupportedAddressType
} from '@/core/chains/bitcoin'
import { parseBitcoinAddressType } from '@/infrastructure/chains/bitcoin'
import { parseChainId } from '@/core/chains/registry'
import { parseKeyDomainId, type KeyDomainId } from '@/core/keyring/domain'

const MAXIMUM_UTXOS_PER_ADDRESS = 10_000
const MAXIMUM_BITCOIN_SUPPLY_SATS = 2_100_000_000_000_000n
const ADDRESS_TYPES = new Set<BitcoinSupportedAddressType>([
  'p2pkh',
  'p2sh-p2wpkh',
  'p2wpkh',
  'p2tr'
])
const ADDRESS_SCHEMES = {
  p2pkh: 'bitcoin-p2pkh',
  'p2sh-p2wpkh': 'bitcoin-p2sh-p2wpkh',
  p2wpkh: 'bitcoin-p2wpkh',
  p2tr: 'bitcoin-p2tr'
} as const
const PURPOSES = { p2pkh: 44, 'p2sh-p2wpkh': 49, p2wpkh: 84, p2tr: 86 } as const
export const BITCOIN_ACCOUNT_TYPE_ORDER = Object.freeze([
  'p2wpkh',
  'p2sh-p2wpkh',
  'p2tr',
  'p2pkh'
] as const satisfies readonly BitcoinSupportedAddressType[])
export const BITCOIN_ACCOUNT_TYPE_LABELS: Readonly<Record<BitcoinSupportedAddressType, string>> =
  Object.freeze({
    p2wpkh: 'Native SegWit',
    'p2sh-p2wpkh': 'Nested SegWit',
    p2tr: 'Taproot',
    p2pkh: 'Legacy'
  })

export interface BitcoinDerivedAddressBalanceView {
  readonly value: string
  readonly addressType: BitcoinSupportedAddressType
  readonly addressScheme: (typeof ADDRESS_SCHEMES)[BitcoinSupportedAddressType]
  readonly change: boolean
  readonly addressIndex: number
  readonly derivationPath: string
  readonly used: boolean
  readonly confirmedRaw: string
  readonly availableRaw: string
  readonly pendingRaw: string
  readonly utxoCount: number
}

export interface BitcoinAddressBalanceCatalogView {
  readonly walletId: KeyDomainId
  readonly accountId: AccountId
  readonly accountIndex: number
  readonly accountDerivationPath: string
  readonly chainId: string
  readonly updatedAt: number
  readonly activeAddressType: BitcoinSupportedAddressType
  readonly confirmedRaw: string
  readonly availableRaw: string
  readonly pendingRaw: string
  readonly addresses: readonly BitcoinDerivedAddressBalanceView[]
}

export type BitcoinAddressBalancesRuntimeMessenger = (
  message: Readonly<Record<string, unknown>>
) => Promise<unknown>

export class BitcoinAddressBalancesClientError extends Error {
  constructor(
    readonly code: 'invalid-response' | 'unavailable',
    message: string
  ) {
    super(message)
    this.name = 'BitcoinAddressBalancesClientError'
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

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string) {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new Error(`${label} has invalid fields`)
  }
}

function parseRawAmount(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,15})$/.test(value)) {
    throw new Error(`Invalid ${label}`)
  }
  if (BigInt(value) > MAXIMUM_BITCOIN_SUPPLY_SATS) throw new Error(`Invalid ${label}`)
  return value
}

function parseSafeInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(`Invalid ${label}`)
  }
  return value as number
}

function parseAddress(
  value: unknown,
  chainId: ChainId,
  accountIndex: number,
  accountDerivationPath: string
): BitcoinDerivedAddressBalanceView {
  const address = readRecord(value, 'Bitcoin address balance')
  assertExactKeys(
    address,
    [
      'value',
      'addressType',
      'addressScheme',
      'change',
      'addressIndex',
      'derivationPath',
      'used',
      'confirmedRaw',
      'availableRaw',
      'pendingRaw',
      'utxoCount'
    ],
    'Bitcoin address balance'
  )
  if (
    typeof address.addressType !== 'string' ||
    !ADDRESS_TYPES.has(address.addressType as BitcoinSupportedAddressType)
  ) {
    throw new Error('Invalid Bitcoin address type')
  }
  const addressType = address.addressType as BitcoinSupportedAddressType
  if (
    address.addressScheme !== ADDRESS_SCHEMES[addressType] ||
    typeof address.change !== 'boolean' ||
    typeof address.used !== 'boolean'
  ) {
    throw new Error('Invalid Bitcoin address metadata')
  }
  const addressIndex = parseSafeInteger(
    address.addressIndex,
    'Bitcoin address index',
    BITCOIN_MAXIMUM_ADDRESSES_PER_TARGET - 1
  )
  const expectedPath =
    accountDerivationPath === 'm'
      ? 'm'
      : addressType === 'p2wpkh'
        ? `${accountDerivationPath.slice(0, -4)}/${address.change ? 1 : 0}/${addressIndex}`
        : `m/${PURPOSES[addressType]}'/${DEFAULT_NETWORK === 'mainnet' ? 0 : 1}'/${accountIndex}'/${address.change ? 1 : 0}/${addressIndex}`
  if (
    address.derivationPath !== expectedPath ||
    (accountDerivationPath === 'm' && (address.change || addressIndex !== 0 || accountIndex !== 0))
  ) {
    throw new Error('Invalid Bitcoin address derivation path')
  }
  const confirmedRaw = parseRawAmount(address.confirmedRaw, 'Bitcoin confirmed balance')
  const availableRaw = parseRawAmount(address.availableRaw, 'Bitcoin available balance')
  const pendingRaw = parseRawAmount(address.pendingRaw, 'Bitcoin pending balance')
  if (BigInt(availableRaw) > BigInt(confirmedRaw)) {
    throw new Error('Bitcoin available balance exceeds confirmed balance')
  }
  const utxoCount = parseSafeInteger(
    address.utxoCount,
    'Bitcoin address UTXO count',
    MAXIMUM_UTXOS_PER_ADDRESS
  )
  if (utxoCount === 0 && (BigInt(confirmedRaw) > 0n || BigInt(pendingRaw) > 0n)) {
    throw new Error('Bitcoin address balance does not match its UTXO count')
  }
  return Object.freeze({
    value: parseSupportedBitcoinAddress(address.value, chainId, addressType),
    addressType,
    addressScheme: ADDRESS_SCHEMES[addressType],
    change: address.change,
    addressIndex,
    derivationPath: expectedPath,
    used: address.used,
    confirmedRaw,
    availableRaw,
    pendingRaw,
    utxoCount
  })
}

function parseResponse(value: unknown): BitcoinAddressBalanceCatalogView | null {
  try {
    const response = readRecord(value, 'Bitcoin address balances response')
    if (Object.prototype.hasOwnProperty.call(response, 'error')) {
      assertExactKeys(response, ['error'], 'Bitcoin address balances error response')
      if (response.error !== 'Bitcoin address balances unavailable') {
        throw new Error('Invalid Bitcoin address balances error')
      }
      throw new BitcoinAddressBalancesClientError(
        'unavailable',
        'Bitcoin address balances are unavailable'
      )
    }
    assertExactKeys(response, ['result'], 'Bitcoin address balances response')
    if (response.result === null) return null
    const result = readRecord(response.result, 'Bitcoin address balances result')
    assertExactKeys(
      result,
      [
        'walletId',
        'accountId',
        'accountIndex',
        'accountDerivationPath',
        'chainId',
        'updatedAt',
        'activeAddressType',
        'confirmedRaw',
        'availableRaw',
        'pendingRaw',
        'addresses'
      ],
      'Bitcoin address balances result'
    )
    const walletId = parseKeyDomainId(result.walletId)
    const accountId = parseAccountId(result.accountId)
    const accountIndex = parseSafeInteger(
      result.accountIndex,
      'Bitcoin address balances Account index',
      2_147_483_647
    )
    const coinType = DEFAULT_NETWORK === 'mainnet' ? 0 : 1
    if (typeof result.accountDerivationPath !== 'string') {
      throw new Error('Invalid Bitcoin account derivation path')
    }
    const accountPathMatch = new RegExp(`^m/84'/${coinType}'/(0|[1-9][0-9]*)'/0/0$`).exec(
      result.accountDerivationPath
    )
    if (
      result.accountDerivationPath !== 'm' &&
      (!accountPathMatch || Number(accountPathMatch[1]) > 0x7fffffff)
    ) {
      throw new Error('Invalid Bitcoin account derivation path')
    }
    const accountDerivationPath = result.accountDerivationPath
    const chainId = parseChainId(getBitcoinNetworkConfig(DEFAULT_NETWORK).chainId).id
    if (result.chainId !== chainId || !Array.isArray(result.addresses)) {
      throw new Error('Invalid Bitcoin address balances scope')
    }
    const accountAddresses = result.activeAddressType === 'p2wpkh' && accountDerivationPath !== 'm'
    if (
      result.addresses.length > (accountAddresses ? BITCOIN_MAXIMUM_ADDRESSES_PER_TARGET * 2 : 1)
    ) {
      throw new Error('Invalid Bitcoin address balances size')
    }
    const addresses = result.addresses.map(address =>
      parseAddress(address, chainId, accountIndex, accountDerivationPath)
    )
    if (
      new Set(addresses.map(address => address.value)).size !== addresses.length ||
      new Set(addresses.map(address => address.derivationPath)).size !== addresses.length
    ) {
      throw new Error('Duplicate Bitcoin address balance')
    }
    const confirmedRaw = parseRawAmount(result.confirmedRaw, 'Bitcoin confirmed total')
    const availableRaw = parseRawAmount(result.availableRaw, 'Bitcoin available total')
    const pendingRaw = parseRawAmount(result.pendingRaw, 'Bitcoin pending total')
    if (BigInt(availableRaw) > BigInt(confirmedRaw)) {
      throw new Error('Bitcoin available total exceeds confirmed total')
    }
    if (
      typeof result.activeAddressType !== 'string' ||
      !ADDRESS_TYPES.has(result.activeAddressType as BitcoinSupportedAddressType)
    ) {
      throw new Error('Invalid active Bitcoin address type')
    }
    const activeAddressType = result.activeAddressType as BitcoinSupportedAddressType
    if (
      addresses.some(
        address =>
          address.addressType !== activeAddressType ||
          (!accountAddresses && (address.change || address.addressIndex !== 0))
      ) ||
      addresses.reduce((sum, address) => sum + BigInt(address.confirmedRaw), 0n) !==
        BigInt(confirmedRaw) ||
      addresses.reduce((sum, address) => sum + BigInt(address.availableRaw), 0n) !==
        BigInt(availableRaw) ||
      addresses.reduce((sum, address) => sum + BigInt(address.pendingRaw), 0n) !==
        BigInt(pendingRaw)
    ) {
      throw new Error('Bitcoin address balances do not match the account total')
    }
    return Object.freeze({
      walletId,
      accountId,
      accountIndex,
      accountDerivationPath,
      chainId,
      updatedAt: parseSafeInteger(
        result.updatedAt,
        'Bitcoin address balances timestamp',
        Date.now()
      ),
      activeAddressType,
      confirmedRaw,
      availableRaw,
      pendingRaw,
      addresses: Object.freeze(addresses)
    })
  } catch (error) {
    if (error instanceof BitcoinAddressBalancesClientError) throw error
    throw new BitcoinAddressBalancesClientError(
      'invalid-response',
      'Invalid Bitcoin address balances response'
    )
  }
}

export function createBitcoinAddressBalancesClient(
  sendMessage: BitcoinAddressBalancesRuntimeMessenger
) {
  return Object.freeze({
    getActiveCatalog: async (): Promise<BitcoinAddressBalanceCatalogView | null> =>
      parseResponse(await sendMessage({ type: 'GET_BITCOIN_ADDRESS_BALANCES' })),
    setActiveAddressType: async (input: {
      readonly walletId: string
      readonly accountId: string
      readonly addressType: BitcoinSupportedAddressType
    }): Promise<BitcoinAddressBalanceCatalogView> => {
      const addressType = parseBitcoinAddressType(input.addressType)
      const result = parseResponse(
        await sendMessage({
          type: 'SET_ACTIVE_BITCOIN_ADDRESS_TYPE',
          walletId: parseKeyDomainId(input.walletId),
          accountId: parseAccountId(input.accountId),
          addressType
        })
      )
      if (!result || result.activeAddressType !== addressType) {
        throw new BitcoinAddressBalancesClientError(
          'invalid-response',
          'Bitcoin account preference was not applied'
        )
      }
      return result
    }
  })
}

export const bitcoinAddressBalancesClient = createBitcoinAddressBalancesClient(message =>
  chrome.runtime.sendMessage(message)
)
