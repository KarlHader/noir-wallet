import { DASH_CHAIN_IDS } from '@/core/chains/registry/chain-ids'
import { IndexedDbStorageV2Repository } from '@/infrastructure/persistence/repositories'
import { loadActiveDashDiscoveryContext } from '@/infrastructure/chains/dash'
import type {
  BackgroundDashTransferController,
  DashExternalSignatureRequired
} from './dash-transfer-controller'
import { loadLedgerDashAccountBinding } from './dash-dapp'
import { requestLedgerSignature } from './ledger-signing-coordinator'

export function beginDashLedgerWalletSignature(
  controller: BackgroundDashTransferController,
  handoff: DashExternalSignatureRequired
): { readonly tabReady: Promise<void>; readonly done: Promise<boolean> } {
  let resolveTab!: () => void
  let rejectTab!: (error: Error) => void
  let tabSettled = false
  const tabReady = new Promise<void>((resolve, reject) => {
    resolveTab = () => {
      if (tabSettled) return
      tabSettled = true
      resolve()
    }
    rejectTab = error => {
      if (tabSettled) return
      tabSettled = true
      reject(error)
    }
  })
  const done = continueDashLedgerWalletSignature(controller, handoff, resolveTab, rejectTab)
  return { tabReady, done }
}

async function continueDashLedgerWalletSignature(
  controller: BackgroundDashTransferController,
  handoff: DashExternalSignatureRequired,
  resolveTab: () => void,
  rejectTab: (error: Error) => void
): Promise<boolean> {
  const failure = (error: unknown): Error =>
    error instanceof Error ? error : new Error('Dash transfer failed')
  try {
    const pending = await controller.getPendingApproval(handoff.transactionId)
    if (
      !pending ||
      pending.graph.root.id !== handoff.transactionId ||
      pending.review.payloadFingerprint.digestHex !== handoff.payloadFingerprint ||
      pending.review.summary.schema !== 'dash.psbt.v1'
    ) {
      throw new Error('Pending Dash transfer was not found')
    }
    const psbtBase64 = await controller.getLedgerPsbt(handoff.transactionId)
    const storageRepository = new IndexedDbStorageV2Repository()
    const chainId = pending.review.chainId
    if (chainId !== DASH_CHAIN_IDS.mainnet) {
      throw new Error('Dash hardware wallets support mainnet only.')
    }
    const context = await loadActiveDashDiscoveryContext(storageRepository, chainId)
    if (
      !context ||
      context.keyDomainSource.kind !== 'hardware' ||
      context.keyDomainSource.vendor !== 'ledger' ||
      context.chainAccount.scope.chainId !== chainId
    ) {
      throw new Error('Dash transfers require a software account')
    }
    const signer = pending.review.summary.fields.signer
    const binding = await loadLedgerDashAccountBinding(context, signer)
    if (binding.expectedAddress !== signer) {
      throw new Error('Ledger Dash account export does not match the active account')
    }
    const scope = {
      keyDomainId: context.chainAccount.scope.keyDomainId,
      accountId: context.chainAccount.scope.accountId,
      chainId: context.chainAccount.scope.chainId
    }
    const response = await requestLedgerSignature(
      {
        kind: 'dash-psbt',
        chainId,
        accountPath: binding.accountPath,
        xpub: binding.xpub,
        expectedAddress: binding.expectedAddress,
        psbtBase64
      },
      {
        scope,
        payloadFingerprint: pending.review.payloadFingerprint,
        expiresAt: pending.review.expiresAt,
        summary: pending.review.summary,
        onTabOpened: resolveTab,
        validate: async () => {
          const latest = await loadActiveDashDiscoveryContext(storageRepository, chainId)
          if (
            !latest ||
            latest.generationId !== context.generationId ||
            latest.chainAccount.id !== context.chainAccount.id ||
            latest.chainAccount.scope.keyDomainId !== scope.keyDomainId ||
            latest.chainAccount.scope.accountId !== scope.accountId ||
            latest.chainAccount.scope.chainId !== scope.chainId ||
            latest.accountIndex !== context.accountIndex ||
            latest.keyDomainSource.kind !== 'hardware' ||
            latest.keyDomainSource.vendor !== 'ledger'
          ) {
            throw new Error('Ledger Dash account changed before signing')
          }
          const latestBinding = await loadLedgerDashAccountBinding(latest, signer)
          if (
            latestBinding.accountPath !== binding.accountPath ||
            latestBinding.xpub !== binding.xpub ||
            latestBinding.expectedAddress !== binding.expectedAddress
          ) {
            throw new Error('Ledger Dash account changed before signing')
          }
        }
      }
    )
    if (response.kind !== 'dash-psbt') {
      throw new Error('Ledger Dash signer returned the wrong response')
    }
    resolveTab()
    await controller.submitLedgerSignature(
      handoff.transactionId,
      handoff.payloadFingerprint,
      response.signedTransactionHex
    )
    return true
  } catch (error) {
    await controller.reject(handoff.transactionId).catch(() => {})
    rejectTab(failure(error))
    return false
  }
}
