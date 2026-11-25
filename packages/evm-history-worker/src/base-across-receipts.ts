import { readBoundedBody } from './read-bounded-body'

const SPOKE_POOL = '0x09aea4b2242abc8bb4bb78d537a67a245a7bec64'
const WETH = '0x4200000000000000000000000000000000000006'
const FILLED_RELAY = '0x44b559f101f8fbcc8a0ea43fa91a05a729a5ea6e14a7c75aa750374690137208'
const FILLED_V3_RELAY = '0x571749edf1d5c9599318cdbc4e28a6475d65e87fd3b2ddbe1e9a8d5e7a0f0ff7'
const WITHDRAWAL = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65'
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const POOL_TOPIC = `0x${SPOKE_POOL.slice(2).padStart(64, '0')}`
const FILL_TOPICS = new Set([FILLED_RELAY, FILLED_V3_RELAY])
const BASE_RPC = 'https://base-rpc.publicnode.com'
const START_BLOCK = 61_274_000
const SCAN_SIZE = 5_000
const MAX_TRANSACTIONS = 12

type RpcRecord = Record<string, unknown>
type BaseRpc = (method: string, params: unknown[]) => Promise<unknown>

interface Cursor {
  readonly block: number
  readonly logIndex: number
}

interface RelayLog {
  readonly transactionHash: string
  readonly blockHash: string
  readonly blockHeight: number
  readonly logIndex: number
  readonly address: string
  readonly topics: string[]
  readonly data: string
}

interface ReceiptRow extends Record<string, SqlStorageValue> {
  readonly transactionHash: string
  readonly blockHash: string
  readonly blockHeight: number
  readonly logIndex: number
  readonly from: string
  readonly to: string
  readonly amountRaw: string
  readonly timestamp: number
}

function invalid(): never {
  throw new Error('Invalid Base receipt RPC data')
}

function record(value: unknown): RpcRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as RpcRecord
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) invalid()
  return value
}

function hex(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid()
  return value.toLowerCase()
}

function hash(value: unknown): string {
  return hex(value, /^0x[\da-f]{64}$/i)
}

function quantity(value: unknown): bigint {
  return BigInt(hex(value, /^0x(?:0|[1-9a-f][\da-f]{0,63})$/i))
}

function number(value: unknown): number {
  const parsed = Number(quantity(value))
  if (!Number.isSafeInteger(parsed)) invalid()
  return parsed
}

function readLog(value: unknown) {
  const log = record(value)
  return {
    address: hex(log.address, /^0x[\da-f]{40}$/i),
    topics: list(log.topics).map(hash),
    data: hex(log.data, /^0x(?:[\da-f]{2})*$/i)
  }
}

function readRelayLog(value: unknown): RelayLog {
  const raw = record(value)
  const log = readLog(raw)
  if (raw.removed === true || log.address !== SPOKE_POOL || !FILL_TOPICS.has(log.topics[0])) {
    invalid()
  }
  return {
    ...log,
    transactionHash: hash(raw.transactionHash),
    blockHash: hash(raw.blockHash),
    blockHeight: number(raw.blockNumber),
    logIndex: number(raw.logIndex)
  }
}

function relayPayout(log: ReturnType<typeof readLog>) {
  const data = log.data.slice(2)
  const word = (index: number) => {
    const value = data.slice(index * 64, (index + 1) * 64)
    if (value.length !== 64) invalid()
    return value
  }
  if (word(1) !== WETH.slice(2).padStart(64, '0')) return null
  let recipientIndex = 11
  if (log.topics[0] === FILLED_V3_RELAY) {
    const offset = Number(BigInt(`0x${word(10)}`))
    if (!Number.isSafeInteger(offset) || offset < 352 || offset % 32 !== 0) invalid()
    recipientIndex = offset / 32
  }
  const recipient = word(recipientIndex)
  const amount = BigInt(`0x${word(recipientIndex + 2)}`)
  if (!/^0{24}[\da-f]{40}$/.test(recipient) || amount === 0n) return null
  return { to: `0x${recipient.slice(24)}`, amount }
}

