import { parseChainAccountId, type ChainAccountId } from '@/core/accounts/domain'
import { parseVerificationAnchorRef, type VerificationAnchorRef } from '@/core/keyring/domain'

const CHAIN_ACCOUNT_ANCHOR_PREFIX = 'chain-account:'

export function buildChainAccountVerificationAnchorRef(
  chainAccountId: ChainAccountId
): VerificationAnchorRef {
  return parseVerificationAnchorRef(
    `${CHAIN_ACCOUNT_ANCHOR_PREFIX}${encodeURIComponent(chainAccountId)}`
  )
}

export function parseChainAccountVerificationAnchorRef(
  value: VerificationAnchorRef
): ChainAccountId {
  if (!value.startsWith(CHAIN_ACCOUNT_ANCHOR_PREFIX)) {
    throw new Error('Verification anchor does not reference a ChainAccount')
  }
  const encoded = value.slice(CHAIN_ACCOUNT_ANCHOR_PREFIX.length)
  let decoded: string
  try {
    decoded = decodeURIComponent(encoded)
  } catch {
    throw new Error('Verification anchor contains invalid encoding')
  }
  const chainAccountId = parseChainAccountId(decoded)
  if (buildChainAccountVerificationAnchorRef(chainAccountId) !== value) {
    throw new Error('Verification anchor is not canonical')
  }
  return chainAccountId
}
