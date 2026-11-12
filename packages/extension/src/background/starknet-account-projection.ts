import type { Network } from '@/types'
import { getStarknetNetworkConfig } from '@/core/chains/starknet/network-config'
import { STARKNET_OZ_CLASS_HASH } from '@/infrastructure/chains/starknet/starknet-primitives'
import { normalizeStarknetFelt } from '@/core/chains/starknet/identifiers'
import type { DerivedStarknetNetworkAccount } from '@/infrastructure/keyring/network-account-metadata-coordinator'
import { StarknetMultichainSigningClient } from '@/infrastructure/keyring/multichain/starknet-signing-client'
import { parseKeyDomainId } from '@/core/keyring/domain'
import type { StarknetActiveAccount } from './starknet-dapp-handler'
import { credentialSession } from './credential-session'

const accounts = new Map<string, StarknetActiveAccount>()

export function rememberSoftwareStarknetAccount(account: StarknetActiveAccount): void {
  accounts.set(`${account.keyDomainId}:${account.accountId}`, account)
  void chrome.storage.session
    .set({ 'starknet-software-accounts': [...accounts.values()] })
    .catch(() => {})
}

export async function hydrateSoftwareStarknetAccounts(): Promise<void> {
  const stored = await chrome.storage.session.get('starknet-software-accounts')
  const value = stored['starknet-software-accounts']
  if (!Array.isArray(value)) return
  accounts.clear()
  for (const item of value) {
    if (!isActiveAccount(item)) continue
    accounts.set(`${item.keyDomainId}:${item.accountId}`, item)
  }
}

export function readSoftwareStarknetAccount(
  keyDomainId: string | null,
  accountId: string | null
): StarknetActiveAccount | null {
  if (!keyDomainId || !accountId) return null
  return accounts.get(`${keyDomainId}:${accountId}`) ?? null
}

export async function deriveSoftwareStarknetMetadata(input: {
  readonly keyDomainId: string
  readonly accountId: string
  readonly accountIndex: number
  readonly network: Network
}): Promise<{
  readonly metadata: DerivedStarknetNetworkAccount
  readonly account: StarknetActiveAccount
}> {
  const config = getStarknetNetworkConfig(input.network)
  const signer = new StarknetMultichainSigningClient({ credentials: credentialSession })
  const derived = await signer.deriveAccount(parseKeyDomainId(input.keyDomainId), {
    chainId: config.chainId,
    accountIndex: input.accountIndex,
    addressIndex: 0,
    classHash: STARKNET_OZ_CLASS_HASH
  })
  const record = readPublicAccount(derived)
  const path = `m/44'/9004'/${input.accountIndex}'/0/0`
  if (record.derivationPath !== path) throw new Error('Starknet derivation path does not match')
  if (normalizeStarknetFelt(record.classHash) !== normalizeStarknetFelt(STARKNET_OZ_CLASS_HASH)) {
    throw new Error('Starknet class hash does not match the software account')
  }
  const metadata = Object.freeze({
    chainId: config.chainId,
    address: record.address,
    publicKey: record.publicKey,
    classHash: record.classHash,
    derivationPath: path
  })
  const account = Object.freeze({
    address: record.address,
    publicKey: record.publicKey,
    classHash: record.classHash,
    implementation: 'open_zeppelin' as const,
    accountIndex: input.accountIndex,
    addressIndex: 0,
    keyDomainId: input.keyDomainId,
    accountId: input.accountId
  })
  rememberSoftwareStarknetAccount(account)
  return { metadata, account }
}

function readPublicAccount(value: unknown): {
  readonly address: string
  readonly publicKey: string
  readonly classHash: string
  readonly derivationPath: string
} {
  if (typeof value !== 'object' || value === null) throw new Error('Starknet account is invalid')
  const record = value as Record<string, unknown>
  const derivation = record.derivation
  const addresses = record.addresses
  if (
    typeof derivation !== 'object' ||
    derivation === null ||
    !Array.isArray(addresses) ||
    addresses.length === 0
  ) {
    throw new Error('Starknet account is invalid')
  }
  const address = addresses[0]
  if (typeof address !== 'object' || address === null)
    throw new Error('Starknet account is invalid')
  return {
    address: readFelt((address as { value?: unknown }).value),
    publicKey: readFelt(record.publicKey),
    classHash: readFelt(record.classHash),
    derivationPath:
      typeof (derivation as { path?: unknown }).path === 'string'
        ? (derivation as { path: string }).path
        : ''
  }
}

function readFelt(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) {
    throw new Error('Starknet account is invalid')
  }
  return value
}

function isActiveAccount(value: unknown): value is StarknetActiveAccount {
  if (typeof value !== 'object' || value === null) return false
  const record = value as StarknetActiveAccount
  return (
    (record.implementation === 'open_zeppelin' ||
      record.implementation === 'argent_v0_4' ||
      record.implementation === 'argent_v0_5') &&
    typeof record.address === 'string' &&
    typeof record.publicKey === 'string' &&
    typeof record.classHash === 'string' &&
    typeof record.keyDomainId === 'string' &&
    typeof record.accountId === 'string'
  )
}
