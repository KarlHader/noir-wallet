import { parseChainAccountId, type ChainAccountId } from '@/core/accounts/domain'
import {
  parseKeyDomainId,
  parseVerificationAnchorRef,
  type CredentialEngine,
  type KeyDomainId,
  type VerificationAnchorRef
} from '@/core/keyring/domain'

const CHAIN_ACCOUNT_ANCHOR_PREFIX = 'chain-account:'
const KEY_DOMAIN_ANCHOR_PREFIX = 'key-domain:'

export function buildKeyDomainVerificationAnchorRef(
  keyDomainId: KeyDomainId,
  engine: CredentialEngine
): VerificationAnchorRef {
  if (engine !== 'zcash' && engine !== 'multichain') {
    throw new Error('Invalid credential engine')
  }
  return parseVerificationAnchorRef(
    `${KEY_DOMAIN_ANCHOR_PREFIX}${encodeURIComponent(keyDomainId)}:${engine}`
  )
}

export function parseKeyDomainVerificationAnchorRef(value: VerificationAnchorRef): {
  keyDomainId: KeyDomainId
  engine: CredentialEngine
} {
  if (!value.startsWith(KEY_DOMAIN_ANCHOR_PREFIX)) {
    throw new Error('Verification anchor does not reference a KeyDomain')
  }
  const suffix = value.slice(KEY_DOMAIN_ANCHOR_PREFIX.length)
  const delimiter = suffix.lastIndexOf(':')
  if (delimiter < 1) throw new Error('KeyDomain verification anchor is incomplete')
  const engine = suffix.slice(delimiter + 1)
  if (engine !== 'zcash' && engine !== 'multichain') {
    throw new Error('Invalid credential engine')
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(suffix.slice(0, delimiter))
  } catch {
    throw new Error('Verification anchor contains invalid encoding')
  }
  const keyDomainId = parseKeyDomainId(decoded)
  if (buildKeyDomainVerificationAnchorRef(keyDomainId, engine) !== value) {
    throw new Error('Verification anchor is not canonical')
  }
  return { keyDomainId, engine }
}

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
