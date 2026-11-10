import { secp256k1 } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { HDKey } from '@scure/bip32'
import { Buffer } from 'buffer'
import { payments, Psbt, Transaction } from 'bitcoinjs-lib'
import { getDashNetworkConfig } from '@/config/networks'
import { DASH_CHAIN_IDS } from '@/core/chains/registry/chain-ids'

export const LEDGER_DASH_APP_NAME = 'Dash'
const MAX_INDEX = 0x7fffffff
const ACCOUNT_XPUB_VERSION = 0x0488b21e

// The public Dash app listing does not name Stax, Flex, or Nano Gen5. Those
// models stay unsupported until a device confirms the app can be installed.
const LEDGER_DASH_SUPPORTED_MODELS = new Set<string>(['nanoS', 'nanoSP', 'nanoX'])

export function ledgerDashDeviceSupported(deviceModel: string): boolean {
  return LEDGER_DASH_SUPPORTED_MODELS.has(deviceModel)
}

export function assertLedgerDashDeviceSupported(deviceModel: string): void {
  if (!ledgerDashDeviceSupported(deviceModel)) {
    throw new Error('This Ledger model is not supported for the Dash app')
  }
}

export function assertDashHardwareMainnet(chainId: string): void {
  if (chainId !== DASH_CHAIN_IDS.mainnet) {
    throw new Error('Dash hardware wallets support mainnet only')
  }
}

export function rejectDashHardwareMessageSigning(): never {
  throw new Error('Dash hardware message signing is unsupported')
}

// Dash Core hashes this prefix, then the compact message length, then the
// UTF-8 message. The bitcoinjs network field is not the hash prefix.
const DASH_SIGNED_MESSAGE_PREFIX = Buffer.from('\x19DarkCoin Signed Message:\n', 'latin1')

export function dashSignedMessageDigest(message: string): Uint8Array {
  const body = Buffer.from(message, 'utf8')
  const payload = Buffer.concat([DASH_SIGNED_MESSAGE_PREFIX, compactSize(body.length), body])
  return sha256(sha256(payload))
}

export function encodeLedgerDashMessageSignature(v: number, rHex: string, sHex: string): string {
  if (!Number.isInteger(v) || v < 0 || v > 3) {
    throw new Error('Ledger Dash message signature is invalid')
  }
  const header = v + 27 + 4
  return Buffer.concat([Buffer.from([header]), scalar(rHex), scalar(sHex)]).toString('base64')
}

export function assertDashLedgerMessageSignature(
  address: string,
  message: string,
  signature: string
): void {
  const compact = Buffer.from(signature, 'base64')
  const header = compact[0]
  if (
    compact.length !== 65 ||
    compact.toString('base64') !== signature ||
    header === undefined ||
    header < 31 ||
    header > 34
  ) {
    throw new Error('Ledger Dash signature does not match the approved message')
  }
  let publicKey: Uint8Array
  try {
    publicKey = secp256k1.Signature.fromCompact(compact.subarray(1))
      .addRecoveryBit(header - 31)
      .recoverPublicKey(dashSignedMessageDigest(message))
      .toRawBytes(true)
  } catch {
    throw new Error('Ledger Dash signature does not match the approved message')
  }
  const payment = payments.p2pkh({
    pubkey: Buffer.from(publicKey),
    network: dashMainnetPaymentNetwork()
  })
  if (payment.address !== address) {
    throw new Error('Ledger Dash signature does not match the approved message')
  }
}

function scalar(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{2,64}$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error('Ledger Dash message signature is invalid')
  }
  return Buffer.from(hex.padStart(64, '0'), 'hex')
}

function compactSize(length: number): Buffer {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error('Ledger Dash message signature is invalid')
  }
  if (length < 0xfd) return Buffer.from([length])
  if (length <= 0xffff) {
    const out = Buffer.alloc(3)
    out[0] = 0xfd
    out.writeUInt16LE(length, 1)
    return out
  }
  const out = Buffer.alloc(5)
  out[0] = 0xfe
  out.writeUInt32LE(length, 1)
  return out
}

function assertIndex(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_INDEX) {
    throw new Error(`Invalid Ledger Dash ${label}`)
  }
  return value
}

export function ledgerDashAccountPath(accountIndex: number): string {
  return `m/44'/5'/${assertIndex(accountIndex, 'account index')}'`
}

export function validateLedgerDashAccountPath(path: string): string {
  const match = /^m\/44'\/5'\/(0|[1-9][0-9]*)'$/.exec(path)
  if (!match) throw new Error('Unsupported Ledger Dash account path')
  assertIndex(Number(match[1]), 'account index')
  return path
}

export function validateLedgerDashAddressPath(path: string): string {
  const match = /^m\/44'\/5'\/(0|[1-9][0-9]*)'\/([01])\/(0|[1-9][0-9]*)$/.exec(path)
  if (!match) throw new Error('Unsupported Ledger Dash derivation path')
  assertIndex(Number(match[1]), 'account index')
  assertIndex(Number(match[3]), 'address index')
  return path
}

