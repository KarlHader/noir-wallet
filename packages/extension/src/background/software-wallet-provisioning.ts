import { isZcashHardwareKeySource } from '@/core/wallet/hardware-wallet-data'
import { validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'
import { backgroundZcashWalletRuntime } from './zcash-wallet-runtime'
import { type MnemonicWordCount } from '@/config/wallet'
import { rehydrateWalletStore, useWalletStore } from '@/store/wallet-store'
import { generateCanonicalMnemonic } from '@/infrastructure/keyring/multichain/canonical-mnemonic-generator'
import { BackgroundMultichainTransport } from '@/infrastructure/keyring/multichain/background-transport'
import { credentialLifecycle } from './credential-lifecycle'
import { credentialSession } from './credential-session'
import { syncScheduler } from './sync-scheduler'
import { normalizeAccountName } from '@/core/wallet/account-name'
import {
  parseSelectedNetworkFamilies,
  type AccountNetworkFamily
} from '@/core/wallet/account-network-selection'
import { isNewWalletFamilyEnabled } from '@/core/chains/feature-runtime-policy'
import { MnemonicGenerator } from '@/core/wallet/mnemonic'
import { mapWasmAccountAddresses } from '@/core/zcash/account-addresses'
import {
  createBuildAddressGatedChainRegistry,
  createInitialProductChainRegistry,
  getBitcoinChainId,
  getZcashChainId
} from '@/core/chains/registry'
import {
  getEvmNetworkConfig,
  getNearNetworkConfig,
  getSolanaNetworkConfig
} from '@/config/networks'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import {
  parseCredentialGenerationId,
  parseGlobalUnlockEpoch,
  parseSessionKeyDomainId,
  type KeyringCommandBinding,
  type KeyringCommandPayload
} from '@/core/keyring/ports'
import { MultichainCommandClient } from '@/infrastructure/keyring/multichain/command-client'
import {
  parseRawEncryptedVault,
  readRecord
} from '@/infrastructure/keyring/multichain/raw-wallet-engine'

export type SoftwareWalletProvisioningMode = 'create' | 'import'

export interface AddSoftwareWalletInput {
  readonly mode: SoftwareWalletProvisioningMode
  readonly mnemonic: string
  readonly accountName: string
  readonly birthdayHeight?: number
  readonly selectedNetworkFamilies?: readonly AccountNetworkFamily[]
}

export interface AddSoftwareWalletResult {
  readonly walletId: string
  readonly credentialStatus: string
}

export interface ProvisionPrimarySoftwareWalletInput {
  readonly mode: SoftwareWalletProvisioningMode
  readonly mnemonic: string
  readonly password: string
  readonly accountName: string
  readonly birthdayHeight?: number
  readonly selectedNetworkFamilies?: readonly AccountNetworkFamily[]
}

export interface SoftwareWalletAddressPreview {
  readonly family: AccountNetworkFamily
  readonly chainId: string
  readonly address: string
}

function parsePreviewAddress(value: unknown, chainId: string): string {
  const account = readRecord(value, 'Preview account')
  if (
    account.chainId !== chainId ||
    !Array.isArray(account.addresses) ||
    account.addresses.length !== 1
  ) {
    throw new Error('Invalid preview account')
  }
  const address = readRecord(account.addresses[0], 'Preview address')
  if (
    typeof address.value !== 'string' ||
    address.value.length === 0 ||
    address.value.length > 256
  ) {
    throw new Error('Invalid preview address')
  }
  return address.value
}

export async function previewSoftwareWalletAddresses(input: {
  readonly mnemonic: string
  readonly selectedNetworkFamilies: readonly AccountNetworkFamily[]
}): Promise<readonly SoftwareWalletAddressPreview[]> {
  const mnemonic = normalizeMnemonic(input.mnemonic)
  const families = importNetworkFamilies(input.selectedNetworkFamilies)
  if (!families) throw new Error('Select at least one supported network')
  const network = DEFAULT_NETWORK
  const available = new Set(
    createBuildAddressGatedChainRegistry(createInitialProductChainRegistry(network))
      .list()
      .map(chain => chain.family)
  )
  if (!families.every(family => available.has(family))) {
    throw new Error('Selected network is unavailable')
  }
  const result: SoftwareWalletAddressPreview[] = []

  if (families.includes('zcash')) {
    const addresses = mapWasmAccountAddresses(
      await MnemonicGenerator.toAddresses(mnemonic, 0, network)
    )
    if (!addresses.transparent) throw new Error('Unable to derive Zcash transparent address')
    result.push({
      family: 'zcash',
      chainId: getZcashChainId(network),
      address: addresses.transparent
    })
  }

  const multichainFamilies = families.filter(family => family !== 'zcash')
  if (multichainFamilies.length === 0) return result

  const nonce = crypto.randomUUID()
  const password = crypto.randomUUID()
  const binding: Extract<KeyringCommandBinding, { readonly kind: 'credential' }> = {
    kind: 'credential',
    keyDomainId: parseSessionKeyDomainId(`wallet:mnemonic-preview:${nonce}`),
    credentialGenerationId: parseCredentialGenerationId(
      `credential-generation:mnemonic-preview:${nonce}`
    ),
    globalUnlockEpoch: parseGlobalUnlockEpoch(`global-unlock:${nonce}`)
  }
  const client = new MultichainCommandClient(new BackgroundMultichainTransport(), {
    defaultTimeoutMs: 120_000,
    maxTimeoutMs: 120_000
  })
  let operationError: unknown
  try {
    const vault = await client.execute(
      { operation: 'credential.import', binding, payload: { mnemonic, password } },
      parseRawEncryptedVault
    )
    await client.execute(
      { operation: 'credential.unlock', binding, payload: { vault, password } },
      value => value
    )
    for (const family of multichainFamilies) {
      const chainId =
        family === 'evm'
          ? getEvmNetworkConfig(network).chainId
          : family === 'bitcoin'
            ? getBitcoinChainId(network)
            : family === 'solana'
              ? getSolanaNetworkConfig(network === 'mainnet' ? 'mainnet' : 'devnet').chainId
              : family === 'near'
                ? getNearNetworkConfig(network).chainId
                : null
      if (!chainId) throw new Error('Selected network is unavailable')
      const payload: KeyringCommandPayload =
        family === 'evm'
          ? { family: 'evm', chainId, addressIndex: 0 }
          : family === 'bitcoin'
            ? {
                family: 'bitcoin',
                chainId,
                addressType: 'p2wpkh',
                accountIndex: 0,
                change: false,
                addressIndex: 0
              }
            : { family, chainId, accountIndex: 0 }
      const address = await client.execute(
        { operation: 'account.derive-public', binding, payload },
        value => parsePreviewAddress(value, chainId)
      )
      result.push({ family, chainId, address })
    }
    return result
  } catch (error) {
    operationError = error
    throw error
  } finally {
    let cleanupError: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await client.execute({ operation: 'credential.lock', binding, payload: {} }, value => value)
        cleanupError = undefined
        break
      } catch (error) {
        cleanupError = error
      }
    }
    await client.destroy()
    if (cleanupError !== undefined && operationError === undefined) throw cleanupError
  }
}

