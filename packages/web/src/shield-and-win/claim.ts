const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]+$/

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
 * Outer whitespace is ignored. Mainnet transparent addresses start with t1
 * and testnet transparent addresses start with tm.
 */
export function isTransparentZcashAddress(value: string): boolean {
  if (typeof value !== 'string') return false
  const address = value.trim()
  if (address.length < 26 || address.length > 40) return false
  if (!address.startsWith('t1') && !address.startsWith('tm')) return false
  if (/\s/.test(address)) return false
  return BASE58_ADDRESS.test(address)
}