function logKey(log: ReturnType<typeof readLog>): string {
  return `${log.address}:${log.topics.join(':')}:${log.data}`
}

function receiptPayouts(receiptLogs: unknown[]) {
  const fills = new Map<number, { log: RelayLog; native: boolean }>()
  let pending:
    | { fill: { log: RelayLog; native: boolean }; amount: bigint; funded: boolean }
    | undefined
  for (const raw of receiptLogs) {
    const log = readLog(raw)
    if (log.address === SPOKE_POOL && FILL_TOPICS.has(log.topics[0])) {
      const fill = { log: readRelayLog(raw), native: false }
      if (fills.has(fill.log.logIndex)) invalid()
      fills.set(fill.log.logIndex, fill)
      const payout = relayPayout(fill.log)
      pending = payout ? { fill, amount: payout.amount, funded: false } : undefined
      continue
    }
    if (!pending) continue
    const matchingWeth =
      log.address === WETH &&
      /^0x[\da-f]{64}$/.test(log.data) &&
      BigInt(log.data) === pending.amount
    if (
      matchingWeth &&
      !pending.funded &&
      log.topics.length === 3 &&
      log.topics[0] === TRANSFER &&
      log.topics[2] === POOL_TOPIC
    ) {
      pending.funded = true
      continue
    }
    pending.fill.native =
      matchingWeth &&
      log.topics.length === 2 &&
      log.topics[0] === WITHDRAWAL &&
      log.topics[1] === POOL_TOPIC
    pending = undefined
  }
  return fills
}

async function requestBaseRpc(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(BASE_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    redirect: 'manual',
    signal: AbortSignal.timeout(12_000)
  })
  if (!response.ok) throw new Error('Base receipt RPC unavailable')
  const bytes = await readBoundedBody(
    response,
    4 * 1024 * 1024,
    () => new Error('Base RPC body too large')
  )
  const decoded = record(JSON.parse(new TextDecoder().decode(bytes)))
  if (decoded.jsonrpc !== '2.0' || decoded.id !== 1 || 'error' in decoded) invalid()
  return decoded.result
}

export async function scanBaseAcrossReceipts(cursor: Cursor, rpc: BaseRpc = requestBaseRpc) {
  const finalized = number(record(await rpc('eth_getBlockByNumber', ['finalized', false])).number)
  const end = Math.min(finalized, cursor.block + SCAN_SIZE - 1)
  if (end < cursor.block) return { cursor, rows: [] }
  const toHex = (value: number) => `0x${value.toString(16)}`
  const logs = list(
    await rpc('eth_getLogs', [
      {
        address: SPOKE_POOL,
        topics: [[...FILL_TOPICS]],
        fromBlock: toHex(cursor.block),
        toBlock: toHex(end)
      }
    ])
  )
    .map(readRelayLog)
    .sort((left, right) => left.blockHeight - right.blockHeight || left.logIndex - right.logIndex)
  const pending = new Map<string, RelayLog[]>()
  const seen = new Set<string>()
  let next = { block: end + 1, logIndex: -1 }
  for (const log of logs) {
    if (log.blockHeight < cursor.block || log.blockHeight > end) invalid()
    if (log.blockHeight === cursor.block && log.logIndex <= cursor.logIndex) continue
    const id = `${log.blockHeight}:${log.logIndex}`
    if (seen.has(id)) invalid()
    seen.add(id)
    if (!relayPayout(log)) continue
    let group = pending.get(log.transactionHash)
    if (!group) {
      if (pending.size === MAX_TRANSACTIONS) {
        next = { block: log.blockHeight, logIndex: log.logIndex - 1 }
        break
      }
      group = []
      pending.set(log.transactionHash, group)
    }
    group.push(log)
  }
  const rows: ReceiptRow[] = []
  const timestamps = new Map<string, number>()
  for (const [transactionHash, candidates] of pending) {
    const receipt = record(await rpc('eth_getTransactionReceipt', [transactionHash]))
    const { blockHash, blockHeight } = candidates[0]
    if (
      receipt.status !== '0x1' ||
      hash(receipt.transactionHash) !== transactionHash ||
      hash(receipt.blockHash) !== blockHash ||
      number(receipt.blockNumber) !== blockHeight
    )
      invalid()
    const receiptFills = receiptPayouts(list(receipt.logs))
    for (const candidate of candidates) {
      const fill = receiptFills.get(candidate.logIndex)
      const log = fill?.log
      if (
        !log ||
        logKey(log) !== logKey(candidate) ||
        log.blockHash !== candidate.blockHash ||
        log.transactionHash !== transactionHash ||
        log.blockHeight !== candidate.blockHeight
      )
        invalid()
      if (!fill.native) continue
      const payout = relayPayout(log)
      if (!payout) invalid()
      let timestamp = timestamps.get(blockHash)
      if (timestamp === undefined) {
        const block = record(await rpc('eth_getBlockByHash', [blockHash, false]))
        if (hash(block.hash) !== blockHash || number(block.number) !== blockHeight) invalid()
        timestamp = number(block.timestamp) * 1_000
        if (!Number.isSafeInteger(timestamp)) invalid()
        timestamps.set(blockHash, timestamp)
      }
      rows.push({
        transactionHash,
        blockHash,
        blockHeight,
        logIndex: log.logIndex,
        from: SPOKE_POOL,
        to: payout.to,
        amountRaw: payout.amount.toString(),
        timestamp
      })
    }
  }
  return { cursor: next, rows }
}

