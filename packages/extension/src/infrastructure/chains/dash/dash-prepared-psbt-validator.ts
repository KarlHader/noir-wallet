import { address, payments, Psbt, Transaction } from 'bitcoinjs-lib'
import { Buffer } from 'buffer'
import { parseSigningSummary, type SigningSummary } from '@/core/keyring/domain'
import { DASH_CHAIN_IDS } from '@/core/chains/registry/chain-ids'
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
  failInvalidSignedDashTransaction,
  isPlainRecord,
  parseDashChain,
  parseDashDuffs,
  parseDashFeeRate,
  parseDashIndex,
  parseDashRecipient,
  type PreparedDashPsbt
} from './dash-transaction-model'

const MAX_PSBT = 2_000_000

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every(key => actual.includes(key))
}

function fail(): never {
  return failInvalidSignedDashTransaction('Signed Dash transaction does not match the review')
}

export function parseDashPsbt(value: unknown, chainId: string): Psbt {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_PSBT ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    return fail()
  }
  try {
    return Psbt.fromBase64(value, { network: dashBitcoinJsNetwork(chainId) })
  } catch {
    return fail()
  }
}

export function parsePreparedDashPsbt(value: PreparedDashPsbt): {
  readonly prepared: PreparedDashPsbt
  readonly psbt: Psbt
} {
  if (
    !isPlainRecord(value) ||
    value.schemaVersion !== 1 ||
    value.transactionVersion !== DASH_CLASSIC_TRANSACTION_VERSION ||
    value.transactionType !== DASH_CLASSIC_TRANSACTION_TYPE ||
    value.sighash !== 'SIGHASH_ALL' ||
    typeof value.imported !== 'boolean' ||
    typeof value.unsignedTransactionId !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.unsignedTransactionId)
  ) {
    return fail()
  }
  const chainId = parseDashChain(value.chainId)
  const accountIndex = parseDashIndex(value.accountIndex, 'Dash account index')
  const lockTime = parseDashIndex(value.lockTime, 'Dash lock time')
  const inputCount = parseDashIndex(
    value.inputCount,
    'Dash input count',
    DASH_MAXIMUM_SELECTION_UTXOS
  )
  const outputCount = parseDashIndex(value.outputCount, 'Dash output count', 2)
  const recipientOutputIndex = parseDashIndex(value.recipientOutputIndex, 'Dash recipient index', 1)
  if (inputCount === 0 || outputCount < 1 || recipientOutputIndex !== 0) return fail()
  const recipient = parseDashRecipient(value.recipient, chainId)
  const selectedTotal = parseDashDuffs(value.selectedTotalDuffs, 'Dash selected total')
  const amount = parseDashDuffs(value.amountDuffs, 'Dash transfer amount')
  const fee = parseDashDuffs(value.feeDuffs, 'Dash transaction fee')
  const change = parseDashDuffs(value.changeDuffs, 'Dash change amount')
  const feeRate = parseDashFeeRate(value.feeRateDuffsPerKb)
  const dust = dashDustDuffs(feeRate)
  const priced = dashFeeForSelection(inputCount, change === 0n ? 1 : 2, feeRate)
  if (
    value.legacyBytes !== priced.legacyBytes ||
    amount + fee + change !== selectedTotal ||
    amount < dust ||
    (change > 0n && (change < dust || value.imported)) ||
    (change > 0n && fee !== priced.feeDuffs) ||
    (change === 0n && fee < priced.feeDuffs)
  ) {
    return fail()
  }
  let changeAddress: string | null = null
  let changeDerivationPath: string | null = null
  let changeOutputIndex: number | null = null
  if (change === 0n) {
    if (
      value.changeAddress !== null ||
      value.changeDerivationPath !== null ||
      value.changeOutputIndex !== null ||
      outputCount !== 1
    ) {
      return fail()
    }
  } else {
    changeAddress = parseDashRecipient(value.changeAddress, chainId)
    changeOutputIndex = parseDashIndex(value.changeOutputIndex, 'Dash change index', 1)
    if (
      typeof value.changeDerivationPath !== 'string' ||
      changeOutputIndex !== 1 ||
      outputCount !== 2
    )
      return fail()
    const coinType = chainId === DASH_CHAIN_IDS.mainnet ? '5' : '1'
    const match = new RegExp(`^m/44'/${coinType}'/${accountIndex}'/1/(\\d+)$`).exec(
      value.changeDerivationPath
    )
    if (!match) return fail()
    changeDerivationPath = expectedDashDerivationPath(
      chainId,
      accountIndex,
      true,
      Number(match[1]),
      false
    )
    if (changeAddress === recipient) return fail()
  }
  const psbt = parseDashPsbt(value.psbtBase64, chainId)
  assertPsbtMatchesReview(psbt, {
    chainId,
    accountIndex,
    imported: value.imported,
    lockTime,
    inputCount,
    outputCount,
    recipient,
    amount,
    change,
    changeAddress,
    changeDerivationPath,
    selectedTotal,
    unsignedTransactionId: value.unsignedTransactionId
  })
  return {
    prepared: Object.freeze({
      ...value,
      chainId,
      accountIndex,
      lockTime,
      inputCount,
      outputCount,
      recipient,
      recipientOutputIndex: 0,
      changeAddress,
      changeDerivationPath,
      changeOutputIndex,
      selectedTotalDuffs: selectedTotal.toString(),
      amountDuffs: amount.toString(),
      feeDuffs: fee.toString(),
      changeDuffs: change.toString(),
      feeRateDuffsPerKb: feeRate.toString()
    }),
    psbt
  }
}

