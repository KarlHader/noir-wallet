import { parseAccountId } from '@/core/accounts/domain'
import { parseKeyDomainId } from '@/core/keyring/domain'
import { backgroundZcashWalletRuntime } from './zcash-wallet-runtime'
import {
  deleteIndexedDbBitcoinChangeReservations,
  IndexedDbBitcoinChangeReservationRepository
} from '@/infrastructure/chains/bitcoin/bitcoin-change-reservation-repository'
import {
  deleteIndexedDbBitcoinDiscovery,
  IndexedDbBitcoinDiscoveryRepository
} from '@/infrastructure/chains/bitcoin/bitcoin-discovery-repository'
import {
  deleteIndexedDbBitcoinInputReservations,
  IndexedDbBitcoinInputReservationRepository
} from '@/infrastructure/chains/bitcoin/bitcoin-input-reservation-repository'
import {
  CredentialRemovalCoordinator,
  CredentialRemovalUnlockRequiredError
} from '@/infrastructure/keyring/migration'
import {
  deleteStorageV2Persistence,
  deleteIndexedDbPortfolioCache,
  deleteIndexedDbTransactionPersistence,
  IndexedDbCredentialRepository,
  IndexedDbPortfolioCacheRepository,
  IndexedDbStorageV2Repository,
  IndexedDbTransactionRepository
} from '@/infrastructure/persistence/repositories'
import {
  deleteHistoryCache,
  deleteHistoryCacheByAccountScope
} from '@/infrastructure/chains/evm/evm-activity-history-cache'
import { rehydrateAccountDataStore, useAccountDataStore } from '@/store/account-data-store'
import { flushWalletStore, rehydrateWalletStore, useWalletStore } from '@/store/wallet-store'
import {
  commitWalletMetadataDeletion,
  commitAccountMetadataDeletion,
  completeLegacyPendingCleanup,
  finalizeLegacyAccountMetadataDeletion,
  completeAccountMetadataDeletion,
  completeWalletMetadataDeletion,
  getAccountDeletionRecord,
  getLegacyPendingCleanups,
  getPendingAccountCleanups,
  getPendingWalletCleanups,
  getWalletDeletionRecord,
  readWalletMetadata,
  renameRetainedAccountMetadata,
  renameRetainedWalletMetadata,
  resetWalletMetadata
} from '@/lib/wallet-metadata-storage'
import { blockWalletRecords, getBlockedWalletIds, unblockWalletRecords } from '@/lib/indexed-db'
import { dappHandler } from './dapp-handler'
import { syncScheduler } from './sync-scheduler'
import { transactionMonitor } from './transaction-monitor'
import { zcashTxMonitor } from './zcash-tx-monitor'
import { credentialSession } from './credential-session'
import { OffscreenCompatibilityWorkerPort } from './offscreen-compatibility-worker'
import { accountContextTransition } from './account-context-transition'
import {
  clearAllSwapApprovalContinuations,
  clearSwapApprovalContinuationsForAccount
} from './swap-approval-continuation'
import { WalletMetadataCoordinator } from '@/infrastructure/keyring/wallet-metadata-coordinator'
import { pendingRequestsManager } from './pending-requests'
import {
  getDetectedEvmAssetCatalogStorageKey,
  getUserEvmAssetCatalogStorageKey
} from '@/infrastructure/chains/evm'
import {
  getLegacyEvmAssetVisibilityStorageKey,
  getTokenVisibilityStorageKey
} from '@/infrastructure/portfolio/chrome-token-visibility'
import {
  DEFI_LLAMA_MARKET_CACHE_STORAGE_KEY,
  USER_ASSET_DEX_POOL_CACHE_STORAGE_KEY,
  USER_ASSET_MARKET_CACHE_STORAGE_KEY,
  USER_ASSET_ONE_CLICK_PRICE_CACHE_STORAGE_KEY
} from '@/infrastructure/prices'
import {
  deleteLendingMarketCache,
  LENDING_MARKET_CACHE_STORAGE_KEY
} from '@/infrastructure/lending/chrome-lending-market-cache'
import { SWAP_TOKEN_CATALOG_CACHE_STORAGE_KEY } from '@/infrastructure/persistence/swap-token-catalog-storage'
import { ActivityHistoryCache } from './activity-history-cache'
import { dappExecutionModeCoordinator } from './dapp-execution-mode'
import type { WalletBackupVerification } from '@/core/wallet/secret-phrase-backup'
import { isNativeV2CredentialKeyDomain } from '@/core/wallet/native-hardware-identity'
import type { StorageV2Snapshot } from '@/ports/repositories'

