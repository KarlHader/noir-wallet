/**
 * Background side of `vault.group.*`. Everything environment-specific comes in through
 * `MultisigVaultDeps`, so this module imports nothing that needs `chrome` and runs under Node tests.
 *
 * Only `open` and `summary` need the Worker, and both go through the active wallet's credential:
 * the Worker derives the record key from the mnemonic it holds for that wallet. `save` handles
 * ciphertext only, so it deliberately needs neither an unlock nor a credential.
 */
import { isBase64Text, isDkgSessionIdText, isDkgShape } from '@/core/multisig/dkg-protocol'
import {
  parseVaultGroupOpenRequest,
  parseVaultGroupSaveRequest,
  parseVaultGroupSummaryRequest,
  parseCreationRequest,
  parseVaultRecoverRequest,
  type VaultGroupMethod,
  type VaultGroupSchema,
  type VaultGroupSummaryResponse
} from '@/core/multisig/vault-group-rpc'
import type { VaultCreationEvidence } from '@/core/multisig/vault-group-rpc'
import type { MultisigCreationOperation } from '@/lib/multisig-creation-storage'
import type { AccountAddresses, AccountData } from '@/types/wallet'
import { thresholdDeviceCount } from '@/core/multisig/types'
import { sealedVaultRecordEquals } from '@/core/multisig/vault-record'
import type { MultisigGroupRecord } from '@/core/multisig/types'
import {
  isVaultAddress,
  isVaultFingerprint,
  parseSealedVaultRecord,
  type SealedVaultRecord,
  type VaultNetwork
} from '@/core/multisig/vault-record'
import type { MultisigGroupScope } from '@/lib/multisig-group-storage'
import type { PendingPhoneRecovery } from '@/lib/multisig-recovery-storage'

export interface MultisigVaultWallet {
  id: string
  mnemonic: boolean
  accountIds: readonly string[]
  derivedAccountIds?: readonly string[]
}

export interface MultisigVaultDeps {
  readWalletState(): Promise<{
    network: VaultNetwork
    activeWalletId: string | null
    activeAccountId?: string | null
    wallets: readonly MultisigVaultWallet[]
  }>
  isUnlocked(): Promise<boolean>
  bindCredential(walletId: string): Promise<boolean>
  forwardToWorker(
    method: 'vault.dkg.open' | 'vault.record.summary' | 'vault.record.recoverPrepare',
    payload: Readonly<Record<string, unknown>>
  ): Promise<unknown>
  readRecord(scope: MultisigGroupScope): Promise<SealedVaultRecord | null>
  /** Stores the record and proves it landed; on failure the scope's earlier record is kept. */
  saveRecord(scope: MultisigGroupScope, record: SealedVaultRecord): Promise<void>
  readGroupId(scope: MultisigGroupScope): Promise<string | null>
  recovery?: {
    withScope<T>(scope: MultisigGroupScope, operation: () => Promise<T>): Promise<T>
    readCreationReady(scope: MultisigGroupScope, groupId: string): Promise<boolean>
    assertSafe(scope: MultisigGroupScope): Promise<void>
    invalidateSigning(scope: MultisigGroupScope): Promise<void>
    readGeneration(): Promise<number>
    readPending(recoveryId: string): Promise<PendingPhoneRecovery | null>
    savePending(recoveryId: string, pending: PendingPhoneRecovery): Promise<void>
    removePending(recoveryId: string): Promise<void>
    replaceRecord(
      scope: MultisigGroupScope,
      previous: SealedVaultRecord,
      candidate: SealedVaultRecord,
      assertAuthorized: () => Promise<void>
    ): Promise<void>
  }
  creation?: {
    /** Stops sync before metadata locking and keeps it paused until the mutation settles. */
    withMutation<T>(walletId: string, operation: () => Promise<T>): Promise<T>
    birthdayHeight(): Promise<number>
    read(scope: MultisigGroupScope): Promise<MultisigCreationOperation | null>
    list(): Promise<MultisigCreationOperation[]>
    write(op: MultisigCreationOperation): Promise<void>
    remove(scope: MultisigGroupScope, operationId: string): Promise<void>
    withScope<T>(scope: MultisigGroupScope, operation: () => Promise<T>): Promise<T>
    register(
      walletId: string,
      account: AccountData,
      record: SealedVaultRecord
    ): Promise<AccountAddresses>
    commitMetadata(
      op: MultisigCreationOperation,
      account: AccountData,
      assertAuthorized: () => Promise<void>
    ): Promise<void>
    saveGroup(scope: MultisigGroupScope, group: MultisigGroupRecord): Promise<void>
  }
}

