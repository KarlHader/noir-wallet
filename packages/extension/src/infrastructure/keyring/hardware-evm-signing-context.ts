import type { ChainAccount } from '@/core/accounts/domain'
import { parseEvmAccountBinding } from '@/infrastructure/chains/evm/evm-account'
import type { CredentialRepository, StorageV2ReadRepository } from '@/ports/repositories'
import { readActiveHardwareCredential } from './active-hardware-credential-inventory'
import {
  KeystoneEvmSigningContextResolver,
  type KeystoneEvmSigningContextResolverOptions
} from './keystone-evm-signing-context'
import type { HardwareCredentialSessionProvider } from './bitcoin-address-derivation-router'

export interface HardwareEvmSigningContextResolverOptions {
  readonly storageRepository: Pick<StorageV2ReadRepository, 'getActivePointer' | 'getSnapshot'>
  readonly credentialRepository: CredentialRepository
  readonly credentials: HardwareCredentialSessionProvider
  readonly network: 'mainnet' | 'testnet'
}

export class HardwareEvmSigningContextResolver {
  private readonly keystone: KeystoneEvmSigningContextResolver

  constructor(private readonly options: HardwareEvmSigningContextResolverOptions) {
    this.keystone = new KeystoneEvmSigningContextResolver(
      options as KeystoneEvmSigningContextResolverOptions
    )
  }

  async resolve(chainAccount: ChainAccount) {
    const pointer = await this.options.storageRepository.getActivePointer()
    if (!pointer) throw new Error('Storage V2 is not active')
    const snapshot = await this.options.storageRepository.getSnapshot(pointer.generationId)
    if (
      !snapshot ||
      snapshot.manifest.status !== 'verified' ||
      snapshot.manifest.generationId !== pointer.generationId ||
      snapshot.manifest.sourceFingerprint !== pointer.sourceFingerprint ||
      snapshot.manifest.activeAccount?.keyDomainId !== chainAccount.scope.keyDomainId ||
      snapshot.manifest.activeAccount.accountId !== chainAccount.scope.accountId ||
      !snapshot.chainAccounts.some(
        candidate =>
          candidate.id === chainAccount.id &&
          JSON.stringify(candidate) === JSON.stringify(chainAccount)
      )
    ) {
      throw new Error('Active EVM ChainAccount metadata mismatch')
    }
    const domains = snapshot.keyDomains.filter(
      candidate => candidate.id === chainAccount.scope.keyDomainId
    )
    if (
      domains.length !== 1 ||
      domains[0].source.kind !== 'hardware' ||
      !domains[0].source.capabilities.includes('evm')
    ) {
      throw new Error('Active hardware Wallet has no EVM capability')
    }
    if (domains[0].source.vendor === 'keystone') return this.keystone.resolve(chainAccount)
    if (domains[0].source.vendor !== 'ledger') throw new Error('Unsupported EVM hardware Wallet')
    if (!(await this.options.credentials.hasUnlockSession())) throw new Error('Wallet is locked')
    const credential = await readActiveHardwareCredential(
      this.options.credentialRepository,
      snapshot,
      chainAccount.scope.keyDomainId,
      await this.options.credentials.getProvisioningPassword()
    )
    if (
      credential.vendor !== 'ledger' ||
      credential.firmwareProfile !== 'multi-app' ||
      !credential.capabilities.includes('evm')
    ) {
      throw new Error('Active Ledger credential has no EVM capability')
    }
    const binding = parseEvmAccountBinding(chainAccount, chainAccount.scope.chainId)
    const matches = credential.accountExport.accounts.filter(
      account =>
        account.family === 'evm' &&
        account.derivationPath === chainAccount.derivation.path &&
        account.address.toLowerCase() === binding.address.toLowerCase()
    )
    if (matches.length !== 1 || matches[0].family !== 'evm')
      throw new Error('EVM account does not match the authenticated Ledger export')
    return Object.freeze({
      derivationPath: matches[0].derivationPath,
      publicKey: matches[0].publicKey,
      address: binding.address.toLowerCase()
    })
  }

  clear(): void {
    this.keystone.clear()
  }
}
