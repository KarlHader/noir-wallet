import type { SolanaReadRpc } from './solana-rpc-types'
import {
  buildSolanaNativeTransfer,
  buildSolanaTokenTransfer,
  SOLANA_TOKEN_2022_PROGRAM,
  SOLANA_TOKEN_PROGRAM
} from './solana-transaction-builder'
import type { PreparedSigningCommand } from '@/core/keyring/ports'

const MAXIMUM_U64 = 18_446_744_073_709_551_615n

export type SolanaTransferErrorCode = 'insufficient-funds'

export class SolanaTransferError extends Error {
  readonly code: SolanaTransferErrorCode

  constructor(code: SolanaTransferErrorCode, message: string) {
    super(message)
    this.name = 'SolanaTransferError'
    this.code = code
  }
}

export interface PrepareSolanaNativeTransferInput {
  readonly chainId: string
  readonly sender: string
  readonly recipient: string
  readonly lamports: string
  readonly rpc: Pick<
    SolanaReadRpc,
    | 'assertExpectedChain'
    | 'getBalanceSnapshot'
    | 'getLatestBlockhash'
    | 'getFeeForMessage'
    | 'simulateTransaction'
  >
  readonly signal?: AbortSignal
}

export interface PreparedSolanaNativeTransfer {
  readonly chainId: string
  readonly sender: string
  readonly recipient: string
  readonly lamports: string
  readonly feeLamports: string
  readonly totalDebitLamports: string
  readonly recentBlockhash: string
  readonly lastValidBlockHeight: number
  readonly transactionBase64: string
  readonly messageBase64: string
  readonly simulationUnitsConsumed: number
}

export interface PrepareSolanaTokenTransferInput {
  readonly chainId: string
  readonly assetId: string
  readonly sender: string
  readonly recipient: string
  readonly mint: string
  readonly decimals: number
  readonly amountRaw: string
  readonly rpc: Pick<
    SolanaReadRpc,
    | 'assertExpectedChain'
    | 'getBalanceSnapshot'
    | 'getTokenAccountsByMints'
    | 'getLatestBlockhash'
    | 'getFeeForMessage'
    | 'simulateTransaction'
  >
  readonly signal?: AbortSignal
}

export interface PreparedSolanaTokenTransfer {
  readonly kind: 'token'
  readonly chainId: string
  readonly assetId: string
  readonly sender: string
  readonly recipient: string
  readonly sourceTokenAccount: string
  readonly destinationTokenAccount: string
  readonly mint: string
  readonly tokenProgram: typeof SOLANA_TOKEN_PROGRAM | typeof SOLANA_TOKEN_2022_PROGRAM
  readonly decimals: number
  readonly amountRaw: string
  readonly feeLamports: string
  readonly recentBlockhash: string
  readonly lastValidBlockHeight: number
  readonly transactionBase64: string
  readonly messageBase64: string
  readonly simulationUnitsConsumed: number
}

export type PreparedSolanaTransfer = PreparedSolanaNativeTransfer | PreparedSolanaTokenTransfer

function parseU64(value: string, label: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} must be a decimal u64`)
  const parsed = BigInt(value)
  if (parsed > MAXIMUM_U64) throw new Error(`${label} exceeds u64`)
  return parsed
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`)
  }
  return value as Record<string, unknown>
}

