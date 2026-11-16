import {
  createBitcoinEsploraClient,
  type BitcoinActivityHistoryRpc,
  type BitcoinDiscoveryRpc,
  type BitcoinEsploraClientConfig,
  type BitcoinTransactionRpc
} from './bitcoin-esplora-client'
import { BitcoinRpcError } from './bitcoin-esplora-error'

const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1_000
const TRANSIENT_FAILURE_COOLDOWN_MS = 30 * 1_000
const MAXIMUM_RATE_LIMIT_COOLDOWN_MS = 60 * 60 * 1_000
const MINIMUM_RATE_LIMIT_COOLDOWN_MS = 1_000
const DEFAULT_MINIMUM_REQUEST_INTERVAL_MS = 250
const MAXIMUM_MINIMUM_REQUEST_INTERVAL_MS = 10_000
const MAXIMUM_ENDPOINTS = 5

interface BitcoinEsploraEndpoint {
  readonly id: string
  readonly baseUrl: string
}

export interface BitcoinEsploraFailoverClientConfig {
  readonly chainId: string
  readonly endpoints: readonly BitcoinEsploraEndpoint[]
  readonly timeoutMs?: number
  readonly maximumResponseBytes?: number
  readonly defaultRateLimitCooldownMs?: number
  readonly maximumRateLimitCooldownMs?: number
  readonly minimumRequestIntervalMs?: number
}

interface BitcoinEsploraFailoverDependencies {
  readonly fetchImplementation?: (input: string, init: RequestInit) => Promise<Response>
  readonly now?: () => number
  readonly delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
}

interface EndpointState {
  readonly client: BitcoinDiscoveryRpc & BitcoinTransactionRpc & BitcoinActivityHistoryRpc
  attested: boolean
  readonly attestations: Map<AbortSignal | undefined, Promise<void>>
  blockedUntil: number
}

function parseDuration(value: number | undefined, fallback: number, label: string): number {
  const parsed = value ?? fallback
  if (!Number.isSafeInteger(parsed) || parsed < MINIMUM_RATE_LIMIT_COOLDOWN_MS) {
    throw new Error(`Invalid ${label}`)
  }
  return parsed
}

function parseMinimumRequestInterval(value: number | undefined): number {
  const interval = value ?? DEFAULT_MINIMUM_REQUEST_INTERVAL_MS
  if (
    !Number.isSafeInteger(interval) ||
    interval < 0 ||
    interval > MAXIMUM_MINIMUM_REQUEST_INTERVAL_MS
  ) {
    throw new Error('Invalid Bitcoin RPC minimum request interval')
  }
  return interval
}

function defaultDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve()
  if (signal?.aborted) return Promise.reject(new Error('Bitcoin RPC request was cancelled'))
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      reject(new Error('Bitcoin RPC request was cancelled'))
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function createRequestStartPacer(
  minimumIntervalMs: number,
  now: () => number,
  delay: (milliseconds: number, signal?: AbortSignal) => Promise<void>
): (signal?: AbortSignal) => Promise<void> {
  if (minimumIntervalMs === 0) {
    return signal => {
      if (signal?.aborted) {
        return Promise.reject(new BitcoinRpcError('cancelled', 'Bitcoin RPC request was cancelled'))
      }
      return Promise.resolve()
    }
  }
  let nextRequestAt = 0
  let startGate = Promise.resolve()

  return signal => {
    const waitForStart = async (): Promise<void> => {
      if (signal?.aborted) {
        throw new BitcoinRpcError('cancelled', 'Bitcoin RPC request was cancelled')
      }
      const timestamp = now()
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
        throw new Error('Invalid Bitcoin RPC clock')
      }
      try {
        await delay(Math.max(0, nextRequestAt - timestamp), signal)
      } catch (error) {
        if (signal?.aborted) {
          throw new BitcoinRpcError('cancelled', 'Bitcoin RPC request was cancelled')
        }
        throw error
      }
      if (signal?.aborted) {
        throw new BitcoinRpcError('cancelled', 'Bitcoin RPC request was cancelled')
      }
      const startedAt = now()
      if (!Number.isSafeInteger(startedAt) || startedAt < timestamp) {
        throw new Error('Invalid Bitcoin RPC clock')
      }
      nextRequestAt = startedAt + minimumIntervalMs
    }
    const ready = startGate.then(waitForStart, waitForStart)
    startGate = ready.then(
      () => undefined,
      () => undefined
    )
    return ready
  }
}

