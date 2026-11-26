/**
 * Sample data for the extension demo. Prices, balances, addresses and activity are all made up,
 * only to demonstrate the UI. Addresses are only ever shown truncated and no QR code that scans
 * to an address is generated, so nobody can send real money to them.
 */
import { IMG } from '../content'

export type Domain = 'shield' | 'public' | 'incognito'
export type TokenId = 'ETH' | 'USDC' | 'USDT' | 'ZEC' | 'BNB'
/** Where an asset lives: a chain in Public / Incognito accounts, a privacy provider in Shield. */
export type Place = 'ethereum' | 'base' | 'bnb' | 'arbitrum' | 'zcash' | 'near' | 'zshield'
/** Key of a holding, e.g. "USDC@base". */
export type Pos = `${TokenId}@${Place}`

const EXT = '/images/home/'

export const TOKENS: Record<
  TokenId,
  { name: string; icon: string; price: number; change: number; digits: number }
> = {
  ETH: { name: 'Ethereum', icon: IMG.eth, price: 3280, change: -1.84, digits: 4 },
  USDC: { name: 'USD Coin', icon: IMG.usdc, price: 1, change: 0.01, digits: 2 },
  USDT: { name: 'Tether', icon: IMG.usdt, price: 1, change: -0.01, digits: 2 },
  ZEC: { name: 'Zcash', icon: IMG.zecCoin, price: 52.8, change: 4.12, digits: 4 },
  BNB: { name: 'BNB', icon: IMG.bnbChip, price: 612.4, change: -0.62, digits: 4 }
}

export const PLACES: Record<Place, { name: string; icon: string; provider?: boolean }> = {
  ethereum: { name: 'Ethereum', icon: IMG.ethChip },
  base: { name: 'Base', icon: `${EXT}base.svg` },
  bnb: { name: 'BNB Chain', icon: IMG.bnbChip },
  arbitrum: { name: 'Arbitrum', icon: IMG.arbChip },
  zcash: { name: 'Zcash', icon: `${EXT}zcash-chain.svg` },
  near: { name: 'NEAR Confidential', icon: `${EXT}near-confidential.svg`, provider: true },
  zshield: { name: 'Zcash Shield', icon: `${EXT}zcash-shield.svg`, provider: true }
}

export const CHAINS: Place[] = ['ethereum', 'base', 'bnb', 'arbitrum', 'zcash']
export const EVM_ICONS = `${EXT}evm-group.svg`

export const pos = (token: TokenId, place: Place) => `${token}@${place}` as Pos
export const split = (key: Pos) => key.split('@') as [TokenId, Place]

/** Tokens selectable in each account: Shield ones sit under a provider; Incognito is EVM-only. */
export const CATALOG: Record<Domain, Pos[]> = {
  shield: ['ETH@near', 'USDC@near', 'USDT@near', 'ZEC@near', 'ZEC@zshield'],
  public: [
    'ETH@ethereum',
    'USDC@base',
    'USDT@bnb',
    'BNB@bnb',
    'ZEC@zcash',
    'USDC@ethereum',
    'USDC@arbitrum',
    'ETH@base'
  ],
  incognito: ['ETH@ethereum', 'USDC@base', 'USDT@bnb', 'BNB@bnb', 'USDC@ethereum']
}

/**
 * Holdings in Public that can be shielded in one click (those with a provider route). The
 * Shield button shown on hover in the token list and the "available to shield" line on the
 * Shield card are both based on it.
 */
export const SHIELDABLE: Pos[] = [
  'ZEC@zcash',
  'ETH@ethereum',
  'USDC@base',
  'USDT@bnb',
  'USDC@ethereum',
  'USDC@arbitrum',
  'ETH@base'
]

export type Holdings = Record<Domain, Partial<Record<Pos, number>>>

export const START_HOLDINGS: Holdings = {
  shield: { 'ETH@near': 0.42, 'USDC@near': 1250, 'ZEC@zshield': 24.5 },
  public: {
    'ETH@ethereum': 1.2,
    'USDC@base': 2400,
    'USDT@bnb': 850,
    'BNB@bnb': 1.4,
    'ZEC@zcash': 6,
    'USDC@arbitrum': 0.42,
    'ETH@base': 0.00012
  },
  incognito: {}
}

/** Addresses of the demo account, in truncated form only. */
export const ADDRESS = {
  public: '0x7a3F…9c2E',
  incognito: '0x4Eb9…D68b',
  transparent: 't1Vac…A4AH',
  shielded: 'u1x8q…7mm4',
  near: '0x5c1D…E07a'
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const HEX = '0123456789abcdefABCDEF'

function seedOf(text: string) {
  let hash = 2166136261
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return hash >>> 0
}

function pick(seed: number, alphabet: string, length: number) {
  let state = seed
  let out = ''
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0
    out += alphabet[(state >>> 8) % alphabet.length]
  }
  return out
}

