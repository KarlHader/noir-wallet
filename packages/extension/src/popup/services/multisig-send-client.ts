import { requestVaultSend } from '@/core/worker/client'
import { TimeoutError, withTimeout } from '@/lib/async-utils'
import { MultisigSendError, toMultisigSendError } from '@/core/multisig/send-errors'
import { zcashWalletRuntimeClient } from './zcash-wallet-runtime-client'
import type {
  VaultSendAuthority,
  VaultSendPrepareRequest,
  VaultSendPrepareResponse,
  VaultSendProgress,
  VaultSendRecovery,
  VaultSendReview,
  VaultSendTransaction
} from '@/core/multisig/send-rpc'
import type { MultisigEnvelope } from '@/core/multisig/messages'
import type { RosterManifest } from '@/core/multisig/roster'
import type { FeeQuote } from '@/config/fee'
import type { MultisigGroupScope } from '@/lib/multisig-group-storage'
import { settleMultisigSendReview } from '@/popup/pages/multisig/send-model'

type SendDraft = Omit<VaultSendPrepareRequest, 'feeQuoteId' | 'marginalFeeZats'>
/** The page receives a review authority and public summary, never transaction bytes. */
export async function prepareMultisigSend(
  draft: SendDraft,
  assertCurrent: () => void
): Promise<VaultSendPrepareResponse> {
  assertCurrent()
  let quote: FeeQuote
  try {
    quote = await withTimeout(zcashWalletRuntimeClient.getFeeQuote(), 15_000, 'Network fee quote')
  } catch (error) {
    assertCurrent()
    throw toMultisigSendError(
      error,
      error instanceof TimeoutError ? 'fee_quote_timeout' : 'fee_quote_unavailable'
    )
  }
  assertCurrent()
  if (quote.expiresAt <= Date.now()) throw new MultisigSendError('fee_quote_unavailable')
  const response = await requestVaultSend('vault.send.prepare', {
    ...draft,
    feeQuoteId: quote.id,
    marginalFeeZats: quote.standardMarginalFeeZats
  })
  return settleMultisigSendReview(response, draft, assertCurrent, cancelMultisigSend)
}

export function authorityFromReview(review: VaultSendReview): VaultSendAuthority {
  return {
    walletId: review.binding.walletId,
    reviewId: review.binding.reviewId,
    sessionId: review.binding.sessionId
  }
}

export function startMultisigSend(authority: VaultSendAuthority): Promise<VaultSendProgress> {
  return requestVaultSend('vault.send.start', authority)
}

export function getMultisigSendRoster(authority: VaultSendAuthority): Promise<RosterManifest> {
  return requestVaultSend('vault.send.roster', authority)
}

export function ingestMultisigSend(
  authority: VaultSendAuthority,
  envelope: MultisigEnvelope
): Promise<VaultSendProgress> {
  return requestVaultSend('vault.send.ingest', { ...authority, envelope })
}

export function statusMultisigSend(authority: VaultSendAuthority): Promise<VaultSendProgress> {
  return requestVaultSend('vault.send.status', authority)
}

export function cancelMultisigSend(authority: VaultSendAuthority): Promise<true> {
  return requestVaultSend('vault.send.cancel', authority)
}

export function closeMultisigSend(authority: VaultSendAuthority): Promise<true> {
  return requestVaultSend('vault.send.close', authority)
}

export function executeMultisigSend(authority: VaultSendAuthority): Promise<VaultSendTransaction> {
  return requestVaultSend('vault.send.execute', authority)
}

export function listMultisigSendTransactions(
  scope: MultisigGroupScope
): Promise<VaultSendTransaction[]> {
  return requestVaultSend('vault.send.transactions', { scope })
}

export function readMultisigSendRecovery(scope: MultisigGroupScope): Promise<VaultSendRecovery> {
  return requestVaultSend('vault.send.recovery', { scope })
}