function parseEndpoints(
  config: BitcoinEsploraFailoverClientConfig,
  fetchImplementation: (input: string, init: RequestInit) => Promise<Response>
): EndpointState[] {
  if (
    !Array.isArray(config.endpoints) ||
    config.endpoints.length < 1 ||
    config.endpoints.length > MAXIMUM_ENDPOINTS
  ) {
    throw new Error('Bitcoin Esplora failover requires one to five endpoints')
  }

  const ids = new Set<string>()
  const urls = new Set<string>()
  return config.endpoints.map(endpoint => {
    if (
      typeof endpoint !== 'object' ||
      endpoint === null ||
      typeof endpoint.id !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(endpoint.id) ||
      ids.has(endpoint.id)
    ) {
      throw new Error('Invalid Bitcoin Esplora endpoint ID')
    }
    ids.add(endpoint.id)

    const clientConfig: BitcoinEsploraClientConfig = {
      chainId: config.chainId,
      baseUrl: endpoint.baseUrl,
      ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
      ...(config.maximumResponseBytes === undefined
        ? {}
        : { maximumResponseBytes: config.maximumResponseBytes })
    }
    const client = createBitcoinEsploraClient(clientConfig, fetchImplementation)
    const normalizedUrl = new URL(endpoint.baseUrl)
    if (!normalizedUrl.pathname.endsWith('/')) normalizedUrl.pathname += '/'
    const baseUrl = normalizedUrl.toString()
    if (urls.has(baseUrl)) throw new Error('Duplicate Bitcoin Esplora endpoint URL')
    urls.add(baseUrl)

    return {
      client,
      attested: false,
      attestations: new Map(),
      blockedUntil: 0
    }
  })
}

function isRateLimited(error: unknown): error is BitcoinRpcError {
  return error instanceof BitcoinRpcError && error.code === 'rate-limited'
}

function isRetryableEndpointFailure(error: unknown): error is BitcoinRpcError {
  return (
    error instanceof BitcoinRpcError &&
    (error.code === 'rate-limited' ||
      error.code === 'network-unavailable' ||
      error.code === 'timeout' ||
      // The bundled endpoints are credential-free public Esplora instances, so a
      // 401/403 never means "wrong credentials" — it is a CDN/anti-bot soft block
      // (e.g. Cloudflare on blockstream.info returning 403 to extension fetches).
      // Cool the endpoint down and fail over to a healthy provider instead of
      // surfacing the whole read as a hard authorization failure.
      error.code === 'unauthorized')
  )
}

