import { DEFAULT_REQUEST_TIMEOUT_MS } from '@/config/extension'
import { getNearNetworkConfigs } from '@/config/networks'
import { readBoundedResponseText } from '@/lib/fetch-utils'
import { parseChainId } from '@/core/chains/registry'

import {
  encodeNearFunctionArgs,
  hasExactKeys,
  isNearAccessKeyMissingResult,
  isRecord,
  parseNearAccountSnapshot,
  parseNearAccessKeySnapshot,
  parseNearFinalBlock,
  parseNearFungibleTokenBalance,
  parseNearFungibleTokenRegistration,
  parseNearNativeTransferCostConfig,
  readNearAccountId,
  readNearHash,
  readNearPublicKey,
  readSafeUnsignedInteger,
  readU128
} from './near-rpc-codecs'
import {
  NearRpcError,
  type NearBroadcastRpc,
  type NearCommitBroadcastRpc,
  type NearReadRpc,
  type NearRpcClientConfig
} from './near-rpc-types'

export {
  NEAR_RPC_ERROR_CODES,
  NearRpcError,
  type NearAccessKeyPermission,
  type NearAccessKeySnapshot,
  type NearAccountSnapshot,
  type NearFinalBlockSnapshot,
  type NearFungibleTokenBalanceSnapshot,
  type NearGasCostComponents,
  type NearNativeTransferCostConfig,
  type NearReadRpc,
  type NearBroadcastRpc,
  type NearCommitBroadcastRpc,
  type NearRpcClientConfig,
  type NearRpcErrorCode,
  type NearTransactionStatus
} from './near-rpc-types'

type FetchImplementation = (input: string, init: RequestInit) => Promise<Response>

const DEFAULT_MAXIMUM_RESPONSE_BYTES = 1024 * 1024
const MAXIMUM_TIMEOUT_MS = 60_000
const MAXIMUM_RESPONSE_BYTES = 4 * 1024 * 1024
const MAXIMUM_SIGNED_TRANSACTION_BYTES = 4 * 1024 * 1024

function parseSignedTransactionBase64(value: string): string {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const decodedBytes = value.length % 4 === 0 ? (value.length / 4) * 3 - padding : -1
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    decodedBytes <= 0 ||
    decodedBytes > MAXIMUM_SIGNED_TRANSACTION_BYTES ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    throw new Error('Invalid NEAR signed transaction')
  }
  let binary: string
  try {
    binary = atob(value)
  } catch {
    throw new Error('Invalid NEAR signed transaction')
  }
  if (
    binary.length === 0 ||
    binary.length > MAXIMUM_SIGNED_TRANSACTION_BYTES ||
    btoa(binary) !== value
  ) {
    throw new Error('Invalid NEAR signed transaction')
  }
  return value
}

function parseRpcUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Invalid NEAR RPC URL')
  }
  const localDevelopmentHost =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && localDevelopmentHost)) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error('NEAR RPC URL must be a credential-free HTTPS endpoint')
  }
  return url.toString()
}

function parseExpectedNetwork(chainIdValue: string) {
  const chainId = parseChainId(chainIdValue)
  if (chainId.namespace !== 'near') throw new Error('Invalid NEAR chain ID')
  const network = getNearNetworkConfigs().find(candidate => candidate.chainId === chainId.id)
  if (!network) throw new Error('Unsupported NEAR chain ID')
  return network
}

function containsRpcCause(value: unknown, expected: string, depth = 0): boolean {
  if (depth > 4 || !isRecord(value)) return false
  if (value.name === expected) return true
  return Object.values(value).some(candidate => containsRpcCause(candidate, expected, depth + 1))
}

