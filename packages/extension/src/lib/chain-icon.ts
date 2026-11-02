import { formatConfiguredChainIconUrl, isDynamicEvmChainIcon } from '@/config/icons'

const EVM_CHAIN_ICON_CATALOG_URL = 'https://api.llama.fi/chains'
const EVM_CHAIN_ICON_BASE_URL = 'https://icons.llamao.fi/icons/chains'

export function createEvmChainIconResolver(fetcher: typeof fetch = fetch) {
  let catalog: Promise<ReadonlyMap<string, string>> | undefined

  return async (chainId: string): Promise<string | undefined> => {
    if (!isDynamicEvmChainIcon(chainId)) return undefined
    if (!catalog) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5_000)
      catalog = fetcher(EVM_CHAIN_ICON_CATALOG_URL, {
        signal: controller.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer'
      })
        .then(async response => {
          if (!response.ok) throw new Error('Chain icon catalog unavailable')
          const value: unknown = await response.json()
          if (!Array.isArray(value)) throw new Error('Invalid chain icon catalog')
          const icons = new Map<string, string>()
          for (const entry of value) {
            if (!entry || typeof entry !== 'object') continue
            const { chainId: id, name } = entry as Record<string, unknown>
            if (typeof id !== 'number' && typeof id !== 'string') continue
            const key = `eip155:${id}`
            if (
              !isDynamicEvmChainIcon(key) ||
              typeof name !== 'string' ||
              name.trim().length === 0 ||
              name.length > 100
            )
              continue
            icons.set(
              key,
              `${EVM_CHAIN_ICON_BASE_URL}/rsz_${encodeURIComponent(name.trim().toLowerCase())}.jpg`
            )
          }
          return icons
        })
        .catch(() => {
          catalog = undefined
          return new Map<string, string>()
        })
        .finally(() => clearTimeout(timeout))
    }
    return (await catalog).get(chainId)
  }
}

export const resolveRemoteEvmChainIconUrl = createEvmChainIconResolver()

export function formatChainIconUrl(chain: string): string {
  return formatConfiguredChainIconUrl(chain)
}

export function resolveChainIconAlias(family: string, displayName: string): string {
  if (family === 'zcash') return 'zec'
  if (family === 'bitcoin') return 'btc'
  if (family !== 'evm') return family

  const normalized = displayName.toLowerCase()
  if (normalized.includes('arbitrum')) return 'arbitrum'
  if (normalized.includes('base')) return 'base'
  if (normalized.includes('bnb') || normalized.includes('bsc')) return 'bsc'
  if (normalized.includes('optimism') || normalized.startsWith('op ')) return 'optimism'
  if (normalized.includes('polygon')) return 'polygon'
  if (normalized.includes('avalanche')) return 'avax'
  if (normalized.includes('monad')) return 'monad'
  if (normalized.includes('gnosis')) return 'gnosis'
  if (normalized.includes('plasma')) return 'plasma'
  if (normalized.includes('x layer') || normalized.includes('xlayer')) return 'xlayer'
  if (normalized.includes('berachain') || normalized.includes('bera')) return 'bera'
  return 'eth'
}
