import {
  parseChainEndpointSettings,
  type ChainEndpointSettings,
  type CustomEvmNetwork
} from '@/core/chains/chain-endpoint-settings'
import { resolveEvmNetworkCatalog } from '@/core/chains/evm-runtime-config'
import { getEvmNetworkConfigs } from '@/config/networks'
import { resolveEvmChainIconAlias } from '@/config/icons'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { Eip1193ProviderError, type ParsedEip1193ChainRequest } from '@/core/dapp/eip1193'

export interface EvmDAppNetworkSwitchOptions {
  readonly readSettings: () => Promise<ChainEndpointSettings>
  readonly commitActiveChain: (chainId: string, origin: string) => Promise<void>
  readonly commitCustomNetwork: (network: CustomEvmNetwork, origin: string) => Promise<void>
  readonly validateRequest?: () => Promise<void>
  readonly requestApproval: (
    origin: string,
    action: 'evmNetwork',
    data: Readonly<{
      action: 'switch' | 'add'
      chainId: `eip155:${number}`
      chainName: string
      iconChain: string
      nativeCurrency?: CustomEvmNetwork['nativeCurrency']
      rpcUrl?: string
      explorerUrl?: string
    }>
  ) => Promise<{ readonly approved: boolean }>
}

export async function handleEvmDAppNetworkSwitch(
  requested: ParsedEip1193ChainRequest,
  origin: string,
  action: 'switch' | 'add',
  options: EvmDAppNetworkSwitchOptions
): Promise<void> {
  const requestedChainId = `eip155:${requested.numericChainId}` as const
  const current = await options.readSettings()
  const configuredNetwork = resolveEvmNetworkCatalog(DEFAULT_NETWORK, current).find(
    network => network.chainId === requestedChainId
  )
  if (action === 'add') {
    if (configuredNetwork) return
    if (
      getEvmNetworkConfigs(DEFAULT_NETWORK === 'mainnet' ? 'testnet' : 'mainnet').some(
        network => network.chainId === requestedChainId
      )
    ) {
      throw new Eip1193ProviderError(4901, 'This chain belongs to the other network mode.')
    }
    if (!requested.metadata) {
      throw new Eip1193ProviderError(-32602, 'Chain name, currency, and RPC URL are required.')
    }
    const metadata = requested.metadata
    let network: CustomEvmNetwork
    try {
      network = parseChainEndpointSettings({
        ...current,
        customEvmNetworks: [
          ...current.customEvmNetworks,
          {
            chainId: requestedChainId,
            numericChainId: requested.numericChainId,
            displayName: metadata.chainName,
            nativeCurrency: metadata.nativeCurrency,
            rpc: {
              protocol: 'evm-json-rpc',
              label: metadata.chainName,
              url: metadata.rpcUrls[0]
            },
            ...(metadata.blockExplorerUrls[0] === undefined
              ? {}
              : {
                  explorer: {
                    label: metadata.chainName,
                    baseUrl: metadata.blockExplorerUrls[0],
                    transactionPath: 'tx'
                  }
                })
          }
        ]
      }).customEvmNetworks.at(-1)!
    } catch (error) {
      throw new Eip1193ProviderError(
        -32602,
        error instanceof Error ? error.message : 'Invalid EVM network metadata.'
      )
    }
    const decision = await options.requestApproval(origin, 'evmNetwork', {
      action: 'add',
      chainId: requestedChainId,
      chainName: network.displayName,
      iconChain: resolveEvmChainIconAlias(requestedChainId),
      nativeCurrency: network.nativeCurrency,
      rpcUrl: network.rpc.url,
      ...(network.explorer === undefined ? {} : { explorerUrl: network.explorer.baseUrl })
    })
    if (!decision.approved) {
      throw new Eip1193ProviderError(4001, 'User rejected the network request.')
    }
    await options.validateRequest?.()
    await options.commitCustomNetwork(network, origin)
    return
  }
  if (!configuredNetwork) {
    throw new Eip1193ProviderError(4902, 'The requested EVM chain is not configured.')
  }

  const decision = await options.requestApproval(origin, 'evmNetwork', {
    action: 'switch',
    chainId: requestedChainId,
    chainName: configuredNetwork.displayName,
    iconChain: configuredNetwork.iconChain
  })
  if (!decision.approved) {
    throw new Eip1193ProviderError(4001, 'User rejected the network request.')
  }

  await options.validateRequest?.()
  await options.commitActiveChain(requestedChainId, origin)
}
