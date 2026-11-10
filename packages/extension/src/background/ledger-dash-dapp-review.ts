import { address, Psbt, Transaction } from 'bitcoinjs-lib'
import { Buffer } from 'buffer'
import type { ChainId } from '@/core/chains/domain'
import { parseSigningSummary, type SigningSummary } from '@/core/keyring/domain'
import type { DashPsbtSummary } from '@/core/keyring/domain/signing-summary'
import { dashBitcoinJsNetwork } from '@/infrastructure/chains/dash/dash-transaction-model'
import type { DashReviewedPayment } from '@/core/dapp/dash-provider'

function sighashName(value: number | undefined): string {
  if (value === undefined || value === 1) return 'SIGHASH_ALL'
  return `SIGHASH_${value}`
}

export async function ledgerDashPsbtSummary(input: {
  readonly chainId: ChainId
  readonly signer: string
  readonly accountIndex: number
  readonly accountPath: string
  readonly psbtBase64: string
  readonly ownsInput: (index: number) => Promise<boolean>
}): Promise<DashPsbtSummary> {
  let psbt: Psbt
  try {
    psbt = Psbt.fromBase64(input.psbtBase64)
  } catch {
    throw new Error('Dash review PSBT is invalid')
  }
  const network = dashBitcoinJsNetwork(input.chainId)
  const inputs = await Promise.all(
    psbt.txInputs.map(async (txInput, index) => {
      const psbtInput = psbt.data.inputs[index]
      let value: number | undefined
      if (psbtInput?.nonWitnessUtxo) {
        const previous = Transaction.fromBuffer(psbtInput.nonWitnessUtxo)
        if (previous.getId() !== Buffer.from(txInput.hash).reverse().toString('hex')) {
          throw new Error('Dash PSBT previous transaction mismatch')
        }
        value = previous.outs[txInput.index]?.value
      } else if (psbtInput?.witnessUtxo) {
        value = psbtInput.witnessUtxo.value
      }
      if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new Error('Dash PSBT input amount is missing')
      }
      const derivation = psbtInput?.bip32Derivation?.find(item =>
        item.path.startsWith(`${input.accountPath}/`)
      )
      const owned = await input.ownsInput(index)
      return Object.freeze({
        index,
        transactionId: Buffer.from(txInput.hash).reverse().toString('hex'),
        outputIndex: txInput.index,
        amountDuffs: String(value),
        sequence: txInput.sequence,
        scriptType: 'p2pkh' as const,
        sighashType: sighashName(psbtInput?.sighashType),
        ownership: owned ? ('signing-account' as const) : ('external' as const),
        derivationPath: owned ? (derivation?.path ?? null) : null
      })
    })
  )
  const signingInputIndexes = inputs
    .filter(item => item.ownership === 'signing-account')
    .map(item => item.index)
  if (signingInputIndexes.length === 0) {
    throw new Error('Dash PSBT has no input owned by the active account')
  }
  const outputs = psbt.txOutputs.map((output, index) => {
    const meta = psbt.data.outputs[index]
    const derived = meta?.bip32Derivation?.find(item =>
      item.path.startsWith(`${input.accountPath}/`)
    )
    let destination: string | null = null
    try {
      destination = address.fromOutputScript(output.script, network)
    } catch {
      destination = null
    }
    const change = derived?.path.startsWith(`${input.accountPath}/1/`) === true
    return Object.freeze({
      index,
      address: destination,
      scriptPubKeyHex: `0x${output.script.toString('hex')}`,
      amountDuffs: String(output.value),
      classification: change
        ? ('change' as const)
        : destination
          ? ('recipient' as const)
          : ('unknown' as const),
      derivationPath: change ? (derived?.path ?? null) : null
    })
  })
  if (outputs.some(item => item.classification === 'unknown')) {
    throw new Error('Dash PSBT has an unsupported output')
  }
  const totalInput = inputs.reduce((sum, item) => sum + BigInt(item.amountDuffs), 0n)
  const totalOutput = outputs.reduce((sum, item) => sum + BigInt(item.amountDuffs), 0n)
  if (totalOutput > totalInput) throw new Error('Dash PSBT outputs exceed inputs')
  const external = inputs.some(item => item.ownership === 'external')
  const nonDefaultSighash = inputs.some(item => item.sighashType !== 'SIGHASH_ALL')
  const issues = [
    ...(external ? [{ code: 'external-input' as const }] : []),
    ...(nonDefaultSighash ? [{ code: 'non-default-sighash' as const }] : [])
  ]
  const summary = parseSigningSummary(
    {
      schema: 'dash.psbt.v1',
      chainId: input.chainId,
      operation: 'transaction',
      review:
        issues.length === 0 ? { level: 'standard', issues: [] } : { level: 'caution', issues },
      fields: {
        psbtVersion: 0,
        signer: input.signer,
        accountIndex: input.accountIndex,
        inputs,
        outputs,
        signingInputIndexes,
        totalInputDuffs: totalInput.toString(),
        totalOutputDuffs: totalOutput.toString(),
        feeDuffs: (totalInput - totalOutput).toString()
      }
    },
    { family: 'dash', chainId: input.chainId, operation: 'transaction' }
  )
  if (summary.schema !== 'dash.psbt.v1') {
    throw new Error('Dash signer did not return a PSBT review')
  }
  return summary
}

export function dashReviewedPayment(
  summary: SigningSummary,
  payloadFingerprint: string
): DashReviewedPayment {
  if (summary.schema !== 'dash.psbt.v1') {
    throw new Error('Dash signing summary is not a PSBT review')
  }
  const recipients = summary.fields.outputs.filter(output => output.classification === 'recipient')
  if (recipients.length !== 1 || !recipients[0].address) {
    throw new Error('Dash PSBT review must contain one recipient')
  }
  return Object.freeze({
    recipient: recipients[0].address,
    amountDuffs: recipients[0].amountDuffs,
    payloadFingerprint
  })
}
