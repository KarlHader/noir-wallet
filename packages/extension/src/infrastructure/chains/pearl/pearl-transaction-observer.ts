import type { PearlDiscoveryRpc, PearlTransactionRpc } from './pearl-blockbook-client'
import { PearlRpcError } from './pearl-blockbook-client'

export type PearlMonitorRpc = Pick<PearlDiscoveryRpc, 'getTipHeight'> &
  Pick<PearlTransactionRpc, 'broadcastRawTransaction' | 'getTransactionStatus'>

export type PearlTransactionObservation =
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

export interface BroadcastSignedPearlTransactionInput {
  readonly rawTransactionHex: string
  readonly expectedTransactionId: string
  readonly rpc: Pick<PearlTransactionRpc, 'broadcastRawTransaction'>
  readonly signal?: AbortSignal
}

const MAXIMUM_FINALITY_CONFIRMATIONS = 2_016

function parseTransactionId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error('Invalid Pearl transaction ID')
  }
  return value
}

export function parsePearlFinalityConfirmations(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) <= 0 ||
    (value as number) > MAXIMUM_FINALITY_CONFIRMATIONS
  ) {
    throw new Error('Invalid Pearl finality confirmation count')
  }
  return value as number
}

export async function broadcastSignedPearlTransaction(
  input: BroadcastSignedPearlTransactionInput
): Promise<string> {
  const expected = parseTransactionId(input.expectedTransactionId)
  const broadcast = parseTransactionId(
    await input.rpc.broadcastRawTransaction(input.rawTransactionHex, input.signal)
  )
  if (broadcast !== expected) {
    throw new PearlRpcError('invalid-response', 'Pearl RPC returned a different transaction ID')
  }
  return broadcast
}

export async function observePearlTransaction(
  transactionIdValue: string,
  requiredConfirmationsValue: number,
  rpc: Pick<PearlMonitorRpc, 'getTipHeight' | 'getTransactionStatus'>,
  signal?: AbortSignal
): Promise<PearlTransactionObservation> {
  const transactionId = parseTransactionId(transactionIdValue)
  const requiredConfirmations = parsePearlFinalityConfirmations(requiredConfirmationsValue)
  const status = await rpc.getTransactionStatus(transactionId, signal)
  if (!status.confirmed) {
    return Object.freeze({ status: 'broadcast', transactionId, requiredConfirmations })
  }
  const blockHeight = status.blockHeight
  const blockHash = status.blockHash
  if (blockHeight === undefined || blockHash === undefined) {
    throw new PearlRpcError('invalid-response', 'Pearl confirmation is missing block data')
  }
  const tipHeight = await rpc.getTipHeight(signal)
  if (!Number.isSafeInteger(tipHeight) || tipHeight < blockHeight) {
    throw new PearlRpcError('invalid-response', 'Pearl tip is behind the transaction block')
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
