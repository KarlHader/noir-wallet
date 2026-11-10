import { MultichainCommandClient } from '@/infrastructure/keyring/multichain/command-client'
import type { KeyringCommandBinding, KeyringCommandPayload } from '@/core/keyring/ports'
import type {
  DerivePearlAddressInput,
  DerivePearlAddressesInput,
  DerivedPearlAddress
} from '@/core/chains/pearl'
import { parseSupportedPearlAddress } from '@/core/chains/pearl'
import type { KeyDomainId } from '@/core/keyring/domain'
import { getPearlChainId, parseChainId } from '@/core/chains/registry'
import {
  MAX_BIP32_INDEX,
  assertExactKeys,
  readHex,
  readLiteral,
  readRecord,
  readString
} from './raw-wallet-engine'
import {
  BackgroundMultichainTransport,
  type BackgroundMultichainForwarder
} from './background-transport'

export interface PearlAddressDerivationPort {
  readonly deriveAddress: (
    keyDomainId: KeyDomainId,
    input: DerivePearlAddressInput,
    signal?: AbortSignal
  ) => Promise<DerivedPearlAddress>
  readonly deriveAddresses?: (
    keyDomainId: KeyDomainId,
    input: DerivePearlAddressesInput,
    signal?: AbortSignal
  ) => Promise<readonly DerivedPearlAddress[]>
}

export interface PearlDerivationCredentialBindingProvider {
  readonly getCredentialBinding: (
    keyDomainId: string
  ) => Promise<Extract<KeyringCommandBinding, { readonly kind: 'credential' }>>
}

export interface PearlMultichainDerivationClientOptions {
  readonly credentials: PearlDerivationCredentialBindingProvider
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

function expectedDerivation(input: DerivePearlAddressInput, imported = false) {
  const chainId = parseChainId(input.chainId).id
  if (chainId !== getPearlChainId('mainnet') && chainId !== getPearlChainId('testnet')) {
    throw new Error('Unsupported Pearl chain ID')
  }
  const accountIndex = parseIndex(input.accountIndex, 'Pearl account index')
  const addressIndex = parseIndex(input.addressIndex, 'Pearl address index')
  if (typeof input.change !== 'boolean') {
    throw new Error('Invalid Pearl derivation request')
  }
  const coinType = chainId === getPearlChainId('mainnet') ? 808276 : 1
  return Object.freeze({
    chainId,
    accountIndex,
    addressIndex,
    change: input.change,
    derivationScheme: imported ? ('imported' as const) : ('bip86' as const),
    derivationPath: imported
      ? 'm'
      : `m/86'/${coinType}'/${accountIndex}'/${input.change ? 1 : 0}/${addressIndex}`
  } as const)
}

function parseDerivedPearlAddress(
  value: unknown,
  input: DerivePearlAddressInput
): DerivedPearlAddress {
  const request = expectedDerivation(input)
  const record = readRecord(value, 'Derived Pearl public account')
  assertExactKeys(
    record,
    [
      'chainId',
      'derivation',
      'identity',
      'addresses',
      'publicKey',
      'masterFingerprint',
      'scriptPubKey'
    ],
    [],
    'Derived Pearl public account'
  )
  if (record.chainId !== request.chainId) {
    throw new Error('Derived Pearl chain does not match the request')
  }
  const derivation = readRecord(record.derivation, 'Derived Pearl account derivation')
  assertExactKeys(derivation, ['scheme', 'path'], [], 'Derived Pearl account derivation')
  const identity = readRecord(record.identity, 'Derived Pearl account identity')
  assertExactKeys(identity, ['kind', 'value'], [], 'Derived Pearl account identity')
  readLiteral(identity.kind, ['account-identifier'], 'Derived Pearl account identity kind')
  if (!Array.isArray(record.addresses) || record.addresses.length !== 1) {
    throw new Error('Derived Pearl account must contain one address')
  }
  const address = readRecord(record.addresses[0], 'Derived Pearl address')
  assertExactKeys(
    address,
    ['value', 'scheme', 'purpose', 'derivation'],
    [],
    'Derived Pearl address'
  )
  const addressDerivation = readRecord(address.derivation, 'Derived Pearl address derivation')
  assertExactKeys(addressDerivation, ['scheme', 'path'], [], 'Derived Pearl address derivation')
  const identityValue = readString(identity.value, 'Derived Pearl identity', 128)
  const addressValue = parseSupportedPearlAddress(
    readString(address.value, 'Derived Pearl address', 128),
    request.chainId
  )
  const derivationScheme = readLiteral(
    derivation.scheme,
    ['bip86', 'imported'],
    'Derived Pearl account derivation scheme'
  )
  const derivationPath = readString(derivation.path, 'Derived Pearl account derivation path', 128)
  const expected = expectedDerivation(input, derivationScheme === 'imported')
  const publicKey = readHex(record.publicKey, 'Derived Pearl public key')
  const masterFingerprint = readHex(record.masterFingerprint, 'Derived Pearl fingerprint', {
    bytes: 4
  })
  const scriptPubKey = readHex(record.scriptPubKey, 'Derived Pearl scriptPubKey')
  if (
    identityValue !== addressValue ||
    address.scheme !== 'pearl_p2tr' ||
    address.purpose !== (input.change ? 'change' : 'receive') ||
    addressDerivation.scheme !== derivationScheme ||
    addressDerivation.path !== derivationPath ||
    derivationScheme !== expected.derivationScheme ||
    derivationPath !== expected.derivationPath ||
    !/^0x0[23][0-9a-f]{64}$/.test(publicKey) ||
    !/^0x5120[0-9a-f]{64}$/.test(scriptPubKey)
  ) {
    throw new Error('Derived Pearl public account does not match the request')
  }
  return Object.freeze({
    chainId: expected.chainId,
    address: addressValue,
    accountIndex: expected.accountIndex,
    change: input.change,
    addressIndex: expected.addressIndex,
    derivationPath,
    publicKey,
    masterFingerprint,
    scriptPubKey,
    addressScheme: 'pearl_p2tr',
    derivationScheme
  })
}

export class PearlMultichainDerivationClient implements PearlAddressDerivationPort {
  private readonly commandClient: MultichainCommandClient

