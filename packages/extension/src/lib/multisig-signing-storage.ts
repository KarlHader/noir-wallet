import {
  parseSigningIntent,
  parseSigningIntentBinding,
  signingIntentBinding,
  isSigningIntentTerminal,
  transitionSigningIntent,
  signingJournalScopeKey,
  parseSigningJournalScopeKey,
  parseSigningSessionId,
  type SigningIntent,
  type SigningIntentBinding,
  type SigningIntentTransition,
  type SigningNoncePhase
} from '@/core/multisig/signing-journal'
import {
  MULTISIG_SIGNING_STORAGE_KEY,
  withMultisigStorageLock,
  type MultisigGroupScope
} from './multisig-group-storage'
import { withUndeletedWalletAccountMetadata } from './wallet-metadata-storage'
import { storageJsonEquals } from './storage-json-equality'
import { MULTISIG_TRANSACTION_STORAGE_KEY } from './multisig-transaction-guard'
import { parseMultisigTransactionRecord } from '@/core/multisig/transaction-journal'

// Compact only expired terminal records. Replay IDs and highest nonce phases survive until deletion.
const PER_ACCOUNT_LIMIT = 128
interface SigningTombstone {
  reviewId: string
  sessionId: string
  noncePhase: SigningNoncePhase
  expiresAt: number
}
interface AccountJournal {
  version: 1
  activeSessionId: string | null
  records: SigningIntent[]
  tombstones: SigningTombstone[]
}
type Journals = Record<string, AccountJournal>
const FAIL = 'Signing journal is unavailable'
async function readStored(): Promise<Journals> {
  const raw: unknown = (await chrome.storage.local.get(MULTISIG_SIGNING_STORAGE_KEY))[
    MULTISIG_SIGNING_STORAGE_KEY
  ]
  if (raw === undefined) return {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(FAIL)
  const journals: Journals = {}
  const sessions = new Set<string>(),
    reviews = new Set<string>()
  const accountCounts = new Map<string, number>()
  const activeAccounts = new Set<string>()
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(FAIL)
    const stored = value as AccountJournal
    if (
      Object.keys(value).sort().join(',') !== 'activeSessionId,records,tombstones,version' ||
      stored.version !== 1 ||
      !Array.isArray(stored.records) ||
      !Array.isArray(stored.tombstones) ||
      stored.records.length > PER_ACCOUNT_LIMIT ||
      (stored.activeSessionId !== null && typeof stored.activeSessionId !== 'string')
    )
      throw new Error(FAIL)
    const scope = parseSigningJournalScopeKey(key)
    if (!scope) throw new Error(FAIL)
    const records = stored.records.map(parseSigningIntent)
    for (const intent of records) {
      if (
        signingJournalScopeKey(intent) !== key ||
        sessions.has(intent.sessionId) ||
        reviews.has(intent.reviewId)
      )
        throw new Error(FAIL)
      sessions.add(intent.sessionId)
      reviews.add(intent.reviewId)
      const accountKey = JSON.stringify([intent.walletId, intent.accountId])
      const count = (accountCounts.get(accountKey) ?? 0) + 1
      if (count > PER_ACCOUNT_LIMIT) throw new Error(FAIL)
      accountCounts.set(accountKey, count)
      if (!isSigningIntentTerminal(intent.phase)) {
        if (activeAccounts.has(accountKey)) throw new Error(FAIL)
        activeAccounts.add(accountKey)
      }
    }
    const tombstones = stored.tombstones.map(marker => {
      if (
        !marker ||
        typeof marker !== 'object' ||
        Array.isArray(marker) ||
        Object.keys(marker).sort().join(',') !== 'expiresAt,noncePhase,reviewId,sessionId' ||
        !['none', 'created', 'committed', 'consumed'].includes(marker.noncePhase) ||
        !Number.isSafeInteger(marker.expiresAt) ||
        marker.expiresAt < 0 ||
        typeof marker.reviewId !== 'string' ||
        !marker.reviewId ||
        marker.reviewId.length > 512 ||
        marker.reviewId.trim() !== marker.reviewId ||
        typeof marker.sessionId !== 'string'
      )
        throw new Error(FAIL)
      parseSigningSessionId(marker.sessionId)
      if (sessions.has(marker.sessionId) || reviews.has(marker.reviewId)) throw new Error(FAIL)
      sessions.add(marker.sessionId)
      reviews.add(marker.reviewId)
      return {
        reviewId: marker.reviewId,
        sessionId: marker.sessionId,
        noncePhase: marker.noncePhase,
        expiresAt: marker.expiresAt
      }
    })
    const active = records.filter(intent => !isSigningIntentTerminal(intent.phase))
    if (active.length > 1 || (active[0]?.sessionId ?? null) !== stored.activeSessionId)
      throw new Error(FAIL)
    Object.defineProperty(journals, key, {
      value: { version: 1, activeSessionId: stored.activeSessionId, records, tombstones },
      enumerable: true,
      configurable: true,
      writable: true
    })
  }
  return journals
}
async function saveVerified(journals: Journals): Promise<void> {
  await chrome.storage.local.set({ [MULTISIG_SIGNING_STORAGE_KEY]: journals })
  const readback: unknown = (await chrome.storage.local.get(MULTISIG_SIGNING_STORAGE_KEY))[
    MULTISIG_SIGNING_STORAGE_KEY
  ]
  if (!storageJsonEquals(readback, journals)) throw new Error('Signing progress could not be saved')
}
function sameBinding(intent: SigningIntent, binding: SigningIntentBinding): boolean {
  return JSON.stringify(signingIntentBinding(intent)) === JSON.stringify(binding)
}
function interruptionScopeKey(scope: MultisigGroupScope | undefined): string | undefined {
  if (scope === undefined) return undefined
  if (
    !scope ||
    typeof scope !== 'object' ||
    Array.isArray(scope) ||
    Object.keys(scope).sort().join(',') !== 'accountId,network,walletId' ||
    (scope.network !== 'mainnet' && scope.network !== 'testnet') ||
    !parseSigningJournalScopeKey(signingJournalScopeKey(scope))
  )
    throw new Error(FAIL)
  return signingJournalScopeKey(scope)
}

