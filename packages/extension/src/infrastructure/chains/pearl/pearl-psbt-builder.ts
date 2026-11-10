import * as secp256k1 from '@bitcoinerlab/secp256k1'
import { address, initEccLib, payments, Psbt, Transaction } from 'bitcoinjs-lib'
import { Buffer } from 'buffer'
import type { DerivedPearlAddress } from '@/core/chains/pearl'
import {
  PEARL_MAXIMUM_SELECTION_UTXOS,
  estimatePearlVbytes,
  failInvalidPearlTransaction,
  parsePearlAddress,
  parsePearlAmount,
  parsePearlChain,
  parsePearlFeeRate,
  parsePearlIndex,
  parsePearlMasterFingerprint,
  parsePearlPublicKey,
  pearlAccountRootFromPath,
  pearlDustSats,
  type BuildPearlPsbtInput,
  type PearlChangeOutputPosition,
  type PearlCoinSelection,
  type PearlSpendableUtxo,
  type PreparedPearlPsbt
} from './pearl-transaction-model'
import { parsePearlSpendableUtxo, sumPearlUtxos } from './pearl-spendable-utxos'
import { pearlBitcoinJsNetwork } from './pearl-network'

const PEARL_RBF_SEQUENCE = 0xfffffffd
const MAXIMUM_LOCK_TIME = 0x7fffffff

let eccInitialized = false

function ensurePearlEcc(): void {
  if (eccInitialized) return
  initEccLib(secp256k1)
  eccInitialized = true
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = []
): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false
  const keys = Object.keys(value)
  const allowed = new Set([...requiredKeys, ...optionalKeys])
  return requiredKeys.every(key => keys.includes(key)) && keys.every(key => allowed.has(key))
}

function parseNonNegativePearlAmount(value: unknown, label: string): bigint {
  if (value === '0') return 0n
  return parsePearlAmount(value, label)
}

function publicKeyBuffer(publicKey: string): Buffer {
  return Buffer.from(publicKey.slice(2), 'hex')
}

function xOnlyPublicKey(publicKey: string): Buffer {
  return publicKeyBuffer(publicKey).subarray(1, 33)
}

function p2trPayment(publicKey: string, chainId: PearlCoinSelection['chainId']) {
  return payments.p2tr({
    internalPubkey: xOnlyPublicKey(publicKey),
    network: pearlBitcoinJsNetwork(chainId)
  })
}

function assertPublicKeyMatchesAddress(
  publicKey: string,
  expectedAddress: string,
  chainId: PearlCoinSelection['chainId']
): void {
  if (p2trPayment(publicKey, chainId).address !== expectedAddress) {
    failInvalidPearlTransaction('Pearl public key does not match its address')
  }
}

function parseCoinSelection(value: PearlCoinSelection): PearlCoinSelection {
  if (
    !hasExactKeys(value, [
      'chainId',
      'accountIndex',
      'recipient',
      'selectedUtxos',
      'selectedTotalSats',
      'amountSats',
      'feeSats',
      'changeSats',
      'estimatedVbytes',
      'feeRateSatsPerVbyte'
    ])
  ) {
    failInvalidPearlTransaction('Invalid Pearl coin selection')
  }
  const chainId = parsePearlChain(value.chainId)
  const accountIndex = parsePearlIndex(value.accountIndex, 'Pearl account index')
  const recipient = parsePearlAddress(value.recipient, chainId)
  const feeRateSatsPerVbyte = parsePearlFeeRate(value.feeRateSatsPerVbyte)
  if (
    !Array.isArray(value.selectedUtxos) ||
    value.selectedUtxos.length === 0 ||
    value.selectedUtxos.length > PEARL_MAXIMUM_SELECTION_UTXOS
  ) {
    failInvalidPearlTransaction('Invalid Pearl selected UTXOs')
  }
  const seen = new Set<string>()
  let accountRoot: string | undefined
  const selectedUtxos = value.selectedUtxos.map(candidate => {
    const utxo = parsePearlSpendableUtxo(candidate)
    if (utxo.chainId !== chainId || utxo.accountIndex !== accountIndex) {
      failInvalidPearlTransaction('Pearl UTXO does not match the selected account')
    }
    const root = pearlAccountRootFromPath(
      utxo.derivationPath,
      chainId,
      utxo.change,
      utxo.addressIndex
    )
    if (accountRoot !== undefined && accountRoot !== root) {
      failInvalidPearlTransaction('Pearl UTXOs belong to different accounts')
    }
    accountRoot = root
    const outpoint = `${utxo.transactionId}:${utxo.outputIndex}`
    if (seen.has(outpoint)) failInvalidPearlTransaction('Duplicate Pearl UTXO')
    seen.add(outpoint)
    assertPublicKeyMatchesAddress(utxo.publicKey, utxo.address, chainId)
    return utxo
  })
  const selectedTotalSats = parsePearlAmount(value.selectedTotalSats, 'Pearl selected total')
  const amountSats = parsePearlAmount(value.amountSats, 'Pearl transfer amount')
  const feeSats = parsePearlAmount(value.feeSats, 'Pearl transaction fee')
  const changeSats = parseNonNegativePearlAmount(value.changeSats, 'Pearl change amount')
  const expectedVbytes = estimatePearlVbytes(selectedUtxos.length, changeSats > 0n)
  if (
    !Number.isSafeInteger(value.estimatedVbytes) ||
    value.estimatedVbytes !== Number(expectedVbytes) ||
    sumPearlUtxos(selectedUtxos) !== selectedTotalSats ||
    amountSats + feeSats + changeSats !== selectedTotalSats ||
    amountSats < pearlDustSats() ||
    (changeSats > 0n && changeSats < pearlDustSats()) ||
    feeSats < expectedVbytes * BigInt(feeRateSatsPerVbyte) ||
    (changeSats > 0n && feeSats !== expectedVbytes * BigInt(feeRateSatsPerVbyte))
  ) {
    failInvalidPearlTransaction('Invalid Pearl coin selection')
  }
  return Object.freeze({
    chainId,
    accountIndex,
    recipient,
    selectedUtxos: Object.freeze(selectedUtxos),
    selectedTotalSats: selectedTotalSats.toString(),
    amountSats: amountSats.toString(),
    feeSats: feeSats.toString(),
    changeSats: changeSats.toString(),
    estimatedVbytes: Number(expectedVbytes),
    feeRateSatsPerVbyte
  })
}

