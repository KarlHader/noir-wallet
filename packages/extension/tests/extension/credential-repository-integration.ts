import { loadActiveWalletSet } from '@/core/accounts/application'
import {
  createChainRegistry,
  createFeatureGatedChainRegistry,
  type ChainCapabilities
} from '@/core/chains/registry'
import { CREDENTIAL_SET_SCHEMA_VERSION, parseCredentialRef } from '@/core/keyring/domain'
import {
  CompatibilityWorkerError,
  CompatibilityWorkerHost,
  CredentialPasswordChangeCoordinator,
  CredentialRemovalCoordinator,
  RetainedV1InventoryCoordinator,
  RetainedV1MigrationCoordinator,
  RetainedV1ReconciliationCoordinator
} from '@/infrastructure/keyring/migration'
import {
  credentialEnvelopePairFormat,
  unwrapSoftwareCredentialEnvelopePair
} from '@/infrastructure/keyring/credential-envelope-authentication'
import { discoverV1Metadata } from '@/infrastructure/persistence/migrations'
import { IndexedDbCredentialRepository } from '@/infrastructure/persistence/repositories'
import { IndexedDbStorageV2Repository } from '@/infrastructure/persistence/repositories'
import type { StorageV2ActivePointer, StorageV2GenerationId } from '@/ports/repositories'

const KEY_DOMAIN_ID = 'wallet:credential-repository-e2e'
const GENERATION_ID = 'generation:credential-repository-e2e'
const CREDENTIAL_SET_REF = 'set:credential-repository-e2e'
const TRANSACTION_ID = 'transaction:credential-repository-e2e'
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const TEST_MNEMONIC_24 = `${'abandon '.repeat(23)}art`
const TEST_ZCASH_ADDRESSES = Object.freeze({
  transparent: 't1XVXWCvpMgBvUaed4XDqWtgQgJSu1Ghz7F',
  shielded:
    'u14hxpxnwfzfujl6n36gfpr2e90mxzupmaksy3ly7ztgcey8qa06703yutk3m3u46tfkeywk9w69atu6zmdlp0lekh8jpsxmpzngrspf379dtgyvyfggtqlyvcq3wjr5y5xngex2qtsxheywdyzdfalk5clnms8wy3fje0j560wvsjm6d8',
  fullUnified:
    'u1vu0zkreyef83369fn3dr94zkg2djqlcgtghxf2jmdcdmxp2z4l70dlh6yfdf5v33cteezva2c528syqtmu7uxgzss6fumh3tzjumnqh45z3yewkqplrfdz4f68aahg8x35yknyf7vjh4wy5sn4cc8edkxlef2p4q8ez6e0xuzrmr4rzff54m5t5whyzdgfg2cujtjdjlx2zqu46h7ty'
})
const TEST_ZCASH_ACCOUNT_1_ADDRESSES = Object.freeze({
  transparent: 't1Tw3THAja3sRNaHxWvzsMCjBJjCHBckBAv',
  shielded:
    'u15gdczv3e4dszv7vqkatz5n74texy6qhms90p2z0k7l37t5yyn9a29v3c7vnyenamdpm0dghv0jn5yn6cr3gfk8xndfk7ljgmjr6r9yuyd0wpxwmwzcr7qv47dml5psenp5tfvdpgkygq4wspumyrjjcqagrw8a2lc2ufkp9dlcsmemgp',
  fullUnified:
    'u1tcavyntv7v0gtkq7uzfnzcvfsx42ay8c6vettpcdv2p0x7ht9esc93gpk9khth43mez38yd5l03lp5jgjgj9079mvud8jv85rk8d5d7nzj2u0n7z8s3wg2rsp2nekjqge83rnjn6mnzghxxhrc6u29lu6rpwyjavy9rzsp2a0ra3lhmypkzj8nty65uupql8ke5gsrqz4nr6xv75l6y'
})
const TEST_ZCASH_24_ADDRESSES = Object.freeze({
  transparent: 't1dUDJ62ANtmebE8drFg7g2MWYwXHQ6Xu3F',
  shielded:
    'u1nvgt6yr35mhc9wdf4wckvl38476vqy96dx3cwkfdwy4jet9300l5v8l2yg27ql7w9qwm0lf8kncnj9nus4mgete06j3cu3mhrqvstg6swvdya6xgzwhh6a9xxdhxkavvvmztqeuaurjtqfk3dzetuzgnu0zjvmdpe8ehvj53sy6yhzxj',
  fullUnified:
    'u16sw4v6wy7f4jzdny55yzl020tp3yqg3c85dc6n7mmq0urfm6adqg79hxmyk85ufn4lun4pfh5q48cc3kvxhxm3w978eqqecdd260gkzjrkun6z7m9mcrt2zszaj0mvk6ufux2zteqwh57cq906hz3rkg63duaeqsvjelv9h5srct0zq8rvlv23wz5hed7zuatqd7p6p4ztugc4t4w2g'
})
const TEST_ZCASH_ROTATED_ADDRESSES = Object.freeze({
  transparent: TEST_ZCASH_ADDRESSES.transparent,
  shielded:
    'u14a9zc405ca7qack06wymcs3mma3qntu7n9wxdllqjp05prw7rwakfuk35sqxfsxdqa9xnk3dqsjtk8mcg6fc8y9ywjwdgjzk525q3zcdyzpm8ypkuyxnzezea3fdym95avs5hn0vuufutm4dhtsurvq7qchpvuvf42pfk6ym0cr36ney',
  fullUnified:
    'u14a9zc405ca7qack06wymcs3mma3qntu7n9wxdllqjp05prw7rwakfuk35sqxfsxdqa9xnk3dqsjtk8mcg6fc8y9ywjwdgjzk525q3zcdyzpm8ypkuyxnzezea3fdym95avs5hn0vuufutm4dhtsurvq7qchpvuvf42pfk6ym0cr36ney'
})

type RetainedV1FixtureOptions = Readonly<{
  network?: 'mainnet' | 'testnet'
  addresses?: Readonly<{
    transparent: string
    shielded: string
    fullUnified: string
  }>
}>

function availableCapabilities(input: {
  readonly addressSchemes: readonly string[]
  readonly derivationSchemes: readonly string[]
  readonly transactionFormats: readonly string[]
  readonly messageFormats: readonly string[]
  readonly model: ChainCapabilities['transaction']['model']
  readonly actions: ChainCapabilities['transaction']['actions']
}): ChainCapabilities {
  return {
    address: {
      status: 'available',
      addressSchemes: input.addressSchemes,
      derivationSchemes: input.derivationSchemes,
      supportsRotation: true,
      supportsChange: false
    },
    signing: {
      status: 'available',
      transactionFormats: input.transactionFormats,
      messageFormats: input.messageFormats
    },
    transaction: {
      status: 'available',
      model: input.model,
      actions: input.actions
    }
  }
}

const TEST_RELEASED_CHAIN_REGISTRY = createFeatureGatedChainRegistry(
  createChainRegistry([
    {
      id: 'bip122:00040fe8ec8471911baa1db1266ea15d',
      family: 'zcash',
      network: { kind: 'mainnet', name: 'mainnet' },
      displayName: 'Zcash',
      featureFlag: 'chain.zcash',
      capabilities: availableCapabilities({
        addressSchemes: ['zcash-full-unified', 'zcash-shielded-unified', 'zcash-transparent-p2pkh'],
        derivationSchemes: ['zip32-unified'],
        transactionFormats: ['zcash-v5'],
        messageFormats: ['zip244'],
        model: 'hybrid-utxo',
        actions: ['native-transfer', 'shield']
      })
    },
    {
      id: 'eip155:1',
      family: 'evm',
      network: { kind: 'mainnet', name: 'mainnet' },
      displayName: 'Ethereum',
      featureFlag: 'chain.evm',
      capabilities: availableCapabilities({
        addressSchemes: ['evm'],
        derivationSchemes: ['bip44'],
        transactionFormats: ['legacy', 'eip1559'],
        messageFormats: ['eip191', 'eip712'],
        model: 'account',
        actions: ['native-transfer', 'token-transfer', 'contract-call']
      })
    },
    {
      id: 'bip122:000000000019d6689c085ae165831e93',
      family: 'bitcoin',
      network: { kind: 'mainnet', name: 'mainnet' },
      displayName: 'Bitcoin',
      featureFlag: 'chain.bitcoin',
      capabilities: availableCapabilities({
        addressSchemes: ['bitcoin-p2wpkh'],
        derivationSchemes: ['bip84'],
        transactionFormats: ['psbt-v0'],
        messageFormats: ['bip322'],
        model: 'utxo',
        actions: ['native-transfer']
      })
    }
  ]),
  ['chain.zcash']
)

