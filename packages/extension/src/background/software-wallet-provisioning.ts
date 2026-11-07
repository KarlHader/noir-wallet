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

export type SoftwareWalletProvisioningMode = 'create' | 'import'

export interface AddSoftwareWalletInput {
  readonly mode: SoftwareWalletProvisioningMode
  readonly mnemonic: string
  readonly accountName: string
  readonly birthdayHeight?: number
}

export interface AddSoftwareWalletResult {
  readonly walletId: string
  readonly credentialStatus: string
}

export interface ProvisionPrimarySoftwareWalletInput {
  readonly mnemonic: string
  readonly password: string
  readonly accountName: string
  readonly birthdayHeight?: number
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
  const mnemonic = normalizeMnemonic(input.mnemonic)
  const birthdayHeight = validateBirthdayHeight(input.birthdayHeight)
  const accountName = normalizeAccountName(input.accountName)

  syncScheduler.pauseForTx()
  syncScheduler.abortSync()
  try {
    await rehydrateWalletStore()
    await backgroundZcashWalletRuntime.initialize()
    await backgroundZcashWalletRuntime.importWallet(
      mnemonic,
      input.password,
      accountName,
      birthdayHeight
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

    syncScheduler.onRequestSync()
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
  const password = await requireProvisioningPassword()

  syncScheduler.pauseForTx()
  syncScheduler.abortSync()
  try {
    await ensureBackgroundPassword(password)
    const walletId =
      input.mode === 'create'
        ? (await backgroundZcashWalletRuntime.addNewWallet(mnemonic, undefined, accountName))
            .walletId
        : await backgroundZcashWalletRuntime.addImportedWallet(
            mnemonic,
            undefined,
            birthdayHeight,
            accountName
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

    syncScheduler.onRequestSync()
    return Object.freeze({ walletId, credentialStatus: credentials.status })
  } catch (error) {
    await lockProvisioningSession()
    throw error
  } finally {
    syncScheduler.resumeAfterTx()
  }
}
