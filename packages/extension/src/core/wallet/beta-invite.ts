import type { StorageV2Snapshot } from '@/ports/repositories'
import { BITCOIN_CHAIN_IDS, ZCASH_CHAIN_IDS } from '@/core/chains/registry/chain-ids'
import { DedupPromise } from '@/lib/async-utils'
import type { Network } from '@/types'

export interface BetaInviteTarget {
  readonly walletId: string
  readonly accountId: string
  readonly walletAddress: string
}

export type BetaInviteActivationState =
  | Readonly<{ phase: 'unverified' }>
  | Readonly<{ phase: 'verified'; inviteCode: string; target?: BetaInviteTarget }>
  | Readonly<{ phase: 'activated'; walletAddress: string }>

export interface BetaInviteStatus {
  readonly required: boolean
  readonly state: BetaInviteActivationState
}

export type BetaInviteErrorCode =
  | 'invalid-code'
  | 'used-code'
  | 'timeout'
  | 'service-unavailable'
  | 'wallet-not-ready'
  | 'verification-required'
  | 'binding-failed'

const ERROR_MESSAGES: Record<BetaInviteErrorCode, string> = {
  'invalid-code': 'Enter a valid invite code.',
  'used-code': 'This invite code has already been used.',
  timeout: 'Invite request timed out. Try again.',
  'service-unavailable': 'Invite service is unavailable. Try again.',
  'wallet-not-ready': 'Wallet account is not ready yet. Try again.',
  'verification-required': 'Verify an invite code first.',
  'binding-failed': 'Could not activate this invite code. Try again.'
}

export class BetaInviteError extends Error {
  constructor(readonly code: BetaInviteErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'BetaInviteError'
  }
}

export function getBetaInviteErrorMessage(error: unknown): string {
  return error instanceof BetaInviteError ? error.message : ERROR_MESSAGES['service-unavailable']
}

export function parseBetaInviteCode(value: unknown): string {
  if (typeof value !== 'string') {
    throw new BetaInviteError('invalid-code')
  }
  const code = value.trim()
  if (!code || code.length > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(code)) {
    throw new BetaInviteError('invalid-code')
  }
  return code
}

export function parseBetaInviteActivationState(value: unknown): BetaInviteActivationState {
  if (value === undefined || value === null) return { phase: 'unverified' }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new BetaInviteError('service-unavailable')
  }
  const record = value as Record<string, unknown>
  if (record.phase === 'unverified') return { phase: 'unverified' }
  if (
    record.phase === 'activated' &&
    typeof record.walletAddress === 'string' &&
    record.walletAddress
  ) {
    return { phase: 'activated', walletAddress: record.walletAddress }
  }
  if (record.phase === 'verified') {
    const inviteCode = parseBetaInviteCode(record.inviteCode)
    if (record.target === undefined) return { phase: 'verified', inviteCode }
    const target = record.target as Record<string, unknown> | null
    if (
      target &&
      typeof target.walletId === 'string' &&
      target.walletId &&
      typeof target.accountId === 'string' &&
      target.accountId &&
      typeof target.walletAddress === 'string' &&
      target.walletAddress
    ) {
      return {
        phase: 'verified',
        inviteCode,
        target: {
          walletId: target.walletId,
          accountId: target.accountId,
          walletAddress: target.walletAddress
        }
      }
    }
  }
  throw new BetaInviteError('service-unavailable')
}

export interface BetaInviteTargetNetworks {
  readonly evmChainIds: readonly string[]
  readonly solanaChainId: string
}