function engineRef(engine: 'zcash' | 'multichain') {
  return `credential:${KEY_DOMAIN_ID}:${GENERATION_ID}:${engine}`
}

function journal(phase: 'staging' | 'verified' | 'failed' = 'staging', revision = 0) {
  return {
    schemaVersion: 1 as const,
    transactionId: TRANSACTION_ID,
    operation: 'migrate' as const,
    targetMetadataGenerationId: 'metadata:credential-repository-e2e',
    transitions: [
      {
        kind: 'provision' as const,
        keyDomainId: KEY_DOMAIN_ID,
        targetCredentialGenerationId: GENERATION_ID,
        targetCredentialSetRef: CREDENTIAL_SET_REF,
        stagedRefs: [engineRef('zcash'), engineRef('multichain')]
      }
    ],
    phase,
    revision,
    createdAt: 1_000,
    updatedAt: 1_000 + revision,
    ...(phase === 'failed' ? { lastErrorCode: 'E2E_FAILURE' } : {})
  }
}

function envelope(engine: 'zcash' | 'multichain', bytes: readonly number[]) {
  return {
    schemaVersion: 1 as const,
    transactionId: TRANSACTION_ID,
    aad: {
      schemaVersion: 1 as const,
      engine,
      keyDomainId: KEY_DOMAIN_ID,
      credentialGenerationId: GENERATION_ID,
      credentialRef: engineRef(engine),
      formatVersion: 1
    },
    encryptedPayload: new Uint8Array(bytes),
    createdAt: 1_001
  }
}

function credentialSet() {
  return {
    schemaVersion: 1 as const,
    transactionId: TRANSACTION_ID,
    credentialSetRef: CREDENTIAL_SET_REF,
    manifest: {
      schemaVersion: CREDENTIAL_SET_SCHEMA_VERSION,
      credentialGenerationId: GENERATION_ID,
      keyDomainId: KEY_DOMAIN_ID,
      source: 'software' as const,
      mnemonicWordCount: 12 as const,
      zcashSeedPolicy: 'direct-bip39-v1' as const,
      engines: {
        zcash: {
          credentialRef: engineRef('zcash'),
          formatVersion: 1,
          verificationAnchorRef: `chain-account:${encodeURIComponent(`${KEY_DOMAIN_ID}:zcash`)}`
        },
        multichain: {
          credentialRef: engineRef('multichain'),
          formatVersion: 1,
          verificationAnchorRef: `chain-account:${encodeURIComponent(`${KEY_DOMAIN_ID}:multichain`)}`
        }
      },
      createdAt: 1_001,
      verifiedAt: 1_002
    }
  }
}

function deleteDatabase(databaseName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('Credential test database deletion blocked'))
  })
}

function bytesToBase64(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary)
}

async function encryptV1Credential(password: string, mnemonic = TEST_MNEMONIC) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  )
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  )
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify({ seedPhrase: mnemonic }))
  )
  return {
    encryptedData: bytesToBase64(new Uint8Array(encrypted)),
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv)
  }
}

async function migrateCanonicalMnemonic(
  password: string,
  mnemonic: string,
  expectedZcash: Readonly<{
    transparent: string
    shielded: string
    fullUnified?: string
  }>
) {
  const envelope = await encryptV1Credential(password, mnemonic)
  return new CompatibilityWorkerHost().migrate({
    operation: 'migrate',
    envelope,
    password,
    zcashNetwork: 'mainnet',
    zcashChainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
    evmChainId: 'eip155:1',
    bitcoinChainId: 'bip122:000000000019d6689c085ae165831e93',
    accounts: [{ accountIndex: 0, expectedZcash }]
  })
}

async function migrateCanonicalMnemonic24(password: string) {
  return migrateCanonicalMnemonic(password, TEST_MNEMONIC_24, TEST_ZCASH_24_ADDRESSES)
}

async function migrateV1Credential(
  password: string,
  suppliedPassword = password,
  expectedTransparent = TEST_ZCASH_ADDRESSES.transparent,
  expectedShielded = TEST_ZCASH_ADDRESSES.shielded,
  expectedFullUnified = TEST_ZCASH_ADDRESSES.fullUnified
) {
  const envelope = await encryptV1Credential(password)
  try {
    const result = await new CompatibilityWorkerHost().migrate({
      operation: 'migrate',
      envelope,
      password: suppliedPassword,
      zcashNetwork: 'mainnet',
      zcashChainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
      evmChainId: 'eip155:1',
      bitcoinChainId: 'bip122:000000000019d6689c085ae165831e93',
      accounts: [
        {
          accountIndex: 0,
          expectedZcash: {
            transparent: expectedTransparent,
            shielded: expectedShielded,
            fullUnified: expectedFullUnified
          }
        }
      ]
    })
    return { ok: true as const, result }
  } catch (error) {
    return {
      ok: false as const,
      code: error instanceof CompatibilityWorkerError ? error.code : 'UNKNOWN'
    }
  }
}

function migrateRotatedV1Credential(password: string) {
  return migrateV1Credential(
    password,
    password,
    TEST_ZCASH_ROTATED_ADDRESSES.transparent,
    TEST_ZCASH_ROTATED_ADDRESSES.shielded,
    TEST_ZCASH_ROTATED_ADDRESSES.fullUnified
  )
}

function migrateMismatchedFullUnifiedV1Credential(password: string) {
  return migrateV1Credential(
    password,
    password,
    TEST_ZCASH_ADDRESSES.transparent,
    TEST_ZCASH_ADDRESSES.shielded,
    TEST_ZCASH_ACCOUNT_1_ADDRESSES.fullUnified
  )
}

async function verifyV1CredentialEnvelope(envelopeValue: unknown, password: string) {
  try {
    await new CompatibilityWorkerHost().migrate({
      operation: 'migrate',
      envelope: envelopeValue as Awaited<ReturnType<typeof encryptV1Credential>>,
      password,
      zcashNetwork: 'mainnet',
      zcashChainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
      evmChainId: 'eip155:1',
      bitcoinChainId: 'bip122:000000000019d6689c085ae165831e93',
      accounts: [{ accountIndex: 0, expectedZcash: TEST_ZCASH_ADDRESSES }]
    })
    return true
  } catch {
    return false
  }
}

