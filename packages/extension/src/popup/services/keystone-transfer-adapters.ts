import type { TransactionId } from '@/core/transactions/domain'
import { getActiveChainEndpointSettings } from '@/core/chains/chain-endpoint-settings'
import { resolveEvmNetworkCatalog } from '@/core/chains/evm-runtime-config'
import { bytesToBase64 } from '@/lib/bytes'
import { parseKeystoneEthereumSignature, parseSignedBitcoinPsbt, type UR } from '@/lib/keystone'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { bitcoinWalletClient } from './bitcoin-wallet-client'
import { evmWalletClient } from './evm-wallet-client'
import type { OnchainTransferSubmission } from './onchain-result-adapters'

type KeystoneSigningRequest = Pick<
  NonNullable<Awaited<ReturnType<typeof bitcoinWalletClient.getExternalSigningRequest>>>,
  'chainId' | 'expiresAt' | 'payloadFingerprint' | 'request'
>

interface KeystoneTransferAdapter {
  readonly client: {
    readonly getExternalSigningRequest: (
      id: TransactionId
    ) => Promise<KeystoneSigningRequest | null>
    readonly rejectTransfer: (id: TransactionId) => Promise<unknown>
    readonly submitExternalSignature: (
      id: TransactionId,
      payloadFingerprint: string,
      responseBase64: string
    ) => Promise<OnchainTransferSubmission>
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
  readonly sentTitle: string
  readonly sentDescription: (networkName: string) => string
  readonly failureTitle: string
  readonly failureDescription: string
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