export function selectBetaInviteTarget(
  snapshot: StorageV2Snapshot,
  network: Network,
  chains: BetaInviteTargetNetworks
): BetaInviteTarget | null {
  const first = [...snapshot.keyDomains]
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    .map(keyDomain => ({
      keyDomain,
      account: snapshot.accounts
        .filter(account => account.keyDomainId === keyDomain.id)
        .sort(
          (left, right) => left.accountIndex - right.accountIndex || left.id.localeCompare(right.id)
        )[0]
    }))
    .find(item => item.account)
  if (!first?.account) return null

  const { keyDomain, account } = first
  const chainAccounts = snapshot.chainAccounts.filter(
    item => item.scope.keyDomainId === keyDomain.id && item.scope.accountId === account.id
  )
  const findAddress = (chainIds: readonly string[], scheme?: string): string | undefined => {
    for (const chainId of chainIds) {
      const candidates = chainAccounts.filter(item => item.scope.chainId === chainId)
      for (const chainAccount of candidates) {
        const address = snapshot.addresses
          .filter(
            item =>
              item.chainAccountId === chainAccount.id &&
              (item.purpose === 'receive' ||
                (scheme === 'evm' && item.purpose === 'identity' && item.preferredForReceive)) &&
              (scheme !== 'evm' ||
                (item.privacy === 'transparent' && item.walletCompatibility === 'broad')) &&
              (scheme === undefined || item.scheme === scheme)
          )
          .sort(
            (left, right) =>
              Number(right.preferredForReceive) - Number(left.preferredForReceive) ||
              left.id.localeCompare(right.id)
          )[0]
        if (address?.value) return address.value
      }
    }
    return undefined
  }

  const evm = findAddress(chains.evmChainIds, 'evm')
  const walletAddress =
    evm ??
    (keyDomain.source.kind === 'software'
      ? undefined
      : (findAddress([ZCASH_CHAIN_IDS[network]], 'zcash-transparent-p2pkh') ??
        findAddress([BITCOIN_CHAIN_IDS[network]]) ??
        findAddress([chains.solanaChainId], 'solana')))
  return walletAddress ? { walletId: keyDomain.id, accountId: account.id, walletAddress } : null
}

export interface BetaInviteActivationDependencies {
  readonly required: boolean
  readonly readState: () => Promise<unknown>
  readonly writeState: (state: BetaInviteActivationState) => Promise<void>
  readonly checkCode: (code: string) => Promise<void>
  readonly bindCode: (code: string, address: string) => Promise<void>
  readonly resolveTarget: () => Promise<BetaInviteTarget | null>
}

export class BetaInviteActivationCoordinator {
  private pending: Promise<void> = Promise.resolve()
  private readonly bindDedup = new DedupPromise<BetaInviteStatus>()

  constructor(private readonly dependencies: BetaInviteActivationDependencies) {}

  async getStatus(): Promise<BetaInviteStatus> {
    if (!this.dependencies.required) return { required: false, state: { phase: 'unverified' } }
    return {
      required: true,
      state: parseBetaInviteActivationState(await this.dependencies.readState())
    }
  }

  async isActivated(): Promise<boolean> {
    const status = await this.getStatus()
    return !status.required || status.state.phase === 'activated'
  }

  check(inviteCode: unknown): Promise<BetaInviteStatus> {
    return this.enqueue(async () => {
      const status = await this.getStatus()
      if (!status.required || status.state.phase === 'activated') return status
      const code = parseBetaInviteCode(inviteCode)
      await this.dependencies.checkCode(code)
      const state: BetaInviteActivationState = {
        phase: 'verified',
        inviteCode: code,
        ...(status.state.phase === 'verified' && status.state.target
          ? { target: status.state.target }
          : {})
      }
      await this.dependencies.writeState(state)
      return { required: true, state }
    })
  }

  bind(): Promise<BetaInviteStatus> {
    return this.bindDedup.run(() =>
      this.enqueue(async () => {
        const status = await this.getStatus()
        if (!status.required || status.state.phase === 'activated') return status
        if (status.state.phase !== 'verified') throw new BetaInviteError('verification-required')
        let { target } = status.state
        if (!target) {
          target = (await this.dependencies.resolveTarget()) ?? undefined
          if (!target) throw new BetaInviteError('wallet-not-ready')
          await this.dependencies.writeState({ ...status.state, target })
        }
        await this.dependencies.bindCode(status.state.inviteCode, target.walletAddress)
        const state: BetaInviteActivationState = {
          phase: 'activated',
          walletAddress: target.walletAddress
        }
        await this.dependencies.writeState(state)
        return { required: true, state }
      })
    )
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.catch(() => {}).then(operation)
    this.pending = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}