export interface MultisigVaultHandler {
  resumePending(): Promise<void>
  handle<M extends VaultGroupMethod>(
    method: M,
    payload: unknown
  ): Promise<VaultGroupSchema[M]['response']>
}

const INVALID_REQUEST = 'Invalid vault group request'
const SCOPE_UNAVAILABLE = 'Vault group scope is not available'
const LOCKED = 'Wallet is locked'
const NOT_ACTIVE = 'Vault setup requires the active wallet'
const NO_CREDENTIAL = 'Wallet credential is unavailable'
const NOT_SAVED = 'Vault record could not be saved'
const CANNOT_OPEN = 'Vault record cannot be opened'
const CANNOT_START = 'Vault setup could not start'

export function createMultisigVaultHandler(deps: MultisigVaultDeps): MultisigVaultHandler {
  const recoveryLifetimeMs = 10 * 60_000
  async function authorizeRecovery(scope: MultisigGroupScope): Promise<SealedVaultRecord> {
    if (!deps.recovery) throw new Error(SCOPE_UNAVAILABLE)
    const state = await deps.readWalletState()
    if (state.activeAccountId !== scope.accountId) throw new Error(NOT_ACTIVE)
    const { activeWalletId } = await checkScope(scope)
    await requireBoundActiveWallet(scope, activeWalletId)
    const record = await deps.readRecord(scope)
    if (
      !record ||
      record.version !== 2 ||
      record.ownerWalletId !== scope.walletId ||
      record.accountId !== scope.accountId ||
      record.network !== scope.network ||
      (await deps.readGroupId(scope)) !== record.groupId ||
      !(await deps.recovery.readCreationReady(scope, record.groupId))
    )
      throw new Error(SCOPE_UNAVAILABLE)
    const latest = await deps.readWalletState()
    if (
      latest.network !== scope.network ||
      latest.activeWalletId !== scope.walletId ||
      latest.activeAccountId !== scope.accountId ||
      !latest.wallets.find(
        wallet =>
          wallet.id === scope.walletId &&
          wallet.mnemonic &&
          wallet.accountIds.includes(scope.accountId)
      ) ||
      !(await deps.isUnlocked())
    )
      throw new Error(SCOPE_UNAVAILABLE)
    return record
  }
  async function assertRecoveryPending(id: string, pending: PendingPhoneRecovery): Promise<void> {
    const current = await deps.recovery!.readPending(id)
    if (
      !current ||
      current.expiresAt !== pending.expiresAt ||
      current.contextGeneration !== pending.contextGeneration ||
      current.scope.network !== pending.scope.network ||
      current.scope.walletId !== pending.scope.walletId ||
      current.scope.accountId !== pending.scope.accountId ||
      !sealedVaultRecordEquals(current.previous, pending.previous) ||
      !sealedVaultRecordEquals(current.candidate, pending.candidate)
    )
      throw new Error(SCOPE_UNAVAILABLE)
  }
  async function handleRecovery(
    method:
      | 'vault.group.recover.prepare'
      | 'vault.group.recover.complete'
      | 'vault.group.recover.cancel',
    payload: unknown
  ): Promise<unknown> {
    const request = parseVaultRecoverRequest(method, payload)
    if (method === 'vault.group.recover.prepare') {
      if (!deps.recovery) throw new Error(SCOPE_UNAVAILABLE)
      const contextGeneration = await deps.recovery!.readGeneration()
      const previous = await authorizeRecovery(request.scope)
      const reply = (await deps.forwardToWorker('vault.record.recoverPrepare', {
        record: previous,
        ownerWalletId: request.scope.walletId,
        request: request.request!
      })) as { record?: unknown; reply?: unknown }
      const candidate = parseSealedVaultRecord(reply?.record)
      if (
        !candidate ||
        candidate.version !== 2 ||
        candidate.network !== request.scope.network ||
        candidate.accountId !== request.scope.accountId ||
        candidate.ownerWalletId !== request.scope.walletId ||
        candidate.groupId !== previous.groupId ||
        typeof reply?.reply !== 'string' ||
        !isBase64Text(reply.reply) ||
        sealedVaultRecordEquals(candidate, previous)
      )
        throw new Error(CANNOT_OPEN)
      const current = await authorizeRecovery(request.scope)
      if (
        !sealedVaultRecordEquals(current, previous) ||
        (await deps.recovery!.readGeneration()) !== contextGeneration
      )
        throw new Error(SCOPE_UNAVAILABLE)
      const recoveryId = crypto.randomUUID()
      const expiresAt = Date.now() + recoveryLifetimeMs
      await deps.recovery!.savePending(recoveryId, {
        scope: request.scope,
        previous,
        candidate,
        expiresAt,
        contextGeneration
      })
      return { recoveryId, reply: reply.reply, expiresAt }
    }
    await authorizeRecovery(request.scope)
    const pending = await deps.recovery!.readPending(request.recoveryId!)
    if (
      !pending ||
      pending.expiresAt <= Date.now() ||
      pending.contextGeneration !== (await deps.recovery!.readGeneration()) ||
      pending.scope.network !== request.scope.network ||
      pending.scope.walletId !== request.scope.walletId ||
      pending.scope.accountId !== request.scope.accountId
    )
      throw new Error(SCOPE_UNAVAILABLE)
    if (method === 'vault.group.recover.cancel') {
      await deps.recovery!.removePending(request.recoveryId!)
      return true
    }
    const current = await authorizeRecovery(request.scope)
    if (sealedVaultRecordEquals(current, pending.candidate)) {
      await deps.recovery!.removePending(request.recoveryId!)
      return true
    }
    if (!sealedVaultRecordEquals(current, pending.previous)) throw new Error(SCOPE_UNAVAILABLE)
    await deps.recovery!.assertSafe(request.scope)
    await assertRecoveryPending(request.recoveryId!, pending)
    await deps.recovery!.invalidateSigning(request.scope)
    await deps.recovery!.withScope(request.scope, async () => {
      if (pending.contextGeneration !== (await deps.recovery!.readGeneration()))
        throw new Error(SCOPE_UNAVAILABLE)
      const current = await authorizeRecovery(request.scope)
      if (!sealedVaultRecordEquals(current, pending.previous)) throw new Error(SCOPE_UNAVAILABLE)
      await deps.recovery!.replaceRecord(
        request.scope,
        pending.previous,
        pending.candidate,
        async () => {
          await assertRecoveryPending(request.recoveryId!, pending)
          if (pending.contextGeneration !== (await deps.recovery!.readGeneration()))
            throw new Error(SCOPE_UNAVAILABLE)
          const latest = await authorizeRecovery(request.scope)
          if (!sealedVaultRecordEquals(latest, pending.previous)) throw new Error(SCOPE_UNAVAILABLE)
        }
      )
    })
    await deps.recovery!.removePending(request.recoveryId!)
    return true
  }
  function creation() {
    if (!deps.creation) throw new Error('Independent account creation is unavailable')
    return deps.creation
  }
  async function requireOperation(scope: MultisigGroupScope, operationId: string | undefined) {
    const op = await creation().read(scope)
    if (!op || op.operationId !== operationId) throw new Error(SCOPE_UNAVAILABLE)
    return op
  }
  async function authorizeOperation(op: MultisigCreationOperation): Promise<void> {
    const state = await deps.readWalletState()
    const wallet = state.wallets.find(w => w.id === op.scope.walletId)
    if (
      !wallet?.mnemonic ||
      state.network !== op.scope.network ||
      !(op.phase === 'ready'
        ? wallet.accountIds.includes(op.scope.accountId)
        : wallet.accountIds.includes(op.parentAccountId))
    )
      throw new Error(SCOPE_UNAVAILABLE)
    if (state.activeWalletId !== op.scope.walletId) throw new Error(NOT_ACTIVE)
    if (
      state.activeAccountId !== undefined &&
      state.activeAccountId !== op.parentAccountId &&
      state.activeAccountId !== op.scope.accountId
    )
      throw new Error(NOT_ACTIVE)
    if (!(await deps.isUnlocked())) throw new Error(LOCKED)
  }
  async function commitOperation(
    op: MultisigCreationOperation,
    displayGroup?: MultisigGroupRecord,
    suppliedEvidence?: VaultCreationEvidence
  ): Promise<{ phase: 'ready'; scope: MultisigGroupScope }> {
    await authorizeOperation(op)
    const commitScoped = async (): Promise<{ phase: 'ready'; scope: MultisigGroupScope }> => {
      op = await requireOperation(op.scope, op.operationId)
      await authorizeOperation(op)
      await requireBoundActiveWallet(op.scope, op.scope.walletId)
      const record = await deps.readRecord(op.scope)
      if (
        !record ||
        record.version !== 2 ||
        record.accountId !== op.scope.accountId ||
        record.ownerWalletId !== op.scope.walletId ||
        record.groupId !== op.groupId ||
        record.network !== op.scope.network
      )
        throw new Error(CANNOT_OPEN)
      const evidence = suppliedEvidence ?? op.evidence
      if (
        !evidence ||
        !op.outerSessionId ||
        evidence.sessionId !== op.outerSessionId ||
        (op.evidence && JSON.stringify(op.evidence) !== JSON.stringify(evidence))
      )
        throw new Error('Verified device confirmation is required')
      const summary = (await deps.forwardToWorker('vault.record.summary', {
        record,
        ownerWalletId: op.scope.walletId,
        creationEvidence: {
          outerSessionId: op.outerSessionId,
          confirmations: evidence.confirmations
        }
      })) as import('@/core/multisig/vault-record').VaultRecordSummary
      await authorizeOperation(op)
      const authenticated = summary?.authenticated
      if (
        !authenticated ||
        authenticated.creationConfirmed !== true ||
        authenticated.accountId !== op.scope.accountId ||
        authenticated.ownerWalletId !== op.scope.walletId ||
        authenticated.birthdayHeight !== op.birthdayHeight ||
        authenticated.rosterHash !== op.rosterHash ||
        authenticated.rosterVersion !== 1 ||
        summary.participants !== thresholdDeviceCount(op.threshold) ||
        summary.threshold !== (op.threshold === '3-of-3' ? 3 : 2) ||
        !isVaultAddress(summary.address) ||
        !isVaultFingerprint(summary.fingerprint)
      )
        throw new Error(CANNOT_OPEN)
      if (op.phase === 'ready') {
        if ((await deps.readGroupId(op.scope)) !== op.groupId) throw new Error(CANNOT_OPEN)
        await authorizeOperation(op)
        return { phase: 'ready', scope: op.scope }
      }
      const group = displayGroup ?? op.group
      if (
        !group ||
        group.groupId !== op.groupId ||
        group.threshold !== op.threshold ||
        group.fingerprint !== summary.fingerprint
      )
        throw new Error(INVALID_REQUEST)
      op = {
        ...op,
        evidence,
        group: {
          ...group,
          createdAt: op.createdAt,
          mock: false,
          devices: Array.from({ length: summary.participants }, (_, index) => {
            const device = group.devices.find(d => d.slot === index + 1)
            return {
              slot: (index + 1) as 1 | 2 | 3,
              role: index === 0 ? ('owner' as const) : ('guardian' as const),
              name:
                device?.name.slice(0, 128) || (index === 0 ? 'Noir Wallet' : `Device ${index + 1}`),
              model: device?.model.slice(0, 128) || '',
              platform:
                index === 0
                  ? ('extension' as const)
                  : device?.platform === 'android'
                    ? ('android' as const)
                    : ('ios' as const)
            }
          })
        }
      }
      await creation().write(op)
      const account: AccountData = {
        id: op.scope.accountId,
        name: 'Multisig',
        source: {
          kind: 'frost-vault',
          version: 1,
          groupId: op.groupId,
          network: op.scope.network as VaultNetwork
        },
        birthdayHeight: op.birthdayHeight,
        addresses: { shielded: summary.address, transparent: '' },
        isPinned: false,
        isHidden: false
      }
      // Re-import is idempotent and validates the current DB even after a previous process saved its marker.
      await authorizeOperation(op)
      account.addresses = await creation().register(op.scope.walletId, account, record)
      await authorizeOperation(op)
      op = {
        ...op,
        phase: op.phase === 'metadata_saved' ? 'metadata_saved' : 'external_imported'
      }
      await creation().write(op)
      await creation().commitMetadata(op, account, () => authorizeOperation(op))
      await authorizeOperation(op)
      op = { ...op, phase: 'metadata_saved' }
      await creation().write(op)
      await creation().saveGroup(op.scope, op.group!)
      await authorizeOperation(op)
      op = { ...op, phase: 'ready' }
      await creation().write(op)
      await authorizeOperation(op)
      return { phase: 'ready', scope: op.scope }
    }
    return creation().withMutation(op.scope.walletId, () =>
      creation().withScope(op.scope, commitScoped)
    )
  }
  async function handleCreation(
    method:
      | 'vault.group.reserve'
      | 'vault.group.commit'
      | 'vault.group.status'
      | 'vault.group.cancel',
    payload: unknown
  ): Promise<unknown> {
    const request = parseCreationRequest(method, payload)
    if (method === 'vault.group.reserve') {
      const { activeWalletId } = await checkScope(request.scope)
      const state = await deps.readWalletState()
      const wallet = state.wallets.find(w => w.id === request.scope.walletId)
      if (state.activeAccountId !== undefined && state.activeAccountId !== request.scope.accountId)
        throw new Error(NOT_ACTIVE)
      if (wallet?.derivedAccountIds && !wallet.derivedAccountIds.includes(request.scope.accountId))
        throw new Error(SCOPE_UNAVAILABLE)
      await requireBoundActiveWallet(request.scope, activeWalletId)
      const birthdayHeight = await creation().birthdayHeight()
      const op: MultisigCreationOperation = {
        version: 1,
        operationId: crypto.randomUUID(),
        scope: { ...request.scope, accountId: crypto.randomUUID() },
        parentAccountId: request.scope.accountId,
        groupId: crypto.randomUUID(),
        birthdayHeight,
        threshold: request.threshold!,
        phase: 'reserved',
        createdAt: Date.now()
      }
      return creation().withScope(op.scope, async () => {
        await authorizeOperation(op)
        const unfinished = (await creation().list()).find(
          prior =>
            prior.scope.network === op.scope.network &&
            prior.scope.walletId === op.scope.walletId &&
            prior.parentAccountId === op.parentAccountId &&
            prior.phase !== 'ready'
        )
        if (unfinished) throw new Error('An earlier multisig setup is incomplete')
        await creation().write(op)
        await authorizeOperation(op)
        return op
      })
    }
    const op = await requireOperation(request.scope, request.operationId)
    if (method === 'vault.group.commit') return commitOperation(op, request.group, request.evidence)
    if (method === 'vault.group.status') {
      if (op.group) await commitOperation(op)
      return creation().withScope(op.scope, async () => {
        const current = await requireOperation(op.scope, op.operationId)
        await authorizeOperation(current)
        return current
      })
    }
    return creation().withScope(op.scope, async () => {
      const current = await requireOperation(op.scope, op.operationId)
      await authorizeOperation(current)
      if (current.phase !== 'reserved' || (await deps.readRecord(op.scope)))
        throw new Error('Saved creation material must be resumed')
      await creation().remove(op.scope, op.operationId)
      return true
    })
  }
  async function checkScope(scope: MultisigGroupScope): Promise<{ activeWalletId: string | null }> {
    const state = await deps.readWalletState()
    const wallet = state.wallets.find(candidate => candidate.id === scope.walletId)
    if (
      scope.network !== state.network ||
      !wallet ||
      !wallet.mnemonic ||
      !wallet.accountIds.includes(scope.accountId)
    ) {
      throw new Error(SCOPE_UNAVAILABLE)
    }
    return { activeWalletId: state.activeWalletId }
  }

  // Binding a credential for a wallet that is not active would unlock key material the user is
  // not currently working with, so the active check comes first and bind is never reached.
  async function requireBoundActiveWallet(
    scope: MultisigGroupScope,
    activeWalletId: string | null
  ): Promise<void> {
    if (!(await deps.isUnlocked())) throw new Error(LOCKED)
    if (scope.walletId !== activeWalletId) throw new Error(NOT_ACTIVE)
    if (!(await deps.bindCredential(scope.walletId))) throw new Error(NO_CREDENTIAL)
  }

  async function open(payload: unknown): Promise<VaultGroupSchema['vault.group.open']['response']> {
    const request = parseVaultGroupOpenRequest(payload)
    const op = request.operationId
      ? await requireOperation(request.scope, request.operationId)
      : null
    if (!op && deps.creation && (await deps.creation.read(request.scope)))
      throw new Error(INVALID_REQUEST)
    const { activeWalletId } = op
      ? (await authorizeOperation(op), { activeWalletId: op.scope.walletId })
      : await checkScope(request.scope)
    if (
      request.binding &&
      (!op ||
        op.phase !== 'reserved' ||
        request.binding.accountId !== op.scope.accountId ||
        request.binding.birthdayHeight !== op.birthdayHeight ||
        request.groupId !== op.groupId ||
        request.participants !== thresholdDeviceCount(op.threshold) ||
        request.threshold !== (op.threshold === '3-of-3' ? 3 : 2))
    )
      throw new Error(INVALID_REQUEST)
    if (op && !request.binding) throw new Error(INVALID_REQUEST)
    if (
      op &&
      (!request.outerSessionId ||
        (op.outerSessionId && op.outerSessionId !== request.outerSessionId) ||
        (op.rosterHash && op.rosterHash !== request.binding!.roster.rosterHash))
    )
      throw new Error(INVALID_REQUEST)
    if (request.mainnet !== (request.scope.network === 'mainnet')) {
      throw new Error(INVALID_REQUEST)
    }
    const performOpen = async (current: MultisigCreationOperation | null) => {
      if (current) {
        await authorizeOperation(current)
        if (
          current.phase !== 'reserved' ||
          (current.outerSessionId && current.outerSessionId !== request.outerSessionId) ||
          (current.rosterHash && current.rosterHash !== request.binding!.roster.rosterHash) ||
          (current.dkgSessionId && request.sessionId && current.dkgSessionId !== request.sessionId)
        )
          throw new Error(INVALID_REQUEST)
        if (current.dkgSessionId) return { sessionId: current.dkgSessionId }
      }
      await requireBoundActiveWallet(request.scope, activeWalletId)
      const reply = await deps.forwardToWorker('vault.dkg.open', {
        participants: request.participants,
        threshold: request.threshold,
        mainnet: request.mainnet,
        ownerWalletId: request.scope.walletId,
        groupId: request.groupId,
        ...(request.binding ? { binding: request.binding } : {}),
        ...(request.outerSessionId ? { outerSessionId: request.outerSessionId } : {}),
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId })
      })
      if (
        typeof reply !== 'object' ||
        reply === null ||
        !(current ? isDkgSessionIdText : isBase64Text)((reply as { sessionId?: unknown }).sessionId)
      )
        throw new Error(CANNOT_START)
      const sessionId = (reply as { sessionId: string }).sessionId
      if (current) {
        await authorizeOperation(current)
        await creation().write({
          ...current,
          rosterHash: request.binding!.roster.rosterHash,
          outerSessionId: request.outerSessionId!,
          dkgSessionId: sessionId
        })
      }
      return { sessionId }
    }
    return op
      ? creation().withScope(op.scope, async () =>
          performOpen(await requireOperation(op.scope, op.operationId))
        )
      : performOpen(null)
  }

  async function save(payload: unknown): Promise<true> {
    const request = parseVaultGroupSaveRequest(payload)
    if (request.record.version === 2) {
      return creation().withScope(request.scope, async () => {
        const op = await requireOperation(request.scope, request.operationId)
        await authorizeOperation(op)
        if (
          !op.rosterHash ||
          request.groupId !== op.groupId ||
          request.record.groupId !== op.groupId ||
          request.record.network !== op.scope.network ||
          request.record.version !== 2 ||
          request.record.accountId !== op.scope.accountId ||
          request.record.ownerWalletId !== op.scope.walletId
        )
          throw new Error(INVALID_REQUEST)
        const previous = await deps.readRecord(op.scope)
        if (previous && !sealedVaultRecordEquals(previous, request.record))
          throw new Error('Creation record cannot be replaced')
        await deps.saveRecord(op.scope, request.record)
        await authorizeOperation(op)
        if (op.phase === 'reserved') await creation().write({ ...op, phase: 'share_saved' })
        return true as const
      })
    }
    await checkScope(request.scope)
    if (
      (await deps.readRecord(request.scope))?.version === 2 ||
      (deps.creation && (await deps.creation.read(request.scope)))
    )
      throw new Error(INVALID_REQUEST)
    if (
      request.record.groupId !== request.groupId ||
      request.record.network !== request.scope.network
    ) {
      throw new Error(INVALID_REQUEST)
    }
    // Storage errors can name quotas or internals; the page only needs to know the save failed.
    // Nothing is deleted here: a failed save leaves the scope's earlier record as it was.
    try {
      await deps.saveRecord(request.scope, request.record)
    } catch {
      throw new Error(NOT_SAVED)
    }
    return true
  }

  async function summary(payload: unknown): Promise<VaultGroupSummaryResponse> {
    const { scope } = parseVaultGroupSummaryRequest(payload)
    const { activeWalletId } = await checkScope(scope)
    await requireBoundActiveWallet(scope, activeWalletId)
    const [record, groupId] = await Promise.all([deps.readRecord(scope), deps.readGroupId(scope)])
    if (!record || record.groupId !== groupId) return { status: 'missing' }
    if (
      record.version === 2 &&
      (record.accountId !== scope.accountId ||
        record.ownerWalletId !== scope.walletId ||
        record.network !== scope.network)
    )
      throw new Error(CANNOT_OPEN)
    const reply = await deps.forwardToWorker('vault.record.summary', {
      record,
      ownerWalletId: scope.walletId
    })
    const value = reply as Record<string, unknown> | null
    // The same rules the record header is held to, so the page never shows what a record could
    // not contain.
    if (
      typeof value !== 'object' ||
      value === null ||
      !isVaultFingerprint(value.fingerprint) ||
      !isVaultAddress(value.address) ||
      !isDkgShape({ participants: value.participants, threshold: value.threshold })
    ) {
      throw new Error(CANNOT_OPEN)
    }
    return {
      status: 'ok',
      fingerprint: value.fingerprint,
      address: value.address,
      participants: value.participants as 2 | 3,
      threshold: value.threshold as 2 | 3
    }
  }

  return {
    async resumePending() {
      if (!deps.creation) return
      for (const op of await deps.creation.list()) {
        if (op.phase !== 'ready' && op.group) {
          try {
            await commitOperation(op)
          } catch {
            /* The next active unlock or explicit status request retries. */
          }
        }
      }
    },
    handle<M extends VaultGroupMethod>(method: M, payload: unknown) {
      let run: Promise<unknown>
      switch (method) {
        case 'vault.group.pending':
          run = (async () => {
            const { scope } = parseVaultGroupSummaryRequest(payload)
            const { activeWalletId } = await checkScope(scope)
            await requireBoundActiveWallet(scope, activeWalletId)
            const pending = (await creation().list()).filter(
              op =>
                op.scope.network === scope.network &&
                op.scope.walletId === scope.walletId &&
                op.parentAccountId === scope.accountId &&
                op.phase !== 'ready'
            )
            const observed = await Promise.all(
              pending.map(async op =>
                op.phase === 'reserved' && (await deps.readRecord(op.scope))
                  ? { ...op, phase: 'share_saved' as const }
                  : op
              )
            )
            await checkScope(scope)
            if (!(await deps.isUnlocked())) throw new Error(LOCKED)
            return observed
          })()
          break
        case 'vault.group.reserve':
        case 'vault.group.commit':
        case 'vault.group.status':
        case 'vault.group.cancel':
          run = handleCreation(method, payload)
          break
        case 'vault.group.open':
          run = open(payload)
          break
        case 'vault.group.save':
          run = save(payload)
          break
        case 'vault.group.summary':
          run = summary(payload)
          break
        case 'vault.group.recover.prepare':
        case 'vault.group.recover.complete':
        case 'vault.group.recover.cancel':
          run = handleRecovery(method, payload)
          break
        default:
          run = Promise.reject(new Error(INVALID_REQUEST))
      }
      return run as Promise<VaultGroupSchema[M]['response']>
    }
  }
}
