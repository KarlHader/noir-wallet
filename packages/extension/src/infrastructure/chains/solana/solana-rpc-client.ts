import { DEFAULT_REQUEST_TIMEOUT_MS } from '@/config/extension'
import { getSolanaNetworkConfigs } from '@/config/networks'
import { readBoundedResponseText } from '@/lib/fetch-utils'
import { parseChainId } from '@/core/chains/registry'

import {
  hasExactKeys,
  isRecord,
  parseAddressLookupTableData,
  parseBase58Bytes,
  parseCanonicalBase64,
  parseContext,
  parseSafeUnsignedInteger,
  parseSignedTransactionBase64,
  parseTokenAccount,
  SOLANA_ADDRESS_LOOKUP_TABLE_PROGRAM,
  SOLANA_LOOKUP_TABLE_MAX_ADDRESSES,
  SOLANA_LOOKUP_TABLE_META_BYTES,
  stringifyBoundedJson
} from './solana-rpc-codecs'
import {
  SOLANA_TOKEN_PROGRAMS,
  SolanaRpcError,
  SolanaSimulationError,
  type SolanaBroadcastOptions,
  type SolanaBroadcastRpc,
  type SolanaAddressSignature,
  type SolanaMessageFeeResult,
  type SolanaNativeBalanceResult,
  type SolanaReadRpc,
  type SolanaRpcClientConfig,
  type SolanaSimulationResult,
  type SolanaTokenProgram,
  type SolanaTransactionSummary,
  type SolanaTransactionTokenDelta
} from './solana-rpc-types'
import { deriveSolanaAssociatedTokenAccount } from './solana-transaction-builder'

export { parseSolanaPublicKey } from './solana-rpc-codecs'
export {
  SOLANA_RPC_ERROR_CODES,
  SOLANA_TOKEN_PROGRAMS,
  SolanaRpcError,
  SolanaSimulationError,
  type SolanaAddressLookupTable,
  type SolanaAddressSignature,
  type SolanaBroadcastOptions,
  type SolanaBroadcastRpc,
  type SolanaLatestBlockhash,
  type SolanaMessageFeeResult,
  type SolanaNativeBalanceResult,
  type SolanaReadRpc,
  type SolanaRpcClientConfig,
  type SolanaRpcErrorCode,
  type SolanaSimulationResult,
  type SolanaSignatureStatus,
  type SolanaTokenAccountBalance,
  type SolanaTokenAccountsResult,
  type SolanaTokenProgram,
  type SolanaTransactionSummary,
  type SolanaTransactionTokenDelta
} from './solana-rpc-types'

type FetchImplementation = (input: string, init: RequestInit) => Promise<Response>

const DEFAULT_MAXIMUM_RESPONSE_BYTES = 1024 * 1024
const MAXIMUM_TIMEOUT_MS = 60_000
const MAXIMUM_RESPONSE_BYTES = 4 * 1024 * 1024
const MAXIMUM_TOKEN_ACCOUNTS = 10_000
const MAXIMUM_MULTIPLE_ACCOUNTS = 100
const MAXIMUM_ADDRESS_SIGNATURES = 100

function parseSignedInteger(value: unknown, label: string): bigint {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new SolanaRpcError('invalid-response', `Invalid ${label}`)
  }
  return BigInt(value)
}

function parseTokenAmount(value: unknown, label: string): { amount: bigint; decimals: number } {
  if (
    !isRecord(value) ||
    typeof value.amount !== 'string' ||
    !/^\d+$/.test(value.amount) ||
    !Number.isSafeInteger(value.decimals) ||
    (value.decimals as number) < 0 ||
    (value.decimals as number) > 255
  ) {
    throw new SolanaRpcError('invalid-response', `Invalid ${label}`)
  }
  return { amount: BigInt(value.amount), decimals: value.decimals as number }
}

