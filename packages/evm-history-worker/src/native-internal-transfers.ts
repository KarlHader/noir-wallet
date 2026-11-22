import { UpstreamError } from './ankr-client'
import { readBoundedBody } from './read-bounded-body'

export const NATIVE_INTERNAL_METHOD = 'noir_getNativeInternalTransfers'
export const MAX_NATIVE_INTERNAL_PAGE_SIZE = 200
export const MAX_NATIVE_INTERNAL_PAGE_TOKEN_LENGTH = 1_024

const MAX_RESPONSE_BYTES = 512 * 1024
const REQUEST_TIMEOUT_MS = 15_000
const QUANTITY = /^0x[0-9a-fA-F]{1,64}$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HASH = /^0x[0-9a-fA-F]{64}$/
const ISO_TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/
const PAGE_KEY = /^[A-Za-z0-9_-]{1,128}$/
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })

export interface NativeInternalParams {
  address: string
  pageSize: number
  fromBlock: number
  pageToken?: string
}

interface Transfer {
  hash: string
  blockNumber: string
  timestamp: string
  from: string
  to: string
  value: string
  transferId: string
}

interface Position {
  key?: string
  consumed?: number
  digest?: string
}

interface Cursor {
  tip: string
  lastBlock?: string
  outgoing: Position | null
  incoming: Position | null
}

interface DirectionPage {
  transfers: Transfer[]
  consumed: number
  key?: string
  nextKey?: string
}

export class InvalidNativeInternalPageToken extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalidData(): UpstreamError {
  return new UpstreamError(502, 'Alchemy returned invalid internal transfer data')
}

function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !QUANTITY.test(value)) throw invalidData()
  return BigInt(value)
}

function hex(value: bigint | number): string {
  return `0x${value.toString(16)}`
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function fromBase64url(value: string): ArrayBuffer {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
  const buffer = new ArrayBuffer(binary.length)
  const bytes = new Uint8Array(buffer)
  for (let index = 0; index < bytes.length; index++) bytes[index] = binary.charCodeAt(index)
  return buffer
}

function cursorMessage(params: NativeInternalParams, payload: string): Uint8Array {
  return encoder.encode(
    JSON.stringify([
      NATIVE_INTERNAL_METHOD,
      1,
      params.address,
      params.fromBlock,
      params.pageSize,
      payload
    ])
  )
}

async function decodeCursor(
  token: string,
  key: CryptoKey,
  params: NativeInternalParams
): Promise<Cursor> {
  try {
    const [payload, signature] = token.split('.')
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token))
      throw new InvalidNativeInternalPageToken()
    const bytes = fromBase64url(signature)
    if (
      base64url(new Uint8Array(bytes)) !== signature ||
      !(await crypto.subtle.verify('HMAC', key, bytes, cursorMessage(params, payload)))
    ) {
      throw new InvalidNativeInternalPageToken()
    }
    return JSON.parse(decoder.decode(fromBase64url(payload))) as Cursor
  } catch {
    throw new InvalidNativeInternalPageToken()
  }
}

async function encodeCursor(
  cursor: Cursor,
  key: CryptoKey,
  params: NativeInternalParams
): Promise<string> {
  const payload = base64url(encoder.encode(JSON.stringify(cursor)))
  const signature = await crypto.subtle.sign('HMAC', key, cursorMessage(params, payload))
  return `${payload}.${base64url(new Uint8Array(signature))}`
}

async function alchemyRequest(
  endpoint: string,
  signal: AbortSignal,
  method: 'eth_blockNumber' | 'alchemy_getAssetTransfers',
  params: unknown[]
): Promise<unknown> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal,
    redirect: 'manual'
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    if (response.status === 429) throw new UpstreamError(429, 'Alchemy rate limit exceeded', 60)
    if (response.status === 401 || response.status === 403) {
      throw new UpstreamError(503, 'Alchemy credentials unavailable')
    }
    throw new UpstreamError(502, 'Alchemy upstream unavailable')
  }
  const bytes = await readBoundedBody(response, MAX_RESPONSE_BYTES, invalidData)
  let data: unknown
  try {
    data = JSON.parse(decoder.decode(bytes))
  } catch {
    throw invalidData()
  }
  if (!isRecord(data) || data.jsonrpc !== '2.0' || data.id !== 1) throw invalidData()
  if ('error' in data) {
    if ('result' in data || !isRecord(data.error)) throw invalidData()
    if (data.error.code === 429) throw new UpstreamError(429, 'Alchemy rate limit exceeded', 60)
    throw new UpstreamError(502, 'Alchemy RPC request failed')
  }
  if (!('result' in data)) throw invalidData()
  return data.result
}

