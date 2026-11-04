import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  entropyToMnemonic,
  mnemonicToEntropy,
  mnemonicToSeedSync,
  validateMnemonic
} from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'

function isAccepted(wasm, phrase) {
  try {
    wasm.validate_mnemonic(phrase)
    return true
  } catch {
    return false
  }
}

test('vendored WASM mnemonic contracts', async t => {
  const originalSelf = Object.getOwnPropertyDescriptor(globalThis, 'self')
  const originalAdd = Object.getOwnPropertyDescriptor(globalThis, 'addEventListener')
  const originalRemove = Object.getOwnPropertyDescriptor(globalThis, 'removeEventListener')
  t.after(() => {
    for (const [name, descriptor] of [
      ['self', originalSelf],
      ['addEventListener', originalAdd],
      ['removeEventListener', originalRemove]
    ]) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  })
  globalThis.self = globalThis
  globalThis.addEventListener = () => {}
  globalThis.removeEventListener = () => {}

  const wasm = await import('../src/lib/wasm-pkg/zcash_wallet_wasm.js')
  wasm.initSync({
    module: readFileSync(new URL('../src/lib/wasm-pkg/zcash_wallet_wasm_bg.wasm', import.meta.url))
  })

  const phrase12 = entropyToMnemonic(new Uint8Array(16), wordlist)
  const phrase24 = entropyToMnemonic(new Uint8Array(32), wordlist)
  const otherPhrase24 = entropyToMnemonic(new Uint8Array(32).fill(1), wordlist)

  await t.test('accepts valid 12/24-word phrases and rejects checksum or word errors', () => {
    for (const phrase of [phrase12, phrase24]) {
      assert.equal(validateMnemonic(phrase, wordlist), true)
      assert.equal(isAccepted(wasm, phrase), true)
    }

    const words = phrase24.split(' ')
    const checksumWord = wordlist.find(word => {
      const changed = [...words.slice(0, -1), word].join(' ')
      return word !== words.at(-1) && !validateMnemonic(changed, wordlist)
    })
    assert.equal(typeof checksumWord === 'string', true)
    const badChecksum = [...words.slice(0, -1), checksumWord].join(' ')
    const unknownWord = [...words.slice(0, -1), 'notaword'].join(' ')
    for (const phrase of [badChecksum, unknownWord]) {
      assert.equal(validateMnemonic(phrase, wordlist), false)
      assert.equal(isAccepted(wasm, phrase), false)
    }
  })

  await t.test('derives the BIP39 seed matched by an independent implementation', () => {
    for (const phrase of [phrase12, phrase24]) {
      for (const passphrase of ['', 'TREZOR']) {
        const actual = wasm.mnemonic_to_seed(phrase, passphrase)
        const expected = mnemonicToSeedSync(phrase, passphrase)
        assert.equal(actual instanceof Uint8Array, true)
        assert.equal(actual.length, 64)
        assert.equal(Buffer.compare(Buffer.from(actual), Buffer.from(expected)) === 0, true)
      }
    }
  })

  await t.test('derives stable addresses bound to seed, network, and account index', () => {
    const base = wasm.mnemonic_to_addresses('main', phrase24, '', 0)
    const repeat = wasm.mnemonic_to_addresses('main', phrase24, '', 0)
    const differentSeed = wasm.mnemonic_to_addresses('main', otherPhrase24, '', 0)
    const differentNetwork = wasm.mnemonic_to_addresses('test', phrase24, '', 0)
    const differentIndex = wasm.mnemonic_to_addresses('main', phrase24, '', 1)

    for (const addresses of [base, repeat, differentSeed, differentNetwork, differentIndex]) {
      assert.equal(
        typeof addresses.transparent === 'string' && addresses.transparent.length > 0,
        true
      )
      assert.equal(typeof addresses.unified === 'string' && addresses.unified.length > 0, true)
    }
    for (const field of ['transparent', 'unified']) {
      assert.equal(base[field] === repeat[field], true)
      assert.equal(base[field] !== differentSeed[field], true)
      assert.equal(base[field] !== differentNetwork[field], true)
      assert.equal(base[field] !== differentIndex[field], true)
    }
  })

  await t.test('generates valid 24-word phrases and rejects 12-word generation', () => {
    assert.throws(() => wasm.generate_mnemonic(12))
    const phrase = wasm.generate_mnemonic(24)
    assert.equal(phrase.split(' ').length, 24)
    assert.equal(validateMnemonic(phrase, wordlist), true)
    assert.equal(isAccepted(wasm, phrase), true)
  })
})

test('vendored WASM mnemonic generation uses Web Crypto and fails closed', async t => {
  const originalSelf = Object.getOwnPropertyDescriptor(globalThis, 'self')
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  const originalRandom = Math.random
  const bytes = readFileSync(
    new URL('../src/lib/wasm-pkg/zcash_wallet_wasm_bg.wasm', import.meta.url)
  )
  let instance = 0

  t.after(() => {
    for (const [name, descriptor] of [
      ['self', originalSelf],
      ['crypto', originalCrypto]
    ]) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
    Math.random = originalRandom
  })

  globalThis.self = globalThis
  const loadFreshWasm = async () => {
    const wasm = await import(`../src/lib/wasm-pkg/zcash_wallet_wasm.js?mnemonic-rng=${instance++}`)
    wasm.initSync({ module: bytes })
    return wasm
  }
  let seed = Uint8Array.from({ length: 32 }, (_, index) => index)
  const cryptoCalls = []
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      getRandomValues(array) {
        cryptoCalls.push(array.byteLength)
        assert.equal(array.byteLength, seed.length)
        array.set(seed)
        return array
      }
    }
  })
  Math.random = () => {
    throw new Error('Math.random must not generate mnemonic entropy')
  }

  const first = (await loadFreshWasm()).generate_mnemonic(24)
  const second = (await loadFreshWasm()).generate_mnemonic(24)
  seed = Uint8Array.from({ length: 32 }, (_, index) => 255 - index)
  const third = (await loadFreshWasm()).generate_mnemonic(24)
  assert.deepEqual(cryptoCalls, [32, 32, 32])
  assert.equal(first === second, true)
  assert.equal(first !== third, true)
  assert.equal(mnemonicToEntropy(first, wordlist).length, 32)
  assert.equal(entropyToMnemonic(mnemonicToEntropy(first, wordlist), wordlist) === first, true)

  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      getRandomValues() {
        throw new Error('Web Crypto unavailable')
      }
    }
  })
  Math.random = () => 0.5
  const withoutCrypto = await loadFreshWasm()
  const originalError = console.error
  try {
    console.error = () => {}
    assert.throws(() => withoutCrypto.generate_mnemonic(24))
  } finally {
    console.error = originalError
  }
})
