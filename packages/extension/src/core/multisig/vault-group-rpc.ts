/**
 * The page-facing `vault.group.*` RPC. Background answers it itself (it owns the wallet state, the
 * credential session and the sealed-record storage) and only forwards the Worker-side parts, so
 * these requests are validated here, at the first extension boundary they cross.
 */
import type { MultisigGroupScope } from '@/lib/multisig-group-storage'
import { parseMultisigGroupRecord } from '@/lib/multisig-group-storage'
import type { MultisigGroupRecord, MultisigThreshold } from './types'
import type { MultisigCreationOperation } from '@/lib/multisig-creation-storage'
import { parseEnvelope } from './messages'
import type { MultisigEnvelope } from './messages'
import { isDkgSessionIdText, isDkgShape } from './dkg-protocol'
import { isBase64Text } from './dkg-protocol'
import { base64ToBytes, bytesToBase64 } from '@/lib/bytes'
import {
  isVaultGroupId,
  isVaultWalletId,
  parseSealedVaultRecord,
  parseVaultRecordBinding,
  type VaultRecordBinding,
  type SealedVaultRecord,
  type VaultRecordSummary
} from './vault-record'

export type VaultGroupOpenRequest = {
  participants: 2 | 3
  threshold: 2 | 3
  mainnet: boolean
  scope: MultisigGroupScope
  groupId: string
  sessionId?: string
  operationId?: string
  binding?: VaultRecordBinding
  outerSessionId?: string
}

export type VaultGroupSaveRequest = {
  scope: MultisigGroupScope
  groupId: string
  record: SealedVaultRecord
  operationId?: string
}

export type VaultGroupSummaryResponse =
  | { status: 'missing' }
  | ({ status: 'ok' } & VaultRecordSummary)
export type VaultCreationEvidence = { sessionId: string; confirmations: MultisigEnvelope[] }
export function parseVaultCreationEvidence(value: unknown): VaultCreationEvidence | null {
  if (
    !hasKeys(value, ['sessionId', 'confirmations']) ||
    !isVaultWalletId(value.sessionId) ||
    !Array.isArray(value.confirmations) ||
    value.confirmations.length < 1 ||
    value.confirmations.length > 2
  )
    return null
  const confirmations = value.confirmations.map(parseEnvelope)
  if (
    confirmations.some(
      item =>
        !item ||
        item.message_type !== 'DKG_FINAL' ||
        item.encrypted_payload.length > 2048 ||
        item.authentication_data.length > 512
    )
  )
    return null
  return { sessionId: value.sessionId, confirmations: confirmations as MultisigEnvelope[] }
}

export interface VaultGroupSchema {
  'vault.group.pending': {
    request: { scope: MultisigGroupScope }
    response: MultisigCreationOperation[]
  }
  'vault.group.reserve': {
    request: { scope: MultisigGroupScope; threshold: MultisigThreshold }
    response: MultisigCreationOperation
  }
  'vault.group.commit': {
    request: {
      scope: MultisigGroupScope
      operationId: string
      group: MultisigGroupRecord
      evidence: VaultCreationEvidence
    }
    response: { phase: 'ready'; scope: MultisigGroupScope }
  }
  'vault.group.status': {
    request: { scope: MultisigGroupScope; operationId: string }
    response: MultisigCreationOperation
  }
  'vault.group.cancel': {
    request: { scope: MultisigGroupScope; operationId: string }
    response: true
  }
  'vault.group.open': { request: VaultGroupOpenRequest; response: { sessionId: string } }
  'vault.group.save': { request: VaultGroupSaveRequest; response: true }
  'vault.group.summary': {
    request: { scope: MultisigGroupScope }
    response: VaultGroupSummaryResponse
  }
  'vault.group.recover.prepare': {
    request: { scope: MultisigGroupScope; request: string }
    response: { recoveryId: string; reply: string; expiresAt: number }
  }
  'vault.group.recover.complete': {
    request: { scope: MultisigGroupScope; recoveryId: string }
    response: true
  }
  'vault.group.recover.cancel': {
    request: { scope: MultisigGroupScope; recoveryId: string }
    response: true
  }
}

export type VaultGroupMethod = keyof VaultGroupSchema

const METHODS: readonly VaultGroupMethod[] = [
  'vault.group.pending',
  'vault.group.reserve',
  'vault.group.commit',
  'vault.group.status',
  'vault.group.cancel',
  'vault.group.open',
  'vault.group.save',
  'vault.group.summary',
  'vault.group.recover.prepare',
  'vault.group.recover.complete',
  'vault.group.recover.cancel'
]

export function isVaultGroupMethod(method: string): method is VaultGroupMethod {
  return (METHODS as readonly string[]).includes(method)
}

const INVALID_REQUEST = 'Invalid vault group request'

function hasKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const actual = Object.keys(value)
  return (
    required.every(key => Object.prototype.hasOwnProperty.call(value, key)) &&
    actual.every(key => required.includes(key) || optional.includes(key))
  )
}

export function parseVaultGroupScope(value: unknown): MultisigGroupScope {
  if (
    !hasKeys(value, ['network', 'walletId', 'accountId']) ||
    (value.network !== 'mainnet' && value.network !== 'testnet') ||
    !isVaultWalletId(value.walletId) ||
    !isVaultWalletId(value.accountId)
  ) {
    throw new Error(INVALID_REQUEST)
  }
  return { network: value.network, walletId: value.walletId, accountId: value.accountId }
}

