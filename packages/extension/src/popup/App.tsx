import { lazy, Suspense, useEffect, type ReactNode } from 'react'
import { ToastContainer } from './components/common/ToastContainer'
import { TestnetModeBanner } from './components/common/TestnetModeBanner'
import { RouterProvider, Routes, Route, useLocation, useNavigate } from './provider/Router'
import { SecretPhraseBackupBanner } from './components/common/SecretPhraseBackupBanner'
import { ModalProvider } from './provider/ModalManager'
import { DialogProvider } from './hooks/useDialog'
import { RouteLoadingSkeleton } from './components/common/RouteLoadingSkeleton'
import { WalletInitializing } from './components/ui/wallet-initializing'
import { BlockingWalletFailure } from './components/common/BlockingWalletFailure'
import { PageHeader } from './components/common/PageHeader'
import { useAppRouting } from './hooks/useAppRouting'
import { BetaInviteActivationGate } from './hooks/useBetaInviteActivation'
import { BetaInviteProtectedRoute } from './components/onboarding/BetaInviteBinding'
import { canUseRouteBeforeBetaActivation } from './services/beta-invite-route-policy'
import { usePersistedExtensionContextSync } from './hooks/usePersistedExtensionContextSync'
import { useAccountDataStore, buildAccountKey } from '@/store/account-data-store'
import { rehydrateWalletStore, useWalletStore } from '@/store/wallet-store'
import { isTransactionStatusUpdatedMessage } from '@/types/transaction-messages'
import { getOwnExtensionSenderContext } from '@/lib/runtime-message-security'
import { initializeAddressBook } from '@/store/address-book-store'

// Pages
import { Home } from './pages/Home'

// Onboarding Pages
import { WelcomePage } from './pages/onboarding/WelcomePage'
import { PasswordPage } from './pages/onboarding/PasswordPage'
import { SecureWalletPage } from './pages/onboarding/SecureWalletPage'
import { ViewPhrasePage } from './pages/onboarding/ViewPhrasePage'
import { ConfirmPhrasePage } from './pages/onboarding/ConfirmPhrasePage'
import { CongratulationsPage } from './pages/onboarding/CongratulationsPage'
import { ImportWordCountPage } from './pages/onboarding/ImportWordCountPage'
import { CreateWordCountPage } from './pages/onboarding/CreateWordCountPage'
import { ImportWalletPage } from './pages/onboarding/ImportWalletPage'
import { ImportZcashHistoryPage } from './pages/onboarding/ImportZcashHistoryPage'
import { ImportPasswordPage } from './pages/onboarding/ImportPasswordPage'
import { UnlockPage } from './pages/onboarding/UnlockPage'

// Account Pages
import { AccountList } from './pages/account/AccountList'
import { AccountDetail } from './pages/account/AccountDetail'
import { AddressesList } from './pages/account/AddressesList'
import { ZcashSettings } from './pages/account/ZcashSettings'
import { ImportPrivateKey } from './pages/account/ImportPrivateKey'
import { ExportPrivateKey } from './pages/account/ExportPrivateKey'

// Transaction Pages
import { Send } from './pages/transactions/Send'
import { MultichainSend } from './pages/transactions/MultichainSend'
import { TransactionResultPage } from './pages/transactions/TransactionResultPage'
import { AssetDetail } from './pages/portfolio/AssetDetail'

// Swap Page
import { Swap } from './pages/swap/Swap'

// Hardware Wallet Pages (full-tab flows)
import { KeystoneConnectPage } from './pages/hardware/KeystoneConnectPage'
import { HardwareConnectPage } from './pages/hardware/HardwareConnectPage'
import { KeystoneSignPage } from './pages/hardware/KeystoneSignPage'
import { KeystoneBitcoinSignPage } from './pages/hardware/KeystoneBitcoinSignPage'
import { KeystoneEvmSignPage } from './pages/hardware/KeystoneEvmSignPage'

// DApp Pages
import { ApprovalPage } from './pages/dapp/ApprovalPage'
import { EvmWalletChoice } from './pages/dapp/EvmWalletChoice'

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
import { UpdatePage } from './pages/Update'

import { useOnboardingStore } from '@/store/onboarding-store'
import {
  resolveBitcoinFeatureRuntimePolicy,
  resolveEvmFeatureRuntimePolicy,
  resolveNearFeatureRuntimePolicy,
  resolveSolanaFeatureRuntimePolicy
} from '@/core/chains/feature-runtime-policy'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'