export function parsePreparedSolanaNativeTransfer(value: unknown): PreparedSolanaNativeTransfer {
  const record = readRecord(value, 'Prepared Solana transfer')
  const keys = [
    'chainId',
    'sender',
    'recipient',
    'lamports',
    'feeLamports',
    'totalDebitLamports',
    'recentBlockhash',
    'lastValidBlockHeight',
    'transactionBase64',
    'messageBase64',
    'simulationUnitsConsumed'
  ]
  if (
    Object.keys(record).length !== keys.length ||
    !keys.every(key => Object.prototype.hasOwnProperty.call(record, key)) ||
    typeof record.chainId !== 'string' ||
    typeof record.sender !== 'string' ||
    typeof record.recipient !== 'string' ||
    typeof record.lamports !== 'string' ||
    typeof record.feeLamports !== 'string' ||
    typeof record.totalDebitLamports !== 'string' ||
    typeof record.recentBlockhash !== 'string' ||
    typeof record.transactionBase64 !== 'string' ||
    typeof record.messageBase64 !== 'string' ||
    !Number.isSafeInteger(record.lastValidBlockHeight) ||
    (record.lastValidBlockHeight as number) <= 0 ||
    !Number.isSafeInteger(record.simulationUnitsConsumed) ||
    (record.simulationUnitsConsumed as number) < 0
  ) {
    throw new Error('Invalid prepared Solana transfer')
  }
  const amount = parseU64(record.lamports, 'Solana transfer amount')
  const fee = parseU64(record.feeLamports, 'Solana transfer fee')
  const totalDebit = parseU64(record.totalDebitLamports, 'Solana transfer total debit')
  if (amount === 0n || totalDebit !== amount + fee) {
    throw new Error('Invalid prepared Solana transfer debit')
  }
  const rebuilt = buildSolanaNativeTransfer({
    chainId: record.chainId,
    sender: record.sender,
    recipient: record.recipient,
    recentBlockhash: record.recentBlockhash,
    lamports: record.lamports
  })
  if (
    record.transactionBase64 !== rebuilt.transactionBase64 ||
    record.messageBase64 !== rebuilt.messageBase64
  ) {
    throw new Error('Prepared Solana transaction bytes do not match its fields')
  }
  return Object.freeze({
    chainId: record.chainId,
    sender: record.sender,
    recipient: record.recipient,
    lamports: record.lamports,
    feeLamports: fee.toString(),
    totalDebitLamports: (amount + fee).toString(),
    recentBlockhash: record.recentBlockhash,
    lastValidBlockHeight: record.lastValidBlockHeight as number,
    transactionBase64: rebuilt.transactionBase64,
    messageBase64: rebuilt.messageBase64,
    simulationUnitsConsumed: record.simulationUnitsConsumed as number
  })
}

export function parsePreparedSolanaTokenTransfer(value: unknown): PreparedSolanaTokenTransfer {
  const record = readRecord(value, 'Prepared Solana token transfer')
  const keys = [
    'kind',
    'chainId',
    'assetId',
    'sender',
    'recipient',
    'sourceTokenAccount',
    'destinationTokenAccount',
    'mint',
    'tokenProgram',
    'decimals',
    'amountRaw',
    'feeLamports',
    'recentBlockhash',
    'lastValidBlockHeight',
    'transactionBase64',
    'messageBase64',
    'simulationUnitsConsumed'
  ]
  if (
    Object.keys(record).length !== keys.length ||
    !keys.every(key => Object.prototype.hasOwnProperty.call(record, key)) ||
    record.kind !== 'token' ||
    typeof record.chainId !== 'string' ||
    typeof record.assetId !== 'string' ||
    typeof record.sender !== 'string' ||
    typeof record.recipient !== 'string' ||
    typeof record.sourceTokenAccount !== 'string' ||
    typeof record.destinationTokenAccount !== 'string' ||
    typeof record.mint !== 'string' ||
    (record.tokenProgram !== SOLANA_TOKEN_PROGRAM &&
      record.tokenProgram !== SOLANA_TOKEN_2022_PROGRAM) ||
    !Number.isSafeInteger(record.decimals) ||
    (record.decimals as number) < 0 ||
    (record.decimals as number) > 255 ||
    typeof record.amountRaw !== 'string' ||
    typeof record.feeLamports !== 'string' ||
    typeof record.recentBlockhash !== 'string' ||
    !Number.isSafeInteger(record.lastValidBlockHeight) ||
    (record.lastValidBlockHeight as number) <= 0 ||
    typeof record.transactionBase64 !== 'string' ||
    typeof record.messageBase64 !== 'string' ||
    !Number.isSafeInteger(record.simulationUnitsConsumed) ||
    (record.simulationUnitsConsumed as number) < 0
  ) {
    throw new Error('Invalid prepared Solana token transfer')
  }
  const amount = parseU64(record.amountRaw, 'Solana token transfer amount')
  const fee = parseU64(record.feeLamports, 'Solana token transfer fee')
  if (amount === 0n) throw new Error('Invalid prepared Solana token transfer amount')
  const rebuilt = buildSolanaTokenTransfer({
    chainId: record.chainId,
    sender: record.sender,
    recipient: record.recipient,
    sourceTokenAccount: record.sourceTokenAccount,
    mint: record.mint,
    tokenProgram: record.tokenProgram,
    decimals: record.decimals as number,
    amountRaw: amount.toString(),
    recentBlockhash: record.recentBlockhash
  })
  if (
    record.assetId !== `${record.chainId}/token:${record.mint}` ||
    record.destinationTokenAccount !== rebuilt.destinationTokenAccount ||
    record.transactionBase64 !== rebuilt.transactionBase64 ||
    record.messageBase64 !== rebuilt.messageBase64
  ) {
    throw new Error('Prepared Solana token transaction bytes do not match its fields')
  }
  return Object.freeze({
    kind: 'token',
    chainId: record.chainId,
    assetId: record.assetId,
    sender: record.sender,
    recipient: record.recipient,
    sourceTokenAccount: record.sourceTokenAccount,
    destinationTokenAccount: rebuilt.destinationTokenAccount,
    mint: record.mint,
    tokenProgram: record.tokenProgram,
    decimals: record.decimals as number,
    amountRaw: amount.toString(),
    feeLamports: fee.toString(),
    recentBlockhash: record.recentBlockhash,
    lastValidBlockHeight: record.lastValidBlockHeight as number,
    transactionBase64: rebuilt.transactionBase64,
    messageBase64: rebuilt.messageBase64,
    simulationUnitsConsumed: record.simulationUnitsConsumed as number
  })
}