async function rewrapV1Credential(currentPassword: string, targetPassword: string) {
  const envelope = await encryptV1Credential(currentPassword)
  try {
    const result = await new CompatibilityWorkerHost().migrate({
      operation: 'change-password',
      envelope,
      password: currentPassword,
      targetPassword,
      zcashNetwork: 'mainnet',
      zcashChainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
      evmChainId: 'eip155:1',
      bitcoinChainId: 'bip122:000000000019d6689c085ae165831e93',
      accounts: [{ accountIndex: 0, expectedZcash: TEST_ZCASH_ADDRESSES }]
    })
    if (result.operation !== 'change-password') throw new Error('Unexpected operation')
    const acceptsNewPassword = await new CompatibilityWorkerHost()
      .migrate({
        operation: 'migrate',
        envelope: result.retainedV1Envelope,
        password: targetPassword,
        zcashNetwork: 'mainnet',
        zcashChainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
        evmChainId: 'eip155:1',
        bitcoinChainId: 'bip122:000000000019d6689c085ae165831e93',
        accounts: [{ accountIndex: 0, expectedZcash: TEST_ZCASH_ADDRESSES }]
      })
      .then(() => true)
      .catch(() => false)
    const acceptsOldPassword = await new CompatibilityWorkerHost()
      .migrate({
        operation: 'migrate',
        envelope: result.retainedV1Envelope,
        password: currentPassword,
        zcashNetwork: 'mainnet',
        zcashChainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
        evmChainId: 'eip155:1',
        bitcoinChainId: 'bip122:000000000019d6689c085ae165831e93',
        accounts: [{ accountIndex: 0, expectedZcash: TEST_ZCASH_ADDRESSES }]
      })
      .then(() => true)
      .catch(() => false)
    const resumed = await new CompatibilityWorkerHost().migrate({
      operation: 'change-password',
      envelope: result.retainedV1Envelope,
      password: targetPassword,
      targetPassword,
      targetVault: result.vault,
      zcashNetwork: 'mainnet',
      zcashChainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
      evmChainId: 'eip155:1',
      bitcoinChainId: 'bip122:000000000019d6689c085ae165831e93',
      accounts: [{ accountIndex: 0, expectedZcash: TEST_ZCASH_ADDRESSES }]
    })
    return {
      ok: true as const,
      result,
      acceptsNewPassword,
      acceptsOldPassword,
      resumedVaultMatches: JSON.stringify(resumed.vault) === JSON.stringify(result.vault)
    }
  } catch (error) {
    return {
      ok: false as const,
      code: error instanceof CompatibilityWorkerError ? error.code : 'UNKNOWN'
    }
  }
}

type MigrationInterrupt = 'none' | 'after-stage' | 'after-commit'

class InterruptingStorageV2Repository extends IndexedDbStorageV2Repository {
  private interrupted = false

  constructor(
    databaseName: string,
    private readonly interrupt: MigrationInterrupt
  ) {
    super({ databaseName })
  }

  override async stage(snapshot: Parameters<IndexedDbStorageV2Repository['stage']>[0]) {
    await super.stage(snapshot)
    if (!this.interrupted && this.interrupt === 'after-stage') {
      this.interrupted = true
      throw new Error('TEST_INTERRUPT_AFTER_STAGE')
    }
  }

  override async commit(
    pointer: StorageV2ActivePointer,
    expectedActiveGenerationId: StorageV2GenerationId | null
  ) {
    const result = await super.commit(pointer, expectedActiveGenerationId)
    if (!this.interrupted && this.interrupt === 'after-commit') {
      this.interrupted = true
      throw new Error('TEST_INTERRUPT_AFTER_COMMIT')
    }
    return result
  }
}

async function prepareRetainedMigrationFixture(
  password: string,
  wordCount: 12 | 24 = 12,
  options: RetainedV1FixtureOptions = {}
) {
  const mnemonic = wordCount === 12 ? TEST_MNEMONIC : TEST_MNEMONIC_24
  const addresses =
    options.addresses ?? (wordCount === 12 ? TEST_ZCASH_ADDRESSES : TEST_ZCASH_24_ADDRESSES)
  const envelope = await encryptV1Credential(password, mnemonic)
  return {
    wallet_state: JSON.stringify({
      state: {
        currentWalletId: 'wallet:retained-v1-e2e',
        currentAccountId: 'account:retained-v1-e2e:0',
        currentNetwork: options.network ?? 'mainnet',
        zecPrice: 0,
        wallets: [
          {
            id: 'wallet:retained-v1-e2e',
            name: 'Retained V1 Wallet',
            seedPhraseKey: 'seed_wallet:retained-v1-e2e',
            accounts: [
              {
                id: 'account:retained-v1-e2e:0',
                name: 'Account 1',
                derivationIndex: 0,
                birthdayHeight: 2_000_000,
                addresses,
                isPinned: false,
                isHidden: false
              }
            ],
            createdAt: 1_700_000_000_000,
            isPinned: false,
            keySource: 'software'
          }
        ],
        accountDisplayNames: {}
      },
      version: 0
    }),
    'seed_wallet:retained-v1-e2e': envelope
  }
}

async function prepareRotatedRetainedMigrationFixture(password: string) {
  return Object.freeze({
    local: await prepareRetainedMigrationFixture(password, 12, {
      addresses: TEST_ZCASH_ROTATED_ADDRESSES
    }),
    expected: TEST_ZCASH_ROTATED_ADDRESSES
  })
}

async function prepareRetainedInventoryFixture(password: string) {
  const initial = await prepareRetainedMigrationFixture(password)
  const target = structuredClone(initial) as Record<string, unknown>
  const stateEnvelope = JSON.parse(target.wallet_state as string) as {
    state: {
      currentWalletId: string
      currentAccountId: string
      wallets: Array<Record<string, unknown>>
    }
  }
  const sourceWallet = stateEnvelope.state.wallets[0] as {
    accounts: Array<Record<string, unknown>>
  }
  const walletId = 'wallet:retained-v1-e2e:added'
  const accountId = 'account:retained-v1-e2e:added:0'
  stateEnvelope.state.wallets.push({
    ...structuredClone(sourceWallet),
    id: walletId,
    name: 'Added V1 Wallet',
    seedPhraseKey: `seed_${walletId}`,
    accounts: sourceWallet.accounts.map(account => ({
      ...structuredClone(account),
      id: accountId
    })),
    createdAt: 1_700_000_100_000
  })
  stateEnvelope.state.currentWalletId = walletId
  stateEnvelope.state.currentAccountId = accountId
  target.wallet_state = JSON.stringify(stateEnvelope)
  target[`seed_${walletId}`] = await encryptV1Credential(password)
  return { initial, target, walletId, accountId }
}

async function prepareRetainedAccountInventoryFixture(password: string) {
  const initial = await prepareRetainedMigrationFixture(password)
  const target = structuredClone(initial) as Record<string, unknown>
  const stateEnvelope = JSON.parse(target.wallet_state as string) as {
    state: {
      currentWalletId: string
      currentAccountId: string
      wallets: Array<{ id: string; accounts: Array<Record<string, unknown>> }>
    }
  }
  const wallet = stateEnvelope.state.wallets[0]
  const accountId = 'account:retained-v1-e2e:1'
  wallet.accounts.push({
    id: accountId,
    name: 'Account 2',
    derivationIndex: 1,
    birthdayHeight: 2_000_000,
    addresses: TEST_ZCASH_ACCOUNT_1_ADDRESSES,
    isPinned: false,
    isHidden: false,
    createdAt: 1_700_000_100_000
  })
  stateEnvelope.state.currentAccountId = accountId
  target.wallet_state = JSON.stringify(stateEnvelope)
  return { initial, target, walletId: wallet.id, accountId }
}

async function runRetainedMigration(
  credentialDatabaseName: string,
  storageDatabaseName: string,
  local: Readonly<Record<string, unknown>>,
  password: string,
  interrupt: MigrationInterrupt = 'none'
) {
  const credentialRepository = new IndexedDbCredentialRepository({
    databaseName: credentialDatabaseName
  })
  const storageRepository = new InterruptingStorageV2Repository(storageDatabaseName, interrupt)
  try {
    const result = await new RetainedV1MigrationCoordinator({
      credentialRepository,
      storageRepository
    }).migrate({
      discovery: discoverV1Metadata(local),
      credentialEnvelopes: local,
      password,
      chains: {
        zcashNetwork: 'mainnet',
        zcashChainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
        evmChainId: 'eip155:1',
        bitcoinChainId: 'bip122:000000000019d6689c085ae165831e93'
      }
    })
    const pointer = await storageRepository.getActivePointer()
    const snapshot = pointer ? await storageRepository.getSnapshot(pointer.generationId) : null
    const journal = await credentialRepository.getJournal(result.transactionId)
    const activeKeyDomain = snapshot?.keyDomains.find(
      keyDomain => keyDomain.id === snapshot.manifest.mainKeyDomainId
    )
    const activeCredentialSet = activeKeyDomain
      ? await credentialRepository.getCredentialSet(activeKeyDomain.credentialRef)
      : null
    return {
      ok: true as const,
      result,
      journalPhase: journal?.phase ?? null,
      activeAccount: snapshot?.manifest.activeAccount ?? null,
      keyDomainSource: activeKeyDomain?.source ?? null,
      credentialPolicy:
        activeCredentialSet?.manifest.source === 'software'
          ? {
              mnemonicWordCount: activeCredentialSet.manifest.mnemonicWordCount,
              zcashSeedPolicy: activeCredentialSet.manifest.zcashSeedPolicy
            }
          : null,
      chainAccounts: snapshot?.chainAccounts.map(account => ({
        chainId: account.scope.chainId,
        path: account.derivation.path,
        identity: account.identity.value
      })),
      addresses: snapshot?.addresses.map(address => ({
        scheme: address.scheme,
        value: address.value
      })),
      addressSchemes: snapshot?.addresses.map(address => address.scheme).sort()
    }
  } catch (error) {
    const pointer = await storageRepository.getActivePointer()
    return {
      ok: false as const,
      code: error instanceof Error ? error.message : 'UNKNOWN',
      activeGenerationId: pointer?.generationId ?? null
    }
  }
}

