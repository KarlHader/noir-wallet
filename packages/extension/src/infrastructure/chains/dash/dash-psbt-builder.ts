import * as secp256k1 from '@bitcoinerlab/secp256k1'
import { initEccLib, payments, Psbt, Transaction } from 'bitcoinjs-lib'
import { Buffer } from 'buffer'
import { parseChainId } from '@/core/chains/registry'
import { DASH_CHAIN_IDS } from '@/core/chains/registry/chain-ids'
import { parseDashSelectableUtxo } from './dash-coin-selection'
import {
  DASH_CLASSIC_TRANSACTION_TYPE,
  DASH_CLASSIC_TRANSACTION_VERSION,
  DASH_FINAL_SEQUENCE,
  DASH_MAXIMUM_SELECTION_UTXOS,
  DASH_SIGHASH_ALL,
  dashBitcoinJsNetwork,
  dashDustDuffs,
  dashFeeForSelection,
  expectedDashDerivationPath,
  failInvalidDashTransaction,
  isPlainRecord,
  parseDashChain,
  parseDashDuffs,
  parseDashFeeRate,
  parseDashIndex,
  parseDashMasterFingerprint,
  parseDashPublicKey,
  parseDashRecipient,
  type DashCoinSelection,
  type DashSelectableUtxo,
  type PreparedDashPsbt
} from './dash-transaction-model'

let eccReady = false

function ensureEcc(): void {
  if (eccReady) return
  initEccLib(secp256k1)
  eccReady = true
}

export interface DashChangeOutput {
  readonly address: string
  readonly derivationPath: string
  readonly publicKey: string
}

export interface BuildDashPsbtInput {
  readonly selection: DashCoinSelection
  readonly masterFingerprint: string
  readonly lockTime?: number
  readonly change?: DashChangeOutput
}

function publicKeyBuffer(publicKey: string): Buffer {
  return Buffer.from(publicKey.slice(2), 'hex')
}

function assertPublicKey(publicKey: string, address: string, chainId: string): Buffer {
  const network = dashBitcoinJsNetwork(chainId)
  const derived = payments.p2pkh({ pubkey: publicKeyBuffer(publicKey), network }).address
  if (derived !== address) failInvalidDashTransaction('Dash public key does not match its address')
  return publicKeyBuffer(publicKey)
}

function parseSelection(value: DashCoinSelection): DashCoinSelection {
  if (!isPlainRecord(value) || !Array.isArray(value.selectedUtxos)) {
    failInvalidDashTransaction('Invalid Dash coin selection')
  }
  const chainId = parseDashChain(value.chainId)
  const accountIndex = parseDashIndex(value.accountIndex, 'Dash account index')
  if (typeof value.imported !== 'boolean') failInvalidDashTransaction('Invalid Dash account type')
  const feeRate = parseDashFeeRate(value.feeRateDuffsPerKb)
  const recipient = parseDashRecipient(value.recipient, chainId)
  if (
    value.selectedUtxos.length === 0 ||
    value.selectedUtxos.length > DASH_MAXIMUM_SELECTION_UTXOS
  ) {
    failInvalidDashTransaction('Invalid Dash selected UTXOs')
  }
  const seen = new Set<string>()
  const selectedUtxos = value.selectedUtxos.map(candidate => {
    const utxo = parseDashSelectableUtxo(candidate)
    if (
      utxo.chainId !== chainId ||
      utxo.accountIndex !== accountIndex ||
      utxo.imported !== value.imported
    ) {
      failInvalidDashTransaction('Dash UTXO does not match the selected account')
    }
    const key = `${utxo.transactionId}:${utxo.outputIndex}`
    if (seen.has(key)) failInvalidDashTransaction('Duplicate Dash UTXO')
    seen.add(key)
    assertPublicKey(utxo.publicKey, utxo.address, chainId)
    return utxo
  })
  const amount = parseDashDuffs(value.amountDuffs, 'Dash transfer amount')
  const fee = parseDashDuffs(value.feeDuffs, 'Dash transaction fee')
  const change = parseDashDuffs(value.changeDuffs, 'Dash change amount')
  const total = selectedUtxos.reduce((sum, utxo) => sum + BigInt(utxo.valueDuffs), 0n)
  const outputs = change === 0n ? 1 : 2
  const priced = dashFeeForSelection(selectedUtxos.length, outputs, feeRate)
  const dust = dashDustDuffs(feeRate)
  if (
    total.toString() !== value.selectedTotalDuffs ||
    amount + fee + change !== total ||
    amount < dust ||
    (change > 0n && (change < dust || value.imported)) ||
    value.legacyBytes !== priced.legacyBytes ||
    (change > 0n && fee !== priced.feeDuffs) ||
    (change === 0n && fee < priced.feeDuffs)
  ) {
    failInvalidDashTransaction('Invalid Dash coin selection')
  }
  return Object.freeze({
    chainId,
    accountIndex,
    imported: value.imported,
    recipient,
    selectedUtxos: Object.freeze(selectedUtxos),
    selectedTotalDuffs: total.toString(),
    amountDuffs: amount.toString(),
    feeDuffs: fee.toString(),
    changeDuffs: change.toString(),
    legacyBytes: priced.legacyBytes,
    feeRateDuffsPerKb: feeRate.toString()
  })
}

