import { CHAIN_BLOCK_EXPLORER_ALTERNATIVES } from '@/config/block-explorers'
import {
  findChainEndpointOverride,
  withChainExplorer,
  type ChainEndpointSettings,
  type CustomChainExplorer
} from '@/core/chains/chain-endpoint-settings'
import type { ExplorerChainOption } from './chain-settings-options'

export function isSameExplorer(
  first: Pick<CustomChainExplorer, 'baseUrl' | 'transactionPath'>,
  second: Pick<CustomChainExplorer, 'baseUrl' | 'transactionPath'>
): boolean {
  return (
    first.baseUrl.replace(/\/+$/, '') === second.baseUrl.replace(/\/+$/, '') &&
    first.transactionPath === second.transactionPath
  )
}

function explorerName(baseUrl: string): string {
  const hostname = new URL(baseUrl).hostname
  if (hostname === 'mempool.space') return 'mempool.space'
  if (hostname === 'solscan.io') return 'Solscan'
  if (hostname === 'nearblocks.io' || hostname === 'testnet.nearblocks.io') return 'NearBlocks'
  if (hostname.endsWith('.blockscout.com')) return 'Blockscout'
  if (hostname === 'etherscan.io' || hostname.endsWith('.etherscan.io')) return 'Etherscan'
  const brand = hostname.replace(/^(www\.|testnet\.|sepolia\.|amoy\.)/, '').split('.')[0]
  return brand.charAt(0).toUpperCase() + brand.slice(1)
}

export function getExplorerPresets(option: ExplorerChainOption): readonly CustomChainExplorer[] {
  const presets: CustomChainExplorer[] = [...(option.presets ?? [])]
  if (option.defaultUrl && !presets.some(preset => isDefaultExplorer(option, preset))) {
    presets.unshift({
      label: explorerName(option.defaultUrl),
      baseUrl: option.defaultUrl,
      transactionPath: option.defaultTransactionPath
    })
  }
  for (const preset of CHAIN_BLOCK_EXPLORER_ALTERNATIVES[option.chainId] ?? []) {
    if (!presets.some(existing => isSameExplorer(existing, preset))) presets.push(preset)
  }
  return presets
}

export function getExplorerSelection(settings: ChainEndpointSettings, option: ExplorerChainOption) {
  const presets = getExplorerPresets(option)
  const selected = findChainEndpointOverride(settings, option.chainId)?.explorer
  const custom =
    selected && !presets.some(preset => isSameExplorer(preset, selected)) ? selected : undefined
  return { presets, selected, custom }
}

export function isDefaultExplorer(
  option: ExplorerChainOption,
  explorer: CustomChainExplorer
): boolean {
  return isSameExplorer(explorer, {
    baseUrl: option.defaultUrl,
    transactionPath: option.defaultTransactionPath
  })
}

export function buildExplorerSelectionSettings(
  settings: ChainEndpointSettings,
  option: ExplorerChainOption,
  explorer: CustomChainExplorer
): ChainEndpointSettings {
  return withChainExplorer(
    settings,
    option.chainId,
    isDefaultExplorer(option, explorer)
      ? undefined
      : {
          label: explorer.label,
          baseUrl: explorer.baseUrl,
          transactionPath: explorer.transactionPath
        }
  )
}

export function buildCustomExplorer(
  option: ExplorerChainOption,
  name: string,
  baseUrl: string,
  transactionPath: string
): CustomChainExplorer {
  return {
    label: name.trim() || `Custom ${option.label}`.slice(0, 64),
    baseUrl: baseUrl.trim(),
    transactionPath: transactionPath.trim()
  }
}
