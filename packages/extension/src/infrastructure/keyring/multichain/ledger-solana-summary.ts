import { PublicKey, VersionedTransaction } from '@solana/web3.js'
import type { ChainId } from '@/core/chains/domain'
import {
  parseSigningSummary,
  type SigningReviewIssue,
  type SolanaTransactionSummary
} from '@/core/keyring/domain'
import { parseCanonicalBase64 } from '@/infrastructure/chains/solana/solana-rpc-codecs'
import { parseSolanaTransactionEnvelope } from '@/infrastructure/chains/solana/solana-transaction-codec'
import { canonicalContent } from './signing-adapter-common'
import {
  interpretSolanaInstruction,
  type SolanaTransactionReviewContext
} from './signing-adapter-solana'

export async function buildLedgerSolanaSummary(
  chainId: ChainId,
  transactionBase64: string,
  signer: string,
  context?: SolanaTransactionReviewContext
): Promise<SolanaTransactionSummary> {
  const envelope = parseSolanaTransactionEnvelope(transactionBase64)
  if (context && context.messageBase64 !== envelope.messageBase64) {
    throw new Error('Solana review context is bound to a different message')
  }
  const bytes = parseCanonicalBase64(transactionBase64, 1_232, 'Solana transaction')
  const transaction = VersionedTransaction.deserialize(bytes)
  const message = transaction.message
  if (
    (message.version === 0 ? 'v0' : message.version) !== envelope.messageVersion ||
    transaction.signatures.length !== message.header.numRequiredSignatures
  ) {
    throw new Error('Solana transaction signature layout is invalid')
  }
  const staticKeys = message.staticAccountKeys.map(key => key.toBase58())
  const requiredSigners = staticKeys.slice(0, message.header.numRequiredSignatures)
  if (!requiredSigners.includes(signer)) {
    throw new Error('Solana transaction does not require the registered Ledger key')
  }
  const loadedWritable: PublicKey[] = []
  const loadedReadonly: PublicKey[] = []
  const lookups = message.addressTableLookups.map((lookup, index) => {
    const expected = envelope.addressTableLookups[index]
    const table = context?.lookupTables[index]
    if (
      !expected ||
      expected.accountKey !== lookup.accountKey.toBase58() ||
      expected.writableIndexes.join(',') !== [...lookup.writableIndexes].join(',') ||
      expected.readonlyIndexes.join(',') !== [...lookup.readonlyIndexes].join(',') ||
      !table ||
      table.accountKey !== expected.accountKey
    ) {
      throw new Error('Solana address lookup table cannot be verified')
    }
    const resolve = (keyIndex: number) => {
      const address = table.addresses[keyIndex]
      if (!address) throw new Error('Solana address lookup index is missing')
      return new PublicKey(address)
    }
    const writable = [...lookup.writableIndexes].map(resolve)
    const readonly = [...lookup.readonlyIndexes].map(resolve)
    loadedWritable.push(...writable)
    loadedReadonly.push(...readonly)
    return Object.freeze({
      accountKey: table.accountKey,
      writableAddresses: Object.freeze(writable.map(key => key.toBase58())),
      readonlyAddresses: Object.freeze(readonly.map(key => key.toBase58()))
    })
  })
  if (
    lookups.length !== envelope.addressTableLookups.length ||
    (context && context.lookupTables.length !== lookups.length)
  ) {
    throw new Error('Solana address lookup context does not match the transaction')
  }
  const keys =
    message.version === 0
      ? message.getAccountKeys({
          accountKeysFromLookups: { writable: loadedWritable, readonly: loadedReadonly }
        })
      : message.getAccountKeys()
  const instructions = await Promise.all(
    message.compiledInstructions.map(async (instruction, index) => {
      const programId = keys.get(instruction.programIdIndex)?.toBase58()
      if (!programId) throw new Error('Solana instruction program is unresolved')
      const accounts = [...instruction.accountKeyIndexes].map(accountIndex => {
        const address = keys.get(accountIndex)?.toBase58()
        if (!address) throw new Error('Solana instruction account is unresolved')
        return Object.freeze({
          address,
          signer: message.isAccountSigner(accountIndex),
          writable: message.isAccountWritable(accountIndex),
          source: accountIndex < staticKeys.length ? ('static' as const) : ('lookup' as const)
        })
      })
      const dataBytes = new Uint8Array(instruction.data)
      return Object.freeze({
        index,
        programId,
        accounts: Object.freeze(accounts),
        data: await canonicalContent(dataBytes, 'base64'),
        interpretation: interpretSolanaInstruction(programId, accounts, dataBytes)
      })
    })
  )
  const issues: SigningReviewIssue[] = instructions.flatMap(instruction =>
    instruction.interpretation.kind === 'unrecognized'
      ? [{ code: 'unrecognized-instruction' as const, subjectIndex: instruction.index }]
      : []
  )
  if (context?.simulationStatus === 'failed')
    issues.push({ code: 'simulation-failed', subjectIndex: 0 })
  const units = instructions.flatMap(instruction =>
    instruction.interpretation.kind === 'compute-unit-limit' ||
    instruction.interpretation.kind === 'compute-request-units-deprecated'
      ? [instruction.interpretation]
      : []
  )
  const prices = instructions.flatMap(instruction =>
    instruction.interpretation.kind === 'compute-unit-price' ? [instruction.interpretation] : []
  )
  if (units.length > 1 || prices.length > 1) {
    throw new Error('Solana transaction contains duplicate compute budget instructions')
  }
  const unitLimit = units[0]
  const unitPrice = prices[0]
  const computeUnitLimit = unitLimit?.units ?? null
  const computeUnitPriceMicroLamports = unitPrice?.microLamports ?? null
  const maximumPriorityFeeLamports =
    unitLimit?.kind === 'compute-request-units-deprecated'
      ? unitLimit.additionalFeeLamports
      : computeUnitLimit !== null && computeUnitPriceMicroLamports !== null
        ? (
            (BigInt(computeUnitLimit) * BigInt(computeUnitPriceMicroLamports) + 999_999n) /
            1_000_000n
          ).toString()
        : null
  const summary = {
    schema: 'solana.transaction.v1' as const,
    chainId,
    operation: 'transaction' as const,
    review: {
      level: issues.length === 0 ? ('standard' as const) : ('caution' as const),
      issues
    },
    fields: {
      messageVersion: envelope.messageVersion,
      feePayer: staticKeys[0],
      recentBlockhash: message.recentBlockhash,
      requiredSigners,
      staticAccountKeys: staticKeys,
      addressTableLookups: lookups,
      feeLamports: context?.feeLamports ?? null,
      computeUnitLimit,
      computeUnitPriceMicroLamports,
      maximumPriorityFeeLamports,
      simulationStatus: context?.simulationStatus ?? 'not-run',
      simulationUnitsConsumed: context?.simulationUnitsConsumed ?? null,
      instructions
    }
  }
  return parseSigningSummary(summary, {
    family: 'solana',
    chainId,
    operation: 'transaction'
  }) as SolanaTransactionSummary
}
