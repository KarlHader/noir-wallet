import { MultichainCommandClient } from '@/infrastructure/keyring/multichain/command-client'
import type { KeyringCommandBinding, KeyringCommandPayload } from '@/core/keyring/ports'
import type { KeyDomainId } from '@/core/keyring/domain'
import { parseChainId } from '@/core/chains/registry'
import type { ChainId } from '@/core/chains/domain'
import {
  MAX_BIP32_INDEX,
  assertExactKeys,
  readHex,
  readLiteral,
  readRecord,
  readString
} from './raw-wallet-engine'
import { dashDerivationPath, isDashChainId, readDashNetworkParams } from './dash-codecs'
import {
  BackgroundMultichainTransport,
  type BackgroundMultichainForwarder
} from './background-transport'

export interface DeriveDashAddressInput {
  readonly chainId: string
  readonly accountIndex: number
  readonly change: boolean
  readonly addressIndex: number
}

export interface DeriveDashAddressesInput {
  readonly chainId: string
  readonly accountIndex: number
  readonly change: boolean
  readonly startAddressIndex: number
  readonly count: number
}

export interface DerivedDashAddress {
  readonly chainId: ChainId
  readonly network: 'mainnet' | 'testnet'
  readonly accountIndex: number
  readonly change: boolean
  readonly addressIndex: number
  readonly address: string
  readonly addressScheme: 'dash_p2pkh'
  readonly derivationScheme: 'bip44' | 'imported'
  readonly derivationPath: string
  readonly publicKey: string
  readonly masterFingerprint: string
  readonly scriptPubKey: string
}

export interface DashAddressDerivationPort {
  readonly deriveAddress: (
    keyDomainId: KeyDomainId,
    input: DeriveDashAddressInput,
    signal?: AbortSignal
  ) => Promise<DerivedDashAddress>
  readonly deriveAddresses?: (
    keyDomainId: KeyDomainId,
    input: DeriveDashAddressesInput,
    signal?: AbortSignal
  ) => Promise<readonly DerivedDashAddress[]>
}

export interface DashDerivationCredentialBindingProvider {
  readonly getCredentialBinding: (
    keyDomainId: string
  ) => Promise<Extract<KeyringCommandBinding, { readonly kind: 'credential' }>>
}