function parseChangeAddress(
  value: unknown,
  selection: PearlCoinSelection,
  masterFingerprint: string
): DerivedPearlAddress {
  if (
    !hasExactKeys(value, [
      'chainId',
      'accountIndex',
      'change',
      'addressIndex',
      'address',
      'addressScheme',
      'derivationScheme',
      'derivationPath',
      'publicKey',
      'masterFingerprint',
      'scriptPubKey'
    ])
  ) {
    failInvalidPearlTransaction('Invalid Pearl change address')
  }
  if (typeof value.change !== 'boolean') {
    failInvalidPearlTransaction('Invalid Pearl change address branch')
  }
  const change = value.change
  const addressIndex = parsePearlIndex(value.addressIndex, 'Pearl change address index')
  if (!change && addressIndex !== 0) {
    failInvalidPearlTransaction('Pearl change address must be the active receive address')
  }
  const selectedRoot = pearlAccountRootFromPath(
    selection.selectedUtxos[0].derivationPath,
    selection.chainId,
    selection.selectedUtxos[0].change,
    selection.selectedUtxos[0].addressIndex
  )
  const expectedPath = `${selectedRoot}/${change ? 1 : 0}/${addressIndex}`
  if (
    value.chainId !== selection.chainId ||
    value.accountIndex !== selection.accountIndex ||
    value.addressScheme !== 'pearl_p2tr' ||
    value.derivationScheme !== 'bip86' ||
    value.derivationPath !== expectedPath ||
    parsePearlMasterFingerprint(value.masterFingerprint) !== masterFingerprint
  ) {
    failInvalidPearlTransaction('Pearl change address does not match the selected account')
  }
  const publicKey = parsePearlPublicKey(value.publicKey)
  const payment = p2trPayment(publicKey, selection.chainId)
  const expectedScriptPubKey = payment.output ? `0x${payment.output.toString('hex')}` : null
  if (expectedScriptPubKey === null || value.scriptPubKey !== expectedScriptPubKey) {
    failInvalidPearlTransaction('Pearl change address scripts do not match its public key')
  }
  const parsed = Object.freeze({
    chainId: selection.chainId,
    accountIndex: selection.accountIndex,
    change,
    addressIndex,
    address: parsePearlAddress(value.address, selection.chainId),
    addressScheme: 'pearl_p2tr' as const,
    derivationScheme: 'bip86' as const,
    derivationPath: expectedPath,
    publicKey,
    masterFingerprint,
    scriptPubKey: expectedScriptPubKey
  })
  assertPublicKeyMatchesAddress(parsed.publicKey, parsed.address, selection.chainId)
  return parsed
}

function tapKeyOrigin(publicKey: string, derivationPath: string, masterFingerprint: Buffer) {
  const internalPublicKey = xOnlyPublicKey(publicKey)
  return {
    tapInternalKey: internalPublicKey,
    tapBip32Derivation: [
      {
        masterFingerprint,
        pubkey: internalPublicKey,
        path: derivationPath,
        leafHashes: [] as Buffer[]
      }
    ]
  }
}