function parseRpcError(value: unknown): NearRpcError {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['code', 'message'], ['cause', 'data', 'name']) ||
    !Number.isSafeInteger(value.code) ||
    typeof value.message !== 'string' ||
    value.message.length === 0 ||
    value.message.length > 4_096
  ) {
    return new NearRpcError('invalid-response', 'Invalid NEAR RPC error response')
  }
  if (
    (value.name !== undefined &&
      (typeof value.name !== 'string' || value.name.length === 0 || value.name.length > 256)) ||
    (value.cause !== undefined && !isRecord(value.cause))
  ) {
    return new NearRpcError('invalid-response', 'Invalid NEAR RPC error response')
  }
  if (containsRpcCause(value, 'UNKNOWN_ACCOUNT')) {
    return new NearRpcError('account-not-found', 'NEAR account was not found')
  }
  if (containsRpcCause(value, 'UNKNOWN_ACCESS_KEY')) {
    return new NearRpcError('access-key-not-found', 'NEAR access key was not found')
  }
  if (containsRpcCause(value, 'UNKNOWN_TRANSACTION')) {
    return new NearRpcError('transaction-not-found', 'NEAR transaction was not found')
  }
  return new NearRpcError(
    value.code === 429 || value.code === -32_005 ? 'rate-limited' : 'rpc-error',
    'NEAR RPC request failed'
  )
}

function mapHttpError(status: number): NearRpcError {
  if (status === 401 || status === 403) {
    return new NearRpcError('unauthorized', 'NEAR RPC authorization failed')
  }
  if (status === 429) return new NearRpcError('rate-limited', 'NEAR RPC rate limit exceeded')
  return new NearRpcError('network-unavailable', 'NEAR RPC endpoint is unavailable')
}

async function readResponseText(response: Response, maximumBytes: number): Promise<string> {
  return readBoundedResponseText(
    response,
    maximumBytes,
    () => new NearRpcError('invalid-response', 'NEAR RPC response exceeds the allowed size')
  )
}