async function runRetainedInventorySync(
  credentialDatabaseName: string,
  storageDatabaseName: string,
  initial: Readonly<Record<string, unknown>>,
  target: Readonly<Record<string, unknown>>,
  password: string,
  interrupt: MigrationInterrupt = 'none'
) {
  const credentialRepository = new IndexedDbCredentialRepository({
    databaseName: credentialDatabaseName
  })
  const initialStorageRepository = new IndexedDbStorageV2Repository({
    databaseName: storageDatabaseName
  })
  const existingPointer = await initialStorageRepository.getActivePointer()
  if (!existingPointer) {
    await new RetainedV1MigrationCoordinator({
      credentialRepository,
      storageRepository: initialStorageRepository
    }).migrate({
      discovery: discoverV1Metadata(initial),
      credentialEnvelopes: initial,
      password,
      chains: {
        zcashNetwork: 'mainnet',
        zcashChainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
        evmChainId: 'eip155:1',
        bitcoinChainId: 'bip122:000000000019d6689c085ae165831e93'
      }
    })
  }
  const storageRepository = new InterruptingStorageV2Repository(storageDatabaseName, interrupt)
  try {
    const result = await new RetainedV1InventoryCoordinator({
      credentialRepository,
      storageRepository
    }).synchronize({
      discovery: discoverV1Metadata(target),
      credentialEnvelopes: target,
      password,
      chains: {
        zcashNetwork: 'mainnet',
        zcashChainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
        evmChainId: 'eip155:1',
        bitcoinChainId: 'bip122:000000000019d6689c085ae165831e93'
      }
    })
    const pointer = await storageRepository.getActivePointer()
    const snapshot = pointer ? await storageRepository.getSnapshot(pointer.generationId) : null
    const addedKeyDomainId = result.provisionedKeyDomainIds[0]
    const addedKeyDomain = snapshot?.keyDomains.find(item => item.id === addedKeyDomainId)
    return {
      ok: true as const,
      result,
      activeGenerationId: pointer?.generationId ?? null,
      counts: snapshot?.manifest.counts ?? null,
      activeAccount: snapshot?.manifest.activeAccount ?? null,
      addedCredentialStatus: addedKeyDomain
        ? (
            await credentialRepository.validateForActivation(
              addedKeyDomain.credentialRef,
              addedKeyDomain.id
            )
          ).status
        : null,
      pendingPhase: (await credentialRepository.findIncompleteJournal('migrate'))?.phase ?? null
    }
  } catch (error) {
    const pointer = await storageRepository.getActivePointer()
    return {
      ok: false as const,
      code: error instanceof Error ? error.message : 'UNKNOWN',
      activeGenerationId: pointer?.generationId ?? null,
      pendingPhase: (await credentialRepository.findIncompleteJournal('migrate'))?.phase ?? null
    }
  }
}

async function initializeCredentialRemoval(
  credentialDatabaseName: string,
  storageDatabaseName: string,
  initial: Readonly<Record<string, unknown>>,
  target: Readonly<Record<string, unknown>>,
  password: string
) {
  const synchronized = await runRetainedInventorySync(
    credentialDatabaseName,
    storageDatabaseName,
    initial,
    target,
    password
  )
  if (!synchronized.ok) throw new Error(synchronized.code)
  return synchronized
}

async function runCredentialRemoval(
  credentialDatabaseName: string,
  storageDatabaseName: string,
  target:
    | Readonly<{ kind: 'account'; keyDomainId: string; accountId: string }>
    | Readonly<{ kind: 'wallet'; keyDomainId: string }>,
  interrupt: MigrationInterrupt = 'none'
) {
  const credentialRepository = new IndexedDbCredentialRepository({
    databaseName: credentialDatabaseName
  })
  const storageRepository = new InterruptingStorageV2Repository(storageDatabaseName, interrupt)
  const sourcePointer = await storageRepository.getActivePointer()
  if (!sourcePointer) throw new Error('Credential removal fixture is not initialized')
  const sourceSnapshot = await storageRepository.getSnapshot(sourcePointer.generationId)
  if (!sourceSnapshot) throw new Error('Credential removal source snapshot is missing')
  const sourceKeyDomain = sourceSnapshot.keyDomains.find(
    keyDomain => keyDomain.id === target.keyDomainId
  )
  const pendingBeforeRemoval = await credentialRepository.findIncompleteJournal('remove')
  const pendingTransition = pendingBeforeRemoval?.transitions.find(
    transition => transition.kind === 'retire' && transition.keyDomainId === target.keyDomainId
  )
  const sourceCredentialSet = sourceKeyDomain
    ? await credentialRepository.getCredentialSet(sourceKeyDomain.credentialRef)
    : pendingTransition?.kind === 'retire'
      ? await credentialRepository.getCredentialSetByGeneration(
          pendingTransition.sourceCredentialGenerationId
        )
      : null

  try {
    const coordinator = new CredentialRemovalCoordinator({
      credentialRepository,
      storageRepository
    })
    const result =
      target.kind === 'wallet'
        ? await coordinator.removeWallet(target.keyDomainId)
        : await coordinator.removeAccount(target.keyDomainId, target.accountId)
    const pointer = await storageRepository.getActivePointer()
    const snapshot = pointer ? await storageRepository.getSnapshot(pointer.generationId) : null
    const pending = await credentialRepository.findIncompleteJournal('remove')
    const sourceEnvelopePresence =
      sourceCredentialSet?.manifest.source === 'software'
        ? await Promise.all(
            Object.values(sourceCredentialSet.manifest.engines)
              .filter(engine => engine !== undefined)
              .map(async engine =>
                Boolean(await credentialRepository.getEnvelope(engine.credentialRef))
              )
          )
        : null
    return {
      ok: true as const,
      result,
      counts: snapshot?.manifest.counts ?? null,
      activeAccount: snapshot?.manifest.activeAccount ?? null,
      targetPresent: snapshot
        ? target.kind === 'wallet'
          ? snapshot.keyDomains.some(keyDomain => keyDomain.id === target.keyDomainId)
          : snapshot.accounts.some(
              account =>
                account.keyDomainId === target.keyDomainId && account.id === target.accountId
            )
        : null,
      sourceCredentialRetired: sourceCredentialSet
        ? Boolean(await credentialRepository.getRetirement(sourceCredentialSet.credentialSetRef))
        : null,
      sourceCredentialActivation: sourceCredentialSet
        ? (
            await credentialRepository.validateForActivation(
              sourceCredentialSet.credentialSetRef,
              sourceCredentialSet.manifest.keyDomainId
            )
          ).status
        : null,
      sourceEnvelopesPresent: sourceEnvelopePresence?.some(Boolean) ?? null,
      pendingPhase: pending?.phase ?? null
    }
  } catch (error) {
    const pointer = await storageRepository.getActivePointer()
    return {
      ok: false as const,
      code: error instanceof Error ? error.message : 'UNKNOWN',
      activeGenerationId: pointer?.generationId ?? null,
      pendingPhase: (await credentialRepository.findIncompleteJournal('remove'))?.phase ?? null
    }
  }
}

