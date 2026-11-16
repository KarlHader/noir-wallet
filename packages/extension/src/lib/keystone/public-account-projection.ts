import { secp256k1 } from '@noble/curves/secp256k1'
import { HDKey, publicKeyToAddress } from 'viem/accounts'
import { keccak256, toHex } from 'viem'
import { networks, payments } from 'bitcoinjs-lib'
import bs58check from 'bs58check'
import { Buffer } from 'buffer'
import type {
  KeystoneBitcoinAccountPayload,
  KeystoneHdPublicKey,
  KeystoneMultiAccountsPayload
} from './account-ur'
import type { DeriveBitcoinAddressInput, DerivedBitcoinAddress } from '@/core/chains/bitcoin'

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const BITCOIN_TESTNET_VERSIONS = Object.freeze({ private: 0x04358394, public: 0x043587cf })
const MAX_ACCOUNT_INDEX = 0x7fffffff

export type KeystoneMultiCoinPublicAccount = Readonly<
  | { family: 'evm'; accountIndex: number; derivationPath: string; identity: string }
  | KeystoneBitcoinPublicAccount
  | { family: 'solana'; accountIndex: number; derivationPath: string; identity: string }
  | { family: 'tron'; accountIndex: number; derivationPath: string; identity: string }
  | { family: 'near'; accountIndex: number; derivationPath: string; identity: string }
>

export interface KeystoneBitcoinPublicAccount {
  readonly family: 'bitcoin'
  readonly accountIndex: number
  readonly derivationPath: string
  readonly identity: string
  readonly publicKeyHex: string
  readonly masterFingerprintHex: string
  readonly descriptor?: string
}

function readHexBytes(value: string, expectedBytes: readonly number[], label: string): Uint8Array {
  if (!expectedBytes.some(bytes => value.length === bytes * 2) || !/^[0-9a-f]+$/.test(value)) {
    throw new Error(`${label} is invalid`)
  }
  return Uint8Array.from(value.match(/../g) ?? [], byte => Number.parseInt(byte, 16))
}

function encodeBase58(bytes: Uint8Array): string {
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  let encoded = ''
  while (value > 0n) {
    const remainder = Number(value % 58n)
    encoded = BASE58_ALPHABET[remainder] + encoded
    value /= 58n
  }
  for (const byte of bytes) {
    if (byte !== 0) break
    encoded = `1${encoded}`
  }
  return encoded || '1'
}

function uncompressedSecp256k1PublicKey(publicKeyHex: string): Uint8Array {
  const compressed = readHexBytes(publicKeyHex, [33], 'Keystone secp256k1 public key')
  if (compressed[0] !== 0x02 && compressed[0] !== 0x03) {
    throw new Error('Keystone secp256k1 public key is invalid')
  }
  try {
    return secp256k1.ProjectivePoint.fromHex(compressed).toRawBytes(false)
  } catch {
    throw new Error('Keystone secp256k1 public key is invalid')
  }
}

function derivePublicKey(
  key: KeystoneHdPublicKey,
  relativePath: readonly number[],
  label: string
): Uint8Array {
  const publicKey = readHexBytes(key.publicKeyHex, [33], `${label} public key`)
  const chainCode = readHexBytes(key.chainCodeHex ?? '', [32], `${label} chain code`)
  const segments = key.derivationPath.slice(2).split('/')
  const last = segments.at(-1)
  if (!last?.endsWith("'")) throw new Error(`${label} origin is invalid`)
  const index = Number(last.slice(0, -1))
  if (!Number.isSafeInteger(index) || index < 0 || index > MAX_ACCOUNT_INDEX) {
    throw new Error(`${label} origin is invalid`)
  }
  const parentFingerprint = key.parentFingerprintHex
    ? Number.parseInt(key.parentFingerprintHex, 16)
    : 0
  try {
    let derived = new HDKey({
      depth: segments.length,
      index: 0x80000000 + index,
      parentFingerprint,
      chainCode,
      publicKey
    })
    for (const child of relativePath) derived = derived.deriveChild(child)
    if (!derived.publicKey) throw new Error('missing public key')
    return derived.publicKey
  } catch {
    throw new Error(`${label} public derivation failed`)
  }
}

function parseAccountIndex(path: string, pattern: RegExp, label: string): number {
  const match = pattern.exec(path)
  const accountIndex = match ? Number(match[1]) : -1
  if (!Number.isSafeInteger(accountIndex) || accountIndex < 0 || accountIndex > MAX_ACCOUNT_INDEX) {
    throw new Error(`${label} does not match the product derivation policy`)
  }
  return accountIndex
}

