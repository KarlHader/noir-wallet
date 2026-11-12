import {
  type LedgerDeviceSigningRequest,
  type LedgerDeviceSigningResponse
} from '@/core/keyring/protocol/ledger-signing'
import { evmWalletClient } from './evm-wallet-client'
import { bitcoinWalletClient } from './bitcoin-wallet-client'
import { parseTransactionId } from '@/core/transactions/domain'
import { signLedgerEvmRequest } from '@/lib/ledger/evm'
import { signLedgerBitcoinRequest } from '@/lib/ledger/bitcoin'
import { ledgerBitcoinAppName } from '@/lib/ledger/bitcoin-model'
import { signLedgerSolanaRequest } from '@/lib/ledger/solana'
import { signLedgerNearRequest } from '@/lib/ledger/near'
import { signLedgerStarknetRequest } from '@/lib/ledger/starknet'
import { LEDGER_STARKNET_APP_NAME } from '@/lib/ledger/starknet-model'
import { signLedgerDashRequest } from '@/lib/ledger/dash'
import { LEDGER_DASH_APP_NAME } from '@/lib/ledger/dash-model'
import type { LedgerSessionOptions } from '@/lib/ledger/device'
import type { LedgerSigningView } from './ledger-signing-view'

export { loadLedgerSigningView } from './ledger-signing-view'
export type { LedgerSigningView } from './ledger-signing-view'

async function send(message: Record<string, unknown>): Promise<unknown> {
  const response = await chrome.runtime.sendMessage(message)
  if (!response || typeof response !== 'object')
    throw new Error('Ledger signing response unavailable')
  if (typeof response.error === 'string') throw new Error(response.error)
  return response.result
}
export function signLedgerDeviceRequest(
  request: LedgerDeviceSigningRequest,
  options: LedgerSessionOptions
): Promise<LedgerDeviceSigningResponse> {
  if (request.kind === 'psbt' || request.kind === 'bip322-simple')
    return signLedgerBitcoinRequest(request, options)
  if (request.kind === 'solana-transaction') return signLedgerSolanaRequest(request, options)
  if (request.kind === 'near-transaction' || request.kind === 'near-nep413-message')
    return signLedgerNearRequest(request, options)
  if (
    request.kind === 'starknet-invoke' ||
    request.kind === 'starknet-deploy-account' ||
    request.kind === 'starknet-typed-data'
  ) {
    return signLedgerStarknetRequest(request, options)
  }
  if (request.kind === 'dash-psbt' || request.kind === 'dash-message')
    return signLedgerDashRequest(request, options)
  if ('derivationPath' in request) return signLedgerEvmRequest(request, options)
  throw new Error('Unsupported Ledger signing request')
}
export async function submitLedgerSigningView(
  view: LedgerSigningView,
  response: LedgerDeviceSigningResponse
): Promise<void> {
  if (view.requestId) {
    await send({ type: 'SUBMIT_LEDGER_SIGNING_RESPONSE', requestId: view.requestId, response })
    return
  }
  if (!view.transactionId) throw new Error('Ledger request unavailable')
  const transactionId = parseTransactionId(view.transactionId)
  if (view.family === 'evm' && 'signatureHex' in response) {
    await evmWalletClient.submitExternalSignature(
      transactionId,
      view.payloadFingerprint.digestHex,
      response.signatureHex
    )
    return
  }
  if ('kind' in response && response.kind === 'dash-psbt') {
    throw new Error('Dash hardware response cannot be broadcast')
  }
  if (view.family === 'bitcoin' && 'signedPsbtBase64' in response) {
    await bitcoinWalletClient.submitExternalSignature(
      transactionId,
      view.payloadFingerprint.digestHex,
      response.signedPsbtBase64
    )
    return
  }
  throw new Error('Ledger response does not match chain')
}
export async function cancelLedgerSigningView(
  view: LedgerSigningView,
  reason?: string
): Promise<void> {
  if (view.requestId) {
    await send({
      type: 'CANCEL_LEDGER_SIGNING_REQUEST',
      requestId: view.requestId,
      ...(reason ? { reason } : {})
    })
    return
  }
  if (view.transactionId)
    await (view.family === 'evm' ? evmWalletClient : bitcoinWalletClient).rejectTransfer(
      parseTransactionId(view.transactionId)
    )
}
export function ledgerRequestDeviceApp(request: LedgerDeviceSigningRequest): string {
  if (request.kind === 'psbt' || request.kind === 'bip322-simple')
    return ledgerBitcoinAppName(request.network)
  if (request.kind === 'solana-transaction') return 'Solana'
  if (request.kind === 'near-transaction' || request.kind === 'near-nep413-message') return 'NEAR'
  if (
    request.kind === 'starknet-invoke' ||
    request.kind === 'starknet-deploy-account' ||
    request.kind === 'starknet-typed-data'
  ) {
    return LEDGER_STARKNET_APP_NAME
  }
  if (request.kind === 'dash-psbt' || request.kind === 'dash-message') return LEDGER_DASH_APP_NAME
  return 'Ethereum'
}
export function ledgerRequestAddress(request: LedgerDeviceSigningRequest): string {
  if (
    request.kind === 'starknet-invoke' ||
    request.kind === 'starknet-deploy-account' ||
    request.kind === 'starknet-typed-data'
  ) {
    return request.address
  }
  return 'expectedAddress' in request ? request.expectedAddress : request.expectedPublicKey
}