type ActiveAccount = {
  walletId: string | null
  accountId: string | null
}

async function blockWalletWrites(walletId: string): Promise<void> {
  await blockWalletRecords('mainnet', walletId)
  await blockWalletRecords('testnet', walletId)
}

async function unblockWalletWrites(walletId: string): Promise<void> {
  await unblockWalletRecords('mainnet', walletId)
  await unblockWalletRecords('testnet', walletId)
}

export class WalletCleanupCoordinator {
  private queue: Promise<void> = Promise.resolve()
  private readonly credentialRepository = new IndexedDbCredentialRepository()
  private readonly storageRepository = new IndexedDbStorageV2Repository()
  private readonly compatibilityWorker = new OffscreenCompatibilityWorkerPort()
  private readonly credentialRemoval = new CredentialRemovalCoordinator({
    credentialRepository: this.credentialRepository,
    storageRepository: this.storageRepository,
    compatibilityWorker: this.compatibilityWorker
  })
  private readonly walletMetadata = new WalletMetadataCoordinator({
    credentialRepository: this.credentialRepository,
    storageRepository: this.storageRepository
  })
  private readonly bitcoinDiscovery = new IndexedDbBitcoinDiscoveryRepository()
  private readonly bitcoinChangeReservations = new IndexedDbBitcoinChangeReservationRepository()
  private readonly bitcoinInputReservations = new IndexedDbBitcoinInputReservationRepository()
  private readonly transactionRepository = new IndexedDbTransactionRepository()
  private readonly portfolioCache = new IndexedDbPortfolioCacheRepository()
  private readonly activityHistoryCache = new ActivityHistoryCache('mainnet')

  constructor(
    private readonly notifyAccountSwitched: (options?: {
      refreshPortfolio?: boolean
    }) => Promise<void>,
    private readonly clearPendingMultichainTransfers: () => Promise<void> = async () => {},
    private readonly removePendingCrossChainAccounts: (
      walletId: string,
      accountIds: readonly string[]
    ) => Promise<void> = async () => {}
  ) {}

  private enqueue<T>(mutation: () => Promise<T>): Promise<T> {
    const task = this.queue
      .catch(() => {})
      .then(async () => {
        syncScheduler.pauseForTx()
        try {
          return await mutation()
        } finally {
          syncScheduler.resumeAfterTx()
        }
      })
    this.queue = task.then(
      () => undefined,
      () => undefined
    )
    return task
  }

  private getActiveAccount(): ActiveAccount {
    const { currentWalletId, currentAccountId } = useWalletStore.getState()
    return {
      walletId: currentWalletId,
      accountId: currentAccountId
    }
  }

  private async hydrateStores(): Promise<void> {
    await Promise.all([rehydrateWalletStore(), rehydrateAccountDataStore()])
  }

  private async assertAnotherWalletRemains(
    walletId: string,
    existingSnapshot?: StorageV2Snapshot
  ): Promise<void> {
    const pointer = await this.storageRepository.getActivePointer()
    if (!pointer) throw new Error('Wallet inventory is unavailable')
    const snapshot =
      existingSnapshot ?? (await this.storageRepository.getSnapshot(pointer.generationId))
    if (!snapshot) throw new Error('Active Storage V2 generation is missing')
    if (
      snapshot.manifest.status !== 'verified' ||
      snapshot.manifest.generationId !== pointer.generationId ||
      snapshot.manifest.sourceFingerprint !== pointer.sourceFingerprint
    ) {
      throw new Error('Active Storage V2 generation does not match its pointer')
    }
    if (!snapshot.keyDomains.some(keyDomain => keyDomain.id === walletId)) {
      throw new Error('Wallet not found')
    }
    if (!snapshot.accounts.some(account => account.keyDomainId === walletId)) {
      throw new Error('Wallet has no Accounts')
    }
    if (!snapshot.accounts.some(account => account.keyDomainId !== walletId)) {
      throw new Error('Cannot remove the last wallet. Use Reset Wallet instead.')
    }
  }