function addInput(
  psbt: Psbt,
  selection: PearlCoinSelection,
  utxo: PearlSpendableUtxo,
  masterFingerprint: Buffer
): void {
  const network = pearlBitcoinJsNetwork(selection.chainId)
  const script = address.toOutputScript(utxo.address, network)
  psbt.addInput({
    hash: utxo.transactionId,
    index: utxo.outputIndex,
    sequence: PEARL_RBF_SEQUENCE,
    witnessUtxo: {
      script,
      value: Number(BigInt(utxo.valueSats))
    },
    ...tapKeyOrigin(utxo.publicKey, utxo.derivationPath, masterFingerprint)
  })
}

export function buildPearlPsbt(input: BuildPearlPsbtInput): PreparedPearlPsbt {
  ensurePearlEcc()
  const hasChange = hasExactKeys(input, ['selection', 'masterFingerprint', 'lockTime', 'change'])
  if (!hasChange && !hasExactKeys(input, ['selection', 'masterFingerprint', 'lockTime'])) {
    failInvalidPearlTransaction('Invalid Pearl PSBT build input')
  }
  const selection = parseCoinSelection(input.selection)
  const masterFingerprintValue = parsePearlMasterFingerprint(input.masterFingerprint)
  const masterFingerprint = Buffer.from(masterFingerprintValue.slice(2), 'hex')
  const lockTime = parsePearlIndex(input.lockTime, 'Pearl lock time', MAXIMUM_LOCK_TIME)
  const changeSats = BigInt(selection.changeSats)
  if (changeSats > 0n !== hasChange) {
    failInvalidPearlTransaction('Pearl change output does not match the coin selection')
  }

  let changeAddress: DerivedPearlAddress | null = null
  let changeOutputPosition: PearlChangeOutputPosition | null = null
  if (hasChange) {
    const changeInput =
      'change' in input ? input.change : failInvalidPearlTransaction('Invalid Pearl change output')
    if (!hasExactKeys(changeInput, ['address', 'outputPosition'])) {
      failInvalidPearlTransaction('Invalid Pearl change output')
    }
    if (changeInput.outputPosition !== 'first' && changeInput.outputPosition !== 'last') {
      failInvalidPearlTransaction('Invalid Pearl change output position')
    }
    changeAddress = parseChangeAddress(changeInput.address, selection, masterFingerprintValue)
    changeOutputPosition = changeInput.outputPosition
  }

  const network = pearlBitcoinJsNetwork(selection.chainId)
  const psbt = new Psbt({ network })
  psbt.setVersion(2).setLocktime(lockTime)
  for (const utxo of selection.selectedUtxos) {
    addInput(psbt, selection, utxo, masterFingerprint)
  }

  const recipientOutput = Object.freeze({
    address: selection.recipient,
    value: Number(BigInt(selection.amountSats))
  })
  const changeOutput =
    changeAddress === null
      ? null
      : Object.freeze({
          address: changeAddress.address,
          value: Number(changeSats),
          ...tapKeyOrigin(changeAddress.publicKey, changeAddress.derivationPath, masterFingerprint)
        })
  if (changeOutputPosition === 'first' && changeOutput) psbt.addOutput(changeOutput)
  psbt.addOutput(recipientOutput)
  if (changeOutputPosition === 'last' && changeOutput) psbt.addOutput(changeOutput)

  const unsignedTransaction = Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer())
  const recipientOutputIndex = changeOutputPosition === 'first' ? 1 : 0
  const changeOutputIndex =
    changeOutputPosition === null ? null : changeOutputPosition === 'first' ? 0 : 1
  return Object.freeze({
    schemaVersion: 1,
    chainId: selection.chainId,
    accountIndex: selection.accountIndex,
    addressScheme: 'pearl_p2tr',
    psbtBase64: psbt.toBase64(),
    unsignedTransactionId: unsignedTransaction.getId(),
    transactionVersion: 2 as const,
    lockTime,
    rbf: true as const,
    inputCount: selection.selectedUtxos.length,
    outputCount: changeOutput === null ? 1 : 2,
    recipient: selection.recipient,
    recipientOutputIndex,
    changeAddress: changeAddress?.address ?? null,
    changeOutputIndex,
    selectedTotalSats: selection.selectedTotalSats,
    amountSats: selection.amountSats,
    feeSats: selection.feeSats,
    changeSats: selection.changeSats,
    estimatedVbytes: selection.estimatedVbytes,
    feeRateSatsPerVbyte: selection.feeRateSatsPerVbyte
  })
}