export function parsePreparedSolanaTransfer(value: unknown): PreparedSolanaTransfer {
  const record = readRecord(value, 'Prepared Solana transfer')
  return record.kind === 'token'
    ? parsePreparedSolanaTokenTransfer(record)
    : parsePreparedSolanaNativeTransfer(record)
}

export async function prepareSolanaNativeTransfer(
  input: PrepareSolanaNativeTransferInput
): Promise<PreparedSolanaNativeTransfer> {
  await input.rpc.assertExpectedChain(input.signal)
  const [balance, latestBlockhash] = await Promise.all([
    input.rpc.getBalanceSnapshot(input.sender, input.signal),
    input.rpc.getLatestBlockhash(input.signal)
  ])
  const built = buildSolanaNativeTransfer({
    chainId: input.chainId,
    sender: input.sender,
    recipient: input.recipient,
    recentBlockhash: latestBlockhash.blockhash,
    lamports: input.lamports
  })
  const fee = await input.rpc.getFeeForMessage(built.messageBase64, input.signal)
  const amountLamports = parseU64(built.lamports, 'Solana transfer amount')
  const feeLamports = parseU64(fee.feeLamports, 'Solana transfer fee')
  const balanceLamports = parseU64(balance.amountRaw, 'Solana account balance')
  const totalDebitLamports = amountLamports + feeLamports
  if (totalDebitLamports > balanceLamports) {
    throw new SolanaTransferError(
      'insufficient-funds',
      'Solana balance cannot cover the transfer amount and fee'
    )
  }
  const simulation = await input.rpc.simulateTransaction(built.transactionBase64, input.signal)
  return Object.freeze({
    chainId: input.chainId,
    sender: built.sender,
    recipient: built.recipient,
    lamports: built.lamports,
    feeLamports: feeLamports.toString(),
    totalDebitLamports: totalDebitLamports.toString(),
    recentBlockhash: built.recentBlockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    transactionBase64: built.transactionBase64,
    messageBase64: built.messageBase64,
    simulationUnitsConsumed: simulation.unitsConsumed
  })
}

