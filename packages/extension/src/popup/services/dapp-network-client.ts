import type {
  CurrentDAppEvmNetworkSelectionContext,
  CurrentDAppEvmNetworkState
} from '@/background/wallet-dapp-evm-networks'

export type { CurrentDAppEvmNetworkState }

export async function readCurrentDAppEvmNetworks(): Promise<CurrentDAppEvmNetworkState | null> {
  const response = await chrome.runtime.sendMessage({ type: 'GET_CURRENT_DAPP_EVM_NETWORKS' })
  if (!response || response.error || !('state' in response)) {
    throw new Error(response?.error || 'Unable to load site networks')
  }
  return response.state
}

export async function selectCurrentDAppEvmNetwork(
  chainId: string,
  selectionContext: CurrentDAppEvmNetworkSelectionContext
): Promise<CurrentDAppEvmNetworkState> {
  const response = await chrome.runtime.sendMessage({
    type: 'SET_CURRENT_DAPP_EVM_NETWORK',
    chainId,
    selectionContext
  })
  if (response?.success !== true || !response.state) {
    throw new Error(response?.error || 'Unable to switch site network')
  }
  return response.state
}