async function runRetainedV1Reconciliation(
  credentialDatabaseName: string,
  storageDatabaseName: string,
  desired: Readonly<Record<string, unknown>>,
  password: string
) {
  const credentialRepository = new IndexedDbCredentialRepository({
    databaseName: credentialDatabaseName
  })
  const storageRepository = new IndexedDbStorageV2Repository({
    databaseName: storageDatabaseName
  })
  const sourcePointer = await storageRepository.getActivePointer()
  if (!sourcePointer) throw new Error('Retained V1 reconciliation fixture is not initialized')
  const sourceSnapshot = await storageRepository.getSnapshot(sourcePointer.generationId)
  if (!sourceSnapshot) throw new Error('Retained V1 reconciliation source is missing')
  const discovery = discoverV1Metadata(desired)
  const desiredWalletIds = new Set(discovery.wallets.map(wallet => wallet.id))
  const removedCredentialSets = await Promise.all(
    sourceSnapshot.keyDomains
      .filter(keyDomain => !desiredWalletIds.has(keyDomain.id))
      .map(keyDomain => credentialRepository.getCredentialSet(keyDomain.credentialRef))
  )
  const result = await new RetainedV1ReconciliationCoordinator({
    credentialRepository,
    storageRepository
  }).synchronize({
    discovery,
    credentialEnvelopes: desired,
    password,
    chains: {
      zcashNetwork: 'mainnet',
      zcashChainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
      evmChainId: 'eip155:1',
      bitcoinChainId: 'bip122:000000000019d6689c085ae165831e93'
    }
  })
  const pointer = await storageRepository.getActivePointer()
  const snapshot = pointer ? await storageRepository.getSnapshot(pointer.generationId) : null
  const retiredCredentialStates = await Promise.all(
    removedCredentialSets.flatMap(credentialSet =>
      credentialSet
        ? [
            (async () => ({
              credentialSetRef: credentialSet.credentialSetRef,
              retired: Boolean(
                await credentialRepository.getRetirement(credentialSet.credentialSetRef)
              ),
              active: (
                await credentialRepository.validateForActivation(
                  credentialSet.credentialSetRef,
                  credentialSet.manifest.keyDomainId
                )
              ).status,
              envelopesPresent:
                credentialSet.manifest.source === 'software'
                  ? (
                      await Promise.all(
                        Object.values(credentialSet.manifest.engines)
                          .filter(engine => engine !== undefined)
                          .map(async engine =>
                            Boolean(await credentialRepository.getEnvelope(engine.credentialRef))
                          )
                      )
                    ).some(Boolean)
                  : null
            }))()
          ]
        : []
    )
  )
  return {
    result,
    counts: snapshot?.manifest.counts ?? null,
    activeAccount: snapshot?.manifest.activeAccount ?? null,
    keyDomainIds: snapshot?.keyDomains.map(keyDomain => keyDomain.id) ?? null,
    accountIds: snapshot?.accounts.map(account => account.id) ?? null,
    retiredCredentialStates,
    pendingRemoval: (await credentialRepository.findIncompleteJournal('remove'))?.phase ?? null,
    pendingInventory: (await credentialRepository.findIncompleteJournal('migrate'))?.phase ?? null
  }
}

async function resetRetainedMigrationDatabases(
  credentialDatabaseName: string,
  storageDatabaseName: string
) {
  await Promise.all([deleteDatabase(credentialDatabaseName), deleteDatabase(storageDatabaseName)])
}

async function initializeCredentialPasswordChange(
  credentialDatabaseName: string,
  storageDatabaseName: string,
  password: string
) {
  const local = await prepareRetainedMigrationFixture(password)
  const migrated = await runRetainedMigration(
    credentialDatabaseName,
    storageDatabaseName,
    local,
    password
  )
  if (!migrated.ok) throw new Error(migrated.code)
  return local
}

async function runCredentialPasswordChange(
  credentialDatabaseName: string,
  storageDatabaseName: string,
  localValue: Readonly<Record<string, unknown>>,
  currentPassword: string,
  newPassword: string,
  interrupt: MigrationInterrupt = 'none'
) {
  const local: Record<string, unknown> = { ...localValue }
  const credentialRepository = new IndexedDbCredentialRepository({
    databaseName: credentialDatabaseName
  })
  const storageRepository = new InterruptingStorageV2Repository(storageDatabaseName, interrupt)
  const retainedV1Storage = {
    async read(keys: readonly string[]) {
      return Object.fromEntries(keys.map(key => [key, local[key]]))
    },
    async write(values: Readonly<Record<string, unknown>>) {
      Object.assign(local, values)
    }
  }
  try {
    const result = await new CredentialPasswordChangeCoordinator({
      credentialRepository,
      storageRepository,
      retainedV1Storage
    }).changePassword({
      discovery: discoverV1Metadata(local),
      credentialEnvelopes: local,
      currentPassword,
      newPassword,
      chains: {
        zcashNetwork: 'mainnet',
        zcashChainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
        evmChainId: 'eip155:1',
        bitcoinChainId: 'bip122:000000000019d6689c085ae165831e93'
      }
    })
    const journal = await credentialRepository.getJournal(result.transactionId)
    const transition = journal?.transitions[0]
    const sourceSet =
      transition && transition.kind === 'replace'
        ? await credentialRepository.getCredentialSetByGeneration(
            transition.sourceCredentialGenerationId
          )
        : null
    const targetSet =
      transition && transition.kind === 'replace'
        ? await credentialRepository.getCredentialSet(transition.targetCredentialSetRef)
        : null
    const pointer = await storageRepository.getActivePointer()
    return {
      ok: true as const,
      result,
      journalPhase: journal?.phase ?? null,
      activeGenerationId: pointer?.generationId ?? null,
      sourceRetired: sourceSet
        ? Boolean(await credentialRepository.getRetirement(sourceSet.credentialSetRef))
        : false,
      sourceZcashEnvelopePresent:
        sourceSet?.manifest.source === 'software'
          ? Boolean(
              await credentialRepository.getEnvelope(sourceSet.manifest.engines.zcash.credentialRef)
            )
          : null,
      targetActivation:
        targetSet === null
          ? null
          : (
              await credentialRepository.validateForActivation(
                targetSet.credentialSetRef,
                targetSet.manifest.keyDomainId
              )
            ).status,
      local
    }
  } catch (error) {
    const pointer = await storageRepository.getActivePointer()
    const pending = await credentialRepository.findIncompleteJournal('change-password')
    return {
      ok: false as const,
      code: error instanceof Error ? error.message : 'UNKNOWN',
      activeGenerationId: pointer?.generationId ?? null,
      pendingPhase: pending?.phase ?? null,
      targetGenerationId: pending?.targetMetadataGenerationId ?? null,
      local
    }
  }
}

async function prepareProductionV2PasswordChange(currentPassword: string) {
  const credentialDatabaseName = 'noir-wallet-credential-db'
  const storageDatabaseName = 'noir-wallet-storage-v2-db'
  await resetRetainedMigrationDatabases(credentialDatabaseName, storageDatabaseName)
  const fixture = await prepareRetainedMigrationFixture(currentPassword)
  const local = {
    ...fixture,
    wallet_state: JSON.parse(fixture.wallet_state as string)
  }
  await chrome.storage.local.clear()
  await chrome.storage.local.set(local)
  const migrated = await runRetainedMigration(
    credentialDatabaseName,
    storageDatabaseName,
    local,
    currentPassword
  )
  if (!migrated.ok) throw new Error(migrated.code)

  return migrated
}

async function prepareProductionV1Migration(
  password: string,
  wordCount: 12 | 24 = 12,
  corruptZcashAnchor = false,
  options: RetainedV1FixtureOptions = {}
) {
  const credentialDatabaseName = 'noir-wallet-credential-db'
  const storageDatabaseName = 'noir-wallet-storage-v2-db'
  await resetRetainedMigrationDatabases(credentialDatabaseName, storageDatabaseName)
  const fixture = await prepareRetainedMigrationFixture(password, wordCount, options)
  const walletState = JSON.parse(fixture.wallet_state as string) as {
    state: {
      wallets: Array<{
        accounts: Array<{ addresses: { transparent: string } }>
      }>
    }
  }
  if (corruptZcashAnchor) {
    walletState.state.wallets[0].accounts[0].addresses.transparent =
      TEST_ZCASH_24_ADDRESSES.transparent
  }
  const local = {
    ...fixture,
    wallet_state: walletState
  }
  await chrome.storage.local.clear()
  await chrome.storage.session.clear()
  await chrome.storage.local.set(local)
  return {
    walletId: 'wallet:retained-v1-e2e',
    wordCount,
    network: options.network ?? 'mainnet'
  }
}

