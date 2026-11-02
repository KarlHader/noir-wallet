import dayjs from './dayjs'
import type { AddressType, WalletItem } from '@/types/wallet'
import {
  getBlockExplorerBaseUrl,
  getBlockExplorerTransactionPath
} from './block-explorer-preferences'
import { DEFAULT_NETWORK, getNetworkConfig } from '@/lib/runtime-network'
import { detectZcashAddressType } from './zcash-memo'

export function formatTimestamp(timestamp: string | number | Date, template?: string) {
  if (!dayjs(timestamp).isValid()) return ''
  return dayjs(timestamp).format(template || 'YYYY/MM/DD HH:mm')
}

export function formatSortAddress(address: string | undefined) {
  if (!address) return ''
  if (/[() ]/.test(address)) return address
  const maxLength = 12
  const isLongAddress = address.length > maxLength
  return isLongAddress ? `${address.slice(0, 6)}...${address.slice(-6)}` : address
}

export function formatAccountName(name: string | undefined, maxLength: number = 16) {
  if (!name) return ''
  if (name.length <= maxLength) return name
  return `${name.slice(0, maxLength - 3)}...`
}

export function getAccountDisplayName(
  walletId: string,
  accountId: string,
  wasmName: string,
  displayNames: Record<string, string>
): string {
  const key = `${walletId}_${accountId}`

  if (displayNames[key]) {
    return displayNames[key]
  }

  const match = wasmName.match(/^Account_(\d+)_\d+$/)
  if (match) {
    const index = parseInt(match[1], 10)
    return `Account ${index + 1}`
  }

  return wasmName
}

export function formatChainName(blockchain: string): string {
  const labels: Record<string, string> = {
    near: 'NEAR',
    eth: 'Ethereum',
    ethereum: 'Ethereum',
    evm: 'Ethereum',
    arb: 'Arbitrum',
    base: 'Base',
    op: 'Optimism',
    bsc: 'BNB Chain',
    arbitrum: 'Arbitrum',
    pol: 'Polygon',
    polygon: 'Polygon',
    optimism: 'Optimism',
    avax: 'Avalanche',
    avalanche: 'Avalanche',
    sol: 'Solana',
    solana: 'Solana',
    btc: 'Bitcoin',
    bitcoin: 'Bitcoin',
    bera: 'Berachain',
    berachain: 'Berachain',
    gnosis: 'Gnosis',
    monad: 'Monad',
    plasma: 'Plasma',
    xlayer: 'X Layer',
    zec: 'Zcash',
    zcash: 'Zcash'
  }
  const normalizedBlockchain = blockchain.toLowerCase()
  return labels[normalizedBlockchain] || blockchain
}

export function formatSymbol(symbol?: string) {
  switch (symbol) {
    case 'wNEAR':
      return 'NEAR'
    default:
      return symbol || ''
  }
}

const explorerUrls: Record<string, string> = {
  near: 'https://nearblocks.io',
  solana: 'https://solscan.io',
  zcash: getBlockExplorerBaseUrl('zcash'),
  bitcoin: 'https://mempool.space',
  ethereum: 'https://etherscan.io',
  bsc: 'https://bscscan.com',
  arbitrum: 'https://arbiscan.io',
  base: 'https://basescan.org',
  optimism: 'https://optimistic.etherscan.io',
  polygon: 'https://polygonscan.com',
  avalanche: 'https://snowtrace.io',
  berachain: 'https://berascan.com',
  gnosis: 'https://gnosisscan.io',
  monad: 'https://monadscan.com',
  plasma: 'https://plasmascan.to',
  xlayer: 'https://www.okx.com/web3/explorer/xlayer'
}
const explorerPaths: Record<string, Record<string, string>> = {
  near: {
    transaction: 'txns',
    account: 'address',
    token: 'token'
  },
  solana: {
    transaction: 'tx',
    account: 'account',
    token: 'token'
  },
  zcash: {
    transaction: getBlockExplorerTransactionPath('zcash'),
    account: 'address',
    token: 'ua' // generic, zcash doesn't have standard "tokens" in explorer same way
  },
  bitcoin: {
    transaction: 'tx',
    account: 'address',
    token: ''
  },
  ethereum: {
    transaction: 'tx',
    account: 'address',
    token: 'token'
  },
  bsc: {
    transaction: 'tx',
    account: 'address',
    token: 'token'
  },
  arbitrum: {
    transaction: 'tx',
    account: 'address',
    token: 'token'
  },
  base: {
    transaction: 'tx',
    account: 'address',
    token: 'token'
  },
  optimism: {
    transaction: 'tx',
    account: 'address',
    token: 'token'
  },
  polygon: {
    transaction: 'tx',
    account: 'address',
    token: 'token'
  },
  avalanche: {
    transaction: 'tx',
    account: 'address',
    token: 'token'
  },
  berachain: {
    transaction: 'tx',
    account: 'address',
    token: 'token'
  },
  gnosis: {
    transaction: 'tx',
    account: 'address',
    token: 'token'
  },
  monad: {
    transaction: 'tx',
    account: 'address',
    token: 'token'
  },
  plasma: {
    transaction: 'tx',
    account: 'address',
    token: 'token'
  },
  xlayer: {
    transaction: 'tx',
    account: 'address',
    token: 'token'
  }
}

