import {
  constants,
  createHash,
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify
} from 'node:crypto'

const SIGNATURE_CONTEXT = Buffer.from('CRX3 SignedData\0')
const MAX_HEADER_SIZE = 1024 * 1024
const SHA256 = /^[0-9a-f]{64}$/i

function requireSha256(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`Invalid ${label}`)
  return value.toLowerCase()
}

function requireBytes(value, label) {
  if (!Buffer.isBuffer(value)) throw new Error(`${label} must be a Buffer`)
  return value
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function uint32(value) {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32LE(value)
  return bytes
}

function varint(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid protobuf integer')
  const bytes = []
  do {
    let byte = value % 128
    value = Math.floor(value / 128)
    if (value) byte |= 0x80
    bytes.push(byte)
  } while (value)
  return Buffer.from(bytes)
}

function bytesField(number, value) {
  return Buffer.concat([varint(number * 8 + 2), varint(value.length), value])
}

function readVarint(bytes, cursor) {
  let value = 0
  let scale = 1
  for (let index = 0; index < 10 && cursor.offset < bytes.length; index++) {
    const byte = bytes[cursor.offset++]
    value += (byte & 0x7f) * scale
    if (!Number.isSafeInteger(value)) throw new Error('Invalid CRX3 protobuf integer')
    if (!(byte & 0x80)) return value
    scale *= 128
  }
  throw new Error('Invalid CRX3 protobuf integer')
}

function readFields(bytes, allowed) {
  const cursor = { offset: 0 }
  const fields = new Map()
  while (cursor.offset < bytes.length) {
    const tag = readVarint(bytes, cursor)
    const number = Math.floor(tag / 8)
    if (tag % 8 !== 2 || !allowed.has(number) || fields.has(number)) {
      throw new Error('Unexpected CRX3 protobuf field')
    }
    const length = readVarint(bytes, cursor)
    if (length > bytes.length - cursor.offset) throw new Error('Truncated CRX3 protobuf field')
    fields.set(number, bytes.subarray(cursor.offset, cursor.offset + length))
    cursor.offset += length
  }
  return fields
}

function onlyField(fields, number) {
  const value = fields.get(number)
  if (!value) throw new Error('Missing CRX3 protobuf field')
  return value
}

function signingInput(signedHeader, zip) {
  return [SIGNATURE_CONTEXT, uint32(signedHeader.length), signedHeader, zip]
}

function parsePublicKey(spki) {
  let key
  try {
    key = createPublicKey({ key: spki, format: 'der', type: 'spki' })
  } catch {
    throw new Error('Invalid CRX3 public key')
  }
  if (
    key.asymmetricKeyType !== 'rsa' ||
    !Number.isSafeInteger(key.asymmetricKeyDetails?.modulusLength) ||
    key.asymmetricKeyDetails.modulusLength < 2048
  ) {
    throw new Error('Invalid CRX3 public key')
  }
  return key
}

export function signCrx3(zipBytes, privateKeyPem, expectedPublicKeySha256) {
  const zip = requireBytes(zipBytes, 'ZIP')
  const expected = requireSha256(expectedPublicKeySha256, 'public key SHA-256')
  if (!zip.length) throw new Error('ZIP must not be empty')
  let privateKey
  try {
    privateKey = createPrivateKey(privateKeyPem)
  } catch {
    throw new Error('Invalid CRX3 signing key')
  }
  if (
    privateKey.asymmetricKeyType !== 'rsa' ||
    !Number.isSafeInteger(privateKey.asymmetricKeyDetails?.modulusLength) ||
    privateKey.asymmetricKeyDetails?.modulusLength < 2048
  ) {
    throw new Error('Invalid CRX3 signing key')
  }
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' })
  const publicKeySha256 = sha256(spki)
  if (publicKeySha256 !== expected) throw new Error('CRX3 signing key fingerprint mismatch')

  const signedHeader = bytesField(1, Buffer.from(publicKeySha256, 'hex').subarray(0, 16))
  const signer = createSign('RSA-SHA256')
  for (const part of signingInput(signedHeader, zip)) signer.update(part)
  let signature
  try {
    signature = signer.sign({ key: privateKey, padding: constants.RSA_PKCS1_PADDING })
  } catch {
    throw new Error('CRX3 signing failed')
  }
  const proof = Buffer.concat([bytesField(1, spki), bytesField(2, signature)])
  const header = Buffer.concat([bytesField(2, proof), bytesField(10000, signedHeader)])
  if (header.length > MAX_HEADER_SIZE) throw new Error('CRX3 header is too large')
  const crx = Buffer.concat([Buffer.from('Cr24'), uint32(3), uint32(header.length), header, zip])
  return { crx, publicKeySha256 }
}

export function verifyCrx3(crxBytes, options) {
  const crx = requireBytes(crxBytes, 'CRX3')
  const expectedZipSha256 = requireSha256(options?.expectedZipSha256, 'ZIP SHA-256')
  const expectedPublicKeySha256 = requireSha256(
    options?.expectedPublicKeySha256,
    'public key SHA-256'
  )
  if (!Number.isSafeInteger(options?.expectedZipSize) || options.expectedZipSize < 1) {
    throw new Error('Invalid expected ZIP size')
  }
  if (crx.length < 12 || crx.toString('ascii', 0, 4) !== 'Cr24' || crx.readUInt32LE(4) !== 3) {
    throw new Error('Invalid CRX3 preamble')
  }
  const headerSize = crx.readUInt32LE(8)
  if (headerSize > MAX_HEADER_SIZE || headerSize > crx.length - 12) {
    throw new Error('Invalid CRX3 header size')
  }
  const fields = readFields(crx.subarray(12, 12 + headerSize), new Set([2, 10000]))
  if (fields.size !== 2) throw new Error('Invalid CRX3 header')
  const proof = readFields(onlyField(fields, 2), new Set([1, 2]))
  if (proof.size !== 2) throw new Error('Invalid CRX3 RSA proof')
  const spki = onlyField(proof, 1)
  const signature = onlyField(proof, 2)
  const publicKey = parsePublicKey(spki)
  const publicKeySha256 = sha256(spki)
  if (publicKeySha256 !== expectedPublicKeySha256) {
    throw new Error('CRX3 public key fingerprint mismatch')
  }
  const signedHeader = onlyField(fields, 10000)
  const signedFields = readFields(signedHeader, new Set([1]))
  const id = onlyField(signedFields, 1)
  if (
    signedFields.size !== 1 ||
    id.length !== 16 ||
    !id.equals(Buffer.from(publicKeySha256, 'hex').subarray(0, 16))
  ) {
    throw new Error('CRX3 ID does not match public key')
  }
  const zip = crx.subarray(12 + headerSize)
  if (zip.length !== options.expectedZipSize || sha256(zip) !== expectedZipSha256) {
    throw new Error('CRX3 ZIP does not match accepted artifact')
  }
  const verifier = createVerify('RSA-SHA256')
  for (const part of signingInput(signedHeader, zip)) verifier.update(part)
  if (!verifier.verify({ key: publicKey, padding: constants.RSA_PKCS1_PADDING }, signature)) {
    throw new Error('Invalid CRX3 signature')
  }
  return { zip, publicKeySha256, crxSha256: sha256(crx) }
}
