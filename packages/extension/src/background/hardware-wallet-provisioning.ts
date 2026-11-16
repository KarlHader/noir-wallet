import { assertNewPassword } from '@/core/wallet/password-policy'
import {
  createLedgerHardwareCredential,
  parseKeystoneHardwareCredential,
  parseLedgerHardwareCredential,
  type LedgerHardwareCredential,
  type KeystoneHardwareCredential
} from '@/core/wallet/hardware-wallet-data'
import {
  parseLedgerMultichainHardwareCredential,
  type LedgerMultichainHardwareCredential,
  type LedgerPublicAccount
} from '@/core/wallet/ledger-hardware-credential'
import {
  assertRetainedDisabledLedgerAccounts,
  assertRetainedDisabledLedgerProjections
} from '@/core/wallet/ledger-feature-policy'
import {
  IndexedDbCredentialRepository,
  IndexedDbStorageV2Repository
} from '@/infrastructure/persistence/repositories'
import { readActiveLedgerHardwareCredential } from '@/infrastructure/keyring/active-hardware-credential-inventory'
import { parseKeyDomainId } from '@/core/keyring/domain'
import { getZcashChainId } from '@/core/chains/registry'
import { areNewHardwareWalletFamiliesEnabled } from '@/core/chains/feature-runtime-policy'
import { SecureStorage } from '@/core/wallet/secure-storage'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import type { AccountAddresses } from '@/types'
import { rehydrateWalletStore, useWalletStore } from '@/store/wallet-store'
import { credentialLifecycle } from './credential-lifecycle'
import { credentialSession } from './credential-session'
import { backgroundZcashWalletRuntime } from './zcash-wallet-runtime'
import { syncScheduler } from './sync-scheduler'

export interface ProvisionHardwareWalletInput {
  readonly credential: unknown
  readonly displayName: string
  readonly password?: string
  readonly birthdayHeight?: number
  readonly existingKeyDomainId?: string
  readonly anchorProof?: LedgerPublicAccount
}

async function activeLedgerAccountForZcash(
  keyDomainId: string,
  password: string,
  anchorProof: LedgerPublicAccount | undefined,
  zcashAccount: Extract<LedgerPublicAccount, { family: 'zcash' }>
): Promise<string> {
  const storage = new IndexedDbStorageV2Repository()
  const pointer = await storage.getActivePointer()
  const snapshot = pointer ? await storage.getSnapshot(pointer.generationId) : null
  const domain = snapshot?.keyDomains.find(item => item.id === keyDomainId)
  if (
    !snapshot ||
    !domain ||
    domain.source.kind !== 'hardware' ||
    domain.source.vendor !== 'ledger'
  ) {
    throw new Error('Existing Ledger Wallet was not found')
  }
  const active = await readActiveLedgerHardwareCredential(
    new IndexedDbCredentialRepository(),
    snapshot,
    domain.id,
    password
  )
  if (
    active.schemaVersion !== 3 ||
    !anchorProof ||
    !active.accountExport.accounts.some(
      account => JSON.stringify(account) === JSON.stringify(anchorProof)
    )
  ) {
    throw new Error('A fresh Ledger anchor matching the active Wallet is required')
  }
  const account = snapshot.accounts.find(
    item => item.keyDomainId === domain.id && item.accountIndex === zcashAccount.accountIndex
  )
  if (!account) throw new Error('Ledger Zcash projection requires an existing logical Account')
  if (
    snapshot.chainAccounts.some(
      item =>
        item.scope.accountId === account.id &&
        item.scope.chainId === getZcashChainId(DEFAULT_NETWORK)
    )
  ) {
    throw new Error('Ledger Zcash account is already projected')
  }
  return account.id
}

