import {
  parseAccount,
  parseAccountId,
  parseAddressId,
  parseChainAccountId,
  type Account,
  type Address,
  type ChainAccount
} from '@/core/accounts/domain'
import { parseChainId } from '@/core/chains/registry'
import { parseKeyDomain, parseKeyDomainId, type KeyDomain } from '@/core/keyring/domain'
import {
  assertStorageV2ExactKeys,
  isStorageV2Record,
  parseStorageV2Derivation,
  parseStorageV2String,
  parseStorageV2Timestamp
} from './storage-v2-validation-helpers'

const ADDRESS_PURPOSES = new Set(['identity', 'receive', 'change'])
const ADDRESS_PRIVACY = new Set(['transparent', 'shielded', 'mixed'])
const ADDRESS_COMPATIBILITY = new Set(['broad', 'limited'])
const IDENTITY_KINDS = new Set(['public-key', 'account-identifier'])

export function parseStorageV2KeyDomain(value: unknown): KeyDomain {
  return parseKeyDomain(value)
}

export function parseStorageV2Account(value: unknown): Account {
  return parseAccount(value)
}

export function parseStorageV2ChainAccount(value: unknown): ChainAccount {
  if (
    !isStorageV2Record(value) ||
    !isStorageV2Record(value.scope) ||
    !isStorageV2Record(value.identity)
  ) {
    throw new Error('Invalid Storage V2 ChainAccount')
  }
  assertStorageV2ExactKeys(value, ['id', 'scope', 'derivation', 'identity', 'createdAt'])
  assertStorageV2ExactKeys(value.scope, ['keyDomainId', 'accountId', 'chainId'])
  assertStorageV2ExactKeys(value.identity, ['kind', 'value'])
  if (typeof value.identity.kind !== 'string' || !IDENTITY_KINDS.has(value.identity.kind)) {
    throw new Error('Invalid ChainAccount identity kind')
  }
  return Object.freeze({
    id: parseChainAccountId(parseStorageV2String(value.id, 'ChainAccount.id', 512)),
    scope: Object.freeze({
      keyDomainId: parseKeyDomainId(
        parseStorageV2String(value.scope.keyDomainId, 'ChainAccount.scope.keyDomainId', 512)
      ),
      accountId: parseAccountId(
        parseStorageV2String(value.scope.accountId, 'ChainAccount.scope.accountId', 512)
      ),
      chainId: parseChainId(
        parseStorageV2String(value.scope.chainId, 'ChainAccount.scope.chainId', 64)
      ).id
    }),
    derivation: parseStorageV2Derivation(value.derivation),
    identity: Object.freeze({
      kind: value.identity.kind as 'public-key' | 'account-identifier',
      value: parseStorageV2String(value.identity.value, 'ChainAccount.identity.value', 4_096)
    }),
    createdAt: parseStorageV2Timestamp(value.createdAt, 'ChainAccount.createdAt')
  })
}

export function parseStorageV2Address(value: unknown): Address {
  if (!isStorageV2Record(value)) throw new Error('Invalid Storage V2 Address')
  assertStorageV2ExactKeys(
    value,
    [
      'id',
      'chainAccountId',
      'value',
      'scheme',
      'purpose',
      'rotatable',
      'preferredForReceive',
      'privacy',
      'walletCompatibility'
    ],
    ['derivation']
  )
  if (
    typeof value.purpose !== 'string' ||
    !ADDRESS_PURPOSES.has(value.purpose) ||
    typeof value.privacy !== 'string' ||
    !ADDRESS_PRIVACY.has(value.privacy) ||
    typeof value.walletCompatibility !== 'string' ||
    !ADDRESS_COMPATIBILITY.has(value.walletCompatibility) ||
    typeof value.rotatable !== 'boolean' ||
    typeof value.preferredForReceive !== 'boolean'
  ) {
    throw new Error('Invalid Storage V2 Address classification')
  }
  return Object.freeze({
    id: parseAddressId(parseStorageV2String(value.id, 'Address.id', 512)),
    chainAccountId: parseChainAccountId(
      parseStorageV2String(value.chainAccountId, 'Address.chainAccountId', 512)
    ),
    value: parseStorageV2String(value.value, 'Address.value', 4_096),
    scheme: parseStorageV2String(value.scheme, 'Address.scheme', 128),
    purpose: value.purpose as Address['purpose'],
    ...(value.derivation === undefined
      ? {}
      : { derivation: parseStorageV2Derivation(value.derivation) }),
    rotatable: value.rotatable,
    preferredForReceive: value.preferredForReceive,
    privacy: value.privacy as Address['privacy'],
    walletCompatibility: value.walletCompatibility as Address['walletCompatibility']
  })
}
