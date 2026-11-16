import '../buffer-polyfill'
import { HDKey } from '@scure/bip32'
import { Buffer } from 'buffer'
import { initEccLib, networks, payments, Psbt, script, Transaction } from 'bitcoinjs-lib'
import { sha256 } from '@noble/hashes/sha256'
import * as secp256k1 from '@bitcoinerlab/secp256k1'

export function networkConfig(network: 'mainnet' | 'testnet') {
  return network === 'mainnet' ? networks.bitcoin : networks.testnet
}

export function ledgerBitcoinAppName(network: 'mainnet' | 'testnet'): 'Bitcoin' | 'Bitcoin Test' {
  return network === 'mainnet' ? 'Bitcoin' : 'Bitcoin Test'
}

export function assertLedgerBitcoinApp(network: 'mainnet' | 'testnet', currentApp: string): void {
  const expected = ledgerBitcoinAppName(network)
  if (currentApp !== expected) throw new Error(`Open the ${expected} App on your Ledger`)
}

export function supportsLedgerBitcoinBip322(appVersion: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(appVersion)
  if (!match) return false
  const [major, minor, patch] = match.slice(1).map(Number)
  if (![major, minor, patch].every(Number.isSafeInteger)) return false
  return major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 3)))
}

function parseXpub(xpub: string): HDKey {
  try {
    return HDKey.fromExtendedKey(xpub)
  } catch {
    return HDKey.fromExtendedKey(xpub, { public: 0x043587cf, private: 0x04358394 })
  }
}

export function deriveLedgerBitcoinAddress(
  xpub: string,
  network: 'mainnet' | 'testnet',
  change: boolean,
  addressIndex: number
): { readonly address: string; readonly publicKey: string; readonly scriptPubKey: string } {
  if (!Number.isSafeInteger(addressIndex) || addressIndex < 0 || addressIndex > 0x7fffffff) {
    throw new Error('Invalid Ledger Bitcoin address index')
  }
  const publicKey = parseXpub(xpub)
    .deriveChild(change ? 1 : 0)
    .deriveChild(addressIndex).publicKey
  if (!publicKey || publicKey.length !== 33) throw new Error('Invalid Ledger Bitcoin public key')
  const payment = payments.p2wpkh({
    pubkey: Buffer.from(publicKey),
    network: networkConfig(network)
  })
  if (!payment.address || !payment.output) throw new Error('Invalid Ledger Bitcoin address')
  return Object.freeze({
    address: payment.address,
    publicKey: `0x${Buffer.from(publicKey).toString('hex')}`,
    scriptPubKey: `0x${payment.output.toString('hex')}`
  })
}

function validOwnedSignature(psbt: Psbt, index: number, pubkey: Buffer): boolean {
  initEccLib(secp256k1)
  return psbt.validateSignaturesOfInput(
    index,
    (key, hash, compact) => secp256k1.verify(hash, key, compact),
    pubkey
  )
}

export function mergeLedgerBitcoinPartialSignature(
  psbt: Psbt,
  index: number,
  pubkey: Buffer,
  signature: Buffer
): void {
  const existing = psbt.data.inputs[index]?.partialSig?.find(item => item.pubkey.equals(pubkey))
  if (existing) {
    try {
      if (existing.signature.at(-1) === 1 && validOwnedSignature(psbt, index, pubkey)) return
    } catch {
      // A malformed pre-existing signature must not be silently replaced.
    }
    throw new Error('Existing Ledger Bitcoin signature is invalid')
  }
  psbt.updateInput(index, { partialSig: [{ pubkey, signature }] })
  if (!validOwnedSignature(psbt, index, pubkey)) {
    throw new Error('Ledger Bitcoin signature is invalid')
  }
}

