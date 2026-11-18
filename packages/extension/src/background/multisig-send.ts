import { parseAccountSource, type AccountSource } from '@/core/accounts/domain/account-source'
import { parseEnvelope } from '@/core/multisig/messages'
import {
  parseSigningIntentBinding,
  signingIntentBinding,
  isSigningIntentTerminal,
  type SigningIntent,
  type SigningIntentBinding
} from '@/core/multisig/signing-journal'
import {
  parseVaultSendAuthority,
  parseVaultSendPrepare,
  type VaultSendAuthority,
  type VaultSendMethod,
  type VaultSendPrepareRequest,
  type VaultSendProgress,
  type VaultSendSchema
} from '@/core/multisig/send-rpc'
import type {
  SigningWorkerMethod,
  SigningPrepareResponse,
  SigningWorkerProgress
} from '@/core/multisig/signing-worker-rpc'
import type { SigningReviewBinding } from '@/core/multisig/signing-coordinator'
import {
  parseSealedVaultRecord,
  sealedVaultRecordEquals,
  type SealedVaultRecord
} from '@/core/multisig/vault-record'
import type { MultisigGroupRecord } from '@/core/multisig/types'
import type { MultisigGroupScope } from '@/lib/multisig-group-storage'
import type { SigningJournal } from '@/lib/multisig-signing-storage'
import { isValidMarginalFeeZats, type FeeQuote } from '@/config/fee'
import { parseKeyringCommandBinding, type KeyringCommandBinding } from '@/core/keyring/ports'

type CredentialBinding = Extract<KeyringCommandBinding, { readonly kind: 'credential' }>

