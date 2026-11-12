import { DEFAULT_REQUEST_TIMEOUT_MS } from '@/config/extension'
import { parseChainId } from '@/core/chains/registry'
import {
  normalizeStarknetFelt,
  starknetFeltChainIdForReference,
  starknetSpecVersionMeetsMinimum,
  type StarknetProductChainReference
} from '@/core/chains/starknet/identifiers'
import { readBoundedResponseText } from '@/lib/fetch-utils'

export interface AttestStarknetRpcEndpointInput {
  readonly chainId: string
  readonly rpcUrl: string
  readonly signal?: AbortSignal
}

const MAXIMUM_RESPONSE_BYTES = 16_384

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readStarknetString(
  rpcUrl: string,
  method: 'starknet_chainId' | 'starknet_specVersion',
  signal: AbortSignal
): Promise<string> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    signal
  })
  if (!response.ok) throw new Error('Starknet RPC endpoint is unavailable')
  const text = await readBoundedResponseText(
    response,
    MAXIMUM_RESPONSE_BYTES,
    () => new Error('Starknet RPC response is too large')
  )
  let decoded: unknown
  try {
    decoded = JSON.parse(text)
  } catch {
    throw new Error('Starknet RPC returned an invalid response')
  }
  if (
    !isRecord(decoded) ||
    decoded.jsonrpc !== '2.0' ||
    decoded.id !== 1 ||
    typeof decoded.result !== 'string' ||
    Object.prototype.hasOwnProperty.call(decoded, 'error')
  ) {
    throw new Error('Starknet RPC returned an invalid response')
  }
  return decoded.result
}

function reportedChainMatches(result: string, reference: StarknetProductChainReference): boolean {
  if (result === reference) return true
  const expected = starknetFeltChainIdForReference(reference)
  try {
    return normalizeStarknetFelt(result) === expected
  } catch {
    return false
  }
}

export async function attestStarknetRpcEndpoint(
  input: AttestStarknetRpcEndpointInput
): Promise<void> {
  const chainId = parseChainId(input.chainId)
  const expectedFelt = starknetFeltChainIdForReference(chainId.reference)
  if (chainId.namespace !== 'starknet' || expectedFelt === undefined) {
    throw new Error('Starknet RPC attestation requires a registered Starknet chain')
  }
  const reference = chainId.reference as StarknetProductChainReference
  if (input.signal?.aborted) throw new Error('Starknet RPC request was cancelled')

  const controller = new AbortController()
  const onAbort = () => controller.abort()
  input.signal?.addEventListener('abort', onAbort, { once: true })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, DEFAULT_REQUEST_TIMEOUT_MS)
  try {
    const [reportedChainId, specVersion] = await Promise.all([
      readStarknetString(input.rpcUrl, 'starknet_chainId', controller.signal),
      readStarknetString(input.rpcUrl, 'starknet_specVersion', controller.signal)
    ])
    if (!reportedChainMatches(reportedChainId, reference)) {
      throw new Error('Starknet RPC chain id does not match the selected chain')
    }
    if (!starknetSpecVersionMeetsMinimum(specVersion.trim())) {
      throw new Error('Starknet RPC spec version must be at least 0.10')
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Starknet RPC')) throw error
    if (timedOut) throw new Error('Starknet RPC request timed out')
    if (controller.signal.aborted || input.signal?.aborted) {
      throw new Error('Starknet RPC request was cancelled')
    }
    throw new Error('Starknet RPC endpoint is unavailable')
  } finally {
    clearTimeout(timeout)
    input.signal?.removeEventListener('abort', onAbort)
  }
}