export class BaseAcrossReceiptIndex {
  private scan?: Promise<void>

  constructor(private readonly state: DurableObjectState) {
    state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS receipts (
      transactionHash TEXT NOT NULL, blockHash TEXT NOT NULL, blockHeight INTEGER NOT NULL,
      logIndex INTEGER NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL,
      amountRaw TEXT NOT NULL, timestamp INTEGER NOT NULL, PRIMARY KEY (transactionHash, logIndex)
    )`)
    state.storage.sql.exec(`CREATE INDEX IF NOT EXISTS receipts_by_recipient
      ON receipts (recipient, blockHeight DESC, logIndex DESC)`)
    state.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS scan_cursor (id INTEGER PRIMARY KEY, block INTEGER, logIndex INTEGER)'
    )
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/advance' && request.method === 'POST') {
      this.scan ??= this.advance().finally(() => {
        this.scan = undefined
      })
      await this.scan
      return new Response(null, { status: 204 })
    }
    const recipient = url.searchParams.get('address')
    const limit = Number(url.searchParams.get('limit'))
    if (
      url.pathname !== '/receipts' ||
      request.method !== 'GET' ||
      !recipient ||
      !/^0x[\da-f]{40}$/.test(recipient) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200
    ) {
      return new Response(null, { status: 400 })
    }
    const rows = this.state.storage.sql
      .exec<ReceiptRow>(
        `SELECT transactionHash, blockHash,
      blockHeight, logIndex, sender AS "from", recipient AS "to", amountRaw, timestamp FROM receipts
      WHERE recipient = ? ORDER BY blockHeight DESC, logIndex DESC LIMIT ?`,
        recipient,
        limit
      )
      .toArray()
    return Response.json({ receipts: rows })
  }

  private async advance(): Promise<void> {
    const sql = this.state.storage.sql
    const cursor = sql
      .exec<
        Cursor & Record<string, SqlStorageValue>
      >('SELECT block, logIndex FROM scan_cursor WHERE id = 1')
      .toArray()[0] ?? { block: START_BLOCK, logIndex: -1 }
    const next = await scanBaseAcrossReceipts(cursor)
    this.state.storage.transactionSync(() => {
      for (const row of next.rows) {
        sql.exec(
          'INSERT OR IGNORE INTO receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          row.transactionHash,
          row.blockHash,
          row.blockHeight,
          row.logIndex,
          row.from,
          row.to,
          row.amountRaw,
          row.timestamp
        )
      }
      sql.exec(
        'INSERT OR REPLACE INTO scan_cursor VALUES (1, ?, ?)',
        next.cursor.block,
        next.cursor.logIndex
      )
    })
  }
}
