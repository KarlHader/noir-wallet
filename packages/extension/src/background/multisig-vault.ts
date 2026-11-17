/**
 * Background side of `vault.group.*`. Everything environment-specific comes in through
 * `MultisigVaultDeps`, so this module imports nothing that needs `chrome` and runs under Node tests.
 *
 * Only `open` and `summary` need the Worker, and both go through the active wallet's credential:
 * the Worker derives the record key from the mnemonic it holds for that wallet. `save` handles
 * ciphertext only, so it deliberately needs neither an unlock nor a credential.
 */
import { isBase64Text, isDkgShape } from '@/core/multisig/dkg-protocol'
import {
  parseVaultGroupOpenRequest,
  parseVaultGroupSaveRequest,
  parseVaultGroupSummaryRequest,
  type VaultGroupMethod,
  type VaultGroupSchema,
  type VaultGroupSummaryResponse
} from '@/core/multisig/vault-group-rpc'
import {
  isVaultAddress,
  isVaultFingerprint,
  type SealedVaultRecord,
  type VaultNetwork
} from '@/core/multisig/vault-record'
import type { MultisigGroupScope } from '@/lib/multisig-group-storage'

export interface MultisigVaultWallet {
  id: string
  mnemonic: boolean
  accountIds: readonly string[]
}

export interface MultisigVaultDeps {
  readWalletState(): Promise<{
    network: VaultNetwork
    activeWalletId: string | null
    wallets: readonly MultisigVaultWallet[]
  }>
  isUnlocked(): Promise<boolean>
  bindCredential(walletId: string): Promise<boolean>
  forwardToWorker(
    method: 'vault.dkg.open' | 'vault.record.summary',
    payload: Readonly<Record<string, unknown>>
  ): Promise<unknown>
  readRecord(scope: MultisigGroupScope): Promise<SealedVaultRecord | null>
  /** Stores the record and proves it landed; on failure the scope's earlier record is kept. */
  saveRecord(scope: MultisigGroupScope, record: SealedVaultRecord): Promise<void>
  readGroupId(scope: MultisigGroupScope): Promise<string | null>
}

export interface MultisigVaultHandler {
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
    const { activeWalletId } = await checkScope(request.scope)
    if (request.mainnet !== (request.scope.network === 'mainnet')) {
      throw new Error(INVALID_REQUEST)
    }
    await requireBoundActiveWallet(request.scope, activeWalletId)
    const reply = await deps.forwardToWorker('vault.dkg.open', {
      participants: request.participants,
      threshold: request.threshold,
      mainnet: request.mainnet,
      ownerWalletId: request.scope.walletId,
      groupId: request.groupId,
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId })
    })
    if (
      typeof reply !== 'object' ||
      reply === null ||
      !isBase64Text((reply as { sessionId?: unknown }).sessionId)
    ) {
      throw new Error(CANNOT_START)
    }
    return { sessionId: (reply as { sessionId: string }).sessionId }
  }

  async function save(payload: unknown): Promise<true> {
    const request = parseVaultGroupSaveRequest(payload)
    await checkScope(request.scope)
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
    handle<M extends VaultGroupMethod>(method: M, payload: unknown) {
      let run: Promise<unknown>
      switch (method) {
        case 'vault.group.open':
          run = open(payload)
          break
        case 'vault.group.save':
          run = save(payload)
          break
        case 'vault.group.summary':
          run = summary(payload)
          break
        default:
          run = Promise.reject(new Error(INVALID_REQUEST))
      }
      return run as Promise<VaultGroupSchema[M]['response']>
    }
  }
}
