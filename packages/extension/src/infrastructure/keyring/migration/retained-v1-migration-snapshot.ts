import { parseAccountId, parseAddressId, parseChainAccountId } from '@/core/accounts/domain'
import { BITCOIN_ADDRESS_POLICY } from '@/core/chains/bitcoin'
import { parseChainId } from '@/core/chains/registry'
import {
  parseCredentialGenerationId,
  parseCredentialRef,
  parseEngineCredentialRef,
  parseKeyDomainId
} from '@/core/keyring/domain'
import type {
  V1DiscoveredAccount,
  V1DiscoveredWallet,
  V1MetadataDiscovery
} from '@/infrastructure/persistence/migrations'
import {
  parseStorageV2GenerationId,
  parseStorageV2Snapshot,
  parseStorageV2SourceFingerprint
} from '@/infrastructure/persistence/schema'
import { STORAGE_V2_SCHEMA_VERSION, type StorageV2Snapshot } from '@/ports/repositories'
import type { CompatibilityWorkerResult } from './compatibility-worker-protocol'
import type { V1EncryptedCredentialEnvelope } from './v1-credential-envelope'

export type PreparedV1Wallet = Readonly<{
  wallet: V1DiscoveredWallet
  legacyEnvelope: V1EncryptedCredentialEnvelope
  result: CompatibilityWorkerResult
  stableSuffix: string
  credentialGenerationId: ReturnType<typeof parseCredentialGenerationId>
  credentialSetRef: ReturnType<typeof parseCredentialRef>
  zcashCredentialRef: ReturnType<typeof parseEngineCredentialRef>
  multichainCredentialRef: ReturnType<typeof parseEngineCredentialRef>
}>

export function findPreparedAccount(
  prepared: PreparedV1Wallet,
  account: V1DiscoveredAccount
): CompatibilityWorkerResult['accounts'][number] {
  const result = prepared.result.accounts.find(item => item.accountIndex === account.accountIndex)
  if (!result) throw new Error('Compatibility Worker omitted a V1 Account')
  return result
}

export function retainedV1EntityId(
  kind: 'chain-account' | 'address',
  stableSuffix: string,
  accountIndex: number,
  role: string
): string {
  return `${kind}:v1-migration:${stableSuffix}:${accountIndex}:${role}`
}