async function provisionLedgerMultichain(
  input: ProvisionHardwareWalletInput,
  credential: LedgerMultichainHardwareCredential
) {
  await rehydrateWalletStore()
  const activeWalletSetMode = await credentialLifecycle.getActiveWalletSetMode()
  const isFirstWallet =
    useWalletStore.getState().wallets.length === 0 && activeWalletSetMode === 'inactive'
  const isInterruptedFirstWalletRecovery =
    useWalletStore.getState().wallets.length === 0 &&
    activeWalletSetMode === 'native-v2-hardware-only' &&
    !(await credentialSession.hasUnlockSession()) &&
    input.password !== undefined
  let password: string
  if (isFirstWallet || isInterruptedFirstWalletRecovery) {
    if (!input.password) throw new Error('A password is required for the first Wallet')
    assertNewPassword(input.password)
    password = input.password
    if (isInterruptedFirstWalletRecovery) await credentialSession.unlock(password)
  } else {
    if (input.password !== undefined) {
      throw new Error('An existing Wallet must use the active global password session')
    }
    if (!(await credentialSession.hasUnlockSession())) {
      throw new Error('Wallet is locked. Please unlock and try again.')
    }
    password = await credentialSession.getProvisioningPassword()
  }
  if (
    !areNewHardwareWalletFamiliesEnabled(credential.capabilities, __ENABLED_CHAIN_FEATURE_FLAGS__)
  ) {
    if (!input.existingKeyDomainId) {
      throw new Error('Ledger account chain is not enabled in this build')
    }
    const storage = new IndexedDbStorageV2Repository()
    const pointer = await storage.getActivePointer()
    const snapshot = pointer ? await storage.getSnapshot(pointer.generationId) : null
    if (
      !snapshot ||
      snapshot.manifest.status !== 'verified' ||
      snapshot.manifest.sourceFingerprint !== pointer?.sourceFingerprint
    ) {
      throw new Error('Active Ledger Wallet is unavailable')
    }
    const prior = await readActiveLedgerHardwareCredential(
      new IndexedDbCredentialRepository(),
      snapshot,
      parseKeyDomainId(input.existingKeyDomainId),
      password
    )
    if (prior.schemaVersion !== 3) {
      throw new Error('Ledger account chain is not enabled in this build')
    }
    const disabled = assertRetainedDisabledLedgerAccounts(
      prior.accountExport.accounts,
      credential.accountExport.accounts,
      input.anchorProof,
      __ENABLED_CHAIN_FEATURE_FLAGS__
    )
    assertRetainedDisabledLedgerProjections(
      snapshot,
      input.existingKeyDomainId,
      DEFAULT_NETWORK,
      disabled
    )
  }
  const zcashAccounts = credential.accountExport.accounts.filter(
    (account): account is Extract<LedgerPublicAccount, { family: 'zcash' }> =>
      account.family === 'zcash' && account.network === DEFAULT_NETWORK
  )
  if (zcashAccounts.length > 1)
    throw new Error('Only one Zcash account per Ledger Wallet can be projected')
  const zcash = zcashAccounts[0]
  if (!zcash && input.birthdayHeight !== undefined) {
    throw new Error('Birthday height requires a Zcash Ledger account')
  }
  let existingKeyDomainId = input.existingKeyDomainId
  let anchorProof = input.anchorProof
  let zcashProjection:
    | {
        accountId: string
        accountIndex: number
        addresses: AccountAddresses
      }
    | undefined
  if (zcash && !existingKeyDomainId) {
    const retained = await provisionRetainedZcashHardware(
      createLedgerHardwareCredential({
        ufvk: zcash.ufvk,
        accountHdIndex: zcash.accountHdIndex,
        deviceModel: credential.deviceModel,
        deviceName: credential.deviceName,
        ledgerSigningTransport: credential.ledgerSigningTransport
      }),
      input.displayName,
      password,
      input.birthdayHeight,
      isFirstWallet
    )
    existingKeyDomainId = retained.keyDomainId
    anchorProof = zcash
  } else if (zcash && existingKeyDomainId) {
    const retained = useWalletStore.getState().getWallet(existingKeyDomainId)
    if (retained) {
      const retainedData = await SecureStorage.loadHardwareWalletData(existingKeyDomainId, password)
      if (retained.keySource !== 'ledger' || retainedData?.ufvk !== zcash.ufvk) {
        throw new Error('Retained Ledger Zcash Wallet does not match the device export')
      }
      const storage = new IndexedDbStorageV2Repository()
      const pointer = await storage.getActivePointer()
      const snapshot = pointer ? await storage.getSnapshot(pointer.generationId) : null
      const hasZcashProjection = snapshot?.chainAccounts.some(
        item =>
          item.scope.keyDomainId === existingKeyDomainId &&
          item.scope.chainId === getZcashChainId(DEFAULT_NETWORK)
      )
      if (!hasZcashProjection) {
        const accountId = await activeLedgerAccountForZcash(
          existingKeyDomainId,
          password,
          anchorProof,
          zcash
        )
        const account = retained.accounts.find(item => item.id === accountId)
        if (!account) throw new Error('Retained Ledger Account ID does not match Storage V2')
        zcashProjection = {
          accountId,
          accountIndex: zcash.accountIndex,
          addresses: account.addresses
        }
      }
    } else {
      const accountId = await activeLedgerAccountForZcash(
        existingKeyDomainId,
        password,
        anchorProof,
        zcash
      )
      await ensureZcashRuntimePassword(password)
      await backgroundZcashWalletRuntime.createHardwareWallet({
        name: input.displayName,
        ufvk: zcash.ufvk,
        seedFingerprintHex: '0'.repeat(64),
        accountHdIndex: zcash.accountHdIndex,
        keySource: 'ledger',
        deviceModel: credential.deviceModel,
        deviceName: credential.deviceName,
        existingLedgerWalletId: existingKeyDomainId,
        existingLedgerAccountId: accountId,
        ...(input.birthdayHeight === undefined ? {} : { birthdayHeight: input.birthdayHeight }),
        enforceNewPasswordPolicy: false
      })
      const wallet = useWalletStore.getState().getWallet(existingKeyDomainId)
      const account = wallet?.accounts.find(item => item.id === accountId)
      if (!account) throw new Error('Ledger Zcash wallet projection was not retained')
      zcashProjection = {
        accountId,
        accountIndex: zcash.accountIndex,
        addresses: account.addresses
      }
    }
  }
  const result = await credentialLifecycle.provisionLedgerHardware({
    credential,
    displayName: input.displayName,
    password,
    network: DEFAULT_NETWORK,
    ...(existingKeyDomainId === undefined ? {} : { existingKeyDomainId }),
    ...(anchorProof === undefined ? {} : { anchorProof }),
    ...(zcashProjection === undefined ? {} : { zcashProjection })
  })
  if (useWalletStore.getState().getWallet(result.keyDomainId)) {
    await SecureStorage.saveLedgerHardwareCredential(result.keyDomainId, credential, password)
  }
  const descriptor = await credentialSession.unlock(password)
  if (!descriptor) throw new Error('Ledger provisioning produced an empty session')
  if (isFirstWallet) {
    await Promise.all([SecureStorage.resetLoginAttempts(), SecureStorage.saveLastActivityTime()])
  }
  return result
}

