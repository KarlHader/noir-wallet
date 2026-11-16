import type { BitcoinSupportedAddressType } from '@/core/chains/bitcoin'
import {
  BITCOIN_DEFAULT_FEE_TARGET_BLOCKS,
  BITCOIN_MAXIMUM_FEE_RATE_SATS_PER_VBYTE,
  BITCOIN_MAXIMUM_FEE_TARGET_BLOCKS,
  BITCOIN_MAXIMUM_SELECTION_UTXOS,
  BitcoinTransactionBuildError,
  bitcoinAccountRootFromPath,
  bitcoinDustSats,
  detectBitcoinAddressType,
  estimateBitcoinVbytes,
  failInvalidBitcoinTransaction,
  parseBitcoinAddress,
  parseBitcoinAddressType,
  parseBitcoinChain,
  parseBitcoinFeeRate,
  parseBitcoinIndex,
  parseBitcoinTransferAmount,
  type BitcoinCoinSelection,
  type BitcoinFeeRateQuote,
  type BitcoinSpendableUtxo,
  type SelectBitcoinCoinsInput
} from './bitcoin-transaction-model'
import {
  compareBitcoinUtxos,
  parseBitcoinSpendableUtxo,
  sumBitcoinUtxos
} from './bitcoin-spendable-utxos'

export function selectBitcoinFeeRate(
  estimates: unknown,
  requestedTargetBlocks = BITCOIN_DEFAULT_FEE_TARGET_BLOCKS
): BitcoinFeeRateQuote {
  const requested = parseBitcoinIndex(
    requestedTargetBlocks,
    'Bitcoin fee target',
    BITCOIN_MAXIMUM_FEE_TARGET_BLOCKS
  )
  if (requested === 0) failInvalidBitcoinTransaction('Invalid Bitcoin fee target')
  if (
    typeof estimates !== 'object' ||
    estimates === null ||
    Array.isArray(estimates) ||
    Object.getPrototypeOf(estimates) !== Object.prototype
  ) {
    throw new BitcoinTransactionBuildError(
      'fee-estimate-unavailable',
      'Bitcoin fee estimates are unavailable'
    )
  }
  const entries = Object.entries(estimates)
  if (entries.length === 0 || entries.length > 64) {
    throw new BitcoinTransactionBuildError(
      'fee-estimate-unavailable',
      'Bitcoin fee estimates are unavailable'
    )
  }
  const parsed = entries.map(([target, rate]) => {
    if (!/^[1-9][0-9]{0,3}$/.test(target)) {
      failInvalidBitcoinTransaction('Invalid Bitcoin fee estimate')
    }
    const targetBlocks = Number(target)
    if (
      targetBlocks > BITCOIN_MAXIMUM_FEE_TARGET_BLOCKS ||
      typeof rate !== 'number' ||
      !Number.isFinite(rate) ||
      rate <= 0 ||
      rate > BITCOIN_MAXIMUM_FEE_RATE_SATS_PER_VBYTE
    ) {
      failInvalidBitcoinTransaction('Invalid Bitcoin fee estimate')
    }
    return Object.freeze({ targetBlocks, satsPerVbyte: Math.ceil(rate) })
  })
  parsed.sort((left, right) => left.targetBlocks - right.targetBlocks)
  const source = [...parsed].reverse().find(entry => entry.targetBlocks <= requested) ?? parsed[0]
  return Object.freeze({
    requestedTargetBlocks: requested,
    sourceTargetBlocks: source.targetBlocks,
    satsPerVbyte: source.satsPerVbyte
  })
}

function makeSelection(
  input: SelectBitcoinCoinsInput,
  recipient: string,
  recipientAddressType: BitcoinSupportedAddressType,
  selectedUtxos: readonly BitcoinSpendableUtxo[],
  amountSats: bigint,
  feeSats: bigint,
  changeSats: bigint,
  estimatedVbytes: bigint,
  feeRateSatsPerVbyte: number
): BitcoinCoinSelection {
  const selectedTotalSats = sumBitcoinUtxos(selectedUtxos)
  if (amountSats + feeSats + changeSats !== selectedTotalSats) {
    failInvalidBitcoinTransaction('Bitcoin coin selection does not balance')
  }
  return Object.freeze({
    chainId: input.chainId,
    accountIndex: input.accountIndex,
    addressType: input.addressType,
    recipient,
    recipientAddressType,
    selectedUtxos: Object.freeze([...selectedUtxos]),
    selectedTotalSats: selectedTotalSats.toString(),
    amountSats: amountSats.toString(),
    feeSats: feeSats.toString(),
    changeSats: changeSats.toString(),
    estimatedVbytes: Number(estimatedVbytes),
    feeRateSatsPerVbyte
  })
}