function parseTransactionAccountKey(value: unknown): string {
  if (typeof value === 'string') return parseBase58Bytes(value, 32, 'Solana account key')
  if (!isRecord(value) || typeof value.pubkey !== 'string') {
    throw new SolanaRpcError('invalid-response', 'Invalid Solana transaction account key')
  }
  return parseBase58Bytes(value.pubkey, 32, 'Solana account key')
}

function parseOwnerTokenBalances(
  value: unknown,
  owner: string,
  label: string
): ReadonlyMap<string, { amount: bigint; decimals: number }> {
  if (value === undefined) return new Map()
  if (!Array.isArray(value) || value.length > MAXIMUM_TOKEN_ACCOUNTS) {
    throw new SolanaRpcError('invalid-response', `Invalid ${label}`)
  }
  const totals = new Map<string, { amount: bigint; decimals: number }>()
  for (const balance of value) {
    if (!isRecord(balance) || balance.owner !== owner || typeof balance.mint !== 'string') continue
    const mint = parseBase58Bytes(balance.mint, 32, 'Solana token mint')
    const parsed = parseTokenAmount(balance.uiTokenAmount, 'Solana token balance')
    const previous = totals.get(mint)
    if (previous && previous.decimals !== parsed.decimals) {
      throw new SolanaRpcError('invalid-response', 'Inconsistent Solana token decimals')
    }
    totals.set(mint, {
      amount: (previous?.amount ?? 0n) + parsed.amount,
      decimals: parsed.decimals
    })
  }
  return totals
}

function resolveSolanaTokenProgram(value: unknown): SolanaTokenProgram | null {
  if (value === SOLANA_TOKEN_PROGRAMS.legacy.programId) return 'legacy'
  if (value === SOLANA_TOKEN_PROGRAMS.token2022.programId) return 'token2022'
  return null
}

function parseRpcUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Invalid Solana RPC URL')
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
    throw new Error('Solana RPC URL must be a credential-free HTTPS endpoint')
  }
  return url.toString()
}

function parseExpectedNetwork(chainIdValue: string): {
  readonly chainId: string
  readonly genesisHash: string
} {
  const chainId = parseChainId(chainIdValue)
  if (chainId.namespace !== 'solana') throw new Error('Invalid Solana chain ID')
  const network = getSolanaNetworkConfigs().find(candidate => candidate.chainId === chainId.id)
  if (!network) throw new Error('Unsupported Solana chain ID')
  return Object.freeze({ chainId: chainId.id, genesisHash: network.genesisHash })
}

function parseRpcError(value: unknown): SolanaRpcError {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['code', 'message'], ['data']) ||
    !Number.isSafeInteger(value.code) ||
    typeof value.message !== 'string' ||
    value.message.length === 0 ||
    value.message.length > 4_096
  ) {
    return new SolanaRpcError('invalid-response', 'Invalid Solana RPC error response')
  }
  return new SolanaRpcError(
    value.code === 429 || value.code === -32_005 ? 'rate-limited' : 'rpc-error',
    'Solana RPC request failed'
  )
}

function mapHttpError(status: number): SolanaRpcError {
  if (status === 401 || status === 403) {
    return new SolanaRpcError('unauthorized', 'Solana RPC authorization failed')
  }
  if (status === 429) return new SolanaRpcError('rate-limited', 'Solana RPC rate limit exceeded')
  return new SolanaRpcError('network-unavailable', 'Solana RPC endpoint is unavailable')
}

async function readResponseText(response: Response, maximumBytes: number): Promise<string> {
  return readBoundedResponseText(
    response,
    maximumBytes,
    () => new SolanaRpcError('invalid-response', 'Solana RPC response exceeds the allowed size')
  )
}

