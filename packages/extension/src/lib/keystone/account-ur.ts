// Must come first: installs the global Buffer required by the UR libraries.
import '../buffer-polyfill'
import { Buffer } from 'buffer'
import { HDKey } from '@scure/bip32'
import {
  CryptoAccount,
  CryptoMultiAccounts,
  type CryptoHDKey,
  type CryptoKeypath
} from '@keystonehq/bc-ur-registry'
import type { UR } from '@ngraveio/bc-ur'

const MAX_ACCOUNT_CBOR_BYTES = 256 * 1024
const MAX_MULTI_ACCOUNT_KEYS = 64
const MAX_BITCOIN_DESCRIPTORS = 32
const MAX_METADATA_LENGTH = 256

export const KEYSTONE_ACCOUNT_UR_TYPE = Object.freeze({
  MULTI_ACCOUNTS: 'crypto-multi-accounts',
  BITCOIN_ACCOUNT: 'crypto-account'
} as const)

export interface KeystoneHdPublicKey {
  readonly publicKeyHex: string
  readonly chainCodeHex?: string
  readonly derivationPath: string
  readonly sourceFingerprintHex?: string
  readonly parentFingerprintHex?: string
  readonly name?: string
  readonly note?: string
}

export interface KeystoneMultiAccountsPayload {
  readonly type: 'multi-accounts'
  readonly masterFingerprintHex: string
  readonly keys: readonly KeystoneHdPublicKey[]
  readonly device?: string
  readonly deviceId?: string
  readonly version?: string
}

export interface KeystoneBitcoinDescriptor {
  readonly descriptor: string
  readonly scriptExpressions: readonly string[]
  readonly key: KeystoneHdPublicKey & { readonly chainCodeHex: string }
}

export interface KeystoneBitcoinAccountPayload {
  readonly type: 'bitcoin-account'
  readonly masterFingerprintHex: string
  readonly descriptors: readonly KeystoneBitcoinDescriptor[]
}

function assertAccountUr(ur: UR, expectedType: string): void {
  if (ur.type !== expectedType) {
    throw new Error(`Unexpected QR content: ${ur.type} (expected ${expectedType})`)
  }
  if (ur.cbor.byteLength === 0 || ur.cbor.byteLength > MAX_ACCOUNT_CBOR_BYTES) {
    throw new Error('Keystone account QR payload has an invalid size')
  }
}

function readBytes(value: unknown, label: string, allowedLengths: readonly number[]): Buffer {
  if (!(value instanceof Uint8Array)) throw new Error(`${label} is missing`)
  const bytes = Buffer.from(value)
  if (!allowedLengths.includes(bytes.byteLength)) {
    throw new Error(`${label} has an invalid length`)
  }
  return bytes
}

function readOptionalBytes(
  value: unknown,
  label: string,
  allowedLengths: readonly number[]
): Buffer | undefined {
  if (value === undefined || value === null) return undefined
  return readBytes(value, label, allowedLengths)
}

function readOptionalMetadata(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.trim() !== value || value.length > MAX_METADATA_LENGTH) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function readDerivationPath(origin: CryptoKeypath | undefined, label: string): string {
  if (!origin) throw new Error(`${label} origin is missing`)
  const components = origin.getComponents()
  if (!Array.isArray(components) || components.length === 0 || components.length > 16) {
    throw new Error(`${label} derivation path is invalid`)
  }

  const segments = components.map(component => {
    if (component.isWildcard()) throw new Error(`${label} derivation path cannot contain wildcards`)
    const index = component.getIndex()
    if (!Number.isSafeInteger(index) || index < 0 || index > 0x7fffffff) {
      throw new Error(`${label} derivation path has an invalid index`)
    }
    return `${index}${component.isHardened() ? "'" : ''}`
  })
  return `m/${segments.join('/')}`
}

