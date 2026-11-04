import type { RpcEndpointOption } from './rpc-endpoints'
import { isCustomRpcEndpointId } from './custom-rpc'
import { isValidMarginalFeeZats } from './fee'

export const RPC_REGISTRY_URL = 'https://rpc.zknoir.com/v1/rpc-endpoints'
export const RPC_PROBE_TIMEOUT_MS = 5_000
const RPC_REGISTRY_FETCH_TIMEOUT_MS = 3_000
const MAX_GRPC_WEB_RESPONSE_BYTES = 1_048_576

export interface RpcRegistryChain {
  id: string
  chain: string
  network: string
  label: string
  iconChain: string
  endpoints: RpcEndpointOption[]
}

export interface RpcRegistryDocument {
  version: 1
  updatedAt: string
  chains: RpcRegistryChain[]
}

export type RpcProbeFunction = (endpoint: RpcEndpointOption) => Promise<number>

export function parseRpcRegistryDocument(value: unknown): RpcRegistryDocument | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<RpcRegistryDocument>
  if (candidate.version !== 1 || typeof candidate.updatedAt !== 'string') return null
  if (!Array.isArray(candidate.chains) || candidate.chains.length === 0) return null

  const chainIds = new Set<string>()
  const chains: RpcRegistryChain[] = []
  for (const rawChain of candidate.chains) {
    if (!rawChain || typeof rawChain !== 'object') return null
    const chain = rawChain as Partial<RpcRegistryChain>
    if (
      !isNonEmptyString(chain.id) ||
      !isNonEmptyString(chain.chain) ||
      !isNonEmptyString(chain.network) ||
      !isNonEmptyString(chain.label) ||
      !isNonEmptyString(chain.iconChain) ||
      !Array.isArray(chain.endpoints) ||
      chain.endpoints.length === 0 ||
      chainIds.has(chain.id)
    ) {
      return null
    }

    const endpointIds = new Set<string>()
    const endpoints: RpcEndpointOption[] = []
    for (const rawEndpoint of chain.endpoints) {
      if (!rawEndpoint || typeof rawEndpoint !== 'object') return null
      const endpoint = rawEndpoint as Partial<RpcEndpointOption>
      if (
        !isNonEmptyString(endpoint.id) ||
        !isNonEmptyString(endpoint.label) ||
        !isSafeRpcUrl(endpoint.url) ||
        isCustomRpcEndpointId(endpoint.id) ||
        endpointIds.has(endpoint.id)
      ) {
        return null
      }
      endpointIds.add(endpoint.id)
      endpoints.push({
        id: endpoint.id,
        label: endpoint.label,
        url: new URL(endpoint.url).origin
      })
    }

    chainIds.add(chain.id)
    chains.push({
      id: chain.id,
      chain: chain.chain,
      network: chain.network,
      label: chain.label,
      iconChain: chain.iconChain,
      endpoints
    })
  }

  return { version: 1, updatedAt: candidate.updatedAt, chains }
}

export async function fetchRpcRegistry(
  fetchFunction: typeof fetch = fetch
): Promise<RpcRegistryDocument> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RPC_REGISTRY_FETCH_TIMEOUT_MS)
  try {
    const response = await fetchFunction(RPC_REGISTRY_URL, {
      cache: 'no-store',
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`RPC registry returned HTTP ${response.status}`)
    const registry = parseRpcRegistryDocument(await response.json())
    if (!registry) throw new Error('RPC registry returned an invalid document')
    return registry
  } finally {
    clearTimeout(timer)
  }
}

export async function selectPreferredRpcEndpoint(
  endpoints: RpcEndpointOption[],
  persistedEndpointId: string | undefined,
  probe: RpcProbeFunction = probeRpcEndpoint
): Promise<RpcEndpointOption> {
  const persisted = endpoints.find(endpoint => endpoint.id === persistedEndpointId)
  if (persisted) return persisted
  if (endpoints.length === 0) throw new Error('No RPC endpoints configured')

  const results = await Promise.all(
    endpoints.map(async (endpoint, index) => {
      try {
        return { endpoint, index, latencyMs: await probe(endpoint) }
      } catch {
        return null
      }
    })
  )
  const reachable = results
    .filter(result => result !== null)
    .sort((left, right) => left.latencyMs - right.latencyMs || left.index - right.index)

  return reachable[0]?.endpoint ?? endpoints[0]
}