export interface DashMultichainDerivationClientOptions {
  readonly credentials: DashDerivationCredentialBindingProvider
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

function parseDerivedDashAddress(
  value: unknown,
  input: DeriveDashAddressInput
): DerivedDashAddress {
  const chainId = parseChainId(input.chainId).id
  if (!isDashChainId(chainId)) throw new Error('Unsupported Dash chain ID')
  const params = readDashNetworkParams(chainId)
  const accountIndex = parseIndex(input.accountIndex, 'Dash account index')
  const addressIndex = parseIndex(input.addressIndex, 'Dash address index')
  if (typeof input.change !== 'boolean') throw new Error('Invalid Dash derivation request')
  const record = readRecord(value, 'Derived Dash public account')
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
    'Derived Dash public account'
  )
  if (record.chainId !== chainId) {
    throw new Error('Derived Dash chain does not match the request')
  }
  const derivation = readRecord(record.derivation, 'Derived Dash account derivation')
  assertExactKeys(derivation, ['scheme', 'path'], [], 'Derived Dash account derivation')
  const identity = readRecord(record.identity, 'Derived Dash account identity')
  assertExactKeys(identity, ['kind', 'value'], [], 'Derived Dash account identity')
  readLiteral(identity.kind, ['account-identifier'], 'Derived Dash account identity kind')
  if (!Array.isArray(record.addresses) || record.addresses.length !== 1) {
    throw new Error('Derived Dash account must contain one address')
  }
  const address = readRecord(record.addresses[0], 'Derived Dash address')
  assertExactKeys(address, ['value', 'scheme', 'purpose', 'derivation'], [], 'Derived Dash address')
  const addressDerivation = readRecord(address.derivation, 'Derived Dash address derivation')
  assertExactKeys(addressDerivation, ['scheme', 'path'], [], 'Derived Dash address derivation')
  const derivationScheme = readLiteral(
    derivation.scheme,
    ['bip44', 'imported'],
    'Derived Dash account derivation scheme'
  )
  const imported = derivationScheme === 'imported'
  if (imported && (accountIndex !== 0 || input.change || addressIndex !== 0)) {
    throw new Error('Imported Dash keys cannot be scanned as an HD chain')
  }
  const derivationPath = readString(derivation.path, 'Derived Dash account derivation path', 128)
  const expectedPath = dashDerivationPath(
    chainId,
    accountIndex,
    input.change,
    addressIndex,
    imported
  )
  const identityValue = readString(identity.value, 'Derived Dash identity', 128)
  const addressValue = readString(address.value, 'Derived Dash address', 128)
  const publicKey = readString(record.publicKey, 'Derived Dash public key', 68)
  const masterFingerprint = readString(
    record.masterFingerprint,
    'Derived Dash master fingerprint',
    10
  )
  const scriptPubKey = readHex(record.scriptPubKey, 'Derived Dash scriptPubKey')
  if (
    identityValue !== addressValue ||
    address.scheme !== 'dash_p2pkh' ||
    address.purpose !== (input.change ? 'change' : 'receive') ||
    addressDerivation.scheme !== derivationScheme ||
    addressDerivation.path !== derivationPath ||
    derivationPath !== expectedPath ||
    !/^0x0[23][0-9a-f]{64}$/.test(publicKey) ||
    !/^0x[0-9a-f]{8}$/.test(masterFingerprint) ||
    !/^0x76a914[0-9a-f]{40}88ac$/.test(scriptPubKey) ||
    !addressValue.startsWith(params.network === 'mainnet' ? 'X' : 'y')
  ) {
    throw new Error('Derived Dash public account does not match the request')
  }
  return Object.freeze({
    chainId,
    network: params.network,
    accountIndex,
    change: input.change,
    addressIndex,
    address: addressValue,
    addressScheme: 'dash_p2pkh',
    derivationScheme,
    derivationPath,
    publicKey,
    masterFingerprint,
    scriptPubKey
  })
}

export class DashMultichainDerivationClient implements DashAddressDerivationPort {
  private readonly commandClient: MultichainCommandClient

  constructor(private readonly options: DashMultichainDerivationClientOptions) {
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
    input: DeriveDashAddressInput,
    signal?: AbortSignal
  ): Promise<DerivedDashAddress> {
    const chainId = parseChainId(input.chainId).id
    const accountIndex = parseIndex(input.accountIndex, 'Dash account index')
    const addressIndex = parseIndex(input.addressIndex, 'Dash address index')
    const binding = await this.options.credentials.getCredentialBinding(keyDomainId)
    return this.commandClient.execute(
      {
        operation: 'account.derive-public',
        binding,
        payload: {
          family: 'dash',
          chainId,
          accountIndex,
          change: input.change,
          addressIndex
        } as KeyringCommandPayload,
        signal
      },
      value => parseDerivedDashAddress(value, input)
    )
  }

  async deriveAddresses(
    keyDomainId: KeyDomainId,
    input: DeriveDashAddressesInput,
    signal?: AbortSignal
  ): Promise<readonly DerivedDashAddress[]> {
    const startAddressIndex = parseIndex(input.startAddressIndex, 'Dash start address index')
    const count = parseIndex(input.count, 'Dash derivation count')
    if (count === 0 || count > 1_000 || startAddressIndex > MAX_BIP32_INDEX - (count - 1)) {
      throw new Error('Invalid Dash derivation batch')
    }
    const chainId = parseChainId(input.chainId).id
    const accountIndex = parseIndex(input.accountIndex, 'Dash account index')
    const binding = await this.options.credentials.getCredentialBinding(keyDomainId)
    return this.commandClient.execute(
      {
        operation: 'account.derive-public',
        binding,
        payload: {
          family: 'dash',
          chainId,
          accountIndex,
          change: input.change,
          startAddressIndex,
          count
        } as KeyringCommandPayload,
        signal
      },
      value => {
        if (!Array.isArray(value) || value.length !== count) {
          throw new Error('Derived Dash account batch has an invalid length')
        }
        return Object.freeze(
          value.map((account, offset) =>
            parseDerivedDashAddress(account, {
              chainId,
              accountIndex,
              change: input.change,
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
