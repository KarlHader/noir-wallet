import { address, networks, Psbt, Transaction } from 'bitcoinjs-lib'
import { Buffer } from 'buffer'
import type { ChainId } from '@/core/chains/domain'
import { parseSigningSummary, type SigningSummary } from '@/core/keyring/domain'
import { digestLedgerPayload } from './ledger-evm-dapp-review'

export async function ledgerBitcoinMessageSummary(
  chainId: ChainId,
  signer: string,
  message: string
): Promise<SigningSummary> {
  const bytes = new TextEncoder().encode(message)
  return parseSigningSummary(
    {
      schema: 'bitcoin.bip322-message.v1',
      chainId,
      operation: 'message',
      review: { level: 'standard', issues: [] },
      fields: {
        address: signer,
        message: {
          encoding: 'utf8',
          value: message,
          byteLength: bytes.length,
          sha256: await digestLedgerPayload(bytes)
        }
      }
    },
    { family: 'bitcoin', chainId, operation: 'message' }
  )
}

export async function ledgerBitcoinPsbtSummary(input: {
  readonly chainId: ChainId
  readonly network: 'mainnet' | 'testnet'
  readonly signer: string
  readonly psbt: Psbt
  readonly ownsInput: (index: number) => Promise<boolean>
}): Promise<SigningSummary> {
  const network = input.network === 'mainnet' ? networks.bitcoin : networks.testnet
  const inputs = await Promise.all(
    input.psbt.txInputs.map(async (txInput, index) => {
      const psbtInput = input.psbt.data.inputs[index]
      let utxo = psbtInput.witnessUtxo
      if (psbtInput.nonWitnessUtxo) {
        const previous = Transaction.fromBuffer(psbtInput.nonWitnessUtxo)
        if (previous.getId() !== Buffer.from(txInput.hash).reverse().toString('hex'))
          throw new Error('Bitcoin PSBT previous transaction mismatch')
        const output = previous.outs[txInput.index]
        if (!output) throw new Error('Bitcoin PSBT previous output is missing')
        if (utxo && (utxo.value !== output.value || !utxo.script.equals(output.script)))
          throw new Error('Bitcoin PSBT UTXO mismatch')
        utxo = output
      }
      if (!utxo || utxo.script.length !== 22 || utxo.script[0] !== 0 || utxo.script[1] !== 20) {
        throw new Error('Ledger dApp PSBT requires Native SegWit inputs')
      }
      if (psbtInput.sighashType !== undefined && psbtInput.sighashType !== 1) {
        throw new Error('Ledger dApp PSBT requires SIGHASH_ALL')
      }
      return Object.freeze({
        index,
        transactionId: Buffer.from(txInput.hash).reverse().toString('hex'),
        outputIndex: txInput.index,
        amountSats: utxo.value.toString(),
        sequence: txInput.sequence,
        scriptType: 'p2wpkh' as const,
        sighashType: 'SIGHASH_ALL',
        ownership: (await input.ownsInput(index))
          ? ('signing-account' as const)
          : ('external' as const)
      })
    })
  )
  const signingInputIndexes = inputs
    .filter(item => item.ownership === 'signing-account')
    .map(item => item.index)
  if (signingInputIndexes.length === 0)
    throw new Error('Bitcoin PSBT has no input owned by the Ledger account')
  const outputs = input.psbt.txOutputs.map((output, index) => {
    let destination: string
    try {
      destination = address.fromOutputScript(output.script, network)
    } catch {
      throw new Error('Ledger dApp PSBT has an unsupported output script')
    }
    return Object.freeze({
      index,
      address: destination,
      scriptPubKeyHex: `0x${output.script.toString('hex')}`,
      amountSats: output.value.toString(),
      classification: 'recipient' as const
    })
  })
  const totalInput = inputs.reduce((sum, item) => sum + BigInt(item.amountSats), 0n)
  const totalOutput = outputs.reduce((sum, item) => sum + BigInt(item.amountSats), 0n)
  if (totalOutput > totalInput) throw new Error('Bitcoin PSBT outputs exceed inputs')
  const external = inputs.some(item => item.ownership === 'external')
  return parseSigningSummary(
    {
      schema: 'bitcoin.psbt.v1',
      chainId: input.chainId,
      operation: 'transaction',
      review: external
        ? { level: 'caution', issues: [{ code: 'external-input' }] }
        : { level: 'standard', issues: [] },
      fields: {
        psbtVersion: 0,
        signer: input.signer,
        inputs,
        outputs,
        signingInputIndexes,
        totalInputSats: totalInput.toString(),
        totalOutputSats: totalOutput.toString(),
        feeSats: (totalInput - totalOutput).toString()
      }
    },
    { family: 'bitcoin', chainId: input.chainId, operation: 'transaction' }
  )
}
