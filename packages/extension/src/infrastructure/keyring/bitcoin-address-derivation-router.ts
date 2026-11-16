import type {
  DeriveBitcoinAddressInput,
  DeriveBitcoinAddressesInput,
  DerivedBitcoinAddress
} from '@/core/chains/bitcoin'
import { parseKeyDomainId, type KeyDomainId } from '@/core/keyring/domain'
import type { StoredHardwareCredential } from '@/core/wallet/hardware-wallet-data'
import { deriveLedgerBitcoinAddress } from '@/lib/ledger/bitcoin-model'
import {
  deriveKeystoneBitcoinAccountAddress,
  deriveKeystoneMultiCoinBitcoinAddress
} from '@/lib/keystone'
import type {
  CredentialRepository,
  StorageV2ReadRepository,
  StorageV2Snapshot
} from '@/ports/repositories'
import { readActiveHardwareCredential } from './active-hardware-credential-inventory'
import type { BitcoinAddressDerivationPort } from './multichain/bitcoin-derivation-client'

type DerivationStorageRepository = Pick<StorageV2ReadRepository, 'getActivePointer' | 'getSnapshot'>

export interface HardwareCredentialSessionProvider {
  readonly hasUnlockSession: () => Promise<boolean>
  readonly getProvisioningPassword: () => Promise<string>
}

export interface BitcoinAddressDerivationRouterOptions {
  readonly software: BitcoinAddressDerivationPort
  readonly storageRepository: DerivationStorageRepository
  readonly credentialRepository: CredentialRepository
  readonly credentials: HardwareCredentialSessionProvider
  readonly network: 'mainnet' | 'testnet'
}

interface ActiveKeyDomainContext {
  readonly snapshot: StorageV2Snapshot
  readonly generationId: string
  readonly sourceKind: 'software' | 'private-key' | 'hardware'
}

interface CachedHardwareCredential {
  readonly generationId: string
  readonly credential: StoredHardwareCredential
}

function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Bitcoin address derivation was cancelled')
}

export class BitcoinAddressDerivationRouter implements BitcoinAddressDerivationPort {
  private readonly hardwareCredentials = new Map<KeyDomainId, CachedHardwareCredential>()

  constructor(private readonly options: BitcoinAddressDerivationRouterOptions) {}

  async deriveAddress(
    keyDomainIdValue: KeyDomainId,
    input: DeriveBitcoinAddressInput,
    signal?: AbortSignal
  ): Promise<DerivedBitcoinAddress> {
    const keyDomainId = parseKeyDomainId(keyDomainIdValue)
    assertNotCancelled(signal)
    const context = await this.loadActiveContext(keyDomainId)
    if (context.sourceKind === 'software' || context.sourceKind === 'private-key') {
      return this.options.software.deriveAddress(keyDomainId, input, signal)
    }
    if (!(await this.options.credentials.hasUnlockSession())) {
      throw new Error('Wallet is locked')
    }
    assertNotCancelled(signal)
    const credential = await this.loadHardwareCredential(keyDomainId, context)
    assertNotCancelled(signal)
    if (credential.vendor === 'ledger') {
      if (credential.firmwareProfile !== 'multi-app' || input.addressType !== 'p2wpkh') {
        throw new Error('Ledger Bitcoin derivation requires a Native SegWit account')
      }
      const matches = credential.accountExport.accounts.filter(
        account =>
          account.family === 'bitcoin' &&
          account.network === this.options.network &&
          account.accountIndex === input.accountIndex &&
          new RegExp(
            `^m/84'/${this.options.network === 'mainnet' ? 0 : 1}'/(?:0|[1-9][0-9]*)'$`
          ).test(account.derivationPath)
      )
      if (matches.length !== 1 || matches[0].family !== 'bitcoin') {
        throw new Error('Ledger Bitcoin account export is missing or ambiguous')
      }
      const activeAccount = context.snapshot.manifest.activeAccount
      const chainAccounts = context.snapshot.chainAccounts.filter(
        candidate =>
          candidate.scope.keyDomainId === keyDomainId &&
          candidate.scope.accountId === activeAccount?.accountId &&
          candidate.scope.chainId === input.chainId
      )
      if (
        chainAccounts.length !== 1 ||
        chainAccounts[0].derivation.scheme !== 'bip84' ||
        chainAccounts[0].derivation.path !== `${matches[0].derivationPath}/0/0` ||
        chainAccounts[0].identity.value !== matches[0].address
      ) {
        throw new Error('Ledger Bitcoin account export does not match the active account')
      }
      const derived = deriveLedgerBitcoinAddress(
        matches[0].xpub,
        this.options.network,
        input.change,
        input.addressIndex
      )
      if (
        !input.change &&
        input.addressIndex === 0 &&
        (derived.address !== matches[0].address || derived.publicKey !== matches[0].publicKey)
      ) {
        throw new Error('Ledger Bitcoin account export does not match its public key')
      }
      return Object.freeze({
        chainId: input.chainId,
        addressType: 'p2wpkh' as const,
        accountIndex: input.accountIndex,
        change: input.change,
        addressIndex: input.addressIndex,
        address: derived.address,
        addressScheme: 'bitcoin-p2wpkh' as const,
        derivationScheme: 'bip84' as const,
        derivationPath: `${matches[0].derivationPath}/${input.change ? 1 : 0}/${input.addressIndex}`,
        publicKey: derived.publicKey,
        masterFingerprint: `0x${matches[0].masterFingerprintHex}`,
        scriptPubKey: derived.scriptPubKey
      })
    }
    const accountExport = credential.accountExport
    if (accountExport.protocol === 'crypto-multi-accounts-v1') {
      return deriveKeystoneMultiCoinBitcoinAddress(
        {
          type: 'multi-accounts',
          masterFingerprintHex: accountExport.masterFingerprintHex,
          keys: accountExport.keys,
          ...(accountExport.device === undefined ? {} : { device: accountExport.device }),
          ...(accountExport.deviceId === undefined ? {} : { deviceId: accountExport.deviceId }),
          ...(accountExport.version === undefined ? {} : { version: accountExport.version })
        },
        input,
        this.options.network
      )
    }
    if (accountExport.protocol === 'crypto-account-v1') {
      return deriveKeystoneBitcoinAccountAddress(
        {
          type: 'bitcoin-account',
          masterFingerprintHex: accountExport.masterFingerprintHex,
          descriptors: accountExport.descriptors
        },
        input,
        this.options.network
      )
    }
    throw new Error('Active hardware credential has no Bitcoin public account export')
  }

