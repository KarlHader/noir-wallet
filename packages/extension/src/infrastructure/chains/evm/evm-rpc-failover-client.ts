import type { EvmDAppReadMethod } from '@/core/dapp/eip1193'
import type { RpcEndpointOption } from '@/config/rpc-endpoints'
import {
  createEvmRpcClient,
  EvmRpcError,
  type EvmBalanceRpc,
  type EvmBroadcastRpc,
  type EvmContractRpc,
  type EvmDAppReadRpc,
  type EvmDAppRpcCall,
  type EvmLatestBlockFee,
  type EvmRpcBlockTag,
  type EvmRpcCall,
  type EvmTransactionLocation,
  type EvmTransactionReceipt,
  type EvmTransactionRpc
} from './evm-rpc-client'

type EvmRpc = EvmBalanceRpc & EvmContractRpc & EvmTransactionRpc & EvmBroadcastRpc & EvmDAppReadRpc

export interface EvmRpcFailoverClientConfig {
  readonly chainId: string
  readonly endpoints: readonly RpcEndpointOption[] | (() => readonly RpcEndpointOption[])
  readonly timeoutMs?: number
  readonly maximumResponseBytes?: number
}

interface EndpointState {
  readonly key: string
  readonly client: EvmRpc
  attested: boolean
}

type FetchImplementation = (input: string, init: RequestInit) => Promise<Response>

function parseEndpoints(
  config: EvmRpcFailoverClientConfig,
  fetchImplementation: FetchImplementation,
  previous: ReadonlyMap<string, EndpointState>
): EndpointState[] {
  const options = typeof config.endpoints === 'function' ? config.endpoints() : config.endpoints
  if (!Array.isArray(options) || options.length < 1 || options.length > 5) {
    throw new Error('EVM RPC failover requires one to five endpoints')
  }
  const ids = new Set<string>()
  const urls = new Set<string>()
  return options.map(endpoint => {
    if (
      typeof endpoint !== 'object' ||
      endpoint === null ||
      typeof endpoint.id !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(endpoint.id) ||
      ids.has(endpoint.id)
    ) {
      throw new Error('Invalid EVM RPC endpoint ID')
    }
    if (typeof endpoint.label !== 'string' || endpoint.label.trim().length === 0) {
      throw new Error('Invalid EVM RPC endpoint label')
    }
    ids.add(endpoint.id)
    const normalizedUrl = new URL(endpoint.url).toString()
    if (urls.has(normalizedUrl)) throw new Error('Duplicate EVM RPC endpoint URL')
    urls.add(normalizedUrl)
    const key = `${endpoint.id}\0${normalizedUrl}`
    const existing = previous.get(key)
    if (existing) return existing
    return {
      key,
      client: createEvmRpcClient(
        {
          chainId: config.chainId,
          rpcUrl: endpoint.url,
          ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
          ...(config.maximumResponseBytes === undefined
            ? {}
            : { maximumResponseBytes: config.maximumResponseBytes })
        },
        fetchImplementation
      ),
      attested: false
    }
  })
}

function isRetryableEndpointFailure(error: unknown): error is EvmRpcError {
  return (
    error instanceof EvmRpcError &&
    (error.code === 'timeout' ||
      error.code === 'network-unavailable' ||
      error.code === 'rate-limited' ||
      error.code === 'unauthorized' ||
      error.code === 'invalid-response' ||
      error.code === 'chain-mismatch')
  )
}

