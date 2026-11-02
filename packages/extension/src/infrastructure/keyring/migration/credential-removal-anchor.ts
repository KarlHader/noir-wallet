import {
  buildChainAccountVerificationAnchorRef,
  parseChainAccountVerificationAnchorRef
} from '@/core/keyring/application'
import type { CredentialEngine, CredentialSetManifest } from '@/core/keyring/domain'
import { getBitcoinChainId, getZcashChainId } from '@/core/chains/registry'
import type { StoredHardwareCredential } from '@/core/wallet/hardware-wallet-data'
import {
  projectKeystoneBitcoinAccounts,
  projectKeystoneMultiCoinAccounts
} from '@/lib/keystone/public-account-projection'
import type { StorageV2Snapshot } from '@/ports/repositories'
import type { CompatibilityWorkerHost } from './compatibility-worker-host'
import { decodeVault } from './credential-password-change-support'
import { decodeV1EncryptedCredentialEnvelope } from './v1-credential-envelope'

type ChainAccount = StorageV2Snapshot['chainAccounts'][number]
type Network = 'mainnet' | 'testnet'

export interface AccountRemovalAnchors {
  readonly replacements: Readonly<Partial<Record<CredentialEngine, ChainAccount>>>
  readonly accountId: string
}

function engineEntries(manifest: CredentialSetManifest) {
  return (
    Object.entries(manifest.engines) as [
      CredentialEngine,
      CredentialSetManifest['engines']['multichain']
    ][]
  ).filter(
    (entry): entry is [CredentialEngine, NonNullable<(typeof entry)[1]>] => entry[1] !== undefined
  )
}

export function selectAccountRemovalAnchors(
  source: StorageV2Snapshot,
  keyDomainId: string,
  accountId: string,
  manifest: CredentialSetManifest
): AccountRemovalAnchors {
  const remaining = source.accounts
    .filter(account => account.keyDomainId === keyDomainId && account.id !== accountId)
    .sort((a, b) => a.accountIndex - b.accountIndex || a.id.localeCompare(b.id))
  const replacements: Partial<Record<CredentialEngine, ChainAccount>> = {}
  for (const [engine, metadata] of engineEntries(manifest)) {
    const anchorId = parseChainAccountVerificationAnchorRef(metadata.verificationAnchorRef)
    const oldAnchor = source.chainAccounts.find(account => account.id === anchorId)
    if (!oldAnchor || oldAnchor.scope.keyDomainId !== keyDomainId) {
      throw new Error('Account removal credential anchor is invalid')
    }
    if (oldAnchor.scope.accountId !== accountId) continue
    const candidate = remaining
      .map(account =>
        source.chainAccounts.find(
          chainAccount =>
            chainAccount.scope.keyDomainId === keyDomainId &&
            chainAccount.scope.accountId === account.id &&
            chainAccount.scope.chainId === oldAnchor.scope.chainId
        )
      )
      .find((value): value is ChainAccount => value !== undefined)
    if (!candidate) throw new Error(`No verified ${engine} account remains for removal`)
    replacements[engine] = candidate
  }
  if (
    new Set(Object.values(replacements).map(account => account.id)).size !==
    Object.values(replacements).length
  ) {
    throw new Error('Account removal credential anchors are not distinct')
  }
  return Object.freeze({ replacements: Object.freeze(replacements), accountId })
}

export function replacementAnchorRefs(
  manifest: CredentialSetManifest,
  anchors: AccountRemovalAnchors
): CredentialSetManifest['engines'] {
  return Object.fromEntries(
    engineEntries(manifest).map(([engine, metadata]) => [
      engine,
      {
        ...metadata,
        verificationAnchorRef: anchors.replacements[engine]
          ? buildChainAccountVerificationAnchorRef(anchors.replacements[engine].id)
          : metadata.verificationAnchorRef
      }
    ])
  ) as CredentialSetManifest['engines']
}

function assertProjection(
  actual: { chainId: string; identity: string; derivationPath: string },
  stored: ChainAccount
) {
  if (
    actual.chainId !== stored.scope.chainId ||
    actual.identity !== stored.identity.value ||
    actual.derivationPath !== stored.derivation.path
  ) {
    throw new Error('Account removal credential proof does not match retained account')
  }
}

