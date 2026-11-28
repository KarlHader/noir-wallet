/** Mainnet t1/t3 and testnet tm/t2, matching the wallet's transparent address schemes. */
const TRANSPARENT_ZCASH_ADDRESS = /^(?:t1|t3|tm|t2)[a-km-zA-HJ-NP-Z1-9]{33}$/

export interface ClaimMessageInput {
  readonly entryId: number
  readonly walletAddress: string
  readonly zcashAddress: string
}

/**
 * Exact EIP-191 text. The signed bytes must match the claim body, including
 * address casing, and the text has no trailing newline.
 */
export function claimMessage(input: ClaimMessageInput): string {
  return [
    'Shield & Win Claim',
    `Entry ID: ${input.entryId}`,
    `Wallet: ${input.walletAddress}`,
    `Zcash Address: ${input.zcashAddress}`
  ].join('\n')
}

export function utf8ToHex(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let hex = '0x'
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

/**
 * Outer whitespace is ignored. Accepts mainnet and testnet transparent
 * addresses because this page does not know the wallet's network mode.
 * P2PKH is t1/tm and P2SH is t3/t2; each prefix is followed by 33 Base58 characters.
 */
export function isTransparentZcashAddress(value: string): boolean {
  if (typeof value !== 'string') return false
  return TRANSPARENT_ZCASH_ADDRESS.test(value.trim())
}
