// Must come first: installs the global Buffer required by the UR libraries.
import '../buffer-polyfill'
import { Buffer } from 'buffer'
import { CryptoKeypath, DataItem, PathComponent, extend } from '@keystonehq/bc-ur-registry'
import { UR, UREncoder } from '@ngraveio/bc-ur'

export const KEYSTONE_ETHEREUM_SIGN_REQUEST_UR_TYPE = 'eth-sign-request' as const
export const KEYSTONE_ETHEREUM_SIGNATURE_UR_TYPE = 'eth-signature' as const
export const DEFAULT_ETHEREUM_SIGN_REQUEST_FRAGMENT_LENGTH = 200

const ETHEREUM_TYPED_TRANSACTION_DATA_TYPE = 4
const MAX_CBOR_BYTES = 256 * 1024
const MAX_UNSIGNED_TRANSACTION_BYTES = 128 * 1024
const MAX_PATH_INDEX = 0x7fffffff

export interface KeystoneEthereumSignRequestInput {
  readonly requestId: string
  readonly unsignedTransactionHex: string
  readonly chainId: number
  readonly derivationPath: string
  readonly masterFingerprintHex: string
  readonly address: string
}

export interface KeystoneEthereumSignRequest extends KeystoneEthereumSignRequestInput {
  readonly cborBase64: string
}

export interface KeystoneEthereumSignature {
  readonly requestId: string
  readonly signatureHex: string
  readonly origin?: string
}

function bytes(value: unknown, expectedLength: number, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== expectedLength) {
    throw new Error(`Invalid ${label}`)
  }
  return Uint8Array.from(value)
}

function bytesToHex(value: Uint8Array): string {
  return [...value].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function hexToBytes(value: string, expectedBytes: number | undefined, label: string): Uint8Array {
  if (
    !/^(?:[0-9a-f]{2})+$/.test(value) ||
    (expectedBytes !== undefined && value.length !== expectedBytes * 2)
  ) {
    throw new Error(`Invalid ${label}`)
  }
  return Uint8Array.from(value.match(/../g) ?? [], byte => Number.parseInt(byte, 16))
}

function parseUuid(value: string): Uint8Array {
  const match =
    /^([0-9a-f]{8})-([0-9a-f]{4})-([1-8][0-9a-f]{3})-([89ab][0-9a-f]{3})-([0-9a-f]{12})$/i.exec(
      value
    )
  if (!match) throw new Error('Invalid Keystone Ethereum request ID')
  return hexToBytes(match.slice(1).join('').toLowerCase(), 16, 'Keystone Ethereum request ID')
}

function formatUuid(value: Uint8Array): string {
  const hex = bytesToHex(bytes(value, 16, 'Keystone Ethereum request ID'))
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function parseDerivationPath(value: string): readonly PathComponent[] {
  if (value.length > 128 || !/^m(?:\/(?:0|[1-9][0-9]{0,9})'?){2,16}$/.test(value)) {
    throw new Error('Invalid Keystone Ethereum derivation path')
  }
  return Object.freeze(
    value
      .slice(2)
      .split('/')
      .map(segment => {
        const hardened = segment.endsWith("'")
        const index = Number(hardened ? segment.slice(0, -1) : segment)
        if (!Number.isSafeInteger(index) || index < 0 || index > MAX_PATH_INDEX) {
          throw new Error('Invalid Keystone Ethereum derivation path')
        }
        return new PathComponent({ index, hardened })
      })
  )
}

function assertCanonicalChainId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Invalid Keystone Ethereum chain ID')
  }
  return value
}

function assertCanonicalAddress(value: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error('Invalid Keystone Ethereum address')
  }
  return value.toLowerCase()
}

function assertCanonicalUnsignedTransaction(value: string): string {
  if (
    !/^0x02(?:[0-9a-f]{2})+$/.test(value) ||
    (value.length - 2) / 2 > MAX_UNSIGNED_TRANSACTION_BYTES
  ) {
    throw new Error('Invalid unsigned Keystone Ethereum transaction')
  }
  return value
}

function createRequestCbor(input: KeystoneEthereumSignRequestInput): Uint8Array {
  const requestId = parseUuid(input.requestId)
  const unsignedTransactionHex = assertCanonicalUnsignedTransaction(input.unsignedTransactionHex)
  const chainId = assertCanonicalChainId(input.chainId)
  const address = assertCanonicalAddress(input.address)
  const masterFingerprint = hexToBytes(
    input.masterFingerprintHex.toLowerCase(),
    4,
    'Keystone master fingerprint'
  )
  const keypath = new CryptoKeypath(
    [...parseDerivationPath(input.derivationPath)],
    Buffer.from(masterFingerprint)
  )
  const taggedKeypath = keypath.toDataItem()
  taggedKeypath.setTag(keypath.getRegistryType().getTag())
  const map: Record<number, unknown> = {
    1: new DataItem(Buffer.from(requestId), extend.RegistryTypes.UUID.getTag()),
    2: Buffer.from(unsignedTransactionHex.slice(2), 'hex'),
    3: ETHEREUM_TYPED_TRANSACTION_DATA_TYPE,
    4: chainId,
    5: taggedKeypath,
    6: Buffer.from(address.slice(2), 'hex'),
    7: 'Noir Wallet'
  }
  const encoded = new Uint8Array(extend.encodeDataItem(new DataItem(map)))
  if (encoded.byteLength === 0 || encoded.byteLength > MAX_CBOR_BYTES) {
    throw new Error('Invalid Keystone Ethereum signing request')
  }
  return encoded
}

