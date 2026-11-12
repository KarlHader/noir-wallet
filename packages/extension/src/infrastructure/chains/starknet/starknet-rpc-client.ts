import { DEFAULT_REQUEST_TIMEOUT_MS } from '@/config/extension'
import { readBoundedResponseText } from '@/lib/fetch-utils'
import { normalizeStarknetFelt } from '@/core/chains/starknet/identifiers'

import {
  assertStarknetExecutionTransaction,
  assertStarknetFelt,
  feltToBigint,
  type StarknetFeeEstimate
} from './starknet-primitives'
import {
  StarknetRpcError,
  type StarknetEventPage,
  type StarknetReadRpc,
  type StarknetBroadcastRpc,
  type StarknetRpcClientConfig,
  type StarknetRpcEvent
} from './starknet-rpc-types'

export { StarknetRpcError } from './starknet-rpc-types'

const MAXIMUM_RESPONSE_BYTES = 1_048_576

interface JsonRpcError {
  readonly code?: number
  readonly message?: string
}

export function createStarknetRpcClient(
  config: StarknetRpcClientConfig
): StarknetReadRpc & StarknetBroadcastRpc {
  const fetchImpl = config.fetchImpl ?? fetch
  const timeoutMs = config.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const blockTimestamps = new Map<number, number>()

  const request = async (
    method: string,
    params: Readonly<Record<string, unknown>> | readonly unknown[],
    signal?: AbortSignal
  ): Promise<unknown> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await fetchImpl(config.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal
      })
      if (!response.ok)
        throw new StarknetRpcError('network-unavailable', 'Starknet RPC is unavailable')
      const text = await readBoundedResponseText(
        response,
        MAXIMUM_RESPONSE_BYTES,
        () => new StarknetRpcError('invalid-response', 'Starknet RPC response is too large')
      )
      const body = JSON.parse(text) as { readonly result?: unknown; readonly error?: JsonRpcError }
      if (body.error) throw mapRpcError(body.error)
      if (!('result' in body)) {
        throw new StarknetRpcError('invalid-response', 'Starknet RPC response is invalid')
      }
      return body.result
    } catch (error) {
      if (error instanceof StarknetRpcError) throw error
      if (signal?.aborted)
        throw new StarknetRpcError('cancelled', 'Starknet RPC request was cancelled')
      if (controller.signal.aborted)
        throw new StarknetRpcError('timeout', 'Starknet RPC request timed out')
      throw new StarknetRpcError('network-unavailable', 'Starknet RPC is unavailable')
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  return {
    async getNonce(address, signal) {
      const result = await request(
        'starknet_getNonce',
        { block_id: 'pre_confirmed', contract_address: assertStarknetFelt(address, 'account') },
        signal
      )
      return feltToBigint(readFelt(result, 'nonce'))
    },
    async getClassHashAt(address, signal) {
      try {
        const result = await request(
          'starknet_getClassHashAt',
          { block_id: 'pre_confirmed', contract_address: assertStarknetFelt(address, 'account') },
          signal
        )
        return normalizeStarknetFelt(readFelt(result, 'class hash'))
      } catch (error) {
        if (error instanceof StarknetRpcError && error.code === 'contract-not-found') return null
        throw error
      }
    },
    async call(contractAddress, selector, calldata, signal) {
      const result = await request(
        'starknet_call',
        {
          request: {
            contract_address: assertStarknetFelt(contractAddress, 'contract'),
            entry_point_selector: assertStarknetFelt(selector, 'selector'),
            calldata: calldata.map(value => assertStarknetFelt(value, 'calldata'))
          },
          block_id: 'pre_confirmed'
        },
        signal
      )
      if (!Array.isArray(result)) {
        throw new StarknetRpcError('invalid-response', 'Starknet call result is invalid')
      }
      return Object.freeze(result.map(value => readFelt(value, 'call result')))
    },
    async estimateFees(transactions, signal) {
      if (transactions.length === 0 || transactions.length > 2) {
        throw new StarknetRpcError('invalid-response', 'Starknet fee estimate request is invalid')
      }
      for (const transaction of transactions) {
        if (transaction.version !== '0x100000000000000000000000000000003') {
          throw new StarknetRpcError(
            'invalid-response',
            'Starknet fee estimate requires a query transaction'
          )
        }
      }
      const result = await request(
        'starknet_estimateFee',
        [transactions, ['SKIP_VALIDATE'], 'pre_confirmed'],
        signal
      )
      const estimates = Array.isArray(result) ? result : [result]
      if (estimates.length !== transactions.length) {
        throw new StarknetRpcError('invalid-response', 'Starknet fee estimate result is invalid')
      }
      return Object.freeze(estimates.map(parseFeeEstimate))
    },
    async getTransactionReceipt(hash, signal) {
      try {
        const result = await request(
          'starknet_getTransactionReceipt',
          { transaction_hash: assertStarknetFelt(hash, 'transaction hash') },
          signal
        )
        const record = readRecord(result, 'receipt')
        return Object.freeze({
          found: true as const,
          finality: readString(record.finality_status, 'finality'),
          execution: readString(record.execution_status, 'execution')
        })
      } catch (error) {
        if (error instanceof StarknetRpcError && error.code === 'transaction-not-found') {
          return Object.freeze({ found: false as const, timedOut: false })
        }
        throw error
      }
    },
    async getBlockTimestamp(blockNumber, signal) {
      if (!Number.isInteger(blockNumber) || blockNumber < 0) {
        throw new StarknetRpcError('invalid-response', 'Starknet block number is invalid')
      }
      const cached = blockTimestamps.get(blockNumber)
      if (cached !== undefined) return cached
      const result = await request(
        'starknet_getBlockWithTxHashes',
        { block_id: { block_number: blockNumber } },
        signal
      )
      const timestamp = readRecord(result, 'block').timestamp
      if (typeof timestamp !== 'number' || !Number.isInteger(timestamp) || timestamp < 0) {
        throw new StarknetRpcError('invalid-response', 'Starknet block timestamp is invalid')
      }
      blockTimestamps.set(blockNumber, timestamp)
      return timestamp
    },
    async getEvents(filter, signal) {
      const result = await request(
        'starknet_getEvents',
        {
          filter: {
            from_block: filter.fromBlock,
            to_block: filter.toBlock,
            address: assertStarknetFelt(filter.address, 'event address'),
            keys: filter.keys.map(group => group.map(key => assertStarknetFelt(key, 'event key'))),
            chunk_size: filter.chunkSize,
            ...(filter.continuationToken === undefined
              ? {}
              : { continuation_token: filter.continuationToken })
          }
        },
        signal
      )
      return parseEventPage(result)
    },
    async addInvokeTransaction(transaction, signal) {
      assertStarknetExecutionTransaction(transaction)
      const result = await request(
        'starknet_addInvokeTransaction',
        { invoke_transaction: transaction },
        signal
      )
      return readHash(result)
    },
    async addDeployAccountTransaction(transaction, signal) {
      assertStarknetExecutionTransaction(transaction)
      const result = await request(
        'starknet_addDeployAccountTransaction',
        { deploy_account_transaction: transaction },
        signal
      )
      return readHash(result)
    }
  }
}