function readHdPublicKey(
  key: CryptoHDKey | undefined,
  label: string,
  options: Readonly<{ requireChainCode: boolean }>
): KeystoneHdPublicKey {
  if (!key) throw new Error(`${label} public key is missing`)
  if (key.isMaster()) throw new Error(`${label} must be a derived public key`)
  if (key.isPrivateKey()) throw new Error(`${label} must not contain private key material`)

  const publicKey = readBytes(key.getKey(), `${label} public key`, [32, 33])
  if (publicKey.byteLength === 33 && publicKey[0] !== 0x02 && publicKey[0] !== 0x03) {
    throw new Error(`${label} compressed public key is invalid`)
  }

  const chainCode = readOptionalBytes(key.getChainCode(), `${label} chain code`, [32])
  if (options.requireChainCode && chainCode === undefined) {
    throw new Error(`${label} chain code is missing`)
  }

  const origin = key.getOrigin()
  const sourceFingerprint = origin
    ? readOptionalBytes(origin.getSourceFingerprint(), `${label} source fingerprint`, [4])
    : undefined
  const parentFingerprint = readOptionalBytes(
    key.getParentFingerprint(),
    `${label} parent fingerprint`,
    [4]
  )
  const name = readOptionalMetadata(key.getName(), `${label} name`)
  const note = readOptionalMetadata(key.getNote(), `${label} note`)

  return Object.freeze({
    publicKeyHex: publicKey.toString('hex'),
    ...(chainCode === undefined ? {} : { chainCodeHex: chainCode.toString('hex') }),
    derivationPath: readDerivationPath(origin, label),
    ...(sourceFingerprint === undefined
      ? {}
      : { sourceFingerprintHex: sourceFingerprint.toString('hex') }),
    ...(parentFingerprint === undefined
      ? {}
      : { parentFingerprintHex: parentFingerprint.toString('hex') }),
    ...(name === undefined ? {} : { name }),
    ...(note === undefined ? {} : { note })
  })
}

function decodeAccountQr<T>(label: string, decode: () => T): T {
  try {
    return decode()
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Keystone ')) throw error
    throw new Error(`${label} could not be decoded`)
  }
}

function assertUniqueKeys(keys: readonly KeystoneHdPublicKey[], label: string): void {
  const identities = new Set<string>()
  for (const key of keys) {
    const identity = `${key.derivationPath}:${key.publicKeyHex}`
    if (identities.has(identity)) throw new Error(`${label} contains a duplicate public key`)
    identities.add(identity)
  }
}

// The vendor formatter's CommonJS bs58check export fails in the browser bundle.
function bitcoinOutputDescriptor(
  key: KeystoneHdPublicKey & { readonly chainCodeHex: string },
  scriptExpressions: readonly string[],
  childrenPath: string | undefined
): string {
  const path = key.derivationPath.slice(2).split('/')
  const last = path[path.length - 1]
  const hardened = last.endsWith("'")
  const index = Number.parseInt(hardened ? last.slice(0, -1) : last, 10)
  const publicKey = Buffer.from(key.publicKeyHex, 'hex')
  if (publicKey.length !== 33) throw new Error('Bitcoin descriptor public key is invalid')

  const xpub = new HDKey({
    depth: path.length,
    index: index + (hardened ? 0x80000000 : 0),
    parentFingerprint: key.parentFingerprintHex ? Number.parseInt(key.parentFingerprintHex, 16) : 0,
    chainCode: Buffer.from(key.chainCodeHex, 'hex'),
    publicKey
  }).publicExtendedKey
  const origin = key.sourceFingerprintHex ? `${key.sourceFingerprintHex}/${path.join('/')}` : ''
  const content = `${origin}${xpub}${childrenPath ? `/${childrenPath}` : ''}`
  return scriptExpressions.reduceRight((value, expression) => `${expression}(${value})`, content)
}

