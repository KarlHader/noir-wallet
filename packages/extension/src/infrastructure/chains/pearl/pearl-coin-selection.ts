import {
  PEARL_DEFAULT_FEE_TARGET_BLOCKS,
  PEARL_MAXIMUM_FEE_RATE_SATS_PER_VBYTE,
  PEARL_MAXIMUM_FEE_TARGET_BLOCKS,
  PEARL_MAXIMUM_SELECTION_UTXOS,
  PearlTransactionBuildError,
  estimatePearlVbytes,
  failInvalidPearlTransaction,
  parsePearlAddress,
  parsePearlChain,
  parsePearlFeeRate,
  parsePearlIndex,
  parsePearlTransferAmount,
  pearlDustSats,
  type PearlCoinSelection,
  type PearlFeeRateQuote,
  type PearlSpendableUtxo,
  type SelectPearlCoinsInput
} from './pearl-transaction-model'
import { parsePearlSpendableUtxo, sumPearlUtxos } from './pearl-spendable-utxos'

export function selectPearlFeeRate(
  estimates: unknown,
  requestedTargetBlocks = PEARL_DEFAULT_FEE_TARGET_BLOCKS
): PearlFeeRateQuote {
  const requested = parsePearlIndex(
    requestedTargetBlocks,
    'Pearl fee target',
    PEARL_MAXIMUM_FEE_TARGET_BLOCKS
  )
  if (requested === 0) failInvalidPearlTransaction('Invalid Pearl fee target')
  if (
    typeof estimates !== 'object' ||
    estimates === null ||
    Array.isArray(estimates) ||
    Object.getPrototypeOf(estimates) !== Object.prototype
  ) {
    throw new PearlTransactionBuildError(
      'fee-estimate-unavailable',
      'Pearl fee estimates are unavailable'
    )
  }
  const entries = Object.entries(estimates)
  if (entries.length === 0 || entries.length > 64) {
    throw new PearlTransactionBuildError(
      'fee-estimate-unavailable',
      'Pearl fee estimates are unavailable'
    )
  }
  const parsed = entries.map(([target, rate]) => {
    if (!/^[1-9][0-9]{0,3}$/.test(target)) {
      failInvalidPearlTransaction('Invalid Pearl fee estimate')
    }
    const targetBlocks = Number(target)
    if (
      targetBlocks > PEARL_MAXIMUM_FEE_TARGET_BLOCKS ||
      typeof rate !== 'number' ||
      !Number.isFinite(rate) ||
      rate <= 0 ||
      rate > PEARL_MAXIMUM_FEE_RATE_SATS_PER_VBYTE
    ) {
      failInvalidPearlTransaction('Invalid Pearl fee estimate')
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
  input: SelectPearlCoinsInput,
  recipient: string,
  selectedUtxos: readonly PearlSpendableUtxo[],
  amountSats: bigint,
  feeSats: bigint,
  changeSats: bigint,
  estimatedVbytes: bigint,
  feeRateSatsPerVbyte: number
): PearlCoinSelection {
  const selectedTotalSats = sumPearlUtxos(selectedUtxos)
  if (amountSats + feeSats + changeSats !== selectedTotalSats) {
    failInvalidPearlTransaction('Pearl coin selection does not balance')
  }
  return Object.freeze({
    chainId: input.chainId,
    accountIndex: input.accountIndex,
    recipient,
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
  input: SelectPearlCoinsInput,
  recipient: string,
  selected: readonly PearlSpendableUtxo[],
  amount: bigint,
  feeRate: bigint,
  feeRateNumber: number
): PearlCoinSelection | null {
  const total = sumPearlUtxos(selected)
  const noChangeVbytes = estimatePearlVbytes(selected.length, false)
  const minimumNoChangeFee = noChangeVbytes * feeRate
  if (total < amount + minimumNoChangeFee) return null
  const withChangeVbytes = estimatePearlVbytes(selected.length, true)
  const withChangeFee = withChangeVbytes * feeRate
  const change = total - amount - withChangeFee
  if (change >= pearlDustSats()) {
    return makeSelection(
      input,
      recipient,
      selected,
      amount,
      withChangeFee,
      change,
      withChangeVbytes,
      feeRateNumber
    )
  }
  const fee = total - amount
  if (fee < minimumNoChangeFee) return null
  return makeSelection(input, recipient, selected, amount, fee, 0n, noChangeVbytes, feeRateNumber)
}

function evaluateMaxSelection(
  input: SelectPearlCoinsInput,
  recipient: string,
  selected: readonly PearlSpendableUtxo[],
  feeRate: bigint,
  feeRateNumber: number
): PearlCoinSelection | null {
  const total = sumPearlUtxos(selected)
  const vbytes = estimatePearlVbytes(selected.length, false)
  const fee = vbytes * feeRate
  if (total <= fee) return null
  return makeSelection(input, recipient, selected, total - fee, fee, 0n, vbytes, feeRateNumber)
}

export function selectPearlCoins(input: SelectPearlCoinsInput): PearlCoinSelection {
  const chainId = parsePearlChain(input.chainId)
  const accountIndex = parsePearlIndex(input.accountIndex, 'Pearl account index')
  const recipient = parsePearlAddress(input.recipient, chainId)
  const amount = parsePearlTransferAmount(input.amount)
  const feeRateNumber = parsePearlFeeRate(input.feeRateSatsPerVbyte)
  const feeRate = BigInt(feeRateNumber)
  if (!Array.isArray(input.utxos) || input.utxos.length === 0) {
    throw new PearlTransactionBuildError('insufficient-funds', 'Pearl UTXOs are unavailable')
  }
  if (input.utxos.length > PEARL_MAXIMUM_SELECTION_UTXOS) {
    throw new PearlTransactionBuildError(
      'capacity-exceeded',
      'Pearl UTXO selection capacity exceeded'
    )
  }
  const utxos = Object.freeze(input.utxos.map(parsePearlSpendableUtxo))
  for (const utxo of utxos) {
    if (utxo.chainId !== chainId || utxo.accountIndex !== accountIndex) {
      failInvalidPearlTransaction('Pearl UTXO does not match the selection scope')
    }
  }

  const selected: PearlSpendableUtxo[] = []
  if (amount.mode === 'max') {
    for (const utxo of utxos) {
      selected.push(utxo)
      const result = evaluateMaxSelection(
        { ...input, chainId, accountIndex, recipient, amount, feeRateSatsPerVbyte: feeRateNumber },
        recipient,
        selected,
        feeRate,
        feeRateNumber
      )
      if (result) return result
    }
    throw new PearlTransactionBuildError('insufficient-funds', 'Insufficient Pearl funds')
  }

  const target = BigInt(amount.valueSats)
  if (target < pearlDustSats()) {
    throw new PearlTransactionBuildError(
      'invalid-intent',
      'Pearl transfer amount is below the dust threshold'
    )
  }
  for (const utxo of utxos) {
    selected.push(utxo)
    const result = evaluateExactSelection(
      { ...input, chainId, accountIndex, recipient, amount, feeRateSatsPerVbyte: feeRateNumber },
      recipient,
      selected,
      target,
      feeRate,
      feeRateNumber
    )
    if (result) return result
  }
  throw new PearlTransactionBuildError('insufficient-funds', 'Insufficient Pearl funds')
}
