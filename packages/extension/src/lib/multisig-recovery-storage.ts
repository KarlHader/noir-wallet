import {
  isVaultWalletId,
  parseSealedVaultRecord,
  sealedVaultRecordEquals,
  type SealedVaultRecord
} from '@/core/multisig/vault-record'
import { withMultisigStorageLock, type MultisigGroupScope } from './multisig-group-storage'
import { storageJsonEquals } from './storage-json-equality'

export const MULTISIG_PHONE_RECOVERY_PENDING_STORAGE_KEY = 'multisig_phone_recovery_pending_v1'
export const MULTISIG_PHONE_RECOVERY_GENERATION_STORAGE_KEY =
  'multisig_phone_recovery_generation_v1'

export interface PendingPhoneRecovery {
  scope: MultisigGroupScope
  previous: SealedVaultRecord
  candidate: SealedVaultRecord
  expiresAt: number
  contextGeneration: number
}

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
  )
}

function sameScope(left: MultisigGroupScope, right: MultisigGroupScope): boolean {
  return (
    left.network === right.network &&
    left.walletId === right.walletId &&
    left.accountId === right.accountId
  )
}

function matchesScope(record: SealedVaultRecord, scope: MultisigGroupScope): boolean {
  return (
    record.version === 2 &&
    record.network === scope.network &&
    record.ownerWalletId === scope.walletId &&
    record.accountId === scope.accountId
  )
}

function parsePending(value: unknown): PendingPhoneRecovery | null {
  if (
    !isObject(value) ||
    !hasKeys(value, ['scope', 'previous', 'candidate', 'expiresAt', 'contextGeneration'])
  )
    return null
  const { scope, previous, candidate, expiresAt, contextGeneration } = value
  if (
    !isObject(scope) ||
    !hasKeys(scope, ['network', 'walletId', 'accountId']) ||
    (scope.network !== 'mainnet' && scope.network !== 'testnet') ||
    !isVaultWalletId(scope.walletId) ||
    !isVaultWalletId(scope.accountId) ||
    typeof expiresAt !== 'number' ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= 0 ||
    typeof contextGeneration !== 'number' ||
    !Number.isSafeInteger(contextGeneration) ||
    contextGeneration < 0
  )
    return null
  const boundScope: MultisigGroupScope = {
    network: scope.network,
    walletId: scope.walletId,
    accountId: scope.accountId
  }
  const original = parseSealedVaultRecord(previous)
  const updated = parseSealedVaultRecord(candidate)
  if (
    !original ||
    !updated ||
    !matchesScope(original, boundScope) ||
    !matchesScope(updated, boundScope) ||
    original.groupId !== updated.groupId ||
    sealedVaultRecordEquals(original, updated)
  )
    return null
  return { scope: boundScope, previous: original, candidate: updated, expiresAt, contextGeneration }
}

function assertId(id: string): void {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error('Invalid phone recovery id')
}

function parseStored(stored: unknown): Record<string, PendingPhoneRecovery> {
  if (stored === undefined) return {}
  if (!isObject(stored)) throw new Error('Invalid pending phone recovery storage')
  const entries = Object.entries(stored).map(([id, value]) => {
    assertId(id)
    const pending = parsePending(value)
    if (!pending) throw new Error('Invalid pending phone recovery storage')
    return [id, pending] as const
  })
  return Object.fromEntries(entries)
}

async function readStored(): Promise<Record<string, PendingPhoneRecovery>> {
  const stored: unknown = (
    await chrome.storage.session.get(MULTISIG_PHONE_RECOVERY_PENDING_STORAGE_KEY)
  )[MULTISIG_PHONE_RECOVERY_PENDING_STORAGE_KEY]
  return parseStored(stored)
}

function parseGeneration(stored: unknown): number {
  if (stored === undefined) return 0
  if (typeof stored !== 'number' || !Number.isSafeInteger(stored) || stored < 0)
    throw new Error('Invalid phone recovery generation')
  return stored
}

export async function readPhoneRecoveryGeneration(): Promise<number> {
  const stored: unknown = (
    await chrome.storage.session.get(MULTISIG_PHONE_RECOVERY_GENERATION_STORAGE_KEY)
  )[MULTISIG_PHONE_RECOVERY_GENERATION_STORAGE_KEY]
  return parseGeneration(stored)
}