export function parseMultiAccounts(ur: UR): KeystoneMultiAccountsPayload {
  assertAccountUr(ur, KEYSTONE_ACCOUNT_UR_TYPE.MULTI_ACCOUNTS)
  const decoded = decodeAccountQr('Keystone account QR', () =>
    CryptoMultiAccounts.fromCBOR(Buffer.from(ur.cbor))
  )
  const masterFingerprint = readBytes(
    decoded.getMasterFingerprint(),
    'Keystone master fingerprint',
    [4]
  )
  const decodedKeys = decoded.getKeys()
  if (
    !Array.isArray(decodedKeys) ||
    decodedKeys.length === 0 ||
    decodedKeys.length > MAX_MULTI_ACCOUNT_KEYS
  ) {
    throw new Error('Keystone account QR contains an invalid number of public keys')
  }
  const keys = Object.freeze(
    decodedKeys.map((key, index) =>
      readHdPublicKey(key, `Keystone public key ${index + 1}`, { requireChainCode: false })
    )
  )
  assertUniqueKeys(keys, 'Keystone account QR')

  const device = readOptionalMetadata(decoded.getDevice(), 'Keystone device name')
  if (device !== undefined && !device.toLowerCase().includes('keystone')) {
    throw new Error('Account QR was not exported by a supported Keystone device')
  }
  const deviceId = readOptionalMetadata(decoded.getDeviceId(), 'Keystone device ID')
  const version = readOptionalMetadata(decoded.getVersion(), 'Keystone version')

  return Object.freeze({
    type: 'multi-accounts',
    masterFingerprintHex: masterFingerprint.toString('hex'),
    keys,
    ...(device === undefined ? {} : { device }),
    ...(deviceId === undefined ? {} : { deviceId }),
    ...(version === undefined ? {} : { version })
  })
}

export function parseBitcoinAccount(ur: UR): KeystoneBitcoinAccountPayload {
  assertAccountUr(ur, KEYSTONE_ACCOUNT_UR_TYPE.BITCOIN_ACCOUNT)
  const decoded = decodeAccountQr('Bitcoin account QR', () =>
    CryptoAccount.fromCBOR(Buffer.from(ur.cbor))
  )
  const masterFingerprint = readBytes(
    decoded.getMasterFingerprint(),
    'Bitcoin master fingerprint',
    [4]
  )
  const outputs = decoded.getOutputDescriptors()
  if (!Array.isArray(outputs) || outputs.length === 0 || outputs.length > MAX_BITCOIN_DESCRIPTORS) {
    throw new Error('Bitcoin account QR contains an invalid number of descriptors')
  }

  const descriptors = Object.freeze(
    outputs.map((output, index) => {
      const label = `Bitcoin descriptor ${index + 1}`
      const expressions = output.getScriptExpressions()
      if (!Array.isArray(expressions) || expressions.length === 0 || expressions.length > 4) {
        throw new Error(`${label} script expression is invalid`)
      }
      const scriptExpressions = Object.freeze(
        expressions.map(expression => {
          const value = expression.getExpression()
          if (typeof value !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(value)) {
            throw new Error(`${label} script expression is invalid`)
          }
          return value
        })
      )
      const key = readHdPublicKey(output.getHDKey(), label, { requireChainCode: true })
      if (key.chainCodeHex === undefined) throw new Error(`${label} chain code is missing`)
      const descriptor = bitcoinOutputDescriptor(
        { ...key, chainCodeHex: key.chainCodeHex },
        scriptExpressions,
        output.getHDKey()?.getChildren()?.getPath()
      )
      if (descriptor.length === 0 || descriptor.length > 4096) {
        throw new Error(`${label} is invalid`)
      }
      return Object.freeze({
        descriptor,
        scriptExpressions,
        key: Object.freeze({ ...key, chainCodeHex: key.chainCodeHex })
      })
    })
  )
  assertUniqueKeys(
    descriptors.map(descriptor => descriptor.key),
    'Bitcoin account QR'
  )

  return Object.freeze({
    type: 'bitcoin-account',
    masterFingerprintHex: masterFingerprint.toString('hex'),
    descriptors
  })
}
