import { addEvmNetwork, switchEvmChain, type EvmProvider } from '@noir-wallet/sdk'
import type { EvmNetworkExample } from './evm-network-catalog'

export async function switchToExampleEvmNetwork(
  provider: EvmProvider,
  network: EvmNetworkExample
): Promise<void> {
  try {
    await switchEvmChain(provider, network.request.chainId)
  } catch (error) {
    if (typeof error !== 'object' || error === null || Reflect.get(error, 'code') !== 4902) {
      throw error
    }
    await addEvmNetwork(provider, network.request)
    await switchEvmChain(provider, network.request.chainId)
  }
}
