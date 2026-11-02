import {
  parseChainEndpointSettings,
  parseCustomEvmNetwork,
  withCustomEvmNetwork,
  withoutCustomEvmNetwork,
  type ChainEndpointSettings
} from './chain-endpoint-settings'
import type { TransactionAccountScope } from '@/core/transactions/domain'
import type { TransactionRepository } from '@/ports/repositories'
import { parseChainId } from './registry'

export function assertChainEndpointSettingsUnchanged(
  current: ChainEndpointSettings,
  expected: unknown
): void {
  if (JSON.stringify(current) !== JSON.stringify(parseChainEndpointSettings(expected))) {
    throw new Error('Network settings changed. Reopen the settings page and try again.')
  }
}

export async function assertCustomEvmNetworksHaveNoPendingTransactions(
  chainIds: readonly string[],
  scopes: readonly TransactionAccountScope[],
  transactions: Pick<TransactionRepository, 'list'>
): Promise<void> {
  for (const chainId of chainIds.map(value => parseChainId(value).id)) {
    for (const scope of scopes) {
      const pending = await transactions.list({
        scope,
        chainId,
        statuses: ['signed', 'broadcast', 'confirming'],
        limit: 1
      })
      if (pending.length > 0) {
        throw new Error('Complete pending transactions before removing this network')
      }
    }
  }
}

/** Compare the reviewed definition while merging into the latest settings. */
export function saveCustomEvmNetworkSettings(
  settings: ChainEndpointSettings,
  value: unknown,
  expectedValue?: unknown
): ChainEndpointSettings {
  const network = parseCustomEvmNetwork(value)
  const expected = expectedValue === undefined ? undefined : parseCustomEvmNetwork(expectedValue)
  const current = settings.customEvmNetworks.find(item => item.chainId === network.chainId)
  if (expected === undefined) {
    if (current) throw new Error('This network already exists. Open it to edit its settings.')
  } else if (
    expected.chainId !== network.chainId ||
    JSON.stringify(current) !== JSON.stringify(expected)
  ) {
    throw new Error('Network settings changed. Reopen the network and try again.')
  }
  return withCustomEvmNetwork(settings, network)
}

export function removeCustomEvmNetworkSettings(
  settings: ChainEndpointSettings,
  value: unknown
): ChainEndpointSettings {
  const expected = parseCustomEvmNetwork(value)
  const current = settings.customEvmNetworks.find(item => item.chainId === expected.chainId)
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new Error('Network settings changed. Reopen the network and try again.')
  }
  return withoutCustomEvmNetwork(settings, expected.chainId)
}
