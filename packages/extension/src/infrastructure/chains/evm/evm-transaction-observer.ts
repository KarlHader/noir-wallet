import { EvmRpcError, type EvmBroadcastRpc, type EvmReceiptLog } from './evm-rpc-client'

export type EvmTransactionObservation =
  | {
      readonly status: 'broadcast'
      readonly transactionHash: string
    }
  | {
      readonly status: 'confirming'
      readonly transactionHash: string
      readonly blockHash: string
      readonly blockNumber: string
      readonly receiptStatus: 'success' | 'failed'
    }
  | {
      readonly status: 'final'
      readonly transactionHash: string
      readonly blockHash: string
      readonly blockNumber: string
      readonly receiptStatus: 'success'
      readonly logs?: readonly EvmReceiptLog[]
    }
  | {
      readonly status: 'failed'
      readonly transactionHash: string
      readonly blockHash: string
      readonly blockNumber: string
      readonly failureCode: 'execution-reverted'
    }

export interface BroadcastSignedEvmTransactionInput {
  readonly rawTransaction: string
  readonly expectedTransactionHash: string
  readonly rpc: EvmBroadcastRpc
  readonly signal?: AbortSignal
}

function parseExpectedHash(value: string): string {
  if (!/^0x[0-9a-f]{64}$/.test(value)) throw new Error('Invalid expected EVM transaction hash')
  return value
}

function parseBlockNumber(value: string, label: string): bigint {
  if (!/^(0|[1-9][0-9]{0,127})$/.test(value)) {
    throw new EvmRpcError('invalid-response', `Invalid ${label}`)
  }
  return BigInt(value)
}

export async function broadcastSignedEvmTransaction(
  input: BroadcastSignedEvmTransactionInput
): Promise<string> {
  const expected = parseExpectedHash(input.expectedTransactionHash)
  const broadcast = await input.rpc.broadcastRawTransaction(input.rawTransaction, input.signal)
  if (broadcast !== expected) {
    throw new EvmRpcError('invalid-response', 'EVM RPC returned a different transaction hash')
  }
  return broadcast
}

export async function observeEvmTransaction(
  transactionHash: string,
  rpc: EvmBroadcastRpc,
  signal?: AbortSignal
): Promise<EvmTransactionObservation | null> {
  const expected = parseExpectedHash(transactionHash)
  const receipt = await rpc.getTransactionReceipt(expected, signal)
  if (receipt === null) {
    const location = await rpc.getTransactionLocation(expected, signal)
    if (location.status !== 'pending') return null
    return Object.freeze({ status: 'broadcast', transactionHash: expected })
  }
  if (receipt.transactionHash !== expected) {
    throw new EvmRpcError('invalid-response', 'EVM receipt transaction hash does not match')
  }
  parseBlockNumber(receipt.blockNumber, 'receipt block number')
  if (receipt.status === 'failed') {
    return Object.freeze({
      status: 'failed',
      transactionHash: expected,
      blockHash: receipt.blockHash,
      blockNumber: receipt.blockNumber,
      failureCode: 'execution-reverted'
    })
  }
  return Object.freeze({
    status: 'final',
    transactionHash: expected,
    blockHash: receipt.blockHash,
    blockNumber: receipt.blockNumber,
    receiptStatus: 'success',
    ...(receipt.logs === undefined ? {} : { logs: receipt.logs })
  })
}
