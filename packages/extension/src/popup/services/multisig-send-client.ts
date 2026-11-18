import { requestVaultSend } from '@/core/worker/client'
import { withTimeout } from '@/lib/async-utils'
import { zcashWalletRuntimeClient } from './zcash-wallet-runtime-client'
import type { VaultSendPrepareRequest, VaultSendPrepareResponse } from '@/core/multisig/send-rpc'
import type { FeeQuote } from '@/config/fee'

type SendDraft = Omit<VaultSendPrepareRequest, 'feeQuoteId' | 'marginalFeeZats'>
type UnavailableSend = Extract<VaultSendPrepareResponse, { available: false }>

/** No signing authority or transaction bytes are exposed to the form. */
export async function prepareMultisigSend(
  draft: SendDraft,
  assertCurrent: () => void
): Promise<UnavailableSend> {
  assertCurrent()
  let quote: FeeQuote
  try {
    quote = await withTimeout(zcashWalletRuntimeClient.getFeeQuote(), 15_000, 'Network fee quote')
  } catch {
    assertCurrent()
    return { available: false, reason: 'fee_quote_unavailable' }
  }
  assertCurrent()
  if (quote.expiresAt <= Date.now()) return { available: false, reason: 'fee_quote_unavailable' }
  const response = await requestVaultSend('vault.send.prepare', {
    ...draft,
    feeQuoteId: quote.id,
    marginalFeeZats: quote.standardMarginalFeeZats
  })
  // A future Background may support reviews before this form supports displaying them.
  // Release any resulting authority rather than letting an undisplayed review remain live.
  if (response.available === true) {
    await requestVaultSend('vault.send.cancel', {
      walletId: response.binding.walletId,
      reviewId: response.binding.reviewId,
      sessionId: response.binding.sessionId
    })
    throw new Error('Multisig review is unavailable in this page')
  }
  assertCurrent()
  if (
    response.available !== false ||
    !['pczt_review_unavailable', 'fee_quote_unavailable'].includes(response.reason)
  ) {
    throw new Error('Invalid multisig preparation response')
  }
  return response
}