export async function probeRpcEndpoint(
  endpoint: RpcEndpointOption,
  fetchFunction: typeof fetch = fetch,
  timeoutMs = RPC_PROBE_TIMEOUT_MS
): Promise<number> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = performance.now()
  try {
    const response = await fetchFunction(
      `${endpoint.url}/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLatestBlock`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/grpc-web+proto',
          'x-grpc-web': '1'
        },
        body: new Uint8Array(5),
        cache: 'no-store',
        signal: controller.signal
      }
    )
    if (response.status !== 200) throw new Error(`RPC probe returned HTTP ${response.status}`)
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (!/^application\/grpc-web(?:\+proto)?(?:;|$)/.test(contentType)) {
      throw new Error(`RPC probe returned ${contentType || 'no content type'}`)
    }

    assertSuccessfulGrpcWebResponse(await readBoundedGrpcWebResponse(response))
    return Math.round(performance.now() - startedAt)
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchLatestBlockHeight(
  rpcUrl: string,
  fetchFunction: typeof fetch = fetch,
  timeoutMs = RPC_PROBE_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<number> {
  const dataFrames = await fetchGrpcWebData(
    rpcUrl,
    'GetLatestBlock',
    new Uint8Array(5),
    fetchFunction,
    timeoutMs,
    signal
  )
  if (dataFrames.length !== 1) throw new Error('RPC latest block returned multiple data frames')
  return readLatestBlockHeight(dataFrames[0])
}

export async function fetchStandardMarginalFee(
  rpcUrl: string,
  fetchFunction: typeof fetch = fetch,
  timeoutMs = RPC_PROBE_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<number> {
  const frames = await fetchGrpcWebData(
    rpcUrl,
    'GetStandardFee',
    new Uint8Array(5),
    fetchFunction,
    timeoutMs,
    signal
  )
  if (frames.length !== 1) throw new Error('RPC standard fee returned multiple data frames')
  const message = frames[0]
  let offset = 0
  let fee: number | undefined
  while (offset < message.length) {
    const tag = readVarint(message, offset)
    offset = tag.next
    if (tag.value > 0xffffffff) throw new Error('RPC standard fee returned an invalid field')
    const field = Math.floor(tag.value / 8)
    const wireType = tag.value % 8
    if (field === 0) throw new Error('RPC standard fee returned an invalid field')
    if (wireType === 0) {
      let value = 0n
      let count = 0
      while (true) {
        if (offset >= message.length || count >= 10) throw new Error('Invalid standard fee varint')
        const byte = message[offset++]
        if (count === 9 && byte > 1) throw new Error('Invalid standard fee varint')
        value |= BigInt(byte & 0x7f) << BigInt(count++ * 7)
        if ((byte & 0x80) === 0) break
      }
      if (field === 1) {
        if (fee !== undefined) throw new Error('RPC standard fee returned duplicate fees')
        fee = Number(value)
        if (!isValidMarginalFeeZats(fee)) throw new Error('RPC returned an invalid standard fee')
      }
    } else if (field === 1) {
      throw new Error('RPC returned an invalid standard fee field')
    } else if (wireType === 1) {
      offset += 8
    } else if (wireType === 5) {
      offset += 4
    } else if (wireType === 2) {
      const length = readVarint(message, offset)
      offset = length.next + length.value
    } else {
      throw new Error('RPC standard fee returned an unsupported field')
    }
    if (offset > message.length) throw new Error('RPC standard fee returned a truncated response')
  }
  if (fee === undefined) throw new Error('RPC returned no standard fee')
  return fee
}

export async function fetchBlockTime(
  rpcUrl: string,
  height: number,
  fetchFunction: typeof fetch = fetch,
  timeoutMs = RPC_PROBE_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<number> {
  if (!Number.isSafeInteger(height) || height <= 0 || height > 0xffffffff) {
    throw new Error('Invalid block height')
  }
  const blockId = Uint8Array.from([0x08, ...encodeVarint(height)])
  const request = new Uint8Array(5 + blockId.length)
  new DataView(request.buffer).setUint32(1, blockId.length)
  request.set(blockId, 5)
  const dataFrames = await fetchGrpcWebData(
    rpcUrl,
    'GetBlock',
    request,
    fetchFunction,
    timeoutMs,
    signal
  )
  if (dataFrames.length !== 1) throw new Error('RPC block returned multiple data frames')
  return readBlockTime(dataFrames[0], height)
}

async function fetchGrpcWebData(
  rpcUrl: string,
  method: string,
  body: Uint8Array,
  fetchFunction: typeof fetch,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<Uint8Array[]> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('RPC request timed out')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    if (signal?.aborted) controller.abort()
    const baseUrl = rpcUrl.replace(/\/+$/, '')
    const response = await fetchFunction(
      `${baseUrl}/cash.z.wallet.sdk.rpc.CompactTxStreamer/${method}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/grpc-web+proto',
          'x-grpc-web': '1'
        },
        body: new Uint8Array(body),
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal
      }
    )
    if (response.status !== 200) {
      throw new Error(`RPC ${method} returned HTTP ${response.status}`)
    }
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (!/^application\/grpc-web(?:\+proto)?(?:;|$)/.test(contentType)) {
      throw new Error(`RPC ${method} returned ${contentType || 'no content type'}`)
    }

    return parseSuccessfulGrpcWebResponse(await readBoundedGrpcWebResponse(response))
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

export async function verifyZcashRpcEndpoint(
  endpoint: RpcEndpointOption,
  expectedNetwork: 'mainnet' | 'testnet',
  fetchFunction: typeof fetch = fetch,
  timeoutMs = RPC_PROBE_TIMEOUT_MS
): Promise<number> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = performance.now()
  try {
    const response = await fetchFunction(
      `${endpoint.url}/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLightdInfo`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/grpc-web+proto',
          'x-grpc-web': '1'
        },
        body: new Uint8Array(5),
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal
      }
    )
    if (response.status !== 200)
      throw new Error(`RPC verification returned HTTP ${response.status}`)
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (!/^application\/grpc-web(?:\+proto)?(?:;|$)/.test(contentType)) {
      throw new Error(`RPC verification returned ${contentType || 'no content type'}`)
    }

    const dataFrames = parseSuccessfulGrpcWebResponse(await readBoundedGrpcWebResponse(response))
    const chainName = readLightdChainName(dataFrames[0])
    const expectedChainName = expectedNetwork === 'mainnet' ? 'main' : 'test'
    if (chainName !== expectedChainName) {
      throw new Error(
        `RPC endpoint is for ${chainName || 'an unknown network'}, not ${expectedNetwork}`
      )
    }
    return Math.round(performance.now() - startedAt)
  } finally {
    clearTimeout(timer)
  }
}

async function readBoundedGrpcWebResponse(response: Response): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > MAX_GRPC_WEB_RESPONSE_BYTES) {
    throw new Error('RPC response is too large')
  }

  if (!response.body) {
    const body = new Uint8Array(await response.arrayBuffer())
    if (body.byteLength > MAX_GRPC_WEB_RESPONSE_BYTES) {
      throw new Error('RPC response is too large')
    }
    return body
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalLength = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalLength += value.byteLength
      if (totalLength > MAX_GRPC_WEB_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error('RPC response is too large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const body = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

function parseSuccessfulGrpcWebResponse(body: Uint8Array): Uint8Array[] {
  let offset = 0
  const dataFrames: Uint8Array[] = []
  let grpcStatus: string | undefined
  while (offset < body.length) {
    if (body.length - offset < 5) throw new Error('RPC probe returned a truncated frame')
    const flags = body[offset]
    if (flags !== 0 && flags !== 0x80) throw new Error('RPC probe returned invalid frame flags')
    const length = new DataView(body.buffer, body.byteOffset + offset + 1, 4).getUint32(0)
    offset += 5
    if (length > body.length - offset) throw new Error('RPC probe returned a truncated payload')
    const payload = body.subarray(offset, offset + length)
    offset += length

    if ((flags & 0x80) === 0) {
      dataFrames.push(payload)
      continue
    }
    const trailers = new TextDecoder().decode(payload)
    grpcStatus = trailers.match(/(?:^|\r?\n)grpc-status:\s*([^\r\n]+)/i)?.[1]?.trim()
  }

  if (dataFrames.length === 0) throw new Error('RPC probe returned no data frame')
  if (grpcStatus !== '0')
    throw new Error(`RPC probe returned gRPC status ${grpcStatus ?? 'missing'}`)
  return dataFrames
}

function assertSuccessfulGrpcWebResponse(body: Uint8Array): void {
  parseSuccessfulGrpcWebResponse(body)
}

function readVarint(bytes: Uint8Array, start: number): { value: number; next: number } {
  let value = 0
  let shift = 0
  for (let offset = start; offset < bytes.length && offset < start + 5; offset += 1) {
    const byte = bytes[offset]
    value += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return { value, next: offset + 1 }
    shift += 7
  }
  throw new Error('RPC endpoint returned an invalid protobuf response')
}

function encodeVarint(value: number): number[] {
  const bytes: number[] = []
  do {
    const byte = value % 128
    value = Math.floor(value / 128)
    bytes.push(value > 0 ? byte | 0x80 : byte)
  } while (value > 0)
  return bytes
}

function readBlockTime(message: Uint8Array, expectedHeight: number): number {
  let offset = 0
  let height: number | undefined
  let time: number | undefined
  while (offset < message.length) {
    const tag = readVarint(message, offset)
    offset = tag.next
    const field = tag.value >>> 3
    const wireType = tag.value & 7
    if (field === 0) throw new Error('RPC endpoint returned an invalid protobuf response')
    if (field === 2 || field === 5) {
      if (wireType !== 0) throw new Error('RPC endpoint returned an invalid block field')
      const result = readVarint(message, offset)
      offset = result.next
      if (field === 2) {
        if (height !== undefined) throw new Error('RPC endpoint returned duplicate block height')
        height = result.value
      } else {
        if (time !== undefined) throw new Error('RPC endpoint returned duplicate block time')
        time = result.value
      }
      continue
    }
    if (wireType === 0) {
      offset = readVarint(message, offset).next
    } else if (wireType === 1) {
      offset += 8
    } else if (wireType === 5) {
      offset += 4
    } else if (wireType === 2) {
      const length = readVarint(message, offset)
      offset = length.next + length.value
    } else {
      throw new Error('RPC endpoint returned an unsupported protobuf field')
    }
    if (offset > message.length)
      throw new Error('RPC endpoint returned a truncated protobuf response')
  }
  if (height !== expectedHeight) throw new Error('RPC endpoint returned the wrong block height')
  if (time === undefined || time <= 0 || time > 0xffffffff) {
    throw new Error('RPC endpoint returned an invalid block time')
  }
  return time
}

function readLightdChainName(message: Uint8Array): string {
  let offset = 0
  while (offset < message.length) {
    const tag = readVarint(message, offset)
    offset = tag.next
    const field = tag.value >>> 3
    const wireType = tag.value & 7
    if (wireType === 0) {
      offset = readVarint(message, offset).next
      continue
    }
    if (wireType === 1) {
      offset += 8
      continue
    }
    if (wireType === 5) {
      offset += 4
      continue
    }
    if (wireType !== 2) throw new Error('RPC endpoint returned an unsupported protobuf field')
    const length = readVarint(message, offset)
    const end = length.next + length.value
    if (end > message.length) throw new Error('RPC endpoint returned a truncated protobuf response')
    if (field === 4) {
      const value = new TextDecoder('utf-8', { fatal: true }).decode(
        message.subarray(length.next, end)
      )
      if (!value || value.length > 32)
        throw new Error('RPC endpoint returned an invalid chain name')
      return value
    }
    offset = end
  }
  throw new Error('RPC endpoint did not report its network')
}

function readLatestBlockHeight(message: Uint8Array): number {
  let offset = 0
  while (offset < message.length) {
    const tag = readVarint(message, offset)
    offset = tag.next
    const field = tag.value >>> 3
    const wireType = tag.value & 7
    if (wireType === 0) {
      const value = readVarint(message, offset)
      offset = value.next
      if (field === 1 && Number.isSafeInteger(value.value) && value.value > 0) {
        return value.value
      }
      continue
    }
    if (wireType === 1) {
      offset += 8
      continue
    }
    if (wireType === 5) {
      offset += 4
      continue
    }
    if (wireType !== 2) throw new Error('RPC endpoint returned an unsupported protobuf field')
    const length = readVarint(message, offset)
    offset = length.next + length.value
    if (offset > message.length) {
      throw new Error('RPC endpoint returned a truncated protobuf response')
    }
  }
  throw new Error('RPC endpoint did not report its latest block height')
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isSafeRpcUrl(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.pathname === '/' || url.pathname === '')
    )
  } catch {
    return false
  }
}