function normalizeTransfer(
  item: unknown,
  address: string,
  direction: 'from' | 'to',
  fromBlock: bigint,
  tip: bigint
): Transfer | null {
  if (
    !isRecord(item) ||
    item.category !== 'internal' ||
    !isRecord(item.rawContract) ||
    item.rawContract.address !== null
  ) {
    throw invalidData()
  }
  const value = quantity(item.rawContract.value)
  if (value === 0n) return null
  const blockNumber = quantity(item.blockNum)
  const { hash, from, to, uniqueId, metadata } = item
  const timestamp = isRecord(metadata) ? metadata.blockTimestamp : undefined
  if (
    typeof hash !== 'string' ||
    !HASH.test(hash) ||
    typeof from !== 'string' ||
    !ADDRESS.test(from) ||
    typeof to !== 'string' ||
    !ADDRESS.test(to) ||
    (direction === 'from' ? from : to).toLowerCase() !== address ||
    blockNumber < fromBlock ||
    blockNumber > tip ||
    typeof uniqueId !== 'string' ||
    !/^[\x21-\x7e]{1,256}$/.test(uniqueId) ||
    typeof timestamp !== 'string' ||
    !ISO_TIMESTAMP.test(timestamp) ||
    !Number.isFinite(Date.parse(timestamp))
  ) {
    throw invalidData()
  }
  const isoTimestamp = new Date(timestamp).toISOString()
  if (isoTimestamp.slice(0, 19) !== timestamp.slice(0, 19)) throw invalidData()
  if (direction === 'to' && from.toLowerCase() === address) return null
  return {
    hash: hash.toLowerCase(),
    blockNumber: hex(blockNumber),
    timestamp: isoTimestamp,
    from: from.toLowerCase(),
    to: to.toLowerCase(),
    value: hex(value),
    transferId: uniqueId
  }
}

async function pageDigest(transfers: Transfer[], nextKey?: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(JSON.stringify([transfers, Boolean(nextKey)]))
  )
  return base64url(new Uint8Array(digest))
}

async function readDirection(
  endpoint: string,
  signal: AbortSignal,
  params: NativeInternalParams,
  tip: string,
  direction: 'from' | 'to',
  position: Position | null
): Promise<DirectionPage | null> {
  if (!position) return null
  const { address, fromBlock, pageSize } = params
  const result = await alchemyRequest(endpoint, signal, 'alchemy_getAssetTransfers', [
    {
      [direction === 'from' ? 'fromAddress' : 'toAddress']: address,
      fromBlock: hex(fromBlock),
      toBlock: tip,
      category: ['internal'],
      excludeZeroValue: true,
      withMetadata: true,
      order: 'desc',
      maxCount: hex(pageSize),
      ...(position.key ? { pageKey: position.key } : {})
    }
  ])
  if (!isRecord(result) || !Array.isArray(result.transfers) || result.transfers.length > pageSize) {
    throw invalidData()
  }
  const nextKey = result.pageKey === '' ? undefined : result.pageKey
  if (
    nextKey !== undefined &&
    (typeof nextKey !== 'string' || !PAGE_KEY.test(nextKey) || nextKey === position.key)
  ) {
    throw invalidData()
  }
  const transfers: Transfer[] = []
  const ids = new Set<string>()
  const minimum = BigInt(fromBlock)
  const maximum = BigInt(tip)
  let previous = maximum
  for (const item of result.transfers) {
    const transfer = normalizeTransfer(item, address, direction, minimum, maximum)
    if (!transfer) continue
    const block = BigInt(transfer.blockNumber)
    if (block > previous || ids.has(transfer.transferId)) throw invalidData()
    previous = block
    ids.add(transfer.transferId)
    transfers.push(transfer)
  }

  if (position.digest && position.digest !== (await pageDigest(transfers, nextKey))) {
    throw new UpstreamError(502, 'Alchemy transfer page changed during pagination')
  }
  return { transfers, consumed: position.consumed ?? 0, key: position.key, nextKey }
}