function validateBirthdayHeight(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid birthday height')
  return value
}

async function ensureZcashRuntimePassword(password: string): Promise<void> {
  await backgroundZcashWalletRuntime.initialize()
  if (backgroundZcashWalletRuntime.getSessionPassword() !== null) return
  if (useWalletStore.getState().wallets.length === 0) {
    backgroundZcashWalletRuntime.establishProvisioningPasswordForEmptyRetainedInventory(password)
    return
  }
  const unlocked = await backgroundZcashWalletRuntime.unlock(password, { skipFailCount: true })
  if (!unlocked.success) throw new Error('Hardware Wallet provisioning session is invalid')
}

async function provisionRetainedZcashHardware(
  credential: KeystoneHardwareCredential | LedgerHardwareCredential,
  displayName: string,
  password: string,
  birthdayHeight: number | undefined,
  isFirstGlobalWallet: boolean
) {
  if (credential.accountExport.protocol !== 'zcash-accounts-v1') {
    throw new Error('Invalid Zcash hardware credential')
  }
  syncScheduler.pauseForTx()
  syncScheduler.abortSync()
  try {
    await ensureZcashRuntimePassword(password)
    const walletId = await backgroundZcashWalletRuntime.createHardwareWallet({
      name: displayName,
      ufvk: credential.accountExport.ufvk,
      seedFingerprintHex: credential.accountExport.seedFingerprintHex,
      accountHdIndex: credential.accountExport.accountHdIndex,
      keySource: credential.vendor,
      ...(credential.vendor === 'ledger'
        ? { deviceModel: credential.deviceModel, deviceName: credential.deviceName }
        : {}),
      ...(birthdayHeight === undefined ? {} : { birthdayHeight }),
      enforceNewPasswordPolicy: isFirstGlobalWallet
    })
    const synchronized = await credentialLifecycle.synchronizeRetainedV1(password)
    const descriptor = await credentialSession.unlock(password)
    if (!descriptor) throw new Error('Hardware Wallet provisioning produced an empty session')
    const unlocked = await backgroundZcashWalletRuntime.unlock(password, { skipFailCount: true })
    if (!unlocked.success) throw new Error('Hardware Wallet provisioning could not restore Wallet')
    const wallet = useWalletStore.getState().getWallet(walletId)
    if (!wallet || wallet.keySource !== credential.vendor || wallet.accounts.length === 0) {
      throw new Error('Provisioned Zcash hardware Wallet is missing')
    }
    if (!synchronized.generationId) {
      throw new Error('Provisioned Zcash hardware Wallet generation is missing')
    }
    await Promise.all([SecureStorage.resetLoginAttempts(), SecureStorage.saveLastActivityTime()])
    syncScheduler.onRequestSync()
    return Object.freeze({
      status:
        synchronized.status === 'migrated' || synchronized.status === 'synchronized'
          ? ('committed' as const)
          : ('already-committed' as const),
      generationId: synchronized.generationId,
      keyDomainId: walletId,
      accountIds: Object.freeze(wallet.accounts.map(account => account.id))
    })
  } catch (error) {
    await Promise.allSettled([backgroundZcashWalletRuntime.lock(), credentialSession.lock()])
    throw error
  } finally {
    syncScheduler.resumeAfterTx()
  }
}

