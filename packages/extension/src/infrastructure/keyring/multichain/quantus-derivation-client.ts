import type { KeyDomainId } from '@/core/keyring/domain'
import type { KeyringCommandBinding, KeyringCommandPayload } from '@/core/keyring/ports'
import {
  decodeQuantusAccountId,
  parseQuantusAddress,
  resolveQuantusDerivationScheme,
  type QuantusDerivationScheme
} from '@/core/chains/quantus'
import { getQuantusChainId, parseChainId } from '@/core/chains/registry'
import { MultichainCommandClient } from '@/infrastructure/keyring/multichain/command-client'
import { MAX_BIP32_INDEX, assertExactKeys, readRecord, readString } from './raw-wallet-engine'
import {
  BackgroundMultichainTransport,
  type BackgroundMultichainForwarder
} from './background-transport'

export interface DeriveQuantusAddressInput {
  readonly chainId: string
  readonly scheme?: QuantusDerivationScheme
  readonly accountIndex: number
  readonly change: boolean
  readonly addressIndex: number
}

export interface DeriveQuantusAddressesInput extends Omit<
  DeriveQuantusAddressInput,
  'addressIndex'
> {
  readonly startAddressIndex: number
  readonly count: number
}

export interface DerivedQuantusAddress {
  readonly chainId: string
  readonly scheme: QuantusDerivationScheme
  readonly accountIndex: number
  readonly change: boolean
  readonly addressIndex: number
  readonly address: string
  readonly accountId: string
  readonly publicKey: string
  readonly derivationPath: string
}

export interface QuantusAddressDerivationPort {
  readonly deriveAddress: (
    keyDomainId: KeyDomainId,
    input: DeriveQuantusAddressInput,
    signal?: AbortSignal
  ) => Promise<DerivedQuantusAddress>
  readonly deriveAddresses?: (
    keyDomainId: KeyDomainId,
    input: DeriveQuantusAddressesInput,
    signal?: AbortSignal
  ) => Promise<readonly DerivedQuantusAddress[]>
}

export interface QuantusDerivationCredentialBindingProvider {
  readonly getCredentialBinding: (
    keyDomainId: string
  ) => Promise<Extract<KeyringCommandBinding, { readonly kind: 'credential' }>>
}

export interface QuantusMultichainDerivationClientOptions {
  readonly credentials: QuantusDerivationCredentialBindingProvider
  readonly forward?: BackgroundMultichainForwarder
  readonly now?: () => number
  readonly createCommandId?: () => string
}

function parseIndex(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_BIP32_INDEX) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

export interface ResolvedQuantusDerivation {
  readonly chainId: string
  readonly scheme: QuantusDerivationScheme
  readonly accountIndex: number
  readonly change: boolean
  readonly derivationPath: string
}

/**
 * Validates a Quantus derivation request and derives the path the WASM must
 * return. Testnet keeps the CAIP-2 reference `quantus:planck`; the worker maps
 * it to the WASM identifier at the engine boundary.
 */
export function resolveQuantusDerivation(
  input: DeriveQuantusAddressInput,
  addressIndex: number
): ResolvedQuantusDerivation {
  const chainId = parseChainId(input.chainId).id
  if (chainId !== getQuantusChainId('mainnet') && chainId !== getQuantusChainId('testnet')) {
    throw new Error('Unsupported Quantus chain ID')
  }
  const scheme = resolveQuantusDerivationScheme(input.scheme)
  const accountIndex = parseIndex(input.accountIndex, 'Quantus account index')
  parseIndex(addressIndex, 'Quantus address index')
  if (typeof input.change !== 'boolean') {
    throw new Error('Invalid Quantus derivation request')
  }
  return Object.freeze({
    chainId,
    scheme,
    accountIndex,
    change: input.change,
    derivationPath: `m/44'/189189'/${accountIndex}'/${input.change ? 1 : 0}'/${addressIndex}'`
  })
}

export function validateQuantusDerivationInput(
  input: DeriveQuantusAddressInput
): Readonly<DeriveQuantusAddressInput> {
  resolveQuantusDerivation(input, input.addressIndex)
  return Object.freeze({ ...input })
}