async function prepareProductionV1WalletAndAccountInventory(password: string) {
  const credentialDatabaseName = 'noir-wallet-credential-db'
  const storageDatabaseName = 'noir-wallet-storage-v2-db'
  await resetRetainedMigrationDatabases(credentialDatabaseName, storageDatabaseName)
  const fixture = await prepareRetainedInventoryFixture(password)
  const target = structuredClone(fixture.target) as Record<string, unknown>
  const walletState = JSON.parse(target.wallet_state as string) as {
    state: {
      currentWalletId: string
      currentAccountId: string
      wallets: Array<{ id: string; accounts: Array<Record<string, unknown>> }>
    }
  }
  const addedWallet = walletState.state.wallets.find(wallet => wallet.id === fixture.walletId)
  if (!addedWallet) throw new Error('Production credential session fixture Wallet is missing')
  const secondAccountId = `${fixture.walletId}:account:1`
  addedWallet.accounts.push({
    id: secondAccountId,
    name: 'Account 2',
    derivationIndex: 1,
    birthdayHeight: 2_000_000,
    addresses: TEST_ZCASH_ACCOUNT_1_ADDRESSES,
    isPinned: false,
    isHidden: false,
    createdAt: 1_700_000_200_000
  })
  walletState.state.currentWalletId = fixture.walletId
  walletState.state.currentAccountId = secondAccountId
  target.wallet_state = JSON.stringify(walletState)

  const synchronized = await runRetainedInventorySync(
    credentialDatabaseName,
    storageDatabaseName,
    fixture.initial,
    target,
    password
  )
  if (!synchronized.ok) throw new Error(synchronized.code)
  const productionLocal = { ...target, wallet_state: walletState }
  await chrome.storage.local.clear()
  await chrome.storage.session.clear()
  await chrome.storage.local.set(productionLocal)
  const persisted = await chrome.storage.local.get(['wallet_state', `seed_${fixture.walletId}`])
  const persistedState = persisted.wallet_state as {
    state?: { currentWalletId?: string; currentAccountId?: string }
  }
  if (
    persistedState.state?.currentWalletId !== fixture.walletId ||
    persistedState.state.currentAccountId !== secondAccountId ||
    !(await verifyV1CredentialEnvelope(persisted[`seed_${fixture.walletId}`], password))
  ) {
    throw new Error('Production credential session fixture verification failed')
  }
  return {
    walletId: fixture.walletId,
    accountIds: [fixture.accountId, secondAccountId],
    previousWalletId: 'wallet:retained-v1-e2e',
    previousAccountId: 'account:retained-v1-e2e:0'
  }
}

async function inspectProductionV2Provisioning() {
  const storageRepository = new IndexedDbStorageV2Repository()
  const credentialRepository = new IndexedDbCredentialRepository()
  const pointer = await storageRepository.getActivePointer()
  const snapshot = pointer ? await storageRepository.getSnapshot(pointer.generationId) : null
  const credentialPolicies = snapshot
    ? await Promise.all(
        snapshot.keyDomains.map(async keyDomain => {
          const credentialSet = await credentialRepository.getCredentialSet(keyDomain.credentialRef)
          return {
            keyDomainId: keyDomain.id,
            source: credentialSet?.manifest.source ?? null,
            mnemonicWordCount:
              credentialSet?.manifest.source === 'software'
                ? credentialSet.manifest.mnemonicWordCount
                : null,
            zcashSeedPolicy:
              credentialSet?.manifest.source === 'software'
                ? credentialSet.manifest.zcashSeedPolicy
                : null
          }
        })
      )
    : []
  return {
    activeGenerationId: pointer?.generationId ?? null,
    mainKeyDomainId: snapshot?.manifest.mainKeyDomainId ?? null,
    activeAccount: snapshot?.manifest.activeAccount ?? null,
    keyDomainIds: snapshot?.keyDomains.map(item => item.id) ?? [],
    accountIds: snapshot?.accounts.map(item => item.id) ?? [],
    accounts:
      snapshot?.accounts.map(item => ({
        id: item.id,
        displayName: item.displayName
      })) ?? [],
    chainAccounts:
      snapshot?.chainAccounts.map(item => ({
        keyDomainId: item.scope.keyDomainId,
        accountId: item.scope.accountId,
        chainId: item.scope.chainId,
        path: item.derivation.path,
        identity: item.identity.value
      })) ?? [],
    addressSchemes: [...new Set(snapshot?.addresses.map(item => item.scheme) ?? [])].sort(),
    credentialPolicies
  }
}

async function productionCredentialAuthentication(password?: string) {
  const storageRepository = new IndexedDbStorageV2Repository()
  const credentialRepository = new IndexedDbCredentialRepository()
  const pointer = await storageRepository.getActivePointer()
  const snapshot = pointer ? await storageRepository.getSnapshot(pointer.generationId) : null
  if (!snapshot) return []

  return Promise.all(
    snapshot.keyDomains
      .filter(keyDomain => keyDomain.source.kind === 'software')
      .map(async keyDomain => {
        const credentialSet = await credentialRepository.getCredentialSet(keyDomain.credentialRef)
        if (!credentialSet || credentialSet.manifest.source !== 'software') {
          throw new Error('Production software CredentialSet is missing')
        }
        const zcash = await credentialRepository.getEnvelope(
          credentialSet.manifest.engines.zcash.credentialRef
        )
        const multichain = await credentialRepository.getEnvelope(
          credentialSet.manifest.engines.multichain.credentialRef
        )
        if (!zcash || !multichain) throw new Error('Production credential envelope is missing')
        const format = credentialEnvelopePairFormat({ zcash, multichain })
        if (password !== undefined && format === 'authenticated') {
          await unwrapSoftwareCredentialEnvelopePair({ zcash, multichain }, password)
        }
        return {
          keyDomainId: keyDomain.id,
          generationId: credentialSet.manifest.credentialGenerationId,
          format,
          aadSchemaVersions: [zcash.aad.schemaVersion, multichain.aad.schemaVersion],
          engineFormats: [
            credentialSet.manifest.engines.zcash.formatVersion,
            credentialSet.manifest.engines.multichain.formatVersion
          ],
          verified: password !== undefined && format === 'authenticated'
        }
      })
  )
}

async function downgradeProductionCredentialAuthenticationToLegacy(password: string) {
  const credentialRepository = new IndexedDbCredentialRepository()
  const storageRepository = new IndexedDbStorageV2Repository()
  const pointer = await storageRepository.getActivePointer()
  const snapshot = pointer ? await storageRepository.getSnapshot(pointer.generationId) : null
  if (!snapshot) throw new Error('Production Storage V2 is not active')

  const envelopes = []
  for (const keyDomain of snapshot.keyDomains) {
    if (keyDomain.source.kind !== 'software') continue
    const credentialSet = await credentialRepository.getCredentialSet(keyDomain.credentialRef)
    if (!credentialSet || credentialSet.manifest.source !== 'software') {
      throw new Error('Production software CredentialSet is missing')
    }
    const zcash = await credentialRepository.getEnvelope(
      credentialSet.manifest.engines.zcash.credentialRef
    )
    const multichain = await credentialRepository.getEnvelope(
      credentialSet.manifest.engines.multichain.credentialRef
    )
    if (!zcash || !multichain) throw new Error('Production credential envelope is missing')
    const payloads = await unwrapSoftwareCredentialEnvelopePair({ zcash, multichain }, password)
    envelopes.push(
      {
        ...zcash,
        aad: { ...zcash.aad, schemaVersion: 1 },
        encryptedPayload: payloads.zcash
      },
      {
        ...multichain,
        aad: { ...multichain.aad, schemaVersion: 1 },
        encryptedPayload: payloads.multichain
      }
    )
  }

  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('noir-wallet-credential-db')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('encryptedCredentialEnvelopes', 'readwrite')
      const envelopeStore = transaction.objectStore('encryptedCredentialEnvelopes')
      envelopes.forEach(envelope => envelopeStore.put(envelope))
      transaction.oncomplete = () => {
        database.close()
        resolve()
      }
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    }
  })
  return productionCredentialAuthentication()
}

