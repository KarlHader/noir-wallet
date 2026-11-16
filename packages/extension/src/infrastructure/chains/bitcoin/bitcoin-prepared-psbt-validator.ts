import { address, networks, payments, Psbt, Transaction } from 'bitcoinjs-lib'
import { Buffer } from 'buffer'
import {
  BITCOIN_MAINNET_CHAIN_ID,
  BITCOIN_MAXIMUM_SELECTION_UTXOS,
  bitcoinDustSats,
  detectBitcoinAddressType,
  estimateBitcoinVbytes,
  failInvalidSignedBitcoinTransaction,
  parseBitcoinAddress,
  parseBitcoinAddressType,
  parseBitcoinAmount,
  parseBitcoinChain,
  parseBitcoinFeeRate,
  parseBitcoinIndex,
  type PreparedBitcoinPsbt
} from './bitcoin-transaction-model'

const BITCOIN_RBF_SEQUENCE = 0xfffffffd
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

function hasOwnExactKeys(value: object, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value)
  return actualKeys.length === keys.length && keys.every(key => actualKeys.includes(key))
}

function failSigned(): never {
  return failInvalidSignedBitcoinTransaction('Invalid signed Bitcoin transaction')
}

function parseNonNegativeAmount(value: unknown, label: string): bigint {
  if (value === '0') return 0n
  return parseBitcoinAmount(value, label)
}

function matchesDerivationPath(path: string, pattern: RegExp): boolean {
  const match = pattern.exec(path)
  return match !== null && Number(match[1]) <= 0x7fffffff
}

function bitcoinNetwork(chainId: PreparedBitcoinPsbt['chainId']) {
  return chainId === BITCOIN_MAINNET_CHAIN_ID ? networks.bitcoin : networks.testnet
}

function bufferEquals(left: Buffer | undefined, right: Buffer | undefined): boolean {
  return left !== undefined && right !== undefined && left.equals(right)
}

export function parseBitcoinPsbt(value: unknown, chainId: PreparedBitcoinPsbt['chainId']): Psbt {
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
    return Psbt.fromBase64(value, { network: bitcoinNetwork(chainId) })
  } catch {
    return failSigned()
  }
}

