import type { SigningResult } from '@/core/keyring/ports'

import { assertStarknetExecutionTransaction } from './starknet-primitives'
import type { StarknetBroadcastRpc } from './starknet-rpc-types'

export function normalizeStarknetSessionPreparePayload(
  payload: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  if (payload.kind !== 'starknet-typed-data' || typeof payload.typedData === 'string')
    return payload
  const typedData = payload.typedData
  if (typeof typedData !== 'object' || typedData === null || Array.isArray(typedData)) {
    throw new Error('Starknet typed data is invalid')
  }
  return Object.freeze({ ...payload, typedData: JSON.stringify(typedData) })
}

export async function broadcastConfirmedStarknetInvoke(
  result: SigningResult,
  rpc: Pick<StarknetBroadcastRpc, 'addInvokeTransaction'>
): Promise<{ readonly transactionHash: string }> {
  const confirmed = parseConfirmedInvoke(result)
  const transactionHash = await rpc.addInvokeTransaction(confirmed.transaction)
  if (transactionHash !== confirmed.transactionHash) {
    throw new Error('Starknet node returned a different transaction hash')
  }
  return { transactionHash }
}

function parseConfirmedInvoke(result: SigningResult): {
  readonly transactionHash: string
  readonly transaction: Readonly<Record<string, unknown>>
} {
  if (
    result.kind !== 'signed-payload' ||
    result.payload.encoding !== 'utf8' ||
    !result.transactionId
  ) {
    throw new Error('Starknet signing result is invalid')
  }
  const transaction = JSON.parse(result.payload.value) as unknown
  if (typeof transaction !== 'object' || transaction === null || Array.isArray(transaction)) {
    throw new Error('Starknet signing result is invalid')
  }
  const record = transaction as Record<string, unknown>
  assertStarknetExecutionTransaction(record)
  return { transactionHash: result.transactionId, transaction: record }
}
