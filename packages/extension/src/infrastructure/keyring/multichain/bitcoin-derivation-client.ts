import { MultichainCommandClient } from '@/infrastructure/keyring/multichain/command-client'
import type { KeyringCommandBinding, KeyringCommandPayload } from '@/core/keyring/ports'
import type {
  DeriveBitcoinAddressInput,
  DeriveBitcoinAddressesInput,
  DerivedBitcoinAddress
} from '@/core/chains/bitcoin'
import { parseSupportedBitcoinAddress } from '@/core/chains/bitcoin'
import type { KeyDomainId } from '@/core/keyring/domain'
import { parseChainId } from '@/core/chains/registry'
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

export interface BitcoinAddressDerivationPort {
  readonly deriveAddress: (
    keyDomainId: KeyDomainId,
    input: DeriveBitcoinAddressInput,
    signal?: AbortSignal
  ) => Promise<DerivedBitcoinAddress>
  readonly deriveAddresses?: (
    keyDomainId: KeyDomainId,
    input: DeriveBitcoinAddressesInput,
    signal?: AbortSignal
  ) => Promise<readonly DerivedBitcoinAddress[]>
}

export interface BitcoinDerivationCredentialBindingProvider {
  readonly getCredentialBinding: (
    keyDomainId: string
  ) => Promise<Extract<KeyringCommandBinding, { readonly kind: 'credential' }>>
}

export interface BitcoinMultichainDerivationClientOptions {
  readonly credentials: BitcoinDerivationCredentialBindingProvider
  readonly forward?: BackgroundMultichainForwarder
  readonly now?: () => number
  readonly createCommandId?: () => string
}

const BITCOIN_MAINNET = 'bip122:000000000019d6689c085ae165831e93'
const BITCOIN_TESTNET = 'bip122:000000000933ea01ad0ee984209779ba'

function parseIndex(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_BIP32_INDEX) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

function bitcoinAddressProfile(addressType: DeriveBitcoinAddressInput['addressType']) {
  switch (addressType) {
    case 'p2pkh':
      return Object.freeze({
        purpose: 44 as const,
        addressScheme: 'bitcoin-p2pkh' as const,
        rawAddressType: 'p2pkh' as const,
        rawAddressScheme: 'bitcoin_p2pkh' as const,
        derivationScheme: 'bip44' as const
      })
    case 'p2sh-p2wpkh':
      return Object.freeze({
        purpose: 49 as const,
        addressScheme: 'bitcoin-p2sh-p2wpkh' as const,
        rawAddressType: 'p2sh_p2wpkh' as const,
        rawAddressScheme: 'bitcoin_p2sh_p2wpkh' as const,
        derivationScheme: 'bip49' as const
      })
    case 'p2wpkh':
      return Object.freeze({
        purpose: 84 as const,
        addressScheme: 'bitcoin-p2wpkh' as const,
        rawAddressType: 'p2wpkh' as const,
        rawAddressScheme: 'bitcoin_p2wpkh' as const,
        derivationScheme: 'bip84' as const
      })
    case 'p2tr':
      return Object.freeze({
        purpose: 86 as const,
        addressScheme: 'bitcoin-p2tr' as const,
        rawAddressType: 'p2tr' as const,
        rawAddressScheme: 'bitcoin_p2tr' as const,
        derivationScheme: 'bip86' as const
      })
  }
}

function expectedDerivation(input: DeriveBitcoinAddressInput, imported = false) {
  const chainId = parseChainId(input.chainId).id
  if (chainId !== BITCOIN_MAINNET && chainId !== BITCOIN_TESTNET) {
    throw new Error('Unsupported Bitcoin chain ID')
  }
  const accountIndex = parseIndex(input.accountIndex, 'Bitcoin account index')
  const addressIndex = parseIndex(input.addressIndex, 'Bitcoin address index')
  if (typeof input.change !== 'boolean') {
    throw new Error('Invalid Bitcoin derivation request')
  }
  const profile = bitcoinAddressProfile(input.addressType)
  const coinType = chainId === BITCOIN_MAINNET ? 0 : 1
  return Object.freeze({
    chainId,
    accountIndex,
    addressIndex,
    ...profile,
    derivationScheme: imported ? ('imported' as const) : profile.derivationScheme,
    derivationPath: imported
      ? 'm'
      : `m/${profile.purpose}'/${coinType}'/${accountIndex}'/${input.change ? 1 : 0}/${addressIndex}`
  } as const)
}

