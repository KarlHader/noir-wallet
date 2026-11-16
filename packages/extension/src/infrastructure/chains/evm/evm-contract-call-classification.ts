export type Erc20CalldataRequest =
  | { readonly kind: 'approve'; readonly spender: string; readonly amountRaw: string }
  | { readonly kind: 'transfer'; readonly recipient: string; readonly amountRaw: string }
  | {
      readonly kind: 'transferFrom'
      readonly sender: string
      readonly recipient: string
      readonly amountRaw: string
    }

const SELECTOR_ARGUMENTS: Readonly<Record<string, number>> = Object.freeze({
  '095ea7b3': 2,
  a9059cbb: 2,
  '23b872dd': 3
})

function decodeAddress(word: string): string | null {
  return /^0{24}[0-9a-f]{40}$/.test(word) ? `0x${word.slice(24)}` : null
}

export function decodeErc20CalldataRequest(value: string | undefined): Erc20CalldataRequest | null {
  if (!value || !/^0x(?:[0-9a-f]{2})+$/i.test(value)) return null
  const hex = value.slice(2).toLowerCase()
  const selector = hex.slice(0, 8)
  const argumentCount = SELECTOR_ARGUMENTS[selector]
  if (!argumentCount || hex.length !== 8 + argumentCount * 64) return null
  const words = Array.from({ length: argumentCount }, (_, index) =>
    hex.slice(8 + index * 64, 8 + (index + 1) * 64)
  )
  if (selector === '23b872dd') {
    const sender = decodeAddress(words[0]!)
    const recipient = decodeAddress(words[1]!)
    if (!sender || !recipient) return null
    return {
      kind: 'transferFrom',
      sender,
      recipient,
      amountRaw: BigInt(`0x${words[2]}`).toString()
    }
  }
  const address = decodeAddress(words[0]!)
  if (!address) return null
  const amountRaw = BigInt(`0x${words[1]}`).toString()
  return selector === '095ea7b3'
    ? { kind: 'approve', spender: address, amountRaw }
    : { kind: 'transfer', recipient: address, amountRaw }
}

export function isErc20ApproveCalldata(value: string | undefined): boolean {
  return decodeErc20CalldataRequest(value)?.kind === 'approve'
}
