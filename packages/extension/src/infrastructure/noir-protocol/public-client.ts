import { fetchWithTimeout } from '@/lib/fetch-utils'

import type { NoirPublicNetworkConfig } from '@/core/services/noir-protocol/public/config'
import type { NoirPublicGasFeeQuote } from '@/core/services/noir-protocol/public/fee'
import {
  computePublicSubmissionId,
  readPublicAccountId,
  readPublicDecimal,
  createPublicSignerWallet,
  readPublicSubmissionId,
  serializePublicBusiness,
  serializePublicCandidate,
  type NoirPublicTxCandidate
} from '@/core/services/noir-protocol/public/protocol'

type JsonRecord = Record<string, unknown>

export type NoirPublicTxStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED'
  | 'PARTIALLY_SUCCEEDED'

export interface NoirPublicTxStatusResponse {
  readonly submission_id: string
  readonly tx_hash?: string
  readonly status: NoirPublicTxStatus
  readonly failure_reason?: string
  readonly anchor?: Readonly<{ txid_hex: string }>
}

export interface NoirPublicSubmitResponse {
  readonly submission_id: string
  readonly status: 'ACCEPTED_FOR_PROCESSING'
}

export interface NoirPublicTokenMetadata {
  readonly name: string
  readonly symbol: string
  readonly decimals: number
}

export type NoirPublicExecutionVerification =
  | Readonly<{ status: 'verified'; signerId: string }>
  | Readonly<{ status: 'failed' | 'unknown' }>

