const providerNames = new Map<string, string>([
  ['bitget', 'Bitget'],
  ['okx', 'OKX'],
  ['binance', 'Binance'],
  ['1inch', '1inch'],
  ['one-inch', '1inch'],
  ['paraswap', 'ParaSwap'],
  ['kodiak', 'Kodiak'],
  ['openocean', 'OpenOcean'],
  ['cow', 'CoW'],
  ['zerox', 'Robinhood'],
  ['jupiter', 'Jupiter'],
  ['titan', 'Titan'],
  ['dflow', 'DFlow'],
  ['hyperion', 'Hyperion'],
  ['near-smart', 'SmartV1'],
  ['near-smartx', 'SmartV2'],
  ['nearintents', 'NEAR Intents'],
  ['near-intents', 'NEAR Intents'],
  ['preswap-nearintents', 'NEAR Intents'],
  ['rango', 'Rango'],
  ['lifi', 'LI.FI'],
  ['jumper', 'Jumper'],
  ['bungee', 'Bungee'],
  ['swapkit', 'SwapKit'],
  ['omnibridge', 'OmniBridge'],
  ['stableflow', 'StableFlow'],
  ['kyberswap', 'KyberSwap'],
  ['near-mca-withdraw', 'NEAR Intents'],
  ['near-confidential', 'NEAR Confidential Intents']
])

const rheaIconBase = 'https://img.rhea.finance/images/dex/'

// Rhea's CDN filenames are case-sensitive and some differ from the quote router ID.
const rheaIconSlugs = new Map<string, string>([
  ['one-inch', '1inch'],
  ['paraswap', 'velora'],
  ['cow', 'cowswap'],
  ['zerox', 'robinhood'],
  ['near-smart', 'rhea'],
  ['near-smartx', 'rhea'],
  ['nearintents', 'near-intents'],
  ['preswap-nearintents', 'near-intents'],
  ['near-mca-withdraw', 'near-intents'],
  ['omnibridge', 'omni'],
  ['kyberswap', 'kyberSwap']
])

export function isInternalSwapProvider(router: string): boolean {
  return /\brhea(?:\b|_|swap|finance)/i.test(router)
}

export function providerDisplayName(router: string): string {
  const name = router.trim()
  if (isInternalSwapProvider(name)) return 'Swap provider'
  return providerNames.get(name.toLowerCase()) ?? name
}

export function getRheaProviderIconUrl(router: string): string | undefined {
  const id = router.trim().toLowerCase()
  if (isInternalSwapProvider(id) || !/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(id)) return undefined
  if (id === 'dflow') return `${rheaIconBase}logo-dflow.svg`
  return `${rheaIconBase}logo-${rheaIconSlugs.get(id) ?? id}-simple.svg`
}
