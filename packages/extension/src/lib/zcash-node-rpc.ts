import { fetchJsonWithTimeout } from './fetch-utils.ts'

const RPC_TIMEOUT_MS = 10_000

interface JsonRpcResponse<T> {
  result?: T
  error?: { code: number; message: string }
}

/** JSON-RPC error that preserves the node's numeric code (e.g. -5 = unknown tx). */
export class ZcashRpcError extends Error {
  code?: number

  constructor(message: string, code?: number) {
    super(message)
    this.name = 'ZcashRpcError'
    this.code = code
  }
}

export interface VerboseScriptPubKey {
  addresses?: string[]
}

export interface VerboseTxInput {
  txid?: string
  vout?: number
  coinbase?: string
}

export interface VerboseTxOutput {
  valueZat?: number
  n?: number
  scriptPubKey?: VerboseScriptPubKey
}

export interface VerboseTransaction {
  txid: string
  vin?: VerboseTxInput[]
  vout?: VerboseTxOutput[]
  blocktime?: number
  time?: number
  confirmations?: number
  height?: number
}

/**
 * Calls a zcashd-style JSON-RPC method on the self-hosted node
 */
export async function zcashNodeRpc<T>(
  baseUrl: string,
  method: string,
  params: unknown[] = [],
  signal?: AbortSignal
): Promise<T> {
  const json = await fetchJsonWithTimeout<JsonRpcResponse<T>>(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    timeoutMs: RPC_TIMEOUT_MS,
    maxBytes: 32 * 1024 * 1024,
    signal
  })
  if (json.error) {
    throw new ZcashRpcError(`RPC ${method} failed: ${json.error.message}`, json.error.code)
  }
  return json.result as T
}

/**
 * Returns all txids involving the address, ordered by block height ascending.
 * Pass a start height to bound the index scan (e.g. wallet birthday).
 */
export function getAddressTxids(
  baseUrl: string,
  address: string,
  startHeight?: number
): Promise<string[]> {
  const query: { addresses: string[]; start?: number } = { addresses: [address] }
  if (startHeight && startHeight > 0) {
    query.start = startHeight
  }
  return zcashNodeRpc<string[]>(baseUrl, 'getaddresstxids', [query])
}

export function getVerboseTransaction(
  baseUrl: string,
  txid: string,
  signal?: AbortSignal
): Promise<VerboseTransaction> {
  return zcashNodeRpc<VerboseTransaction>(baseUrl, 'getrawtransaction', [txid, 1], signal)
}

/** zcashd error code for an unknown txid ("No information available about transaction"). */
const TX_NOT_FOUND_RPC_CODE = -5

export type TxLookup =
  | { status: 'confirmed'; confirmations: number }
  | { status: 'mempool' }
  | { status: 'notfound' }
  | { status: 'error' }

/**
 * Classifies a txid against the node, distinguishing an authoritative
 * "not found" (evicted / never mined) from a transient RPC or network error,
 * so callers never fail a live transaction on a flaky lookup.
 */
export async function lookupTransaction(baseUrl: string, txid: string): Promise<TxLookup> {
  try {
    const tx = await getVerboseTransaction(baseUrl, txid)
    if (
      !txid.trim() ||
      typeof tx?.txid !== 'string' ||
      tx.txid.trim().toLowerCase() !== txid.trim().toLowerCase()
    ) {
      return { status: 'error' }
    }
    const confirmations = tx.confirmations === undefined ? 0 : tx.confirmations
    if (!Number.isSafeInteger(confirmations) || confirmations < 0) {
      return { status: 'error' }
    }
    return confirmations > 0 ? { status: 'confirmed', confirmations } : { status: 'mempool' }
  } catch (error) {
    if (error instanceof ZcashRpcError && error.code === TX_NOT_FOUND_RPC_CODE) {
      return { status: 'notfound' }
    }
    return { status: 'error' }
  }
}

/**
 * Returns confirmation count (0 while in mempool), or null when the node
 * does not know the transaction or the query fails
 */
export async function getTransactionConfirmations(
  baseUrl: string,
  txid: string
): Promise<number | null> {
  const lookup = await lookupTransaction(baseUrl, txid)
  if (lookup.status === 'confirmed') return lookup.confirmations
  if (lookup.status === 'mempool') return 0
  return null
}

export async function pollingTransactionConfirmations(
  baseUrl: string,
  txid: string,
  requiredConfirmations: number,
  onConfirmations?: (confirmations: number) => void,
  options?: { interval?: number; maxRetries?: number; signal?: AbortSignal }
): Promise<number> {
  const interval = options?.interval ?? 5000
  const maxRetries = options?.maxRetries ?? 360
  const signal = options?.signal

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    if (signal?.aborted) {
      throw new DOMException('Transaction confirmation polling aborted', 'AbortError')
    }

    const confirmations = await getTransactionConfirmations(baseUrl, txid)
    if (signal?.aborted) {
      throw new DOMException('Transaction confirmation polling aborted', 'AbortError')
    }
    if (confirmations != null) {
      onConfirmations?.(confirmations)
      if (confirmations >= requiredConfirmations) return confirmations
    }

    if (attempt === maxRetries) break
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener('abort', handleAbort)
      const handleAbort = () => {
        clearTimeout(timer)
        cleanup()
        reject(new DOMException('Transaction confirmation polling aborted', 'AbortError'))
      }
      const timer = setTimeout(() => {
        cleanup()
        resolve()
      }, interval)
      signal?.addEventListener('abort', handleAbort, { once: true })
      if (signal?.aborted) handleAbort()
    })
  }

  throw new Error(`Transaction confirmation polling timed out after ${maxRetries} attempts`)
}

/**
 * Returns the current chain tip height, or null when the query fails.
 */
export async function getBlockCount(baseUrl: string): Promise<number | null> {
  try {
    const height = await zcashNodeRpc<number>(baseUrl, 'getblockcount', [])
    return typeof height === 'number' ? height : null
  } catch {
    return null
  }
}

/**
 * Runs an async task per item with bounded concurrency
 */
export async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex]
      nextIndex += 1
      await task(item)
    }
  })
  await Promise.all(workers)
}
