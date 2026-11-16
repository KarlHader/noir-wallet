import type { ChainDefinition } from '@/core/chains/registry'
import type { AccountData, Network, WalletItem } from '@/types'

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

export function parseSelectedChainIds(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      chainId => typeof chainId !== 'string' || chainId.length === 0 || chainId.length > 128
    ) ||
    new Set(value).size !== value.length
  ) {
    throw new Error('Select at least one supported chain')
  }
  return Object.freeze([...value] as string[])
}

export function isAccountChainEnabled(
  account: AccountData,
  network: Network,
  family: AccountNetworkFamily,
  chainId: string
): boolean {
  if (!isAccountNetworkEnabled(account, network, family)) return false
  if (family === 'evm') return true
  const selected = account.networkChainSelections?.[network]
  return selected === undefined || parseSelectedChainIds(selected).includes(chainId)
}

export function isRetainedV1UpgradeAccount(
  wallet: WalletItem | null | undefined,
  account: AccountData | null | undefined,
  network: Network
): boolean {
  return Boolean(
    wallet &&
    account &&
    wallet.secretPhraseOrigin === undefined &&
    (wallet.keySource === undefined || wallet.keySource === 'software') &&
    account.networkSelections?.[network]
  )
}

export function isRetainedV1ZcashOnlyAccount(
  wallet: WalletItem | null | undefined,
  account: AccountData | null | undefined,
  network: Network
): boolean {
  const families = account?.networkSelections?.[network]
  return (
    isRetainedV1UpgradeAccount(wallet, account, network) &&
    families?.length === 1 &&
    families[0] === 'zcash'
  )
}
