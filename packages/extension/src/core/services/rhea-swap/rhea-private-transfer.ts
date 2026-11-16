import type { RheaSwapToken } from './rhea-swap-model'

export function resolveRheaPrivateTransferToken(
  tokens: readonly RheaSwapToken[],
  contractAddress: string | null
): RheaSwapToken | null {
  if (contractAddress === null) return tokens.find(token => token.isNative) ?? null
  const normalized = contractAddress.toLowerCase()
  return (
    tokens.find(token => !token.isNative && token.contractAddress?.toLowerCase() === normalized) ??
    null
  )
}