export function parseVaultGroupOpenRequest(payload: unknown): VaultGroupOpenRequest {
  if (
    !hasKeys(
      payload,
      ['participants', 'threshold', 'mainnet', 'scope', 'groupId'],
      ['sessionId', 'operationId', 'binding', 'outerSessionId']
    )
  ) {
    throw new Error(INVALID_REQUEST)
  }
  const shape = { participants: payload.participants, threshold: payload.threshold }
  if (
    !isDkgShape(shape) ||
    typeof payload.mainnet !== 'boolean' ||
    !isVaultGroupId(payload.groupId) ||
    (payload.sessionId !== undefined && !isDkgSessionIdText(payload.sessionId))
  ) {
    throw new Error(INVALID_REQUEST)
  }
  const binding =
    payload.binding === undefined ? undefined : parseVaultRecordBinding(payload.binding)
  if (
    binding === null ||
    (payload.outerSessionId !== undefined && !isVaultWalletId(payload.outerSessionId)) ||
    (payload.operationId !== undefined && !isVaultWalletId(payload.operationId))
  )
    throw new Error(INVALID_REQUEST)
  return {
    participants: shape.participants,
    threshold: shape.threshold,
    mainnet: payload.mainnet,
    scope: parseVaultGroupScope(payload.scope),
    groupId: payload.groupId,
    ...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId }),
    ...(payload.operationId === undefined ? {} : { operationId: payload.operationId }),
    ...(binding ? { binding } : {}),
    ...(payload.outerSessionId === undefined ? {} : { outerSessionId: payload.outerSessionId })
  }
}

export function parseVaultGroupSaveRequest(payload: unknown): VaultGroupSaveRequest {
  if (
    !hasKeys(payload, ['scope', 'groupId', 'record'], ['operationId']) ||
    !isVaultGroupId(payload.groupId) ||
    (payload.operationId !== undefined && !isVaultWalletId(payload.operationId))
  ) {
    throw new Error(INVALID_REQUEST)
  }
  const record = parseSealedVaultRecord(payload.record)
  if (!record) throw new Error(INVALID_REQUEST)
  return {
    scope: parseVaultGroupScope(payload.scope),
    groupId: payload.groupId,
    record,
    ...(payload.operationId === undefined ? {} : { operationId: payload.operationId })
  }
}

export function parseVaultGroupSummaryRequest(payload: unknown): { scope: MultisigGroupScope } {
  if (!hasKeys(payload, ['scope'])) throw new Error(INVALID_REQUEST)
  return { scope: parseVaultGroupScope(payload.scope) }
}

export function parseVaultRecoverRequest(
  method:
    | 'vault.group.recover.prepare'
    | 'vault.group.recover.complete'
    | 'vault.group.recover.cancel',
  payload: unknown
): { scope: MultisigGroupScope; request?: string; recoveryId?: string } {
  if (method === 'vault.group.recover.prepare') {
    if (!hasKeys(payload, ['scope', 'request']) || !isBase64Text(payload.request))
      throw new Error(INVALID_REQUEST)
    const bytes = base64ToBytes(payload.request)
    if (bytesToBase64(bytes) !== payload.request || bytes.length !== 202)
      throw new Error(INVALID_REQUEST)
    return { scope: parseVaultGroupScope(payload.scope), request: payload.request }
  }
  if (
    !hasKeys(payload, ['scope', 'recoveryId']) ||
    typeof payload.recoveryId !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(payload.recoveryId)
  )
    throw new Error(INVALID_REQUEST)
  return { scope: parseVaultGroupScope(payload.scope), recoveryId: payload.recoveryId }
}

export function parseCreationRequest(
  method:
    | 'vault.group.reserve'
    | 'vault.group.commit'
    | 'vault.group.status'
    | 'vault.group.cancel',
  payload: unknown
): {
  scope: MultisigGroupScope
  operationId?: string
  threshold?: MultisigThreshold
  group?: MultisigGroupRecord
  evidence?: VaultCreationEvidence
} {
  const keys =
    method === 'vault.group.reserve'
      ? ['scope', 'threshold']
      : method === 'vault.group.commit'
        ? ['scope', 'operationId', 'group', 'evidence']
        : ['scope', 'operationId']
  if (!hasKeys(payload, keys)) throw new Error(INVALID_REQUEST)
  const scope = parseVaultGroupScope(payload.scope)
  if (method === 'vault.group.reserve') {
    if (!['2-of-2', '2-of-3', '3-of-3'].includes(payload.threshold as string))
      throw new Error(INVALID_REQUEST)
    return { scope, threshold: payload.threshold as MultisigThreshold }
  }
  if (!isVaultWalletId(payload.operationId)) throw new Error(INVALID_REQUEST)
  if (method === 'vault.group.commit') {
    const group = parseMultisigGroupRecord(payload.group)
    const evidence = parseVaultCreationEvidence(payload.evidence)
    if (!group || !evidence) throw new Error(INVALID_REQUEST)
    return { scope, operationId: payload.operationId, group, evidence }
  }
  return { scope, operationId: payload.operationId }
}