export function ledgerDashDevicePath(path: string): string {
  return path.startsWith('m/') ? path.slice(2) : path
}

export function dashMainnetPaymentNetwork() {
  const config = getDashNetworkConfig('mainnet')
  if (config.chainId !== DASH_CHAIN_IDS.mainnet) {
    throw new Error('Dash hardware wallets support mainnet only')
  }
  return {
    messagePrefix: '\x19Dash Signed Message:\n',
    bech32: 'dash',
    bip32: { public: ACCOUNT_XPUB_VERSION, private: 0x0488ade4 },
    pubKeyHash: config.p2pkhVersion,
    scriptHash: config.p2shVersion,
    wif: config.wifVersion
  }
}

function duffs(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Dash amount is not an integer number of duffs')
  }
  return BigInt(value)
}

export function deriveLedgerDashP2pkh(
  xpub: string,
  change: boolean,
  addressIndex: number
): { readonly address: string; readonly publicKey: string; readonly scriptPubKeyHex: string } {
  assertIndex(addressIndex, 'address index')
  let child: HDKey
  try {
    child = HDKey.fromExtendedKey(xpub, { public: ACCOUNT_XPUB_VERSION, private: 0x0488ade4 })
      .deriveChild(change ? 1 : 0)
      .deriveChild(addressIndex)
  } catch {
    throw new Error('Invalid Ledger Dash xpub')
  }
  if (!child.publicKey || child.publicKey.length !== 33) throw new Error('Invalid Ledger Dash xpub')
  const payment = payments.p2pkh({
    pubkey: Buffer.from(child.publicKey),
    network: dashMainnetPaymentNetwork()
  })
  if (!payment.address || !payment.output) throw new Error('Invalid Ledger Dash address')
  return Object.freeze({
    address: payment.address,
    publicKey: Buffer.from(child.publicKey).toString('hex'),
    scriptPubKeyHex: payment.output.toString('hex')
  })
}

export function normalizeLedgerDashPublicKey(value: string): string {
  const hex = value.trim().toLowerCase().replace(/^0x/, '')
  if (/^(02|03)[0-9a-f]{64}$/.test(hex)) return hex
  if (/^04[0-9a-f]{128}$/.test(hex)) {
    try {
      return secp256k1.ProjectivePoint.fromHex(hex).toHex(true)
    } catch {
      throw new Error('Ledger returned an invalid Dash public key')
    }
  }
  throw new Error('Ledger returned an invalid Dash public key')
}

function reviewInputAmount(psbt: Psbt, index: number): bigint {
  const input = psbt.data.inputs[index]
  const spent = psbt.txInputs[index]
  if (!input || !spent) throw new Error('Dash review PSBT is invalid')
  if (input.witnessUtxo) return duffs(input.witnessUtxo.value)
  if (input.nonWitnessUtxo) {
    const previous = Transaction.fromBuffer(input.nonWitnessUtxo)
    const output = previous.outs[spent.index]
    if (!output) throw new Error('Dash review PSBT input amount is missing')
    return duffs(output.value)
  }
  throw new Error('Dash review PSBT input amount is missing')
}

export function assertDashHardwareSignedTransactionMatchesReview(
  reviewPsbtBase64: string,
  signedTransactionHex: string,
  chainId: string
): void {
  assertDashHardwareMainnet(chainId)
  let review: Psbt
  let signed: Transaction
  try {
    review = Psbt.fromBase64(reviewPsbtBase64)
    signed = Transaction.fromHex(signedTransactionHex)
  } catch {
    throw new Error('Dash hardware signature does not match the review')
  }
  const unsigned = Transaction.fromBuffer(review.data.globalMap.unsignedTx.toBuffer())
  if (
    signed.ins.length !== unsigned.ins.length ||
    signed.ins.some(
      (input, index) =>
        !input.hash.equals(unsigned.ins[index].hash) ||
        input.index !== unsigned.ins[index].index ||
        input.sequence !== unsigned.ins[index].sequence
    )
  ) {
    throw new Error('Dash hardware signature inputs do not match the review')
  }
  if (
    signed.outs.length !== unsigned.outs.length ||
    signed.outs.some((output, index) => !output.script.equals(unsigned.outs[index].script))
  ) {
    throw new Error('Dash hardware signature outputs do not match the review')
  }
  const inputAmount = unsigned.ins.reduce(
    (sum, _input, index) => sum + reviewInputAmount(review, index),
    0n
  )
  const reviewedOutputAmount = unsigned.outs.reduce((sum, output) => sum + duffs(output.value), 0n)
  const signedOutputAmount = signed.outs.reduce((sum, output) => sum + duffs(output.value), 0n)
  const reviewedFee = inputAmount - reviewedOutputAmount
  const signedFee = inputAmount - signedOutputAmount
  if (reviewedFee < 0n || signedFee !== reviewedFee) {
    throw new Error('Dash hardware signature fee does not match the review')
  }
}
