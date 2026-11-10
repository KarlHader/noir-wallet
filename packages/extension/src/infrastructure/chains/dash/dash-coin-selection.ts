import { DASH_MAX_MONEY_DUFFS } from './config'
import {
  DASH_MAXIMUM_SELECTION_UTXOS,
  DashTransactionBuildError,
  dashDustDuffs,
  dashFeeForSelection,
  expectedDashDerivationPath,
  failInvalidDashTransaction,
  isPlainRecord,
  parseDashChain,
  parseDashDuffs,
  parseDashFeeRate,
  parseDashIndex,
  parseDashPublicKey,
  parseDashRecipient,
  parseDashTransferAmount,
  type DashCoinSelection,
  type DashSelectableUtxo,
  type SelectDashCoinsInput
} from './dash-transaction-model'

const TXID = /^[0-9a-f]{64}$/
const SCRIPT = /^76a914[0-9a-f]{40}88ac$/
const RAW_TX = /^(?:[0-9a-f]{2})+$/

function sumUtxos(utxos: readonly DashSelectableUtxo[]): bigint {
  return utxos.reduce((total, utxo) => {
    const next = total + BigInt(utxo.valueDuffs)
    if (next > DASH_MAX_MONEY_DUFFS) failInvalidDashTransaction('Dash selection exceeds MAX_MONEY')
    return next
  }, 0n)
}

export function parseDashSelectableUtxo(value: unknown): DashSelectableUtxo {
  if (
    !isPlainRecord(value) ||
    (value.imported !== true && value.imported !== false) ||
    (value.change !== true && value.change !== false)
  ) {
    failInvalidDashTransaction('Invalid Dash UTXO')
  }
  const chainId = parseDashChain(value.chainId)
  const accountIndex = parseDashIndex(value.accountIndex, 'Dash account index')
  const addressIndex = parseDashIndex(value.addressIndex, 'Dash address index')
  const imported = value.imported === true
  const change = value.change === true
  if (
    typeof value.transactionId !== 'string' ||
    !TXID.test(value.transactionId) ||
    !Number.isSafeInteger(value.outputIndex) ||
    (value.outputIndex as number) < 0 ||
    (value.outputIndex as number) > 0xffffffff ||
    typeof value.scriptHex !== 'string' ||
    !SCRIPT.test(value.scriptHex) ||
    typeof value.rawTransactionHex !== 'string' ||
    !RAW_TX.test(value.rawTransactionHex) ||
    value.rawTransactionHex.length > 2 * 1024 * 1024 ||
    typeof value.address !== 'string' ||
    typeof value.derivationPath !== 'string'
  ) {
    failInvalidDashTransaction('Invalid Dash UTXO')
  }
  const path = expectedDashDerivationPath(chainId, accountIndex, change, addressIndex, imported)
  if (value.derivationPath !== path)
    failInvalidDashTransaction('Dash UTXO path does not match the account')
  return Object.freeze({
    chainId,
    accountIndex,
    imported,
    change,
    addressIndex,
    address: parseDashRecipient(value.address, chainId),
    derivationPath: path,
    publicKey: parseDashPublicKey(value.publicKey),
    scriptHex: value.scriptHex,
    transactionId: value.transactionId,
    outputIndex: value.outputIndex as number,
    valueDuffs: parseDashDuffs(value.valueDuffs, 'Dash UTXO value').toString(),
    rawTransactionHex: value.rawTransactionHex
  })
}

function compareUtxos(left: DashSelectableUtxo, right: DashSelectableUtxo): number {
  const value = BigInt(left.valueDuffs) - BigInt(right.valueDuffs)
  if (value !== 0n) return value < 0n ? -1 : 1
  if (left.transactionId !== right.transactionId) {
    return left.transactionId < right.transactionId ? -1 : 1
  }
  return left.outputIndex - right.outputIndex
}

function makeSelection(
  input: SelectDashCoinsInput,
  recipient: string,
  selected: readonly DashSelectableUtxo[],
  amount: bigint,
  fee: bigint,
  change: bigint,
  legacyBytes: number,
  feeRate: bigint
): DashCoinSelection {
  if (amount + fee + change !== sumUtxos(selected)) {
    failInvalidDashTransaction('Dash coin selection does not balance')
  }
  return Object.freeze({
    chainId: input.chainId,
    accountIndex: input.accountIndex,
    imported: input.imported,
    recipient,
    selectedUtxos: Object.freeze([...selected]),
    selectedTotalDuffs: sumUtxos(selected).toString(),
    amountDuffs: amount.toString(),
    feeDuffs: fee.toString(),
    changeDuffs: change.toString(),
    legacyBytes,
    feeRateDuffsPerKb: feeRate.toString()
  })
}