function evaluateExactSelection(
  input: SelectBitcoinCoinsInput,
  recipient: string,
  recipientType: BitcoinSupportedAddressType,
  selected: readonly BitcoinSpendableUtxo[],
  amount: bigint,
  feeRate: bigint,
  feeRateNumber: number
): BitcoinCoinSelection | null {
  const total = sumBitcoinUtxos(selected)
  const noChangeVbytes = estimateBitcoinVbytes(
    selected.length,
    input.addressType,
    recipientType,
    false
  )
  const minimumNoChangeFee = noChangeVbytes * feeRate
  if (total < amount + minimumNoChangeFee) return null
  const withChangeVbytes = estimateBitcoinVbytes(
    selected.length,
    input.addressType,
    recipientType,
    true
  )
  const withChangeFee = withChangeVbytes * feeRate
  const change = total - amount - withChangeFee
  if (change >= bitcoinDustSats(input.addressType)) {
    return makeSelection(
      input,
      recipient,
      recipientType,
      selected,
      amount,
      withChangeFee,
      change,
      withChangeVbytes,
      feeRateNumber
    )
  }
  return makeSelection(
    input,
    recipient,
    recipientType,
    selected,
    amount,
    total - amount,
    0n,
    noChangeVbytes,
    feeRateNumber
  )
}

export function selectBitcoinCoins(input: SelectBitcoinCoinsInput): BitcoinCoinSelection {
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) ||
    Object.keys(input).length !== 7 ||
    ![
      'chainId',
      'accountIndex',
      'addressType',
      'recipient',
      'amount',
      'feeRateSatsPerVbyte',
      'utxos'
    ].every(key => Object.prototype.hasOwnProperty.call(input, key))
  ) {
    failInvalidBitcoinTransaction('Invalid Bitcoin coin selection input')
  }
  const chainId = parseBitcoinChain(input.chainId)
  const accountIndex = parseBitcoinIndex(input.accountIndex, 'Bitcoin account index')
  const addressType = parseBitcoinAddressType(input.addressType)
  const feeRateNumber = parseBitcoinFeeRate(input.feeRateSatsPerVbyte)
  const feeRate = BigInt(feeRateNumber)
  const recipient = parseBitcoinAddress(input.recipient, chainId)
  const recipientType = detectBitcoinAddressType(recipient, chainId)
  const transferAmount = parseBitcoinTransferAmount(input.amount)
  if (!Array.isArray(input.utxos) || input.utxos.length === 0) {
    throw new BitcoinTransactionBuildError('insufficient-funds', 'No spendable Bitcoin UTXOs')
  }
  if (input.utxos.length > BITCOIN_MAXIMUM_SELECTION_UTXOS) {
    throw new BitcoinTransactionBuildError(
      'capacity-exceeded',
      'Bitcoin UTXO selection capacity exceeded'
    )
  }
  const seen = new Set<string>()
  let accountRoot: string | undefined
  const candidates = input.utxos.map(value => {
    const utxo = parseBitcoinSpendableUtxo(value)
    if (
      utxo.chainId !== chainId ||
      utxo.accountIndex !== accountIndex ||
      utxo.addressType !== addressType
    ) {
      failInvalidBitcoinTransaction('Bitcoin UTXO does not match the selected account')
    }
    const root = bitcoinAccountRootFromPath(
      utxo.derivationPath,
      chainId,
      addressType,
      utxo.change,
      utxo.addressIndex
    )
    if (accountRoot !== undefined && accountRoot !== root) {
      failInvalidBitcoinTransaction('Bitcoin UTXOs belong to different accounts')
    }
    accountRoot = root
    const key = `${utxo.transactionId}:${utxo.outputIndex}`
    if (seen.has(key)) failInvalidBitcoinTransaction('Duplicate Bitcoin UTXO')
    seen.add(key)
    return utxo
  })
  candidates.sort(compareBitcoinUtxos)
  const normalizedInput = Object.freeze({
    ...input,
    chainId,
    accountIndex,
    addressType,
    amount: transferAmount
  })

  if (transferAmount.mode === 'max') {
    const estimatedVbytes = estimateBitcoinVbytes(
      candidates.length,
      addressType,
      recipientType,
      false
    )
    const fee = estimatedVbytes * feeRate
    const total = sumBitcoinUtxos(candidates)
    const amount = total - fee
    if (amount < bitcoinDustSats(recipientType)) {
      throw new BitcoinTransactionBuildError('insufficient-funds', 'Insufficient Bitcoin funds')
    }
    return makeSelection(
      normalizedInput,
      recipient,
      recipientType,
      candidates,
      amount,
      fee,
      0n,
      estimatedVbytes,
      feeRateNumber
    )
  }

  const amount = BigInt(transferAmount.valueSats)
  if (amount < bitcoinDustSats(recipientType)) {
    failInvalidBitcoinTransaction('Bitcoin transfer amount is dust')
  }
  let bestSingle: BitcoinCoinSelection | null = null
  for (const candidate of candidates) {
    const selection = evaluateExactSelection(
      normalizedInput,
      recipient,
      recipientType,
      [candidate],
      amount,
      feeRate,
      feeRateNumber
    )
    if (
      selection &&
      (!bestSingle || BigInt(selection.selectedTotalSats) < BigInt(bestSingle.selectedTotalSats))
    ) {
      bestSingle = selection
    }
  }
  if (bestSingle) return bestSingle

  const selected: BitcoinSpendableUtxo[] = []
  for (const candidate of candidates) {
    selected.push(candidate)
    const selection = evaluateExactSelection(
      normalizedInput,
      recipient,
      recipientType,
      selected,
      amount,
      feeRate,
      feeRateNumber
    )
    if (selection) return selection
  }
  throw new BitcoinTransactionBuildError('insufficient-funds', 'Insufficient Bitcoin funds')
}