/**
 * Create for one Worker lifetime. Recovered metadata never grants authority to resume secrets.
 * Cancellation/interruption requires the caller to first confirm Worker material was destroyed.
 */
export function createSigningJournal() {
  const owned = new Set<string>()
  return {
    async reserveSigningIntent(
      input: SigningIntentBinding,
      now: number
    ): Promise<Readonly<SigningIntent>> {
      const binding = parseSigningIntentBinding(input)
      const intent = parseSigningIntent({
        ...binding,
        version: 1,
        phase: 'review_ready',
        noncePhase: 'none',
        updatedAt: now
      })
      if (now >= intent.expiresAt) return Promise.reject(new Error(FAIL))
      return withUndeletedWalletAccountMetadata(
        binding.walletId,
        binding.accountId,
        binding.network,
        () =>
          withMultisigStorageLock(async () => {
            const journals = await readStored(),
              key = signingJournalScopeKey(binding)
            // Never discard markers to make room. Full expired terminal rows can be compacted.
            for (const account of Object.values(journals)) {
              const expired = account.records.filter(
                previous => isSigningIntentTerminal(previous.phase) && previous.expiresAt <= now
              )
              account.tombstones.push(
                ...expired.map(previous => ({
                  reviewId: previous.reviewId,
                  sessionId: previous.sessionId,
                  noncePhase: previous.noncePhase,
                  expiresAt: previous.expiresAt
                }))
              )
              account.records = account.records.filter(previous => !expired.includes(previous))
            }
            const current = journals[key] ?? {
              version: 1,
              activeSessionId: null,
              records: [],
              tombstones: []
            }
            const all = Object.values(journals).flatMap(value => value.records)
            const retired = Object.values(journals).flatMap(value => value.tombstones)
            if (
              current.activeSessionId !== null ||
              all.filter(
                previous =>
                  previous.walletId === binding.walletId && previous.accountId === binding.accountId
              ).length >= PER_ACCOUNT_LIMIT ||
              retired.some(
                previous =>
                  previous.sessionId === binding.sessionId || previous.reviewId === binding.reviewId
              ) ||
              all.some(
                previous =>
                  previous.sessionId === binding.sessionId ||
                  previous.reviewId === binding.reviewId ||
                  (previous.walletId === binding.walletId &&
                    previous.accountId === binding.accountId &&
                    !isSigningIntentTerminal(previous.phase))
              )
            )
              throw new Error(FAIL)
            journals[key] = {
              version: 1,
              activeSessionId: binding.sessionId,
              records: [...current.records, intent],
              tombstones: current.tombstones
            }
            await saveVerified(journals)
            for (const marker of retired) owned.delete(marker.sessionId)
            owned.add(binding.sessionId)
            return intent
          })
      )
    },
    async readSigningIntent(input: SigningIntentBinding): Promise<Readonly<SigningIntent> | null> {
      const binding = parseSigningIntentBinding(input)
      return withMultisigStorageLock(async () => {
        const intent = (await readStored())[signingJournalScopeKey(binding)]?.records.find(
          record => record.sessionId === binding.sessionId
        )
        if (intent && !sameBinding(intent, binding)) throw new Error(FAIL)
        return intent ?? null
      })
    },
    listSigningIntents(): Promise<Readonly<SigningIntent>[]> {
      return withMultisigStorageLock(async () =>
        Object.values(await readStored()).flatMap(value => value.records)
      )
    },
    async advanceSigningIntent(
      input: SigningIntentBinding,
      edge: SigningIntentTransition,
      now: number
    ): Promise<Readonly<SigningIntent>> {
      const binding = parseSigningIntentBinding(input)
      return withUndeletedWalletAccountMetadata(
        binding.walletId,
        binding.accountId,
        binding.network,
        () =>
          withMultisigStorageLock(async () => {
            const journals = await readStored(),
              key = signingJournalScopeKey(binding),
              account = journals[key]
            const index =
              account?.records.findIndex(record => record.sessionId === binding.sessionId) ?? -1
            const current = account?.records[index]
            if (!owned.has(binding.sessionId) || !current || !sameBinding(current, binding))
              throw new Error(FAIL)
            const next = transitionSigningIntent(current, edge, now)
            if (next === current) return current
            account.records[index] = next
            account.activeSessionId = isSigningIntentTerminal(next.phase) ? null : next.sessionId
            await saveVerified(journals)
            return next
          })
      )
    },
    async settleConfirmedSigningIntent(
      input: SigningIntentBinding,
      txId: string,
      now: number
    ): Promise<Readonly<SigningIntent>> {
      const binding = parseSigningIntentBinding(input)
      if (!/^[0-9a-f]{64}$/.test(txId) || !Number.isSafeInteger(now) || now < 0)
        throw new Error(FAIL)
      return withUndeletedWalletAccountMetadata(
        binding.walletId,
        binding.accountId,
        binding.network,
        () =>
          withMultisigStorageLock(async () => {
            const journals = await readStored()
            const key = signingJournalScopeKey(binding)
            const account = journals[key]
            const index =
              account?.records.findIndex(record => record.sessionId === binding.sessionId) ?? -1
            const current = account?.records[index]
            if (
              !current ||
              !sameBinding(current, binding) ||
              (current.phase !== 'signed' && current.phase !== 'confirmed') ||
              current.noncePhase !== 'consumed' ||
              now < current.updatedAt
            )
              throw new Error(FAIL)
            const rawTransactions: unknown = (
              await chrome.storage.local.get(MULTISIG_TRANSACTION_STORAGE_KEY)
            )[MULTISIG_TRANSACTION_STORAGE_KEY]
            if (
              !rawTransactions ||
              typeof rawTransactions !== 'object' ||
              Array.isArray(rawTransactions)
            )
              throw new Error(FAIL)
            const rows: unknown = (rawTransactions as Record<string, unknown>)[key]
            if (!Array.isArray(rows)) throw new Error(FAIL)
            const confirmed = rows
              .map(parseMultisigTransactionRecord)
              .filter(
                record =>
                  record.txId === txId &&
                  record.phase === 'confirmed' &&
                  storageJsonEquals(record.binding, binding)
              )
            if (confirmed.length !== 1) throw new Error(FAIL)
            if (current.phase === 'confirmed') return current
            const next = parseSigningIntent({
              ...current,
              phase: 'confirmed',
              noncePhase: 'consumed',
              updatedAt: now
            })
            account.records[index] = next
            account.activeSessionId = null
            await saveVerified(journals)
            owned.delete(binding.sessionId)
            return next
          })
      )
    },
    async interruptSigningIntents(
      scope: MultisigGroupScope | undefined,
      now: number
    ): Promise<void> {
      if (!Number.isSafeInteger(now) || now < 0) return Promise.reject(new Error(FAIL))
      const target = interruptionScopeKey(scope)
      return withMultisigStorageLock(async () => {
        const journals = await readStored()
        let changed = false
        for (const [key, account] of Object.entries(journals)) {
          if (target !== undefined && key !== target) continue
          account.records = account.records.map(intent => {
            if (isSigningIntentTerminal(intent.phase) || intent.phase === 'signed') return intent
            changed = true
            return transitionSigningIntent(
              intent,
              {
                expectedPhase: intent.phase,
                expectedNoncePhase: intent.noncePhase,
                nextPhase: 'interrupted',
                nextNoncePhase: intent.noncePhase
              },
              Math.max(now, intent.updatedAt)
            )
          })
          account.activeSessionId =
            account.records.find(intent => !isSigningIntentTerminal(intent.phase))?.sessionId ??
            null
        }
        if (changed) await saveVerified(journals)
        for (const account of Object.values(journals))
          for (const intent of account.records)
            if (isSigningIntentTerminal(intent.phase)) owned.delete(intent.sessionId)
      })
    }
  }
}
export type SigningJournal = ReturnType<typeof createSigningJournal>