  private async resumeAfterMutation(
    previous: ActiveAccount,
    resumeCurrentWallet: boolean
  ): Promise<void> {
    const current = this.getActiveAccount()
    const currentChanged =
      current.walletId !== previous.walletId || current.accountId !== previous.accountId

    if (current.walletId && current.accountId && (currentChanged || resumeCurrentWallet)) {
      await backgroundZcashWalletRuntime.initialize()
      if (!backgroundZcashWalletRuntime.isLocked()) {
        await backgroundZcashWalletRuntime.ensureWalletCoreAccount(
          current.walletId,
          current.accountId
        )
      }
      syncScheduler.onAccountSwitched(current.walletId)
    }

    if (currentChanged) {
      await this.notifyAccountSwitched()
    }
  }

  private async refreshCredentialSessionAfterWalletRemoval(password: string | null): Promise<void> {
    if (!password) return
    try {
      await credentialSession.unlock(password)
    } catch {
      await credentialSession.lock().catch(() => {})
      await backgroundZcashWalletRuntime.lock()
    }
  }

  async resumePendingCleanup(): Promise<void> {
    const network = backgroundZcashWalletRuntime.getNetwork()
    const pendingWallets = await getPendingWalletCleanups()
    const pendingAccounts = await getPendingAccountCleanups()
    const legacyPending = await getLegacyPendingCleanups()
    const activeWalletIds = new Set(
      (await readWalletMetadata())?.state.wallets.map(wallet => wallet.id) ?? []
    )
    const blockedWallets = new Set([
      ...(await getBlockedWalletIds('mainnet')),
      ...(await getBlockedWalletIds('testnet'))
    ])
    for (const walletId of blockedWallets) {
      if (
        activeWalletIds.has(walletId) &&
        !pendingWallets.includes(walletId) &&
        !legacyPending.some(pending => pending.walletId === walletId) &&
        !pendingAccounts.some(
          pending => pending.network === network && pending.walletId === walletId
        )
      ) {
        await unblockWalletWrites(walletId)
      }
    }
    for (const walletId of pendingWallets) {
      await this.removeWallet(walletId)
    }
    for (const pending of pendingAccounts) {
      if (pending.network !== network) continue
      if (!backgroundZcashWalletRuntime.getSessionPassword()) {
        try {
          await this.credentialRemoval.preflightAccountRemoval(
            pending.walletId,
            pending.accountId,
            null,
            network
          )
        } catch (error) {
          if (error instanceof CredentialRemovalUnlockRequiredError) continue
          throw error
        }
      }
      await this.removeAccount(pending.walletId, pending.accountId)
    }
    for (const pending of legacyPending) {
      if (pending.walletDeleted) {
        await this.resumeLegacyWalletRemoval(pending.walletId)
      } else if (pending.accounts.length > 0) {
        if (!backgroundZcashWalletRuntime.getSessionPassword()) {
          let requiresUnlock = false
          for (const account of pending.accounts) {
            try {
              await this.credentialRemoval.preflightAccountRemoval(
                pending.walletId,
                account.accountId,
                null,
                account.network
              )
            } catch (error) {
              if (!(error instanceof CredentialRemovalUnlockRequiredError)) throw error
              requiresUnlock = true
              break
            }
          }
          if (requiresUnlock) continue
        }
        await this.resumeLegacyAccountRemoval(pending.walletId, pending.accounts)
      } else if (pending.walletPresent) {
        await this.resumeLegacyUncommittedRemoval(pending.walletId)
      } else {
        throw new Error('Interrupted V1 wallet cleanup has no recoverable metadata')
      }
    }
  }

  private async resumeLegacyUncommittedRemoval(walletId: string): Promise<void> {
    await this.enqueue(async () => {
      await this.hydrateStores()
      if (!useWalletStore.getState().getWallet(walletId)) {
        throw new Error('Interrupted V1 wallet cleanup has no recoverable metadata')
      }
      await syncScheduler.cancelWalletRemoval(walletId)
      await unblockWalletWrites(walletId)
      await completeLegacyPendingCleanup(walletId)
      if (this.getActiveAccount().walletId === walletId) {
        syncScheduler.onAccountSwitched(walletId)
      }
    })
  }