export async function provisionHardwareWallet(
  input: ProvisionHardwareWalletInput,
  vendor: 'keystone' | 'ledger'
) {
  const credential =
    vendor === 'keystone'
      ? parseKeystoneHardwareCredential(input.credential)
      : parseLedgerHardwareCredential(input.credential)
  if (vendor === 'ledger' && credential.schemaVersion === 3) {
    return provisionLedgerMultichain(input, parseLedgerMultichainHardwareCredential(credential))
  }
  if (
    !areNewHardwareWalletFamiliesEnabled(credential.capabilities, __ENABLED_CHAIN_FEATURE_FLAGS__)
  ) {
    throw new Error('Hardware Wallet chain is not enabled in this build')
  }
  const birthdayHeight = validateBirthdayHeight(input.birthdayHeight)
  if (credential.accountExport.protocol !== 'zcash-accounts-v1' && birthdayHeight !== undefined) {
    throw new Error('Birthday height is only valid for Zcash hardware Wallets')
  }
  if (
    typeof input.displayName !== 'string' ||
    input.displayName.length === 0 ||
    input.displayName.length > 128 ||
    input.displayName.trim() !== input.displayName
  ) {
    throw new Error('Invalid hardware Wallet name')
  }

  await rehydrateWalletStore()
  const hasRetainedV1Wallet = useWalletStore.getState().wallets.length > 0
  const activeWalletSetMode = await credentialLifecycle.getActiveWalletSetMode()
  const isFirstWallet = !hasRetainedV1Wallet && activeWalletSetMode === 'inactive'
  const isInterruptedFirstWalletRecovery =
    !hasRetainedV1Wallet &&
    activeWalletSetMode === 'native-v2-hardware-only' &&
    !(await credentialSession.hasUnlockSession()) &&
    input.password !== undefined
  let password: string
  if (isFirstWallet || isInterruptedFirstWalletRecovery) {
    if (input.password === undefined) throw new Error('A password is required for the first Wallet')
    assertNewPassword(input.password)
    password = input.password
    if (isInterruptedFirstWalletRecovery) {
      const descriptor = await credentialSession.unlock(password)
      if (!descriptor) throw new Error('Hardware Wallet recovery produced an empty session')
    }
  } else {
    if (input.password !== undefined) {
      throw new Error('An existing Wallet must use the active global password session')
    }
    if (!(await credentialSession.hasUnlockSession())) {
      throw new Error('Wallet is locked. Please unlock and try again.')
    }
    password = await credentialSession.getProvisioningPassword()
  }

  const result =
    credential.accountExport.protocol === 'zcash-accounts-v1'
      ? await provisionRetainedZcashHardware(
          credential,
          input.displayName,
          password,
          birthdayHeight,
          isFirstWallet
        )
      : await credentialLifecycle.provisionKeystoneHardware({
          credential: parseKeystoneHardwareCredential(credential),
          displayName: input.displayName,
          password,
          network: DEFAULT_NETWORK
        })
  if (isFirstWallet) {
    const descriptor = await credentialSession.unlock(password)
    if (!descriptor) throw new Error('Hardware Wallet provisioning produced an empty session')
    await Promise.all([SecureStorage.resetLoginAttempts(), SecureStorage.saveLastActivityTime()])
  }
  return result
}

export function provisionKeystoneHardware(input: ProvisionHardwareWalletInput) {
  return provisionHardwareWallet(input, 'keystone')
}

export function provisionLedgerHardware(input: ProvisionHardwareWalletInput) {
  return provisionHardwareWallet(input, 'ledger')
}