export interface NoirPublicMcaNonceSnapshot {
  readonly nonce: string
  readonly finalBlockTimestampMs: number
}

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`)
  }
  return value as JsonRecord
}

function readOptionalString(value: unknown, label: string, max = 512): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

function readHex(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`Invalid ${label}`)
  }
  return value.toLowerCase()
}

function parseSubmitResponse(value: unknown, expectedId: string): NoirPublicSubmitResponse {
  const envelope = record(value, 'Public submission envelope')
  if (envelope.code !== 0) throw new Error('Public submission failed')
  const response = record(envelope.data, 'Public submission response')
  const submission_id = readPublicSubmissionId(response.hash)
  if (submission_id !== expectedId) {
    throw new Error('Public submission response does not match the signed candidate')
  }
  return Object.freeze({ submission_id, status: 'ACCEPTED_FOR_PROCESSING' })
}

export function parsePublicGasFeeQuote(
  value: unknown,
  config: NoirPublicNetworkConfig,
  now = Date.now()
): NoirPublicGasFeeQuote {
  const envelope = record(value, 'Public gas fee envelope')
  if (envelope.code !== 0) throw new Error('Public gas fee query failed')
  const response = record(envelope.data, 'Public gas fee response')
  const tokens = record(response.gas_tokens, 'Public gas tokens')
  if (tokens[config.zecTokenId] !== 'ZEC') throw new Error('Public ZEC fee token is unavailable')
  const feeAccount = readPublicAccountId(response.gas_fee_account, 'Public gas fee account')
  const batch = record(response.batch, 'Public gas fee batch')
  const batchId = readPublicDecimal(batch.batch_id, 'Public gas fee batch ID')
  const completedAt = Date.parse(batch.completed_at as string)
  if (!Number.isFinite(completedAt) || completedAt > now || now - completedAt > 30 * 60_000) {
    throw new Error('Public gas fee quote is stale')
  }
  if (batch.gas_units !== '1000000000000' || !Array.isArray(batch.quotes)) {
    throw new Error('Invalid Public gas fee batch')
  }
  const zecQuotes = batch.quotes.filter(
    item =>
      item !== null &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      (item as JsonRecord).symbol === 'ZEC'
  )
  if (zecQuotes.length !== 1) throw new Error('Invalid Public ZEC gas fee quote')
  const zec = record(zecQuotes[0], 'Public ZEC gas fee quote')
  if (zec.decimals !== 8) throw new Error('Invalid Public ZEC fee decimals')
  const latestUnit = readPublicDecimal(zec.fee_atomic, 'Public ZEC fee per Tgas')
  if (latestUnit === '0') throw new Error('Invalid Public ZEC gas fee')
  const feePerTgasRaw = latestUnit
  return Object.freeze({ feeAccount, feePerTgasRaw, decimals: 8, batchId, completedAt })
}

export function parsePublicTxStatusResponse(
  value: unknown,
  expectedId: string
): NoirPublicTxStatusResponse {
  const response = record(value, 'Public transaction status')
  const submission_id = readPublicSubmissionId(response.hash)
  if (submission_id !== readPublicSubmissionId(expectedId)) {
    throw new Error('Public status hash does not match the request')
  }
  const statuses: readonly NoirPublicTxStatus[] = [
    'PENDING',
    'PROCESSING',
    'COMPLETED',
    'FAILED',
    'PARTIALLY_SUCCEEDED'
  ]
  if (!statuses.includes(response.status as NoirPublicTxStatus))
    throw new Error('Invalid Public status')
  const tx_hash =
    response.tx_hash === ''
      ? undefined
      : readOptionalString(response.tx_hash, 'Public transaction hash', 128)
  const failure_reason =
    response.error_message === ''
      ? undefined
      : readOptionalString(response.error_message, 'Public failure reason')
  const anchor =
    response.anchor_txid_hex === undefined || response.anchor_txid_hex === ''
      ? undefined
      : Object.freeze({
          txid_hex: readHex(response.anchor_txid_hex, 'Public anchor transaction ID')
        })
  return Object.freeze({
    submission_id,
    status: response.status as NoirPublicTxStatus,
    ...(tx_hash ? { tx_hash } : {}),
    ...(failure_reason ? { failure_reason } : {}),
    ...(anchor ? { anchor } : {})
  })
}

function encodeBase64Json(value: JsonRecord): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function parseNearRpcResult(value: unknown): unknown {
  const response = record(value, 'NEAR RPC response')
  if (response.error !== undefined) throw new Error('NEAR RPC query failed')
  const result = record(response.result, 'NEAR RPC result')
  if (!Array.isArray(result.result) || result.result.length > 1024 * 1024) {
    throw new Error('Invalid NEAR RPC function result')
  }
  const bytes = Uint8Array.from(result.result, byte => {
    if (!Number.isInteger(byte) || (byte as number) < 0 || (byte as number) > 255) {
      throw new Error('Invalid NEAR RPC result byte')
    }
    return byte as number
  })
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
}

export function parsePublicNonceSnapshot(
  queryValue: unknown,
  blockValue: unknown
): NoirPublicMcaNonceSnapshot {
  const query = record(queryValue, 'Public nonce RPC response')
  const result = record(query.result, 'Public nonce RPC result')
  const blockHash = readOptionalString(result.block_hash, 'Public nonce block hash', 64)
  if (!blockHash || !/^[1-9A-HJ-NP-Za-km-z]{32,55}$/.test(blockHash)) {
    throw new Error('Invalid Public nonce block hash')
  }
  const block = record(record(blockValue, 'Public block RPC response').result, 'Public final block')
  const header = record(block.header, 'Public final block header')
  if (header.hash !== blockHash) throw new Error('Public nonce and block do not match')
  const timestampNs = readPublicDecimal(header.timestamp_nanosec, 'Public final block timestamp')
  const timestampMs = Number(BigInt(timestampNs) / 1_000_000n)
  if (!Number.isSafeInteger(timestampMs) || timestampMs <= 0) {
    throw new Error('Invalid Public final block timestamp')
  }
  return Object.freeze({
    nonce: readPublicDecimal(parseNearRpcResult(queryValue), 'Public MCA nonce'),
    finalBlockTimestampMs: timestampMs
  })
}

function readBase64Json(value: unknown): unknown {
  if (
    typeof value !== 'string' ||
    value.length > 128 * 1024 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    throw new Error('Invalid Public exec arguments')
  }
  const binary = atob(value)
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
}

function outcomeStatus(value: unknown): 'success' | 'failed' | 'unknown' {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'unknown'
  const status = value as JsonRecord
  const keys = Object.keys(status)
  if (keys.length !== 1) return 'unknown'
  if (keys[0] === 'Failure') return 'failed'
  if (keys[0] === 'SuccessValue' && typeof status.SuccessValue === 'string') return 'success'
  if (keys[0] === 'SuccessReceiptId' && typeof status.SuccessReceiptId === 'string')
    return 'success'
  return 'unknown'
}

export function verifyPublicExecutionOutcome(
  value: unknown,
  candidate: NoirPublicTxCandidate,
  txHash: string
): NoirPublicExecutionVerification {
  try {
    const response = record(value, 'Public NEAR transaction')
    const transaction = record(response.transaction, 'Public NEAR transaction')
    if (
      transaction.hash !== txHash ||
      transaction.receiver_id !== candidate.address ||
      typeof transaction.signer_id !== 'string' ||
      !Array.isArray(transaction.actions) ||
      transaction.actions.length !== 1
    )
      return { status: 'unknown' }
    const action = record(
      record(transaction.actions[0], 'Public NEAR action').FunctionCall,
      'Public NEAR function call'
    )
    if (action.method_name !== 'exec') return { status: 'unknown' }
    const args = record(readBase64Json(action.args), 'Public exec arguments')
    if (
      Object.keys(args).length !== 3 ||
      !['business', 'signature', 'signer_wallet'].every(key => key in args)
    ) {
      return { status: 'unknown' }
    }
    const business = record(args.business, 'Public exec business')
    if (
      JSON.stringify(business) !==
        serializePublicBusiness({
          nonce: candidate.nonce,
          deadline: candidate.deadline,
          txRequests: candidate.tx_requests
        }) ||
      args.signature !== candidate.signature ||
      JSON.stringify(args.signer_wallet) !== JSON.stringify(candidate.signer_wallet)
    ) {
      return { status: 'unknown' }
    }
    if (response.final_execution_status !== 'FINAL') return { status: 'unknown' }
    const final = outcomeStatus(response.status)
    if (final === 'failed') return { status: 'failed' }
    if (final !== 'success') return { status: 'unknown' }
    const transactionOutcome = record(response.transaction_outcome, 'Public transaction outcome')
    const topLevel = outcomeStatus(
      record(transactionOutcome.outcome, 'Public transaction outcome').status
    )
    if (topLevel === 'failed') return { status: 'failed' }
    if (
      topLevel !== 'success' ||
      !Array.isArray(response.receipts_outcome) ||
      response.receipts_outcome.length < 1
    ) {
      return { status: 'unknown' }
    }
    for (const receipt of response.receipts_outcome) {
      const receiptStatus = outcomeStatus(
        record(record(receipt, 'Public receipt').outcome, 'Public receipt outcome').status
      )
      if (receiptStatus === 'failed') return { status: 'failed' }
      if (receiptStatus !== 'success') return { status: 'unknown' }
    }
    return Object.freeze({ status: 'verified', signerId: transaction.signer_id })
  } catch {
    return { status: 'unknown' }
  }
}

export function readPublicTransactionSigner(
  value: unknown,
  candidate: NoirPublicTxCandidate,
  txHash: string
): string | null {
  try {
    const response = record(value, 'Public transaction index response')
    if (!Array.isArray(response.transactions) || response.transactions.length !== 1) return null
    const indexed = record(response.transactions[0], 'Public indexed transaction')
    const transaction = record(indexed.transaction, 'Public indexed transaction')
    if (transaction.hash !== txHash || transaction.receiver_id !== candidate.address) return null
    return readPublicAccountId(transaction.signer_id, 'Public execution signer')
  } catch {
    return null
  }
}

export class NoirPublicClient {
  constructor(
    private readonly config: NoirPublicNetworkConfig,
    private readonly nearRpcUrl: string
  ) {
    if (config.network !== 'mainnet') throw new Error('Public MCA requires mainnet')
    const rpcUrl = new URL(nearRpcUrl)
    if (
      rpcUrl.protocol !== 'https:' &&
      rpcUrl.hostname !== 'localhost' &&
      rpcUrl.hostname !== '127.0.0.1'
    ) {
      throw new Error('Public MCA requires a secure NEAR RPC endpoint')
    }
  }

  async submitPublicTransaction(
    candidate: NoirPublicTxCandidate,
    signal?: AbortSignal
  ): Promise<NoirPublicSubmitResponse> {
    if (candidate.tgas === undefined) {
      throw new Error('Legacy Public transaction cannot be resubmitted')
    }
    const expectedId = computePublicSubmissionId(candidate)
    const response = await fetchWithTimeout(`${this.config.submitBaseUrl}/public/txs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: serializePublicCandidate(candidate),
      timeoutMs: 20_000,
      maxBytes: 64 * 1024,
      signal
    })
    return parseSubmitResponse(await response.json(), expectedId)
  }

  async getGasFeeQuote(signal?: AbortSignal): Promise<NoirPublicGasFeeQuote> {
    const response = await fetchWithTimeout(`${this.config.submitBaseUrl}/gas-fees`, {
      timeoutMs: 15_000,
      maxBytes: 64 * 1024,
      signal
    })
    return parsePublicGasFeeQuote(await response.json(), this.config)
  }

  async getPublicTransaction(
    submissionId: string,
    signal?: AbortSignal
  ): Promise<NoirPublicTxStatusResponse> {
    const id = readPublicSubmissionId(submissionId)
    const response = await fetchWithTimeout(`${this.config.queryBaseUrl}/public/txs/${id}`, {
      timeoutMs: 15_000,
      maxBytes: 64 * 1024,
      signal
    })
    const envelope = record(await response.json(), 'Public status envelope')
    if (envelope.code === 4004) throw new Error('Public submission not found yet')
    if (envelope.code !== 0) throw new Error('Public status query failed')
    return parsePublicTxStatusResponse(envelope.data, id)
  }

  async verifiedPublicExecution(
    candidate: NoirPublicTxCandidate,
    txHash: string,
    signal?: AbortSignal
  ): Promise<NoirPublicExecutionVerification> {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,55}$/.test(txHash)) return { status: 'unknown' }
    try {
      const indexedResponse = await fetchWithTimeout(
        `${this.config.transactionIndexBaseUrl}/transactions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tx_hashes: [txHash] }),
          timeoutMs: 12_000,
          maxBytes: 8 * 1024 * 1024,
          signal
        }
      )
      const signerId = readPublicTransactionSigner(await indexedResponse.json(), candidate, txHash)
      if (!signerId) return { status: 'unknown' }
      const response = await fetchWithTimeout(this.nearRpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'noir-public-execution',
          method: 'tx',
          params: { tx_hash: txHash, sender_account_id: signerId, wait_until: 'FINAL' }
        }),
        timeoutMs: 15_000,
        maxBytes: 1024 * 1024,
        signal
      })
      const envelope = record(await response.json(), 'Public transaction RPC response')
      if (envelope.error !== undefined) return { status: 'unknown' }
      const verified = verifyPublicExecutionOutcome(envelope.result, candidate, txHash)
      if (verified.status === 'verified' && verified.signerId !== signerId)
        return { status: 'unknown' }
      return verified
    } catch {
      return { status: 'unknown' }
    }
  }

  async callNearView(
    accountId: string,
    methodName: string,
    args: JsonRecord,
    signal?: AbortSignal
  ): Promise<unknown> {
    const response = await fetchWithTimeout(this.nearRpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'noir-public-view',
        method: 'query',
        params: {
          request_type: 'call_function',
          finality: 'final',
          account_id: readPublicAccountId(accountId, 'NEAR view account'),
          method_name: methodName,
          args_base64: encodeBase64Json(args)
        }
      }),
      timeoutMs: 15_000,
      maxBytes: 1024 * 1024,
      signal
    })
    return parseNearRpcResult(await response.json())
  }

  async getNativeBalance(mcaId: string, signal?: AbortSignal): Promise<string> {
    const response = await fetchWithTimeout(this.nearRpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'noir-public-native-balance',
        method: 'query',
        params: {
          request_type: 'view_account',
          finality: 'final',
          account_id: readPublicAccountId(mcaId, 'Public MCA')
        }
      }),
      timeoutMs: 15_000,
      maxBytes: 64 * 1024,
      signal
    })
    const envelope = record(await response.json(), 'NEAR account response')
    if (envelope.error !== undefined) throw new Error('NEAR account query failed')
    return readPublicDecimal(
      record(envelope.result, 'NEAR account').amount,
      'Public native NEAR balance'
    )
  }

  async getMcaByWallet(
    publicKey: string,
    signal?: AbortSignal,
    identityChain: 'zcash' | 'evm' = 'zcash'
  ): Promise<string | null> {
    const result = await this.callNearView(
      this.config.parentContractId,
      'get_mca_by_wallet',
      {
        wallet: createPublicSignerWallet(publicKey, identityChain)
      },
      signal
    )
    if (result === null) return null
    return readPublicAccountId(result, 'Public MCA')
  }

  async getMcaNonce(mcaId: string, signal?: AbortSignal): Promise<string> {
    return readPublicDecimal(
      await this.callNearView(mcaId, 'get_nonce', {}, signal),
      'Public MCA nonce'
    )
  }

  async getMcaNonceSnapshot(
    mcaId: string,
    signal?: AbortSignal
  ): Promise<NoirPublicMcaNonceSnapshot> {
    const nonceResponse = await fetchWithTimeout(this.nearRpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'noir-public-final-nonce',
        method: 'query',
        params: {
          request_type: 'call_function',
          finality: 'final',
          account_id: readPublicAccountId(mcaId, 'Public MCA'),
          method_name: 'get_nonce',
          args_base64: encodeBase64Json({})
        }
      }),
      timeoutMs: 15_000,
      maxBytes: 64 * 1024,
      signal
    })
    const nonceValue: unknown = await nonceResponse.json()
    const blockHash = readOptionalString(
      record(record(nonceValue, 'Public nonce RPC response').result, 'Public nonce RPC result')
        .block_hash,
      'Public nonce block hash',
      64
    )
    if (!blockHash || !/^[1-9A-HJ-NP-Za-km-z]{32,55}$/.test(blockHash)) {
      throw new Error('Invalid Public nonce block hash')
    }
    const blockResponse = await fetchWithTimeout(this.nearRpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'noir-public-final-block',
        method: 'block',
        params: { block_id: blockHash }
      }),
      timeoutMs: 15_000,
      maxBytes: 64 * 1024,
      signal
    })
    return parsePublicNonceSnapshot(nonceValue, await blockResponse.json())
  }

  async getCreateMcaFee(tokenId: string, signal?: AbortSignal): Promise<string> {
    if (!this.config.tokenIds.includes(tokenId)) throw new Error('Unsupported Public fee token')
    return readPublicDecimal(
      await this.callNearView(
        this.config.parentContractId,
        'get_create_mca_fee',
        {
          token_id: tokenId
        },
        signal
      ),
      'Public MCA creation fee'
    )
  }

  async getNearValue(tokenId: string, signal?: AbortSignal): Promise<string> {
    if (!this.config.tokenIds.includes(tokenId)) throw new Error('Unsupported Public fee token')
    return readPublicDecimal(
      await this.callNearView(
        this.config.parentContractId,
        'get_near_value',
        {
          token_id: tokenId
        },
        signal
      ),
      'Public MCA near value'
    )
  }

  async getFtBalance(tokenId: string, mcaId: string, signal?: AbortSignal): Promise<string> {
    if (!this.config.tokenIds.includes(tokenId)) throw new Error('Unsupported Public asset')
    return readPublicDecimal(
      await this.callNearView(
        tokenId,
        'ft_balance_of',
        {
          account_id: readPublicAccountId(mcaId, 'Public MCA')
        },
        signal
      ),
      'Public token balance'
    )
  }

  async getFtMetadata(tokenId: string, signal?: AbortSignal): Promise<NoirPublicTokenMetadata> {
    const configured = this.config.assets.find(asset => asset.tokenId === tokenId)
    if (!configured) throw new Error('Unsupported Public asset')
    const metadata = record(
      await this.callNearView(tokenId, 'ft_metadata', {}, signal),
      'Public token metadata'
    )
    if (
      typeof metadata.name !== 'string' ||
      metadata.name.length < 1 ||
      metadata.name.length > 100 ||
      typeof metadata.symbol !== 'string' ||
      metadata.symbol.length < 1 ||
      metadata.symbol.length > 20 ||
      !Number.isInteger(metadata.decimals) ||
      (metadata.decimals as number) < 0 ||
      (metadata.decimals as number) > 30
    ) {
      throw new Error('Invalid Public token metadata')
    }
    if (metadata.decimals !== configured.decimals)
      throw new Error('Public token decimals differ from configured asset')
    return Object.freeze({
      name: metadata.name,
      symbol: metadata.symbol,
      decimals: metadata.decimals as number
    })
  }
}