  constructor(private readonly options: PearlMultichainDerivationClientOptions) {
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
    input: DerivePearlAddressInput,
    signal?: AbortSignal
  ): Promise<DerivedPearlAddress> {
    const expected = expectedDerivation(input)
    const binding = await this.options.credentials.getCredentialBinding(keyDomainId)
    return this.commandClient.execute(
      {
        operation: 'account.derive-public',
        binding,
        payload: {
          family: 'pearl',
          chainId: expected.chainId,
          accountIndex: expected.accountIndex,
          change: input.change,
          addressIndex: expected.addressIndex
        } as KeyringCommandPayload,
        signal
      },
      value => parseDerivedPearlAddress(value, input)
    )
  }

  async deriveAddresses(
    keyDomainId: KeyDomainId,
    input: DerivePearlAddressesInput,
    signal?: AbortSignal
  ): Promise<readonly DerivedPearlAddress[]> {
    const startAddressIndex = parseIndex(input.startAddressIndex, 'Pearl start address index')
    const count = parseIndex(input.count, 'Pearl derivation count')
    if (count === 0 || count > 1_000 || startAddressIndex > MAX_BIP32_INDEX - (count - 1)) {
      throw new Error('Invalid Pearl derivation batch')
    }
    const firstInput = Object.freeze({ ...input, addressIndex: startAddressIndex })
    const expected = expectedDerivation(firstInput)
    const binding = await this.options.credentials.getCredentialBinding(keyDomainId)
    return this.commandClient.execute(
      {
        operation: 'account.derive-public',
        binding,
        payload: {
          family: 'pearl',
          chainId: expected.chainId,
          accountIndex: expected.accountIndex,
          change: input.change,
          startAddressIndex,
          count
        } as KeyringCommandPayload,
        signal
      },
      value => {
        if (!Array.isArray(value) || value.length !== count) {
          throw new Error('Derived Pearl account batch has an invalid length')
        }
        return Object.freeze(
          value.map((account, offset) =>
            parseDerivedPearlAddress(account, {
              ...input,
              addressIndex: startAddressIndex + offset
            })
          )
        )
      }
    )
  }

  destroy(): Promise<void> {
    return this.commandClient.destroy()
  }
}