  private async resumeLegacyWalletRemoval(walletId: string): Promise<void> {
    await this.enqueue(async () => {
      await this.hydrateStores()
      await blockWalletWrites(walletId)
      await syncScheduler.prepareWalletRemoval(walletId)
      await backgroundZcashWalletRuntime.removeWalletAuthoritatively(walletId, [])
      await this.credentialRemoval.removeWallet(walletId)
      await dappHandler.removeAccountReferences(walletId)
      const accountData = useAccountDataStore.getState()
      for (const network of ['mainnet', 'testnet'] as const) {
        const prefix = `${network}_${walletId}_`
        const accountIds = new Set(
          [
            ...accountData.balances.keys(),
            ...accountData.syncStates.keys(),
            ...accountData.portfolioValues.keys()
          ]
            .filter(key => key.startsWith(prefix))
            .map(key => key.slice(prefix.length))
        )
        await accountData.deleteWalletData(network, walletId, [...accountIds])
      }
      await completeWalletMetadataDeletion(walletId)
      await completeLegacyPendingCleanup(walletId)
    })
  }

  private async resumeLegacyAccountRemoval(
    walletId: string,
    accounts: readonly {
      accountId: string
      network: 'mainnet' | 'testnet'
      derivationIndex?: number
    }[]
  ): Promise<void> {
    await this.enqueue(async () => {
      await this.hydrateStores()
      const previous = this.getActiveAccount()
      await syncScheduler.prepareAccountRemoval(walletId)
      await blockWalletWrites(walletId)
      for (const account of accounts) {
        await this.removeMultichainAccountData(walletId, account.accountId)
        await backgroundZcashWalletRuntime.finishAccountRemovalCleanup(
          walletId,
          account.accountId,
          account.derivationIndex
        )
        const credentialRemoval = await this.credentialRemoval.removeAccount(
          walletId,
          account.accountId,
          backgroundZcashWalletRuntime.getSessionPassword(),
          account.network
        )
        if (credentialRemoval.transactionId) {
          await this.refreshCredentialSessionAfterWalletRemoval(
            backgroundZcashWalletRuntime.getSessionPassword()
          )
        }
        await dappHandler.removeAccountReferences(walletId, account.accountId)
      }
      await finalizeLegacyAccountMetadataDeletion(walletId, accounts)
      await unblockWalletWrites(walletId)
      await this.resumeAfterMutation(previous, previous.walletId === walletId)
      await completeLegacyPendingCleanup(walletId)
    })
  }