function previousOutput(utxo: DashSelectableUtxo): {
  readonly transaction: Transaction
  readonly script: Buffer
} {
  let transaction: Transaction
  try {
    transaction = Transaction.fromHex(utxo.rawTransactionHex)
  } catch {
    failInvalidDashTransaction('Invalid Dash previous transaction')
  }
  const output = transaction.outs[utxo.outputIndex]
  const script = Buffer.from(utxo.scriptHex, 'hex')
  if (
    transaction.getId() !== utxo.transactionId ||
    !output ||
    output.value !== Number(BigInt(utxo.valueDuffs)) ||
    !output.script.equals(script)
  ) {
    failInvalidDashTransaction('Dash previous transaction output does not match discovery')
  }
  return { transaction, script }
}

export function buildDashPsbt(input: BuildDashPsbtInput): PreparedDashPsbt {
  ensureEcc()
  if (!isPlainRecord(input)) failInvalidDashTransaction('Invalid Dash PSBT build input')
  const selection = parseSelection(input.selection)
  const fingerprint = parseDashMasterFingerprint(input.masterFingerprint)
  const lockTime = parseDashIndex(input.lockTime ?? 0, 'Dash lock time')
  const changeDuffs = BigInt(selection.changeDuffs)
  const change = input.change
  if (changeDuffs > 0n !== (change !== undefined)) {
    failInvalidDashTransaction('Dash change output does not match the coin selection')
  }
  let changeAddress: string | null = null
  let changePath: string | null = null
  let changeKey: Buffer | null = null
  if (change) {
    if (!isPlainRecord(change) || selection.imported) {
      failInvalidDashTransaction('Invalid Dash change output')
    }
    changeAddress = parseDashRecipient(change.address, selection.chainId)
    if (change.derivationPath !== expectedChangePath(selection, change.derivationPath)) {
      failInvalidDashTransaction('Dash change output does not belong to the selected account')
    }
    changePath = change.derivationPath
    changeKey = assertPublicKey(
      parseDashPublicKey(change.publicKey),
      changeAddress,
      selection.chainId
    )
    if (changeAddress === selection.recipient) {
      failInvalidDashTransaction('Dash change address must be distinct from the recipient')
    }
  }

  const network = dashBitcoinJsNetwork(selection.chainId)
  const masterFingerprint = Buffer.from(fingerprint.slice(2), 'hex')
  const psbt = new Psbt({ network })
  psbt.setVersion(DASH_CLASSIC_TRANSACTION_VERSION).setLocktime(lockTime)
  for (const utxo of selection.selectedUtxos) {
    const previous = previousOutput(utxo)
    psbt.addInput({
      hash: utxo.transactionId,
      index: utxo.outputIndex,
      sequence: DASH_FINAL_SEQUENCE,
      sighashType: DASH_SIGHASH_ALL,
      nonWitnessUtxo: previous.transaction.toBuffer(),
      bip32Derivation: [
        {
          masterFingerprint,
          pubkey: publicKeyBuffer(utxo.publicKey),
          path: utxo.derivationPath
        }
      ]
    })
  }
  psbt.addOutput({ address: selection.recipient, value: Number(BigInt(selection.amountDuffs)) })
  if (changeAddress && changeKey && changePath) {
    psbt.addOutput({
      address: changeAddress,
      value: Number(changeDuffs),
      bip32Derivation: [{ masterFingerprint, pubkey: changeKey, path: changePath }]
    })
  }
  const unsigned = Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer())
  if (
    (unsigned.version & 0xffff) !== DASH_CLASSIC_TRANSACTION_VERSION ||
    unsigned.version >>> 16 !== DASH_CLASSIC_TRANSACTION_TYPE
  ) {
    failInvalidDashTransaction('Dash transaction type must stay classic')
  }
  return Object.freeze({
    schemaVersion: 1,
    chainId: parseChainId(selection.chainId).id,
    accountIndex: selection.accountIndex,
    imported: selection.imported,
    psbtBase64: psbt.toBase64(),
    unsignedTransactionId: unsigned.getId(),
    transactionVersion: DASH_CLASSIC_TRANSACTION_VERSION,
    transactionType: DASH_CLASSIC_TRANSACTION_TYPE,
    lockTime,
    sighash: 'SIGHASH_ALL',
    inputCount: selection.selectedUtxos.length,
    outputCount: changeAddress === null ? 1 : 2,
    recipient: selection.recipient,
    recipientOutputIndex: 0,
    changeAddress,
    changeDerivationPath: changePath,
    changeOutputIndex: changeAddress === null ? null : 1,
    selectedTotalDuffs: selection.selectedTotalDuffs,
    amountDuffs: selection.amountDuffs,
    feeDuffs: selection.feeDuffs,
    changeDuffs: selection.changeDuffs,
    legacyBytes: selection.legacyBytes,
    feeRateDuffsPerKb: selection.feeRateDuffsPerKb
  })
}

function expectedChangePath(selection: DashCoinSelection, path: unknown): string {
  if (typeof path !== 'string' || selection.imported) {
    return failInvalidDashTransaction('Invalid Dash change path')
  }
  const coinType = selection.chainId === DASH_CHAIN_IDS.mainnet ? '5' : '1'
  const match = new RegExp(`^m/44'/${coinType}'/${selection.accountIndex}'/1/(\\d+)$`).exec(path)
  if (!match)
    return failInvalidDashTransaction('Dash change output does not belong to the selected account')
  const addressIndex = Number(match[1])
  if (!Number.isSafeInteger(addressIndex) || addressIndex > 0x7fffffff) {
    return failInvalidDashTransaction('Dash change output does not belong to the selected account')
  }
  return expectedDashDerivationPath(
    selection.chainId,
    selection.accountIndex,
    true,
    addressIndex,
    false
  )
}
