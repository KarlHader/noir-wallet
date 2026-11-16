import { parseAccountId } from '@/core/accounts/domain'
import { parseChainId } from '@/core/chains/registry'
import {
  parseKeyDomainId,
  parseSigningSummary,
  type SolanaTransactionSummary
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
import {
  parsePreparedSolanaTransfer,
  type PreparedSolanaTransfer
} from './solana-transfer-preparer'
import { parseSignedSolanaTransaction } from './solana-signed-transaction'

const STORAGE_KEY_PREFIX = 'solana_pending_transfer:'
const REVIEW_GRAPH_STORAGE_KEY_PREFIX = 'solana_pending_review_graph:'
const SCHEMA_VERSION = 1 as const
const MAX_PENDING_TRANSFERS = 256

interface PendingTransferBase {
  readonly schemaVersion: typeof SCHEMA_VERSION
  readonly transactionId: TransactionId
  readonly segmentId: TransactionSegmentId
  readonly scope: TransactionAccountScope
}

export interface AwaitingApprovalSolanaTransfer extends PendingTransferBase {
  readonly phase: 'awaiting-approval'
  readonly prepared: PreparedSolanaTransfer
  readonly signingSummary: SolanaTransactionSummary
  readonly signingCommandId: SigningCommandId
  readonly signingExecution?: SigningExecution
  readonly accountIndex?: number
  readonly payloadFingerprint: string
  readonly expiresAt: number
}

export interface SignedPendingSolanaTransfer extends PendingTransferBase {
  readonly phase: 'signed'
  readonly transactionBase64: string
  readonly transactionHash: string
  readonly messageBase64: string
  readonly lastValidBlockHeight: number
  readonly signedAt: number
}

export type PendingSolanaTransfer = AwaitingApprovalSolanaTransfer | SignedPendingSolanaTransfer

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

function parseScope(value: unknown): TransactionAccountScope {
  const record = readRecord(value, 'Pending Solana transfer scope')
  assertExactKeys(record, ['keyDomainId', 'accountId'], 'Pending Solana transfer scope')
  return Object.freeze({
    keyDomainId: parseKeyDomainId(record.keyDomainId),
    accountId: parseAccountId(record.accountId)
  })
}

function parseCommon(record: Record<string, unknown>): PendingTransferBase {
  if (record.schemaVersion !== SCHEMA_VERSION) {
    throw new Error('Unsupported pending Solana transfer schema')
  }
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    transactionId: parseTransactionId(record.transactionId),
    segmentId: parseTransactionSegmentId(record.segmentId),
    scope: parseScope(record.scope)
  })
}

export function parsePendingSolanaTransfer(value: unknown): PendingSolanaTransfer {
  const record = readRecord(value, 'Pending Solana transfer')
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
        ...(Object.prototype.hasOwnProperty.call(record, 'accountIndex') ? ['accountIndex'] : []),
        'payloadFingerprint',
        'expiresAt'
      ],
      'Pending Solana transfer'
    )
    const prepared = parsePreparedSolanaTransfer(record.prepared)
    if (
      record.accountIndex !== undefined &&
      (!Number.isSafeInteger(record.accountIndex) ||
        (record.accountIndex as number) < 0 ||
        (record.accountIndex as number) > 0x7fffffff)
    ) {
      throw new Error('Invalid pending Solana account index')
    }
    const signingExecution: SigningExecution | undefined =
      record.signingExecution === undefined
        ? undefined
        : (() => {
            const execution = readRecord(record.signingExecution, 'Solana signing execution')
            if (execution.kind === 'internal') {
              assertExactKeys(execution, ['kind'], 'Solana signing execution')
              return { kind: 'internal' as const }
            }
            assertExactKeys(execution, ['kind', 'request'], 'Solana signing execution')
            const request = readRecord(execution.request, 'Solana Ledger signing request')
            assertExactKeys(request, ['encoding', 'value'], 'Solana Ledger signing request')
            if (
              execution.kind !== 'external' ||
              request.encoding !== 'base64' ||
              request.value !== prepared.transactionBase64
            ) {
              throw new Error('Invalid pending Solana Ledger signing request')
            }
            return {
              kind: 'external' as const,
              request: { encoding: 'base64' as const, value: prepared.transactionBase64 }
            }
          })()
    if (
      typeof record.payloadFingerprint !== 'string' ||
      !/^[0-9a-f]{64}$/.test(record.payloadFingerprint)
    ) {
      throw new Error('Invalid pending Solana payload fingerprint')
    }
    return Object.freeze({
      ...parseCommon(record),
      phase: 'awaiting-approval',
      prepared,
      signingSummary: parseSigningSummary(record.signingSummary, {
        family: 'solana',
        chainId: parseChainId(prepared.chainId).id,
        operation: 'transaction'
      }) as SolanaTransactionSummary,
      signingCommandId: parseSigningCommandId(
        typeof record.signingCommandId === 'string' ? record.signingCommandId : ''
      ),
      ...(signingExecution === undefined ? {} : { signingExecution }),
      ...(record.accountIndex === undefined ? {} : { accountIndex: record.accountIndex as number }),
      payloadFingerprint: record.payloadFingerprint,
      expiresAt: readTimestamp(record.expiresAt, 'pending Solana signing expiry')
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
        'messageBase64',
        'lastValidBlockHeight',
        'signedAt'
      ],
      'Pending Solana transfer'
    )
    const signed = parseSignedSolanaTransaction(record.transactionBase64, record.transactionHash)
    if (
      record.messageBase64 !== signed.messageBase64 ||
      !Number.isSafeInteger(record.lastValidBlockHeight) ||
      (record.lastValidBlockHeight as number) <= 0
    ) {
      throw new Error('Invalid signed pending Solana transaction metadata')
    }
    return Object.freeze({
      ...parseCommon(record),
      phase: 'signed',
      ...signed,
      lastValidBlockHeight: record.lastValidBlockHeight as number,
      signedAt: readTimestamp(record.signedAt, 'Solana signing time')
    })
  }
  throw new Error('Invalid pending Solana transfer phase')
}

export interface SolanaPendingTransferStore {
  readonly get: (transactionId: TransactionId) => Promise<PendingSolanaTransfer | null>
  readonly getReviewGraph: (transactionId: TransactionId) => Promise<TransactionGraph | null>
  readonly list: () => Promise<readonly PendingSolanaTransfer[]>
  readonly clear: () => Promise<number>
  readonly put: (record: PendingSolanaTransfer, reviewGraph?: TransactionGraph) => Promise<void>
  readonly delete: (transactionId: TransactionId) => Promise<void>
}

export class ChromeSessionSolanaPendingTransferStore
  extends ChromeSessionPendingTransactionStore<PendingSolanaTransfer>
  implements SolanaPendingTransferStore
{
  constructor(storage: SessionStorageArea = chrome.storage.session) {
    super({
      storage,
      recordKeyPrefix: STORAGE_KEY_PREFIX,
      reviewGraphKeyPrefix: REVIEW_GRAPH_STORAGE_KEY_PREFIX,
      parseRecord: parsePendingSolanaTransfer,
      label: 'Solana',
      maximumRecords: MAX_PENDING_TRANSFERS
    })
  }
}
