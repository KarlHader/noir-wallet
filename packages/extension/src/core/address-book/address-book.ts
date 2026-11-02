import type { Network } from '@/types'
import type { ChainFamily } from '@/core/chains/registry'
import { parseChainId, getBitcoinChainId, getZcashChainId } from '@/core/chains/registry'
import { parseSupportedBitcoinAddress } from '@/core/chains/bitcoin'
import { findBuiltinEvmNetworkConfig } from '@/config/networks'

export const ADDRESS_BOOK_SCHEMA_VERSION = 2 as const
export const ADDRESS_BOOK_MAX_CONTACTS = 500
export const ADDRESS_BOOK_MAX_NAME_LENGTH = 64

export interface AddressBookContact {
  readonly id: string
  readonly schemaVersion: typeof ADDRESS_BOOK_SCHEMA_VERSION
  readonly chainId: string
  readonly chainFamily: Extract<ChainFamily, 'zcash' | 'evm' | 'bitcoin'>
  readonly network: Network
  readonly networkName: string
  readonly address: string
  readonly normalizedAddress: string
  readonly addressScheme: string
  readonly name: string
  readonly addedAt: number
  readonly updatedAt: number
  readonly znsName?: string
}

export interface CreateAddressBookContactInput {
  readonly chainId: string
  readonly chainFamily: AddressBookContact['chainFamily']
  readonly network: Network
  readonly networkName: string
  readonly address: string
  readonly name: string
  readonly addedAt?: number
  readonly updatedAt?: number
  readonly znsName?: string
}

export interface LegacyContact {
  readonly address: string
  readonly name: string
  readonly addedAt: number
  readonly znsName?: string
}

export interface LegacyContactMigrationResult {
  readonly contacts: readonly AddressBookContact[]
  readonly skippedCount: number
}

function parseContactName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Contact name must be a string')
  const name = value.trim().replace(/\s+/g, ' ')
  if (
    name.length === 0 ||
    name.length > ADDRESS_BOOK_MAX_NAME_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(name)
  ) {
    throw new Error(`Contact name must contain 1-${ADDRESS_BOOK_MAX_NAME_LENGTH} characters`)
  }
  return name
}

function parseNetworkName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Network name must be a string')
  const name = value.trim()
  if (name.length === 0 || name.length > 128) throw new Error('Invalid network name')
  return name
}

function parseTimestamp(value: unknown, label: string, fallback?: number): number {
  if (Number.isSafeInteger(value) && (value as number) >= 0) return value as number
  if (fallback !== undefined) return fallback
  throw new Error(`Invalid ${label}`)
}

function parseZnsName(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error('Invalid ZNS name')
  const name = value.trim()
  if (name.length === 0 || name.length > 255 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error('Invalid ZNS name')
  }
  return name
}

export function parseZcashAddress(
  value: unknown,
  network: Network
): Readonly<{ address: string; scheme: string }> {
  if (typeof value !== 'string' || value.trim() !== value) {
    throw new Error('Invalid Zcash address')
  }
  const patterns: ReadonlyArray<readonly [string, RegExp]> =
    network === 'mainnet'
      ? [
          ['zcash-transparent-p2pkh', /^t1[a-km-zA-HJ-NP-Z1-9]{33}$/],
          ['zcash-transparent-p2sh', /^t3[a-km-zA-HJ-NP-Z1-9]{33}$/],
          ['zcash-full-unified', /^u1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{50,}$/],
          ['zcash-sapling', /^zs[a-km-zA-HJ-NP-Z1-9]{76}$/]
        ]
      : [
          ['zcash-transparent-p2pkh', /^tm[a-km-zA-HJ-NP-Z1-9]{33}$/],
          ['zcash-transparent-p2sh', /^t2[a-km-zA-HJ-NP-Z1-9]{33}$/],
          ['zcash-full-unified', /^utest1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{50,}$/],
          ['zcash-sapling', /^ztestsapling[a-km-zA-HJ-NP-Z1-9]{60,}$/]
        ]
  const match = patterns.find(([, pattern]) => pattern.test(value))
  if (!match) throw new Error('Invalid Zcash address')
  return { address: value, scheme: match[0] as string }
}

function bitcoinAddressScheme(address: string): string {
  if (address.startsWith('bc1p') || address.startsWith('tb1p')) return 'bitcoin-p2tr'
  if (address.startsWith('bc1q') || address.startsWith('tb1q')) return 'bitcoin-p2wpkh'
  if (/^[13]/.test(address) || /^[mn2]/.test(address)) {
    return address.startsWith('3') || address.startsWith('2')
      ? 'bitcoin-p2sh-p2wpkh'
      : 'bitcoin-p2pkh'
  }
  throw new Error('Unsupported Bitcoin address')
}

export function normalizeAddressBookAddress(
  chainFamily: AddressBookContact['chainFamily'],
  address: string
): string {
  return chainFamily === 'evm' ? address.toLowerCase() : address
}