export function createKeystoneEthereumSignRequest(
  input: KeystoneEthereumSignRequestInput
): KeystoneEthereumSignRequest {
  const cbor = createRequestCbor(input)
  return Object.freeze({
    requestId: formatUuid(parseUuid(input.requestId)),
    unsignedTransactionHex: assertCanonicalUnsignedTransaction(input.unsignedTransactionHex),
    chainId: assertCanonicalChainId(input.chainId),
    derivationPath: input.derivationPath,
    masterFingerprintHex: input.masterFingerprintHex.toLowerCase(),
    address: assertCanonicalAddress(input.address),
    cborBase64: Buffer.from(cbor).toString('base64')
  })
}

export function createKeystoneEthereumSignRequestUREncoder(
  cborBytes: Uint8Array,
  maxFragmentLength = DEFAULT_ETHEREUM_SIGN_REQUEST_FRAGMENT_LENGTH
): UREncoder {
  if (
    !(cborBytes instanceof Uint8Array) ||
    cborBytes.byteLength === 0 ||
    cborBytes.byteLength > MAX_CBOR_BYTES ||
    !Number.isSafeInteger(maxFragmentLength) ||
    maxFragmentLength < 10 ||
    maxFragmentLength > 4096
  ) {
    throw new Error('Invalid Keystone Ethereum signing request')
  }
  return new UREncoder(
    new UR(Buffer.from(cborBytes), KEYSTONE_ETHEREUM_SIGN_REQUEST_UR_TYPE),
    maxFragmentLength
  )
}

function readMap(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`)
  }
  return value as Record<string, unknown>
}

function parseSignatureCbor(cbor: Uint8Array): KeystoneEthereumSignature {
  if (!(cbor instanceof Uint8Array) || cbor.byteLength === 0 || cbor.byteLength > MAX_CBOR_BYTES) {
    throw new Error('Invalid Keystone Ethereum signature')
  }
  let map: Record<string, unknown>
  try {
    map = readMap(extend.decodeToDataItem(Buffer.from(cbor)).getData(), 'Keystone signature map')
  } catch {
    throw new Error('Invalid Keystone Ethereum signature')
  }
  const keys = Object.keys(map).sort()
  if (
    (keys.length !== 2 && keys.length !== 3) ||
    keys[0] !== '1' ||
    keys[1] !== '2' ||
    (keys.length === 3 && keys[2] !== '3')
  ) {
    throw new Error('Invalid Keystone Ethereum signature')
  }
  const requestIdItem = map[1]
  if (
    !(requestIdItem instanceof DataItem) ||
    requestIdItem.getTag() !== extend.RegistryTypes.UUID.getTag()
  ) {
    throw new Error('Invalid Keystone Ethereum signature request ID')
  }
  const signature = bytes(map[2], 65, 'Keystone Ethereum signature')
  if (signature[64] !== 0 && signature[64] !== 1) {
    throw new Error('Invalid Keystone Ethereum signature recovery ID')
  }
  const origin = map[3]
  if (
    origin !== undefined &&
    (typeof origin !== 'string' ||
      origin.length === 0 ||
      origin.length > 256 ||
      origin.trim() !== origin)
  ) {
    throw new Error('Invalid Keystone Ethereum signature origin')
  }
  return Object.freeze({
    requestId: formatUuid(bytes(requestIdItem.getData(), 16, 'Keystone Ethereum request ID')),
    signatureHex: `0x${bytesToHex(signature)}`,
    ...(typeof origin === 'string' ? { origin } : {})
  })
}

export function parseKeystoneEthereumSignature(ur: UR): KeystoneEthereumSignature {
  if (ur.type !== KEYSTONE_ETHEREUM_SIGNATURE_UR_TYPE) {
    throw new Error(
      `Unexpected QR content: ${ur.type} (expected ${KEYSTONE_ETHEREUM_SIGNATURE_UR_TYPE})`
    )
  }
  return parseSignatureCbor(new Uint8Array(ur.cbor))
}

export function parseKeystoneEthereumSignatureCborBase64(value: string): KeystoneEthereumSignature {
  if (
    value.length === 0 ||
    value.length > MAX_CBOR_BYTES * 2 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error('Invalid Keystone Ethereum signature')
  }
  return parseSignatureCbor(new Uint8Array(Buffer.from(value, 'base64')))
}
