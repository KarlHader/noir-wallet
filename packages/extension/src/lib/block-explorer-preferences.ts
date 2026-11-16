import {
  BLOCK_EXPLORER_GROUPS,
  DEFAULT_BLOCK_EXPLORER_PREFERENCES,
  type BlockExplorerChain,
  type BlockExplorerOption,
  type BlockExplorerPreferences
} from '@/config/block-explorers'

const blockExplorerOptionsByChain = BLOCK_EXPLORER_GROUPS.reduce(
  (acc, group) => {
    acc[group.chain] = group.options
    return acc
  },
  {} as Record<BlockExplorerChain, BlockExplorerOption[]>
)

let activeBlockExplorerPreferences: BlockExplorerPreferences = {
  ...DEFAULT_BLOCK_EXPLORER_PREFERENCES
}

export function setActiveBlockExplorerPreferences(preferences?: Partial<BlockExplorerPreferences>) {
  activeBlockExplorerPreferences = {
    ...DEFAULT_BLOCK_EXPLORER_PREFERENCES,
    ...preferences
  }
}

export function getBlockExplorerBaseUrl(chain: BlockExplorerChain): string {
  return getActiveBlockExplorerOption(chain)?.baseUrl || ''
}

export function getBlockExplorerTransactionPath(chain: BlockExplorerChain): string {
  return getActiveBlockExplorerOption(chain)?.transactionPath || ''
}

function getActiveBlockExplorerOption(chain: BlockExplorerChain): BlockExplorerOption | undefined {
  const selectedId =
    activeBlockExplorerPreferences[chain] || DEFAULT_BLOCK_EXPLORER_PREFERENCES[chain]
  const selectedOption = blockExplorerOptionsByChain[chain]?.find(
    option => option.id === selectedId
  )
  const defaultOption = blockExplorerOptionsByChain[chain]?.find(
    option => option.id === DEFAULT_BLOCK_EXPLORER_PREFERENCES[chain]
  )

  return selectedOption || defaultOption
}
