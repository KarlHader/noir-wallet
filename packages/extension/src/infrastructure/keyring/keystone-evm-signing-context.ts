import type { ChainAccount } from '@/core/accounts/domain'
import { parseEvmAccountBinding } from '@/infrastructure/chains/evm/evm-account'
import { parseKeyDomainId, type KeyDomainId } from '@/core/keyring/domain'
import type { KeystoneHardwareCredential } from '@/core/wallet/hardware-wallet-data'
import { projectKeystoneMultiCoinAccounts } from '@/lib/keystone'
import type {
  CredentialRepository,
  StorageV2ReadRepository,
  StorageV2Snapshot
} from '@/ports/repositories'
import { readActiveHardwareCredential } from './active-hardware-credential-inventory'
import type { HardwareCredentialSessionProvider } from './bitcoin-address-derivation-router'

type SigningStorageRepository = Pick<StorageV2ReadRepository, 'getActivePointer' | 'getSnapshot'>

export interface KeystoneEvmSigningContext {
  readonly derivationPath: string
  readonly masterFingerprintHex: string
  readonly address: string
}

export interface KeystoneEvmSigningContextResolverOptions {
  readonly storageRepository: SigningStorageRepository
  readonly credentialRepository: CredentialRepository
  readonly credentials: HardwareCredentialSessionProvider
  readonly network: 'mainnet' | 'testnet'
}

interface CachedHardwareCredential {
  readonly generationId: string
  readonly credential: KeystoneHardwareCredential
}

export class KeystoneEvmSigningContextResolver {
  private readonly hardwareCredentials = new Map<KeyDomainId, CachedHardwareCredential>()

  constructor(private readonly options: KeystoneEvmSigningContextResolverOptions) {}

  async resolve(chainAccount: ChainAccount): Promise<KeystoneEvmSigningContext> {
    if (!(await this.options.credentials.hasUnlockSession())) throw new Error('Wallet is locked')
    const keyDomainId = parseKeyDomainId(chainAccount.scope.keyDomainId)
    const { snapshot, generationId } = await this.loadActiveContext(chainAccount)
    const credential = await this.loadHardwareCredential(keyDomainId, snapshot, generationId)
    if (
      credential.firmwareProfile !== 'multi-coin' ||
      credential.accountExport.protocol !== 'crypto-multi-accounts-v1' ||
      !credential.capabilities.includes('evm')
    ) {
      throw new Error('Active Keystone credential has no EVM signing capability')
    }
    const binding = parseEvmAccountBinding(chainAccount, chainAccount.scope.chainId)
    const matches = projectKeystoneMultiCoinAccounts(
      {
        type: 'multi-accounts',
        masterFingerprintHex: credential.accountExport.masterFingerprintHex,
        keys: credential.accountExport.keys,
        ...(credential.accountExport.device === undefined
          ? {}
          : { device: credential.accountExport.device }),
        ...(credential.accountExport.deviceId === undefined
          ? {}
          : { deviceId: credential.accountExport.deviceId }),
        ...(credential.accountExport.version === undefined
          ? {}
          : { version: credential.accountExport.version })
      },
      this.options.network
    ).filter(
      account =>
        account.family === 'evm' &&
        account.accountIndex === binding.addressIndex &&
        account.identity.toLowerCase() === binding.address.toLowerCase() &&
        account.derivationPath === chainAccount.derivation.path
    )
    if (matches.length !== 1 || matches[0].family !== 'evm') {
      throw new Error('Active EVM ChainAccount does not match the authenticated Keystone export')
    }
    return Object.freeze({
      derivationPath: matches[0].derivationPath,
      masterFingerprintHex: credential.accountExport.masterFingerprintHex,
      address: matches[0].identity.toLowerCase()
    })
  }

  clear(): void {
    this.hardwareCredentials.clear()
  }

  private async loadActiveContext(
    chainAccount: ChainAccount
  ): Promise<{ readonly snapshot: StorageV2Snapshot; readonly generationId: string }> {
    const pointer = await this.options.storageRepository.getActivePointer()
    if (!pointer) throw new Error('Storage V2 is not active')
    const snapshot = await this.options.storageRepository.getSnapshot(pointer.generationId)
    if (
      !snapshot ||
      snapshot.manifest.status !== 'verified' ||
      snapshot.manifest.generationId !== pointer.generationId ||
      snapshot.manifest.sourceFingerprint !== pointer.sourceFingerprint ||
      snapshot.manifest.activeAccount?.keyDomainId !== chainAccount.scope.keyDomainId ||
      snapshot.manifest.activeAccount.accountId !== chainAccount.scope.accountId
    ) {
      throw new Error('Active Storage V2 generation does not match the EVM signing Account')
    }
    const domains = snapshot.keyDomains.filter(
      candidate => candidate.id === chainAccount.scope.keyDomainId
    )
    if (
      domains.length !== 1 ||
      domains[0].source.kind !== 'hardware' ||
      domains[0].source.vendor !== 'keystone' ||
      !domains[0].source.capabilities.includes('evm')
    ) {
      throw new Error('Active Wallet is not an EVM-capable Keystone Wallet')
    }
    const accounts = snapshot.chainAccounts.filter(candidate => candidate.id === chainAccount.id)
    if (accounts.length !== 1 || JSON.stringify(accounts[0]) !== JSON.stringify(chainAccount)) {
      throw new Error('Active EVM ChainAccount metadata mismatch')
    }
    return Object.freeze({ snapshot, generationId: pointer.generationId })
  }

  private async loadHardwareCredential(
    keyDomainId: KeyDomainId,
    snapshot: StorageV2Snapshot,
    generationId: string
  ): Promise<KeystoneHardwareCredential> {
    const cached = this.hardwareCredentials.get(keyDomainId)
    if (cached?.generationId === generationId) return cached.credential
    const password = await this.options.credentials.getProvisioningPassword()
    const credential = await readActiveHardwareCredential(
      this.options.credentialRepository,
      snapshot,
      keyDomainId,
      password
    )
    if (credential.vendor !== 'keystone') {
      throw new Error('Expected a Keystone EVM credential')
    }
    this.hardwareCredentials.set(keyDomainId, Object.freeze({ generationId, credential }))
    return credential
  }
}
