import { parseAccountId } from '@/core/accounts/domain'
import { parseNearAccountId, parseNearBase58 } from '@/core/chains/near'
import { parseChainId } from '@/core/chains/registry'
import {
  parseKeyDomainId,
  parseSigningSummary,
  type NearTransactionSummary
} from '@/core/keyring/domain'
import {
  parseSigningCommandId,
  type SigningCommandId,
  type SigningExecution
} from '@/core/keyring/ports'
import {
  parseTransactionId,
  parseTransactionSegmentId,
  type TransactionAccountScope,
  type TransactionGraph,
  type TransactionId,
  type TransactionSegmentId
} from '@/core/transactions/domain'
import {
  ChromeSessionPendingTransactionStore,
  type SessionStorageArea
} from '../pending-transaction-store'

import { parsePreparedNearTransfer, type PreparedNearTransfer } from './near-transfer-preparer'

const STORAGE_KEY_PREFIX = 'near_pending_transfer:'
const REVIEW_GRAPH_STORAGE_KEY_PREFIX = 'near_pending_review_graph:'
const SCHEMA_VERSION = 1 as const
const MAX_PENDING_TRANSFERS = 256
const MAXIMUM_SIGNED_TRANSACTION_BYTES = 4 * 1024 * 1024

interface PendingTransferBase {
  readonly schemaVersion: typeof SCHEMA_VERSION
  readonly transactionId: TransactionId
  readonly segmentId: TransactionSegmentId
  readonly scope: TransactionAccountScope
}

export interface AwaitingApprovalNearTransfer extends PendingTransferBase {
  readonly phase: 'awaiting-approval'
  readonly prepared: PreparedNearTransfer
  readonly signingSummary: NearTransactionSummary
  readonly signingCommandId: SigningCommandId
  readonly signingExecution?: SigningExecution
  readonly payloadFingerprint: string
  readonly expiresAt: number
}

export interface SignedPendingNearTransfer extends PendingTransferBase {
  readonly phase: 'signed'
  readonly transactionBase64: string
  readonly transactionHash: string
  readonly signerId: string
  readonly signedAt: number
}

export type PendingNearTransfer = AwaitingApprovalNearTransfer | SignedPendingNearTransfer

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`)
  }
  return value as Record<string, unknown>
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  label: string
) {
  if (
    Object.keys(value).length !== required.length ||
    !required.every(key => Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new Error(`${label} has invalid fields`)
  }
}

function readTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${label}`)
  return value as number
}

function parseCanonicalBase64(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid signed NEAR transaction')
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const decodedBytes = value.length % 4 === 0 ? (value.length / 4) * 3 - padding : -1
  if (
    decodedBytes <= 0 ||
    decodedBytes > MAXIMUM_SIGNED_TRANSACTION_BYTES ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    throw new Error('Invalid signed NEAR transaction')
  }
  let binary: string
  try {
    binary = atob(value)
  } catch {
    throw new Error('Invalid signed NEAR transaction')
  }
  if (binary.length !== decodedBytes || btoa(binary) !== value) {
    throw new Error('Invalid signed NEAR transaction')
  }
  return value
}

function parseScope(value: unknown): TransactionAccountScope {
  const record = readRecord(value, 'Pending NEAR transfer scope')
  assertExactKeys(record, ['keyDomainId', 'accountId'], 'Pending NEAR transfer scope')
  return Object.freeze({
    keyDomainId: parseKeyDomainId(record.keyDomainId),
    accountId: parseAccountId(record.accountId)
  })
}

function parseCommon(record: Record<string, unknown>): PendingTransferBase {
  if (record.schemaVersion !== SCHEMA_VERSION) {
    throw new Error('Unsupported pending NEAR transfer schema')
  }
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    transactionId: parseTransactionId(record.transactionId),
    segmentId: parseTransactionSegmentId(record.segmentId),
    scope: parseScope(record.scope)
  })
}

