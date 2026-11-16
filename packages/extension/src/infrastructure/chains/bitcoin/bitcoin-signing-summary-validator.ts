import * as secp256k1 from '@bitcoinerlab/secp256k1'
import type { BitcoinPsbtSummary, SigningSummary } from '@/core/keyring/domain'
import { address, initEccLib, networks, Transaction } from 'bitcoinjs-lib'
import { Buffer } from 'buffer'
import { base64ToBytes } from '@/lib/bytes'
import { parsePreparedBitcoinPsbt } from './bitcoin-prepared-psbt-validator'
import {
  BITCOIN_MAINNET_CHAIN_ID,
  parseBitcoinAddress,
  type PreparedBitcoinPsbt
} from './bitcoin-transaction-model'

let eccInitialized = false

export interface BitcoinSigningPreparePayload {
  readonly kind: 'bitcoin-psbt'
  readonly chainId: PreparedBitcoinPsbt['chainId']
  readonly addressType: PreparedBitcoinPsbt['addressType']
  readonly accountIndex: number
  readonly psbt: string
}

export const KEYSTONE_BITCOIN_SIGNING_TTL_MS = 10 * 60 * 1_000

function ensureBitcoinEcc(): void {
  if (eccInitialized) return
  initEccLib(secp256k1)
  eccInitialized = true
}

function bitcoinNetwork(chainId: PreparedBitcoinPsbt['chainId']) {
  return chainId === BITCOIN_MAINNET_CHAIN_ID ? networks.bitcoin : networks.testnet
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function createBitcoinSigningPreparePayload(
  preparedValue: PreparedBitcoinPsbt
): BitcoinSigningPreparePayload {
  const { prepared } = parsePreparedBitcoinPsbt(preparedValue)
  return Object.freeze({
    kind: 'bitcoin-psbt',
    chainId: prepared.chainId,
    addressType: prepared.addressType,
    accountIndex: prepared.accountIndex,
    psbt: prepared.psbtBase64
  })
}

export async function computeBitcoinSigningPayloadFingerprint(
  preparedValue: PreparedBitcoinPsbt
): Promise<string> {
  const { prepared } = parsePreparedBitcoinPsbt(preparedValue)
  const decoded = base64ToBytes(prepared.psbtBase64)
  const bytes = new Uint8Array(new ArrayBuffer(decoded.byteLength))
  bytes.set(decoded)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export function assertBitcoinSigningSummaryMatchesPrepared(
  preparedValue: PreparedBitcoinPsbt,
  summary: SigningSummary,
  signerValue: string
): void {
  normalizeBitcoinSigningSummary(preparedValue, summary, signerValue)
}

export function normalizeBitcoinSigningSummary(
  preparedValue: PreparedBitcoinPsbt,
  summary: SigningSummary,
  signerValue: string
): BitcoinPsbtSummary {
  const expected = createBitcoinSigningSummary(preparedValue, signerValue)
  if (sameJson(summary, expected)) return expected

  const { prepared } = parsePreparedBitcoinPsbt(preparedValue)
  const signer = parseBitcoinAddress(signerValue, prepared.chainId, prepared.addressType)
  if (
    summary.schema === 'bitcoin.psbt.v1' &&
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
  throw new Error('Bitcoin signing summary does not match the prepared PSBT')
}

export function createBitcoinSigningSummary(
  preparedValue: PreparedBitcoinPsbt,
  signerValue: string
): BitcoinPsbtSummary {
  ensureBitcoinEcc()
  const { prepared, psbt } = parsePreparedBitcoinPsbt(preparedValue)
  const signer = parseBitcoinAddress(signerValue, prepared.chainId, prepared.addressType)
  const expectedInputs: BitcoinPsbtSummary['fields']['inputs'] = Object.freeze(
    psbt.txInputs.map((input, index) => {
      const psbtInput = psbt.data.inputs[index]
      let spendValue: number | undefined = psbtInput?.witnessUtxo?.value
      if (spendValue === undefined && psbtInput?.nonWitnessUtxo) {
        const previous = Transaction.fromBuffer(psbtInput.nonWitnessUtxo)
        if (previous.getId() !== Buffer.from(input.hash).reverse().toString('hex')) {
          throw new Error('Bitcoin signing summary does not match the prepared PSBT')
        }
        spendValue = previous.outs[input.index]?.value
      }
      if (spendValue === undefined || input.sequence === undefined) {
        throw new Error('Bitcoin signing summary does not match the prepared PSBT')
      }
      return Object.freeze({
        index,
        transactionId: Buffer.from(input.hash).reverse().toString('hex'),
        outputIndex: input.index,
        amountSats: spendValue.toString(),
        sequence: input.sequence,
        scriptType: prepared.addressType,
        sighashType: prepared.addressType === 'p2tr' ? 'SIGHASH_DEFAULT' : 'SIGHASH_ALL',
        ownership: 'signing-account' as const
      })
    })
  )
  const network = bitcoinNetwork(prepared.chainId)
  const expectedOutputs: BitcoinPsbtSummary['fields']['outputs'] = Object.freeze(
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
  const expectedFields: BitcoinPsbtSummary['fields'] = Object.freeze({
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
    throw new Error('Bitcoin signing summary does not match the prepared PSBT')
  }
  return Object.freeze({
    schema: 'bitcoin.psbt.v1',
    chainId: prepared.chainId,
    operation: 'transaction',
    review: Object.freeze({ level: 'standard', issues: Object.freeze([]) }),
    fields: expectedFields
  })
}
