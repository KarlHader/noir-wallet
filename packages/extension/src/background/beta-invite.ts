import { BETA_INVITE_ACTIVATION_STORAGE_KEY } from '@/config/beta-invite'
import { getEvmNetworkConfigs, getSolanaNetworkConfig } from '@/config/networks'
import {
  BetaInviteActivationCoordinator,
  BetaInviteError,
  selectBetaInviteTarget
} from '@/core/wallet/beta-invite'
import { accountContextTransition } from '@/background/account-context-transition'
import { IndexedDbStorageV2Repository } from '@/infrastructure/persistence/repositories'
import { bindBetaInviteCode, checkBetaInviteCode } from '@/infrastructure/wallet/beta-invite-api'
import { initializeRuntimeNetwork } from '@/lib/runtime-network'

declare const __BETA_INVITE_REQUIRED__: boolean

const repository = new IndexedDbStorageV2Repository()

export const betaInviteActivation = new BetaInviteActivationCoordinator({
  required: __BETA_INVITE_REQUIRED__,
  readState: async () => {
    const stored = await chrome.storage.local.get(BETA_INVITE_ACTIVATION_STORAGE_KEY)
    return stored[BETA_INVITE_ACTIVATION_STORAGE_KEY]
  },
  writeState: state => chrome.storage.local.set({ [BETA_INVITE_ACTIVATION_STORAGE_KEY]: state }),
  checkCode: checkBetaInviteCode,
  bindCode: bindBetaInviteCode,
  resolveTarget: () =>
    accountContextTransition.runActiveOperation(async () => {
      const network = await initializeRuntimeNetwork()
      const pointer = await repository.getActivePointer()
      if (!pointer) return null
      const snapshot = await repository.getSnapshot(pointer.generationId)
      if (
        !snapshot ||
        snapshot.manifest.status !== 'verified' ||
        snapshot.manifest.generationId !== pointer.generationId ||
        snapshot.manifest.sourceFingerprint !== pointer.sourceFingerprint
      ) {
        throw new BetaInviteError('wallet-not-ready')
      }
      return selectBetaInviteTarget(snapshot, network, {
        evmChainIds: getEvmNetworkConfigs(network).map(config => config.chainId),
        solanaChainId: getSolanaNetworkConfig(network === 'mainnet' ? 'mainnet' : 'devnet').chainId
      })
    })
})
