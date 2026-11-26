/**
 * Copy and image assets for the home page. The copy follows the design mock, and the wallet
 * screenshots are images exported from it.
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
  shieldGlyph: `${DIR}imgGroup1948763176.svg`
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
   * Send Privately: home screen with the Send / Receive buttons called out (the callout extends
   * left past the phone frame).
   */
  send: { src: `${DIR}send-privately.webp`, width: 464, height: 667, frame: { x: 79, y: 10 } },
  /** Receive Privately: receiving address screen; the QR code and the address are blurred. */
  receive: {
    src: `${DIR}receive-privately.webp`,
    width: 395,
    height: 667,
    frame: { x: 10, y: 10 }
  },
  /**
   * Shield & Unshield: Public account, with the ZEC row and its one-click Shield button called
   * out (the callout extends past both sides of the phone frame).
   */
  shieldToken: { src: `${DIR}shield-token.webp`, width: 558, height: 754, frame: { x: 96, y: 30 } }
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
  /**
   * Wallet + DApp page + the connecting line between them, 1000 × 716.5 overall (the wallet takes
   * the left 355).
   */
  defi: { src: `${DIR}defi-access.webp`, width: 1000, height: 716.5 },
  statue: { src: `${DIR}statue.webp`, width: 2294, height: 1106 }
} as const

export type TransferTab = {
  id: 'send' | 'receive'
  title: string
  body: string
  shot: keyof typeof PHONES
  alt: string
}

export const TRANSFER_TABS: TransferTab[] = [
  {
    id: 'send',
    title: 'Send Privately',
    body: 'Send tokens in seconds without revealing who sent what to whom.',
    shot: 'send',
    alt: 'Noir Wallet home on the Shield account, $4,489.21 across privacy providers, with the Send and Receive buttons called out.'
  },
  {
    id: 'receive',
    title: 'Receive Privately',
    body: 'Receive tokens on a shielded address that hides your balance and identity.',
    shot: 'receive',
    alt: 'Receiving Address screen for ZEC on a NEAR Confidential address: send at least $2 of ZEC. The QR code and the one-time address are blurred.'
  }
]

export const SHIELD_POINTS = [
  'One-click shield tokens',
  'Shield tokens from wallet',
  'Unshield tokens to wallet',
  'Integrate multiple shield providers'
]

/** Supported Shield Tools: the first two are integrated, the rest are coming soon. */
export const TOOLS: { name: string; icon: string; soon?: boolean }[] = [
  { name: 'Zcash Shield', icon: `${DIR}imgGroup1948762866.svg` },
  { name: 'Near Confidential', icon: `${DIR}imgImage1037.png` },
  { name: 'Railgun', icon: `${DIR}imgGroup1948763189.svg`, soon: true },
  { name: 'Privacy Pool', icon: `${DIR}imgGroup1948763187.svg`, soon: true },
  { name: 'ZAMA', icon: `${DIR}imgGroup1948763186.svg`, soon: true }
]

export const DEFI_LEAVES = ['Lending', 'Perps', 'Cash Out']