export function createSolanaRpcClient(
  config: SolanaRpcClientConfig,
  fetchImplementation: FetchImplementation = fetch
): SolanaReadRpc & SolanaBroadcastRpc {
  const expectedNetwork = parseExpectedNetwork(config.chainId)
  const rpcUrl = parseRpcUrl(config.rpcUrl)
  const timeoutMs = config.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const maximumResponseBytes = config.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAXIMUM_TIMEOUT_MS) {
    throw new Error('Invalid Solana RPC timeout')
  }
  if (
    !Number.isSafeInteger(maximumResponseBytes) ||
    maximumResponseBytes < 1_024 ||
    maximumResponseBytes > MAXIMUM_RESPONSE_BYTES
  ) {
    throw new Error('Invalid Solana RPC response limit')
  }

  let requestId = 0
  const request = async (
    method:
      | 'getGenesisHash'
      | 'getBalance'
      | 'getLatestBlockhash'
      | 'getBlockHeight'
      | 'getFeeForMessage'
      | 'simulateTransaction'
      | 'getTokenAccountsByOwner'
      | 'getMultipleAccounts'
      | 'getAccountInfo'
      | 'getSignatureStatuses'
      | 'getSignaturesForAddress'
      | 'getTransaction'
      | 'sendTransaction',
    params: readonly unknown[],
    externalSignal?: AbortSignal
  ): Promise<unknown> => {
    if (externalSignal?.aborted) {
      throw new SolanaRpcError('cancelled', 'Solana RPC request was cancelled')
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
        throw new SolanaRpcError('invalid-response', 'Solana RPC response is not valid JSON')
      }
      if (!isRecord(decoded) || decoded.jsonrpc !== '2.0' || decoded.id !== id) {
        throw new SolanaRpcError('invalid-response', 'Invalid Solana RPC response envelope')
      }
      if (Object.prototype.hasOwnProperty.call(decoded, 'error')) {
        if (!hasExactKeys(decoded, ['jsonrpc', 'id', 'error'])) {
          throw new SolanaRpcError('invalid-response', 'Invalid Solana RPC error envelope')
        }
        throw parseRpcError(decoded.error)
      }
      if (!hasExactKeys(decoded, ['jsonrpc', 'id', 'result'])) {
        throw new SolanaRpcError('invalid-response', 'Invalid Solana RPC result envelope')
      }
      return decoded.result
    } catch (error) {
      if (error instanceof SolanaRpcError) throw error
      if (controller.signal.aborted) {
        throw new SolanaRpcError(
          timedOut ? 'timeout' : 'cancelled',
          timedOut ? 'Solana RPC request timed out' : 'Solana RPC request was cancelled'
        )
      }
      throw new SolanaRpcError('network-unavailable', 'Solana RPC request failed')
    } finally {
      clearTimeout(timeout)
      externalSignal?.removeEventListener('abort', onExternalAbort)
    }
  }

  const getBalanceSnapshot = async (
    address: string,
    signal?: AbortSignal
  ): Promise<SolanaNativeBalanceResult> => {
    const result = await request(
      'getBalance',
      [parseBase58Bytes(address, 32, 'Solana address'), Object.freeze({ commitment: 'confirmed' })],
      signal
    )
    if (!isRecord(result) || !hasExactKeys(result, ['context', 'value'])) {
      throw new SolanaRpcError('invalid-response', 'Invalid Solana balance response')
    }
    return Object.freeze({
      contextSlot: parseContext(result.context),
      amountRaw: parseSafeUnsignedInteger(result.value, 'Solana balance').toString()
    })
  }

  return Object.freeze({
    assertExpectedChain: async (signal?: AbortSignal) => {
      const actual = parseBase58Bytes(
        await request('getGenesisHash', [], signal),
        32,
        'Solana genesis hash'
      )
      if (actual !== expectedNetwork.genesisHash) {
        throw new SolanaRpcError('chain-mismatch', 'Solana RPC endpoint returned the wrong chain')
      }
    },
    getBalance: async (address: string, signal?: AbortSignal) =>
      (await getBalanceSnapshot(address, signal)).amountRaw,
    getBalanceSnapshot,
    getLatestBlockhash: async (signal?: AbortSignal) => {
      const result = await request(
        'getLatestBlockhash',
        [Object.freeze({ commitment: 'confirmed' })],
        signal
      )
      if (!isRecord(result) || !hasExactKeys(result, ['context', 'value'])) {
        throw new SolanaRpcError('invalid-response', 'Invalid Solana latest blockhash response')
      }
      if (
        !isRecord(result.value) ||
        !hasExactKeys(result.value, ['blockhash', 'lastValidBlockHeight'])
      ) {
        throw new SolanaRpcError('invalid-response', 'Invalid Solana latest blockhash value')
      }
      return Object.freeze({
        contextSlot: parseContext(result.context),
        blockhash: parseBase58Bytes(result.value.blockhash, 32, 'Solana blockhash'),
        lastValidBlockHeight: parseSafeUnsignedInteger(
          result.value.lastValidBlockHeight,
          'Solana last valid block height'
        )
      })
    },
    getBlockHeight: async (signal?: AbortSignal) =>
      parseSafeUnsignedInteger(
        await request('getBlockHeight', [Object.freeze({ commitment: 'confirmed' })], signal),
        'Solana block height'
      ),
    getFeeForMessage: async (
      messageBase64: string,
      signal?: AbortSignal
    ): Promise<SolanaMessageFeeResult> => {
      parseCanonicalBase64(messageBase64, 1_232, 'Solana transaction message')
      const result = await request(
        'getFeeForMessage',
        [messageBase64, Object.freeze({ commitment: 'confirmed' })],
        signal
      )
      if (!isRecord(result) || !hasExactKeys(result, ['context', 'value'])) {
        throw new SolanaRpcError('invalid-response', 'Invalid Solana message fee response')
      }
      if (result.value === null) {
        throw new SolanaRpcError('rpc-error', 'Solana message fee is unavailable')
      }
      return Object.freeze({
        contextSlot: parseContext(result.context),
        feeLamports: parseSafeUnsignedInteger(result.value, 'Solana message fee').toString()
      })
    },
    simulateTransaction: async (
      transactionBase64: string,
      signal?: AbortSignal
    ): Promise<SolanaSimulationResult> => {
      const result = await request(
        'simulateTransaction',
        [
          parseSignedTransactionBase64(transactionBase64),
          Object.freeze({
            commitment: 'confirmed',
            encoding: 'base64',
            replaceRecentBlockhash: false,
            sigVerify: false
          })
        ],
        signal
      )
      if (!isRecord(result) || !hasExactKeys(result, ['context', 'value'])) {
        throw new SolanaRpcError('invalid-response', 'Invalid Solana simulation response')
      }
      if (
        !isRecord(result.value) ||
        !hasExactKeys(
          result.value,
          ['err', 'unitsConsumed'],
          [
            'accounts',
            'fee',
            'innerInstructions',
            'loadedAccountsDataSize',
            'loadedAddresses',
            'logs',
            'postBalances',
            'postTokenBalances',
            'preBalances',
            'preTokenBalances',
            'replacementBlockhash',
            'returnData'
          ]
        )
      ) {
        throw new SolanaRpcError('invalid-response', 'Invalid Solana simulation result')
      }
      const unitsConsumed = parseSafeUnsignedInteger(
        result.value.unitsConsumed,
        'Solana simulation units consumed'
      )
      const contextSlot = parseContext(result.context)
      if (result.value.logs !== undefined) {
        if (
          !Array.isArray(result.value.logs) ||
          result.value.logs.length > 1_000 ||
          result.value.logs.some(
            log => typeof log !== 'string' || log.length === 0 || log.length > 4_096
          )
        ) {
          throw new SolanaRpcError('invalid-response', 'Invalid Solana simulation logs')
        }
      }
      if (result.value.err !== null) {
        stringifyBoundedJson(result.value.err, 'Solana simulation error')
        throw new SolanaSimulationError(contextSlot, unitsConsumed)
      }
      return Object.freeze({ contextSlot, unitsConsumed })
    },
    getTokenAccountsByOwner: async (
      owner: string,
      program: SolanaTokenProgram,
      signal?: AbortSignal
    ) => {
      const parsedOwner = parseBase58Bytes(owner, 32, 'Solana token owner')
      if (program !== 'legacy' && program !== 'token2022') {
        throw new Error('Invalid Solana token program')
      }
      const tokenProgram = SOLANA_TOKEN_PROGRAMS[program]
      const result = await request(
        'getTokenAccountsByOwner',
        [
          parsedOwner,
          Object.freeze({ programId: tokenProgram.programId }),
          Object.freeze({ commitment: 'confirmed', encoding: 'jsonParsed' })
        ],
        signal
      )
      if (!isRecord(result) || !hasExactKeys(result, ['context', 'value'])) {
        throw new SolanaRpcError('invalid-response', 'Invalid Solana token accounts response')
      }
      if (!Array.isArray(result.value) || result.value.length > MAXIMUM_TOKEN_ACCOUNTS) {
        throw new SolanaRpcError('invalid-response', 'Invalid Solana token accounts list')
      }
      const seen = new Set<string>()
      const accounts = result.value.map(value => {
        const account = parseTokenAccount(value, parsedOwner, program)
        if (seen.has(account.accountAddress)) {
          throw new SolanaRpcError('invalid-response', 'Duplicate Solana token account')
        }
        seen.add(account.accountAddress)
        return account
      })
      return Object.freeze({
        contextSlot: parseContext(result.context),
        accounts: Object.freeze(accounts)
      })
    },
    getTokenAccountsByMints: async (
      owner: string,
      mints: readonly string[],
      signal?: AbortSignal
    ) => {
      const parsedOwner = parseBase58Bytes(owner, 32, 'Solana token owner')
      if (!Array.isArray(mints) || mints.length > MAXIMUM_MULTIPLE_ACCOUNTS) {
        throw new Error('Invalid Solana token mint inventory')
      }
      const parsedMints = mints.map(mint => parseBase58Bytes(mint, 32, 'Solana token mint'))
      if (new Set(parsedMints).size !== parsedMints.length) {
        throw new Error('Duplicate Solana token mint')
      }
      if (parsedMints.length === 0) {
        return Object.freeze({ contextSlot: 0, accounts: Object.freeze([]) })
      }
      const mintResult = await request(
        'getMultipleAccounts',
        [
          Object.freeze(parsedMints),
          Object.freeze({
            commitment: 'confirmed',
            encoding: 'base64',
            dataSlice: Object.freeze({ offset: 0, length: 0 })
          })
        ],
        signal
      )
      if (!isRecord(mintResult) || !hasExactKeys(mintResult, ['context', 'value'])) {
        throw new SolanaRpcError('invalid-response', 'Invalid Solana token mint response')
      }
      const mintContextSlot = parseContext(mintResult.context)
      if (!Array.isArray(mintResult.value) || mintResult.value.length !== parsedMints.length) {
        throw new SolanaRpcError('invalid-response', 'Invalid Solana token mint account list')
      }
      const descriptors = mintResult.value.flatMap((value, index) => {
        if (value === null) return []
        if (
          !isRecord(value) ||
          !hasExactKeys(
            value,
            ['data', 'executable', 'lamports', 'owner', 'rentEpoch'],
            ['space']
          ) ||
          value.executable !== false
        ) {
          throw new SolanaRpcError('invalid-response', 'Invalid Solana token mint account')
        }
        const program = resolveSolanaTokenProgram(value.owner)
        if (!program) return []
        const mint = parsedMints[index]
        return [
          Object.freeze({
            mint,
            program,
            accountAddress: deriveSolanaAssociatedTokenAccount(
              parsedOwner,
              mint,
              SOLANA_TOKEN_PROGRAMS[program].programId
            )
          })
        ]
      })
      if (descriptors.length === 0) {
        return Object.freeze({ contextSlot: mintContextSlot, accounts: Object.freeze([]) })
      }
      const tokenResult = await request(
        'getMultipleAccounts',
        [
          Object.freeze(descriptors.map(descriptor => descriptor.accountAddress)),
          Object.freeze({ commitment: 'confirmed', encoding: 'jsonParsed' })
        ],
        signal
      )
      if (!isRecord(tokenResult) || !hasExactKeys(tokenResult, ['context', 'value'])) {
        throw new SolanaRpcError('invalid-response', 'Invalid Solana associated token response')
      }
      const contextSlot = parseContext(tokenResult.context)
      if (!Array.isArray(tokenResult.value) || tokenResult.value.length !== descriptors.length) {
        throw new SolanaRpcError('invalid-response', 'Invalid Solana associated token account list')
      }
      const accounts = tokenResult.value.flatMap((value, index) => {
        if (value === null) return []
        const descriptor = descriptors[index]
        const account = parseTokenAccount(
          Object.freeze({ pubkey: descriptor.accountAddress, account: value }),
          parsedOwner,
          descriptor.program
        )
        if (account.mint !== descriptor.mint) {
          throw new SolanaRpcError(
            'invalid-response',
            'Solana token account returned the wrong mint'
          )
        }
        return [account]
      })
      return Object.freeze({ contextSlot, accounts: Object.freeze(accounts) })
    },
    getSignaturesForAddress: async (
      address: string,
      limit: number,
      until?: string,
      signal?: AbortSignal
    ): Promise<readonly SolanaAddressSignature[]> => {
      const parsedAddress = parseBase58Bytes(address, 32, 'Solana history address')
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAXIMUM_ADDRESS_SIGNATURES) {
        throw new Error('Invalid Solana history limit')
      }
      const parsedUntil =
        until === undefined
          ? undefined
          : parseBase58Bytes(until, 64, 'Solana history until signature')
      const result = await request(
        'getSignaturesForAddress',
        [
          parsedAddress,
          Object.freeze({
            commitment: 'confirmed',
            limit,
            ...(parsedUntil === undefined ? {} : { until: parsedUntil })
          })
        ],
        signal
      )
      if (!Array.isArray(result) || result.length > limit) {
        throw new SolanaRpcError('invalid-response', 'Invalid Solana signature history response')
      }
      const seen = new Set<string>()
      return Object.freeze(
        result.map(value => {
          if (
            !isRecord(value) ||
            typeof value.signature !== 'string' ||
            !Number.isSafeInteger(value.slot) ||
            (value.slot as number) < 0 ||
            (value.blockTime !== null &&
              (!Number.isSafeInteger(value.blockTime) || (value.blockTime as number) < 0)) ||
            (value.confirmationStatus !== 'confirmed' && value.confirmationStatus !== 'finalized')
          ) {
            throw new SolanaRpcError('invalid-response', 'Invalid Solana signature history item')
          }
          const signature = parseBase58Bytes(value.signature, 64, 'Solana transaction signature')
          if (seen.has(signature)) {
            throw new SolanaRpcError('invalid-response', 'Duplicate Solana history signature')
          }
          seen.add(signature)
          return Object.freeze({
            signature,
            slot: value.slot as number,
            blockTime: value.blockTime as number | null,
            status: value.err === null ? value.confirmationStatus : ('failed' as const)
          })
        })
      )
    },
    getTransactionSummary: async (
      signature: string,
      owner: string,
      signal?: AbortSignal
    ): Promise<SolanaTransactionSummary | null> => {
      const parsedSignature = parseBase58Bytes(signature, 64, 'Solana transaction signature')
      const parsedOwner = parseBase58Bytes(owner, 32, 'Solana history owner')
      const result = await request(
        'getTransaction',
        [
          parsedSignature,
          Object.freeze({
            commitment: 'confirmed',
            encoding: 'jsonParsed',
            maxSupportedTransactionVersion: 0
          })
        ],
        signal
      )
      if (result === null) return null
      if (
        !isRecord(result) ||
        !Number.isSafeInteger(result.slot) ||
        (result.slot as number) < 0 ||
        (result.blockTime !== null &&
          (!Number.isSafeInteger(result.blockTime) || (result.blockTime as number) < 0)) ||
        !isRecord(result.transaction) ||
        !isRecord(result.transaction.message) ||
        !Array.isArray(result.transaction.message.accountKeys) ||
        !isRecord(result.meta) ||
        !Array.isArray(result.meta.preBalances) ||
        !Array.isArray(result.meta.postBalances) ||
        result.meta.preBalances.length !== result.meta.postBalances.length ||
        typeof result.meta.fee !== 'number'
      ) {
        throw new SolanaRpcError('invalid-response', 'Invalid Solana transaction history response')
      }
      const accountKeys = result.transaction.message.accountKeys.map(parseTransactionAccountKey)
      if (accountKeys.length !== result.meta.preBalances.length) {
        throw new SolanaRpcError('invalid-response', 'Invalid Solana transaction balance list')
      }
      const ownerIndex = accountKeys.indexOf(parsedOwner)
      const nativeDelta =
        ownerIndex < 0
          ? 0n
          : parseSignedInteger(result.meta.postBalances[ownerIndex], 'Solana post balance') -
            parseSignedInteger(result.meta.preBalances[ownerIndex], 'Solana pre balance')
      const preTokens = parseOwnerTokenBalances(
        result.meta.preTokenBalances,
        parsedOwner,
        'Solana pre-token balances'
      )
      const postTokens = parseOwnerTokenBalances(
        result.meta.postTokenBalances,
        parsedOwner,
        'Solana post-token balances'
      )
      const mints = new Set([...preTokens.keys(), ...postTokens.keys()])
      const tokenDeltas: SolanaTransactionTokenDelta[] = []
      for (const mint of mints) {
        const pre = preTokens.get(mint)
        const post = postTokens.get(mint)
        if (pre && post && pre.decimals !== post.decimals) {
          throw new SolanaRpcError('invalid-response', 'Inconsistent Solana token decimals')
        }
        const delta = (post?.amount ?? 0n) - (pre?.amount ?? 0n)
        if (delta === 0n) continue
        const tokenBalance = post ?? pre
        if (!tokenBalance) {
          throw new SolanaRpcError('invalid-response', 'Missing Solana token balance')
        }
        tokenDeltas.push(
          Object.freeze({ mint, amountRaw: delta.toString(), decimals: tokenBalance.decimals })
        )
      }
      return Object.freeze({
        signature: parsedSignature,
        slot: result.slot as number,
        blockTime: result.blockTime as number | null,
        failed: result.meta.err !== null,
        feeRaw: parseSafeUnsignedInteger(result.meta.fee, 'Solana transaction fee').toString(),
        nativeDeltaRaw: nativeDelta.toString(),
        tokenDeltas: Object.freeze(tokenDeltas)
      })
    },
    getAddressLookupTable: async (address: string, signal?: AbortSignal) => {
      const parsedAddress = parseBase58Bytes(address, 32, 'Solana address lookup table address')
      const result = await request(
        'getAccountInfo',
        [parsedAddress, Object.freeze({ commitment: 'confirmed', encoding: 'base64' })],
        signal
      )
      if (!isRecord(result) || !hasExactKeys(result, ['context', 'value'])) {
        throw new SolanaRpcError('invalid-response', 'Invalid Solana account information response')
      }
      const contextSlot = parseContext(result.context)
      if (result.value === null) return null
      const account = result.value
      if (
        !isRecord(account) ||
        !hasExactKeys(
          account,
          ['data', 'executable', 'lamports', 'owner', 'rentEpoch'],
          ['space']
        ) ||
        account.executable !== false ||
        account.owner !== SOLANA_ADDRESS_LOOKUP_TABLE_PROGRAM ||
        !Array.isArray(account.data) ||
        account.data.length !== 2 ||
        account.data[1] !== 'base64'
      ) {
        throw new SolanaRpcError('invalid-response', 'Invalid Solana address lookup table account')
      }
      const data = parseCanonicalBase64(
        account.data[0],
        SOLANA_LOOKUP_TABLE_META_BYTES + SOLANA_LOOKUP_TABLE_MAX_ADDRESSES * 32,
        'Solana address lookup table data'
      )
      if (account.space !== undefined && account.space !== data.byteLength) {
        throw new SolanaRpcError('invalid-response', 'Invalid Solana address lookup table size')
      }
      return parseAddressLookupTableData(data, parsedAddress, contextSlot)
    },
    getSignatureStatus: async (signature: string, signal?: AbortSignal) => {
      const parsedSignature = parseBase58Bytes(signature, 64, 'Solana transaction signature')
      const result = await request(
        'getSignatureStatuses',
        [[parsedSignature], Object.freeze({ searchTransactionHistory: true })],
        signal
      )
      if (!isRecord(result) || !hasExactKeys(result, ['context', 'value'])) {
        throw new SolanaRpcError('invalid-response', 'Invalid Solana signature status response')
      }
      const contextSlot = parseContext(result.context)
      if (!Array.isArray(result.value) || result.value.length !== 1) {
        throw new SolanaRpcError('invalid-response', 'Invalid Solana signature status list')
      }
      const status = result.value[0]
      if (status === null) return Object.freeze({ status: 'unknown', contextSlot })
      if (
        !isRecord(status) ||
        !hasExactKeys(status, ['slot', 'confirmations', 'err', 'status', 'confirmationStatus']) ||
        (status.confirmations !== null &&
          (!Number.isSafeInteger(status.confirmations) || (status.confirmations as number) < 0)) ||
        (status.confirmationStatus !== null &&
          status.confirmationStatus !== 'processed' &&
          status.confirmationStatus !== 'confirmed' &&
          status.confirmationStatus !== 'finalized')
      ) {
        throw new SolanaRpcError('invalid-response', 'Invalid Solana signature status')
      }
      const failed = status.err !== null
      const errorJson = failed ? stringifyBoundedJson(status.err, 'Solana transaction error') : null
      const expectedStatus = failed
        ? isRecord(status.status) &&
          hasExactKeys(status.status, ['Err']) &&
          stringifyBoundedJson(status.status.Err, 'Solana transaction status error') === errorJson
        : isRecord(status.status) &&
          hasExactKeys(status.status, ['Ok']) &&
          status.status.Ok === null
      if (!expectedStatus) {
        throw new SolanaRpcError('invalid-response', 'Invalid Solana signature result')
      }
      const confirmationStatus = status.confirmationStatus ?? 'processed'
      return Object.freeze({
        status: failed ? 'failed' : confirmationStatus,
        contextSlot,
        slot: parseSafeUnsignedInteger(status.slot, 'Solana transaction slot'),
        confirmations: status.confirmations as number | null
      })
    },
    broadcastSignedTransaction: async (
      transactionBase64: string,
      signal?: AbortSignal,
      options?: SolanaBroadcastOptions
    ) =>
      parseBase58Bytes(
        await request(
          'sendTransaction',
          [
            parseSignedTransactionBase64(transactionBase64),
            Object.freeze({
              encoding: 'base64',
              skipPreflight: options?.skipPreflight ?? false,
              preflightCommitment: options?.preflightCommitment ?? 'confirmed',
              maxRetries: options?.maxRetries ?? 3,
              ...(options?.minContextSlot === undefined
                ? {}
                : { minContextSlot: options.minContextSlot })
            })
          ],
          signal
        ),
        64,
        'Solana transaction signature'
      )
  })
}
