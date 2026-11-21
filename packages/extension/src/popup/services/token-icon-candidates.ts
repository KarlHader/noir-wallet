import type { SwapToken } from '@/core/services/intents-api'
import { MARKET_ASSETS } from '@/config/asset-market-assets'
import { findBundledWalletMarketAssetId, isBundledWalletAsset } from './token-display-policy'

interface TokenIconCandidateInput {
  readonly token?: Pick<SwapToken, 'blockchain' | 'contractAddress' | 'icon' | 'coingeckoIcon'>
  readonly icon?: string
  readonly assetId?: string
  readonly symbol?: string
  readonly blockchain?: string
  readonly nativeChain?: string
  readonly bundledIcon?: string
  readonly contractIcon?: string
}

const customTokenIcons: Readonly<Record<string, string>> = Object.freeze({
  [MARKET_ASSETS.eth]: 'https://assets.zknoir.com/chain/ethereum.svg'
})

export function formatTokenIcon({
  assetId,
  token,
  symbol,
  icon
}: Pick<TokenIconCandidateInput, 'assetId' | 'token' | 'symbol' | 'icon'>): string | undefined {
  const marketAsset = isBundledEthIconIdentity(assetId, token, symbol)
    ? MARKET_ASSETS.eth
    : assetId
      ? findBundledWalletMarketAssetId(assetId)
      : null
  return (marketAsset ? customTokenIcons[marketAsset] : undefined) ?? icon
}

const nativeAssetIconUrls: Readonly<Record<string, string>> = Object.freeze({
  [MARKET_ASSETS.bnb]:
    'https://coin-images.coingecko.com/coins/images/825/large/bnb-icon2_2x.png?1696501970',
  [MARKET_ASSETS.pol]:
    'https://coin-images.coingecko.com/coins/images/32440/large/pol.png?1759114181',
  [MARKET_ASSETS.avax]:
    'https://coin-images.coingecko.com/coins/images/12559/large/Avalanche_Circle_RedWhite_Trans.png?1696512369',
  [MARKET_ASSETS.mon]:
    'https://coin-images.coingecko.com/coins/images/38927/large/mon.png?1766029057',
  [MARKET_ASSETS.xdai]:
    'https://coin-images.coingecko.com/coins/images/11062/large/Identity-Primary-DarkBG.png?1696511004',
  [MARKET_ASSETS.xpl]:
    'https://coin-images.coingecko.com/coins/images/66489/large/Plasma-symbol-green-1.png?1755142558',
  [MARKET_ASSETS.okb]:
    'https://coin-images.coingecko.com/coins/images/4463/large/WeChat_Image_20220118095654.png?1696505053',
  [MARKET_ASSETS.bera]:
    'https://coin-images.coingecko.com/coins/images/25235/large/BERA.png?1738822008',
  [MARKET_ASSETS.btc]:
    'https://coin-images.coingecko.com/coins/images/1/large/bitcoin.png?1696501400',
  [MARKET_ASSETS.sol]:
    'https://coin-images.coingecko.com/coins/images/4128/large/solana.png?1718769756',
  [MARKET_ASSETS.near]:
    'https://coin-images.coingecko.com/coins/images/10365/large/near.jpg?1696510367'
})

function getBundledNativeIconFallback(
  assetId: string | undefined,
  token?: Pick<SwapToken, 'contractAddress'>
): string | undefined {
  if (!assetId || (token !== undefined && token.contractAddress != null)) return undefined
  if (!(isBundledWalletAsset(assetId) && assetId.includes('/slip44:')) && !token) {
    return undefined
  }
  const marketAsset = findBundledWalletMarketAssetId(assetId)
  return marketAsset ? nativeAssetIconUrls[marketAsset] : undefined
}

export function isBundledEthIconIdentity(
  assetId: string | undefined,
  token?: Pick<SwapToken, 'contractAddress'>,
  symbol?: string
): boolean {
  if (!assetId) return false
  if (/^eip155:[1-9][0-9]*\/slip44:60$/.test(assetId)) {
    return (
      (token === undefined || token.contractAddress == null) &&
      (findBundledWalletMarketAssetId(assetId) === MARKET_ASSETS.eth ||
        symbol?.toUpperCase() === 'ETH')
    )
  }
  return (
    findBundledWalletMarketAssetId(assetId) === MARKET_ASSETS.eth &&
    token?.contractAddress == null &&
    token !== undefined
  )
}

function isCoinGeckoIconUrl(value: string | undefined): boolean {
  if (!value) return false
  try {
    return new URL(value).hostname === 'coin-images.coingecko.com'
  } catch {
    return false
  }
}

function isPublicIpfsIconUrl(value: string | undefined): boolean {
  if (!value) return false
  try {
    const url = new URL(value)
    return (
      url.protocol === 'ipfs:' ||
      url.pathname.toLowerCase().includes('/ipfs/') ||
      url.hostname === 'ipfs.io' ||
      url.hostname.startsWith('ipfs.') ||
      url.hostname.includes('.ipfs.') ||
      url.hostname === 'cloudflare-ipfs.com' ||
      url.hostname === 'dweb.link' ||
      url.hostname === 'gateway.pinata.cloud' ||
      url.hostname === 'nftstorage.link'
    )
  } catch {
    return false
  }
}

function isRetiredIconSource(value: string, depth = 0): boolean {
  if (depth > 3) return true
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    if (host === 'trustwallet.com' || host.endsWith('.trustwallet.com')) return true
    if (
      ['github.com', 'raw.githubusercontent.com', 'cdn.jsdelivr.net'].includes(host) &&
      /(?:^|\/)trustwallet\/assets(?:@|\/|$)/i.test(url.pathname)
    )
      return true
    // Previously cached history icons can wrap the original URL in our proxy.
    const source = url.searchParams.get('source')
    return source ? isRetiredIconSource(source, depth + 1) : false
  } catch {
    return false
  }
}

function isOnlineIconUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

export function getTokenIconCandidates({
  token,
  icon,
  assetId,
  symbol,
  bundledIcon,
  contractIcon
}: TokenIconCandidateInput): readonly string[] {
  const providerIcon = isPublicIpfsIconUrl(token?.icon ?? undefined) ? undefined : token?.icon
  const metadataIcon = isCoinGeckoIconUrl(icon) || isPublicIpfsIconUrl(icon) ? undefined : icon
  const coinGeckoIcon = isCoinGeckoIconUrl(icon) ? icon : token?.coingeckoIcon
  const nativeIcon = getBundledNativeIconFallback(assetId, token)
  const preferredNativeIcon =
    assetId && findBundledWalletMarketAssetId(assetId) === MARKET_ASSETS.avax
      ? nativeIcon
      : undefined
  const candidates = [
    formatTokenIcon({ assetId, token, symbol }),
    bundledIcon,
    preferredNativeIcon,
    providerIcon,
    metadataIcon,
    coinGeckoIcon,
    isCoinGeckoIconUrl(contractIcon) ? contractIcon : undefined,
    nativeIcon
  ]

  return Object.freeze(
    candidates.filter(
      (candidate, index): candidate is string =>
        typeof candidate === 'string' &&
        candidate.length > 0 &&
        isOnlineIconUrl(candidate) &&
        !isRetiredIconSource(candidate) &&
        candidates.indexOf(candidate) === index
    )
  )
}
