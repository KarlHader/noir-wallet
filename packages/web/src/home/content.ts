/**
 * Copy and image assets for the home page. The copy follows the design mock (Figma "Noir
 * Landingpage", the November 27 version), and the wallet screenshots are images exported from it.
 */
import type { CSSProperties } from 'react'

const DIR = '/images/home/'

export const IMG = {
  logo: `${DIR}imgNoirLogo1.jpg`,
  // Token and chain icons used in the extension demo ("Try the extension")
  usdt: `${DIR}imgImage4.png`,
  usdc: `${DIR}imgImage3.png`,
  eth: `${DIR}imgImage1049.png`,
  zecCoin: `${DIR}imgGroup1948762978.svg`,
  aave: `${DIR}imgImage1045.png`,
  ethChip: `${DIR}imgImage902.png`,
  arbChip: `${DIR}imgGroup1948761781.svg`,
  bnbChip: `${DIR}imgGroup1948761777.svg`,
  // Shield glyph in the middle of How Noir Wallet Works
  shieldGlyph: `${DIR}imgGroup1948763176.svg`,
  // Hardware wallet marks, the same files the extension uses
  ledger: `${DIR}ledger.svg`,
  keystone: `${DIR}keystone.png`,
  // "Backed by" band: the YZi Labs logo exported from the design mock (black, 150 × 36)
  yzi: `${DIR}yzi-labs.svg`
} as const

/** Width of the phone frame in the design mock (CSS px). */
export const PHONE_WIDTH = 375

/**
 * Wallet images exported from the design mock (2x, transparent background): they include
 * shadow padding on all sides, some have callouts that extend past the phone frame, and the
 * blurred fade-out at the bottom is already baked into the image. frame is the position of the
 * phone frame's top-left corner in the image (CSS px); the image is aligned to the phone frame
 * when placed on the page, see frameStyle.
 */
export type PhoneShot = {
  src: string
  width: number
  height: number
  frame: { x: number; y: number }
}

export const PHONES = {
  /** Hero: the Shield account home screen. */
  hero: { src: `${DIR}hero-wallet.webp`, width: 435, height: 754, frame: { x: 30, y: 30 } },
  /**
   * The same home screen with the Send / Receive buttons called out (the callout extends left
   * past the phone frame). The hero shows it on phones, and Key Features shows it first.
   */
  send: { src: `${DIR}send-privately.webp`, width: 464, height: 667, frame: { x: 79, y: 10 } }
} as const satisfies Record<string, PhoneShot>

/**
 * The container width is the phone frame width: scale the image up proportionally, then pull it
 * up and left by its padding so the phone frame lands exactly inside the container.
 */
export function frameStyle(shot: PhoneShot): CSSProperties {
  const k = 100 / PHONE_WIDTH
  return {
    width: `${shot.width * k}%`,
    maxWidth: 'none',
    marginLeft: `${-shot.frame.x * k}%`,
    marginTop: `${-shot.frame.y * k}%`
  }
}

export const SHOTS = {
  statue: { src: `${DIR}statue.webp`, width: 2294, height: 1106 }
} as const

/**
 * Key Features: the cards on the right, and the picture each one shows on the left. Pictures
 * are placed on the design mock's 434 × 647 stage: x and y are the image's top-left corner
 * relative to the stage (CSS px), w × h its size; clip cuts the image off at that height.
 */
export type FeatureLayer = {
  src: string
  x: number
  y: number
  w: number
  h: number
  clip?: number
  blur?: boolean
}

export type Feature = {
  id: 'transfer' | 'shield' | 'defi'
  title: string
  body: string
  alt: string
  layers: FeatureLayer[]
}

export const FEATURES: Feature[] = [
  {
    id: 'transfer',
    title: 'Send & Receive Privately',
    body: 'Send tokens in seconds without revealing who sent what to whom.',
    alt: 'Noir Wallet home on the Shield account, $4,489.21 across privacy providers, with the Send and Receive buttons called out.',
    layers: [{ src: PHONES.send.src, x: -20, y: -10, w: 464, h: 667 }]
  },
  {
    id: 'shield',
    title: 'Shield Funds Easily',
    body: 'Move funds in and out of your private balance in one click, across multiple privacy providers.',
    alt: 'Noir Wallet on the Public account, $1,406.56, with the ZEC row and its one-click Shield button called out.',
    layers: [{ src: `${DIR}shield-token.webp`, x: -37, y: -30, w: 558, h: 754, clip: 685 }]
  },
  {
    id: 'defi',
    title: 'Use Defi Privately',
    body: 'Smoothly switch private account to access DApps',
    alt: 'Noir Wallet on the Incognito account, $1,232.06, connected to app.aave.com, in front of the app it is connected to.',
    layers: [
      { src: `${DIR}defi-dapp.webp`, x: -11, y: 136, w: 510, h: 374, blur: true },
      { src: `${DIR}defi-wallet.webp`, x: 28, y: 19, w: 317, h: 549 }
    ]
  }
]