export function parsePendingNearTransfer(value: unknown): PendingNearTransfer {
  const record = readRecord(value, 'Pending NEAR transfer')
  if (record.phase === 'awaiting-approval') {
    assertExactKeys(
      record,
      [
        'schemaVersion',
        'phase',
        'transactionId',
        'segmentId',
        'scope',
        'prepared',
        'signingSummary',
        'signingCommandId',
        ...(Object.prototype.hasOwnProperty.call(record, 'signingExecution')
          ? ['signingExecution']
          : []),
        'payloadFingerprint',
        'expiresAt'
      ],
      'Pending NEAR transfer'
    )
    const prepared = parsePreparedNearTransfer(record.prepared)
    const signingExecution: SigningExecution | undefined =
      record.signingExecution === undefined
        ? undefined
        : (() => {
            const execution = readRecord(record.signingExecution, 'NEAR signing execution')
            if (execution.kind === 'internal') {
              assertExactKeys(execution, ['kind'], 'NEAR signing execution')
              return { kind: 'internal' as const }
            }
            assertExactKeys(execution, ['kind', 'request'], 'NEAR signing execution')
            const request = readRecord(execution.request, 'NEAR Ledger signing request')
            assertExactKeys(request, ['encoding', 'value'], 'NEAR Ledger signing request')
            if (execution.kind !== 'external' || request.encoding !== 'base64') {
              throw new Error('Invalid pending NEAR Ledger signing request')
            }
            return {
              kind: 'external' as const,
              request: {
                encoding: 'base64' as const,
                value: parseCanonicalBase64(request.value)
              }
            }
          })()
    if (
      typeof record.payloadFingerprint !== 'string' ||
      !/^[0-9a-f]{64}$/.test(record.payloadFingerprint)
    ) {
      throw new Error('Invalid pending NEAR payload fingerprint')
    }
    return Object.freeze({
      ...parseCommon(record),
      phase: 'awaiting-approval',
      prepared,
      signingSummary: parseSigningSummary(record.signingSummary, {
        family: 'near',
        chainId: parseChainId(prepared.chainId).id,
        operation: 'transaction'
      }) as NearTransactionSummary,
      signingCommandId: parseSigningCommandId(
        typeof record.signingCommandId === 'string' ? record.signingCommandId : ''
      ),
      ...(signingExecution === undefined ? {} : { signingExecution }),
      payloadFingerprint: record.payloadFingerprint,
      expiresAt: readTimestamp(record.expiresAt, 'pending NEAR signing expiry')
    })
  }
  if (record.phase === 'signed') {
    assertExactKeys(
      record,
      [
        'schemaVersion',
        'phase',
        'transactionId',
        'segmentId',
        'scope',
        'transactionBase64',
        'transactionHash',
        'signerId',
        'signedAt'
      ],
      'Pending NEAR transfer'
    )
    return Object.freeze({
      ...parseCommon(record),
      phase: 'signed',
      transactionBase64: parseCanonicalBase64(record.transactionBase64),
      transactionHash: parseNearBase58(record.transactionHash, 32, 'NEAR transaction hash'),
      signerId: parseNearAccountId(record.signerId, 'NEAR transaction signer account ID'),
      signedAt: readTimestamp(record.signedAt, 'NEAR signing time')
    })
  }
  throw new Error('Invalid pending NEAR transfer phase')
}

export interface NearPendingTransferStore {
  readonly get: (transactionId: TransactionId) => Promise<PendingNearTransfer | null>
  readonly getReviewGraph: (transactionId: TransactionId) => Promise<TransactionGraph | null>
  readonly list: () => Promise<readonly PendingNearTransfer[]>
  readonly clear: () => Promise<number>
  readonly put: (record: PendingNearTransfer, reviewGraph?: TransactionGraph) => Promise<void>
  readonly delete: (transactionId: TransactionId) => Promise<void>
}

export class ChromeSessionNearPendingTransferStore
  extends ChromeSessionPendingTransactionStore<PendingNearTransfer>
  implements NearPendingTransferStore
{
  constructor(storage: SessionStorageArea = chrome.storage.session) {
    super({
      storage,
      recordKeyPrefix: STORAGE_KEY_PREFIX,
      reviewGraphKeyPrefix: REVIEW_GRAPH_STORAGE_KEY_PREFIX,
      parseRecord: parsePendingNearTransfer,
      label: 'NEAR',
      maximumRecords: MAX_PENDING_TRANSFERS
    })
  }
}