function parseDerivedBitcoinAddress(
  value: unknown,
  input: DeriveBitcoinAddressInput
): DerivedBitcoinAddress {
  const request = expectedDerivation(input)
  const record = readRecord(value, 'Derived Bitcoin public account')
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
    ['redeemScript'],
    'Derived Bitcoin public account'
  )
  if (record.chainId !== request.chainId) {
    throw new Error('Derived Bitcoin chain does not match the request')
  }
  const derivation = readRecord(record.derivation, 'Derived Bitcoin account derivation')
  assertExactKeys(derivation, ['scheme', 'path'], [], 'Derived Bitcoin account derivation')
  const identity = readRecord(record.identity, 'Derived Bitcoin account identity')
  assertExactKeys(identity, ['kind', 'value'], [], 'Derived Bitcoin account identity')
  readLiteral(identity.kind, ['account-identifier'], 'Derived Bitcoin account identity kind')
  if (!Array.isArray(record.addresses) || record.addresses.length !== 1) {
    throw new Error('Derived Bitcoin account must contain one address')
  }
  const address = readRecord(record.addresses[0], 'Derived Bitcoin address')
  assertExactKeys(
    address,
    ['value', 'scheme', 'purpose', 'derivation'],
    [],
    'Derived Bitcoin address'
  )
  const addressDerivation = readRecord(address.derivation, 'Derived Bitcoin address derivation')
  assertExactKeys(addressDerivation, ['scheme', 'path'], [], 'Derived Bitcoin address derivation')

  const identityValue = readString(identity.value, 'Derived Bitcoin identity', 128)
  const addressValue = parseSupportedBitcoinAddress(
    readString(address.value, 'Derived Bitcoin address', 128),
    parseChainId(request.chainId).id,
    input.addressType
  )
  const derivationScheme = readLiteral(
    derivation.scheme,
    ['bip44', 'bip49', 'bip84', 'bip86', 'imported'],
    'Derived Bitcoin account derivation scheme'
  )
  const derivationPath = readString(derivation.path, 'Derived Bitcoin account derivation path', 128)
  const expected = expectedDerivation(input, derivationScheme === 'imported')
  const publicKey = readString(record.publicKey, 'Derived Bitcoin public key', 68)
  const masterFingerprint = readString(
    record.masterFingerprint,
    'Derived Bitcoin master fingerprint',
    10
  )
  const scriptPubKey = readHex(record.scriptPubKey, 'Derived Bitcoin scriptPubKey')
  const redeemScript =
    record.redeemScript === undefined
      ? undefined
      : readHex(record.redeemScript, 'Derived Bitcoin redeemScript')
  const validScript =
    input.addressType === 'p2pkh'
      ? /^0x76a914[0-9a-f]{40}88ac$/.test(scriptPubKey)
      : input.addressType === 'p2sh-p2wpkh'
        ? /^0xa914[0-9a-f]{40}87$/.test(scriptPubKey) &&
          /^0x0014[0-9a-f]{40}$/.test(redeemScript ?? '')
        : input.addressType === 'p2wpkh'
          ? /^0x0014[0-9a-f]{40}$/.test(scriptPubKey)
          : /^0x5120[0-9a-f]{64}$/.test(scriptPubKey)
  if (
    identityValue !== addressValue ||
    address.scheme !== expected.rawAddressScheme ||
    address.purpose !== (input.change ? 'change' : 'receive') ||
    addressDerivation.scheme !== derivationScheme ||
    addressDerivation.path !== derivationPath ||
    derivationScheme !== expected.derivationScheme ||
    derivationPath !== expected.derivationPath ||
    !/^0x0[23][0-9a-f]{64}$/.test(publicKey) ||
    !/^0x[0-9a-f]{8}$/.test(masterFingerprint) ||
    !validScript ||
    (input.addressType !== 'p2sh-p2wpkh' && redeemScript !== undefined)
  ) {
    throw new Error('Derived Bitcoin public account does not match the request')
  }

  return Object.freeze({
    chainId: parseChainId(expected.chainId).id,
    addressType: input.addressType,
    accountIndex: expected.accountIndex,
    change: input.change,
    addressIndex: expected.addressIndex,
    address: addressValue,
    addressScheme: expected.addressScheme,
    derivationScheme,
    derivationPath,
    publicKey,
    masterFingerprint,
    scriptPubKey,
    ...(redeemScript === undefined ? {} : { redeemScript })
  })
}

export class BitcoinMultichainDerivationClient implements BitcoinAddressDerivationPort {
  private readonly commandClient: MultichainCommandClient

  constructor(private readonly options: BitcoinMultichainDerivationClientOptions) {
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
    input: DeriveBitcoinAddressInput,
    signal?: AbortSignal
  ): Promise<DerivedBitcoinAddress> {
    const expected = expectedDerivation(input)
    const binding = await this.options.credentials.getCredentialBinding(keyDomainId)
    return this.commandClient.execute(
      {
        operation: 'account.derive-public',
        binding,
        payload: {
          family: 'bitcoin',
          chainId: expected.chainId,
          addressType: expected.rawAddressType,
          accountIndex: expected.accountIndex,
          change: input.change,
          addressIndex: expected.addressIndex
        } as KeyringCommandPayload,
        signal
      },
      value => parseDerivedBitcoinAddress(value, input)
    )
  }

  async deriveAddresses(
    keyDomainId: KeyDomainId,
    input: DeriveBitcoinAddressesInput,
    signal?: AbortSignal
  ): Promise<readonly DerivedBitcoinAddress[]> {
    const startAddressIndex = parseIndex(input.startAddressIndex, 'Bitcoin start address index')
    const count = parseIndex(input.count, 'Bitcoin derivation count')
    if (count === 0 || count > 1_000 || startAddressIndex > MAX_BIP32_INDEX - (count - 1)) {
      throw new Error('Invalid Bitcoin derivation batch')
    }
    const firstInput = Object.freeze({ ...input, addressIndex: startAddressIndex })
    const expected = expectedDerivation(firstInput)
    const binding = await this.options.credentials.getCredentialBinding(keyDomainId)
    return this.commandClient.execute(
      {
        operation: 'account.derive-public',
        binding,
        payload: {
          family: 'bitcoin',
          chainId: expected.chainId,
          addressType: expected.rawAddressType,
          accountIndex: expected.accountIndex,
          change: input.change,
          startAddressIndex,
          count
        } as KeyringCommandPayload,
        signal
      },
      value => {
        if (!Array.isArray(value) || value.length !== count) {
          throw new Error('Derived Bitcoin account batch has an invalid length')
        }
        return Object.freeze(
          value.map((account, offset) =>
            parseDerivedBitcoinAddress(account, {
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