function importNetworkFamilies(
  value: readonly AccountNetworkFamily[] | undefined
): readonly AccountNetworkFamily[] | undefined {
  if (value === undefined) return undefined
  const families = parseSelectedNetworkFamilies(value)
  if (
    !families.every(family => isNewWalletFamilyEnabled(family, __ENABLED_CHAIN_FEATURE_FLAGS__))
  ) {
    throw new Error('Selected network is unavailable')
  }
  return families
}

function normalizeMnemonic(value: string): string {
  const mnemonic = value.trim().split(/\s+/).join(' ')
  const wordCount = mnemonic.split(' ').length
  if ((wordCount !== 12 && wordCount !== 24) || !validateMnemonic(mnemonic, wordlist)) {
    throw new Error('Invalid seed phrase')
  }
  return mnemonic
}

function validateBirthdayHeight(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid birthday height')
  }
  return value
}

async function requireProvisioningPassword(): Promise<string> {
  if (!(await credentialSession.hasUnlockSession())) {
    throw new Error('Wallet is locked. Please unlock and try again.')
  }
  return credentialSession.getProvisioningPassword()
}

async function ensureBackgroundPassword(password: string): Promise<void> {
  await rehydrateWalletStore()
  await backgroundZcashWalletRuntime.initialize()
  if (backgroundZcashWalletRuntime.getSessionPassword() !== null) return

  if (useWalletStore.getState().wallets.length === 0) {
    backgroundZcashWalletRuntime.establishProvisioningPasswordForEmptyRetainedInventory(password)
    return
  }

  const unlocked = await backgroundZcashWalletRuntime.unlock(password, {
    skipFailCount: true,
    allowMissingCredentialRecovery: true
  })
  if (!unlocked.success) {
    throw new Error('Wallet provisioning session is invalid')
  }
}

async function lockProvisioningSession(): Promise<void> {
  await Promise.allSettled([backgroundZcashWalletRuntime.lock(), credentialSession.lock()])
}

export async function generateAddWalletMnemonic(wordCount: MnemonicWordCount): Promise<string> {
  const password = await requireProvisioningPassword()
  return generateCanonicalMnemonic(wordCount, password, new BackgroundMultichainTransport())
}