async function nextPosition(page: DirectionPage | null): Promise<Position | null> {
  if (!page) return null
  if (page.consumed === page.transfers.length) return page.nextKey ? { key: page.nextKey } : null
  return {
    key: page.key,
    consumed: page.consumed,
    digest: await pageDigest(page.transfers, page.nextKey)
  }
}

export async function getNativeInternalTransfers(
  secret: unknown,
  params: NativeInternalParams,
  callerSignal: AbortSignal
): Promise<{ transfers: Transfer[]; nextPageToken?: string }> {
  const apiKey = typeof secret === 'string' ? secret.trim() : ''
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(apiKey)) {
    throw new UpstreamError(503, 'Alchemy credentials unavailable')
  }
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(apiKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  )
  const controller = new AbortController()
  const cancel = () => controller.abort()
  const timer = setTimeout(cancel, REQUEST_TIMEOUT_MS)
  callerSignal.addEventListener('abort', cancel, { once: true })
  try {
    if (callerSignal.aborted) throw new UpstreamError(499, 'Request cancelled')
    const endpoint = `https://base-mainnet.g.alchemy.com/v2/${apiKey}`
    const cursor: Cursor = params.pageToken
      ? await decodeCursor(params.pageToken, key, params)
      : {
          tip: hex(
            quantity(await alchemyRequest(endpoint, controller.signal, 'eth_blockNumber', []))
          ),
          outgoing: {},
          incoming: {}
        }
    if (BigInt(cursor.tip) < BigInt(params.fromBlock)) return { transfers: [] }

    const [outgoing, incoming] = await Promise.all([
      readDirection(endpoint, controller.signal, params, cursor.tip, 'from', cursor.outgoing),
      readDirection(endpoint, controller.signal, params, cursor.tip, 'to', cursor.incoming)
    ])
    const transfers: Transfer[] = []
    let lastBlock = BigInt(cursor.lastBlock ?? cursor.tip)
    while (transfers.length < params.pageSize) {
      const sent = outgoing?.transfers[outgoing.consumed]
      const received = incoming?.transfers[incoming.consumed]
      if ((!sent && outgoing?.nextKey) || (!received && incoming?.nextKey)) break
      const page =
        sent && (!received || BigInt(sent.blockNumber) >= BigInt(received.blockNumber))
          ? outgoing
          : received
            ? incoming
            : null
      if (!page) break
      const transfer = page.transfers[page.consumed++]
      const block = BigInt(transfer.blockNumber)
      if (block > lastBlock) throw invalidData()
      lastBlock = block
      transfers.push(transfer)
    }

    const [nextOutgoing, nextIncoming] = await Promise.all([
      nextPosition(outgoing),
      nextPosition(incoming)
    ])
    if (!nextOutgoing && !nextIncoming) return { transfers }
    return {
      transfers,
      nextPageToken: await encodeCursor(
        {
          tip: cursor.tip,
          lastBlock: hex(lastBlock),
          outgoing: nextOutgoing,
          incoming: nextIncoming
        },
        key,
        params
      )
    }
  } catch (error) {
    if (callerSignal.aborted) throw new UpstreamError(499, 'Request cancelled')
    if (controller.signal.aborted) throw new UpstreamError(504, 'Alchemy request timed out')
    if (error instanceof UpstreamError || error instanceof InvalidNativeInternalPageToken)
      throw error
    throw new UpstreamError(502, 'Alchemy upstream unavailable')
  } finally {
    clearTimeout(timer)
    callerSignal.removeEventListener('abort', cancel)
    controller.abort()
  }
}