/** Supported privacy providers: the first two are integrated, the rest are coming soon. */
export const PROVIDERS: { name: string; icon: string; soon?: boolean }[] = [
  { name: 'Zcash Shield', icon: `${DIR}imgGroup1948762866.svg` },
  { name: 'Near Confidential', icon: `${DIR}imgImage1037.png` },
  { name: 'Railgun', icon: `${DIR}imgGroup1948763189.svg`, soon: true },
  { name: 'Privacy Pool', icon: `${DIR}imgGroup1948763187.svg`, soon: true },
  { name: 'ZAMA', icon: `${DIR}imgGroup1948763186.svg`, soon: true }
]

export const DEFI_LEAVES = ['Lending', 'Perps', 'Cash Out']

/** Choose How Visible Each Move Is: the three accounts every wallet has. */
export const ACCOUNTS: {
  id: 'public' | 'shield' | 'incognito'
  name: string
  intro: string
  detail: string
  who: string
  when: string
}[] = [
  {
    id: 'public',
    name: 'Public',
    intro: 'Receive at your usual address and make regular transfers.',
    detail: 'Your main account. Create it in Noir or import a wallet you already use.',
    who: 'Anyone who knows your address can look up its onchain activity.',
    when: 'You want to keep the address people already pay.'
  },
  {
    id: 'shield',
    name: 'Shield',
    intro: 'Hold funds privately, pay someone privately, or receive a private payment.',
    detail:
      'Your combined private balance across supported privacy rails, including the Zcash shielded pool and NEAR Confidential Intents.',
    who: 'Your balance stays inside the privacy rails that hold it.',
    when: 'Available routes depend on the asset and network.'
  },
  {
    id: 'incognito',
    name: 'Incognito',
    intro: 'Use DeFi without connecting your main address.',
    detail: 'A separate address derived from the same recovery phrase and funded through Shield.',
    who: 'Apps see your Incognito address. Funding through Shield avoids a direct onchain link to Public.',
    when: 'Activity across apps on one Incognito address can be viewed together.'
  }
]

/** Ledger Supported: three steps, each with its own icon. */
export const HARDWARE_STEPS: {
  icon: 'usb' | 'shield' | 'transfer'
  title: string
  body: string
}[] = [
  {
    icon: 'usb',
    title: 'Connect Your Ledger',
    body: 'Add wallet by clicking [Connect a hardware wallet], connect your ledger and select networks.'
  },
  {
    icon: 'shield',
    title: 'Shield Funds',
    body: 'Choose your available assets and move it into Shield wallet.'
  },
  {
    icon: 'transfer',
    title: 'Transfer Privately',
    body: 'You can always use ledger to initiate private transactions from your shield wallet when you need.'
  }
]

/** BlockSec's signed audit report of the Zcash wallet WASM (June 2026). */
const AUDIT_REPORT_URL =
  'https://github.com/blocksecteam/audit-reports/blob/main/rust/blocksec_noirwallet_zcash_wallet_wasm_signed_20260609.pdf'

/** Your Key Open Code: four points, each with a large, blurred icon on the right. */
export const TRUST_POINTS: {
  icon: 'custody' | 'backup' | 'audit' | 'code'
  title: string
  body: string
  link?: { label: string; href: string }
}[] = [
  {
    icon: 'custody',
    title: 'Self-Custody',
    body: 'Your keys stay with you. Noir never holds your funds or recovery phrase.'
  },
  {
    icon: 'backup',
    title: 'One Backup',
    body: 'Incognito is derived from the same recovery phrase using HDwallet technology, so there is no second phrase to store.'
  },
  {
    icon: 'audit',
    title: 'Audited',
    body: 'Noir has been independently audited.',
    link: { label: 'Read the audit report', href: AUDIT_REPORT_URL }
  },
  {
    icon: 'code',
    title: 'Open Source',
    body: 'The code is public, so anyone can check what the wallet does.',
    link: { label: 'View on GitHub', href: __WALLET_REPOSITORY_URL__ }
  }
]

/** Footer links, in the design mock's order. */
export const SOCIAL: { name: 'x' | 'telegram' | 'github'; label: string; href: string }[] = [
  { name: 'x', label: 'Noir Wallet on X', href: 'https://x.com/noir_wallet' },
  { name: 'telegram', label: 'Noir Wallet on Telegram', href: 'https://t.me/noirprivacy' },
  { name: 'github', label: 'Noir Wallet on GitHub', href: __WALLET_REPOSITORY_URL__ }
]