function evaluateExact(
  input: SelectDashCoinsInput,
  recipient: string,
  selected: readonly DashSelectableUtxo[],
  amount: bigint,
  feeRate: bigint,
  dust: bigint
): DashCoinSelection | null {
  const total = sumUtxos(selected)
  const noChange = dashFeeForSelection(selected.length, 1, feeRate)
  if (total < amount + noChange.feeDuffs) return null
  if (input.imported) {
    return makeSelection(
      input,
      recipient,
      selected,
      amount,
      total - amount,
      0n,
      noChange.legacyBytes,
      feeRate
    )
  }
  const withChange = dashFeeForSelection(selected.length, 2, feeRate)
  const change = total - amount - withChange.feeDuffs
  if (change >= dust) {
    return makeSelection(
      input,
      recipient,
      selected,
      amount,
      withChange.feeDuffs,
      change,
      withChange.legacyBytes,
      feeRate
    )
  }
  return makeSelection(
    input,
    recipient,
    selected,
    amount,
    total - amount,
    0n,
    noChange.legacyBytes,
    feeRate
  )
}

export function selectDashCoins(input: SelectDashCoinsInput): DashCoinSelection {
  if (!isPlainRecord(input)) failInvalidDashTransaction('Invalid Dash coin selection input')
  const chainId = parseDashChain(input.chainId)
  const accountIndex = parseDashIndex(input.accountIndex, 'Dash account index')
  if (typeof input.imported !== 'boolean') failInvalidDashTransaction('Invalid Dash account type')
  const feeRate = parseDashFeeRate(input.feeRateDuffsPerKb)
  const dust = dashDustDuffs(feeRate)
  const recipient = parseDashRecipient(input.recipient, chainId)
  const amount = parseDashTransferAmount(input.amount)
  if (!Array.isArray(input.utxos) || input.utxos.length === 0) {
    throw new DashTransactionBuildError('insufficient-funds', 'No spendable Dash UTXOs')
  }
  if (input.utxos.length > DASH_MAXIMUM_SELECTION_UTXOS) {
    throw new DashTransactionBuildError(
      'capacity-exceeded',
      'Dash UTXO selection capacity exceeded'
    )
  }
  const seen = new Set<string>()
  const candidates = input.utxos.map(value => {
    const utxo = parseDashSelectableUtxo(value)
    if (
      utxo.chainId !== chainId ||
      utxo.accountIndex !== accountIndex ||
      utxo.imported !== input.imported
    ) {
      failInvalidDashTransaction('Dash UTXO does not match the selected account')
    }
    const key = `${utxo.transactionId}:${utxo.outputIndex}`
    if (seen.has(key)) failInvalidDashTransaction('Duplicate Dash UTXO')
    seen.add(key)
    return utxo
  })
  candidates.sort(compareUtxos)
  const normalized = Object.freeze({ ...input, chainId, accountIndex, amount })

  if (amount.mode === 'max') {
    const priced = dashFeeForSelection(candidates.length, 1, feeRate)
    const total = sumUtxos(candidates)
    const send = total - priced.feeDuffs
    if (send < dust) {
      throw new DashTransactionBuildError('insufficient-funds', 'Insufficient Dash funds')
    }
    return makeSelection(
      normalized,
      recipient,
      candidates,
      send,
      priced.feeDuffs,
      0n,
      priced.legacyBytes,
      feeRate
    )
  }

  const exact = BigInt(amount.valueDuffs)
  if (exact < dust)
    failInvalidDashTransaction('Dash transfer amount is below the dust relay threshold')
  let best: DashCoinSelection | null = null
  for (const candidate of candidates) {
    const selection = evaluateExact(normalized, recipient, [candidate], exact, feeRate, dust)
    if (
      selection &&
      (!best || BigInt(selection.selectedTotalDuffs) < BigInt(best.selectedTotalDuffs))
    ) {
      best = selection
    }
  }
  if (best) return best
  const selected: DashSelectableUtxo[] = []
  for (const candidate of candidates) {
    selected.push(candidate)
    const selection = evaluateExact(normalized, recipient, selected, exact, feeRate, dust)
    if (selection) return selection
  }
  throw new DashTransactionBuildError('insufficient-funds', 'Insufficient Dash funds')
}