interface ReviewBinding {
  readonly chainId: ReturnType<typeof parseDashChain>
  readonly accountIndex: number
  readonly imported: boolean
  readonly lockTime: number
  readonly inputCount: number
  readonly outputCount: number
  readonly recipient: string
  readonly amount: bigint
  readonly change: bigint
  readonly changeAddress: string | null
  readonly changeDerivationPath: string | null
  readonly selectedTotal: bigint
  readonly unsignedTransactionId: string
}

function assertPsbtMatchesReview(psbt: Psbt, review: ReviewBinding): void {
  const network = dashBitcoinJsNetwork(review.chainId)
  const unsigned = Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer())
  if (
    !exactKeys(psbt.data.globalMap, ['unsignedTx']) ||
    psbt.version !== DASH_CLASSIC_TRANSACTION_VERSION ||
    unsigned.version >>> 16 !== DASH_CLASSIC_TRANSACTION_TYPE ||
    psbt.locktime !== review.lockTime ||
    psbt.inputCount !== review.inputCount ||
    psbt.txOutputs.length !== review.outputCount ||
    unsigned.getId() !== review.unsignedTransactionId ||
    psbt.txOutputs[0].value !== Number(review.amount) ||
    !psbt.txOutputs[0].script.equals(address.toOutputScript(review.recipient, network))
  ) {
    return fail()
  }
  if (review.changeAddress === null) {
    if (psbt.txOutputs.length !== 1) return fail()
  } else if (
    psbt.txOutputs.length !== 2 ||
    psbt.txOutputs[1].value !== Number(review.change) ||
    !psbt.txOutputs[1].script.equals(address.toOutputScript(review.changeAddress, network))
  ) {
    return fail()
  }
  let total = 0n
  let fingerprint: Buffer | null = null
  const seen = new Set<string>()
  for (let index = 0; index < psbt.data.inputs.length; index += 1) {
    const input = psbt.data.inputs[index]
    const txInput = psbt.txInputs[index]
    const derivation = input.bip32Derivation?.[0]
    if (
      !input ||
      !txInput ||
      input.witnessUtxo !== undefined ||
      input.nonWitnessUtxo === undefined ||
      input.sighashType !== DASH_SIGHASH_ALL ||
      txInput.sequence !== DASH_FINAL_SEQUENCE ||
      input.bip32Derivation?.length !== 1 ||
      !derivation ||
      derivation.masterFingerprint.length !== 4
    ) {
      return fail()
    }
    if (fingerprint === null) fingerprint = derivation.masterFingerprint
    if (!fingerprint.equals(derivation.masterFingerprint)) return fail()
    const txid = Buffer.from(txInput.hash).reverse().toString('hex')
    const outpoint = `${txid}:${txInput.index}`
    if (seen.has(outpoint)) return fail()
    seen.add(outpoint)
    let previous: Transaction
    try {
      previous = Transaction.fromBuffer(input.nonWitnessUtxo)
    } catch {
      return fail()
    }
    const output = previous.outs[txInput.index]
    if (!output || previous.getId() !== txid) return fail()
    const payment = payments.p2pkh({ pubkey: derivation.pubkey, network })
    if (!payment.output || !output.script.equals(payment.output) || payment.address === undefined)
      return fail()
    const expectedPath = expectedPathFor(review, derivation.path)
    if (derivation.path !== expectedPath) return fail()
    total += BigInt(output.value)
  }
  if (total !== review.selectedTotal) return fail()
  const recipientOutput = psbt.data.outputs[0]
  if (!recipientOutput || Object.keys(recipientOutput).length !== 0) return fail()
  if (review.changeDerivationPath !== null) {
    const changeOutput = psbt.data.outputs[1]
    const derivation = changeOutput?.bip32Derivation?.[0]
    if (
      !changeOutput ||
      !fingerprint ||
      changeOutput.bip32Derivation?.length !== 1 ||
      !derivation ||
      !derivation.masterFingerprint.equals(fingerprint) ||
      derivation.path !== review.changeDerivationPath
    ) {
      return fail()
    }
    const payment = payments.p2pkh({ pubkey: derivation.pubkey, network })
    if (!payment.output || !psbt.txOutputs[1].script.equals(payment.output)) return fail()
  }
}

