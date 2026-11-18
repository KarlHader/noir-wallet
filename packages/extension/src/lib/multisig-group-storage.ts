import { deleteMultisigIdentity } from '@/lib/multisig-identity-storage'
import type { MultisigDevice, MultisigGroupRecord } from '@/core/multisig/types'
import { storageJsonEquals } from './storage-json-equality'

export const MULTISIG_GROUPS_STORAGE_KEY = 'multisig_groups_v1'
export const MULTISIG_BANNER_STORAGE_KEY = 'multisig_banner_dismissed_v1'
export const MULTISIG_VAULT_RECORDS_STORAGE_KEY = 'multisig_vault_records_v1'
export const MULTISIG_CREATION_STORAGE_KEY = 'multisig_creation_v1'
export const MULTISIG_SIGNING_STORAGE_KEY = 'multisig_signing_v1'
const MULTISIG_STORAGE_LOCK_NAME = 'noir-multisig-storage'

// One lock for all three keys: every read-modify-write below, in any extension context, would
// otherwise overwrite a concurrent writer's change to the same key.
export async function withMultisigStorageLock<T>(operation: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error('Multisig storage coordination is unavailable')
  return navigator.locks.request(MULTISIG_STORAGE_LOCK_NAME, operation)
}

export interface MultisigGroupScope {
  network: string
  walletId: string
  accountId: string
}

// The network is part of the key so a testnet group never shows on the mainnet account.
export function multisigGroupScopeKey(scope: MultisigGroupScope): string {
  return `${scope.network}:${scope.walletId}:${scope.accountId}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseDevice(value: unknown): MultisigDevice | null {
  if (!isRecord(value)) return null
  const { slot, role, name, model, platform } = value
  if (
    typeof slot !== 'number' ||
    !Number.isFinite(slot) ||
    typeof role !== 'string' ||
    typeof name !== 'string' ||
    typeof model !== 'string' ||
    typeof platform !== 'string'
  ) {
    return null
  }
  // The checks above are deliberately as loose as the stored shape: a stored record is a display
  // cache, so a newer role or platform label must not hide the group badge.
  return { slot, role, name, model, platform } as MultisigDevice
}

// Rebuilding the object field by field means only the known, non-secret fields are ever written
// or returned, whatever else the caller or the stored value carries.
export function parseMultisigGroupRecord(value: unknown): MultisigGroupRecord | null {
  if (!isRecord(value)) return null
  const { groupId, threshold, transportKind, devices, fingerprint, createdAt, mock } = value
  if (
    typeof groupId !== 'string' ||
    typeof threshold !== 'string' ||
    typeof transportKind !== 'string' ||
    typeof fingerprint !== 'string' ||
    typeof createdAt !== 'number' ||
    !Number.isFinite(createdAt) ||
    typeof mock !== 'boolean' ||
    !Array.isArray(devices)
  ) {
    return null
  }
  const parsedDevices: MultisigDevice[] = []
  for (const device of devices) {
    const parsed = parseDevice(device)
    if (!parsed) return null
    parsedDevices.push(parsed)
  }
  return {
    groupId,
    threshold,
    transportKind,
    devices: parsedDevices,
    fingerprint,
    createdAt,
    mock
  } as MultisigGroupRecord
}

async function readStoredGroups(): Promise<Record<string, MultisigGroupRecord>> {
  const stored = (await chrome.storage.local.get(MULTISIG_GROUPS_STORAGE_KEY))[
    MULTISIG_GROUPS_STORAGE_KEY
  ]
  if (!isRecord(stored)) return {}
  // fromEntries defines own properties, so a hostile stored key such as `__proto__` stays data.
  return Object.fromEntries(
    Object.entries(stored).flatMap(([key, value]) => {
      const record = parseMultisigGroupRecord(value)
      return record ? [[key, record] as const] : []
    })
  )
}

async function readStoredBannerFlags(): Promise<Record<string, true>> {
  const stored = (await chrome.storage.local.get(MULTISIG_BANNER_STORAGE_KEY))[
    MULTISIG_BANNER_STORAGE_KEY
  ]
  if (!isRecord(stored)) return {}
  return Object.fromEntries(
    Object.entries(stored).flatMap(([key, value]) => (value === true ? [[key, true] as const] : []))
  )
}

export async function readAllMultisigGroups(): Promise<
  Readonly<Record<string, MultisigGroupRecord>>
> {
  return Object.freeze(await readStoredGroups())
}

export async function readMultisigGroup(
  scope: MultisigGroupScope
): Promise<MultisigGroupRecord | null> {
  return (await readStoredGroups())[multisigGroupScopeKey(scope)] ?? null
}

export async function writeMultisigGroup(
  scope: MultisigGroupScope,
  record: MultisigGroupRecord
): Promise<void> {
  const sanitized = parseMultisigGroupRecord(record)
  if (!sanitized) throw new Error('Invalid multisig group record')
  await withMultisigStorageLock(async () => {
    const stored = (await chrome.storage.local.get(MULTISIG_GROUPS_STORAGE_KEY))[
      MULTISIG_GROUPS_STORAGE_KEY
    ]
    const groups = isRecord(stored) ? stored : {}
    await chrome.storage.local.set({
      [MULTISIG_GROUPS_STORAGE_KEY]: { ...groups, [multisigGroupScopeKey(scope)]: sanitized }
    })
    const readback = (await chrome.storage.local.get(MULTISIG_GROUPS_STORAGE_KEY))[
      MULTISIG_GROUPS_STORAGE_KEY
    ]
    if (
      !isRecord(readback) ||
      !storageJsonEquals(readback[multisigGroupScopeKey(scope)], sanitized)
    )
      throw new Error('Multisig group could not be saved')
  })
}

export async function isMultisigBannerDismissed(scope: MultisigGroupScope): Promise<boolean> {
  return (await readStoredBannerFlags())[multisigGroupScopeKey(scope)] === true
}

export async function dismissMultisigBanner(scope: MultisigGroupScope): Promise<void> {
  await withMultisigStorageLock(async () => {
    const flags = await readStoredBannerFlags()
    await chrome.storage.local.set({
      [MULTISIG_BANNER_STORAGE_KEY]: { ...flags, [multisigGroupScopeKey(scope)]: true }
    })
  })
}

export async function clearMultisigData(): Promise<void> {
  await withMultisigStorageLock(async () => {
    await chrome.storage.local.remove([
      MULTISIG_GROUPS_STORAGE_KEY,
      MULTISIG_BANNER_STORAGE_KEY,
      MULTISIG_VAULT_RECORDS_STORAGE_KEY,
      MULTISIG_CREATION_STORAGE_KEY,
      MULTISIG_SIGNING_STORAGE_KEY
    ])
    await deleteMultisigIdentity()
  })
}