export function createBitcoinEsploraFailoverClient(
  config: BitcoinEsploraFailoverClientConfig,
  dependencies: BitcoinEsploraFailoverDependencies = {}
): BitcoinDiscoveryRpc & BitcoinTransactionRpc & BitcoinActivityHistoryRpc {
  const fetchImplementation = dependencies.fetchImplementation ?? fetch
  const now = dependencies.now ?? Date.now
  const minimumRequestIntervalMs = parseMinimumRequestInterval(config.minimumRequestIntervalMs)
  const paceRequestStart = createRequestStartPacer(
    minimumRequestIntervalMs,
    now,
    dependencies.delay ?? defaultDelay
  )
  const defaultCooldownMs = parseDuration(
    config.defaultRateLimitCooldownMs,
    DEFAULT_RATE_LIMIT_COOLDOWN_MS,
    'Bitcoin RPC rate-limit cooldown'
  )
  const maximumCooldownMs = parseDuration(
    config.maximumRateLimitCooldownMs,
    MAXIMUM_RATE_LIMIT_COOLDOWN_MS,
    'Bitcoin RPC maximum rate-limit cooldown'
  )
  if (maximumCooldownMs < defaultCooldownMs) {
    throw new Error('Bitcoin RPC maximum rate-limit cooldown is too small')
  }

  const endpoints = parseEndpoints(config, fetchImplementation)
  let activeIndex = 0
  let lastBlockedError: BitcoinRpcError | undefined

  const markRateLimited = (state: EndpointState, error: BitcoinRpcError): void => {
    const requestedCooldown =
      error.retryAfterMs === undefined || error.retryAfterMs < MINIMUM_RATE_LIMIT_COOLDOWN_MS
        ? defaultCooldownMs
        : error.retryAfterMs
    state.blockedUntil = now() + Math.min(requestedCooldown, maximumCooldownMs)
  }

  const markTransientFailure = (state: EndpointState): void => {
    state.blockedUntil = now() + TRANSIENT_FAILURE_COOLDOWN_MS
  }

  const orderedAvailableIndices = (): number[] => {
    const currentTime = now()
    const indices: number[] = []
    for (let offset = 0; offset < endpoints.length; offset += 1) {
      const index = (activeIndex + offset) % endpoints.length
      if (endpoints[index].blockedUntil <= currentTime) indices.push(index)
    }
    return indices
  }

  const run = async <T>(
    operation: (state: EndpointState) => Promise<T>,
    signal?: AbortSignal,
    attest = true
  ): Promise<T> => {
    if (signal?.aborted) {
      throw new BitcoinRpcError('cancelled', 'Bitcoin RPC request was cancelled')
    }

    let lastRetryableError: BitcoinRpcError | undefined
    for (const index of orderedAvailableIndices()) {
      const state = endpoints[index]
      if (state.blockedUntil > now()) continue
      try {
        if (attest && !state.attested) {
          const existingAttestation = state.attestations.get(signal)
          const attestation =
            existingAttestation ??
            paceRequestStart(signal)
              .then(() => state.client.assertExpectedChain(signal))
              .then(() => {
                state.attested = true
              })
              .finally(() => {
                state.attestations.delete(signal)
              })
          if (!existingAttestation) state.attestations.set(signal, attestation)
          await attestation
        }
        await paceRequestStart(signal)
        const result = await operation(state)
        activeIndex = index
        return result
      } catch (error) {
        if (!isRetryableEndpointFailure(error)) throw error
        if (isRateLimited(error)) markRateLimited(state, error)
        else markTransientFailure(state)
        lastRetryableError = error
        lastBlockedError = error
      }
    }

    throw (
      lastRetryableError ??
      lastBlockedError ??
      new BitcoinRpcError('rate-limited', 'All Bitcoin RPC endpoints are cooling down')
    )
  }

  return Object.freeze({
    assertExpectedChain: async (signal?: AbortSignal) =>
      run(
        async state => {
          if (state.attested) return
          await state.client.assertExpectedChain(signal)
          state.attested = true
        },
        signal,
        false
      ),
    getTipHeight: async (signal?: AbortSignal) =>
      run(state => state.client.getTipHeight(signal), signal),
    getAddressActivity: async (address: string, signal?: AbortSignal) =>
      run(state => state.client.getAddressActivity(address, signal), signal),
    getAddressUtxos: async (address: string, signal?: AbortSignal) =>
      run(state => state.client.getAddressUtxos(address, signal), signal),
    getAddressTransactions: async (address: string, signal?: AbortSignal) =>
      run(state => state.client.getAddressTransactions(address, signal), signal),
    getFeeEstimates: async (signal?: AbortSignal) =>
      run(state => state.client.getFeeEstimates(signal), signal),
    broadcastRawTransaction: async (rawTransactionHex: string, signal?: AbortSignal) =>
      run(state => state.client.broadcastRawTransaction(rawTransactionHex, signal), signal),
    getTransactionStatus: async (transactionId: string, signal?: AbortSignal) =>
      run(state => state.client.getTransactionStatus(transactionId, signal), signal),
    getRawTransaction: async (transactionId: string, signal?: AbortSignal) =>
      run(state => state.client.getRawTransaction(transactionId, signal), signal),
    getOutputSpendStatus: async (
      transactionId: string,
      outputIndex: number,
      signal?: AbortSignal
    ) => run(state => state.client.getOutputSpendStatus(transactionId, outputIndex, signal), signal)
  })
}