export function verifyLedgerBitcoinPsbtResponse(input: {
  readonly original: Psbt
  readonly signed: Psbt
  readonly ownedIndexes: readonly number[]
  readonly masterFingerprintHex: string
  readonly accountPath: string
}): Psbt {
  const { original, signed, ownedIndexes } = input
  if (signed.inputCount !== original.inputCount || ownedIndexes.length === 0) {
    throw new Error('Ledger PSBT owned input count changed')
  }
  const withoutNewSignatures = Psbt.fromBase64(signed.toBase64())
  for (const index of ownedIndexes) {
    const derivations =
      original.data.inputs[index]?.bip32Derivation?.filter(
        item =>
          Buffer.from(item.masterFingerprint).toString('hex') === input.masterFingerprintHex &&
          item.path.startsWith(`${input.accountPath}/`)
      ) ?? []
    if (derivations.length !== 1) throw new Error('Ledger PSBT input derivation is ambiguous')
    const pubkey = Buffer.from(derivations[0].pubkey)
    const previous = original.data.inputs[index].partialSig?.find(item =>
      item.pubkey.equals(pubkey)
    )
    const received = signed.data.inputs[index].partialSig?.find(item => item.pubkey.equals(pubkey))
    if (!received || received.signature.at(-1) !== 1) {
      throw new Error('Ledger PSBT owned input signature is missing or invalid')
    }
    if (previous && !received.signature.equals(previous.signature)) {
      throw new Error('Ledger PSBT changed an existing owned signature')
    }
    if (!previous) {
      const remaining =
        withoutNewSignatures.data.inputs[index].partialSig?.filter(
          item => !item.pubkey.equals(pubkey)
        ) ?? []
      if (remaining.length === 0) delete withoutNewSignatures.data.inputs[index].partialSig
      else withoutNewSignatures.data.inputs[index].partialSig = remaining
    }
    if (!validOwnedSignature(signed, index, pubkey)) {
      throw new Error('Ledger Bitcoin signature is invalid')
    }
  }
  if (withoutNewSignatures.toBase64() !== original.toBase64()) {
    throw new Error('Ledger PSBT changed unapproved fields')
  }
  return signed
}

export function ledgerBip322MessagePsbt(
  message: string,
  address: string,
  publicKey: string,
  fingerprintHex: string,
  path: string,
  network: 'mainnet' | 'testnet'
): Psbt {
  const tagHash = sha256(Buffer.from('BIP0322-signed-message', 'utf8'))
  const messageHash = Buffer.from(
    sha256(Buffer.concat([tagHash, tagHash, Buffer.from(message, 'utf8')]))
  )
  const toSpend = new Transaction()
  toSpend.version = 0
  toSpend.addInput(
    Buffer.alloc(32),
    0xffffffff,
    0,
    Buffer.concat([Buffer.from([0, 32]), messageHash])
  )
  const output = payments.p2wpkh({
    pubkey: Buffer.from(publicKey.slice(2), 'hex'),
    network: networkConfig(network)
  }).output
  if (!output) throw new Error('Invalid BIP322 Bitcoin address')
  toSpend.addOutput(output, 0)
  const psbt = new Psbt({ network: networkConfig(network) })
  psbt.setVersion(0)
  psbt.addInput({
    hash: toSpend.getId(),
    index: 0,
    sequence: 0,
    witnessUtxo: { script: output, value: 0 },
    bip32Derivation: [
      {
        masterFingerprint: Buffer.from(fingerprintHex, 'hex'),
        path: `${path}/0/0`,
        pubkey: Buffer.from(publicKey.slice(2), 'hex')
      }
    ]
  })
  psbt.addOutput({ script: script.compile([script.OPS.OP_RETURN]), value: 0 })
  if (payments.p2wpkh({ output, network: networkConfig(network) }).address !== address) {
    throw new Error('BIP322 address does not match Ledger account')
  }
  return psbt
}

export function verifyLedgerBitcoinBip322Signature(input: {
  readonly message: string
  readonly signature: string
  readonly address: string
  readonly publicKey: string
  readonly masterFingerprintHex: string
  readonly accountPath: string
  readonly network: 'mainnet' | 'testnet'
}): boolean {
  if (!/^smp(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.signature))
    return false
  const witness = Buffer.from(input.signature.slice(3), 'base64')
  if (witness.length < 4 || witness[0] !== 2) return false
  const signatureLength = witness[1]
  const pubkeyOffset = 2 + signatureLength
  if (
    pubkeyOffset >= witness.length ||
    witness[pubkeyOffset] !== 33 ||
    pubkeyOffset + 34 !== witness.length
  )
    return false
  const signature = witness.subarray(2, pubkeyOffset)
  const pubkey = witness.subarray(pubkeyOffset + 1)
  if (!pubkey.equals(Buffer.from(input.publicKey.slice(2), 'hex'))) return false
  try {
    initEccLib(secp256k1)
    const psbt = ledgerBip322MessagePsbt(
      input.message,
      input.address,
      input.publicKey,
      input.masterFingerprintHex,
      input.accountPath,
      input.network
    )
    psbt.updateInput(0, { partialSig: [{ pubkey, signature }] })
    return psbt.validateSignaturesOfInput(0, (key, hash, compact) =>
      secp256k1.verify(hash, key, compact)
    )
  } catch {
    return false
  }
}
