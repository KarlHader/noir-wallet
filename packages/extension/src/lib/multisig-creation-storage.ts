import {
  MULTISIG_CREATION_STORAGE_KEY,
  multisigGroupScopeKey,
  withMultisigStorageLock,
  parseMultisigGroupRecord
} from './multisig-group-storage'
import type { MultisigGroupScope } from './multisig-group-storage'
import type { MultisigGroupRecord, MultisigThreshold } from '@/core/multisig/types'
import { parseVaultCreationEvidence } from '@/core/multisig/vault-group-rpc'
import type { VaultCreationEvidence } from '@/core/multisig/vault-group-rpc'
import { storageJsonEquals } from './storage-json-equality'

export type CreationPhase =
  | 'reserved'
  | 'share_saved'
  | 'external_imported'
  | 'metadata_saved'
  | 'ready'
export interface MultisigCreationOperation {
  version: 1
  operationId: string
  scope: MultisigGroupScope
  parentAccountId: string
  accountName?: string
  groupId: string
  threshold: MultisigThreshold
  birthdayHeight: number
  createdAt: number
  phase: CreationPhase
  rosterHash?: string
  group?: MultisigGroupRecord
  outerSessionId?: string
  dkgSessionId?: string
  evidence?: VaultCreationEvidence
}

function parse(value: unknown): MultisigCreationOperation | null {
  if (!value || typeof value !== 'object') return null
  const op = value as MultisigCreationOperation
  const allowed = [
    'version',
    'operationId',
    'scope',
    'parentAccountId',
    'accountName',
    'groupId',
    'threshold',
    'birthdayHeight',
    'createdAt',
    'phase',
    'rosterHash',
    'group',
    'outerSessionId',
    'dkgSessionId',
    'evidence'
  ]
  if (Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) return null
  if (
    op.version !== 1 ||
    typeof op.operationId !== 'string' ||
    !op.operationId ||
    !op.scope ||
    !['mainnet', 'testnet'].includes(op.scope.network) ||
    typeof op.scope.walletId !== 'string' ||
    typeof op.scope.accountId !== 'string' ||
    typeof op.parentAccountId !== 'string' ||
    (op.accountName !== undefined &&
      (typeof op.accountName !== 'string' ||
        !op.accountName.trim() ||
        op.accountName.length > 128)) ||
    typeof op.groupId !== 'string' ||
    !['2-of-2', '2-of-3', '3-of-3'].includes(op.threshold) ||
    !Number.isSafeInteger(op.birthdayHeight) ||
    op.birthdayHeight < 0 ||
    op.birthdayHeight > 0xffffffff ||
    !Number.isSafeInteger(op.createdAt) ||
    !['reserved', 'share_saved', 'external_imported', 'metadata_saved', 'ready'].includes(op.phase)
  )
    return null
  if (op.rosterHash !== undefined && !/^[0-9a-f]{64}$/.test(op.rosterHash)) return null
  const group = op.group === undefined ? undefined : parseMultisigGroupRecord(op.group)
  const evidence = op.evidence === undefined ? undefined : parseVaultCreationEvidence(op.evidence)
  if (
    evidence === null ||
    (op.outerSessionId !== undefined &&
      (typeof op.outerSessionId !== 'string' || !op.outerSessionId)) ||
    (op.dkgSessionId !== undefined && typeof op.dkgSessionId !== 'string')
  )
    return null
  if (
    group === null ||
    !op.scope.walletId ||
    !op.scope.accountId ||
    !op.parentAccountId ||
    !op.groupId
  )
    return null
  return {
    version: 1,
    operationId: op.operationId,
    scope: {
      network: op.scope.network,
      walletId: op.scope.walletId,
      accountId: op.scope.accountId
    },
    parentAccountId: op.parentAccountId,
    ...(op.accountName ? { accountName: op.accountName } : {}),
    groupId: op.groupId,
    threshold: op.threshold,
    birthdayHeight: op.birthdayHeight,
    createdAt: op.createdAt,
    phase: op.phase,
    ...(op.rosterHash ? { rosterHash: op.rosterHash } : {}),
    ...(group ? { group } : {}),
    ...(op.outerSessionId ? { outerSessionId: op.outerSessionId } : {}),
    ...(op.dkgSessionId ? { dkgSessionId: op.dkgSessionId } : {}),
    ...(evidence ? { evidence } : {})
  }
}

async function raw(): Promise<Record<string, unknown>> {
  const value = (await chrome.storage.local.get(MULTISIG_CREATION_STORAGE_KEY))[
    MULTISIG_CREATION_STORAGE_KEY
  ]
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}
export async function readCreationOperation(
  scope: MultisigGroupScope
): Promise<MultisigCreationOperation | null> {
  const value = (await raw())[multisigGroupScopeKey(scope)]
  const op = parse(value)
  return op && multisigGroupScopeKey(op.scope) === multisigGroupScopeKey(scope) ? op : null
}
export async function listCreationOperations(): Promise<MultisigCreationOperation[]> {
  return Object.values(await raw()).flatMap(value => {
    const op = parse(value)
    return op ? [op] : []
  })
}
export function saveCreationOperation(op: MultisigCreationOperation): Promise<void> {
  const checked = parse(op)
  if (!checked) return Promise.reject(new Error('Invalid multisig creation operation'))
  return withMultisigStorageLock(async () => {
    const entries = await raw()
    const key = multisigGroupScopeKey(op.scope)
    await chrome.storage.local.set({
      [MULTISIG_CREATION_STORAGE_KEY]: { ...entries, [key]: checked }
    })
    if (!storageJsonEquals((await raw())[key], checked))
      throw new Error('Creation progress could not be saved')
  })
}
export function removeCreationOperation(
  scope: MultisigGroupScope,
  operationId: string
): Promise<void> {
  return withMultisigStorageLock(async () => {
    const entries = await raw()
    if (parse(entries[multisigGroupScopeKey(scope)])?.operationId !== operationId)
      throw new Error('Creation operation is unavailable')
    delete entries[multisigGroupScopeKey(scope)]
    await chrome.storage.local.set({ [MULTISIG_CREATION_STORAGE_KEY]: entries })
  })
}