  removeAccount(
    walletId: string,
    accountId: string,
    verification?: WalletBackupVerification
  ): Promise<void> {
    return this.enqueue(async () => {
      await this.hydrateStores()
      const previous = this.getActiveAccount()
      const wallet = useWalletStore.getState().getWallet(walletId)
      const account = wallet?.accounts.find(candidate => candidate.id === accountId)
      if (!wallet || !account) {
        if (await getWalletDeletionRecord(walletId)) {
          await this.removeNativeStorageV2Wallet(walletId, previous)
        } else {
          const derivationIndex = await getAccountDeletionRecord(
            walletId,
            accountId,
            backgroundZcashWalletRuntime.getNetwork()
          )
          if (derivationIndex !== null) {
            await accountContextTransition.runScopedMutation(
              [{ walletId, accountId }],
              async () => {
                await syncScheduler.prepareAccountRemoval(walletId)
                await blockWalletWrites(walletId)
                await this.removeMultichainAccountData(walletId, accountId)
                await backgroundZcashWalletRuntime.finishAccountRemovalCleanup(
                  walletId,
                  accountId,
                  derivationIndex
                )
                const credentialRemoval = await this.credentialRemoval.removeAccount(
                  walletId,
                  accountId,
                  backgroundZcashWalletRuntime.getSessionPassword(),
                  backgroundZcashWalletRuntime.getNetwork()
                )
                if (credentialRemoval.transactionId) {
                  await this.refreshCredentialSessionAfterWalletRemoval(
                    backgroundZcashWalletRuntime.getSessionPassword()
                  )
                }
                await unblockWalletWrites(walletId)
                await this.resumeAfterMutation(previous, true)
                await completeAccountMetadataDeletion(
                  walletId,
                  accountId,
                  backgroundZcashWalletRuntime.getNetwork()
                )
              }
            )
          }
        }
        return
      }

      await accountContextTransition.runScopedMutation([{ walletId, accountId }], async () => {
        const removesWallet = wallet.accounts.length === 1
        const sessionPassword = backgroundZcashWalletRuntime.getSessionPassword()
        if (removesWallet) {
          await backgroundZcashWalletRuntime.verifyWalletBackupForRemoval(walletId, verification)
          await this.assertAnotherWalletRemains(walletId)
          await syncScheduler.prepareWalletRemoval(walletId)
          await blockWalletWrites(walletId)
          try {
            await commitWalletMetadataDeletion(
              walletId,
              wallet.accounts.map(item => item.id)
            )
          } catch (error) {
            await unblockWalletWrites(walletId)
            await syncScheduler.cancelWalletRemoval(walletId)
            throw error
          }
        } else {
          await syncScheduler.prepareAccountRemoval(walletId)
          await blockWalletWrites(walletId)
          try {
            await this.credentialRemoval.preflightAccountRemoval(
              walletId,
              accountId,
              sessionPassword,
              backgroundZcashWalletRuntime.getNetwork()
            )
            await commitAccountMetadataDeletion(
              walletId,
              accountId,
              backgroundZcashWalletRuntime.getNetwork(),
              account.derivationIndex
            )
          } catch (error) {
            await unblockWalletWrites(walletId)
            await syncScheduler.cancelWalletRemoval(walletId)
            throw error
          }
        }
        if (removesWallet) {
          await Promise.all([
            transactionMonitor.removeAccount(walletId),
            zcashTxMonitor.removeAccount(walletId),
            this.removePendingCrossChainAccounts(
              walletId,
              wallet.accounts.map(item => item.id)
            ),
            dappHandler.removeAccountReferences(walletId)
          ])
        } else {
          await Promise.all([
            transactionMonitor.removeAccount(walletId, accountId),
            zcashTxMonitor.removeAccount(walletId, accountId),
            this.removePendingCrossChainAccounts(walletId, [accountId]),
            dappHandler.removeAccountReferences(walletId, accountId)
          ])
        }
        await this.removeMultichainAccountData(walletId, accountId)

        if (removesWallet) {
          await backgroundZcashWalletRuntime.removeWalletAuthoritatively(
            walletId,
            wallet.accounts.map(item => item.id)
          )
          await this.credentialRemoval.removeWallet(walletId)
        } else {
          const removed = await backgroundZcashWalletRuntime.removeAccountAuthoritatively(
            walletId,
            accountId
          )
          if (removed === 'missing') {
            await backgroundZcashWalletRuntime.finishAccountRemovalCleanup(
              walletId,
              accountId,
              account.derivationIndex
            )
          }
          const credentialRemoval = await this.credentialRemoval.removeAccount(
            walletId,
            accountId,
            sessionPassword,
            backgroundZcashWalletRuntime.getNetwork()
          )
          if (credentialRemoval.transactionId) {
            await this.refreshCredentialSessionAfterWalletRemoval(sessionPassword)
          }
          await unblockWalletWrites(walletId)
        }
        if (removesWallet) {
          await this.refreshCredentialSessionAfterWalletRemoval(sessionPassword)
        }
        await this.resumeAfterMutation(previous, !removesWallet)
        if (removesWallet) await completeWalletMetadataDeletion(walletId)
        else {
          await completeAccountMetadataDeletion(
            walletId,
            accountId,
            backgroundZcashWalletRuntime.getNetwork()
          )
        }
      })
    })
  }