async function tamperProductionCredentialEnvelope() {
  const credentialRepository = new IndexedDbCredentialRepository()
  const storageRepository = new IndexedDbStorageV2Repository()
  const pointer = await storageRepository.getActivePointer()
  const snapshot = pointer ? await storageRepository.getSnapshot(pointer.generationId) : null
  const keyDomain = snapshot?.keyDomains.find(item => item.source.kind === 'software')
  if (!keyDomain) throw new Error('Production software KeyDomain is missing')
  const credentialSet = await credentialRepository.getCredentialSet(keyDomain.credentialRef)
  if (!credentialSet || credentialSet.manifest.source !== 'software') {
    throw new Error('Production software CredentialSet is missing')
  }
  const envelope = await credentialRepository.getEnvelope(
    credentialSet.manifest.engines.multichain.credentialRef
  )
  if (!envelope) throw new Error('Production Multichain credential envelope is missing')
  const encryptedPayload = new Uint8Array(envelope.encryptedPayload)
  encryptedPayload[encryptedPayload.length - 1] ^= 1

  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('noir-wallet-credential-db')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('encryptedCredentialEnvelopes', 'readwrite')
      transaction.objectStore('encryptedCredentialEnvelopes').put({
        ...envelope,
        encryptedPayload
      })
      transaction.oncomplete = () => {
        database.close()
        resolve()
      }
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    }
  })
}

async function inspectProductionActiveWalletSet() {
  const active = await loadActiveWalletSet({
    repository: new IndexedDbStorageV2Repository(),
    chainRegistry: TEST_RELEASED_CHAIN_REGISTRY
  })
  if (!active) return null
  return {
    generationId: active.generationId,
    activeAccountId: active.activeAccount?.id ?? null,
    availableChainAccounts: active.availableChainAccounts.map(item => ({
      chainId: item.chain.id,
      chainAccountId: item.chainAccount.id,
      addressSchemes: item.addresses.map(address => address.scheme).sort(),
      preferredReceiveAddressIds: item.addresses
        .filter(address => address.preferredForReceive)
        .map(address => address.id)
        .sort()
    }))
  }
}

async function inspectProductionV2PasswordChange(currentPassword: string, newPassword: string) {
  const persisted = await chrome.storage.local.get('seed_wallet:retained-v1-e2e')
  const envelope = persisted['seed_wallet:retained-v1-e2e']
  const repository = new IndexedDbCredentialRepository()
  const pending = await repository.findIncompleteJournal('change-password')
  const storageRepository = new IndexedDbStorageV2Repository()
  const pointer = await storageRepository.getActivePointer()
  return {
    sessionPassword:
      (await chrome.storage.session.get('session_password')).session_password ?? null,
    acceptsNewPassword: await verifyV1CredentialEnvelope(envelope, newPassword),
    acceptsOldPassword: await verifyV1CredentialEnvelope(envelope, currentPassword),
    pendingPhase: pending?.phase ?? null,
    activeGenerationId: pointer?.generationId ?? null
  }
}

async function prepareProductionV2Removal(password: string, kind: 'account' | 'wallet') {
  const credentialDatabaseName = 'noir-wallet-credential-db'
  const storageDatabaseName = 'noir-wallet-storage-v2-db'
  await resetRetainedMigrationDatabases(credentialDatabaseName, storageDatabaseName)
  const fixture =
    kind === 'wallet'
      ? await prepareRetainedInventoryFixture(password)
      : await prepareRetainedAccountInventoryFixture(password)
  const local = {
    ...fixture.target,
    wallet_state: JSON.parse(fixture.target.wallet_state as string)
  }
  await chrome.storage.local.clear()
  await chrome.storage.local.set(local)
  const initialized = await runRetainedInventorySync(
    credentialDatabaseName,
    storageDatabaseName,
    fixture.initial,
    fixture.target,
    password
  )
  if (!initialized.ok) throw new Error(initialized.code)
  const storageRepository = new IndexedDbStorageV2Repository()
  const pointer = await storageRepository.getActivePointer()
  const snapshot = pointer ? await storageRepository.getSnapshot(pointer.generationId) : null
  const keyDomain = snapshot?.keyDomains.find(item => item.id === fixture.walletId)
  if (!keyDomain) throw new Error('Production removal target CredentialSet is missing')
  return {
    kind,
    walletId: fixture.walletId,
    accountId: fixture.accountId,
    credentialSetRef: keyDomain.credentialRef
  }
}

async function inspectProductionV2Removal(
  target: Readonly<{
    kind: 'account' | 'wallet'
    walletId: string
    accountId: string
    credentialSetRef: string
  }>
) {
  const storageRepository = new IndexedDbStorageV2Repository()
  const credentialRepository = new IndexedDbCredentialRepository()
  const pointer = await storageRepository.getActivePointer()
  const snapshot = pointer ? await storageRepository.getSnapshot(pointer.generationId) : null
  const credentialSetRef = parseCredentialRef(target.credentialSetRef)
  const credentialSet = await credentialRepository.getCredentialSet(credentialSetRef)
  const envelopePresence =
    credentialSet?.manifest.source === 'software'
      ? await Promise.all(
          Object.values(credentialSet.manifest.engines)
            .filter(engine => engine !== undefined)
            .map(async engine =>
              Boolean(await credentialRepository.getEnvelope(engine.credentialRef))
            )
        )
      : null
  const local = await chrome.storage.local.get(null)
  const walletState =
    typeof local.wallet_state === 'string' ? JSON.parse(local.wallet_state) : local.wallet_state
  const wallet = walletState?.state?.wallets?.find(
    (item: { id?: unknown }) => item.id === target.walletId
  )
  const survivorChainAccounts =
    snapshot?.chainAccounts.filter(account => account.scope.keyDomainId !== target.walletId) ?? []
  const survivorChainAccountIds = new Set(survivorChainAccounts.map(account => account.id))
  return {
    counts: snapshot?.manifest.counts ?? null,
    survivorChainAccounts: survivorChainAccounts.map(account => ({
      scope: account.scope,
      derivation: account.derivation,
      identity: account.identity
    })),
    survivorAddresses:
      snapshot?.addresses
        .filter(address => survivorChainAccountIds.has(address.chainAccountId))
        .map(address => ({
          chainAccountId: address.chainAccountId,
          value: address.value,
          scheme: address.scheme,
          purpose: address.purpose
        })) ?? [],
    targetKeyDomainPresent:
      snapshot?.keyDomains.some(keyDomain => keyDomain.id === target.walletId) ?? null,
    targetAccountPresent:
      snapshot?.accounts.some(account => account.id === target.accountId) ?? null,
    credentialRetired: Boolean(await credentialRepository.getRetirement(credentialSetRef)),
    credentialActivation: credentialSet
      ? (
          await credentialRepository.validateForActivation(
            credentialSet.credentialSetRef,
            credentialSet.manifest.keyDomainId
          )
        ).status
      : null,
    credentialEnvelopesPresent: envelopePresence?.some(Boolean) ?? null,
    v1WalletPresent: Boolean(wallet),
    v1AccountPresent: Boolean(
      wallet?.accounts?.some((account: { id?: unknown }) => account.id === target.accountId)
    ),
    v1CredentialPresent: local[`seed_${target.walletId}`] !== undefined,
    pendingPhase: (await credentialRepository.findIncompleteJournal('remove'))?.phase ?? null
  }
}

async function inspectProductionV2DatabasePresence() {
  const databases = await indexedDB.databases()
  const names = new Set(databases.map(database => database.name))
  return {
    credentialDatabasePresent: names.has('noir-wallet-credential-db'),
    storageDatabasePresent: names.has('noir-wallet-storage-v2-db')
  }
}