function mapRpcError(error: JsonRpcError): StarknetRpcError {
  const message = typeof error.message === 'string' ? error.message : 'Starknet RPC request failed'
  if (error.code === 20 || /CONTRACT_NOT_FOUND/i.test(message)) {
    return new StarknetRpcError('contract-not-found', 'Starknet contract was not found')
  }
  if (error.code === 29 || /TRANSACTION_NOT_FOUND|Transaction hash not found/i.test(message)) {
    return new StarknetRpcError('transaction-not-found', 'Starknet transaction was not found')
  }
  if (error.code === 40 || /ENTRYPOINT_NOT_FOUND|Entry point not found/i.test(message)) {
    return new StarknetRpcError('entrypoint-not-found', 'Starknet entry point was not found')
  }
  return new StarknetRpcError('rpc-error', 'Starknet RPC request failed', message)
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StarknetRpcError('invalid-response', `Starknet ${label} is invalid`)
  }
  return value as Record<string, unknown>
}

function readString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new StarknetRpcError('invalid-response', `Starknet ${label} is invalid`)
  }
  return value
}

function readFelt(value: unknown, label: string): string {
  try {
    return assertStarknetFelt(readString(value, label), label)
  } catch {
    throw new StarknetRpcError('invalid-response', `Starknet ${label} is invalid`)
  }
}