  removeWallet(walletId: string, verification?: WalletBackupVerification): Promise<void> {
    return this.enqueue(async () => {
      await this.hydrateStores()
      const previous = this.getActiveAccount()
      const wallet = useWalletStore.getState().getWallet(walletId)
      if (!wallet) {
        await this.removeNativeStorageV2Wallet(walletId, previous)
        return
      }
      await accountContextTransition.runScopedMutation(
        wallet.accounts.map(account => ({ walletId, accountId: account.id })),
        async () => {
          const sessionPassword = backgroundZcashWalletRuntime.getSessionPassword()
          await backgroundZcashWalletRuntime.verifyWalletBackupForRemoval(walletId, verification)
          await this.assertAnotherWalletRemains(walletId)
          await syncScheduler.prepareWalletRemoval(walletId)
          await blockWalletWrites(walletId)
          try {
            await commitWalletMetadataDeletion(
              walletId,
              wallet.accounts.map(item => item.id)
            )
          } catch (error) {
            await unblockWalletWrites(walletId)
            await syncScheduler.cancelWalletRemoval(walletId)
            throw error
          }
          await Promise.all([
            transactionMonitor.removeAccount(walletId),
            zcashTxMonitor.removeAccount(walletId),
            this.removePendingCrossChainAccounts(
              walletId,
              wallet.accounts.map(item => item.id)
            ),
            dappHandler.removeAccountReferences(walletId)
          ])
          await Promise.all(
            wallet.accounts.map(account => this.removeMultichainAccountData(walletId, account.id))
          )
          await backgroundZcashWalletRuntime.removeWalletAuthoritatively(walletId)
          await this.credentialRemoval.removeWallet(walletId)
          await this.refreshCredentialSessionAfterWalletRemoval(sessionPassword)
          await this.resumeAfterMutation(previous, false)
          await completeWalletMetadataDeletion(walletId)
        }
      )
    })
  }

  renameAccount(walletId: string, accountId: string, displayName: string): Promise<void> {
    return this.enqueue(() =>
      accountContextTransition.runActiveOperation(async () => {
        if (!(await credentialSession.hasUnlockSession())) throw new Error('Wallet is locked')
        await this.hydrateStores()
        const pointer = await this.storageRepository.getActivePointer()
        if (!pointer) throw new Error('Account not found')
        const snapshot = await this.storageRepository.getSnapshot(pointer.generationId)
        if (!snapshot) throw new Error('Active Storage V2 generation is missing')
        const keyDomain = snapshot.keyDomains.find(item => item.id === walletId)
        const catalogAccount = snapshot.accounts.find(
          item => item.id === accountId && item.keyDomainId === walletId
        )
        if (!keyDomain || !catalogAccount) throw new Error('Account not found')
        const wallet = useWalletStore.getState().getWallet(walletId)
        const account = wallet?.accounts.find(candidate => candidate.id === accountId)
        if (
          !account &&
          !isNativeV2CredentialKeyDomain(keyDomain) &&
          !(wallet && keyDomain.source.kind === 'hardware')
        ) {
          throw new Error('Account not found')
        }

        const previousName = account
          ? useWalletStore.getState().getAccountDisplayName(walletId, accountId)
          : null
        const result = await this.walletMetadata.renameAccount({
          keyDomainId: walletId,
          accountId,
          displayName
        })
        if (result.status === 'storage-v2-inactive') throw new Error('Account not found')
        if (account) {
          try {
            await renameRetainedAccountMetadata(
              walletId,
              accountId,
              previousName,
              displayName.normalize('NFC')
            )
          } catch (error) {
            try {
              await this.walletMetadata.renameAccount({
                keyDomainId: walletId,
                accountId,
                displayName: catalogAccount.displayName
              })
            } catch {
              throw new Error(
                'Account rename failed and its metadata rollback could not be verified'
              )
            }
            throw error
          }
          await rehydrateWalletStore()
        }
        await chrome.runtime.sendMessage({ type: 'ACCOUNT_CONTEXT_CHANGED' }).catch(() => {})
      })
    )
  }

  setAccountPinned(walletId: string, accountId: string, pinned: boolean): Promise<void> {
    return this.setAccountPreference(walletId, accountId, 'isPinned', pinned)
  }

  setAccountHidden(walletId: string, accountId: string, hidden: boolean): Promise<void> {
    return this.setAccountPreference(walletId, accountId, 'isHidden', hidden)
  }

