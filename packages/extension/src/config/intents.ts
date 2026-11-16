import type { Network } from '@/types'

export interface ConfidentialFundingNetworkConfig {
  readonly oneClickApiUrl: string
  readonly oneClickDirectApiUrl: string
  readonly rheaSwapApiUrl: string
}

function parseServiceUrl(value: string, label: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(`${label} must be an absolute URL`)
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must be a credential-free HTTPS URL without query or fragment`)
  }
  return trimmed
}

export function getConfidentialFundingNetworkConfig(
  network: Network
): ConfidentialFundingNetworkConfig | null {
  if (network !== 'mainnet') return null
  return Object.freeze({
    oneClickApiUrl: parseServiceUrl(
      __CONFIDENTIAL_ONE_CLICK_API_URL__ || 'https://api.rhea.finance/proxy/1click/v0',
      'Confidential Mainnet 1Click URL'
    ),
    oneClickDirectApiUrl: 'https://1click.chaindefuser.com/v0',
    rheaSwapApiUrl: 'https://api.rhea.finance'
  })
}

/** ZEC Intents asset ID from the multichain token list. */
export const ZEC_ZCASH_ASSET = 'nep141:zec.omft.near'

/** Native NEAR (wrapped) intents asset — the canonical default swap-to token. */
export const WNEAR_NEAR_ASSET = 'nep141:wrap.near'

/**
 * Intents app fee entry. `fee` is in basis points (100 = 1%).
 * Note: 1Click applies a 50/50 revenue share by default, so half of `fee`
 * reaches the recipient and half goes to the 1Click protocol.
 */
export interface IntentsAppFee {
  recipient: string
  fee: number
}

/** Swap app fee: 0.35% (35 bps), collected to noir's swap account. */
export const NOIR_SWAP_APP_FEES: IntentsAppFee[] = [{ recipient: 'noir_swap.near', fee: 35 }]
export const NOIR_SWAP_REFERRAL = 'noir_swap'
export const NOIR_MOVE_REFERRAL = 'noir_move'
export const NOIR_SEND_REFERRAL = 'noir_send'
export const NOIR_RECEIVE_REFERRAL = 'noir_receive'

export type NoirIntentsReferral =
  | typeof NOIR_SWAP_REFERRAL
  | typeof NOIR_MOVE_REFERRAL
  | typeof NOIR_SEND_REFERRAL
  | typeof NOIR_RECEIVE_REFERRAL
