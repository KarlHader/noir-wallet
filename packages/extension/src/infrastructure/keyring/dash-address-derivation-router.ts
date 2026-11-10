import { HDKey } from '@scure/bip32'
import { parseChainId } from '@/core/chains/registry'
import { DASH_CHAIN_IDS } from '@/core/chains/registry/chain-ids'
import { parseKeyDomainId, type KeyDomainId } from '@/core/keyring/domain'
import type { StoredHardwareCredential } from '@/core/wallet/hardware-wallet-data'
import { deriveLedgerDashP2pkh } from '@/lib/ledger/dash-model'
import type {
  CredentialRepository,
  StorageV2ReadRepository,
  StorageV2Snapshot
} from '@/ports/repositories'
import { readActiveHardwareCredential } from './active-hardware-credential-inventory'
import { dashDerivationPath } from './multichain/dash-codecs'
import type {
  DashAddressDerivationPort,
  DeriveDashAddressInput,
  DeriveDashAddressesInput,
  DerivedDashAddress
} from './multichain/dash-derivation-client'

type DerivationStorageRepository = Pick<StorageV2ReadRepository, 'getActivePointer' | 'getSnapshot'>

export interface DashHardwareCredentialSessionProvider {
  readonly hasUnlockSession: () => Promise<boolean>
  readonly getProvisioningPassword: () => Promise<string>
}

export interface DashAddressDerivationRouterOptions {
  readonly software: DashAddressDerivationPort
  readonly storageRepository: DerivationStorageRepository
  readonly credentialRepository: CredentialRepository
  readonly credentials: DashHardwareCredentialSessionProvider
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

const ACCOUNT_XPUB_VERSION = 0x0488b21e

function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Dash address derivation was cancelled')
}

function accountNodeFingerprint(xpub: string): string {
  let account: HDKey
  try {
    account = HDKey.fromExtendedKey(xpub, { public: ACCOUNT_XPUB_VERSION, private: 0x0488ade4 })
  } catch {
    throw new Error('Invalid Ledger Dash xpub')
  }
  return `0x${account.fingerprint.toString(16).padStart(8, '0')}`
}

export class DashAddressDerivationRouter implements DashAddressDerivationPort {
  private readonly hardwareCredentials = new Map<KeyDomainId, CachedHardwareCredential>()

  constructor(private readonly options: DashAddressDerivationRouterOptions) {}

  async deriveAddress(
    keyDomainIdValue: KeyDomainId,
    input: DeriveDashAddressInput,
    signal?: AbortSignal
  ): Promise<DerivedDashAddress> {
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
    const chainId = parseChainId(input.chainId).id
    if (this.options.network !== 'mainnet' || chainId !== DASH_CHAIN_IDS.mainnet) {
      throw new Error('Dash hardware wallets support mainnet only')
    }
    const credential = await this.loadHardwareCredential(keyDomainId, context)
    assertNotCancelled(signal)
    if (credential.vendor !== 'ledger') {
      throw new Error('Dash hardware derivation is unavailable for this wallet')
    }
    if (credential.firmwareProfile !== 'multi-app' || !credential.capabilities.includes('dash')) {
      throw new Error('Ledger Dash derivation requires a multi-app Dash account')
    }
    const matches = credential.accountExport.accounts.filter(
      account =>
        account.family === 'dash' &&
        account.network === 'mainnet' &&
        account.accountIndex === input.accountIndex &&
        /^m\/44'\/5'\/(?:0|[1-9][0-9]*)'$/.test(account.derivationPath)
    )
    if (matches.length !== 1 || matches[0].family !== 'dash') {
      throw new Error('Ledger Dash account export is missing or ambiguous')
    }
    const account = matches[0]
    const activeAccount = context.snapshot.manifest.activeAccount
    const chainAccounts = context.snapshot.chainAccounts.filter(
      candidate =>
        candidate.scope.keyDomainId === keyDomainId &&
        candidate.scope.accountId === activeAccount?.accountId &&
        candidate.scope.chainId === chainId
    )
    const receivePath = `${account.derivationPath}/0/0`
    if (
      chainAccounts.length !== 1 ||
      chainAccounts[0].derivation.scheme !== 'bip44' ||
      chainAccounts[0].derivation.path !== receivePath ||
      chainAccounts[0].identity.value !== account.address
    ) {
      throw new Error('Ledger Dash account export does not match the active account')
    }
    const receive = deriveLedgerDashP2pkh(account.xpub, false, 0)
    if (
      receive.address !== account.address ||
      `0x${receive.publicKey}` !== account.publicKey.toLowerCase()
    ) {
      throw new Error('Ledger Dash account export does not match its public key')
    }
    const derived =
      input.change || input.addressIndex !== 0
        ? deriveLedgerDashP2pkh(account.xpub, input.change, input.addressIndex)
        : receive
    const derivationPath = dashDerivationPath(
      chainId,
      input.accountIndex,
      input.change,
      input.addressIndex,
      false
    )
    if (
      derivationPath !== `${account.derivationPath}/${input.change ? 1 : 0}/${input.addressIndex}`
    ) {
      throw new Error('Ledger Dash derivation path does not match the account export')
    }
    return Object.freeze({
      chainId,
      network: 'mainnet',
      accountIndex: input.accountIndex,
      change: input.change,
      addressIndex: input.addressIndex,
      address: derived.address,
      addressScheme: 'dash_p2pkh',
      derivationScheme: 'bip44',
      derivationPath,
      publicKey: `0x${derived.publicKey}`,
      // Ledger Dash exports have no master fingerprint. This is the account
      // node fingerprint and must not be written into a PSBT BIP32 derivation.
      masterFingerprint: accountNodeFingerprint(account.xpub),
      scriptPubKey: `0x${derived.scriptPubKeyHex}`
    })
  }

  async deriveAddresses(
    keyDomainIdValue: KeyDomainId,
    input: DeriveDashAddressesInput,
    signal?: AbortSignal
  ): Promise<readonly DerivedDashAddress[]> {
    const keyDomainId = parseKeyDomainId(keyDomainIdValue)
    if (!Number.isSafeInteger(input.count) || input.count <= 0 || input.count > 1_000) {
      throw new Error('Invalid Dash derivation batch')
    }
    assertNotCancelled(signal)
    const context = await this.loadActiveContext(keyDomainId)
    if (context.sourceKind === 'software' || context.sourceKind === 'private-key') {
      if (this.options.software.deriveAddresses) {
        return this.options.software.deriveAddresses(keyDomainId, input, signal)
      }
      const derived: DerivedDashAddress[] = []
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
    const derived: DerivedDashAddress[] = []
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
      throw new Error('Dash derivation is not bound to the active Wallet')
    }
    const matches = snapshot.keyDomains.filter(candidate => candidate.id === keyDomainId)
    if (matches.length !== 1) throw new Error('Active Dash KeyDomain is missing or ambiguous')
    const source = matches[0].source
    if (source.kind === 'hardware' && source.vendor !== 'ledger') {
      throw new Error('Dash hardware derivation is unavailable for this wallet')
    }
    if (source.kind === 'hardware' && !source.capabilities.includes('dash')) {
      throw new Error('Active hardware Wallet has no Dash derivation capability')
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
      credential.vendor !== 'ledger' ||
      credential.firmwareProfile !== 'multi-app' ||
      !credential.capabilities.includes('dash')
    ) {
      throw new Error('Active hardware credential has no Dash capability')
    }
    this.hardwareCredentials.set(
      keyDomainId,
      Object.freeze({ generationId: context.generationId, credential })
    )
    return credential
  }
}