/**
 * A set of demo addresses per account (also truncated only). Account 1 uses fixed values; the
 * others are derived from the account id, so they stay the same when switching back and forth.
 */
export function addressFor(id: string, kind: keyof typeof ADDRESS) {
  if (id === 'a1') return ADDRESS[kind]
  const seed = seedOf(`${id}:${kind}`)
  if (kind === 'transparent') return `t1${pick(seed, B58, 3)}…${pick(seed + 7, B58, 4)}`
  if (kind === 'shielded')
    return `u1${pick(seed, B58.toLowerCase(), 3)}…${pick(seed + 7, B58.toLowerCase(), 4)}`
  return `0x${pick(seed, HEX, 4)}…${pick(seed + 7, HEX, 4)}`
}

export type Recipient = { name: string; addr: string; kind: 'evm' | 'zcash' }

export const RECIPIENTS: Recipient[] = [
  { name: 'Maya', addr: '0x5413…58dc1', kind: 'evm' },
  { name: 'Cold storage', addr: '0x91Ac…0f3B', kind: 'evm' },
  { name: 'Leo', addr: 'u1qe4…9fxk', kind: 'zcash' },
  { name: 'Studio payroll', addr: 'zs1k8…3m2d', kind: 'zcash' }
]

export type ActivityKind =
  | 'send'
  | 'receive'
  | 'shield'
  | 'unshield'
  | 'swap'
  | 'deposit'
  | 'withdraw'

export type Activity = {
  id: string
  kind: ActivityKind
  from: Domain
  to: Domain
  token: TokenId
  place: Place
  amount: number
  toToken: TokenId
  toPlace: Place
  toAmount: number
  peer: string
  when: string
  fee: string
  /**
   * Transactions created in the demo carry the details from when they were submitted, and show
   * them as-is when the item is opened.
   */
  fresh?: boolean
  time?: string
  provider?: string
  network?: string
  fromLabel?: string
  toLabel?: string
  route?: 'cluster' | 'direct'
}

const past = (
  id: string,
  kind: ActivityKind,
  from: Domain,
  to: Domain,
  token: TokenId,
  place: Place,
  amount: number,
  peer: string,
  when: string,
  fee: string,
  swapTo?: [TokenId, number]
): Activity => ({
  id,
  kind,
  from,
  to,
  token,
  place,
  amount,
  toToken: swapTo?.[0] ?? token,
  toPlace: kind === 'shield' ? (token === 'ZEC' ? 'zshield' : 'near') : place,
  toAmount: swapTo?.[1] ?? amount,
  peer,
  when,
  fee
})

export const START_ACTIVITY: Activity[] = [
  past(
    'a1',
    'shield',
    'public',
    'shield',
    'ZEC',
    'zcash',
    10,
    'Zcash Shield',
    '2d ago',
    '0.00015 ZEC'
  ),
  past('a2', 'receive', 'public', 'public', 'USDC', 'base', 2400, '0x2b77…e41C', '3d ago', '—'),
  past(
    'a3',
    'swap',
    'shield',
    'shield',
    'ETH',
    'near',
    0.2,
    'NEAR Confidential',
    '5d ago',
    '$0.21',
    ['USDC', 653.9]
  ),
  past('a4', 'send', 'public', 'public', 'ETH', 'ethereum', 0.15, '0x91Ac…0f3B', '1w ago', '$0.42')
]

/* ---------- Accounts ---------- */

/**
 * The wallet's avatars are hosted on the official CDN (avatar_1 … avatar_43), the same set the
 * extension uses.
 */
const AVATAR_CDN = 'https://assets.zknoir.com/images'
export const avatarUrl = (n: number) => `${AVATAR_CDN}/avatar_${n}.webp`
/** Avatar numbers handed out in order to new accounts. No. 1 is the one Liam uses in the hero. */
export const AVATAR_ORDER = [1, 24, 12, 33, 7, 29, 16, 40, 2, 11, 26, 38]

export type AccountSeed = {
  name: string
  avatar: number
  incognito: boolean
  holdings: Holdings
  activity: Activity[]
}

/**
 * The two accounts the demo starts with: Account 1 is the main account; Account 2 holds small
 * amounts and already has Incognito enabled.
 */
export const START_ACCOUNTS: AccountSeed[] = [
  {
    name: 'Account 1',
    avatar: 1,
    incognito: false,
    holdings: START_HOLDINGS,
    activity: START_ACTIVITY
  },
  {
    name: 'Account 2',
    avatar: 24,
    incognito: true,
    holdings: {
      shield: { 'ZEC@zshield': 3.2, 'USDC@near': 180 },
      public: { 'USDC@base': 640, 'ETH@base': 0.08 },
      incognito: { 'USDC@base': 250 }
    },
    activity: [
      past(
        'b1',
        'deposit',
        'public',
        'incognito',
        'USDC',
        'base',
        250,
        'Account 2 · Incognito',
        '4d ago',
        '$0.84'
      ),
      past(
        'b2',
        'receive',
        'shield',
        'shield',
        'ZEC',
        'zshield',
        3.2,
        'Shielded sender',
        '1w ago',
        '—'
      )
    ]
  }
]