function parseDerivedQuantusAddress(
  value: unknown,
  expected: ResolvedQuantusDerivation,
  addressIndex: number
): DerivedQuantusAddress {
  const record = readRecord(value, 'Derived Quantus public account')
  assertExactKeys(
    record,
    ['chainId', 'derivation', 'identity', 'addresses', 'publicKey'],
    [],
    'Derived Quantus public account'
  )
  const derivation = readRecord(record.derivation, 'Derived Quantus derivation')
  assertExactKeys(derivation, ['scheme', 'path'], [], 'Derived Quantus derivation')
  const addresses = record.addresses
  if (!Array.isArray(addresses) || addresses.length !== 1) {
    throw new Error('Derived Quantus public account has an invalid address list')
  }
  const address = readRecord(addresses[0], 'Derived Quantus address')
  assertExactKeys(
    address,
    ['value', 'scheme', 'purpose', 'derivation'],
    [],
    'Derived Quantus address'
  )
  const addressValue = parseQuantusAddress(address.value, 'Derived Quantus address')
  const addressDerivation = readRecord(address.derivation, 'Derived Quantus address derivation')
  assertExactKeys(addressDerivation, ['scheme', 'path'], [], 'Derived Quantus address derivation')
  const identity = readRecord(record.identity, 'Derived Quantus identity')
  assertExactKeys(identity, ['kind', 'value'], [], 'Derived Quantus identity')

  const publicKey = readString(record.publicKey, 'Derived Quantus public key', 8_192)
  const derivationScheme = addressDerivation.scheme
  const derivationPath = readString(derivation.path, 'Derived Quantus derivation path', 128)
  if (
    readString(record.chainId, 'Derived Quantus chain ID', 64) !== expected.chainId ||
    identity.kind !== 'account-identifier' ||
    identity.value !== addressValue ||
    address.scheme !== 'quantus' ||
    derivationScheme !== 'bip44' ||
    derivation.scheme !== derivationScheme ||
    derivationPath !== expected.derivationPath ||
    addressDerivation.path !== derivationPath ||
    !/^0x(?:[0-9a-f]{2})+$/.test(publicKey)
  ) {
    throw new Error('Derived Quantus public account does not match the request')
  }
  return Object.freeze({
    chainId: expected.chainId,
    scheme: expected.scheme,
    accountIndex: expected.accountIndex,
    change: expected.change,
    addressIndex,
    address: addressValue,
    accountId: toHex(decodeQuantusAccountId(addressValue)),
    publicKey,
    derivationPath
  })
}

function toHex(bytes: Uint8Array): string {
  let value = '0x'
  for (const byte of bytes) value += byte.toString(16).padStart(2, '0')
  return value
}

export class QuantusMultichainDerivationClient implements QuantusAddressDerivationPort {
  private readonly commandClient: MultichainCommandClient

  constructor(private readonly options: QuantusMultichainDerivationClientOptions) {
    this.commandClient = new MultichainCommandClient(
      new BackgroundMultichainTransport(options.forward),
      {
        defaultTimeoutMs: 120_000,
        maxTimeoutMs: 120_000,
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.createCommandId === undefined
          ? {}
          : { createCommandId: options.createCommandId })
      }
    )
  }

  async deriveAddress(
    keyDomainId: KeyDomainId,
    input: DeriveQuantusAddressInput,
    signal?: AbortSignal
  ): Promise<DerivedQuantusAddress> {
    const expected = resolveQuantusDerivation(input, input.addressIndex)
    const binding = await this.options.credentials.getCredentialBinding(keyDomainId)
    return this.commandClient.execute(
      {
        operation: 'account.derive-public',
        binding,
        payload: {
          family: 'quantus',
          chainId: expected.chainId,
          scheme: expected.scheme,
          accountIndex: expected.accountIndex,
          change: expected.change,
          addressIndex: input.addressIndex
        } as KeyringCommandPayload,
        signal
      },
      value => parseDerivedQuantusAddress(value, expected, input.addressIndex)
    )
  }

  async deriveAddresses(
    keyDomainId: KeyDomainId,
    input: DeriveQuantusAddressesInput,
    signal?: AbortSignal
  ): Promise<readonly DerivedQuantusAddress[]> {
    const startAddressIndex = parseIndex(input.startAddressIndex, 'Quantus start address index')
    const count = parseIndex(input.count, 'Quantus derivation count')
    if (count === 0 || count > 1_000 || startAddressIndex > MAX_BIP32_INDEX - (count - 1)) {
      throw new Error('Invalid Quantus derivation batch')
    }
    const expected = resolveQuantusDerivation(
      { ...input, addressIndex: startAddressIndex },
      startAddressIndex
    )
    const binding = await this.options.credentials.getCredentialBinding(keyDomainId)
    return this.commandClient.execute(
      {
        operation: 'account.derive-public',
        binding,
        payload: {
          family: 'quantus',
          chainId: expected.chainId,
          scheme: expected.scheme,
          accountIndex: expected.accountIndex,
          change: expected.change,
          startAddressIndex,
          count
        } as KeyringCommandPayload,
        signal
      },
      value => {
        if (!Array.isArray(value) || value.length !== count) {
          throw new Error('Derived Quantus account batch has an invalid length')
        }
        return Object.freeze(
          value.map((candidate, offset) => {
            const addressIndex = startAddressIndex + offset
            return parseDerivedQuantusAddress(
              candidate,
              resolveQuantusDerivation({ ...input, addressIndex }, addressIndex),
              addressIndex
            )
          })
        )
      }
    )
  }
}

export function createQuantusMultichainDerivationClient(
  options: QuantusMultichainDerivationClientOptions
): QuantusAddressDerivationPort {
  return new QuantusMultichainDerivationClient(options)
}