function expectedPathFor(review: ReviewBinding, path: string): string {
  if (review.imported) {
    if (path !== 'm' || review.accountIndex !== 0) return fail()
    return 'm'
  }
  const coinType = review.chainId === DASH_CHAIN_IDS.mainnet ? '5' : '1'
  const match = new RegExp(`^m/44'/${coinType}'/${review.accountIndex}'/([01])/(\\d+)$`).exec(path)
  if (!match) return fail()
  const addressIndex = Number(match[2])
  if (!Number.isSafeInteger(addressIndex) || addressIndex > 0x7fffffff) return fail()
  return expectedDashDerivationPath(
    review.chainId,
    review.accountIndex,
    match[1] === '1',
    addressIndex,
    false
  )
}

function derivationEquals(
  left: { masterFingerprint: Buffer; pubkey: Buffer; path: string } | undefined,
  right: { masterFingerprint: Buffer; pubkey: Buffer; path: string } | undefined
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.path === right.path &&
    left.masterFingerprint.equals(right.masterFingerprint) &&
    left.pubkey.equals(right.pubkey)
  )
}

/** Rejects a PSBT whose funding transaction, outpoint, value, script, or key origin differs from review. */
export function assertDashSignedPsbtMatchesPrepared(
  prepared: PreparedDashPsbt,
  signedPsbtBase64: string
): Psbt {
  const parsed = parsePreparedDashPsbt(prepared)
  const signed = parseDashPsbt(signedPsbtBase64, parsed.prepared.chainId)
  if (
    !signed.data.globalMap.unsignedTx
      .toBuffer()
      .equals(parsed.psbt.data.globalMap.unsignedTx.toBuffer())
  ) {
    return fail()
  }
  if (parsed.psbt.data.inputs.length !== signed.data.inputs.length) return fail()
  for (let index = 0; index < parsed.psbt.data.inputs.length; index += 1) {
    const expected = parsed.psbt.data.inputs[index]
    const actual = signed.data.inputs[index]
    const expectedInput = parsed.psbt.txInputs[index]
    const actualInput = signed.txInputs[index]
    if (
      !actual ||
      !actualInput ||
      !expectedInput ||
      !expected.nonWitnessUtxo ||
      !actual.nonWitnessUtxo ||
      !expected.nonWitnessUtxo.equals(actual.nonWitnessUtxo) ||
      !Buffer.from(expectedInput.hash).equals(Buffer.from(actualInput.hash)) ||
      expectedInput.index !== actualInput.index ||
      expected.sighashType !== actual.sighashType ||
      !derivationEquals(expected.bip32Derivation?.[0], actual.bip32Derivation?.[0]) ||
      actual.partialSig?.length !== 1 ||
      actual.finalScriptSig !== undefined ||
      actual.witnessUtxo !== undefined
    ) {
      return fail()
    }
    let previous: Transaction
    try {
      previous = Transaction.fromBuffer(actual.nonWitnessUtxo)
    } catch {
      return fail()
    }
    const output = previous.outs[actualInput.index]
    const reviewed = Transaction.fromBuffer(expected.nonWitnessUtxo).outs[expectedInput.index]
    if (
      !output ||
      !reviewed ||
      previous.getId() !== Buffer.from(actualInput.hash).reverse().toString('hex') ||
      output.value !== reviewed.value ||
      !output.script.equals(reviewed.script)
    ) {
      return fail()
    }
  }
  if (parsed.psbt.data.outputs.length !== signed.data.outputs.length) return fail()
  for (let index = 0; index < parsed.psbt.data.outputs.length; index += 1) {
    const expected = parsed.psbt.data.outputs[index]
    const actual = signed.data.outputs[index]
    if (
      !actual ||
      (!derivationEquals(expected.bip32Derivation?.[0], actual.bip32Derivation?.[0]) &&
        (expected.bip32Derivation !== undefined || actual.bip32Derivation !== undefined))
    ) {
      return fail()
    }
  }
  return signed
}