export function parsePreparedBitcoinPsbt(value: PreparedBitcoinPsbt): {
  readonly prepared: PreparedBitcoinPsbt
  readonly psbt: Psbt
} {
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'chainId',
      'accountIndex',
      'addressType',
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
    typeof value.unsignedTransactionId !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.unsignedTransactionId)
  ) {
    return failSigned()
  }
  const chainId = parseBitcoinChain(value.chainId)
  const accountIndex = parseBitcoinIndex(value.accountIndex, 'Bitcoin account index')
  const addressType = parseBitcoinAddressType(value.addressType)
  const lockTime = parseBitcoinIndex(value.lockTime, 'Bitcoin lock time', MAXIMUM_LOCK_TIME)
  const inputCount = parseBitcoinIndex(
    value.inputCount,
    'Bitcoin input count',
    BITCOIN_MAXIMUM_SELECTION_UTXOS
  )
  const outputCount = parseBitcoinIndex(value.outputCount, 'Bitcoin output count', 2)
  const recipientOutputIndex = parseBitcoinIndex(
    value.recipientOutputIndex,
    'Bitcoin recipient output index',
    1
  )
  if (inputCount === 0 || outputCount < 1 || recipientOutputIndex >= outputCount)
    return failSigned()
  const recipient = parseBitcoinAddress(value.recipient, chainId)
  const recipientAddressType = detectBitcoinAddressType(recipient, chainId)
  const selectedTotalSats = parseBitcoinAmount(value.selectedTotalSats, 'Bitcoin selected total')
  const amountSats = parseBitcoinAmount(value.amountSats, 'Bitcoin transfer amount')
  const feeSats = parseBitcoinAmount(value.feeSats, 'Bitcoin transaction fee')
  const changeSats = parseNonNegativeAmount(value.changeSats, 'Bitcoin change amount')
  const feeRateSatsPerVbyte = parseBitcoinFeeRate(value.feeRateSatsPerVbyte)
  const expectedVbytes = estimateBitcoinVbytes(
    inputCount,
    addressType,
    recipientAddressType,
    changeSats > 0n
  )
  if (
    !Number.isSafeInteger(value.estimatedVbytes) ||
    value.estimatedVbytes !== Number(expectedVbytes) ||
    amountSats + feeSats + changeSats !== selectedTotalSats ||
    amountSats < bitcoinDustSats(recipientAddressType) ||
    (changeSats > 0n && changeSats < bitcoinDustSats(addressType)) ||
    feeSats < expectedVbytes * BigInt(feeRateSatsPerVbyte) ||
    (changeSats > 0n && feeSats !== expectedVbytes * BigInt(feeRateSatsPerVbyte))
  ) {
    return failSigned()
  }
  let changeAddress: string | null = null
  let changeOutputIndex: number | null = null
  if (changeSats === 0n) {
    if (value.changeAddress !== null || value.changeOutputIndex !== null || outputCount !== 1) {
      return failSigned()
    }
  } else {
    changeAddress = parseBitcoinAddress(value.changeAddress, chainId, addressType)
    changeOutputIndex = parseBitcoinIndex(value.changeOutputIndex, 'Bitcoin change output index', 1)
    if (
      outputCount !== 2 ||
      changeOutputIndex === recipientOutputIndex ||
      changeOutputIndex >= outputCount
    ) {
      return failSigned()
    }
  }

  const psbt = parseBitcoinPsbt(value.psbtBase64, chainId)
  const unsignedTransaction = Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer())
  if (
    !hasOwnExactKeys(psbt.data.globalMap, ['unsignedTx']) ||
    psbt.version !== 2 ||
    psbt.locktime !== lockTime ||
    psbt.inputCount !== inputCount ||
    psbt.txOutputs.length !== outputCount ||
    unsignedTransaction.getId() !== value.unsignedTransactionId ||
    psbt.txInputs.some(input => input.sequence !== BITCOIN_RBF_SEQUENCE) ||
    psbt.txOutputs[recipientOutputIndex].value !== Number(amountSats) ||
    !psbt.txOutputs[recipientOutputIndex].script.equals(
      address.toOutputScript(recipient, bitcoinNetwork(chainId))
    ) ||
    (changeOutputIndex !== null &&
      (psbt.txOutputs[changeOutputIndex].value !== Number(changeSats) ||
        !psbt.txOutputs[changeOutputIndex].script.equals(
          address.toOutputScript(changeAddress as string, bitcoinNetwork(chainId))
        )))
  ) {
    return failSigned()
  }

  let inputTotal = 0n
  let masterFingerprint: Buffer | null = null
  const purpose =
    addressType === 'p2pkh'
      ? 44
      : addressType === 'p2sh-p2wpkh'
        ? 49
        : addressType === 'p2wpkh'
          ? 84
          : 86
  const coinType = chainId === BITCOIN_MAINNET_CHAIN_ID ? 0 : 1
  const pathPattern = new RegExp(
    `^m/${purpose}'/${coinType}'/${addressType === 'p2wpkh' ? '(?:0|[1-9][0-9]*)' : accountIndex}'/[01]/(0|[1-9][0-9]{0,9})$`
  )
  let accountRoot: string | null = null
  for (let inputIndex = 0; inputIndex < psbt.data.inputs.length; inputIndex += 1) {
    const input = psbt.data.inputs[inputIndex]
    if (input.finalScriptSig || input.finalScriptWitness) return failSigned()
    const derivation =
      addressType === 'p2tr' ? input.tapBip32Derivation?.[0] : input.bip32Derivation?.[0]
    const expectedInputKeys =
      addressType === 'p2pkh'
        ? ['nonWitnessUtxo', 'bip32Derivation']
        : addressType === 'p2sh-p2wpkh'
          ? ['witnessUtxo', 'bip32Derivation', 'redeemScript']
          : addressType === 'p2wpkh'
            ? ['witnessUtxo', 'bip32Derivation']
            : ['witnessUtxo', 'tapBip32Derivation', 'tapInternalKey']
    if (
      !hasOwnExactKeys(input, expectedInputKeys) ||
      (addressType !== 'p2tr' &&
        (input.bip32Derivation?.length !== 1 ||
          input.tapBip32Derivation !== undefined ||
          input.tapInternalKey !== undefined)) ||
      (addressType === 'p2tr' &&
        (input.tapBip32Derivation?.length !== 1 ||
          input.bip32Derivation !== undefined ||
          input.tapBip32Derivation[0].leafHashes.length !== 0 ||
          !bufferEquals(input.tapInternalKey, input.tapBip32Derivation[0].pubkey))) ||
      (addressType === 'p2pkh' && input.witnessUtxo !== undefined) ||
      (addressType !== 'p2pkh' && (!input.witnessUtxo || input.nonWitnessUtxo !== undefined)) ||
      (addressType !== 'p2sh-p2wpkh' && input.redeemScript !== undefined) ||
      !derivation ||
      derivation.masterFingerprint.length !== 4 ||
      !matchesDerivationPath(derivation.path, pathPattern)
    ) {
      return failSigned()
    }
    if (masterFingerprint === null) masterFingerprint = derivation.masterFingerprint
    if (!masterFingerprint.equals(derivation.masterFingerprint)) return failSigned()
    const inputRoot = derivation.path.split('/').slice(0, 4).join('/')
    if (accountRoot !== null && accountRoot !== inputRoot) return failSigned()
    accountRoot = inputRoot
    const network = bitcoinNetwork(chainId)
    const payment =
      addressType === 'p2pkh'
        ? payments.p2pkh({ pubkey: derivation.pubkey, network })
        : addressType === 'p2sh-p2wpkh'
          ? payments.p2sh({
              redeem: payments.p2wpkh({ pubkey: derivation.pubkey, network }),
              network
            })
          : addressType === 'p2wpkh'
            ? payments.p2wpkh({ pubkey: derivation.pubkey, network })
            : payments.p2tr({ internalPubkey: derivation.pubkey, network })
    const expectedScript = payment.output
    if (!expectedScript) return failSigned()
    if (
      addressType === 'p2sh-p2wpkh' &&
      !bufferEquals(input.redeemScript, payment.redeem?.output)
    ) {
      return failSigned()
    }
    let spendValue: number
    let spendScript: Buffer
    if (addressType === 'p2pkh') {
      if (!input.nonWitnessUtxo) return failSigned()
      let previous: Transaction
      try {
        previous = Transaction.fromBuffer(input.nonWitnessUtxo)
      } catch {
        return failSigned()
      }
      const transactionInput = psbt.txInputs[inputIndex]
      if (previous.getId() !== Buffer.from(transactionInput.hash).reverse().toString('hex')) {
        return failSigned()
      }
      const previousOutput = previous.outs[transactionInput.index]
      if (!previousOutput) return failSigned()
      spendValue = previousOutput.value
      spendScript = previousOutput.script
    } else {
      if (!input.witnessUtxo) return failSigned()
      spendValue = input.witnessUtxo.value
      spendScript = input.witnessUtxo.script
    }
    if (!spendScript.equals(expectedScript)) return failSigned()
    inputTotal += BigInt(spendValue)
  }
  if (inputTotal !== selectedTotalSats) return failSigned()

  if (changeOutputIndex !== null) {
    const output = psbt.data.outputs[changeOutputIndex]
    const derivation =
      addressType === 'p2tr' ? output.tapBip32Derivation?.[0] : output.bip32Derivation?.[0]
    if (!accountRoot) return failSigned()
    const activeAddressPath = `${accountRoot}/0/0`
    const legacyChangePath = new RegExp(`^${accountRoot}/1/(0|[1-9][0-9]{0,9})$`)
    if (
      (addressType !== 'p2tr' && output.bip32Derivation?.length !== 1) ||
      (addressType === 'p2tr' &&
        (output.tapBip32Derivation?.length !== 1 ||
          output.tapBip32Derivation[0].leafHashes.length !== 0 ||
          !bufferEquals(output.tapInternalKey, output.tapBip32Derivation[0].pubkey))) ||
      !derivation ||
      !masterFingerprint ||
      !derivation.masterFingerprint.equals(masterFingerprint) ||
      (derivation.path !== activeAddressPath &&
        !matchesDerivationPath(derivation.path, legacyChangePath))
    ) {
      return failSigned()
    }
    const network = bitcoinNetwork(chainId)
    const payment =
      addressType === 'p2pkh'
        ? payments.p2pkh({ pubkey: derivation.pubkey, network })
        : addressType === 'p2sh-p2wpkh'
          ? payments.p2sh({
              redeem: payments.p2wpkh({ pubkey: derivation.pubkey, network }),
              network
            })
          : addressType === 'p2wpkh'
            ? payments.p2wpkh({ pubkey: derivation.pubkey, network })
            : payments.p2tr({ internalPubkey: derivation.pubkey, network })
    const expectedOutputScript = payment.output
    if (
      addressType === 'p2sh-p2wpkh' &&
      !bufferEquals(output.redeemScript, payment.redeem?.output)
    ) {
      return failSigned()
    }
    if (!bufferEquals(psbt.txOutputs[changeOutputIndex].script, expectedOutputScript)) {
      return failSigned()
    }
  }

  const recipientOutput = psbt.data.outputs[recipientOutputIndex]
  if (!recipientOutput || !hasOwnExactKeys(recipientOutput, [])) return failSigned()
  if (changeOutputIndex !== null) {
    const changeOutput = psbt.data.outputs[changeOutputIndex]
    const expectedKeys =
      addressType === 'p2tr'
        ? ['tapBip32Derivation', 'tapInternalKey']
        : addressType === 'p2sh-p2wpkh'
          ? ['bip32Derivation', 'redeemScript']
          : ['bip32Derivation']
    if (!changeOutput || !hasOwnExactKeys(changeOutput, expectedKeys)) return failSigned()
  }

  return {
    prepared: Object.freeze({
      ...value,
      chainId,
      accountIndex,
      addressType,
      lockTime,
      inputCount,
      outputCount,
      recipient,
      recipientOutputIndex,
      changeAddress,
      changeOutputIndex,
      selectedTotalSats: selectedTotalSats.toString(),
      amountSats: amountSats.toString(),
      feeSats: feeSats.toString(),
      changeSats: changeSats.toString(),
      feeRateSatsPerVbyte
    }),
    psbt
  }
}
