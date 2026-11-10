import { address, Psbt, Transaction } from 'bitcoinjs-lib'
import { Buffer } from 'buffer'
import {
  PEARL_MAXIMUM_SELECTION_UTXOS,
  estimatePearlVbytes,
  failInvalidSignedPearlTransaction,
  parsePearlAddress,
  parsePearlAmount,
  parsePearlChain,
  parsePearlFeeRate,
  parsePearlIndex,
  pearlDustSats,
  type PreparedPearlPsbt
} from './pearl-transaction-model'
import { pearlBitcoinJsNetwork } from './pearl-network'

const PEARL_RBF_SEQUENCE = 0xfffffffd
const MAXIMUM_LOCK_TIME = 0x7fffffff
const MAXIMUM_PSBT_BASE64_LENGTH = 2_000_000

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false
  const actualKeys = Object.keys(value)
  return actualKeys.length === keys.length && keys.every(key => actualKeys.includes(key))
}

function failSigned(): never {
  return failInvalidSignedPearlTransaction('Invalid signed Pearl transaction')
}

function parseNonNegativeAmount(value: unknown, label: string): bigint {
  if (value === '0') return 0n
  return parsePearlAmount(value, label)
}

export function parsePearlPsbt(value: unknown, chainId: PreparedPearlPsbt['chainId']): Psbt {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAXIMUM_PSBT_BASE64_LENGTH ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    return failSigned()
  }
  try {
    return Psbt.fromBase64(value, { network: pearlBitcoinJsNetwork(chainId) })
  } catch {
    return failSigned()
  }
}

export function parsePreparedPearlPsbt(value: PreparedPearlPsbt): {
  readonly prepared: PreparedPearlPsbt
  readonly psbt: Psbt
} {
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'chainId',
      'accountIndex',
      'addressScheme',
      'psbtBase64',
      'unsignedTransactionId',
      'transactionVersion',
      'lockTime',
      'rbf',
      'inputCount',
      'outputCount',
      'recipient',
      'recipientOutputIndex',
      'changeAddress',
      'changeOutputIndex',
      'selectedTotalSats',
      'amountSats',
      'feeSats',
      'changeSats',
      'estimatedVbytes',
      'feeRateSatsPerVbyte'
    ]) ||
    value.schemaVersion !== 1 ||
    value.transactionVersion !== 2 ||
    value.rbf !== true ||
    value.addressScheme !== 'pearl_p2tr' ||
    typeof value.unsignedTransactionId !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.unsignedTransactionId)
  ) {
    return failSigned()
  }
  const chainId = parsePearlChain(value.chainId)
  const accountIndex = parsePearlIndex(value.accountIndex, 'Pearl account index')
  const lockTime = parsePearlIndex(value.lockTime, 'Pearl lock time', MAXIMUM_LOCK_TIME)
  const inputCount = parsePearlIndex(
    value.inputCount,
    'Pearl input count',
    PEARL_MAXIMUM_SELECTION_UTXOS
  )
  const outputCount = parsePearlIndex(value.outputCount, 'Pearl output count', 2)
  if (inputCount === 0 || (outputCount !== 1 && outputCount !== 2)) return failSigned()
  const recipient = parsePearlAddress(value.recipient, chainId)
  const recipientOutputIndex = parsePearlIndex(value.recipientOutputIndex, 'Pearl recipient output')
  const changeSats = parseNonNegativeAmount(value.changeSats, 'Pearl change amount')
  const amountSats = parsePearlAmount(value.amountSats, 'Pearl amount')
  const feeSats = parsePearlAmount(value.feeSats, 'Pearl fee')
  const selectedTotalSats = parsePearlAmount(value.selectedTotalSats, 'Pearl selected total')
  const feeRateSatsPerVbyte = parsePearlFeeRate(value.feeRateSatsPerVbyte)
  const estimatedVbytes = parsePearlIndex(value.estimatedVbytes, 'Pearl estimated vbytes')
  if (
    amountSats + feeSats + changeSats !== selectedTotalSats ||
    amountSats < pearlDustSats() ||
    (changeSats > 0n && changeSats < pearlDustSats()) ||
    estimatedVbytes !== Number(estimatePearlVbytes(inputCount, changeSats > 0n))
  ) {
    return failSigned()
  }
  if (changeSats === 0n) {
    if (value.changeAddress !== null || value.changeOutputIndex !== null || outputCount !== 1) {
      return failSigned()
    }
  } else if (
    typeof value.changeAddress !== 'string' ||
    value.changeOutputIndex === null ||
    outputCount !== 2
  ) {
    return failSigned()
  } else {
    parsePearlAddress(value.changeAddress, chainId)
  }

  const psbt = parsePearlPsbt(value.psbtBase64, chainId)
  const network = pearlBitcoinJsNetwork(chainId)
  if (
    psbt.txInputs.length !== inputCount ||
    psbt.txOutputs.length !== outputCount ||
    psbt.locktime !== lockTime ||
    !psbt.txInputs.every(input => input.sequence === PEARL_RBF_SEQUENCE)
  ) {
    return failSigned()
  }
  const recipientScript = address.toOutputScript(recipient, network)
  const recipientOutput = psbt.txOutputs[recipientOutputIndex]
  if (
    !recipientOutput ||
    recipientOutput.value !== Number(amountSats) ||
    !Buffer.from(recipientOutput.script).equals(recipientScript)
  ) {
    return failSigned()
  }
  if (changeSats > 0n && value.changeOutputIndex !== null && value.changeAddress !== null) {
    const changeScript = address.toOutputScript(value.changeAddress, network)
    const changeOutput = psbt.txOutputs[value.changeOutputIndex]
    if (
      !changeOutput ||
      changeOutput.value !== Number(changeSats) ||
      !Buffer.from(changeOutput.script).equals(changeScript)
    ) {
      return failSigned()
    }
  }
  for (const input of psbt.data.inputs) {
    if (
      input.tapInternalKey === undefined ||
      input.witnessUtxo === undefined ||
      input.tapBip32Derivation?.length !== 1
    ) {
      return failSigned()
    }
  }
  const unsignedTransaction = Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer())
  if (unsignedTransaction.getId() !== value.unsignedTransactionId) return failSigned()

  return Object.freeze({
    prepared: Object.freeze({
      schemaVersion: 1 as const,
      chainId,
      accountIndex,
      addressScheme: 'pearl_p2tr' as const,
      psbtBase64: value.psbtBase64,
      unsignedTransactionId: value.unsignedTransactionId,
      transactionVersion: 2 as const,
      lockTime,
      rbf: true as const,
      inputCount,
      outputCount,
      recipient,
      recipientOutputIndex,
      changeAddress: value.changeAddress,
      changeOutputIndex: value.changeOutputIndex,
      selectedTotalSats: selectedTotalSats.toString(),
      amountSats: amountSats.toString(),
      feeSats: feeSats.toString(),
      changeSats: changeSats.toString(),
      estimatedVbytes,
      feeRateSatsPerVbyte
    }),
    psbt
  })
}
