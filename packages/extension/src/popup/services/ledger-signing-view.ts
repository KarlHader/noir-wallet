import {
  parseLedgerPendingSigning,
  type LedgerPendingSigning
} from '@/core/keyring/protocol/ledger-signing'
import { parseTransactionId } from '@/core/transactions/domain'
import { evmWalletClient } from './evm-wallet-client'
import { bitcoinWalletClient } from './bitcoin-wallet-client'

export interface LedgerSigningView extends Omit<
  LedgerPendingSigning,
  'requestDigest' | 'requestId'
> {
  readonly requestId?: string
  readonly transactionId?: string
  readonly family?: 'evm' | 'bitcoin'
}

export async function loadLedgerSigningView(query: {
  readonly requestId?: string
  readonly transactionId?: string
  readonly family?: string
}): Promise<LedgerSigningView> {
  if (query.requestId) {
    const response = await chrome.runtime.sendMessage({
      type: 'GET_LEDGER_SIGNING_REQUEST',
      requestId: query.requestId
    })
    if (!response || typeof response !== 'object')
      throw new Error('Ledger signing response unavailable')
    if (typeof response.error === 'string') throw new Error(response.error)
    return parseLedgerPendingSigning(response.result)
  }
  if (!query.transactionId || (query.family !== 'evm' && query.family !== 'bitcoin'))
    throw new Error('Ledger request not found')
  const transactionId = parseTransactionId(query.transactionId)
  const client = query.family === 'evm' ? evmWalletClient : bitcoinWalletClient
  const external = await client.getExternalSigningRequest(transactionId)
  if (
    !external ||
    external.vendor !== 'ledger' ||
    !external.ledgerRequest ||
    external.expiresAt <= Date.now()
  )
    throw new Error('Ledger request unavailable. Review this action again.')
  return {
    transactionId,
    family: query.family,
    request: external.ledgerRequest,
    scope: { ...external.scope, chainId: external.chainId },
    payloadFingerprint: { algorithm: 'sha256', digestHex: external.payloadFingerprint },
    expiresAt: external.expiresAt,
    summary: external.summary
  }
}
