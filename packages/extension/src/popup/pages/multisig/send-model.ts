import { parseDisplayUnitAmount } from '@/lib/number-format'
import { ZEC_DECIMALS } from '@/config/wallet'
import { thresholdDeviceCount } from '@/core/multisig/types'
import { parseVaultGroupScope } from '@/core/multisig/vault-group-rpc'
import { parseSigningIntentBinding } from '@/core/multisig/signing-journal'
import type { AccountSource } from '@/core/accounts/domain'
import type { DeviceSlot, MultisigGroupRecord } from '@/core/multisig/types'
import type {
  VaultSendAuthority,
  VaultSendPrepareRequest,
  VaultSendPrepareResponse,
  VaultSendRecovery,
  VaultSendReview,
  VaultSendTransaction
} from '@/core/multisig/send-rpc'
import type { MultisigGroupScope } from '@/lib/multisig-group-storage'

interface ActiveSendAccount {
  network: 'mainnet' | 'testnet'
  walletId: string | null
  accountId: string | null
  source?: AccountSource
}

export interface MultisigSendContext {
  scope: MultisigGroupScope
  group: MultisigGroupRecord
}

export function parseMultisigSendScope(search: string): MultisigGroupScope | null {
  const params = new URLSearchParams(search)
  try {
    return parseVaultGroupScope({
      network: params.get('network'),
      walletId: params.get('walletId'),
      accountId: params.get('accountId')
    })
  } catch {
    return null
  }
}

function hasSendRoster(group: MultisigGroupRecord): boolean {
  if (
    group.mock ||
    !['2-of-2', '2-of-3', '3-of-3'].includes(group.threshold) ||
    group.devices.length !== thresholdDeviceCount(group.threshold)
  )
    return false
  const slots = new Set(group.devices.map(device => device.slot))
  return (
    group.devices.every(
      device =>
        Number.isInteger(device.slot) &&
        (device.slot === 1
          ? device.role === 'owner' && device.platform === 'extension'
          : device.slot >= 2 &&
            device.slot <= group.devices.length &&
            device.role === 'guardian' &&
            ['ios', 'android'].includes(device.platform))
    ) &&
    slots.size === group.devices.length &&
    slots.has(1)
  )
}

/** UI slots are one-based; the authenticated signing protocol uses extension slot zero. */
export function getMultisigSendSlots(
  group: MultisigGroupRecord,
  selectedPhone: DeviceSlot | null
): number[] | null {
  if (!hasSendRoster(group)) return null
  if (group.threshold === '2-of-3') {
    if (
      selectedPhone === null ||
      selectedPhone === 1 ||
      !group.devices.some(device => device.slot === selectedPhone && device.role === 'guardian')
    ) {
      return null
    }
    return [0, selectedPhone - 1]
  }
  return group.devices.map(device => device.slot - 1).sort((left, right) => left - right)
}

/** Cached roster display never substitutes for Background's authenticated scope checks. */
export function resolveMultisigSendContext(
  scope: MultisigGroupScope | null,
  active: ActiveSendAccount,
  group: MultisigGroupRecord | null
): MultisigSendContext | null {
  if (
    !scope ||
    !group ||
    !hasSendRoster(group) ||
    active.network !== scope.network ||
    active.walletId !== scope.walletId ||
    active.accountId !== scope.accountId ||
    active.source?.kind !== 'frost-vault' ||
    active.source.version !== 1 ||
    active.source.network !== scope.network ||
    active.source.groupId !== group.groupId
  )
    return null
  return { scope, group }
}

export function parseMultisigSendAmount(amount: string): string | null {
  try {
    const zats = parseDisplayUnitAmount(amount, ZEC_DECIMALS)
    return BigInt(zats) > 0n && BigInt(zats) <= 2_100_000_000_000_000n ? zats : null
  } catch {
    return null
  }
}

