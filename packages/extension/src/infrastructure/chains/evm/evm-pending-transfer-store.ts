import { parseAccountId } from '@/core/accounts/domain'
import {
  parseKeyDomainId,
  parseSigningSummary,
  type EvmTransactionSummary,
  type SigningSummary
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
import { parsePreparedEvmTransfer, type PreparedEvmTransfer } from './evm-transaction-builder'
import { serializePreparedEvmUnsignedTransaction } from './evm-signed-transaction'
import { createKeystoneEthereumSignRequest } from '@/lib/keystone'
import { bytesToBase64, hexToBytes } from '@/lib/bytes'

const STORAGE_KEY_PREFIX = 'evm_pending_transfer:'
const REVIEW_GRAPH_STORAGE_KEY_PREFIX = 'evm_pending_review_graph:'
const SCHEMA_VERSION = 2 as const
const LEGACY_SCHEMA_VERSION = 1 as const
const MAX_PENDING_TRANSFERS = 256

interface PendingTransferBase {
  readonly schemaVersion: typeof SCHEMA_VERSION
  readonly transactionId: TransactionId
  readonly segmentId: TransactionSegmentId
  readonly scope: TransactionAccountScope
}

export interface AwaitingApprovalEvmTransfer extends PendingTransferBase {
  readonly phase: 'awaiting-approval'
  readonly prepared: PreparedEvmTransfer
  readonly signingSummary: SigningSummary
  readonly signingCommandId: SigningCommandId
  readonly signingExecution: SigningExecution
  readonly externalSigner: EvmExternalSignerBinding | null
  readonly payloadFingerprint: string
  readonly expiresAt: number
}

export interface EvmExternalSignerBinding {
  readonly vendor?: 'keystone' | 'ledger'
  readonly requestId: string
  readonly derivationPath: string
  readonly masterFingerprintHex?: string
  readonly address: string
}

export interface AwaitingExternalSignatureEvmTransfer extends Omit<
  AwaitingApprovalEvmTransfer,
  'phase' | 'signingExecution' | 'externalSigner'
> {
  readonly phase: 'awaiting-external-signature'
  readonly signingExecution: Extract<SigningExecution, { readonly kind: 'external' }>
  readonly externalSigner: EvmExternalSignerBinding
}

export interface SignedPendingEvmTransfer extends PendingTransferBase {
  readonly phase: 'signed'
  readonly rawTransaction: string
  readonly transactionHash: string
  readonly signedAt: number
}

export type PendingEvmSigningTransfer =
  | AwaitingApprovalEvmTransfer
  | AwaitingExternalSignatureEvmTransfer

export type PendingEvmTransfer = PendingEvmSigningTransfer | SignedPendingEvmTransfer

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
): void {
  if (
    Object.keys(value).length !== required.length ||
    !required.every(key => Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new Error(`${label} has invalid fields`)
  }
}

function readTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Invalid ${label}`)
  }
  return value as number
}

function readCanonicalBase64(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 * 1024 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

function parseExternalSigner(value: unknown): EvmExternalSignerBinding | null {
  if (value === null) return null
  const record = readRecord(value, 'Pending EVM external signer')
  const vendor = record.vendor === 'ledger' ? 'ledger' : 'keystone'
  assertExactKeys(
    record,
    vendor === 'ledger'
      ? ['vendor', 'requestId', 'derivationPath', 'address']
      : record.vendor === 'keystone'
        ? ['vendor', 'requestId', 'derivationPath', 'masterFingerprintHex', 'address']
        : ['requestId', 'derivationPath', 'masterFingerprintHex', 'address'],
    'Pending EVM external signer'
  )
  if (
    typeof record.requestId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      record.requestId
    ) ||
    typeof record.derivationPath !== 'string' ||
    !/^m(?:\/(?:0|[1-9][0-9]{0,9})'?){2,16}$/.test(record.derivationPath) ||
    (vendor === 'keystone' &&
      (typeof record.masterFingerprintHex !== 'string' ||
        !/^[0-9a-f]{8}$/.test(record.masterFingerprintHex))) ||
    typeof record.address !== 'string' ||
    !/^0x[0-9a-f]{40}$/.test(record.address)
  ) {
    throw new Error('Invalid pending EVM external signer')
  }
  return Object.freeze({
    ...(record.vendor === undefined ? {} : { vendor }),
    requestId: record.requestId,
    derivationPath: record.derivationPath,
    ...(vendor === 'keystone'
      ? { masterFingerprintHex: record.masterFingerprintHex as string }
      : {}),
    address: record.address
  })
}

function parseSigningExecution(
  value: unknown,
  prepared: PreparedEvmTransfer,
  externalSigner: EvmExternalSignerBinding | null
): SigningExecution {
  const record = readRecord(value, 'Pending EVM signing execution')
  if (record.kind === 'internal') {
    assertExactKeys(record, ['kind'], 'Pending EVM signing execution')
    if (externalSigner !== null)
      throw new Error('Internal EVM signing cannot bind an external signer')
    return Object.freeze({ kind: 'internal' as const })
  }
  if (record.kind !== 'external' || externalSigner === null) {
    throw new Error('Invalid pending EVM signing execution')
  }
  assertExactKeys(record, ['kind', 'request'], 'Pending EVM signing execution')
  const request = readRecord(record.request, 'Pending EVM external signing request')
  assertExactKeys(request, ['encoding', 'value'], 'Pending EVM external signing request')
  const requestBase64 = readCanonicalBase64(request.value, 'pending EVM signing request')
  const unsignedTransactionHex = serializePreparedEvmUnsignedTransaction(prepared)
  const expectedBase64 =
    externalSigner.vendor === 'ledger'
      ? bytesToBase64(hexToBytes(unsignedTransactionHex))
      : createKeystoneEthereumSignRequest({
          requestId: externalSigner.requestId,
          unsignedTransactionHex,
          chainId: Number(prepared.transaction.chainId),
          derivationPath: externalSigner.derivationPath,
          masterFingerprintHex: externalSigner.masterFingerprintHex!,
          address: externalSigner.address
        }).cborBase64
  if (
    request.encoding !== 'base64' ||
    requestBase64 !== expectedBase64 ||
    externalSigner.address !== prepared.from.toLowerCase()
  ) {
    throw new Error('Pending EVM external signing request does not match the prepared transaction')
  }
  return Object.freeze({
    kind: 'external' as const,
    request: Object.freeze({ encoding: 'base64' as const, value: requestBase64 })
  })
}

function parseScope(value: unknown): TransactionAccountScope {
  const record = readRecord(value, 'Pending EVM transfer scope')
  assertExactKeys(record, ['keyDomainId', 'accountId'], 'Pending EVM transfer scope')
  return Object.freeze({
    keyDomainId: parseKeyDomainId(record.keyDomainId),
    accountId: parseAccountId(record.accountId)
  })
}

function readCanonicalHex(
  value: unknown,
  label: string,
  options: { readonly bytes?: number; readonly maximumBytes?: number } = {}
): string {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-f]{2})+$/.test(value)) {
    throw new Error(`Invalid ${label}`)
  }
  const bytes = (value.length - 2) / 2
  if (
    (options.bytes !== undefined && bytes !== options.bytes) ||
    (options.maximumBytes !== undefined && bytes > options.maximumBytes)
  ) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

function parseCommon(record: Record<string, unknown>): PendingTransferBase {
  if (record.schemaVersion !== SCHEMA_VERSION && record.schemaVersion !== LEGACY_SCHEMA_VERSION) {
    throw new Error('Unsupported pending EVM transfer schema')
  }
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    transactionId: parseTransactionId(record.transactionId),
    segmentId: parseTransactionSegmentId(record.segmentId),
    scope: parseScope(record.scope)
  })
}

export function parsePendingEvmTransfer(value: unknown): PendingEvmTransfer {
  const record = readRecord(value, 'Pending EVM transfer')
  if (record.phase === 'awaiting-approval' && record.schemaVersion === LEGACY_SCHEMA_VERSION) {
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
        'payloadFingerprint',
        'expiresAt'
      ],
      'Legacy pending EVM transfer'
    )
    const fingerprint = record.payloadFingerprint
    if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) {
      throw new Error('Invalid pending EVM payload fingerprint')
    }
    const prepared = parsePreparedEvmTransfer(record.prepared)
    return Object.freeze({
      ...parseCommon(record),
      phase: 'awaiting-approval' as const,
      prepared,
      signingSummary: parseSigningSummary(record.signingSummary, {
        family: 'evm',
        chainId: prepared.chainId,
        operation: 'transaction'
      }) as EvmTransactionSummary,
      signingCommandId: parseSigningCommandId(
        typeof record.signingCommandId === 'string' ? record.signingCommandId : ''
      ),
      signingExecution: Object.freeze({ kind: 'internal' as const }),
      externalSigner: null,
      payloadFingerprint: fingerprint,
      expiresAt: readTimestamp(record.expiresAt, 'pending EVM signing expiry')
    })
  }
  if (
    record.schemaVersion === SCHEMA_VERSION &&
    (record.phase === 'awaiting-approval' || record.phase === 'awaiting-external-signature')
  ) {
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
        'signingExecution',
        'externalSigner',
        'payloadFingerprint',
        'expiresAt'
      ],
      'Pending EVM transfer'
    )
    const fingerprint = record.payloadFingerprint
    if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) {
      throw new Error('Invalid pending EVM payload fingerprint')
    }
    const prepared = parsePreparedEvmTransfer(record.prepared)
    const externalSigner = parseExternalSigner(record.externalSigner)
    const signingExecution = parseSigningExecution(
      record.signingExecution,
      prepared,
      externalSigner
    )
    if (
      record.phase === 'awaiting-external-signature' &&
      (signingExecution.kind !== 'external' || externalSigner === null)
    ) {
      throw new Error('Pending external EVM signature has no external request')
    }
    const parsed = Object.freeze({
      ...parseCommon(record),
      phase: record.phase,
      prepared,
      signingSummary: parseSigningSummary(record.signingSummary, {
        family: 'evm',
        chainId: prepared.chainId,
        operation: 'transaction'
      }) as EvmTransactionSummary,
      signingCommandId: parseSigningCommandId(
        typeof record.signingCommandId === 'string' ? record.signingCommandId : ''
      ),
      signingExecution,
      externalSigner,
      payloadFingerprint: fingerprint,
      expiresAt: readTimestamp(record.expiresAt, 'pending EVM signing expiry')
    })
    return record.phase === 'awaiting-external-signature'
      ? (parsed as AwaitingExternalSignatureEvmTransfer)
      : (parsed as AwaitingApprovalEvmTransfer)
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
        'rawTransaction',
        'transactionHash',
        'signedAt'
      ],
      'Pending EVM transfer'
    )
    return Object.freeze({
      ...parseCommon(record),
      phase: 'signed',
      rawTransaction: readCanonicalHex(record.rawTransaction, 'signed EVM transaction', {
        maximumBytes: 128 * 1024
      }),
      transactionHash: readCanonicalHex(record.transactionHash, 'EVM transaction hash', {
        bytes: 32
      }),
      signedAt: readTimestamp(record.signedAt, 'EVM signing time')
    })
  }
  throw new Error('Invalid pending EVM transfer phase')
}

export interface EvmPendingTransferStore {
  readonly get: (transactionId: TransactionId) => Promise<PendingEvmTransfer | null>
  readonly getReviewGraph: (transactionId: TransactionId) => Promise<TransactionGraph | null>
  readonly list: () => Promise<readonly PendingEvmTransfer[]>
  readonly clear: () => Promise<number>
  readonly put: (record: PendingEvmTransfer, reviewGraph?: TransactionGraph) => Promise<void>
  readonly delete: (transactionId: TransactionId) => Promise<void>
}

export class ChromeSessionEvmPendingTransferStore
  extends ChromeSessionPendingTransactionStore<PendingEvmTransfer>
  implements EvmPendingTransferStore
{
  constructor(storage: SessionStorageArea = chrome.storage.session) {
    super({
      storage,
      recordKeyPrefix: STORAGE_KEY_PREFIX,
      reviewGraphKeyPrefix: REVIEW_GRAPH_STORAGE_KEY_PREFIX,
      parseRecord: parsePendingEvmTransfer,
      label: 'EVM',
      maximumRecords: MAX_PENDING_TRANSFERS
    })
  }
}
