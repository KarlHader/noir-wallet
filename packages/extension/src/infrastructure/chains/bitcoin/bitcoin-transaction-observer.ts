import type { BitcoinDiscoveryRpc, BitcoinTransactionRpc } from './bitcoin-esplora-client'
import { BitcoinRpcError } from './bitcoin-esplora-client'

export type BitcoinMonitorRpc = Pick<BitcoinDiscoveryRpc, 'getTipHeight'> &
  Pick<
    BitcoinTransactionRpc,
    'broadcastRawTransaction' | 'getTransactionStatus' | 'getOutputSpendStatus'
  >

export type BitcoinTransactionObservation =
  | {
      readonly status: 'broadcast'
      readonly transactionId: string
      readonly requiredConfirmations: number
    }
  | {
      readonly status: 'confirming' | 'final'
      readonly transactionId: string
      readonly blockHash: string
      readonly blockHeight: number
      readonly confirmations: number
      readonly requiredConfirmations: number
    }

export interface BroadcastSignedBitcoinTransactionInput {
  readonly rawTransactionHex: string
  readonly expectedTransactionId: string
  readonly rpc: Pick<BitcoinTransactionRpc, 'broadcastRawTransaction'>
  readonly signal?: AbortSignal
}

const MAXIMUM_FINALITY_CONFIRMATIONS = 2_016

function parseTransactionId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error('Invalid Bitcoin transaction ID')
  }
  return value
}

export function parseBitcoinFinalityConfirmations(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) <= 0 ||
    (value as number) > MAXIMUM_FINALITY_CONFIRMATIONS
  ) {
    throw new Error('Invalid Bitcoin finality confirmation count')
  }
  return value as number
}

export async function broadcastSignedBitcoinTransaction(
  input: BroadcastSignedBitcoinTransactionInput
): Promise<string> {
  const expected = parseTransactionId(input.expectedTransactionId)
  const broadcast = parseTransactionId(
    await input.rpc.broadcastRawTransaction(input.rawTransactionHex, input.signal)
  )
  if (broadcast !== expected) {
    throw new BitcoinRpcError('invalid-response', 'Bitcoin RPC returned a different transaction ID')
  }
  return broadcast
}

export async function observeBitcoinTransaction(
  transactionIdValue: string,
  requiredConfirmationsValue: number,
  rpc: Pick<BitcoinMonitorRpc, 'getTipHeight' | 'getTransactionStatus'>,
  signal?: AbortSignal
): Promise<BitcoinTransactionObservation> {
  const transactionId = parseTransactionId(transactionIdValue)
  const requiredConfirmations = parseBitcoinFinalityConfirmations(requiredConfirmationsValue)
  const status = await rpc.getTransactionStatus(transactionId, signal)
  if (!status.confirmed) {
    return Object.freeze({ status: 'broadcast', transactionId, requiredConfirmations })
  }
  const blockHeight = status.blockHeight
  const blockHash = status.blockHash
  if (blockHeight === undefined || blockHash === undefined) {
    throw new BitcoinRpcError('invalid-response', 'Bitcoin confirmation is missing block data')
  }
  const tipHeight = await rpc.getTipHeight(signal)
  if (!Number.isSafeInteger(tipHeight) || tipHeight < blockHeight) {
    throw new BitcoinRpcError('invalid-response', 'Bitcoin tip is behind the transaction block')
  }
  const confirmations = tipHeight - blockHeight + 1
  return Object.freeze({
    status: confirmations >= requiredConfirmations ? 'final' : 'confirming',
    transactionId,
    blockHash,
    blockHeight,
    confirmations,
    requiredConfirmations
  })
}