export const EMPTY_HOLDINGS: Holdings = { shield: {}, public: {}, incognito: {} }

/* ---------- Networks in settings ---------- */

export type NetworkInfo = {
  id: string
  name: string
  icon: string
  chainId: string
  currency: string
  rpc: string
  explorer: string
  custom?: boolean
}

export const NETWORKS: NetworkInfo[] = [
  {
    id: 'zcash',
    name: 'Zcash',
    icon: `${EXT}zcash-chain.svg`,
    chainId: 'Mainnet',
    currency: 'ZEC',
    rpc: 'Auto',
    explorer: 'Default'
  },
  {
    id: 'ethereum',
    name: 'Ethereum',
    icon: IMG.ethChip,
    chainId: '1',
    currency: 'ETH',
    rpc: 'Auto · thirdweb',
    explorer: 'Etherscan · etherscan.io'
  },
  {
    id: 'arbitrum',
    name: 'Arbitrum',
    icon: IMG.arbChip,
    chainId: '42161',
    currency: 'ETH',
    rpc: 'Auto',
    explorer: 'Arbiscan · arbiscan.io'
  },
  {
    id: 'bnb',
    name: 'BNB Chain',
    icon: IMG.bnbChip,
    chainId: '56',
    currency: 'BNB',
    rpc: 'Auto',
    explorer: 'BscScan · bscscan.com'
  },
  {
    id: 'base',
    name: 'Base',
    icon: `${EXT}base.svg`,
    chainId: '8453',
    currency: 'ETH',
    rpc: 'Auto',
    explorer: 'Basescan · basescan.org'
  },
  {
    id: 'polygon',
    name: 'Polygon',
    icon: 'https://assets.zknoir.com/chain/polygon.svg',
    chainId: '137',
    currency: 'POL',
    rpc: 'Auto',
    explorer: 'Polygonscan · polygonscan.com'
  }
]

export const SOCIAL = [
  { label: 'GitHub', url: __WALLET_REPOSITORY_URL__ },
  { label: 'X', url: 'https://x.com/noir_wallet' },
  { label: 'Telegram', url: 'https://t.me/noirprivacy' }
]

export const DAPPS = [
  { name: 'Noir', tag: 'Lending', url: 'app.zknoir.com/lending', icon: IMG.logo },
  { name: 'Noir', tag: 'Perp', url: 'app.zknoir.com/perps', icon: IMG.logo },
  { name: 'AAVE', tag: 'Lending', url: 'app.aave.com', icon: IMG.aave }
]

export const PROVIDER_COPY = {
  near: {
    title: 'NEAR Confidential Intents',
    body: 'Confidential Intents processes transfers and swaps on a private NEAR shard. Your balance and transaction details stay out of public view.'
  },
  zshield: {
    title: 'Zcash Shield',
    body: 'Shielding moves your ZEC into Zcash’s shielded pool. Transfers within the pool keep both wallet addresses and the amount private.'
  }
}

/* ---------- Formatting ---------- */

export const usd = (value: number) =>
  `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export const amountText = (value: number, token: TokenId) => {
  const digits = TOKENS[token].digits
  const shown = value.toLocaleString('en-US', { maximumFractionDigits: digits })
  return `${shown === '-0' ? '0' : shown} ${token}`
}

export const priceText = (token: TokenId) => {
  const price = TOKENS[token].price
  return price < 10 ? `$${price.toFixed(4)}` : usd(price)
}

export const changeText = (change: number) => `${change > 0 ? '+' : ''}${change.toFixed(2)}%`

export const valueOf = (book: Partial<Record<Pos, number>>) =>
  Object.entries(book).reduce(
    (sum, [key, amount]) => sum + (amount ?? 0) * TOKENS[split(key as Pos)[0]].price,
    0
  )

/** Price curve: a fixed random walk per token and range, so switching ranges changes the shape. */
export function priceSeries(token: TokenId, range: string, points = 48) {
  let seed = [...`${token}${range}`].reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) >>> 0, 7)
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 2 ** 32
  }
  const drift = TOKENS[token].change / 100 / points
  const swing = token === 'USDC' || token === 'USDT' ? 0.0006 : 0.012
  const out: number[] = []
  let value = 1
  for (let index = 0; index < points; index += 1) {
    value *= 1 + drift + (rand() - 0.5) * swing
    out.push(value)
  }
  return out
}
