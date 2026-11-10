import * as secp256k1 from '@bitcoinerlab/secp256k1'
import type { PearlPsbtSummary, SigningSummary } from '@/core/keyring/domain'
import { address, initEccLib, Transaction } from 'bitcoinjs-lib'
import { pearlBitcoinJsNetwork } from './pearl-network'
import { Buffer } from 'buffer'
import { base64ToBytes } from '@/lib/bytes'
import { parsePreparedPearlPsbt } from './pearl-prepared-psbt-validator'
import { parsePearlAddress, type PreparedPearlPsbt } from './pearl-transaction-model'

let eccInitialized = false

export interface PearlSigningPreparePayload {
  readonly kind: 'pearl-psbt'
  readonly chainId: PreparedPearlPsbt['chainId']
  readonly accountIndex: number
  readonly psbt: string
}

export const KEYSTONE_PEARL_SIGNING_TTL_MS = 10 * 60 * 1_000

function ensurePearlEcc(): void {
  if (eccInitialized) return
  initEccLib(secp256k1)
  eccInitialized = true
}

function pearlNetwork(chainId: PreparedPearlPsbt['chainId']) {
  return pearlBitcoinJsNetwork(chainId)
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function createPearlSigningPreparePayload(
  preparedValue: PreparedPearlPsbt
): PearlSigningPreparePayload {
  const { prepared } = parsePreparedPearlPsbt(preparedValue)
  // Worker signing.prepare rejects unknown fields; Pearl has a single P2TR scheme.
  return Object.freeze({
    kind: 'pearl-psbt',
    chainId: prepared.chainId,
    accountIndex: prepared.accountIndex,
    psbt: prepared.psbtBase64
  })
}

export async function computePearlSigningPayloadFingerprint(
  preparedValue: PreparedPearlPsbt
): Promise<string> {
  const { prepared } = parsePreparedPearlPsbt(preparedValue)
  const decoded = base64ToBytes(prepared.psbtBase64)
  const bytes = new Uint8Array(new ArrayBuffer(decoded.byteLength))
  bytes.set(decoded)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export function assertPearlSigningSummaryMatchesPrepared(
  preparedValue: PreparedPearlPsbt,
  summary: SigningSummary,
  signerValue: string
): void {
  normalizePearlSigningSummary(preparedValue, summary, signerValue)
}

export function normalizePearlSigningSummary(
  preparedValue: PreparedPearlPsbt,
  summary: SigningSummary,
  signerValue: string
): PearlPsbtSummary {
  const expected = createPearlSigningSummary(preparedValue, signerValue)
  if (sameJson(summary, expected)) return expected

  const { prepared } = parsePreparedPearlPsbt(preparedValue)
  const signer = parsePearlAddress(signerValue, prepared.chainId)
  if (
    summary.schema === 'pearl.psbt.v1' &&
    prepared.changeAddress === signer &&
    prepared.changeOutputIndex !== null
  ) {
    const normalized = Object.freeze({
      ...summary,
      fields: Object.freeze({
        ...summary.fields,
        outputs: Object.freeze(
          summary.fields.outputs.map(output =>
            output.index === prepared.changeOutputIndex && output.classification === 'recipient'
              ? Object.freeze({ ...output, classification: 'change' as const })
              : output
          )
        )
      })
    })
    if (sameJson(normalized, expected)) return expected
  }
  throw new Error('Pearl signing summary does not match the prepared PSBT')
}

export function createPearlSigningSummary(
  preparedValue: PreparedPearlPsbt,
  signerValue: string
): PearlPsbtSummary {
  ensurePearlEcc()
  const { prepared, psbt } = parsePreparedPearlPsbt(preparedValue)
  const signer = parsePearlAddress(signerValue, prepared.chainId)
  const expectedInputs: PearlPsbtSummary['fields']['inputs'] = Object.freeze(
    psbt.txInputs.map((input, index) => {
      const psbtInput = psbt.data.inputs[index]
      let spendValue: number | undefined = psbtInput?.witnessUtxo?.value
      if (spendValue === undefined && psbtInput?.nonWitnessUtxo) {
        const previous = Transaction.fromBuffer(psbtInput.nonWitnessUtxo)
        if (previous.getId() !== Buffer.from(input.hash).reverse().toString('hex')) {
          throw new Error('Pearl signing summary does not match the prepared PSBT')
        }
        spendValue = previous.outs[input.index]?.value
      }
      if (spendValue === undefined || input.sequence === undefined) {
        throw new Error('Pearl signing summary does not match the prepared PSBT')
      }
      return Object.freeze({
        index,
        transactionId: Buffer.from(input.hash).reverse().toString('hex'),
        outputIndex: input.index,
        amountSats: spendValue.toString(),
        sequence: input.sequence,
        scriptType: 'p2tr',
        sighashType: prepared.addressScheme === 'pearl_p2tr' ? 'SIGHASH_DEFAULT' : 'SIGHASH_ALL',
        ownership: 'signing-account' as const
      })
    })
  )
  const network = pearlNetwork(prepared.chainId)
  const expectedOutputs: PearlPsbtSummary['fields']['outputs'] = Object.freeze(
    psbt.txOutputs.map((output, index) =>
      Object.freeze({
        index,
        address: address.fromOutputScript(output.script, network),
        scriptPubKeyHex: `0x${output.script.toString('hex')}`,
        amountSats: output.value.toString(),
        classification:
          index === prepared.recipientOutputIndex
            ? ('recipient' as const)
            : index === prepared.changeOutputIndex
              ? ('change' as const)
              : ('unknown' as const)
      })
    )
  )
  const expectedSigningInputIndexes = Object.freeze(expectedInputs.map(input => input.index))
  const expectedFields: PearlPsbtSummary['fields'] = Object.freeze({
    psbtVersion: 0,
    signer,
    inputs: expectedInputs,
    outputs: expectedOutputs,
    signingInputIndexes: expectedSigningInputIndexes,
    totalInputSats: prepared.selectedTotalSats,
    totalOutputSats: (BigInt(prepared.amountSats) + BigInt(prepared.changeSats)).toString(),
    feeSats: prepared.feeSats
  })
  if (expectedOutputs.some(output => output.classification === 'unknown')) {
    throw new Error('Pearl signing summary does not match the prepared PSBT')
  }
  return Object.freeze({
    schema: 'pearl.psbt.v1',
    chainId: prepared.chainId,
    operation: 'transaction',
    review: Object.freeze({ level: 'standard', issues: Object.freeze([]) }),
    fields: expectedFields
  })
}