const LedgerConnectPage = lazy(() =>
  import('./pages/hardware/LedgerConnectPage').then(module => ({
    default: module.LedgerConnectPage
  }))
)
const LedgerSignPage = lazy(() =>
  import('./pages/hardware/LedgerSignPage').then(module => ({ default: module.LedgerSignPage }))
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

function ZcashCapabilityEntry({
  children,
  fallbackPath
}: {
  children: ReactNode
  fallbackPath: string
}) {
  const { replace } = useNavigate()
  const { activeAccount, loading } = useActiveAccountNetworks()
  const legacyAccountAvailable = useWalletStore(state => Boolean(state.getCurrentAccount()))
  const supportsZcash =
    activeAccount?.networks.some(network => network.chain.family === 'zcash') ??
    legacyAccountAvailable

  useEffect(() => {
    if (!loading && !supportsZcash) replace(fallbackPath)
  }, [fallbackPath, loading, replace, supportsZcash])

  if (loading) return <RouteLoadingSkeleton title="Send" variant="form" />
  if (!supportsZcash) return null
  return children
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
        <Route index element={<WelcomePage />} />
        <Route path="password" element={<PasswordPage />} />
        <Route path="secure-wallet" element={<SecureWalletPage />} />
        <Route path="create-word-count" element={<CreateWordCountPage />} />
        <Route path="view-phrase" element={<ViewPhrasePage />} />
        <Route path="confirm-phrase" element={<ConfirmPhrasePage />} />
        <Route path="congratulations" element={<CongratulationsPage />} />
        <Route path="import-word-count" element={<ImportWordCountPage />} />
        <Route path="import" element={<ImportWalletPage />} />
        <Route path="import-zcash-history" element={<ImportZcashHistoryPage />} />
        <Route path="import-password" element={<ImportPasswordPage />} />
      </Route>

      <Route path="/unlock" element={<UnlockPage />} />
      <Route path="/send" element={multichainSendEnabled ? <MultichainSend /> : <Send />} />
      {multichainSendEnabled && (
        <Route
          path="/send/cross-chain"
          element={
            DEFAULT_NETWORK === 'mainnet' ? (
              <Swap purpose="cross-chain-send" />
            ) : (
              <MainnetOnlyEntry />
            )
          }
        />
      )}
      {multichainSendEnabled && (
        <Route
          path="/send/zcash"
          element={
            <ZcashCapabilityEntry fallbackPath="/send">
              <Send />
            </ZcashCapabilityEntry>
          }
        />
      )}
      <Route path="/transaction-result" element={<TransactionResultPage />} />
      <Route path="/asset-detail" element={<AssetDetail />} />
      <Route path="/account-list" element={<AccountList />} />
      <Route path="/account-detail" element={<AccountDetail />} />
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
      <Route path="/hardware/connect" element={<HardwareConnectPage />} />
      <Route path="/hardware/keystone-connect" element={<KeystoneConnectPage />} />
      <Route
        path="/hardware/ledger-connect"
        element={
          <Suspense fallback={<RouteLoadingSkeleton title="Connect Ledger" variant="form" />}>
            <LedgerConnectPage />
          </Suspense>
        }
      />
      <Route
        path="/hardware/ledger-sign"
        element={
          <Suspense fallback={<RouteLoadingSkeleton title="Ledger signing" variant="form" />}>
            <LedgerSignPage />
          </Suspense>
        }
      />
      <Route path="/hardware/sign" element={<KeystoneSignPage />} />
      <Route path="/hardware/bitcoin-sign" element={<KeystoneBitcoinSignPage />} />
      <Route path="/hardware/evm-sign" element={<KeystoneEvmSignPage />} />

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
      <Route path="/update" element={<UpdatePage />} />

      <Route path="/view-seed-phrase" element={<ViewSeedPhrase />} />
      <Route
        path="/swap"
        element={DEFAULT_NETWORK === 'mainnet' ? <Swap /> : <MainnetOnlyEntry />}
      />
      <Route path="/approval" element={<ApprovalPage />} />
    </Routes>
  )
}

function AppContent() {
  const { isLoading, initializationFailure, retryInitialization } = useAppRouting()
  const location = useLocation()
  usePersistedExtensionContextSync()
  const { reloadTransactions } = useAccountDataStore()

  useEffect(() => {
    void initializeAddressBook().catch(() => {})
  }, [])

  useEffect(() => {
    const handleMessage = (message: unknown, sender: chrome.runtime.MessageSender) => {
      if (!message || typeof message !== 'object') return

      const messageType = 'type' in message ? message.type : undefined
      const senderContext = getOwnExtensionSenderContext(sender, chrome.runtime.id)
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
  }, [reloadTransactions])

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
      <div className="min-h-0 flex-1">
        <AppRoutes />
      </div>
    </div>
  )

  return canUseRouteBeforeBetaActivation(location.pathname) ? (
    content
  ) : (
    <BetaInviteProtectedRoute>{content}</BetaInviteProtectedRoute>
  )
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
    <ModalProvider>
      <RouterProvider initialPath={initialPath}>
        <DialogProvider>
          {isEvmWalletChoice ? (
            <div className="h-full w-full bg-background">
              <Routes>
                <Route path="/evm-wallet-choice" element={<EvmWalletChoice />} />
              </Routes>
            </div>
          ) : (
            <>
              <BetaInviteActivationGate>
                <AppContent />
              </BetaInviteActivationGate>
              <ToastContainer />
            </>
          )}
        </DialogProvider>
      </RouterProvider>
    </ModalProvider>
  )
}

export default App
