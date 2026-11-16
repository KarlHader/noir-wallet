import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { signCrx3, verifyCrx3 } from '../../../../../scripts/lib/crx3.mjs'
import { readZipEntry, readZipManifest } from '../../../../../scripts/lib/release-zip.mjs'
import { createTestZip } from '../../fixtures/store-zip.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const manifest = JSON.stringify({ manifest_version: 3, name: 'Test extension', version: '1.2.3' })
const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' })
const publicKeySha256 = hash(createPublicKey(privateKey).export({ format: 'der', type: 'spki' }))

function acceptedZip() {
  return createTestZip({ 'manifest.json': manifest, 'assets/example.txt': 'accepted bytes' })
}

test('signs the accepted ZIP bytes and verifies the pinned RSA public key', () => {
  const zip = acceptedZip()
  const { crx, publicKeySha256: signedFingerprint } = signCrx3(zip, privateKeyPem, publicKeySha256)
  assert.equal(signedFingerprint, publicKeySha256)
  const verified = verifyCrx3(crx, {
    expectedZipSha256: hash(zip),
    expectedZipSize: zip.length,
    expectedPublicKeySha256: publicKeySha256
  })
  assert.deepEqual(verified.zip, zip)
  assert.equal(verified.crxSha256, hash(crx))
  assert.equal(readZipManifest(verified.zip).version, '1.2.3')
})

test('rejects changed ZIP bytes, broken proof, and a different signing key', () => {
  const zip = acceptedZip()
  const { crx } = signCrx3(zip, privateKeyPem, publicKeySha256)
  const expected = {
    expectedZipSha256: hash(zip),
    expectedZipSize: zip.length,
    expectedPublicKeySha256: publicKeySha256
  }
  const changedZip = Buffer.from(crx)
  changedZip[changedZip.length - 1] ^= 1
  assert.throws(() => verifyCrx3(changedZip, expected), /ZIP does not match/)

  const changedProof = Buffer.from(crx)
  // The signature is the final 256 bytes of the first length-delimited proof.
  const firstFieldLength = (crx[13] & 0x7f) | ((crx[14] & 0x7f) << 7)
  const signatureEnd = 15 + firstFieldLength
  changedProof[signatureEnd - 1] ^= 1
  assert.throws(() => verifyCrx3(changedProof, expected), /Invalid CRX3 signature/)

  assert.throws(
    () => verifyCrx3(crx, { ...expected, expectedPublicKeySha256: '0'.repeat(64) }),
    /fingerprint mismatch/
  )
  assert.throws(() => signCrx3(zip, privateKeyPem, '0'.repeat(64)), /fingerprint mismatch/)
  assert.throws(
    () => signCrx3(zip, `bad key ${privateKeyPem}`, publicKeySha256),
    error => error.message === 'Invalid CRX3 signing key'
  )
})

test('verifies Chromium’s fixed developer proof without relying on our signer', () => {
  // Chromium Authors, BSD-3-Clause: components/test/data/crx_file/valid_no_publisher.crx3
  // https://chromium.googlesource.com/chromium/src/+/refs/tags/145.0.7566.1/components/test/data/crx_file/valid_no_publisher.crx3
  const original = readFileSync(
    new URL('../../fixtures/chromium-valid-no-publisher.crx3', import.meta.url)
  )
  assert.equal(hash(original), 'd033c510f9e4ee081ccb60ea2bf530dc2e5cb0e71085b55503c8b13b74515fe4')
  const headerSize = original.readUInt32LE(8)
  const header = original.subarray(12, 12 + headerSize)
  assert.equal(header[0], 0x12)
  const firstLength = (header[1] & 0x7f) | ((header[2] & 0x7f) << 7)
  const developerHeader = header.subarray(3 + firstLength)
  assert.equal(developerHeader[0], 0x12)
  const size = Buffer.alloc(4)
  size.writeUInt32LE(developerHeader.length)
  const zip = original.subarray(12 + headerSize)
  const singleProofCrx = Buffer.concat([original.subarray(0, 8), size, developerHeader, zip])
  const result = verifyCrx3(singleProofCrx, {
    expectedZipSha256: 'e05ced14ad9d9b9c220dd10861c73b0f39f04038d6a361c45f4983d57acfe632',
    expectedZipSize: 12244,
    expectedPublicKeySha256: 'e996dfa8eed34bc6614a57bb7308cd7e519bcc690841e1969f7cb173ef16800a'
  })
  assert.deepEqual(result.zip, zip)
  assert.equal(readZipManifest(result.zip).version, '394')
})

test('reads stored and deflated entries with data descriptors and size limits', () => {
  for (const options of [{}, { deflate: true }, { deflate: true, dataDescriptor: true }]) {
    const zip = createTestZip({ 'manifest.json': manifest, 'receipt.json': '{"ok":true}' }, options)
    assert.deepEqual(readZipManifest(zip), JSON.parse(manifest))
    assert.equal(readZipEntry(zip, 'receipt.json', { maxBytes: 100 }).toString(), '{"ok":true}')
    assert.throws(() => readZipEntry(zip, 'manifest.json', { maxBytes: 5 }), /exceeds size limit/)
  }
})

test('rejects ZIP path ambiguity, links, encryption, ZIP64 and inconsistent headers', () => {
  assert.throws(() => readZipManifest(createTestZip({ '../manifest.json': manifest })), /Unsafe/)
  assert.throws(
    () => readZipManifest(createTestZip({ 'manifest.json': manifest, 'MANIFEST.JSON': manifest })),
    /Duplicate/
  )
  assert.throws(
    () => readZipManifest(createTestZip({ 'manifest.json': manifest, 'manifest.json/': '' })),
    /Duplicate/
  )
  assert.throws(
    () => readZipManifest(createTestZip({ 'manifest.json': manifest, 'manifest.json/child': '' })),
    /Ambiguous/
  )
  const zip = acceptedZip()
  const central = zip.readUInt32LE(zip.length - 6)
  const symlink = Buffer.from(zip)
  symlink.writeUInt32LE((0o120777 << 16) >>> 0, central + 38)
  assert.throws(() => readZipManifest(symlink), /links and special files/)
  const encrypted = Buffer.from(zip)
  encrypted.writeUInt16LE(0x801, central + 8)
  assert.throws(() => readZipManifest(encrypted), /Unsupported ZIP entry/)
  const zip64 = Buffer.from(zip)
  zip64.writeUInt32LE(0xffffffff, zip64.length - 6)
  assert.throws(() => readZipManifest(zip64), /ZIP64/)
  const mismatch = Buffer.from(zip)
  mismatch.writeUInt32LE(1, 18)
  assert.throws(() => readZipManifest(mismatch), /local sizes do not match/)
})