export function createAddressBookContact(
  input: CreateAddressBookContactInput,
  now = Date.now()
): AddressBookContact {
  const parsedChain = parseChainId(input.chainId)
  let address: string
  let addressScheme: string
  let expectedNetworkName: string

  if (input.chainFamily === 'evm') {
    const networkConfig = findBuiltinEvmNetworkConfig(input.network, input.chainId)
    if (
      parsedChain.namespace !== 'eip155' ||
      !networkConfig ||
      !/^0x[0-9a-fA-F]{40}$/.test(input.address)
    ) {
      throw new Error('Invalid EVM contact')
    }
    if (/^0x0{40}$/i.test(input.address)) throw new Error('Invalid EVM contact')
    address = input.address
    addressScheme = 'evm'
    expectedNetworkName = networkConfig.displayName
  } else if (input.chainFamily === 'bitcoin') {
    if (input.chainId !== getBitcoinChainId(input.network)) {
      throw new Error('Bitcoin contact network does not match its chain')
    }
    address = parseSupportedBitcoinAddress(input.address, parsedChain.id)
    addressScheme = bitcoinAddressScheme(address)
    expectedNetworkName = input.network === 'mainnet' ? 'Bitcoin' : 'Bitcoin Testnet'
  } else {
    if (input.chainId !== getZcashChainId(input.network)) {
      throw new Error('Zcash contact network does not match its chain')
    }
    const parsedAddress = parseZcashAddress(input.address, input.network)
    address = parsedAddress.address
    addressScheme = parsedAddress.scheme
    expectedNetworkName = input.network === 'mainnet' ? 'Zcash' : 'Zcash Testnet'
  }

  const normalizedAddress = normalizeAddressBookAddress(input.chainFamily, address)
  const addedAt = parseTimestamp(input.addedAt, 'contact addedAt', now)
  const updatedAt = parseTimestamp(input.updatedAt, 'contact updatedAt', addedAt)
  const znsName = parseZnsName(input.znsName)
  const networkName = parseNetworkName(input.networkName)
  if (networkName !== expectedNetworkName) {
    throw new Error('Contact network name does not match its chain')
  }
  return Object.freeze({
    id: `${input.chainId}:${normalizedAddress}`,
    schemaVersion: ADDRESS_BOOK_SCHEMA_VERSION,
    chainId: input.chainId,
    chainFamily: input.chainFamily,
    network: input.network,
    networkName,
    address,
    normalizedAddress,
    addressScheme,
    name: parseContactName(input.name),
    addedAt,
    updatedAt,
    ...(znsName ? { znsName } : {})
  })
}

export function parseAddressBookContact(value: unknown): AddressBookContact {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid address book contact')
  }
  const contact = value as Record<string, unknown>
  if (contact.schemaVersion !== ADDRESS_BOOK_SCHEMA_VERSION) {
    throw new Error('Unsupported address book contact version')
  }
  if (
    typeof contact.chainId !== 'string' ||
    (contact.chainFamily !== 'zcash' &&
      contact.chainFamily !== 'evm' &&
      contact.chainFamily !== 'bitcoin') ||
    (contact.network !== 'mainnet' && contact.network !== 'testnet') ||
    typeof contact.address !== 'string'
  ) {
    throw new Error('Invalid address book contact')
  }
  const parsed = createAddressBookContact({
    chainId: contact.chainId,
    chainFamily: contact.chainFamily,
    network: contact.network,
    networkName: contact.networkName as string,
    address: contact.address,
    name: contact.name as string,
    addedAt: contact.addedAt as number,
    updatedAt: contact.updatedAt as number,
    znsName: contact.znsName as string | undefined
  })
  if (
    contact.id !== parsed.id ||
    contact.normalizedAddress !== parsed.normalizedAddress ||
    contact.addressScheme !== parsed.addressScheme
  ) {
    throw new Error('Address book contact integrity check failed')
  }
  return parsed
}

export function parseAddressBookContacts(value: unknown): readonly AddressBookContact[] {
  if (!Array.isArray(value) || value.length > ADDRESS_BOOK_MAX_CONTACTS) {
    throw new Error('Invalid address book contact list')
  }
  const contacts = value.map(parseAddressBookContact)
  if (new Set(contacts.map(contact => contact.id)).size !== contacts.length) {
    throw new Error('Duplicate address book contact')
  }
  return Object.freeze(contacts)
}

function inferLegacyZcashNetwork(address: string): Network | null {
  if (/^(utest1|ztestsapling|tm|t2)/.test(address)) return 'testnet'
  if (/^(u1|zs|t1|t3)/.test(address)) return 'mainnet'
  return null
}

export function migrateLegacyContacts(value: unknown): LegacyContactMigrationResult {
  if (!Array.isArray(value)) return Object.freeze({ contacts: Object.freeze([]), skippedCount: 0 })
  const migrated = new Map<string, AddressBookContact>()
  let skippedCount = 0
  for (const entry of value.slice(0, ADDRESS_BOOK_MAX_CONTACTS)) {
    try {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new Error('Invalid legacy contact')
      }
      const legacy = entry as Record<string, unknown>
      if (typeof legacy.address !== 'string') throw new Error('Invalid legacy address')
      const network = inferLegacyZcashNetwork(legacy.address)
      if (!network) throw new Error('Ambiguous legacy address')
      const contact = createAddressBookContact({
        chainId: getZcashChainId(network),
        chainFamily: 'zcash',
        network,
        networkName: network === 'mainnet' ? 'Zcash' : 'Zcash Testnet',
        address: legacy.address,
        name: legacy.name as string,
        addedAt: legacy.addedAt as number,
        znsName: legacy.znsName as string | undefined
      })
      migrated.set(contact.id, contact)
    } catch {
      skippedCount += 1
    }
  }
  skippedCount += Math.max(0, value.length - ADDRESS_BOOK_MAX_CONTACTS)
  return Object.freeze({ contacts: Object.freeze([...migrated.values()]), skippedCount })
}

export function readLegacyContactsStorage(value: unknown): unknown[] {
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return []
    const state = (parsed as Record<string, unknown>).state
    if (typeof state !== 'object' || state === null || Array.isArray(state)) return []
    const contacts = (state as Record<string, unknown>).contacts
    return Array.isArray(contacts) ? contacts : []
  } catch {
    return []
  }
}