export async function generatePrimaryWalletMnemonic(
  wordCount: MnemonicWordCount,
  password: string
): Promise<string> {
  return generateCanonicalMnemonic(wordCount, password, new BackgroundMultichainTransport())
}

export async function provisionPrimarySoftwareWallet(
  input: ProvisionPrimarySoftwareWalletInput,
  synchronizeNetworkMetadata?: () => Promise<void>
): Promise<AddSoftwareWalletResult> {
  if (input.mode !== 'create' && input.mode !== 'import') {
    throw new Error('Invalid wallet provisioning mode')
  }
  const mnemonic = normalizeMnemonic(input.mnemonic)
  const birthdayHeight = validateBirthdayHeight(input.birthdayHeight)
  const accountName = normalizeAccountName(input.accountName)
  const selectedNetworkFamilies = importNetworkFamilies(input.selectedNetworkFamilies)

  syncScheduler.pauseForTx()
  syncScheduler.abortSync()
  try {
    await rehydrateWalletStore()
    await backgroundZcashWalletRuntime.initialize()
    await backgroundZcashWalletRuntime.importWallet(
      mnemonic,
      input.password,
      accountName,
      birthdayHeight,
      selectedNetworkFamilies,
      input.mode === 'create' ? 'created' : 'imported'
    )

    const credentials = await credentialLifecycle.synchronizeRetainedV1(input.password)
    const descriptor = await credentialSession.unlock(input.password)
    if (!descriptor) throw new Error('Credential provisioning produced an empty session')

    const currentWalletId = useWalletStore.getState().currentWalletId
    const currentWallet = currentWalletId
      ? useWalletStore.getState().getWallet(currentWalletId)
      : null
    if (!currentWalletId || !currentWallet)
      throw new Error('Wallet setup produced no active wallet')
    if (
      !isZcashHardwareKeySource(currentWallet.keySource) &&
      !(await credentialSession.bindZcashCredential(currentWalletId))
    ) {
      throw new Error('Unable to bind the Zcash credential session')
    }
    await synchronizeNetworkMetadata?.()

    if (selectedNetworkFamilies?.includes('zcash') !== false) syncScheduler.onRequestSync()
    return Object.freeze({ walletId: currentWalletId, credentialStatus: credentials.status })
  } catch (error) {
    await lockProvisioningSession()
    throw error
  } finally {
    syncScheduler.resumeAfterTx()
  }
}

export async function addSoftwareWallet(
  input: AddSoftwareWalletInput,
  synchronizeNetworkMetadata?: () => Promise<void>
): Promise<AddSoftwareWalletResult> {
  const mnemonic = normalizeMnemonic(input.mnemonic)
  const birthdayHeight = validateBirthdayHeight(input.birthdayHeight)
  const accountName = normalizeAccountName(input.accountName)
  const selectedNetworkFamilies = importNetworkFamilies(input.selectedNetworkFamilies)
  const password = await requireProvisioningPassword()

  syncScheduler.pauseForTx()
  syncScheduler.abortSync()
  try {
    await ensureBackgroundPassword(password)
    const walletId =
      input.mode === 'create'
        ? (
            await backgroundZcashWalletRuntime.addNewWallet(
              mnemonic,
              undefined,
              accountName,
              selectedNetworkFamilies
            )
          ).walletId
        : await backgroundZcashWalletRuntime.addImportedWallet(
            mnemonic,
            undefined,
            birthdayHeight,
            accountName,
            selectedNetworkFamilies
          )

    const credentials = await credentialLifecycle.synchronizeRetainedV1(password)

    await backgroundZcashWalletRuntime.lock()
    const descriptor = await credentialSession.unlock(password)
    if (!descriptor) throw new Error('Credential provisioning produced an empty session')

    const unlocked = await backgroundZcashWalletRuntime.unlock(password, { skipFailCount: true })
    if (!unlocked.success) throw new Error('Wallet provisioning could not restore the wallet')

    const currentWalletId = useWalletStore.getState().currentWalletId
    const currentWallet = currentWalletId
      ? useWalletStore.getState().getWallet(currentWalletId)
      : null
    if (
      currentWalletId &&
      !isZcashHardwareKeySource(currentWallet?.keySource) &&
      !(await credentialSession.bindZcashCredential(currentWalletId))
    ) {
      throw new Error('Unable to bind the Zcash credential session')
    }
    await synchronizeNetworkMetadata?.()

    if (selectedNetworkFamilies?.includes('zcash') !== false) syncScheduler.onRequestSync()
    return Object.freeze({ walletId, credentialStatus: credentials.status })
  } catch (error) {
    await lockProvisioningSession()
    throw error
  } finally {
    syncScheduler.resumeAfterTx()
  }
}