export interface MultisigSendDeps {
  journal: SigningJournal
  now?: () => number
  withScope<T>(scope: MultisigGroupScope, run: () => Promise<T>): Promise<T>
  readWalletState(): Promise<{
    network: 'mainnet' | 'testnet'
    activeWalletId: string | null
    activeAccountId: string | null
    wallets: readonly {
      id: string
      software: boolean
      accounts: readonly { id: string; source?: unknown }[]
    }[]
  }>
  isUnlocked(): Promise<boolean>
  bindCredential(walletId: string): Promise<boolean>
  getCredentialBinding(walletId: string): Promise<CredentialBinding>
  readRecord(scope: MultisigGroupScope): Promise<SealedVaultRecord | null>
  readGroup(scope: MultisigGroupScope): Promise<MultisigGroupRecord | null>
  readCreationReady(scope: MultisigGroupScope, groupId: string): Promise<boolean>
  getFeeQuote(): Promise<FeeQuote>
  forwardToWorker(
    method: SigningWorkerMethod,
    payload: Readonly<Record<string, unknown>>
  ): Promise<unknown>
}
interface Context {
  source: AccountSource
  record: SealedVaultRecord
  group: MultisigGroupRecord
}
interface Entry extends Context {
  binding: Readonly<SigningIntentBinding>
  credentialBinding: CredentialBinding
  disarm: () => void
  closing: boolean
}
const FAIL = 'Multisig signing is unavailable. Review this action again.'
const ref = (binding: SigningReviewBinding): VaultSendAuthority => ({
  walletId: binding.walletId,
  reviewId: binding.reviewId,
  sessionId: binding.sessionId
})
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
function publicBinding(binding: SigningIntentBinding): SigningReviewBinding {
  const { threshold: _threshold, transport: _transport, createdAt: _createdAt, ...rest } = binding
  return { ...rest, selectedSlots: [...binding.selectedSlots] }
}
/** Background owns authorization and the durable acknowledgement of every Worker nonce yield. */
export function createMultisigSendHandler(deps: MultisigSendDeps) {
  const now = deps.now ?? Date.now
  const entries = new Map<string, Entry>()
  const tails = new Map<string, Promise<unknown>>()
  let initialization: Promise<void> | null = null
  let revision = 0
  function serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
    const result = (tails.get(key) ?? Promise.resolve()).catch(() => {}).then(run)
    tails.set(key, result)
    void result
      .finally(() => {
        if (tails.get(key) === result) tails.delete(key)
      })
      .catch(() => {})
    return result
  }
  async function initialize(): Promise<void> {
    if (!initialization) {
      initialization = (async () => {
        // A Background restart does not kill the offscreen Worker. Confirm destruction first.
        if ((await deps.forwardToWorker('vault.sign.worker.invalidate', {})) !== true)
          throw new Error(FAIL)
        await deps.journal.interruptSigningIntents(undefined, now())
      })().catch(error => {
        initialization = null
        throw error
      })
    }
    return initialization
  }
  async function context(
    scope: MultisigGroupScope,
    groupId: string,
    rosterVersion: number
  ): Promise<Context> {
    return deps.withScope(scope, async () => {
      const state = await deps.readWalletState()
      const wallet = state.wallets.find(value => value.id === scope.walletId)
      const account = wallet?.accounts.find(value => value.id === scope.accountId)
      if (
        state.network !== scope.network ||
        state.activeWalletId !== scope.walletId ||
        state.activeAccountId !== scope.accountId ||
        !wallet?.software ||
        !account ||
        !(await deps.isUnlocked()) ||
        rosterVersion !== 1
      )
        throw new Error(FAIL)
      const source = parseAccountSource(account.source)
      if (source.groupId !== groupId || source.network !== scope.network) throw new Error(FAIL)
      const record = parseSealedVaultRecord(await deps.readRecord(scope))
      const group = await deps.readGroup(scope)
      if (
        !record ||
        record.version !== 2 ||
        record.ownerWalletId !== scope.walletId ||
        record.accountId !== scope.accountId ||
        record.network !== scope.network ||
        record.groupId !== groupId ||
        !group ||
        group.groupId !== groupId ||
        group.mock !== false ||
        !(await deps.readCreationReady(scope, groupId))
      )
        throw new Error(FAIL)
      const latest = await deps.readWalletState()
      if (
        latest.network !== scope.network ||
        latest.activeWalletId !== scope.walletId ||
        latest.activeAccountId !== scope.accountId ||
        !(await deps.isUnlocked())
      )
        throw new Error(FAIL)
      return { source, record, group: structuredClone(group) }
    })
  }
  async function authorize(entry: Entry): Promise<void> {
    if (entry.closing || now() >= entry.binding.expiresAt) throw new Error(FAIL)
    const current = await context(entry.binding, entry.binding.groupId, entry.binding.rosterVersion)
    if (
      !same(current.source, entry.source) ||
      !sealedVaultRecordEquals(current.record, entry.record) ||
      current.group.threshold !== entry.group.threshold ||
      current.group.fingerprint !== entry.group.fingerprint
    )
      throw new Error(FAIL)
    const credential = await attest(entry.binding.walletId)
    if (!same(credential, entry.credentialBinding)) throw new Error(FAIL)
    // Attestation is asynchronous; selection may change while the descriptor is read.
    const attestedContext = await context(
      entry.binding,
      entry.binding.groupId,
      entry.binding.rosterVersion
    )
    if (
      !same(attestedContext.source, entry.source) ||
      !sealedVaultRecordEquals(attestedContext.record, entry.record) ||
      attestedContext.group.threshold !== entry.group.threshold ||
      attestedContext.group.fingerprint !== entry.group.fingerprint
    )
      throw new Error(FAIL)
    if (entry.closing || now() >= entry.binding.expiresAt) throw new Error(FAIL)
  }
  async function attest(walletId: string): Promise<CredentialBinding> {
    const binding = parseKeyringCommandBinding(await deps.getCredentialBinding(walletId))
    if (binding.kind !== 'credential' || binding.keyDomainId !== walletId) throw new Error(FAIL)
    return {
      kind: 'credential',
      keyDomainId: binding.keyDomainId,
      credentialGenerationId: binding.credentialGenerationId,
      globalUnlockEpoch: binding.globalUnlockEpoch
    }
  }
  async function read(entry: Entry): Promise<Readonly<SigningIntent>> {
    const intent = await deps.journal.readSigningIntent(entry.binding)
    if (!intent) throw new Error(FAIL)
    return intent
  }
  async function finish(
    entry: Entry,
    phase: 'cancelled' | 'expired' | 'interrupted'
  ): Promise<void> {
    entry.closing = true
    entry.disarm()
    // No journal release is allowed until the Worker confirms ephemeral material is gone.
    if ((await deps.forwardToWorker('vault.sign.worker.close', { ...ref(entry.binding) })) !== true)
      throw new Error(FAIL)
    const intent = await read(entry)
    if (!isSigningIntentTerminal(intent.phase))
      await deps.journal.advanceSigningIntent(
        entry.binding,
        {
          expectedPhase: intent.phase,
          expectedNoncePhase: intent.noncePhase,
          nextPhase: phase,
          nextNoncePhase: intent.noncePhase
        },
        Math.max(now(), intent.updatedAt)
      )
    entries.delete(entry.binding.reviewId)
  }
  async function fail(entry: Entry): Promise<never> {
    await finish(entry, now() >= entry.binding.expiresAt ? 'expired' : 'interrupted')
    throw new Error(FAIL)
  }
  async function prepare(
    request: VaultSendPrepareRequest
  ): Promise<VaultSendSchema['vault.send.prepare']['response']> {
    const captured = revision
    const original = await context(request.scope, request.groupId, request.rosterVersion)
    if (
      (await deps.journal.listSigningIntents()).some(
        intent =>
          intent.walletId === request.scope.walletId &&
          intent.accountId === request.scope.accountId &&
          !isSigningIntentTerminal(intent.phase)
      )
    )
      throw new Error(FAIL)
    const threshold = original.group.threshold
    const count = threshold === '3-of-3' ? 3 : 2,
      total = threshold === '2-of-2' ? 2 : 3
    if (request.selectedSlots.length !== count || request.selectedSlots.some(slot => slot >= total))
      throw new Error(FAIL)
    let quote: FeeQuote
    try {
      quote = await deps.getFeeQuote()
    } catch {
      return { available: false, reason: 'fee_quote_unavailable' }
    }
    if (
      quote.id !== request.feeQuoteId ||
      !Number.isSafeInteger(quote.expiresAt) ||
      quote.expiresAt <= now() ||
      !isValidMarginalFeeZats(quote.standardMarginalFeeZats) ||
      ![quote.standardMarginalFeeZats, quote.standardMarginalFeeZats * 4].includes(
        request.marginalFeeZats
      )
    )
      return { available: false, reason: 'fee_quote_unavailable' }
    const current = await context(request.scope, request.groupId, request.rosterVersion)
    if (
      captured !== revision ||
      !sealedVaultRecordEquals(original.record, current.record) ||
      !same(original.source, current.source) ||
      original.group.threshold !== current.group.threshold ||
      original.group.fingerprint !== current.group.fingerprint ||
      !(await deps.bindCredential(request.scope.walletId))
    )
      throw new Error(FAIL)
    const credentialBinding = await attest(request.scope.walletId)
    await context(request.scope, request.groupId, request.rosterVersion)
    if (captured !== revision) throw new Error(FAIL)
    const reply = (await deps.forwardToWorker('vault.sign.worker.prepare', {
      scope: { ...request.scope, groupId: request.groupId, rosterVersion: request.rosterVersion },
      source: original.source,
      sealedRecord: original.record,
      intent: {
        recipient: request.to,
        amount: request.amountZats,
        memo: request.memo ?? '',
        marginalFeeZats: request.marginalFeeZats,
        feeQuoteId: quote.id
      },
      selectedSlots: request.selectedSlots,
      transport: request.transport
    })) as SigningPrepareResponse
    if (reply?.available === false && reply.reason === 'pczt_review_unavailable')
      return { available: false, reason: 'pczt_review_unavailable' }
    if (!reply || reply.available !== true) throw new Error(FAIL)
    const binding = parseSigningIntentBinding({
      ...reply.binding,
      threshold: reply.threshold,
      transport: reply.transport,
      createdAt: reply.createdAt
    })
    const entry: Entry = {
      ...original,
      binding,
      credentialBinding,
      closing: false,
      disarm: () => {}
    }
    let reserved = false
    try {
      if (
        captured !== revision ||
        binding.walletId !== request.scope.walletId ||
        binding.accountId !== request.scope.accountId ||
        binding.network !== request.scope.network ||
        binding.groupId !== request.groupId ||
        binding.rosterVersion !== request.rosterVersion ||
        binding.threshold !== threshold ||
        binding.transport !== request.transport ||
        !same(binding.selectedSlots, request.selectedSlots) ||
        binding.createdAt > now() ||
        binding.expiresAt <= now() ||
        reply.summary?.recipient !== request.to ||
        reply.summary?.amount !== request.amountZats ||
        reply.summary?.memo !== (request.memo ?? '') ||
        typeof reply.summary?.fee !== 'string' ||
        !/^(0|[1-9][0-9]{0,15})$/.test(reply.summary.fee)
      )
        throw new Error(FAIL)
      await authorize(entry)
      await deps.journal.reserveSigningIntent(binding, now())
      reserved = true
      const saved = await read(entry)
      if (saved.phase !== 'review_ready' || saved.noncePhase !== 'none') throw new Error(FAIL)
      await authorize(entry)
      if (captured !== revision) throw new Error(FAIL)
      entries.set(binding.reviewId, entry)
      const timer = setTimeout(
        () => {
          void serialized(binding.reviewId, () => finish(entry, 'expired')).catch(() => {})
        },
        Math.max(0, binding.expiresAt - now())
      )
      ;(timer as { unref?: () => void }).unref?.()
      entry.disarm = () => clearTimeout(timer)
      return {
        available: true,
        binding: publicBinding(binding),
        summary: {
          recipient: reply.summary.recipient,
          amount: reply.summary.amount,
          memo: reply.summary.memo,
          fee: reply.summary.fee
        }
      }
    } catch {
      if (reserved) await finish(entry, 'interrupted')
      else if (
        (await deps.forwardToWorker('vault.sign.worker.close', { ...ref(binding) })) !== true
      )
        throw new Error(FAIL)
      throw new Error(FAIL)
    }
  }
  function checkedProgress(entry: Entry, raw: unknown): SigningWorkerProgress {
    const value = raw as SigningWorkerProgress
    const binding = parseSigningIntentBinding({
      ...value?.binding,
      threshold: entry.binding.threshold,
      transport: entry.binding.transport,
      createdAt: entry.binding.createdAt
    })
    if (
      !same(binding, entry.binding) ||
      !value.status ||
      value.status.sessionId !== binding.sessionId ||
      !same(value.status.selectedSlots, binding.selectedSlots) ||
      !['created', 'commitments', 'shares', 'signed', 'aborted'].includes(value.status.phase) ||
      !Array.isArray(value.outbound)
    )
      throw new Error(FAIL)
    for (const item of value.outbound) {
      const envelope = parseEnvelope(item)
      if (
        !envelope ||
        envelope.group_id !== binding.groupId ||
        envelope.session_id !== binding.sessionId ||
        envelope.sender_id !== 'device-1'
      )
        throw new Error(FAIL)
    }
    for (const slots of [value.status.committedSlots, value.status.sharedSlots])
      if (
        !Array.isArray(slots) ||
        new Set(slots).size !== slots.length ||
        slots.some(slot => !binding.selectedSlots.includes(slot))
      )
        throw new Error(FAIL)
    if (
      value.persistence &&
      (typeof value.persistence.ackId !== 'string' ||
        value.persistence.ackId.length < 1 ||
        value.persistence.ackId.length > 256 ||
        !['created', 'committed', 'consumed'].includes(value.persistence.phase) ||
        value.outbound.length > 0)
    )
      throw new Error(FAIL)
    return {
      ...value,
      status: {
        sessionId: binding.sessionId,
        phase: value.status.phase,
        selectedSlots: [...binding.selectedSlots],
        committedSlots: [...value.status.committedSlots],
        sharedSlots: [...value.status.sharedSlots]
      },
      outbound: value.outbound.map(item => parseEnvelope(item)!)
    }
  }
  async function process(entry: Entry, raw: unknown): Promise<VaultSendProgress> {
    for (let turn = 0; turn < 5; turn++) {
      await authorize(entry)
      const reply = checkedProgress(entry, raw)
      let intent = await read(entry)
      if (isSigningIntentTerminal(intent.phase)) throw new Error(FAIL)
      if (reply.persistence) {
        const pending = reply.persistence
        await deps.journal.advanceSigningIntent(
          entry.binding,
          {
            expectedPhase: 'signing',
            expectedNoncePhase: intent.noncePhase,
            nextPhase: 'signing',
            nextNoncePhase: pending.phase
          },
          now()
        )
        intent = await read(entry)
        if (intent.phase !== 'signing' || intent.noncePhase !== pending.phase) throw new Error(FAIL)
        await authorize(entry)
        raw = await deps.forwardToWorker('vault.sign.worker.advance', {
          ...ref(entry.binding),
          acknowledgement: { ackId: pending.ackId, phase: pending.phase, persisted: true }
        })
        continue
      }
      if (reply.status.phase === 'aborted') throw new Error(FAIL)
      if (reply.status.phase === 'signed' && intent.phase !== 'signed') {
        await deps.journal.advanceSigningIntent(
          entry.binding,
          {
            expectedPhase: 'signing',
            expectedNoncePhase: 'consumed',
            nextPhase: 'signed',
            nextNoncePhase: 'consumed'
          },
          now()
        )
        intent = await read(entry)
      }
      await authorize(entry)
      return {
        binding: publicBinding(entry.binding),
        phase: intent.phase,
        noncePhase: intent.noncePhase,
        status: reply.status,
        outbound: reply.outbound
      }
    }
    throw new Error(FAIL)
  }
  async function lookup(authority: VaultSendAuthority): Promise<Entry | null> {
    const entry = entries.get(authority.reviewId)
    if (
      entry &&
      (entry.binding.walletId !== authority.walletId ||
        entry.binding.sessionId !== authority.sessionId)
    )
      throw new Error(FAIL)
    return entry ?? null
  }
  async function operation(
    method: Exclude<VaultSendMethod, 'vault.send.prepare'>,
    payload: unknown
  ): Promise<unknown> {
    const authority = parseVaultSendAuthority(payload, method === 'vault.send.ingest')
    return serialized(authority.reviewId, async () => {
      const entry = await lookup(authority)
      if (!entry) {
        if (method !== 'vault.send.status' && method !== 'vault.send.cancel') throw new Error(FAIL)
        const intent = (await deps.journal.listSigningIntents()).find(
          value =>
            value.walletId === authority.walletId &&
            value.reviewId === authority.reviewId &&
            value.sessionId === authority.sessionId
        )
        if (!intent || !isSigningIntentTerminal(intent.phase)) throw new Error(FAIL)
        if (method === 'vault.send.cancel') return true
        await context(intent, intent.groupId, intent.rosterVersion)
        return {
          binding: publicBinding(signingIntentBinding(intent)),
          phase: intent.phase,
          noncePhase: intent.noncePhase,
          status: null,
          outbound: []
        }
      }
      if (method === 'vault.send.cancel') {
        await finish(entry, 'cancelled')
        return true
      }
      try {
        await authorize(entry)
        const intent = await read(entry)
        if (isSigningIntentTerminal(intent.phase)) throw new Error(FAIL)
        if (method === 'vault.send.start' && intent.phase === 'review_ready')
          await deps.journal.advanceSigningIntent(
            entry.binding,
            {
              expectedPhase: 'review_ready',
              expectedNoncePhase: 'none',
              nextPhase: 'signing',
              nextNoncePhase: 'none'
            },
            now()
          )
        if (method === 'vault.send.ingest' && intent.phase !== 'signing') throw new Error(FAIL)
        await authorize(entry)
        const workerMethod =
          method === 'vault.send.start'
            ? 'vault.sign.worker.start'
            : method === 'vault.send.ingest'
              ? 'vault.sign.worker.ingest'
              : 'vault.sign.worker.status'
        return await process(
          entry,
          await deps.forwardToWorker(workerMethod, {
            ...ref(entry.binding),
            ...(authority.envelope ? { envelope: authority.envelope } : {})
          })
        )
      } catch {
        return fail(entry)
      }
    })
  }
  return {
    initialize,
    async recoverPending(): Promise<void> {
      if (
        (await deps.journal.listSigningIntents()).some(
          intent => !isSigningIntentTerminal(intent.phase)
        )
      )
        await initialize()
    },
    async invalidate(request?: {
      mode: 'scope' | 'except'
      scope: { walletId: string; accountId: string }
    }): Promise<void> {
      revision += 1
      const selected = [...entries.values()].filter(
        entry =>
          !request ||
          (entry.binding.walletId === request.scope.walletId &&
            entry.binding.accountId === request.scope.accountId) ===
            (request.mode === 'scope')
      )
      for (const entry of selected) entry.closing = true
      for (const entry of selected)
        await serialized(entry.binding.reviewId, () => finish(entry, 'interrupted'))
    },
    async handle<M extends VaultSendMethod>(
      method: M,
      payload: unknown
    ): Promise<VaultSendSchema[M]['response']> {
      try {
        await initialize()
        if (method === 'vault.send.prepare') {
          const request = parseVaultSendPrepare(payload)
          return (await serialized(
            JSON.stringify([request.scope.walletId, request.scope.accountId]),
            () => prepare(request)
          )) as VaultSendSchema[M]['response']
        }
        return (await operation(method, payload)) as VaultSendSchema[M]['response']
      } catch {
        throw new Error(FAIL)
      }
    }
  }
}
