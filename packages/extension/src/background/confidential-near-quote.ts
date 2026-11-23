import { isAddress } from 'viem'
import { nearConfidentialPortfolioAssetId } from '@/core/chains/near/near-portfolio-assets'
import { parseNearAccountId } from '@/core/chains/near/identifiers'

export const NEAR_CONFIDENTIAL_PROTOCOL_ASSET_ID = 'nep141:wrap.near'
export const NEAR_CONFIDENTIAL_CHAIN_ASSET_ID = 'near:mainnet/slip44:397'
export const NEAR_CONFIDENTIAL_DEPOSIT_MODE = 'SIMPLE'
const NEAR_DEPOSIT_ADDRESS = /^[0-9a-f]{64}$/

export function isNearConfidentialProtocolAsset(assetId: string): boolean {
  return assetId === NEAR_CONFIDENTIAL_PROTOCOL_ASSET_ID
}

/** Real NEAR-chain nep141 ids. Bridge omft and omdep assets stay on their origin chain. */
export function isNearChainConfidentialProtocolAsset(assetId: string): boolean {
  return nearConfidentialPortfolioAssetId(assetId) !== null
}

export function assertNearConfidentialDepositAddress(value: string): string {
  if (!NEAR_DEPOSIT_ADDRESS.test(value)) {
    throw new Error('NEAR Shield deposit address is invalid')
  }
  return value
}

function canonicalNearAccount(value: string): string | null {
  try {
    const accountId = parseNearAccountId(value)
    return accountId === value ? accountId : null
  } catch {
    return null
  }
}

function lowercaseEvmAddress(value: string): string {
  return isAddress(value) ? value.toLowerCase() : value
}

// NEAR-source quotes reject a checksummed confidential recipient. EVM-source
// quotes keep the address the caller supplied.
export function normalizeNearConfidentialQuote<
  T extends {
    readonly originAsset: string
    readonly recipient: string
    readonly refundTo?: string
    readonly recipientType: 'CONFIDENTIAL_INTENTS' | 'DESTINATION_CHAIN'
    readonly refundType: 'ORIGIN_CHAIN' | 'CONFIDENTIAL_INTENTS'
  }
>(input: T): T {
  if (!isNearChainConfidentialProtocolAsset(input.originAsset)) return input
  const recipient =
    input.recipientType === 'CONFIDENTIAL_INTENTS'
      ? lowercaseEvmAddress(input.recipient)
      : input.recipient
  let refundTo = input.refundTo === undefined ? undefined : lowercaseEvmAddress(input.refundTo)
  if (
    refundTo === undefined &&
    input.refundType === 'CONFIDENTIAL_INTENTS' &&
    input.recipientType === 'DESTINATION_CHAIN'
  ) {
    const accountId = canonicalNearAccount(recipient)
    if (accountId) refundTo = accountId
  }
  if (recipient === input.recipient && refundTo === input.refundTo) return input
  return {
    ...input,
    recipient,
    ...(refundTo === undefined ? {} : { refundTo })
  }
}
