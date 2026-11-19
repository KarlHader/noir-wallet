import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blake2b } from '@noble/hashes/blake2b'
import { decodeMultisigRecipient } from '../../../src/core/multisig/recipient'

// ZIP 316 vectors from zcash_address/src/kind/unified/address/test_vectors.rs.
const orchardOnly =
  'u1dqavtnjvu42hlsjw6sc2mxajqlyt03zg8l4luykz9fnchunq74nqxhfp58h5n5xfpyqhheax8thta8lfkjgp8wqwsavc0g4mgu4du02c'
const orchardWithSaplingAndP2pkh =
  'u1pg2aaph7jp8rpf6yhsza25722sg5fcn3vaca6ze27hqjw7jvvhhuxkpcg0ge9xh6drsgdkda8qjq5chpehkcpxf87rnjryjqwymdheptpvnljqqrjqzjwkc2ma6hcq666kgwfytxwac8eyex6ndgr6ezte66706e3vaqrd25dzvzkc69kw0jgywtd0cmq52q5lkw6uh7hyvzjse8ksx'
const saplingOnly =
  'u1l8xunezsvhq8fgzfl7404m450nwnd76zshscn6nfys7vyz2ywyh4cc5daaq0c7q2su5lqfh23sp7fkf3kt27ve5948mzpfdvckzaect2jtte308mkwlycj2u0eac077wu70vqcetkxf'
const rawOrchard = Uint8Array.from(
  Buffer.from(
    '5178924f7067eac261044ca27ba3cf52f798486973af0795e61587aa1b1ecad333dc520497edc61df88980',
    'hex'
  )
)

// Fixture encoder uses the forward ZIP 316 transform to exercise invalid raw containers
// behind valid Bech32m checksums. The public vectors above independently check decoding.
function fixtureAddress(hrp: string, raw: Uint8Array, paddingHrp = hrp): string {
  const bytes = new Uint8Array(raw.length + 16)
  bytes.set(raw)
  bytes.set(new TextEncoder().encode(paddingHrp), raw.length)
  const left = bytes.subarray(0, Math.min(64, Math.floor(bytes.length / 2)))
  const right = bytes.subarray(left.length)
  const personal = new Uint8Array(16)
  personal.set(new TextEncoder().encode('UA_F4Jumble_'))
  const xor = (target: Uint8Array, input: Uint8Array, length: number) => {
    const hash = blake2b(input, { dkLen: length, personalization: personal })
    for (let i = 0; i < target.length; i++) target[i] ^= hash[i]
  }
  const g = (round: number) => {
    personal[12] = 0x47
    personal[13] = round
    for (let block = 0; block * 64 < right.length; block++) {
      personal[14] = block & 255
      personal[15] = block >>> 8
      xor(right.subarray(block * 64, (block + 1) * 64), left, 64)
    }
  }
  const h = (round: number) => {
    personal[12] = 0x48
    personal[13] = round
    personal[14] = 0
    personal[15] = 0
    xor(left, right, left.length)
  }
  g(0)
  h(0)
  g(1)
  h(1)
  const alphabet = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
  const data: number[] = []
  let acc = 0
  let bits = 0
  for (const byte of bytes) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      data.push((acc >>> bits) & 31)
    }
    acc &= (1 << bits) - 1
  }
  if (bits) data.push((acc << (5 - bits)) & 31)
  const step = (check: number, value: number) => {
    const top = check >>> 25
    let next = ((check & 0x1ffffff) << 5) ^ value
    const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) next ^= generators[i]
    return next >>> 0
  }
  let check = 1
  for (const char of hrp) check = step(check, char.charCodeAt(0) >>> 5)
  check = step(check, 0)
  for (const char of hrp) check = step(check, char.charCodeAt(0) & 31)
  for (const value of data) check = step(check, value)
  for (let i = 0; i < 6; i++) check = step(check, 0)
  check ^= 0x2bc830a3
  for (let i = 0; i < 6; i++) data.push((check >>> (5 * (5 - i))) & 31)
  return `${hrp}1${data.map(value => alphabet[value]).join('')}`
}

const orchardItem = Uint8Array.of(3, 43, ...rawOrchard)

test('decodes Orchard bytes from public single and multiple receiver UAs', () => {
  assert.equal(
    Buffer.from(decodeMultisigRecipient(orchardOnly, 'mainnet')).toString('hex'),
    '5178924f7067eac261044ca27ba3cf52f798486973af0795e61587aa1b1ecad333dc520497edc61df88980'
  )
  assert.equal(
    Buffer.from(decodeMultisigRecipient(orchardWithSaplingAndP2pkh, 'mainnet')).toString('hex'),
    'cecbe5e689a453a3fe10ccf7617e6c1fb382819d7fc9200a1f42092ac84a30378f8c1fb90dff71a6d5042d'
  )
})

test('rejects UAs without Orchard and wrong network, checksum or case', () => {
  for (const [address, network] of [
    [saplingOnly, 'mainnet'],
    [orchardOnly, 'testnet'],
    [orchardOnly.slice(0, -1) + 'q', 'mainnet'],
    [orchardOnly.slice(0, 10).toUpperCase() + orchardOnly.slice(10), 'mainnet']
  ] as const) {
    assert.throws(() => decodeMultisigRecipient(address, network))
  }
})

test('accepts testnet and shielded-only revision 2 Orchard UAs', () => {
  for (const [hrp, network] of [
    ['utest', 'testnet'],
    ['zu', 'mainnet'],
    ['zutest', 'testnet']
  ] as const) {
    assert.deepEqual(decodeMultisigRecipient(fixtureAddress(hrp, orchardItem), network), rawOrchard)
  }
  const transparent = Uint8Array.of(0, 20, ...new Uint8Array(20))
  assert.deepEqual(
    decodeMultisigRecipient(
      fixtureAddress('tu', Uint8Array.of(...transparent, ...orchardItem)),
      'mainnet'
    ),
    rawOrchard
  )
  assert.deepEqual(decodeMultisigRecipient(orchardOnly.toUpperCase(), 'mainnet'), rawOrchard)
})

test('rejects noncanonical items and unsupported receiver shapes behind valid checksums', () => {
  const p2pkh = Uint8Array.of(0, 20, ...new Uint8Array(20))
  const malformed = [
    Uint8Array.of(3, 0xfd, 43, 0, ...rawOrchard), // noncanonical CompactSize
    Uint8Array.of(3, 44, ...rawOrchard, 0), // wrong Orchard length
    Uint8Array.of(3, 43, ...rawOrchard, ...orchardItem), // duplicate
    Uint8Array.of(...orchardItem, ...p2pkh), // wrong order
    Uint8Array.of(3, 43, ...rawOrchard, 4, 1, 0), // unknown receiver
    Uint8Array.of(1, 20, ...new Uint8Array(20), ...orchardItem), // P2SH
    Uint8Array.of(...orchardItem, 0xc0, 1, 0) // metadata outside product support
  ]
  for (const raw of malformed)
    assert.throws(() => decodeMultisigRecipient(fixtureAddress('u', raw), 'mainnet'))
  assert.throws(() =>
    decodeMultisigRecipient(
      fixtureAddress('zu', Uint8Array.of(...p2pkh, ...orchardItem)),
      'mainnet'
    )
  )
  assert.throws(() => decodeMultisigRecipient(fixtureAddress('tu', orchardItem), 'mainnet'))
  assert.throws(() => decodeMultisigRecipient(fixtureAddress('u', orchardItem, 'utest'), 'mainnet'))
})
