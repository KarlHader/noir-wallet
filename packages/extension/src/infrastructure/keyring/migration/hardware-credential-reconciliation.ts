import { hardwareCredentialMetadataEquals } from '@/core/keyring/domain'
import { findLedgerPublicAccount } from '@/core/wallet/ledger-hardware-credential'
import { isNativeHardwareWalletId } from '@/core/wallet/native-hardware-identity'
import { getZcashChainId } from '@/core/chains/registry'
import { SecureStorage } from '@/core/wallet/secure-storage'
import { parseChainAccountVerificationAnchorRef } from '@/core/keyring/application'
import { unwrapHardwareCredentialEnvelope } from '@/infrastructure/keyring/credential-envelope-authentication'
import type { V1MetadataDiscovery } from '@/infrastructure/persistence/migrations'
import type { CredentialRepository, StorageV2Snapshot } from '@/ports/repositories'
import {
  hardwareCredentialMatchesMetadata,
  hardwareCredentialEnvelopeEquals,
  ledgerMultichainCredentialEquals,
  readHardwareCredentialEnvelope
} from './hardware-credential-password-change'
import {
  decodeV1EncryptedCredentialEnvelope,
  parseV1EncryptedCredentialEnvelope
} from './v1-credential-envelope'

export async function reconcileActiveHardwareCredentials(
  repository: CredentialRepository,
  snapshot: StorageV2Snapshot,
  discovery: V1MetadataDiscovery,
  credentialEnvelopes: Readonly<Record<string, unknown>>,
  password: string,
  options: Readonly<{
    allowRemovedWallets?: boolean
    allowNativeV2Wallets?: boolean
  }> = {}
): Promise<void> {
  if (discovery.status !== 'ready' || discovery.wallets.length === 0) {
    throw new Error('Active hardware credential inventory does not match retained V1')
  }
  const hardwareWallets = discovery.wallets.filter(wallet => wallet.keySource !== 'software')
  const hardwareKeyDomains = snapshot.keyDomains.filter(
    keyDomain => keyDomain.source.kind === 'hardware'
  )
  const retainedHardwareKeyDomains = hardwareKeyDomains.filter(
    keyDomain =>
      !(
        options.allowNativeV2Wallets &&
        isNativeHardwareWalletId(keyDomain.id) &&
        !hardwareWallets.some(wallet => wallet.id === keyDomain.id)
      )
  )
  if (
    (!options.allowRemovedWallets && hardwareWallets.length === 0) ||
    hardwareWallets.some(
      wallet => !retainedHardwareKeyDomains.some(keyDomain => keyDomain.id === wallet.id)
    ) ||
    (!options.allowRemovedWallets && hardwareWallets.length !== retainedHardwareKeyDomains.length)
  ) {
    throw new Error('Active hardware credential inventory does not match retained V1')
  }
  const wallets = new Map(hardwareWallets.map(wallet => [wallet.id, wallet]))
  if (wallets.size !== hardwareWallets.length) {
    throw new Error('Active hardware credential inventory contains duplicate Wallets')
  }

  for (const keyDomain of hardwareKeyDomains) {
    const wallet = wallets.get(keyDomain.id)
    if (!wallet && options.allowNativeV2Wallets && isNativeHardwareWalletId(keyDomain.id)) {
      continue
    }
    if (!wallet && options.allowRemovedWallets) continue
    if (!wallet || keyDomain.source.kind !== 'hardware') {
      throw new Error('Active hardware credential inventory does not match retained V1')
    }
    const liveEnvelope = parseV1EncryptedCredentialEnvelope(
      credentialEnvelopes[wallet.credentialStorageKey]
    )
    const liveCredential = await readHardwareCredentialEnvelope(liveEnvelope, password)
    const isMultiAppLedger =
      keyDomain.source.vendor === 'ledger' && keyDomain.source.firmwareProfile === 'multi-app'
    if (
      !isMultiAppLedger &&
      !hardwareCredentialMatchesMetadata(liveCredential, {
        vendor: keyDomain.source.vendor,
        firmwareProfile: keyDomain.source.firmwareProfile,
        capabilities: keyDomain.source.capabilities
      })
    ) {
      throw new Error('Retained V1 hardware credential metadata mismatch')
    }

    const activation = await repository.validateForActivation(keyDomain.credentialRef, keyDomain.id)
    if (
      activation.status !== 'active' ||
      !activation.record ||
      activation.record.manifest.source !== 'hardware' ||
      !hardwareCredentialMetadataEquals(keyDomain.source, activation.record.manifest.hardware)
    ) {
      throw new Error(`Active hardware CredentialSet is invalid: ${activation.status}`)
    }

    const retainedAccount = wallet.accounts[0]
    const storedAccount = snapshot.accounts.find(
      account =>
        account.keyDomainId === keyDomain.id &&
        account.id === retainedAccount?.id &&
        account.accountIndex === retainedAccount?.accountIndex
    )
    const zcashMetadata = activation.record.manifest.engines.zcash
    if (
      !retainedAccount ||
      wallet.accounts.length !== 1 ||
      !storedAccount ||
      (!zcashMetadata && !isMultiAppLedger)
    ) {
      throw new Error('Retained V1 hardware Account metadata mismatch')
    }
    const anchoredChainAccount = isMultiAppLedger
      ? snapshot.chainAccounts.find(
          account =>
            account.scope.keyDomainId === keyDomain.id &&
            account.scope.accountId === storedAccount.id &&
            (account.scope.chainId === getZcashChainId('mainnet') ||
              account.scope.chainId === getZcashChainId('testnet')) &&
            snapshot.addresses.some(
              address =>
                address.chainAccountId === account.id &&
                address.scheme === 'zcash-shielded-unified' &&
                address.value === retainedAccount.addresses.shielded
            ) &&
            snapshot.addresses.some(
              address =>
                address.chainAccountId === account.id &&
                address.scheme === 'zcash-transparent-p2pkh' &&
                address.value === retainedAccount.addresses.transparent
            )
        )
      : snapshot.chainAccounts.find(
          account =>
            account.id ===
            parseChainAccountVerificationAnchorRef(zcashMetadata!.verificationAnchorRef)
        )
    if (
      !anchoredChainAccount ||
      anchoredChainAccount.scope.keyDomainId !== keyDomain.id ||
      anchoredChainAccount.scope.accountId !== storedAccount.id
    ) {
      throw new Error('Retained V1 hardware ChainAccount metadata mismatch')
    }
    const addresses = snapshot.addresses.filter(
      address => address.chainAccountId === anchoredChainAccount.id
    )
    const addressMatches = (scheme: string, value: string) =>
      addresses.filter(address => address.scheme === scheme && address.value === value).length === 1
    if (
      !addressMatches('zcash-transparent-p2pkh', retainedAccount.addresses.transparent) ||
      !addressMatches('zcash-shielded-unified', retainedAccount.addresses.shielded) ||
      (retainedAccount.addresses.fullUnified !== undefined &&
        !addressMatches('zcash-full-unified', retainedAccount.addresses.fullUnified))
    ) {
      throw new Error('Retained V1 hardware Address metadata mismatch')
    }

    for (const metadata of Object.values(activation.record.manifest.engines)) {
      if (!metadata) continue
      const envelope = await repository.getEnvelope(metadata.credentialRef)
      if (!envelope) throw new Error('Active hardware engine credential is missing')
      const retainedEnvelope = decodeV1EncryptedCredentialEnvelope(
        await unwrapHardwareCredentialEnvelope(envelope, password)
      )
      if (isMultiAppLedger) {
        const activeCredential = await readHardwareCredentialEnvelope(retainedEnvelope, password)
        if (activeCredential.vendor !== 'ledger' || activeCredential.schemaVersion !== 3) {
          throw new Error('Active Ledger multichain credential is invalid')
        }
        const zcashAccount = findLedgerPublicAccount(activeCredential, {
          family: 'zcash',
          accountIndex: retainedAccount.accountIndex,
          network:
            anchoredChainAccount.scope.chainId === getZcashChainId('mainnet')
              ? 'mainnet'
              : 'testnet'
        })
        if (
          !zcashAccount ||
          (liveCredential.accountExport.protocol === 'zcash-accounts-v1'
            ? liveCredential.accountExport.ufvk !== zcashAccount.ufvk ||
              liveCredential.accountExport.accountHdIndex !== zcashAccount.accountHdIndex
            : !ledgerMultichainCredentialEquals(liveCredential, activeCredential))
        ) {
          throw new Error('Active Ledger credential differs from retained Zcash Wallet')
        }
        if (liveCredential.schemaVersion !== 3) {
          await SecureStorage.saveLedgerHardwareCredential(wallet.id, activeCredential, password)
        }
      } else if (!hardwareCredentialEnvelopeEquals(retainedEnvelope, liveEnvelope)) {
        throw new Error('Active hardware credential differs from retained V1')
      }
    }
  }
}