  private setAccountPreference(
    walletId: string,
    accountId: string,
    preference: 'isPinned' | 'isHidden',
    value: boolean
  ): Promise<void> {
    return this.enqueue(async () => {
      if (!(await credentialSession.hasUnlockSession())) throw new Error('Wallet is locked')
      await this.hydrateStores()
      const account = useWalletStore.getState().getAccount(walletId, accountId)
      if (!account) throw new Error('Account not found')
      const previousValue = account[preference]
      if (previousValue === value) return

      useWalletStore.getState().updateAccountInWallets(walletId, accountId, { [preference]: value })
      try {
        await flushWalletStore()
      } catch (error) {
        useWalletStore
          .getState()
          .updateAccountInWallets(walletId, accountId, { [preference]: previousValue })
        throw error
      }
    })
  }

  renameNativeWallet(walletId: string, displayName: string) {
    return this.enqueue(() =>
      accountContextTransition.runActiveOperation(async () => {
        if (!(await credentialSession.hasUnlockSession())) throw new Error('Wallet is locked')
        await this.hydrateStores()
        const pointer = await this.storageRepository.getActivePointer()
        if (!pointer) throw new Error('Wallet not found')
        const snapshot = await this.storageRepository.getSnapshot(pointer.generationId)
        if (!snapshot) throw new Error('Active Storage V2 generation is missing')
        const keyDomain = snapshot.keyDomains.find(item => item.id === walletId)
        if (!keyDomain) throw new Error('Wallet not found')
        const wallet = useWalletStore.getState().getWallet(walletId)
        if (!wallet && !isNativeV2CredentialKeyDomain(keyDomain)) {
          throw new Error('Wallet not found')
        }
        const result = await this.walletMetadata.renameWallet({
          keyDomainId: walletId,
          displayName
        })
        if (result.status === 'storage-v2-inactive') throw new Error('Wallet not found')
        if (wallet) {
          try {
            await renameRetainedWalletMetadata(walletId, wallet.name, displayName.normalize('NFC'))
          } catch (error) {
            try {
              await this.walletMetadata.renameWallet({
                keyDomainId: walletId,
                displayName: keyDomain.displayName
              })
            } catch {
              throw new Error(
                'Wallet rename failed and its metadata rollback could not be verified'
              )
            }
            throw error
          }
          await rehydrateWalletStore()
        }
        await chrome.runtime.sendMessage({ type: 'ACCOUNT_CONTEXT_CHANGED' }).catch(() => {})
        return result
      })
    )
  }

  reset(): Promise<void> {
    return this.enqueue(async () => {
      await this.hydrateStores()
      const wallets = useWalletStore.getState().wallets
      await accountContextTransition.runActiveOperation(async () => {
        for (const wallet of wallets) {
          await syncScheduler.prepareWalletRemoval(wallet.id)
          await blockWalletWrites(wallet.id)
        }
        await credentialSession.lock()
        await resetWalletMetadata()
        await this.clearPendingMultichainTransfers()
        await Promise.all([
          transactionMonitor.clear(),
          zcashTxMonitor.clear(),
          dappHandler.clearConnections()
        ])
        await Promise.all([
          deleteIndexedDbTransactionPersistence(),
          deleteIndexedDbPortfolioCache(),
          deleteIndexedDbBitcoinDiscovery(),
          deleteIndexedDbBitcoinChangeReservations(),
          deleteIndexedDbBitcoinInputReservations(),
          deleteHistoryCache(),
          this.activityHistoryCache.clear(),
          dappExecutionModeCoordinator.clear(),
          clearAllSwapApprovalContinuations(),
          chrome.storage.local.remove([
            getUserEvmAssetCatalogStorageKey('mainnet'),
            getUserEvmAssetCatalogStorageKey('testnet'),
            getDetectedEvmAssetCatalogStorageKey('mainnet'),
            getDetectedEvmAssetCatalogStorageKey('testnet'),
            getTokenVisibilityStorageKey('mainnet'),
            getTokenVisibilityStorageKey('testnet'),
            getLegacyEvmAssetVisibilityStorageKey('mainnet'),
            getLegacyEvmAssetVisibilityStorageKey('testnet'),
            USER_ASSET_DEX_POOL_CACHE_STORAGE_KEY,
            USER_ASSET_MARKET_CACHE_STORAGE_KEY,
            USER_ASSET_ONE_CLICK_PRICE_CACHE_STORAGE_KEY,
            DEFI_LLAMA_MARKET_CACHE_STORAGE_KEY,
            'coin_gecko_market_change_cache_v1',
            LENDING_MARKET_CACHE_STORAGE_KEY,
            SWAP_TOKEN_CATALOG_CACHE_STORAGE_KEY
          ])
        ])
        await backgroundZcashWalletRuntime.resetWalletDataAuthoritatively(
          wallets.map(wallet => wallet.id)
        )
        await this.notifyAccountSwitched({ refreshPortfolio: false })
        await deleteStorageV2Persistence()
      })
    })
  }