  async deriveAddresses(
    keyDomainIdValue: KeyDomainId,
    input: DeriveBitcoinAddressesInput,
    signal?: AbortSignal
  ): Promise<readonly DerivedBitcoinAddress[]> {
    const keyDomainId = parseKeyDomainId(keyDomainIdValue)
    if (!Number.isSafeInteger(input.count) || input.count <= 0 || input.count > 1_000) {
      throw new Error('Invalid Bitcoin derivation batch')
    }
    assertNotCancelled(signal)
    const context = await this.loadActiveContext(keyDomainId)
    if (context.sourceKind === 'software' || context.sourceKind === 'private-key') {
      if (this.options.software.deriveAddresses) {
        return this.options.software.deriveAddresses(keyDomainId, input, signal)
      }
      const derived: DerivedBitcoinAddress[] = []
      for (let offset = 0; offset < input.count; offset += 1) {
        derived.push(
          await this.options.software.deriveAddress(
            keyDomainId,
            { ...input, addressIndex: input.startAddressIndex + offset },
            signal
          )
        )
      }
      return Object.freeze(derived)
    }
    const derived: DerivedBitcoinAddress[] = []
    for (let offset = 0; offset < input.count; offset += 1) {
      derived.push(
        await this.deriveAddress(
          keyDomainId,
          { ...input, addressIndex: input.startAddressIndex + offset },
          signal
        )
      )
    }
    return Object.freeze(derived)
  }

  clear(): void {
    this.hardwareCredentials.clear()
  }

  private async loadActiveContext(keyDomainId: KeyDomainId): Promise<ActiveKeyDomainContext> {
    const pointer = await this.options.storageRepository.getActivePointer()
    if (!pointer) throw new Error('Storage V2 is not active')
    const snapshot = await this.options.storageRepository.getSnapshot(pointer.generationId)
    if (
      !snapshot ||
      snapshot.manifest.status !== 'verified' ||
      snapshot.manifest.generationId !== pointer.generationId ||
      snapshot.manifest.sourceFingerprint !== pointer.sourceFingerprint
    ) {
      throw new Error('Active Storage V2 generation does not match its pointer')
    }
    if (snapshot.manifest.activeAccount?.keyDomainId !== keyDomainId) {
      throw new Error('Bitcoin derivation is not bound to the active Wallet')
    }
    const matches = snapshot.keyDomains.filter(candidate => candidate.id === keyDomainId)
    if (matches.length !== 1) throw new Error('Active Bitcoin KeyDomain is missing or ambiguous')
    const source = matches[0].source
    if (
      source.kind === 'hardware' &&
      ((source.vendor !== 'keystone' && source.vendor !== 'ledger') ||
        !source.capabilities.includes('bitcoin'))
    ) {
      throw new Error('Active hardware Wallet has no Bitcoin derivation capability')
    }
    return Object.freeze({
      snapshot,
      generationId: pointer.generationId,
      sourceKind: source.kind
    })
  }

  private async loadHardwareCredential(
    keyDomainId: KeyDomainId,
    context: ActiveKeyDomainContext
  ): Promise<StoredHardwareCredential> {
    const cached = this.hardwareCredentials.get(keyDomainId)
    if (cached?.generationId === context.generationId) return cached.credential
    const password = await this.options.credentials.getProvisioningPassword()
    const credential = await readActiveHardwareCredential(
      this.options.credentialRepository,
      context.snapshot,
      keyDomainId,
      password
    )
    if (
      credential.vendor === 'ledger'
        ? credential.firmwareProfile !== 'multi-app' || !credential.capabilities.includes('bitcoin')
        : !credential.capabilities.includes('bitcoin')
    ) {
      throw new Error('Active hardware credential has no Bitcoin capability')
    }
    this.hardwareCredentials.set(
      keyDomainId,
      Object.freeze({ generationId: context.generationId, credential })
    )
    return credential
  }
}