export function formatExplorerUrl(
  chain: string,
  val: string,
  type: 'transaction' | 'account' | 'token' = 'transaction'
) {
  if (chain === 'zcash' && DEFAULT_NETWORK === 'testnet') {
    const testnetPath = type === 'transaction' ? 'tx' : type === 'account' ? 'address' : 'token'
    return `${getNetworkConfig('testnet').explorerUrl}/${testnetPath}/${val}`
  }

  const explorerUrl = chain === 'zcash' ? getBlockExplorerBaseUrl('zcash') : explorerUrls[chain]
  if (!explorerUrl) return ''
  const explorerPath =
    chain === 'zcash' && type === 'transaction'
      ? getBlockExplorerTransactionPath('zcash')
      : explorerPaths[chain]?.[type]

  let params = ''
  if (chain === 'solana') {
    params = '?cluster=mainnet-beta'
  }

  return `${explorerUrl}/${explorerPath}/${val}${params}`
}

const assetChainMap: Record<string, string> = {
  zec: 'zcash',
  zcash: 'zcash',
  near: 'near',
  eth: 'ethereum',
  sol: 'solana',
  btc: 'bitcoin',
  bsc: 'bsc',
  arb: 'arbitrum',
  base: 'base',
  op: 'optimism',
  pol: 'polygon',
  avax: 'avalanche',
  bera: 'berachain',
  gnosis: 'gnosis',
  monad: 'monad',
  plasma: 'plasma',
  xlayer: 'xlayer'
}

/**
 * Extracts chain name from intents asset ID (fallback, prefer using token.blockchain directly)
 */
export function getChainFromAssetId(assetId: string): string {
  if (!assetId) return ''
  const parts = assetId.split(':')
  if (parts[0] === '1cs_v1' && parts.length >= 3) {
    return assetChainMap[parts[1]] || parts[1]
  }
  if (parts[0] === 'nep245') {
    const chainId = /^([0-9]+)_/.exec(parts.slice(2).join(':'))?.[1]
    const byEvmChainId: Record<string, string> = {
      '10': 'optimism',
      '56': 'bsc',
      '100': 'gnosis',
      '137': 'polygon',
      '143': 'monad',
      '196': 'xlayer',
      '9745': 'plasma',
      '80094': 'berachain',
      '43114': 'avalanche'
    }
    if (chainId && byEvmChainId[chainId]) return byEvmChainId[chainId]
  }
  if (parts[0] === 'nep141' || parts[0] === 'nep245') {
    const tokenId = parts[1] || ''
    if (tokenId.startsWith('zec.')) return 'zcash'
    const prefix = tokenId.split(/[.-]/)[0]
    if (prefix && assetChainMap[prefix]) return assetChainMap[prefix]
    if (tokenId.endsWith('.near')) return 'near'
  }
  return assetChainMap[parts[0]] || parts[0]
}

export function formatWalletName(
  wallet: { id: string; name: string },
  allWallets: { id: string; name: string }[]
): string {
  const walletIndex = allWallets.findIndex(w => w.id === wallet.id)
  return formatWalletNameAtIndex(wallet.name, walletIndex)
}

export function formatWalletBackupName(
  wallet: WalletItem,
  allWallets: WalletItem[],
  displayNames: Record<string, string>
): string {
  const primary = wallet.accounts.find(account => account.derivationIndex === 0)
  if (!primary) return formatWalletName(wallet, allWallets)
  const customName = displayNames[`${wallet.id}_${primary.id}`]?.trim()
  return (
    customName ||
    formatSortAddress(primary.addresses.shielded || primary.addresses.transparent) ||
    formatWalletName(wallet, allWallets)
  )
}

export function formatWalletNameAtIndex(walletName: string, walletIndex: number): string {
  return walletIndex >= 0 && isGeneratedWalletTimestampName(walletName)
    ? `Wallet ${walletIndex + 1}`
    : walletName
}

export function isGeneratedWalletTimestampName(walletName: string): boolean {
  return /^Wallet \d{13,}$/.test(walletName)
}

export function detectAddressType(address: string): AddressType {
  return detectZcashAddressType(address)
}
