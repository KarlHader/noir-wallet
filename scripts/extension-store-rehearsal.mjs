import { generateKeyPairSync, createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { signCrx3, verifyCrx3 } from './lib/crx3.mjs'
import { readZipManifest } from './lib/release-zip.mjs'
import { createTestZip } from '../packages/extension/tests/fixtures/store-zip.mjs'

// Only synthetic content and an ephemeral key cross the CI artifact boundary.
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const [command, directory, expectedDigest] = process.argv.slice(2)
if (!directory || !['create', 'verify'].includes(command)) {
  throw new Error(
    'Usage: extension-store-rehearsal.mjs create|verify <directory> [metadata-digest]'
  )
}
if (command === 'create') {
  mkdirSync(directory, { recursive: true })
  if (readdirSync(directory).length) throw new Error('Rehearsal directory must be empty')
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const publicKeySha256 = sha256(publicKey.export({ type: 'spki', format: 'der' }))
  const zip = createTestZip({
    'manifest.json': JSON.stringify({
      manifest_version: 3,
      version: '0.0.1',
      name: 'Store rehearsal fixture'
    }),
    'fixture.txt': 'This is a synthetic CI fixture, not a wallet release.'
  })
  const { crx } = signCrx3(
    zip,
    privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeySha256
  )
  const metadata = Buffer.from(
    JSON.stringify({
      purpose: 'rehearsal',
      zipSha256: sha256(zip),
      zipSize: zip.length,
      publicKeySha256,
      crxSha256: sha256(crx)
    })
  )
  writeFileSync(path.join(directory, 'rehearsal.crx'), crx)
  writeFileSync(path.join(directory, 'rehearsal.json'), metadata)
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `metadata_sha256=${sha256(metadata)}\n`, { flag: 'a' })
  }
  process.stdout.write(`Rehearsal metadata SHA-256: ${sha256(metadata)}\n`)
} else {
  if (readdirSync(directory).sort().join(',') !== 'rehearsal.crx,rehearsal.json')
    throw new Error('Invalid rehearsal inventory')
  const metadataBytes = readFileSync(path.join(directory, 'rehearsal.json'))
  if (!/^[0-9a-f]{64}$/.test(expectedDigest ?? '') || sha256(metadataBytes) !== expectedDigest) {
    throw new Error('Rehearsal metadata changed between runners')
  }
  const metadata = JSON.parse(metadataBytes)
  if (metadata.purpose !== 'rehearsal') throw new Error('Expected a rehearsal fixture')
  const crx = readFileSync(path.join(directory, 'rehearsal.crx'))
  if (sha256(crx) !== metadata.crxSha256) throw new Error('Rehearsal CRX changed between runners')
  const { zip } = verifyCrx3(crx, {
    expectedZipSha256: metadata.zipSha256,
    expectedZipSize: metadata.zipSize,
    expectedPublicKeySha256: metadata.publicKeySha256
  })
  if (readZipManifest(zip).version !== '0.0.1') throw new Error('Rehearsal manifest mismatch')
  process.stdout.write(
    'Synthetic CRX signature and original ZIP verified on the receiving runner.\n'
  )
}