export async function proveSoftwareAccountRemovalAnchors(input: {
  readonly source: StorageV2Snapshot
  readonly keyDomainId: string
  readonly anchors: AccountRemovalAnchors
  readonly zcashPayload: Uint8Array
  readonly multichainPayload: Uint8Array
  readonly password: string
  readonly worker: Pick<CompatibilityWorkerHost, 'migrate'>
  readonly network: Network
}): Promise<void> {
  const selected = Object.values(input.anchors.replacements)
  if (selected.length === 0) return
  const owner = input.source.accounts.find(account => account.id === selected[0].scope.accountId)
  if (!owner || selected.some(chainAccount => chainAccount.scope.accountId !== owner.id)) {
    throw new Error('Account removal engines require one retained Account proof')
  }
  const find = (chainId: string) =>
    input.source.chainAccounts.find(
      account => account.scope.accountId === owner.id && account.scope.chainId === chainId
    )
  const zcash = find(getZcashChainId(input.network))
  const bitcoin = find(getBitcoinChainId(input.network))
  const evmAnchor = input.anchors.replacements.multichain
  if (!evmAnchor?.scope.chainId.startsWith('eip155:')) {
    throw new Error('Retained software EVM anchor proof is unavailable')
  }
  const evm = find(evmAnchor.scope.chainId)
  if (!zcash || !bitcoin || !evm) {
    throw new Error('Retained software Account proof is incomplete')
  }
  const transparent = input.source.addresses.find(
    address => address.chainAccountId === zcash.id && address.scheme === 'zcash-transparent-p2pkh'
  )?.value
  const shielded = input.source.addresses.find(
    address => address.chainAccountId === zcash.id && address.scheme === 'zcash-shielded-unified'
  )?.value
  if (!transparent || !shielded) throw new Error('Retained Zcash Account addresses are missing')
  const result = await input.worker.migrate({
    operation: 'migrate',
    envelope: decodeV1EncryptedCredentialEnvelope(input.zcashPayload),
    password: input.password,
    targetVault: decodeVault(input.multichainPayload),
    zcashNetwork: input.network,
    zcashChainId: zcash.scope.chainId,
    evmChainId: evm.scope.chainId,
    bitcoinChainId: bitcoin.scope.chainId,
    accounts: [{ accountIndex: owner.accountIndex, expectedZcash: { transparent, shielded } }]
  })
  const derived = result.accounts.find(account => account.accountIndex === owner.accountIndex)
  if (!derived || result.accounts.length !== 1)
    throw new Error('Retained Account proof is incomplete')
  assertProjection(derived.zcash, zcash)
  assertProjection(derived.evm, evm)
  assertProjection(derived.bitcoin, bitcoin)
  for (const candidate of selected) {
    if (![zcash.id, evm.id, bitcoin.id].includes(candidate.id)) {
      throw new Error('Account removal anchor is outside the verified account')
    }
  }
}

function familyForChain(chainId: string, network: Network) {
  if (chainId === getZcashChainId(network)) return 'zcash'
  if (chainId === getBitcoinChainId(network)) return 'bitcoin'
  if (chainId.startsWith('eip155:')) return 'evm'
  if (chainId.startsWith('solana:')) return 'solana'
  if (chainId.startsWith('near:')) return 'near'
  return null
}

export function proveHardwareAccountRemovalAnchors(
  source: StorageV2Snapshot,
  anchors: AccountRemovalAnchors,
  credential: StoredHardwareCredential,
  network: Network
): void {
  for (const candidate of Object.values(anchors.replacements)) {
    const owner = source.accounts.find(account => account.id === candidate.scope.accountId)
    const family = familyForChain(candidate.scope.chainId, network)
    if (!owner || !family) throw new Error('Hardware account removal proof is unavailable')
    if (
      credential.vendor === 'ledger' &&
      credential.accountExport.protocol === 'ledger-accounts-v1'
    ) {
      const matches = credential.accountExport.accounts.filter(
        account =>
          account.accountIndex === owner.accountIndex &&
          account.family === family &&
          (!('network' in account) || account.network === network)
      )
      if (matches.length !== 1 || family === 'zcash') {
        throw new Error('Hardware account removal proof is unavailable')
      }
      const account = matches[0]
      const identity = 'address' in account ? account.address : null
      const path = family === 'bitcoin' ? `${account.derivationPath}/0/0` : account.derivationPath
      if (identity !== candidate.identity.value || path !== candidate.derivation.path) {
        throw new Error('Hardware account removal proof does not match retained account')
      }
      continue
    }
    if (credential.vendor === 'keystone' && (family === 'evm' || family === 'bitcoin')) {
      const exported = credential.accountExport
      const projected =
        exported.protocol === 'crypto-multi-accounts-v1'
          ? projectKeystoneMultiCoinAccounts(
              {
                type: 'multi-accounts',
                masterFingerprintHex: exported.masterFingerprintHex,
                keys: exported.keys,
                ...(exported.device === undefined ? {} : { device: exported.device }),
                ...(exported.deviceId === undefined ? {} : { deviceId: exported.deviceId }),
                ...(exported.version === undefined ? {} : { version: exported.version })
              },
              network
            )
          : exported.protocol === 'crypto-account-v1'
            ? projectKeystoneBitcoinAccounts(
                {
                  type: 'bitcoin-account',
                  masterFingerprintHex: exported.masterFingerprintHex,
                  descriptors: exported.descriptors
                },
                network
              )
            : []
      const matches = projected.filter(
        account => account.accountIndex === owner.accountIndex && account.family === family
      )
      if (
        matches.length !== 1 ||
        matches[0].identity !== candidate.identity.value ||
        matches[0].derivationPath !== candidate.derivation.path
      ) {
        throw new Error('Hardware account removal proof does not match retained account')
      }
      continue
    }
    throw new Error('Hardware account removal proof is unavailable')
  }
}