  private async removeMultichainAccountData(walletId: string, accountId: string): Promise<void> {
    const scope = {
      keyDomainId: parseKeyDomainId(walletId),
      accountId: parseAccountId(accountId)
    }
    await Promise.all([
      this.bitcoinDiscovery.deleteByAccountScope(scope),
      this.bitcoinChangeReservations.deleteByAccountScope(scope),
      this.bitcoinInputReservations.deleteByAccountScope(scope),
      deleteHistoryCacheByAccountScope(scope),
      this.transactionRepository.deleteByAccountScope(scope),
      this.portfolioCache.deleteByAccountScope(scope),
      deleteLendingMarketCache(walletId, accountId),
      this.activityHistoryCache.deleteByScope(scope),
      dappExecutionModeCoordinator.removeAccount(walletId, accountId),
      clearSwapApprovalContinuationsForAccount(walletId, accountId)
    ])
  }

  private async removeNativeStorageV2Wallet(
    walletId: string,
    previous: ActiveAccount
  ): Promise<void> {
    const pointer = await this.storageRepository.getActivePointer()
    const deletedAccountIds = await getWalletDeletionRecord(walletId)
    if (!pointer && !deletedAccountIds) throw new Error('Wallet not found')
    const snapshot = pointer ? await this.storageRepository.getSnapshot(pointer.generationId) : null
    if (pointer && !snapshot) throw new Error('Active Storage V2 generation is missing')
    const keyDomain = snapshot?.keyDomains.find(item => item.id === walletId)
    if (!keyDomain && !deletedAccountIds) throw new Error('Wallet not found')
    if (keyDomain && !isNativeV2CredentialKeyDomain(keyDomain) && !deletedAccountIds) {
      throw new Error('Wallet metadata is not managed by the native Wallet inventory')
    }
    if (!deletedAccountIds) await this.assertAnotherWalletRemains(walletId, snapshot ?? undefined)
    const accountIds =
      deletedAccountIds ??
      snapshot?.accounts
        .filter(account => account.keyDomainId === walletId)
        .map(account => account.id) ??
      []
    if (accountIds.length === 0) throw new Error('Wallet has no Accounts')
    const password = await credentialSession.getProvisioningPassword().catch(() => null)

    await accountContextTransition.runScopedMutation(
      accountIds.map(accountId => ({ walletId, accountId })),
      async () => {
        let committed = false
        try {
          await syncScheduler.prepareMetadataOnlyWalletRemoval(walletId)
          pendingRequestsManager.cancelContext(walletId)
          await commitWalletMetadataDeletion(walletId, accountIds)
          committed = true
          await this.removePendingCrossChainAccounts(walletId, accountIds)
          const cleanup = await Promise.allSettled([
            transactionMonitor.removeAccount(walletId),
            zcashTxMonitor.removeAccount(walletId),
            dappHandler.removeAccountReferences(walletId),
            ...accountIds.map(accountId => this.removeMultichainAccountData(walletId, accountId))
          ])
          const cleanupIncomplete = cleanup.some(result => result.status === 'rejected')
          if (deletedAccountIds) {
            await backgroundZcashWalletRuntime.removeWalletAuthoritatively(walletId, accountIds)
          }
          await this.credentialRemoval.removeWallet(walletId)
          await this.refreshCredentialSessionAfterWalletRemoval(password)
          await this.resumeAfterMutation(previous, false)
          await this.notifyAccountSwitched()
          if (cleanupIncomplete)
            throw new Error('Wallet removal cleanup is incomplete; retry removal')
          await completeWalletMetadataDeletion(walletId)
        } catch (error) {
          if (!committed) await syncScheduler.cancelWalletRemoval(walletId)
          throw error
        }
      }
    )
  }
}