function readHash(value: unknown): string {
  const record = readRecord(value, 'broadcast result')
  return readFelt(record.transaction_hash, 'transaction hash')
}

function parseHexBigint(value: unknown, label: string): bigint {
  const felt = readFelt(value, label)
  return feltToBigint(felt)
}

function parseFeeEstimate(value: unknown): StarknetFeeEstimate {
  const record = readRecord(value, 'fee estimate')
  const l1GasConsumed = parseHexBigint(record.l1_gas_consumed ?? record.l1GasConsumed, 'l1 gas')
  const l1GasPrice = parseHexBigint(record.l1_gas_price ?? record.l1GasPrice, 'l1 gas price')
  const l2GasConsumed = parseHexBigint(record.l2_gas_consumed ?? record.l2GasConsumed, 'l2 gas')
  const l2GasPrice = parseHexBigint(record.l2_gas_price ?? record.l2GasPrice, 'l2 gas price')
  const l1DataGasConsumed = parseHexBigint(
    record.l1_data_gas_consumed ?? record.l1DataGasConsumed,
    'l1 data gas'
  )
  const l1DataGasPrice = parseHexBigint(
    record.l1_data_gas_price ?? record.l1DataGasPrice,
    'l1 data gas price'
  )
  const overall =
    record.overall_fee === undefined && record.overallFee === undefined
      ? l1GasConsumed * l1GasPrice + l2GasConsumed * l2GasPrice + l1DataGasConsumed * l1DataGasPrice
      : parseHexBigint(record.overall_fee ?? record.overallFee, 'overall fee')
  return {
    l1GasConsumed,
    l1GasPrice,
    l2GasConsumed,
    l2GasPrice,
    l1DataGasConsumed,
    l1DataGasPrice,
    overallFee: overall
  }
}

function parseEventPage(value: unknown): StarknetEventPage {
  const record = readRecord(value, 'events')
  if (!Array.isArray(record.events)) {
    throw new StarknetRpcError('invalid-response', 'Starknet events are invalid')
  }
  const events = record.events.map((event, index) => parseEvent(event, index))
  const token = record.continuation_token
  return {
    events: Object.freeze(events),
    ...(typeof token === 'string' && token.length > 0 ? { continuationToken: token } : {})
  }
}

function parseEvent(value: unknown, index: number): StarknetRpcEvent {
  const record = readRecord(value, 'event')
  const keys = readFeltList(record.keys, 'event keys')
  const data = readFeltList(record.data, 'event data')
  const eventIndex =
    typeof record.event_index === 'number' && Number.isSafeInteger(record.event_index)
      ? String(record.event_index)
      : `${readBlockNumber(record.block_number)}:${index}`
  return {
    fromAddress: readFelt(record.from_address, 'event address'),
    keys,
    data,
    blockNumber: readBlockNumber(record.block_number),
    transactionHash: readFelt(record.transaction_hash, 'transaction hash'),
    eventIndex
  }
}

function readFeltList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new StarknetRpcError('invalid-response', `Starknet ${label} are invalid`)
  }
  return Object.freeze(value.map(item => readFelt(item, label)))
}

function readBlockNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new StarknetRpcError('invalid-response', 'Starknet block number is invalid')
  }
  return value
}