function assertSourceFingerprint(
  key: KeystoneHdPublicKey,
  masterFingerprintHex: string,
  label: string,
  required = false
): void {
  if (
    (required && key.sourceFingerprintHex === undefined) ||
    (key.sourceFingerprintHex !== undefined && key.sourceFingerprintHex !== masterFingerprintHex)
  ) {
    throw new Error(`${label} source fingerprint does not match the account export`)
  }
}

function evmAccount(key: KeystoneHdPublicKey): KeystoneMultiCoinPublicAccount {
  const accountLevel = /^m\/44'\/60'\/0'$/.test(key.derivationPath)
  const accountIndex = accountLevel
    ? 0
    : parseAccountIndex(key.derivationPath, /^m\/44'\/60'\/0'\/0\/([0-9]+)$/, 'Keystone EVM path')
  const compressed = accountLevel
    ? derivePublicKey(key, [0, accountIndex], 'Keystone EVM account')
    : readHexBytes(key.publicKeyHex, [33], 'Keystone EVM public key')
  const publicKey = uncompressedSecp256k1PublicKey(Buffer.from(compressed).toString('hex'))
  const identity = publicKeyToAddress(
    `0x${Buffer.from(publicKey).toString('hex')}` as `0x${string}`
  )
  return Object.freeze({
    family: 'evm',
    accountIndex,
    derivationPath: accountLevel ? `${key.derivationPath}/0/${accountIndex}` : key.derivationPath,
    identity
  })
}

function solanaAccount(key: KeystoneHdPublicKey): KeystoneMultiCoinPublicAccount {
  const accountIndex = parseAccountIndex(
    key.derivationPath,
    /^m\/44'\/501'\/([0-9]+)'\/0'$/,
    'Keystone Solana path'
  )
  const publicKey = readHexBytes(key.publicKeyHex, [32], 'Keystone Solana public key')
  return Object.freeze({
    family: 'solana',
    accountIndex,
    derivationPath: key.derivationPath,
    identity: encodeBase58(publicKey)
  })
}

function tronAccount(key: KeystoneHdPublicKey): KeystoneMultiCoinPublicAccount {
  const accountLevel = /^m\/44'\/195'\/0'$/.test(key.derivationPath)
  const accountIndex = accountLevel
    ? 0
    : parseAccountIndex(key.derivationPath, /^m\/44'\/195'\/0'\/0\/([0-9]+)$/, 'Keystone TRON path')
  const compressed = accountLevel
    ? derivePublicKey(key, [0, accountIndex], 'Keystone TRON account')
    : readHexBytes(key.publicKeyHex, [33], 'Keystone TRON public key')
  const publicKey = uncompressedSecp256k1PublicKey(Buffer.from(compressed).toString('hex'))
  const digest = Buffer.from(keccak256(toHex(publicKey.subarray(1))).slice(2), 'hex')
  const identity = bs58check.encode(Buffer.concat([Buffer.from([0x41]), digest.subarray(-20)]))
  return Object.freeze({
    family: 'tron',
    accountIndex,
    derivationPath: accountLevel ? `${key.derivationPath}/0/${accountIndex}` : key.derivationPath,
    identity
  })
}

function nearAccount(key: KeystoneHdPublicKey): KeystoneMultiCoinPublicAccount {
  const accountIndex = parseAccountIndex(
    key.derivationPath,
    /^m\/44'\/397'\/([0-9]+)'$/,
    'Keystone NEAR path'
  )
  const publicKey = readHexBytes(key.publicKeyHex, [32], 'Keystone NEAR public key')
  return Object.freeze({
    family: 'near',
    accountIndex,
    derivationPath: key.derivationPath,
    identity: Buffer.from(publicKey).toString('hex')
  })
}

export function projectKeystoneMultiCoinAccounts(
  payload: KeystoneMultiAccountsPayload,
  network: 'mainnet' | 'testnet'
): readonly KeystoneMultiCoinPublicAccount[] {
  const bitcoinCoinType = network === 'mainnet' ? 0 : 1
  const accounts = payload.keys.flatMap(key => {
    const project = (factory: () => KeystoneMultiCoinPublicAccount) => {
      assertSourceFingerprint(key, payload.masterFingerprintHex, 'Keystone public key', true)
      return [factory()]
    }
    if (
      (/^m\/44'\/60'\/0'$/.test(key.derivationPath) &&
        (key.note === undefined || key.note === 'account.standard')) ||
      (/^m\/44'\/60'\/0'\/0\/[0-9]+$/.test(key.derivationPath) &&
        key.note !== 'account.ledger_live')
    ) {
      return project(() => evmAccount(key))
    }
    if (new RegExp(`^m/84'/${bitcoinCoinType}'/[0-9]+'$`).test(key.derivationPath)) {
      return project(() => bitcoinAccountFromHdKey(key, payload.masterFingerprintHex, network))
    }
    if (/^m\/44'\/501'\/[0-9]+'\/0'$/.test(key.derivationPath)) {
      return project(() => solanaAccount(key))
    }
    if (
      /^m\/44'\/195'\/0'$/.test(key.derivationPath) ||
      /^m\/44'\/195'\/0'\/0\/[0-9]+$/.test(key.derivationPath)
    ) {
      return project(() => tronAccount(key))
    }
    if (/^m\/44'\/397'\/[0-9]+'$/.test(key.derivationPath)) {
      return project(() => nearAccount(key))
    }
    return []
  })
  if (accounts.length === 0) {
    throw new Error('Keystone account export has no supported product Accounts')
  }
  const scopes = accounts.map(account => `${account.family}:${account.accountIndex}`)
  if (new Set(scopes).size !== scopes.length) {
    throw new Error('Keystone account export contains duplicate product Accounts')
  }
  return Object.freeze(accounts)
}

function bitcoinNetwork(network: 'mainnet' | 'testnet') {
  return network === 'mainnet' ? networks.bitcoin : networks.testnet
}

function bitcoinAccountFromHdKey(
  key: KeystoneHdPublicKey,
  masterFingerprintHex: string,
  network: 'mainnet' | 'testnet'
): KeystoneBitcoinPublicAccount {
  const coinType = network === 'mainnet' ? 0 : 1
  const accountIndex = parseAccountIndex(
    key.derivationPath,
    new RegExp(`^m/84'/${coinType}'/([0-9]+)'$`),
    'Keystone Bitcoin path'
  )
  const receivePublicKey = derivePublicKey(key, [0, 0], 'Keystone Bitcoin account')
  const identity = payments.p2wpkh({
    pubkey: Buffer.from(receivePublicKey),
    network: bitcoinNetwork(network)
  }).address
  if (!identity) throw new Error('Keystone Bitcoin address derivation failed')
  return Object.freeze({
    family: 'bitcoin',
    accountIndex,
    derivationPath: `${key.derivationPath}/0/0`,
    identity,
    publicKeyHex: Buffer.from(receivePublicKey).toString('hex'),
    masterFingerprintHex
  })
}

function deriveBitcoinAddressFromHdKey(
  key: KeystoneHdPublicKey,
  masterFingerprintHex: string,
  input: DeriveBitcoinAddressInput,
  network: 'mainnet' | 'testnet'
): DerivedBitcoinAddress {
  const coinType = network === 'mainnet' ? 0 : 1
  if (
    input.chainId !==
      (network === 'mainnet'
        ? 'bip122:000000000019d6689c085ae165831e93'
        : 'bip122:000000000933ea01ad0ee984209779ba') ||
    input.addressType !== 'p2wpkh' ||
    !Number.isSafeInteger(input.accountIndex) ||
    input.accountIndex < 0 ||
    input.accountIndex > MAX_ACCOUNT_INDEX ||
    !Number.isSafeInteger(input.addressIndex) ||
    input.addressIndex < 0 ||
    input.addressIndex > MAX_ACCOUNT_INDEX
  ) {
    throw new Error('Keystone Bitcoin derivation request is invalid')
  }
  const expectedPath = `m/84'/${coinType}'/${input.accountIndex}'`
  if (key.derivationPath !== expectedPath) {
    throw new Error('Keystone Bitcoin account export does not match the requested Account')
  }
  assertSourceFingerprint(key, masterFingerprintHex, 'Keystone Bitcoin public key', true)
  const publicKey = derivePublicKey(
    key,
    [input.change ? 1 : 0, input.addressIndex],
    'Keystone Bitcoin account'
  )
  const derivedAddress = payments.p2wpkh({
    pubkey: Buffer.from(publicKey),
    network: bitcoinNetwork(network)
  }).address
  if (!derivedAddress) throw new Error('Keystone Bitcoin address derivation failed')
  return Object.freeze({
    chainId: input.chainId,
    addressType: 'p2wpkh' as const,
    accountIndex: input.accountIndex,
    change: input.change,
    addressIndex: input.addressIndex,
    address: derivedAddress,
    addressScheme: 'bitcoin-p2wpkh' as const,
    derivationScheme: 'bip84' as const,
    derivationPath: `${expectedPath}/${input.change ? 1 : 0}/${input.addressIndex}`,
    publicKey: `0x${Buffer.from(publicKey).toString('hex')}`,
    masterFingerprint: `0x${masterFingerprintHex}`
  })
}

export function deriveKeystoneMultiCoinBitcoinAddress(
  payload: KeystoneMultiAccountsPayload,
  input: DeriveBitcoinAddressInput,
  network: 'mainnet' | 'testnet'
): DerivedBitcoinAddress {
  const coinType = network === 'mainnet' ? 0 : 1
  const path = `m/84'/${coinType}'/${input.accountIndex}'`
  const matches = payload.keys.filter(key => key.derivationPath === path)
  if (matches.length !== 1) {
    throw new Error('Keystone Multi-Coin export has missing or ambiguous Bitcoin Account')
  }
  return deriveBitcoinAddressFromHdKey(matches[0], payload.masterFingerprintHex, input, network)
}

export function deriveKeystoneBitcoinAccountAddress(
  payload: KeystoneBitcoinAccountPayload,
  input: DeriveBitcoinAddressInput,
  network: 'mainnet' | 'testnet'
): DerivedBitcoinAddress {
  const coinType = network === 'mainnet' ? 0 : 1
  const path = `m/84'/${coinType}'/${input.accountIndex}'`
  const matches = payload.descriptors.filter(
    descriptor =>
      descriptor.scriptExpressions.length === 1 &&
      descriptor.scriptExpressions[0] === 'wpkh' &&
      descriptor.key.derivationPath === path
  )
  if (matches.length !== 1) {
    throw new Error('Keystone Bitcoin export has missing or ambiguous BIP-84 Account')
  }
  return deriveBitcoinAddressFromHdKey(matches[0].key, payload.masterFingerprintHex, input, network)
}

export function projectKeystoneBitcoinAccounts(
  payload: KeystoneBitcoinAccountPayload,
  network: 'mainnet' | 'testnet'
): readonly KeystoneBitcoinPublicAccount[] {
  const coinType = network === 'mainnet' ? 0 : 1
  const projected = payload.descriptors
    .filter(
      descriptor =>
        descriptor.scriptExpressions.length === 1 && descriptor.scriptExpressions[0] === 'wpkh'
    )
    .map(descriptor => {
      const accountIndex = parseAccountIndex(
        descriptor.key.derivationPath,
        new RegExp(`^m/84'/${coinType}'/([0-9]+)'$`),
        'Keystone Bitcoin path'
      )
      assertSourceFingerprint(
        descriptor.key,
        payload.masterFingerprintHex,
        'Bitcoin descriptor',
        true
      )
      const publicKey = readHexBytes(
        descriptor.key.publicKeyHex,
        [33],
        'Keystone Bitcoin public key'
      )
      const chainCode = readHexBytes(
        descriptor.key.chainCodeHex,
        [32],
        'Keystone Bitcoin chain code'
      )
      const parentFingerprint = descriptor.key.parentFingerprintHex
        ? Number.parseInt(descriptor.key.parentFingerprintHex, 16)
        : 0
      let receivePublicKey: Uint8Array | null
      try {
        receivePublicKey = new HDKey({
          ...(network === 'testnet' ? { versions: BITCOIN_TESTNET_VERSIONS } : {}),
          depth: 3,
          index: 0x80000000 + accountIndex,
          parentFingerprint,
          chainCode,
          publicKey
        })
          .deriveChild(0)
          .deriveChild(0).publicKey
      } catch {
        throw new Error('Keystone Bitcoin descriptor public derivation failed')
      }
      if (!receivePublicKey) throw new Error('Keystone Bitcoin descriptor has no public key')
      const identity = payments.p2wpkh({
        pubkey: Buffer.from(receivePublicKey),
        network: bitcoinNetwork(network)
      }).address
      if (!identity) throw new Error('Keystone Bitcoin address derivation failed')
      return Object.freeze({
        family: 'bitcoin' as const,
        accountIndex,
        derivationPath: `${descriptor.key.derivationPath}/0/0`,
        identity,
        publicKeyHex: Buffer.from(receivePublicKey).toString('hex'),
        masterFingerprintHex: payload.masterFingerprintHex,
        descriptor: descriptor.descriptor
      })
    })
  if (projected.length === 0) {
    throw new Error('Keystone Bitcoin account export has no BIP-84 descriptor')
  }
  if (new Set(projected.map(account => account.accountIndex)).size !== projected.length) {
    throw new Error('Keystone Bitcoin account export contains duplicate BIP-84 Accounts')
  }
  return Object.freeze(projected)
}
