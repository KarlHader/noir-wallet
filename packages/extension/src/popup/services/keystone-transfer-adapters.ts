import type { TransactionId } from '@/core/transactions/domain'
import { getActiveChainEndpointSettings } from '@/core/chains/chain-endpoint-settings'
import { resolveEvmNetworkCatalog } from '@/core/chains/evm-runtime-config'
import { bytesToBase64 } from '@/lib/bytes'
import { parseKeystoneEthereumSignature, parseSignedBitcoinPsbt, type UR } from '@/lib/keystone'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { bitcoinWalletClient } from './bitcoin-wallet-client'
import { evmWalletClient } from './evm-wallet-client'
import type { OnchainTransferSubmission } from './onchain-result-adapters'
import type { KeystoneEvmSigningView } from '@/background/keystone-evm-message-signing'

type KeystoneSigningRequest = Pick<
  NonNullable<Awaited<ReturnType<typeof bitcoinWalletClient.getExternalSigningRequest>>>,
  'chainId' | 'expiresAt' | 'payloadFingerprint' | 'request'
> &
  Partial<Pick<KeystoneEvmSigningView, 'kind'>>

export interface KeystoneTransferAdapter<SigningId extends string = TransactionId> {
  readonly client: {
    readonly getExternalSigningRequest: (id: SigningId) => Promise<KeystoneSigningRequest | null>
    readonly rejectTransfer: (id: SigningId) => Promise<unknown>
    readonly submitExternalSignature: (
      id: SigningId,
      payloadFingerprint: string,
      responseBase64: string
    ) => Promise<Pick<OnchainTransferSubmission, 'status'> | { readonly status: 'signed' }>
  }
  readonly name: string
  readonly title: string
  readonly reviewPrompt: string
  readonly scanAction: string
  readonly responseType: string
  readonly encodeResponse: (ur: UR) => string
  readonly networkName: (chainId: string) => string
  readonly detailLabel: string
  readonly showNetworkInReview?: boolean
  readonly signatureOnly?: boolean
  readonly sentTitle: string
  readonly sentDescription: (networkName: string) => string
  readonly failureTitle: string
  readonly failureDescription: string
}

async function sendKeystoneDeviceMessage<Result>(message: {
  readonly type: string
  readonly requestId: string
  readonly signatureCborBase64?: string
}): Promise<Result> {
  const response: { result?: Result; error?: string } | undefined =
    await chrome.runtime.sendMessage(message)
  if (response?.result === undefined) {
    throw new Error(response?.error ?? 'Keystone signing is unavailable. Review this action again.')
  }
  return response.result
}

export type KeystoneTransferFamily = 'bitcoin' | 'evm'

export const keystoneTransferAdapters: Readonly<
  Record<KeystoneTransferFamily, KeystoneTransferAdapter>
> = {
  bitcoin: {
    client: bitcoinWalletClient,
    name: 'Bitcoin',
    title: 'Sign Bitcoin with Keystone',
    reviewPrompt:
      'Scan this PSBT with Keystone. Verify the recipient, amount, and fee again on the device before signing.',
    scanAction: 'Scan Signed Transaction',
    responseType: 'crypto-psbt',
    encodeResponse: ur => bytesToBase64(parseSignedBitcoinPsbt(ur)),
    networkName: () => 'Bitcoin',
    detailLabel: 'Asset',
    sentTitle: 'Bitcoin sent',
    sentDescription: () =>
      'The signed Bitcoin transaction was broadcast and is now awaiting confirmation.',
    failureTitle: 'Signing failed',
    failureDescription: 'The signed Bitcoin transaction could not be completed.'
  },
  evm: {
    client: evmWalletClient,
    name: 'EVM',
    title: 'Sign with Keystone',
    reviewPrompt:
      'Scan this request with Keystone. Verify the recipient, amount, network, and fee again on the device before signing.',
    scanAction: 'Scan Signature',
    responseType: 'eth-signature',
    encodeResponse: ur => {
      parseKeystoneEthereumSignature(ur)
      return bytesToBase64(ur.cbor)
    },
    networkName: chainId =>
      resolveEvmNetworkCatalog(DEFAULT_NETWORK, getActiveChainEndpointSettings()).find(
        candidate => candidate.chainId === chainId
      )?.displayName ?? 'EVM network',
    detailLabel: 'Network',
    showNetworkInReview: true,
    sentTitle: 'Transaction sent',
    sentDescription: networkName =>
      `The signed transaction was broadcast on ${networkName} and is now awaiting confirmation.`,
    failureTitle: 'Signature rejected',
    failureDescription:
      'The signature did not match the approved request or active Keystone Account. Start a new send.'
  }
}

export const keystoneEvmDeviceSigningAdapter: KeystoneTransferAdapter<string> = {
  ...keystoneTransferAdapters.evm,
  signatureOnly: true,
  client: {
    getExternalSigningRequest: requestId =>
      sendKeystoneDeviceMessage<KeystoneEvmSigningView>({
        type: 'GET_KEYSTONE_EVM_DEVICE_SIGNING_REQUEST',
        requestId
      }),
    rejectTransfer: requestId =>
      sendKeystoneDeviceMessage({ type: 'CANCEL_KEYSTONE_EVM_DEVICE_SIGNING_REQUEST', requestId }),
    submitExternalSignature: async (requestId, _payloadFingerprint, signatureCborBase64) => {
      await sendKeystoneDeviceMessage({
        type: 'SUBMIT_KEYSTONE_EVM_DEVICE_SIGNING_RESPONSE',
        requestId,
        signatureCborBase64
      })
      return { status: 'signed' }
    }
  },
  encodeResponse: ur => {
    if (ur.type !== 'eth-signature')
      throw new Error('Scan the Ethereum signature shown by Keystone.')
    return bytesToBase64(ur.cbor)
  },
  failureDescription: 'The signature did not match the approved request. Review this action again.'
}