export function buildRetainedV1Snapshot(
  discovery: V1MetadataDiscovery,
  preparedWallets: readonly PreparedV1Wallet[],
  generationId: ReturnType<typeof parseStorageV2GenerationId>,
  sourceFingerprint: ReturnType<typeof parseStorageV2SourceFingerprint>,
  timestamp: number
): StorageV2Snapshot {
  const preparedByWalletId = new Map(preparedWallets.map(item => [item.wallet.id, item]))
  const keyDomains = discovery.wallets.map(wallet => {
    const prepared = preparedByWalletId.get(wallet.id)
    if (!prepared) throw new Error('Prepared credential is missing for a V1 Wallet Set')
    return {
      id: parseKeyDomainId(wallet.id),
      credentialRef: prepared.credentialSetRef,
      source: {
        kind: 'software' as const,
        mnemonicWordCount: prepared.result.mnemonicWordCount
      },
      displayName: wallet.displayName,
      createdAt: wallet.createdAt
    }
  })
  const accounts = discovery.wallets.flatMap(wallet =>
    wallet.accounts.map(account => ({
      id: parseAccountId(account.id),
      keyDomainId: parseKeyDomainId(wallet.id),
      accountIndex: account.accountIndex,
      displayName: account.displayName,
      createdAt: account.createdAt
    }))
  )
  const chainAccounts: StorageV2Snapshot['chainAccounts'][number][] = []
  const addresses: StorageV2Snapshot['addresses'][number][] = []

  for (const prepared of preparedWallets) {
    for (const account of prepared.wallet.accounts) {
      const result = findPreparedAccount(prepared, account)
      const scope = {
        keyDomainId: parseKeyDomainId(prepared.wallet.id),
        accountId: parseAccountId(account.id)
      }
      const zcashChainAccountId = parseChainAccountId(
        retainedV1EntityId('chain-account', prepared.stableSuffix, account.accountIndex, 'zcash')
      )
      const evmChainAccountId = parseChainAccountId(
        retainedV1EntityId('chain-account', prepared.stableSuffix, account.accountIndex, 'evm')
      )
      const bitcoinChainAccountId = parseChainAccountId(
        retainedV1EntityId('chain-account', prepared.stableSuffix, account.accountIndex, 'bitcoin')
      )
      chainAccounts.push(
        {
          id: zcashChainAccountId,
          scope: { ...scope, chainId: parseChainId(result.zcash.chainId).id },
          derivation: { scheme: 'zip32-unified', path: result.zcash.derivationPath },
          identity: { kind: 'account-identifier', value: result.zcash.identity },
          createdAt: account.createdAt
        },
        {
          id: evmChainAccountId,
          scope: { ...scope, chainId: parseChainId(result.evm.chainId).id },
          derivation: { scheme: 'bip44', path: result.evm.derivationPath },
          identity: { kind: 'account-identifier', value: result.evm.identity },
          createdAt: account.createdAt
        },
        {
          id: bitcoinChainAccountId,
          scope: { ...scope, chainId: parseChainId(result.bitcoin.chainId).id },
          derivation: {
            scheme: BITCOIN_ADDRESS_POLICY.defaultCreate.derivationScheme,
            path: result.bitcoin.derivationPath
          },
          identity: { kind: 'account-identifier', value: result.bitcoin.identity },
          createdAt: account.createdAt
        }
      )
      const address = (role: string) =>
        parseAddressId(
          retainedV1EntityId('address', prepared.stableSuffix, account.accountIndex, role)
        )
      addresses.push(
        {
          id: address('zcash-full-unified'),
          chainAccountId: zcashChainAccountId,
          value: result.zcash.identity,
          scheme: 'zcash-full-unified',
          purpose: 'identity',
          derivation: { scheme: 'zip32-unified', path: result.zcash.derivationPath },
          rotatable: false,
          preferredForReceive: false,
          privacy: 'mixed',
          walletCompatibility: 'limited'
        },
        {
          id: address('zcash-shielded'),
          chainAccountId: zcashChainAccountId,
          value: account.addresses.shielded,
          scheme: 'zcash-shielded-unified',
          purpose: 'receive',
          rotatable: true,
          preferredForReceive: true,
          privacy: 'shielded',
          walletCompatibility: 'limited'
        },
        {
          id: address('zcash-transparent'),
          chainAccountId: zcashChainAccountId,
          value: account.addresses.transparent,
          scheme: 'zcash-transparent-p2pkh',
          purpose: 'receive',
          rotatable: false,
          preferredForReceive: false,
          privacy: 'transparent',
          walletCompatibility: 'broad'
        },
        {
          id: address('evm'),
          chainAccountId: evmChainAccountId,
          value: result.evm.identity,
          scheme: 'evm',
          purpose: 'identity',
          derivation: { scheme: 'bip44', path: result.evm.derivationPath },
          rotatable: false,
          preferredForReceive: true,
          privacy: 'transparent',
          walletCompatibility: 'broad'
        },
        {
          id: address('bitcoin-receive-0'),
          chainAccountId: bitcoinChainAccountId,
          value: result.bitcoin.identity,
          scheme: BITCOIN_ADDRESS_POLICY.defaultCreate.addressScheme,
          purpose: 'receive',
          derivation: {
            scheme: BITCOIN_ADDRESS_POLICY.defaultCreate.derivationScheme,
            path: result.bitcoin.derivationPath
          },
          rotatable: true,
          preferredForReceive: true,
          privacy: 'transparent',
          walletCompatibility: 'broad'
        }
      )
    }
  }

  return parseStorageV2Snapshot({
    manifest: {
      schemaVersion: STORAGE_V2_SCHEMA_VERSION,
      generationId,
      status: 'verified',
      sourceFingerprint,
      mainKeyDomainId: keyDomains[0]?.id,
      ...(discovery.currentWalletId && discovery.currentAccountId
        ? {
            activeAccount: {
              keyDomainId: parseKeyDomainId(discovery.currentWalletId),
              accountId: parseAccountId(discovery.currentAccountId)
            }
          }
        : {}),
      counts: {
        keyDomains: keyDomains.length,
        accounts: accounts.length,
        chainAccounts: chainAccounts.length,
        addresses: addresses.length
      },
      createdAt: timestamp,
      verifiedAt: timestamp
    },
    keyDomains,
    accounts,
    chainAccounts,
    addresses
  })
}
