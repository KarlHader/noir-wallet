import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { supportsEvmPrivateExecution } from '@/core/chains/evm'
import { getEvmNetworkConfig } from '@/config/networks'
import {
  DAppExecutionModeCoordinator,
  DAppExecutionModeRequestGate,
  type DAppExecutionModeRepository,
  type PersistedDAppExecutionModes
} from '@/core/dapp/dapp-execution-mode'
import { loadActiveEvmPortfolioContext } from '@/infrastructure/chains/evm'
import { IndexedDbStorageV2Repository } from '@/infrastructure/persistence/repositories'

const DAPP_EXECUTION_MODE_STORAGE_KEY = 'dapp_execution_modes_v1'

export class ChromeDAppExecutionModeRepository implements DAppExecutionModeRepository {
  async read(): Promise<unknown> {
    const stored = await chrome.storage.local.get(DAPP_EXECUTION_MODE_STORAGE_KEY)
    return stored[DAPP_EXECUTION_MODE_STORAGE_KEY]
  }

  async write(value: PersistedDAppExecutionModes): Promise<void> {
    await chrome.storage.local.set({ [DAPP_EXECUTION_MODE_STORAGE_KEY]: value })
  }

  async clear(): Promise<void> {
    await chrome.storage.local.remove(DAPP_EXECUTION_MODE_STORAGE_KEY)
  }
}

const storageRepository = new IndexedDbStorageV2Repository()

export const dappExecutionModeCoordinator = new DAppExecutionModeCoordinator(
  new ChromeDAppExecutionModeRepository(),
  {
    isAvailable: async scope => {
      if (scope.network !== DEFAULT_NETWORK) return false
      const context = await loadActiveEvmPortfolioContext(
        storageRepository,
        getEvmNetworkConfig(DEFAULT_NETWORK).chainId
      )
      return (
        context !== null &&
        supportsEvmPrivateExecution(context.keyDomainSource) &&
        context.chainAccount.scope.keyDomainId === scope.keyDomainId &&
        context.chainAccount.scope.accountId === scope.accountId
      )
    }
  }
)

export const dappExecutionModeRequestGate = new DAppExecutionModeRequestGate()
