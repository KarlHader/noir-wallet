import {
  getBitcoinNetworkConfig,
  getNearNetworkConfig,
  getSolanaNetworkConfig
} from '@/config/networks'
import { CHAIN_BLOCK_EXPLORER_ALTERNATIVES } from '@/config/block-explorers'
import {
  getBlockExplorerBaseUrl,
  getBlockExplorerTransactionPath
} from '@/lib/block-explorer-preferences'
import {
  findChainEndpointOverride,
  getActiveChainEndpointSettings
} from '@/core/chains/chain-endpoint-settings'
import { resolveEvmNetworkCatalog } from '@/core/chains/evm-runtime-config'
import { getNetworkConfig } from '@/lib/runtime-network'
import { getBitcoinChainId, getZcashChainId } from '@/core/chains/registry'
import type { Network } from '@/types'
import { isSameExplorer } from './explorer-settings-model'

export interface ChainExplorerTarget {
  readonly baseUrl: string
  readonly transactionPath: string
  readonly addressPath?: string
  readonly tokenPath?: string
}

export function resolveChainExplorerTarget(
  chainId: string,
  network: Network
): ChainExplorerTarget | null {
  const settings = getActiveChainEndpointSettings()
  const custom = findChainEndpointOverride(settings, chainId)?.explorer
  const solana = getSolanaNetworkConfig(network === 'mainnet' ? 'mainnet' : 'devnet')
  if (custom) {
    const preset = CHAIN_BLOCK_EXPLORER_ALTERNATIVES[chainId]?.find(explorer =>
      isSameExplorer(explorer, custom)
    )
    return Object.freeze({
      baseUrl:
        preset && chainId === solana.chainId && network === 'testnet'
          ? `${custom.baseUrl}?cluster=devnet`
          : custom.baseUrl,
      transactionPath: custom.transactionPath,
      ...(preset?.addressPath ? { addressPath: preset.addressPath } : {}),
      ...(preset && chainId.startsWith('eip155:') ? { tokenPath: 'token' } : {})
    })
  }
  if (chainId === getZcashChainId(network)) {
    return network === 'mainnet'
      ? Object.freeze({
          baseUrl: getBlockExplorerBaseUrl('zcash'),
          transactionPath: getBlockExplorerTransactionPath('zcash')
        })
      : Object.freeze({ baseUrl: getNetworkConfig(network).explorerUrl, transactionPath: 'tx' })
  }
  if (chainId === getBitcoinChainId(network)) {
    return Object.freeze({
      baseUrl: getBitcoinNetworkConfig(network).explorerUrl,
      transactionPath: 'tx'
    })
  }
  if (chainId === solana.chainId) {
    return Object.freeze({
      baseUrl: solana.explorerUrl,
      transactionPath: 'tx',
      addressPath: 'account'
    })
  }
  const near = getNearNetworkConfig(network)
  if (chainId === near.chainId) {
    return Object.freeze({ baseUrl: near.explorerUrl, transactionPath: 'txns' })
  }
  const evm = resolveEvmNetworkCatalog(network, settings).find(config => config.chainId === chainId)
  return evm?.explorerUrl
    ? Object.freeze({ baseUrl: evm.explorerUrl, transactionPath: 'tx', tokenPath: 'token' })
    : null
}

function explorerLink(target: ChainExplorerTarget, path: string, identifier: string): string {
  const url = new URL(target.baseUrl)
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${path}/${encodeURIComponent(identifier)}`
  return url.toString()
}

export function formatChainTransactionExplorerUrl(
  chainId: string,
  transactionHash: string,
  network: Network
): string {
  const target = resolveChainExplorerTarget(chainId, network)
  return target ? explorerLink(target, target.transactionPath, transactionHash) : ''
}

export function formatChainAddressExplorerUrl(
  chainId: string,
  address: string,
  network: Network
): string {
  const target = resolveChainExplorerTarget(chainId, network)
  return target ? explorerLink(target, target.addressPath ?? 'address', address) : ''
}

export function formatChainAssetExplorerUrl(
  chainId: string,
  asset: Readonly<{ kind: 'native' | 'token'; namespace: string; reference: string }>,
  network: Network
): string {
  const target = resolveChainExplorerTarget(chainId, network)
  if (!target) return ''
  return target.tokenPath && asset.kind === 'token' && asset.namespace === 'erc20'
    ? explorerLink(target, target.tokenPath, asset.reference)
    : target.baseUrl
}
