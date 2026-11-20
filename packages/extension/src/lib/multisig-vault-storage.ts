import {
  MULTISIG_BANNER_STORAGE_KEY,
  MULTISIG_GROUPS_STORAGE_KEY,
  MULTISIG_VAULT_RECORDS_STORAGE_KEY,
  MULTISIG_CREATION_STORAGE_KEY,
  MULTISIG_SIGNING_STORAGE_KEY,
  multisigGroupScopeKey,
  withMultisigStorageLock,
  type MultisigGroupScope
} from '@/lib/multisig-group-storage'
import {
  parseSealedVaultRecord,
  sealedVaultRecordEquals,
  type SealedVaultRecord
} from '@/core/multisig/vault-record'
import {
  parseSigningJournalScopeKey,
  type SigningJournalScope
} from '@/core/multisig/signing-journal'
import {
  assertNoUnresolvedMultisigTransactionsLocked,
  assertNoMultisigRecoveryConflictLocked,
  deleteResolvedFinalizationRecoveryLocked,
  MULTISIG_TRANSACTION_STORAGE_KEY
} from './multisig-transaction-guard'

const NETWORKS = ['mainnet', 'testnet'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readRawMap(storageKey: string): Promise<Record<string, unknown>> {
  const stored = (await chrome.storage.local.get(storageKey))[storageKey]
  return isRecord(stored) ? stored : {}
}

// The scope key starts with the network, so an entry sealed for one network can never be read
// back as another network's record, even if the stored map was edited or migrated by hand.
async function readStoredVaults(): Promise<Record<string, SealedVaultRecord>> {
  const stored = await readRawMap(MULTISIG_VAULT_RECORDS_STORAGE_KEY)
  // fromEntries defines own properties, so a hostile stored key such as `__proto__` stays data.
  return Object.fromEntries(
    Object.entries(stored).flatMap(([key, value]) => {
      const record = parseSealedVaultRecord(value)
      return record &&
        key.startsWith(`${record.network}:`) &&
        (record.version !== 2 ||
          key ===
            multisigGroupScopeKey({
              network: record.network,
              walletId: record.ownerWalletId,
              accountId: record.accountId
            }))
        ? [[key, record] as const]
        : []
    })
  )
}

export async function readVaultRecord(
  scope: MultisigGroupScope
): Promise<SealedVaultRecord | null> {
  return (await readStoredVaults())[multisigGroupScopeKey(scope)] ?? null
}

/** Writes the record and proves it landed, as one step other writers cannot interleave with. */
export function saveVaultRecordVerified(
  scope: MultisigGroupScope,
  record: SealedVaultRecord
): Promise<void> {
  const sanitized = parseSealedVaultRecord(record)
  if (
    !sanitized ||
    sanitized.network !== scope.network ||
    (sanitized.version === 2 &&
      (sanitized.accountId !== scope.accountId || sanitized.ownerWalletId !== scope.walletId))
  ) {
    return Promise.reject(new Error('Invalid vault record'))
  }
  const key = multisigGroupScopeKey(scope)
  return withMultisigStorageLock(async () => {
    // Raw, not parsed: an entry this build cannot read (a newer version, say) belongs to someone
    // and must survive a save for another scope untouched.
    const before = await readRawMap(MULTISIG_VAULT_RECORDS_STORAGE_KEY)
    const hadPrevious = Object.prototype.hasOwnProperty.call(before, key)
    const previous = before[key]
    // If this write throws, nothing was changed and the earlier record is still the stored one.
    await chrome.storage.local.set({
      [MULTISIG_VAULT_RECORDS_STORAGE_KEY]: { ...before, [key]: sanitized }
    })
    const after = await readRawMap(MULTISIG_VAULT_RECORDS_STORAGE_KEY)
    const stored = Object.prototype.hasOwnProperty.call(after, key)
      ? parseSealedVaultRecord(after[key])
      : null
    if (stored && sealedVaultRecordEquals(stored, sanitized)) return
    // A record that did not land unchanged must not replace a good one: put back what was there.
    const restored: Record<string, unknown> = { ...after }
    if (hadPrevious) restored[key] = previous
    else delete restored[key]
    await chrome.storage.local.set({ [MULTISIG_VAULT_RECORDS_STORAGE_KEY]: restored })
    throw new Error('Vault record could not be saved')
  })
}

/** Replace only the record whose phone proof was reviewed, under the shared multisig lock. */
export function replaceVaultRecordForRecovery(
  scope: MultisigGroupScope,
  previous: SealedVaultRecord,
  candidate: SealedVaultRecord,
  assertAuthorized: () => Promise<void>
): Promise<void> {
  const checked = parseSealedVaultRecord(candidate)
  if (
    !checked ||
    checked.version !== 2 ||
    checked.network !== scope.network ||
    checked.ownerWalletId !== scope.walletId ||
    checked.accountId !== scope.accountId ||
    checked.groupId !== previous.groupId
  )
    return Promise.reject(new Error('Invalid vault recovery record'))
  const key = multisigGroupScopeKey(scope)
  return withMultisigStorageLock(async () => {
    await assertNoMultisigRecoveryConflictLocked(
      scope as {
        network: 'mainnet' | 'testnet'
        walletId: string
        accountId: string
      }
    )
    await assertAuthorized()
    const before = await readRawMap(MULTISIG_VAULT_RECORDS_STORAGE_KEY)
    const current = parseSealedVaultRecord(before[key])
    if (!current || !sealedVaultRecordEquals(current, previous))
      throw new Error('Vault recovery record changed')
    await chrome.storage.local.set({
      [MULTISIG_VAULT_RECORDS_STORAGE_KEY]: { ...before, [key]: checked }
    })
    const after = await readRawMap(MULTISIG_VAULT_RECORDS_STORAGE_KEY)
    const stored = parseSealedVaultRecord(after[key])
    if (stored && sealedVaultRecordEquals(stored, checked)) return
    await chrome.storage.local.set({
      [MULTISIG_VAULT_RECORDS_STORAGE_KEY]: { ...after, [key]: before[key] }
    })
    throw new Error('Vault recovery record could not be saved')
  })
}

// Removes matching entries from all three maps in one lock; a map with no match is not rewritten.
async function deleteMatching(
  matches: (key: string) => boolean,
  matchesSigningScope: (scope: SigningJournalScope) => boolean,
  matchesTransaction: (walletId: string, accountId: string) => boolean,
  walletId: string
): Promise<void> {
  await withMultisigStorageLock(async () => {
    await assertNoUnresolvedMultisigTransactionsLocked(matchesTransaction, [walletId])
    await deleteResolvedFinalizationRecoveryLocked(matchesTransaction)
    for (const storageKey of [
      MULTISIG_VAULT_RECORDS_STORAGE_KEY,
      MULTISIG_GROUPS_STORAGE_KEY,
      MULTISIG_BANNER_STORAGE_KEY,
      MULTISIG_CREATION_STORAGE_KEY,
      MULTISIG_SIGNING_STORAGE_KEY,
      MULTISIG_TRANSACTION_STORAGE_KEY
    ]) {
      const stored = await readRawMap(storageKey)
      const entries = Object.entries(stored)
      const kept = entries.filter(([key]) => {
        if (
          storageKey !== MULTISIG_SIGNING_STORAGE_KEY &&
          storageKey !== MULTISIG_TRANSACTION_STORAGE_KEY
        )
          return !matches(key)
        const scope = parseSigningJournalScopeKey(key)
        return !scope || !matchesSigningScope(scope)
      })
      if (kept.length === entries.length) continue
      await chrome.storage.local.set({ [storageKey]: Object.fromEntries(kept) })
    }
  })
}

export async function deleteMultisigDataForAccount(
  walletId: string,
  accountId: string
): Promise<void> {
  const targets = new Set(
    NETWORKS.map(network => multisigGroupScopeKey({ network, walletId, accountId }))
  )
  await deleteMatching(
    key => targets.has(key),
    scope => scope.walletId === walletId && scope.accountId === accountId,
    (transactionWalletId, transactionAccountId) =>
      transactionWalletId === walletId && transactionAccountId === accountId,
    walletId
  )
}

export async function deleteMultisigDataForWallet(walletId: string): Promise<void> {
  const prefixes = NETWORKS.map(network => `${network}:${walletId}:`)
  await deleteMatching(
    key => prefixes.some(prefix => key.startsWith(prefix)),
    scope => scope.walletId === walletId,
    transactionWalletId => transactionWalletId === walletId,
    walletId
  )
}
