import type { ChainDefinition } from '@/core/chains/registry'
import type { AccountData, Network } from '@/types'
import { isFrostAccount } from '@/core/accounts/domain/account-source'

export type AccountNetworkFamily = ChainDefinition['family']

const FAMILIES = new Set<AccountNetworkFamily>([
  'zcash',
  'evm',
  'bitcoin',
  'solana',
  'tron',
  'near'
])

export function parseSelectedNetworkFamilies(value: unknown): readonly AccountNetworkFamily[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(family => !FAMILIES.has(family)) ||
    new Set(value).size !== value.length
  ) {
    throw new Error('Select at least one supported network')
  }
  return Object.freeze([...value] as AccountNetworkFamily[])
}

export function getDefaultImportNetworkFamilies(
  wordCount: 12 | 24,
  availableFamilies: readonly AccountNetworkFamily[]
): readonly AccountNetworkFamily[] {
  if (wordCount !== 12 && wordCount !== 24) throw new Error('Invalid recovery phrase length')
  const available = parseSelectedNetworkFamilies(availableFamilies)
  return Object.freeze(
    wordCount === 12 ? available.filter(family => family !== 'zcash') : [...available]
  )
}

export function isAccountNetworkEnabled(
  account: AccountData,
  network: Network,
  family: AccountNetworkFamily
): boolean {
  if (!FAMILIES.has(family)) throw new Error('Unsupported network family')
  if (isFrostAccount(account)) return account.source.network === network && family === 'zcash'
  const selections = account.networkSelections
  if (selections === undefined) return true
  if (
    typeof selections !== 'object' ||
    selections === null ||
    Array.isArray(selections) ||
    Object.keys(selections).some(key => key !== 'mainnet' && key !== 'testnet')
  ) {
    throw new Error('Invalid account network selection')
  }
  if (!Object.prototype.hasOwnProperty.call(selections, network)) {
    return true
  }
  return parseSelectedNetworkFamilies(selections[network]).includes(family)
}