export async function prepareSolanaTokenTransfer(
  input: PrepareSolanaTokenTransferInput
): Promise<PreparedSolanaTokenTransfer> {
  await input.rpc.assertExpectedChain(input.signal)
  const [nativeBalance, tokenAccounts, latestBlockhash] = await Promise.all([
    input.rpc.getBalanceSnapshot(input.sender, input.signal),
    input.rpc.getTokenAccountsByMints(input.sender, [input.mint], input.signal),
    input.rpc.getLatestBlockhash(input.signal)
  ])
  const amount = parseU64(input.amountRaw, 'Solana token transfer amount')
  if (amount === 0n) throw new Error('Solana token transfer amount must be positive')
  const candidates = tokenAccounts.accounts
    .filter(
      account =>
        account.mint === input.mint &&
        account.decimals === input.decimals &&
        BigInt(account.amountRaw) >= amount
    )
    .sort((left, right) => left.accountAddress.localeCompare(right.accountAddress))
  const source = candidates[0]
  if (!source) {
    throw new SolanaTransferError(
      'insufficient-funds',
      'No Solana token account can cover the transfer amount'
    )
  }
  const built = buildSolanaTokenTransfer({
    chainId: input.chainId,
    sender: input.sender,
    recipient: input.recipient,
    sourceTokenAccount: source.accountAddress,
    mint: input.mint,
    tokenProgram: source.program === 'legacy' ? SOLANA_TOKEN_PROGRAM : SOLANA_TOKEN_2022_PROGRAM,
    decimals: input.decimals,
    amountRaw: amount.toString(),
    recentBlockhash: latestBlockhash.blockhash
  })
  const fee = await input.rpc.getFeeForMessage(built.messageBase64, input.signal)
  const feeLamports = parseU64(fee.feeLamports, 'Solana token transfer fee')
  if (feeLamports > parseU64(nativeBalance.amountRaw, 'Solana account balance')) {
    throw new SolanaTransferError(
      'insufficient-funds',
      'Solana balance cannot cover the token transfer fee'
    )
  }
  const simulation = await input.rpc.simulateTransaction(built.transactionBase64, input.signal)
  return Object.freeze({
    kind: 'token',
    chainId: input.chainId,
    assetId: input.assetId,
    sender: built.sender,
    recipient: built.recipient,
    sourceTokenAccount: built.sourceTokenAccount,
    destinationTokenAccount: built.destinationTokenAccount,
    mint: built.mint,
    tokenProgram: built.tokenProgram,
    decimals: built.decimals,
    amountRaw: built.amountRaw,
    feeLamports: feeLamports.toString(),
    recentBlockhash: built.recentBlockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    transactionBase64: built.transactionBase64,
    messageBase64: built.messageBase64,
    simulationUnitsConsumed: simulation.unitsConsumed
  })
}

export async function computeSolanaTransactionFingerprint(
  transactionBase64: string
): Promise<string> {
  const binary = atob(transactionBase64)
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function assertSolanaTransferSigningMatchesPrepared(
  prepared: PreparedSolanaTransfer,
  signing: PreparedSigningCommand
): Promise<void> {
  if (
    signing.chainId !== prepared.chainId ||
    signing.operation !== 'transaction' ||
    (signing.execution.kind === 'external' &&
      (signing.execution.request.encoding !== 'base64' ||
        signing.execution.request.value !== prepared.transactionBase64)) ||
    signing.summary.schema !== 'solana.transaction.v1' ||
    signing.summary.review.level !== 'standard' ||
    signing.summary.review.issues.length !== 0 ||
    signing.payloadFingerprint.digestHex !==
      (await computeSolanaTransactionFingerprint(prepared.transactionBase64))
  ) {
    throw new Error('Solana signing command does not match the prepared transfer')
  }
  const fields = signing.summary.fields
  if (
    fields.messageVersion !== 'legacy' ||
    fields.feePayer !== prepared.sender ||
    fields.recentBlockhash !== prepared.recentBlockhash ||
    fields.requiredSigners.length !== 1 ||
    fields.requiredSigners[0] !== prepared.sender ||
    fields.addressTableLookups.length !== 0
  ) {
    throw new Error('Solana signing summary does not match the prepared transfer')
  }
  if ('kind' in prepared) {
    const associated = fields.instructions[0]?.interpretation
    const transfer = fields.instructions[1]?.interpretation
    if (
      fields.instructions.length !== 2 ||
      associated?.kind !== 'associated-token-create-idempotent' ||
      associated.payer !== prepared.sender ||
      associated.owner !== prepared.recipient ||
      associated.associatedAccount !== prepared.destinationTokenAccount ||
      associated.mint !== prepared.mint ||
      associated.tokenProgram !== prepared.tokenProgram ||
      transfer?.kind !== 'spl-token-transfer' ||
      transfer.source !== prepared.sourceTokenAccount ||
      transfer.destination !== prepared.destinationTokenAccount ||
      transfer.authority !== prepared.sender ||
      transfer.mint !== prepared.mint ||
      transfer.decimals !== prepared.decimals ||
      transfer.amountRaw !== prepared.amountRaw
    ) {
      throw new Error('Solana signing summary does not match the prepared token transfer')
    }
    return
  }
  const instruction = fields.instructions[0]?.interpretation
  if (
    fields.instructions.length !== 1 ||
    instruction?.kind !== 'system-transfer' ||
    instruction.from !== prepared.sender ||
    instruction.to !== prepared.recipient ||
    instruction.lamports !== prepared.lamports
  ) {
    throw new Error('Solana signing summary does not match the prepared native transfer')
  }
}