/** Accept only an actual review of this draft; request fields cannot substitute for PCZT review. */
export function validateMultisigSendReview(
  review: VaultSendReview,
  draft: Omit<VaultSendPrepareRequest, 'feeQuoteId' | 'marginalFeeZats'>,
  now: number = Date.now()
): void {
  const binding = review?.binding
  // The journal parser owns the canonical session, digest, account and slot shape checks.
  const parsed = parseSigningIntentBinding({
    ...binding,
    threshold: draft.selectedSlots.length === 3 ? '3-of-3' : '2-of-3',
    transport: draft.transport,
    createdAt: 0
  })
  const summary = review.summary
  if (
    !Number.isSafeInteger(now) ||
    parsed.walletId !== draft.scope.walletId ||
    parsed.accountId !== draft.scope.accountId ||
    parsed.network !== draft.scope.network ||
    parsed.groupId !== draft.groupId ||
    parsed.rosterVersion !== draft.rosterVersion ||
    parsed.expiresAt <= now ||
    JSON.stringify(parsed.selectedSlots) !== JSON.stringify(draft.selectedSlots) ||
    !summary ||
    summary.recipient !== draft.to ||
    summary.amount !== draft.amountZats ||
    summary.memo !== (draft.memo ?? '') ||
    typeof summary.fee !== 'string' ||
    !/^(0|[1-9][0-9]{0,15})$/.test(summary.fee) ||
    BigInt(summary.fee) > 2_100_000_000_000_000n
  ) {
    throw new Error('Multisig review does not match this transfer')
  }
}

/** A late review still reserves signing authority until Background cancels it. */
export async function settleMultisigSendReview(
  response: VaultSendPrepareResponse,
  draft: Omit<VaultSendPrepareRequest, 'feeQuoteId' | 'marginalFeeZats'>,
  assertCurrent: () => void,
  cancel: (authority: VaultSendAuthority) => Promise<unknown>
): Promise<VaultSendPrepareResponse> {
  if (response.available) {
    try {
      assertCurrent()
      validateMultisigSendReview(response, draft)
      return response
    } catch (error) {
      const binding = response.binding
      await cancel({
        walletId: binding.walletId,
        reviewId: binding.reviewId,
        sessionId: binding.sessionId
      }).catch(() => {})
      throw error
    }
  }
  assertCurrent()
  if (!['pczt_review_unavailable', 'fee_quote_unavailable'].includes(response.reason)) {
    throw new Error('Invalid multisig preparation response')
  }
  return response
}

const TRANSACTION_PHASE_RANK = {
  finalized: 0,
  submission_unknown: 1,
  broadcast: 2,
  confirmed: 3
} as const

export function parseMultisigSendRecovery(value: unknown): VaultSendRecovery {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid recovery state')
  const recovery = value as Record<string, unknown>
  if (
    Object.keys(recovery).length !== 2 ||
    typeof recovery.signedWithoutTransaction !== 'boolean' ||
    !['none', 'signed_without_receipt', 'finalization_incomplete'].includes(
      recovery.status as string
    ) ||
    recovery.signedWithoutTransaction !== (recovery.status !== 'none')
  )
    throw new Error('Invalid recovery state')
  return recovery as unknown as VaultSendRecovery
}

/** An older storage read must not turn a confirmed or broadcast payment back into pending. */
export function mergeMultisigSendTransactions(
  current: readonly VaultSendTransaction[],
  incoming: readonly VaultSendTransaction[],
  scope: MultisigGroupScope
): VaultSendTransaction[] {
  const byReview = new Map<string, VaultSendTransaction>()
  for (const transaction of [...current, ...incoming]) {
    if (
      transaction.binding.network !== scope.network ||
      transaction.binding.walletId !== scope.walletId ||
      transaction.binding.accountId !== scope.accountId ||
      !/^[0-9a-f]{64}$/.test(transaction.txId)
    )
      throw new Error('Invalid multisig transaction scope')
    const previous = byReview.get(transaction.binding.reviewId)
    if (previous && previous.txId !== transaction.txId)
      throw new Error('Conflicting multisig transaction identity')
    if (
      !previous ||
      TRANSACTION_PHASE_RANK[transaction.phase] > TRANSACTION_PHASE_RANK[previous.phase]
    )
      byReview.set(transaction.binding.reviewId, transaction)
  }
  return [...byReview.values()]
}

export function getUnresolvedMultisigTransactions(
  transactions: readonly VaultSendTransaction[]
): VaultSendTransaction[] {
  return transactions.filter(transaction => transaction.phase !== 'confirmed')
}