export function invalidatePendingPhoneRecoveries(): Promise<void> {
  return withMultisigStorageLock(async () => {
    const current = await readPhoneRecoveryGeneration()
    if (current === Number.MAX_SAFE_INTEGER) throw new Error('Phone recovery generation exhausted')
    const next = current + 1
    await chrome.storage.session.set({
      [MULTISIG_PHONE_RECOVERY_GENERATION_STORAGE_KEY]: next,
      [MULTISIG_PHONE_RECOVERY_PENDING_STORAGE_KEY]: {}
    })
    const stored = await chrome.storage.session.get([
      MULTISIG_PHONE_RECOVERY_GENERATION_STORAGE_KEY,
      MULTISIG_PHONE_RECOVERY_PENDING_STORAGE_KEY
    ])
    if (
      stored[MULTISIG_PHONE_RECOVERY_GENERATION_STORAGE_KEY] !== next ||
      !storageJsonEquals(stored[MULTISIG_PHONE_RECOVERY_PENDING_STORAGE_KEY], {})
    )
      throw new Error('Phone recovery invalidation could not be saved')
  })
}

export async function readPendingPhoneRecovery(id: string): Promise<PendingPhoneRecovery | null> {
  assertId(id)
  const snapshot = await chrome.storage.session.get([
    MULTISIG_PHONE_RECOVERY_PENDING_STORAGE_KEY,
    MULTISIG_PHONE_RECOVERY_GENERATION_STORAGE_KEY
  ])
  const generation = parseGeneration(snapshot[MULTISIG_PHONE_RECOVERY_GENERATION_STORAGE_KEY])
  const pending = parseStored(snapshot[MULTISIG_PHONE_RECOVERY_PENDING_STORAGE_KEY])[id]
  return pending && pending.contextGeneration === generation && pending.expiresAt > Date.now()
    ? pending
    : null
}

export async function savePendingPhoneRecovery(
  id: string,
  pending: PendingPhoneRecovery
): Promise<void> {
  assertId(id)
  const checked = parsePending(pending)
  if (!checked || checked.expiresAt <= Date.now()) throw new Error('Invalid pending phone recovery')
  return withMultisigStorageLock(async () => {
    if (checked.contextGeneration !== (await readPhoneRecoveryGeneration()))
      throw new Error('Phone recovery context changed')
    const stored = await readStored()
    if (stored[id] && !sameScope(stored[id].scope, checked.scope))
      throw new Error('Phone recovery id already exists')
    const now = Date.now()
    const kept = Object.fromEntries(
      Object.entries(stored).filter(
        ([, entry]) => entry.expiresAt > now && !sameScope(entry.scope, checked.scope)
      )
    )
    const next = { ...kept, [id]: checked }
    await chrome.storage.session.set({ [MULTISIG_PHONE_RECOVERY_PENDING_STORAGE_KEY]: next })
    const readback: unknown = (
      await chrome.storage.session.get(MULTISIG_PHONE_RECOVERY_PENDING_STORAGE_KEY)
    )[MULTISIG_PHONE_RECOVERY_PENDING_STORAGE_KEY]
    if (!storageJsonEquals(readback, next))
      throw new Error('Pending phone recovery could not be saved')
  })
}

export async function removePendingPhoneRecovery(id: string): Promise<void> {
  assertId(id)
  return withMultisigStorageLock(async () => {
    const stored = await readStored()
    if (!Object.prototype.hasOwnProperty.call(stored, id)) return
    const kept = Object.fromEntries(Object.entries(stored).filter(([key]) => key !== id))
    if (Object.keys(kept).length === 0)
      await chrome.storage.session.remove(MULTISIG_PHONE_RECOVERY_PENDING_STORAGE_KEY)
    else await chrome.storage.session.set({ [MULTISIG_PHONE_RECOVERY_PENDING_STORAGE_KEY]: kept })
    const readback: unknown = (
      await chrome.storage.session.get(MULTISIG_PHONE_RECOVERY_PENDING_STORAGE_KEY)
    )[MULTISIG_PHONE_RECOVERY_PENDING_STORAGE_KEY]
    if (
      Object.keys(kept).length === 0 ? readback !== undefined : !storageJsonEquals(readback, kept)
    )
      throw new Error('Pending phone recovery could not be removed')
  })
}