export function createEvmRpcFailoverClient(
  config: EvmRpcFailoverClientConfig,
  fetchImplementation: FetchImplementation = fetch
): EvmRpc {
  let endpointStates = parseEndpoints(config, fetchImplementation, new Map())
  let activeKey = endpointStates[0].key

  const snapshotEndpoints = (): readonly EndpointState[] => {
    if (typeof config.endpoints !== 'function') return endpointStates
    const previous = new Map(endpointStates.map(state => [state.key, state]))
    const next = parseEndpoints(config, fetchImplementation, previous)
    endpointStates = next
    return next
  }

  const run = async <T>(
    operation: (state: EndpointState) => Promise<T>,
    signal?: AbortSignal,
    attest = true
  ): Promise<T> => {
    if (signal?.aborted) throw new EvmRpcError('cancelled', 'EVM RPC request was cancelled')
    const endpoints = snapshotEndpoints()
    const activeIndex = Math.max(
      0,
      endpoints.findIndex(state => state.key === activeKey)
    )
    let lastRetryableError: EvmRpcError | undefined
    for (let offset = 0; offset < endpoints.length; offset += 1) {
      const index = (activeIndex + offset) % endpoints.length
      const state = endpoints[index]
      try {
        if (attest && !state.attested) {
          await state.client.assertExpectedChain(signal)
          state.attested = true
        }
        const result = await operation(state)
        activeKey = state.key
        return result
      } catch (error) {
        if (!isRetryableEndpointFailure(error)) throw error
        state.attested = false
        lastRetryableError = error
      }
    }
    throw (
      lastRetryableError ??
      new EvmRpcError('network-unavailable', 'All EVM RPC endpoints are unavailable')
    )
  }

  return Object.freeze({
    assertExpectedChain: async (signal?: AbortSignal) => {
      await run(
        async state => {
          await state.client.assertExpectedChain(signal)
          state.attested = true
        },
        signal,
        false
      )
    },
    requestDAppRead: (
      method: EvmDAppReadMethod,
      params: readonly unknown[] | Readonly<Record<string, unknown>>,
      signal?: AbortSignal
    ) => run(state => state.client.requestDAppRead(method, params, signal), signal),
    getNativeBalance: (address: string, signal?: AbortSignal) =>
      run(state => state.client.getNativeBalance(address, signal), signal),
    getErc20Balance: (contract: string, address: string, signal?: AbortSignal) =>
      run(state => state.client.getErc20Balance(contract, address, signal), signal),
    getCode: (address: string, signal?: AbortSignal) =>
      run(state => state.client.getCode(address, signal), signal),
    callContract: (address: string, data: string, signal?: AbortSignal) =>
      run(state => state.client.callContract(address, data, signal), signal),
    call: (call: EvmDAppRpcCall, blockTag: EvmRpcBlockTag, signal?: AbortSignal) =>
      run(state => state.client.call(call, blockTag, signal), signal),
    getTransactionCount: (address: string, blockTag: EvmRpcBlockTag, signal?: AbortSignal) =>
      run(state => state.client.getTransactionCount(address, blockTag, signal), signal),
    getPendingNonce: (address: string, signal?: AbortSignal) =>
      run(state => state.client.getPendingNonce(address, signal), signal),
    simulateCall: (call: EvmRpcCall, signal?: AbortSignal) =>
      run(state => state.client.simulateCall(call, signal), signal),
    estimateGas: (call: EvmDAppRpcCall, signal?: AbortSignal) =>
      run(state => state.client.estimateGas(call, signal), signal),
    getMaximumPriorityFeePerGas: (signal?: AbortSignal) =>
      run(state => state.client.getMaximumPriorityFeePerGas(signal), signal),
    getGasPrice: (signal?: AbortSignal) => run(state => state.client.getGasPrice(signal), signal),
    getLatestBlockFee: (signal?: AbortSignal): Promise<EvmLatestBlockFee> =>
      run(state => state.client.getLatestBlockFee(signal), signal),
    broadcastRawTransaction: (rawTransaction: string, signal?: AbortSignal) =>
      run(state => state.client.broadcastRawTransaction(rawTransaction, signal), signal),
    getTransactionReceipt: (
      transactionHash: string,
      signal?: AbortSignal
    ): Promise<EvmTransactionReceipt | null> =>
      run(state => state.client.getTransactionReceipt(transactionHash, signal), signal),
    getTransactionLocation: (
      transactionHash: string,
      signal?: AbortSignal
    ): Promise<EvmTransactionLocation> =>
      run(state => state.client.getTransactionLocation(transactionHash, signal), signal),
    hasTransaction: (transactionHash: string, signal?: AbortSignal) =>
      run(state => state.client.hasTransaction(transactionHash, signal), signal),
    getFinalizedBlockNumber: (signal?: AbortSignal) =>
      run(state => state.client.getFinalizedBlockNumber(signal), signal)
  })
}