export function createNearRpcClient(
  config: NearRpcClientConfig,
  fetchImplementation: FetchImplementation = fetch
): NearReadRpc & NearBroadcastRpc & NearCommitBroadcastRpc {
  const expectedNetwork = parseExpectedNetwork(config.chainId)
  const rpcUrl = parseRpcUrl(config.rpcUrl)
  const timeoutMs = config.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const maximumResponseBytes = config.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAXIMUM_TIMEOUT_MS) {
    throw new Error('Invalid NEAR RPC timeout')
  }
  if (
    !Number.isSafeInteger(maximumResponseBytes) ||
    maximumResponseBytes < 1_024 ||
    maximumResponseBytes > MAXIMUM_RESPONSE_BYTES
  ) {
    throw new Error('Invalid NEAR RPC response limit')
  }

  let requestId = 0
  const request = async (
    method:
      | 'status'
      | 'genesis_config'
      | 'query'
      | 'block'
      | 'gas_price'
      | 'EXPERIMENTAL_protocol_config'
      | 'tx'
      | 'broadcast_tx_async'
      | 'broadcast_tx_commit',
    params: readonly unknown[] | Readonly<Record<string, unknown>>,
    externalSignal?: AbortSignal
  ): Promise<unknown> => {
    if (externalSignal?.aborted) {
      throw new NearRpcError('cancelled', 'NEAR RPC request was cancelled')
    }
    const controller = new AbortController()
    let timedOut = false
    const onExternalAbort = () => controller.abort()
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true })
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    requestId = requestId >= 2_147_483_647 ? 1 : requestId + 1
    const id = requestId
    try {
      const response = await fetchImplementation(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal
      })
      if (!response.ok) throw mapHttpError(response.status)
      const text = await readResponseText(response, maximumResponseBytes)
      let decoded: unknown
      try {
        decoded = JSON.parse(text)
      } catch {
        throw new NearRpcError('invalid-response', 'NEAR RPC response is not valid JSON')
      }
      if (!isRecord(decoded) || decoded.jsonrpc !== '2.0' || decoded.id !== id) {
        throw new NearRpcError('invalid-response', 'Invalid NEAR RPC response envelope')
      }
      if (Object.prototype.hasOwnProperty.call(decoded, 'error')) {
        if (!hasExactKeys(decoded, ['jsonrpc', 'id', 'error'])) {
          throw new NearRpcError('invalid-response', 'Invalid NEAR RPC error envelope')
        }
        throw parseRpcError(decoded.error)
      }
      if (!hasExactKeys(decoded, ['jsonrpc', 'id', 'result'])) {
        throw new NearRpcError('invalid-response', 'Invalid NEAR RPC result envelope')
      }
      return decoded.result
    } catch (error) {
      if (error instanceof NearRpcError) throw error
      if (controller.signal.aborted) {
        throw new NearRpcError(
          timedOut ? 'timeout' : 'cancelled',
          timedOut ? 'NEAR RPC request timed out' : 'NEAR RPC request was cancelled'
        )
      }
      throw new NearRpcError('network-unavailable', 'NEAR RPC request failed')
    } finally {
      clearTimeout(timeout)
      externalSignal?.removeEventListener('abort', onExternalAbort)
    }
  }

  return Object.freeze({
    assertExpectedChain: async (signal?: AbortSignal) => {
      const status = await request('status', [], signal)
      const genesis = await request('genesis_config', [], signal)
      const genesisBlock = await request(
        'block',
        Object.freeze({ block_id: expectedNetwork.genesisHeight }),
        signal
      )
      if (
        !isRecord(status) ||
        status.chain_id !== expectedNetwork.network ||
        !isRecord(status.sync_info) ||
        readNearHash(status.sync_info.latest_block_hash, 'NEAR status latest block hash').length ===
          0 ||
        !isRecord(genesis) ||
        genesis.chain_id !== expectedNetwork.network ||
        readSafeUnsignedInteger(genesis.genesis_height, 'NEAR genesis height') !==
          expectedNetwork.genesisHeight ||
        genesis.genesis_time !== expectedNetwork.genesisTime ||
        !isRecord(genesisBlock) ||
        !isRecord(genesisBlock.header) ||
        readSafeUnsignedInteger(genesisBlock.header.height, 'NEAR genesis block height') !==
          expectedNetwork.genesisHeight ||
        readNearHash(genesisBlock.header.hash, 'NEAR genesis block hash') !==
          expectedNetwork.genesisHash
      ) {
        throw new NearRpcError('chain-mismatch', 'NEAR RPC endpoint returned the wrong chain')
      }
    },
    getAccount: async (accountIdValue: string, signal?: AbortSignal) => {
      const accountId = readNearAccountId(accountIdValue, 'NEAR account ID')
      try {
        const result = await request(
          'query',
          Object.freeze({ request_type: 'view_account', finality: 'final', account_id: accountId }),
          signal
        )
        return parseNearAccountSnapshot(result, accountId)
      } catch (error) {
        if (error instanceof NearRpcError && error.code === 'account-not-found') return null
        throw error
      }
    },
    getAccessKey: async (accountIdValue: string, publicKeyValue: string, signal?: AbortSignal) => {
      const accountId = readNearAccountId(accountIdValue, 'NEAR account ID')
      const publicKey = readNearPublicKey(publicKeyValue, 'NEAR public key')
      try {
        const result = await request(
          'query',
          Object.freeze({
            request_type: 'view_access_key',
            finality: 'final',
            account_id: accountId,
            public_key: publicKey
          }),
          signal
        )
        if (isNearAccessKeyMissingResult(result, publicKey)) return null
        return parseNearAccessKeySnapshot(result, accountId, publicKey)
      } catch (error) {
        if (error instanceof NearRpcError && error.code === 'access-key-not-found') return null
        throw error
      }
    },
    getFinalBlock: async (signal?: AbortSignal) =>
      parseNearFinalBlock(await request('block', Object.freeze({ finality: 'final' }), signal)),
    getGasPrice: async (signal?: AbortSignal) => {
      const result = await request('gas_price', [null], signal)
      if (!isRecord(result) || !hasExactKeys(result, ['gas_price'])) {
        throw new NearRpcError('invalid-response', 'Invalid NEAR gas price response')
      }
      return readU128(result.gas_price, 'NEAR gas price')
    },
    getNativeTransferCostConfig: async (signal?: AbortSignal) =>
      parseNearNativeTransferCostConfig(
        await request('EXPERIMENTAL_protocol_config', Object.freeze({ finality: 'final' }), signal),
        expectedNetwork.network
      ),
    getTransactionStatus: async (
      transactionHashValue: string,
      signerIdValue: string,
      signal?: AbortSignal
    ) => {
      const transactionHash = readNearHash(transactionHashValue, 'NEAR transaction hash')
      const signerId = readNearAccountId(signerIdValue, 'NEAR transaction signer account ID')
      let result: unknown
      try {
        result = await request(
          'tx',
          Object.freeze({
            tx_hash: transactionHash,
            sender_account_id: signerId,
            wait_until: 'NONE'
          }),
          signal
        )
      } catch (error) {
        if (error instanceof NearRpcError && error.code === 'transaction-not-found') {
          return Object.freeze({ status: 'unknown' as const })
        }
        throw error
      }
      if (
        !isRecord(result) ||
        !isRecord(result.transaction) ||
        readNearHash(result.transaction.hash, 'NEAR transaction response hash') !==
          transactionHash ||
        typeof result.final_execution_status !== 'string'
      ) {
        throw new NearRpcError('invalid-response', 'Invalid NEAR transaction status response')
      }
      const executionStatus = result.final_execution_status
      if (
        ![
          'NONE',
          'NOT_STARTED',
          'STARTED',
          'INCLUDED',
          'EXECUTED_OPTIMISTIC',
          'INCLUDED_FINAL',
          'EXECUTED',
          'FINAL'
        ].includes(executionStatus)
      ) {
        throw new NearRpcError('invalid-response', 'Invalid NEAR transaction execution status')
      }
      if (executionStatus !== 'FINAL') {
        return Object.freeze({ status: 'confirming' as const })
      }
      if (!isRecord(result.status)) {
        throw new NearRpcError('invalid-response', 'Invalid finalized NEAR transaction status')
      }
      const statusKeys = Object.keys(result.status)
      if (statusKeys.length !== 1) {
        throw new NearRpcError('invalid-response', 'Invalid finalized NEAR transaction status')
      }
      if (statusKeys[0] === 'Failure' && isRecord(result.status.Failure)) {
        return Object.freeze({ status: 'failed' as const })
      }
      if (statusKeys[0] === 'SuccessValue' && typeof result.status.SuccessValue === 'string') {
        return Object.freeze({ status: 'final' as const })
      }
      throw new NearRpcError('invalid-response', 'Invalid finalized NEAR transaction status')
    },
    getFungibleTokenBalance: async (
      contractIdValue: string,
      accountIdValue: string,
      signal?: AbortSignal
    ) => {
      const contractId = readNearAccountId(contractIdValue, 'NEAR fungible token contract ID')
      const accountId = readNearAccountId(accountIdValue, 'NEAR account ID')
      const result = await request(
        'query',
        Object.freeze({
          request_type: 'call_function',
          finality: 'final',
          account_id: contractId,
          method_name: 'ft_balance_of',
          args_base64: encodeNearFunctionArgs(Object.freeze({ account_id: accountId }))
        }),
        signal
      )
      return parseNearFungibleTokenBalance(result, contractId, accountId)
    },
    isFungibleTokenAccountRegistered: async (
      contractIdValue: string,
      accountIdValue: string,
      signal?: AbortSignal
    ) => {
      const contractId = readNearAccountId(contractIdValue, 'NEAR fungible token contract ID')
      const accountId = readNearAccountId(accountIdValue, 'NEAR account ID')
      const result = await request(
        'query',
        Object.freeze({
          request_type: 'call_function',
          finality: 'final',
          account_id: contractId,
          method_name: 'storage_balance_of',
          args_base64: encodeNearFunctionArgs(Object.freeze({ account_id: accountId }))
        }),
        signal
      )
      return parseNearFungibleTokenRegistration(result)
    },
    broadcastSignedTransaction: async (transactionBase64: string, signal?: AbortSignal) =>
      readNearHash(
        await request(
          'broadcast_tx_async',
          [parseSignedTransactionBase64(transactionBase64)],
          signal
        ),
        'NEAR transaction hash'
      ),
    broadcastSignedTransactionAndWait: async (transactionBase64: string, signal?: AbortSignal) => {
      const result = await request(
        'broadcast_tx_commit',
        [parseSignedTransactionBase64(transactionBase64)],
        signal
      )
      if (
        !isRecord(result) ||
        !isRecord(result.transaction) ||
        typeof result.transaction.hash !== 'string' ||
        readNearHash(result.transaction.hash, 'NEAR transaction response hash').length === 0
      ) {
        throw new NearRpcError('invalid-response', 'Invalid NEAR committed transaction response')
      }
      return Object.freeze(result)
    }
  })
}
