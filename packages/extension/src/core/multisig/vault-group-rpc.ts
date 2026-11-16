/**
 * The page-facing `vault.group.*` RPC. Background answers it itself (it owns the wallet state, the
 * credential session and the sealed-record storage) and only forwards the Worker-side parts, so
 * these requests are validated here, at the first extension boundary they cross.
 */
import type { MultisigGroupScope } from '@/lib/multisig-group-storage'
import { isDkgShape } from './dkg-protocol'
import {
  isVaultGroupId,
  isVaultWalletId,
  parseSealedVaultRecord,
  type SealedVaultRecord,
  type VaultRecordSummary
} from './vault-record'

export type VaultGroupOpenRequest = {
  participants: 2 | 3
  threshold: 2 | 3
  mainnet: boolean
  scope: MultisigGroupScope
  groupId: string
}

export type VaultGroupSaveRequest = {
  scope: MultisigGroupScope
  groupId: string
  record: SealedVaultRecord
}

export type VaultGroupSummaryResponse =
  | { status: 'missing' }
  | ({ status: 'ok' } & VaultRecordSummary)

export interface VaultGroupSchema {
  'vault.group.open': { request: VaultGroupOpenRequest; response: { sessionId: string } }
  'vault.group.save': { request: VaultGroupSaveRequest; response: true }
  'vault.group.summary': {
    request: { scope: MultisigGroupScope }
    response: VaultGroupSummaryResponse
  }
}

export type VaultGroupMethod = keyof VaultGroupSchema

const METHODS: readonly VaultGroupMethod[] = [
  'vault.group.open',
  'vault.group.save',
  'vault.group.summary'
]

export function isVaultGroupMethod(method: string): method is VaultGroupMethod {
  return (METHODS as readonly string[]).includes(method)
}

const INVALID_REQUEST = 'Invalid vault group request'

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const actual = Object.keys(value)
  return (
    actual.length === keys.length &&
    keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
  )
}

function parseScope(value: unknown): MultisigGroupScope {
  if (
    !hasExactKeys(value, ['network', 'walletId', 'accountId']) ||
    (value.network !== 'mainnet' && value.network !== 'testnet') ||
    !isVaultWalletId(value.walletId) ||
    !isVaultWalletId(value.accountId)
  ) {
    throw new Error(INVALID_REQUEST)
  }
  return { network: value.network, walletId: value.walletId, accountId: value.accountId }
}

export function parseVaultGroupOpenRequest(payload: unknown): VaultGroupOpenRequest {
  if (!hasExactKeys(payload, ['participants', 'threshold', 'mainnet', 'scope', 'groupId'])) {
    throw new Error(INVALID_REQUEST)
  }
  const shape = { participants: payload.participants, threshold: payload.threshold }
  if (
    !isDkgShape(shape) ||
    typeof payload.mainnet !== 'boolean' ||
    !isVaultGroupId(payload.groupId)
  ) {
    throw new Error(INVALID_REQUEST)
  }
  return {
    participants: shape.participants,
    threshold: shape.threshold,
    mainnet: payload.mainnet,
    scope: parseScope(payload.scope),
    groupId: payload.groupId
  }
}

export function parseVaultGroupSaveRequest(payload: unknown): VaultGroupSaveRequest {
  if (!hasExactKeys(payload, ['scope', 'groupId', 'record']) || !isVaultGroupId(payload.groupId)) {
    throw new Error(INVALID_REQUEST)
  }
  const record = parseSealedVaultRecord(payload.record)
  if (!record) throw new Error(INVALID_REQUEST)
  return { scope: parseScope(payload.scope), groupId: payload.groupId, record }
}

export function parseVaultGroupSummaryRequest(payload: unknown): { scope: MultisigGroupScope } {
  if (!hasExactKeys(payload, ['scope'])) throw new Error(INVALID_REQUEST)
  return { scope: parseScope(payload.scope) }
}