export async function computeDashSigningPayloadFingerprint(psbtBase64: string): Promise<string> {
  const bytes = Buffer.from(psbtBase64, 'base64')
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Buffer.from(digest).toString('hex')
}

export function createDashSigningSummary(
  prepared: PreparedDashPsbt,
  signer: string
): SigningSummary {
  const { prepared: parsed, psbt } = parsePreparedDashPsbt(prepared)
  if (parseDashRecipient(signer, parsed.chainId) !== signer) return fail()
  const network = dashBitcoinJsNetwork(parsed.chainId)
  const inputs = psbt.data.inputs.map((input, index) => {
    const txInput = psbt.txInputs[index]
    const derivation = input.bip32Derivation?.[0]
    const previous = Transaction.fromBuffer(input.nonWitnessUtxo ?? Buffer.alloc(0))
    const output = previous.outs[txInput.index]
    if (!derivation || !output) return fail()
    return Object.freeze({
      index,
      transactionId: Buffer.from(txInput.hash).reverse().toString('hex'),
      outputIndex: txInput.index,
      amountDuffs: BigInt(output.value).toString(),
      sequence: txInput.sequence,
      scriptType: 'p2pkh' as const,
      sighashType: 'SIGHASH_ALL',
      ownership: 'signing-account' as const,
      derivationPath: derivation.path
    })
  })
  const outputs = psbt.txOutputs.map((output, index) => {
    const meta = psbt.data.outputs[index]
    const derived = meta?.bip32Derivation?.[0]
    const decoded = address.fromOutputScript(output.script, network)
    return Object.freeze({
      index,
      address: decoded,
      scriptPubKeyHex: `0x${output.script.toString('hex')}`,
      amountDuffs: BigInt(output.value).toString(),
      classification:
        index === parsed.changeOutputIndex ? ('change' as const) : ('recipient' as const),
      derivationPath: derived?.path ?? null
    })
  })
  const totalOut = outputs.reduce((sum, output) => sum + BigInt(output.amountDuffs), 0n)
  return parseSigningSummary(
    {
      schema: 'dash.psbt.v1',
      chainId: parsed.chainId,
      operation: 'transaction',
      review: { level: 'standard', issues: [] },
      fields: {
        psbtVersion: 0,
        signer,
        accountIndex: parsed.accountIndex,
        inputs,
        outputs,
        signingInputIndexes: inputs.map(input => input.index),
        totalInputDuffs: parsed.selectedTotalDuffs,
        totalOutputDuffs: totalOut.toString(),
        feeDuffs: parsed.feeDuffs
      }
    },
    { family: 'dash', chainId: parsed.chainId, operation: 'transaction' }
  )
}

export function assertDashSigningSummaryMatchesPrepared(
  prepared: PreparedDashPsbt,
  summary: SigningSummary,
  signer: string
): void {
  const expected = createDashSigningSummary(prepared, signer)
  if (expected.schema !== 'dash.psbt.v1' || summary.schema !== 'dash.psbt.v1') {
    throw new Error('Dash signing summary does not match the reviewed PSBT')
  }
  if (summary.review.level === 'blocked') {
    throw new Error('Dash signing summary does not match the reviewed PSBT')
  }
  const left = expected.fields
  const right = summary.fields
  const sameInputs =
    left.inputs.length === right.inputs.length &&
    left.inputs.every((input, index) => {
      const actual = right.inputs[index]
      return (
        actual !== undefined &&
        input.transactionId === actual.transactionId &&
        input.outputIndex === actual.outputIndex &&
        input.amountDuffs === actual.amountDuffs &&
        input.sighashType === actual.sighashType &&
        input.ownership === actual.ownership &&
        input.derivationPath === actual.derivationPath &&
        input.sequence === actual.sequence
      )
    })
  const sameOutputs =
    left.outputs.length === right.outputs.length &&
    left.outputs.every((output, index) => {
      const actual = right.outputs[index]
      return (
        actual !== undefined &&
        output.address === actual.address &&
        output.amountDuffs === actual.amountDuffs &&
        output.classification === actual.classification &&
        output.derivationPath === actual.derivationPath &&
        output.scriptPubKeyHex === actual.scriptPubKeyHex
      )
    })
  if (
    left.signer !== signer ||
    right.signer !== signer ||
    left.accountIndex !== right.accountIndex ||
    left.psbtVersion !== right.psbtVersion ||
    left.feeDuffs !== right.feeDuffs ||
    left.totalInputDuffs !== right.totalInputDuffs ||
    left.totalOutputDuffs !== right.totalOutputDuffs ||
    !sameInputs ||
    !sameOutputs
  ) {
    throw new Error('Dash signing summary does not match the reviewed PSBT')
  }
}
