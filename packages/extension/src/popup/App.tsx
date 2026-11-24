import { lazy, Suspense, useEffect, useRef, type ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { ToastContainer } from './components/common/ToastContainer'
import { TestnetModeBanner } from './components/shell/TestnetModeBanner'
import { RouterProvider, Routes, Route, useLocation, useNavigate } from './provider/Router'
import { SecretPhraseBackupBanner } from './components/shell/SecretPhraseBackupBanner'
import { ModalProvider } from './provider/ModalManager'
import { DialogProvider } from './hooks/useDialog'
import { RouteLoadingSkeleton } from './components/common/RouteLoadingSkeleton'
import { WalletInitializing } from './components/ui/wallet-initializing'
import { BlockingWalletFailure } from './components/shell/BlockingWalletFailure'
import { PageHeader } from './components/common/PageHeader'
import { useAppRouting } from './hooks/useAppRouting'
import { usePersistedExtensionContextSync } from './hooks/usePersistedExtensionContextSync'
import { useAccountDataStore, buildAccountKey } from '@/store/account-data-store'
import { rehydrateWalletStore, useWalletStore } from '@/store/wallet-store'
import { isTransactionStatusUpdatedMessage } from '@/types/transaction-messages'
import { getOwnExtensionSenderContext } from '@/lib/runtime-message-security'
import { parseTransactionId } from '@/core/transactions/domain'
import { isSidePanelSurface } from '@/lib/extension-display-mode'
import { initializeAddressBook } from '@/store/address-book-store'
import { resolveLegacyShieldFundsPath } from './services/home-navigation'

// Pages
import { Home } from './pages/Home'

// Onboarding Pages
import { Welcome } from './pages/onboarding/Welcome'
import { Password } from './pages/onboarding/Password'
import { SecureWallet } from './pages/onboarding/SecureWallet'
import { ViewPhrase } from './pages/onboarding/ViewPhrase'
import { ConfirmPhrase } from './pages/onboarding/ConfirmPhrase'
import { Congratulations } from './pages/onboarding/Congratulations'
import { ImportWordCount } from './pages/onboarding/ImportWordCount'
import { CreateWordCount } from './pages/onboarding/CreateWordCount'
import { ImportWallet } from './pages/onboarding/ImportWallet'
import { ImportAccounts } from './pages/onboarding/ImportAccounts'
import { ImportPassword } from './pages/onboarding/ImportPassword'
import { Unlock } from './pages/onboarding/Unlock'

// Account Pages
import { AccountList } from './pages/account/AccountList'
import { AccountDetail } from './pages/account/AccountDetail'
import { ManageAccountNetworks } from './pages/account/ManageAccountNetworks'
import { AddressesList } from './pages/account/AddressesList'
import { ZcashSettings } from './pages/account/ZcashSettings'
import { ImportPrivateKey } from './pages/account/ImportPrivateKey'
import { ExportPrivateKey } from './pages/account/ExportPrivateKey'

// Transaction Pages
import { Send } from './pages/transactions/Send'
import { DepositWithdraw } from './pages/transactions/DepositWithdraw'
import { ShieldFundsPage, UnshieldFundsPage } from './pages/transactions/ShieldFunds'
import { TransactionOutcome } from './pages/transactions/TransactionOutcome'
import { AssetDetail } from './pages/portfolio/AssetDetail'
import { ShieldProviderDetail } from './pages/portfolio/ShieldProviderDetail'
import { Receive } from './pages/portfolio/Receive'

// Swap Page
import { Swap } from './pages/swap/Swap'

// Hardware Wallet Pages (full-tab flows)
import { KeystoneConnect } from './pages/hardware/KeystoneConnect'
import { HardwareConnect } from './pages/hardware/HardwareConnect'
import { KeystoneSign } from './pages/hardware/KeystoneSign'
import { KeystoneTransferSign } from './pages/hardware/KeystoneTransferSign'

// DApp Pages
import { Approval } from './pages/dapp/Approval'
import { EvmWalletChoice } from './pages/dapp/EvmWalletChoice'
import { DAppConnections } from './pages/dapp/DAppConnections'

// Settings Pages
import { Settings } from './pages/settings/Settings'
import { General } from './pages/settings/General'
import { Networks } from './pages/settings/Networks'
import { DefaultEvmWallet } from './pages/settings/DefaultEvmWallet'
import { ManageTokens } from './pages/settings/ManageTokens'
import { SecurityPrivacy } from './pages/settings/SecurityPrivacy'
import { ZeroIndexerNodes } from './pages/settings/ZeroIndexerNodes'
import { ChangePassword } from './pages/settings/ChangePassword'
import { About } from './pages/settings/About'
import { Help } from './pages/settings/Help'
import { DeveloperSettings } from './pages/settings/DeveloperSettings'
import { AddressBook } from './pages/settings/AddressBook'
import { TermsOfUse } from './pages/settings/TermsOfUse'
import { ViewSeedPhrase } from './pages/settings/ViewSeedPhrase'
import { VotingRounds } from './pages/voting/VotingRounds'
import { VotingRound } from './pages/voting/VotingRound'
import { Update } from './pages/Update'

import { useOnboardingStore } from '@/store/onboarding-store'
import {
  resolveBitcoinFeatureRuntimePolicy,
  resolveEvmFeatureRuntimePolicy,
  resolveNearFeatureRuntimePolicy,
  resolveSolanaFeatureRuntimePolicy
} from '@/core/chains/feature-runtime-policy'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'

const LedgerConnect = lazy(() =>
  import('./pages/hardware/LedgerConnect').then(module => ({
    default: module.LedgerConnect
  }))
)
const LedgerSign = lazy(() =>
  import('./pages/hardware/LedgerSign').then(module => ({ default: module.LedgerSign }))
)
import { useActiveAccountNetworks } from './hooks/useActiveAccountNetworks'

const multichainSendEnabled =
  resolveEvmFeatureRuntimePolicy(__ENABLED_CHAIN_FEATURE_FLAGS__).newOperationsEnabled ||
  resolveBitcoinFeatureRuntimePolicy(__ENABLED_CHAIN_FEATURE_FLAGS__).newOperationsEnabled ||
  resolveSolanaFeatureRuntimePolicy(__ENABLED_CHAIN_FEATURE_FLAGS__).newOperationsEnabled ||
  resolveNearFeatureRuntimePolicy(__ENABLED_CHAIN_FEATURE_FLAGS__).newOperationsEnabled
const evmNetworkSettingsEnabled = resolveEvmFeatureRuntimePolicy(
  __ENABLED_CHAIN_FEATURE_FLAGS__
).newOperationsEnabled

function LegacyShieldFundsRedirect() {
  const { search } = useLocation()
  return <Navigate replace to={resolveLegacyShieldFundsPath(search)} />
}

// Entry component for adding wallet (sets flowMode and redirects)
function AddWalletEntry() {
  const { replace } = useNavigate()
  const { setFlowMode, setMode, reset } = useOnboardingStore()

  useEffect(() => {
    reset()
    setFlowMode('addWallet')
    setMode('create')
    replace('/onboarding/create-word-count')
  }, [replace, reset, setFlowMode, setMode])

  return null
}

function ImportWalletEntry() {
  const { replace } = useNavigate()
  const { setFlowMode, setMode, reset } = useOnboardingStore()

  useEffect(() => {
    reset()
    setFlowMode('addWallet')
    setMode('import')
    replace('/onboarding/import-word-count')
  }, [replace, reset, setFlowMode, setMode])

  return null
}

function MainnetOnlyEntry() {
  const { replace } = useNavigate()

  useEffect(() => {
    replace('/')
  }, [replace])

  return null
}

function VotingCapabilityEntry({ children }: { children: ReactNode }) {
  const { replace } = useNavigate()
  const { activeAccount, loading } = useActiveAccountNetworks()
  const supportsVoting =
    activeAccount?.walletSource.kind === 'software' &&
    activeAccount.networks.some(network => network.chain.family === 'zcash')

  useEffect(() => {
    if (!loading && !supportsVoting) replace('/')
  }, [loading, replace, supportsVoting])

  if (loading) return <RouteLoadingSkeleton title="Zcash voting" />
  if (!supportsVoting) return null
  return children
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />

      {/* Onboarding Routes */}
      <Route path="/onboarding">
        <Route index element={<Welcome />} />
        <Route path="password" element={<Password />} />
        <Route path="secure-wallet" element={<SecureWallet />} />
        <Route path="create-word-count" element={<CreateWordCount />} />
        <Route path="view-phrase" element={<ViewPhrase />} />
        <Route path="confirm-phrase" element={<ConfirmPhrase />} />
        <Route path="congratulations" element={<Congratulations />} />
        <Route path="import-word-count" element={<ImportWordCount />} />
        <Route path="import" element={<ImportWallet />} />
        <Route path="import-accounts" element={<ImportAccounts />} />
        <Route path="import-password" element={<ImportPassword />} />
      </Route>

      <Route path="/unlock" element={<Unlock />} />
      <Route path="/send" element={<Send multiChainEnabled={multichainSendEnabled} />} />
      <Route path="/transfer" element={<DepositWithdraw />} />
      <Route path="/shield" element={<ShieldFundsPage />} />
      <Route path="/unshield" element={<UnshieldFundsPage />} />
      <Route path="/transaction-result" element={<TransactionOutcome />} />
      <Route path="/asset-detail" element={<AssetDetail />} />
      <Route path="/account-list" element={<AccountList />} />
      <Route path="/account-detail" element={<AccountDetail />} />
      <Route path="/account-networks" element={<ManageAccountNetworks />} />
      <Route path="/add-wallet" element={<AddWalletEntry />} />
      <Route path="/import-wallet" element={<ImportWalletEntry />} />
      <Route path="/import-private-key" element={<ImportPrivateKey />} />
      <Route path="/export-private-key" element={<ExportPrivateKey />} />
      <Route path="/addresses-list" element={<AddressesList />} />
      <Route path="/zcash-settings" element={<ZcashSettings />} />
      <Route
        path="/voting"
        element={
          <VotingCapabilityEntry>
            <VotingRounds />
          </VotingCapabilityEntry>
        }
      />
      <Route
        path="/voting/round"
        element={
          <VotingCapabilityEntry>
            <VotingRound />
          </VotingCapabilityEntry>
        }
      />

      {/* Hardware Wallet Routes (opened in a full browser tab) */}
      <Route path="/hardware/connect" element={<HardwareConnect />} />
      <Route path="/hardware/keystone-connect" element={<KeystoneConnect />} />
      <Route
        path="/hardware/ledger-connect"
        element={
          <Suspense fallback={<RouteLoadingSkeleton title="Connect Ledger" variant="form" />}>
            <LedgerConnect />
          </Suspense>
        }
      />
      <Route
        path="/hardware/ledger-sign"
        element={
          <Suspense fallback={<RouteLoadingSkeleton title="Ledger signing" variant="form" />}>
            <LedgerSign />
          </Suspense>
        }
      />
      <Route path="/hardware/sign" element={<KeystoneSign />} />
      <Route path="/hardware/bitcoin-sign" element={<KeystoneTransferSign family="bitcoin" />} />
      <Route path="/hardware/evm-sign" element={<KeystoneTransferSign family="evm" />} />

      <Route path="/dapp-connections" element={<DAppConnections />} />
      <Route path="/shield-provider" element={<ShieldProviderDetail />} />
      <Route path="/shield-funds" element={<LegacyShieldFundsRedirect />} />
      <Route path="/receive" element={<Receive />} />
      <Route path="/shield-swap" element={<Swap />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="/default-evm-wallet" element={<DefaultEvmWallet />} />
      <Route path="/general" element={<General />} />
      <Route path="/networks" element={<Networks />} />
      <Route
        path="/manage-tokens"
        element={evmNetworkSettingsEnabled ? <ManageTokens /> : <Settings />}
      />
      <Route path="/security-privacy" element={<SecurityPrivacy />} />
      <Route path="/zero-indexer-nodes" element={<ZeroIndexerNodes />} />
      <Route path="/developer-settings" element={<DeveloperSettings />} />
      <Route path="/address-book" element={<AddressBook />} />
      <Route path="/change-password" element={<ChangePassword />} />
      <Route path="/about" element={<About />} />
      <Route path="/help" element={<Help />} />
      <Route path="/terms-of-use" element={<TermsOfUse />} />
      <Route path="/update" element={<Update />} />

      <Route path="/view-seed-phrase" element={<ViewSeedPhrase />} />
      <Route
        path="/swap"
        element={DEFAULT_NETWORK === 'mainnet' ? <Swap /> : <MainnetOnlyEntry />}
      />
      <Route path="/approval" element={<Approval />} />
    </Routes>
  )
}

function AppContent() {
  const { isLoading, initializationFailure, retryInitialization } = useAppRouting()
  const location = useLocation()
  const { navigate } = useNavigate()
  const sidePanelWindowId = useRef<number | null>(null)
  usePersistedExtensionContextSync()
  const { reloadTransactions } = useAccountDataStore()

  useEffect(() => {
    if (!isSidePanelSurface(window.location.search)) return
    let active = true
    void chrome.windows
      .getCurrent()
      .then(currentWindow => {
        if (active) sidePanelWindowId.current = currentWindow.id ?? null
      })
      .catch(() => {})
    return () => {
      active = false
      sidePanelWindowId.current = null
    }
  }, [])

  useEffect(() => {
    void initializeAddressBook().catch(() => {})
  }, [])

  useEffect(() => {
    const handleMessage = (
      message: unknown,
      sender: chrome.runtime.MessageSender,
      sendResponse: (response?: unknown) => void
    ) => {
      if (!message || typeof message !== 'object') return

      const messageType = 'type' in message ? message.type : undefined
      const senderContext = getOwnExtensionSenderContext(sender, chrome.runtime.id)
      if (
        messageType === 'LEDGER_SWAP_APPROVAL_SIGNED' &&
        isSidePanelSurface(window.location.search) &&
        senderContext === 'service-worker' &&
        sidePanelWindowId.current !== null &&
        sidePanelWindowId.current === ('windowId' in message ? message.windowId : undefined)
      ) {
        let transactionId: string
        try {
          transactionId = parseTransactionId(
            'transactionId' in message ? message.transactionId : undefined
          )
        } catch {
          return
        }
        navigate(`/swap?resumeApproval=${encodeURIComponent(transactionId)}`)
        sendResponse(true)
        return
      }
      if (messageType === 'ACCOUNT_CONTEXT_CHANGED' && senderContext === 'service-worker') {
        void rehydrateWalletStore().catch(error => {
          console.error('[Popup] Failed to refresh the active Account context:', error)
        })
        return
      }
      if (senderContext !== 'service-worker') return
      if (
        messageType === 'TRANSACTION_ADDED' ||
        messageType === 'TRANSACTION_UPDATED' ||
        isTransactionStatusUpdatedMessage(message)
      ) {
        const accountKey =
          'accountKey' in message && typeof message.accountKey === 'string'
            ? message.accountKey
            : undefined
        if (!accountKey) return
        reloadTransactions(accountKey).catch(console.error)
      }
    }

    chrome.runtime.onMessage.addListener(handleMessage)

    return () => {
      chrome.runtime.onMessage.removeListener(handleMessage)
    }
  }, [navigate, reloadTransactions])

  useEffect(() => {
    const { currentAccountId, currentWalletId, currentNetwork } = useWalletStore.getState()
    if (currentAccountId && currentWalletId) {
      const accountKey = buildAccountKey(currentNetwork, currentWalletId, currentAccountId)
      reloadTransactions(accountKey).catch(console.error)
    }
  }, [reloadTransactions])

  if (initializationFailure) {
    const isUpgradeFailure = initializationFailure === 'upgrade'

    return (
      <div className="page-container">
        <PageHeader />
        <BlockingWalletFailure
          title={isUpgradeFailure ? 'Wallet upgrade failed' : 'Wallet startup failed'}
          description={
            isUpgradeFailure
              ? 'Noir Wallet could not finish upgrading this wallet. It will stay locked until the upgrade completes.'
              : 'Noir Wallet could not finish starting. The wallet will remain unavailable until startup succeeds.'
          }
          assurance={
            isUpgradeFailure
              ? 'Your existing wallet data is still stored on this device. Noir Wallet will not open a partially upgraded wallet.'
              : 'Wallet data on this device has not been cleared. Retry to start Noir Wallet again.'
          }
          isRetrying={isLoading}
          onRetry={() => void retryInitialization()}
        />
      </div>
    )
  }

  if (isLoading) {
    return <WalletInitializing />
  }

  const content = (
    <div className="flex h-full min-h-full w-full flex-col bg-background">
      <TestnetModeBanner />
      {!location.pathname.startsWith('/onboarding') &&
        location.pathname !== '/unlock' &&
        location.pathname !== '/approval' &&
        location.pathname !== '/add-wallet' &&
        location.pathname !== '/import-wallet' &&
        !location.pathname.startsWith('/hardware/') &&
        !(
          location.pathname === '/view-seed-phrase' &&
          new URLSearchParams(location.search).get('backup') === '1'
        ) && <SecretPhraseBackupBanner />}
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <AppRoutes />
      </div>
    </div>
  )

  return content
}

function App() {
  // Extract initial path from URL hash for dApp windows
  const getInitialPath = () => {
    const hash = window.location.hash.slice(1) // Remove leading '#'

    if (hash) {
      // For paths that don't start with '/', add one
      if (!hash.startsWith('/')) {
        return `/${hash}` // Preserve full hash including query params
      }
      return hash
    }

    // Default for normal popup windows
    return '/onboarding'
  }

  const initialPath = getInitialPath()
  const isEvmWalletChoice = initialPath.split('?')[0] === '/evm-wallet-choice'

  return (
    <RouterProvider initialPath={initialPath}>
      <ModalProvider>
        <DialogProvider>
          {isEvmWalletChoice ? (
            <div className="flex h-full w-full items-center justify-center bg-background">
              <Routes>
                <Route path="/evm-wallet-choice" element={<EvmWalletChoice />} />
              </Routes>
            </div>
          ) : (
            <>
              <AppContent />
              <ToastContainer />
            </>
          )}
        </DialogProvider>
      </ModalProvider>
    </RouterProvider>
  )
}

export default App