function storageV2Snapshot(generationId: string) {
  const keyDomainId = 'wallet:storage-v2-e2e'
  const accountId = 'account:storage-v2-e2e'
  const evmChainAccountId = 'chain-account:storage-v2-e2e:evm'
  return {
    manifest: {
      schemaVersion: 2 as const,
      generationId,
      status: 'verified' as const,
      sourceFingerprint: 'b'.repeat(64),
      mainKeyDomainId: keyDomainId,
      counts: { keyDomains: 1, accounts: 1, chainAccounts: 1, addresses: 1 },
      createdAt: 2_000,
      verifiedAt: 2_001
    },
    keyDomains: [
      {
        id: keyDomainId,
        credentialRef: 'credential-set:storage-v2-e2e',
        source: { kind: 'software' as const, mnemonicWordCount: 12 },
        displayName: 'Wallet 1',
        createdAt: 1_000
      }
    ],
    accounts: [
      {
        id: accountId,
        keyDomainId,
        accountIndex: 0,
        displayName: 'Account 1',
        createdAt: 1_000
      }
    ],
    chainAccounts: [
      {
        id: evmChainAccountId,
        scope: { keyDomainId, accountId, chainId: 'eip155:1' },
        derivation: { scheme: 'bip44', path: "m/44'/60'/0'/0/0" },
        identity: {
          kind: 'account-identifier' as const,
          value: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
        },
        createdAt: 1_000
      }
    ],
    addresses: [
      {
        id: 'address:storage-v2-e2e:evm',
        chainAccountId: evmChainAccountId,
        value: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
        scheme: 'evm',
        purpose: 'identity' as const,
        derivation: { scheme: 'bip44', path: "m/44'/60'/0'/0/0" },
        rotatable: false,
        preferredForReceive: true,
        privacy: 'transparent' as const,
        walletCompatibility: 'broad' as const
      }
    ]
  }
}

async function stageStorageV2(databaseName: string, generationId: string) {
  const repository = new IndexedDbStorageV2Repository({ databaseName })
  await repository.stage(storageV2Snapshot(generationId))
  return { generationId: (await repository.getManifest(generationId))?.generationId ?? null }
}

async function readAndCommitStorageV2(databaseName: string, generationId: string) {
  const repository = new IndexedDbStorageV2Repository({ databaseName })
  const snapshot = await repository.getSnapshot(generationId)
  const accounts = await repository.listAccounts(generationId, 'wallet:storage-v2-e2e')
  const commit = await repository.commit(
    {
      schemaVersion: 2,
      generationId,
      sourceFingerprint: 'b'.repeat(64),
      committedAt: 2_002
    },
    null
  )
  let discard = 'discarded'
  try {
    await repository.discardUncommittedGeneration(generationId)
  } catch {
    discard = 'rejected'
  }
  return {
    snapshotGenerationId: snapshot?.manifest.generationId ?? null,
    chainIdentity: snapshot?.chainAccounts[0]?.identity.value ?? null,
    accountIds: accounts.map(account => account.id),
    commit,
    activeGenerationId: (await repository.getActivePointer())?.generationId ?? null,
    discard
  }
}

async function raceStorageV2Commit(databaseName: string) {
  const firstGeneration = 'metadata:storage-v2-race:first'
  const secondGeneration = 'metadata:storage-v2-race:second'
  const first = new IndexedDbStorageV2Repository({ databaseName })
  const second = new IndexedDbStorageV2Repository({ databaseName })
  await first.stage(storageV2Snapshot(firstGeneration))
  await second.stage(storageV2Snapshot(secondGeneration))
  const pointer = (generationId: string) => ({
    schemaVersion: 2 as const,
    generationId,
    sourceFingerprint: 'b'.repeat(64),
    committedAt: 2_002
  })
  const results = await Promise.all([
    first.commit(pointer(firstGeneration), null),
    second.commit(pointer(secondGeneration), null)
  ])
  return {
    results: results.sort(),
    activeGenerationId: (await first.getActivePointer())?.generationId ?? null
  }
}

async function stageAfterInterruption(databaseName: string) {
  const repository = new IndexedDbCredentialRepository({ databaseName })
  return {
    journal: await repository.createJournal(journal()),
    zcash: await repository.putEnvelope(envelope('zcash', [11, 12, 13]))
  }
}

async function resumeAndVerify(databaseName: string) {
  const repository = new IndexedDbCredentialRepository({ databaseName })
  const multichain = await repository.putEnvelope(envelope('multichain', [21, 22, 23]))
  const set = await repository.putCredentialSet(credentialSet())
  const advanced = await repository.advanceJournal(journal('verified', 1), 0)
  const storedZcash = await repository.getEnvelope(engineRef('zcash'))
  const storedSet = await repository.getCredentialSetByGeneration(GENERATION_ID)
  return {
    multichain,
    set,
    advanced,
    zcashBytes: storedZcash ? [...storedZcash.encryptedPayload] : null,
    credentialSetRef: storedSet?.credentialSetRef ?? null,
    activation: await repository.validateForActivation(CREDENTIAL_SET_REF, KEY_DOMAIN_ID)
  }
}

async function raceJournalAdvance(databaseName: string) {
  const first = new IndexedDbCredentialRepository({ databaseName })
  const second = new IndexedDbCredentialRepository({ databaseName })
  await first.createJournal(journal())
  await first.putEnvelope(envelope('zcash', [41, 42, 43]))
  await first.putEnvelope(envelope('multichain', [51, 52, 53]))
  await first.putCredentialSet(credentialSet())
  const [verified, failed] = await Promise.all([
    first.advanceJournal(journal('verified', 1), 0),
    second.advanceJournal(journal('failed', 1), 0)
  ])
  return {
    verified,
    failed,
    phase: (await first.getJournal(TRANSACTION_ID))?.phase ?? null
  }
}

async function corruptAndRead(databaseName: string) {
  const repository = new IndexedDbCredentialRepository({ databaseName })
  await repository.createJournal(journal())
  await repository.putEnvelope(envelope('zcash', [31, 32, 33]))
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(databaseName)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('credentialTransactionJournals', 'readwrite')
      transaction.objectStore('credentialTransactionJournals').put({
        ...journal(),
        password: 'must-never-be-accepted'
      })
      transaction.oncomplete = () => {
        database.close()
        resolve()
      }
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    }
    request.onerror = () => reject(request.error)
  })
  try {
    await repository.validateForActivation(CREDENTIAL_SET_REF, KEY_DOMAIN_ID)
    return 'accepted'
  } catch {
    return 'rejected'
  }
}

Object.assign(globalThis, {
  credentialRepositoryIntegration: Object.freeze({
    reset: deleteDatabase,
    stageAfterInterruption,
    resumeAndVerify,
    raceJournalAdvance,
    corruptAndRead,
    migrateCanonicalMnemonic24,
    migrateV1Credential,
    migrateRotatedV1Credential,
    migrateMismatchedFullUnifiedV1Credential,
    verifyV1CredentialEnvelope,
    rewrapV1Credential,
    prepareRetainedMigrationFixture,
    prepareRotatedRetainedMigrationFixture,
    prepareRetainedInventoryFixture,
    prepareRetainedAccountInventoryFixture,
    runRetainedMigration,
    runRetainedInventorySync,
    initializeCredentialRemoval,
    runCredentialRemoval,
    runRetainedV1Reconciliation,
    resetRetainedMigrationDatabases,
    initializeCredentialPasswordChange,
    runCredentialPasswordChange,
    prepareProductionV2PasswordChange,
    prepareProductionV1Migration,
    prepareProductionV1WalletAndAccountInventory,
    inspectProductionV2Provisioning,
    productionCredentialAuthentication,
    downgradeProductionCredentialAuthenticationToLegacy,
    tamperProductionCredentialEnvelope,
    inspectProductionActiveWalletSet,
    inspectProductionV2PasswordChange,
    prepareProductionV2Removal,
    inspectProductionV2Removal,
    inspectProductionV2DatabasePresence,
    stageStorageV2,
    readAndCommitStorageV2,
    raceStorageV2Commit
  })
})
