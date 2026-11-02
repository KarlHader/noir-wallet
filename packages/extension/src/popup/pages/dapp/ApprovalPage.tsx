import { InlineError } from '@/popup/components/common/InlineError'
import { useState, useEffect, useRef, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Button } from '../../components/ui/button'
import { WarningBox } from '../../components/ui/WarningBox'
import { useWalletStore } from '@/store/wallet-store'
import { useTransactionResultStore } from '@/store/transaction-result-store'
import { zcashWalletRuntimeClient } from '@/popup/services/zcash-wallet-runtime-client'
import { Icon } from '@iconify/react'
import { AddressTypeLabel } from '@/popup/components/account/AddressType'
import { formatAccountName, getAccountDisplayName, formatSortAddress } from '@/lib/format'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { StandardTransactionResult } from '../../components/transaction/StandardTransactionResult'
import { FeeTierPicker } from '../../components/transaction/FeeTierPicker'
import { useFeeEstimate } from '../../hooks/useFeeEstimate'
import { useSettingsStore } from '@/store/settings-store'
import { deriveFeeByTier, marginalFeeForTier } from '@/core/zcash/fee-policy'
import type { AddressType } from '@/types/wallet'

import { cn } from '@/lib/utils'
import { classifyError, getResponseErrorMessage } from '@/lib/errors'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import {
  hasEnoughTransparentBalanceToShield,
  MIN_SHIELDING_BALANCE_MESSAGE
} from '@/core/zcash/shielding'
import { getOwnExtensionSenderContext } from '@/lib/runtime-message-security'
import { ApprovalWindowLayout } from '@/popup/components/dapp/ApprovalWindowLayout'
import { EvmAddNetworkDetails } from '@/popup/components/dapp/EvmAddNetworkDetails'
import {
  ApprovalDetailCard,
  DAppConnectionHeader,
  DAppNetworkCard,
  DAppRequestHeader
} from '@/popup/components/dapp/ApprovalRequestPresentation'
import { SigningSummaryReview } from '@/popup/components/signing/SigningSummaryReview'
import { Skeleton } from '@/popup/components/ui/skeleton'
import {
  canRetryPendingApprovalLoad,
  parsePendingApprovalResponse
} from '@/popup/services/dapp-approval-request'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import { EvmGasFundingApproval } from '@/popup/components/dapp/EvmGasFundingApproval'
import { NetworkFeeTierPicker } from '@/popup/components/transaction/NetworkFeeTierPicker'
import { parseNetworkFeeTier, type NetworkFeeTier } from '@/core/transactions/domain'
import { parseEvmFeeSelection, type EvmFeeSelection } from '@/infrastructure/chains/evm'
import { NETWORKS } from '@/config/networks'
import { getBundledEvmAssetDefinitions } from '@/core/chains/registry/product-chain-definitions'
import { ChainIcon } from '@/popup/components/common/ChainIcon'
import { CopyToast, useCopyToClipboard } from '@/popup/components/common/CopyToast'
import { useNavigate } from '@/popup/provider/Router'
import {
  formatDAppHost,
  parseBitcoinSigningSummary,
  parseEvmAddNetworkApproval,
  parseEvmMessageSummary,
  parseEvmPrivateTransferApproval,
  parseEvmTransactionSummary,
  parseNativeSigningSummary,
  resolveDAppFaviconPageUrl
} from '@/popup/services/dapp-approval-summary'

interface BatchAccountOption {
  id: string
  label: string
  addresses: { transparent: string; shielded: string }
}

interface ChainAccountOption {
  id: string
  label: string
  address: string
  required?: boolean
}

interface MultichainScopeOption {
  chainId: string
  chainName: string
  iconChain: string
  methods: string[]
  notifications: string[]
  accounts: ChainAccountOption[]
  preselectedIds: string[]
}

const MULTI_ACCOUNT_CONNECT_ACTIONS = new Set([
  'connect',
  'evmConnect',
  'bitcoinConnect',
  'solanaConnect',
  'nearConnect'
])

function ApprovalCheckIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5" fill="none">
      <path
        d="m3.5 8.25 2.75 2.75 6.25-6.25"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ApprovalBackIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5" fill="none">
      <path
        d="m9.5 3.5-4.5 4.5 4.5 4.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ConnectionPermissionSummary({ includesActivity = false }: { includesActivity?: boolean }) {
  return (
    <section aria-label="Permissions" className="space-y-2 px-1 text-xs leading-5 text-muted">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 text-primary">
          <ApprovalCheckIcon />
        </span>
        <span>
          View selected addresses and balances{includesActivity ? ' and public activity' : ''}.
        </span>
      </div>
      <div className="flex items-start gap-2">
        <Icon icon="lucide:shield-check" className="mt-0.5 size-3.5 shrink-0 text-primary" />
        <span>Transactions and signatures still require your approval.</span>
      </div>
    </section>
  )
}

export function ApprovalPage() {
  const { navigate } = useNavigate()
  const [searchParams] = useSearchParams()
  const {
    getCurrentAccount,
    getAccount,
    currentWalletId: activeWalletId,
    currentNetwork,
    accountDisplayNames
  } = useWalletStore()
  const [approvalBinding, setApprovalBinding] = useState<{
    walletId: string
    accountId: string
  } | null>(null)
  const currentWalletId = approvalBinding?.walletId ?? activeWalletId
  const {
    activeAccount: storageV2Account,
    loading: accountNetworksLoading,
    refresh: refreshAccountNetworks
  } = useActiveAccountNetworks()
  const currentAccount = approvalBinding
    ? getAccount(approvalBinding.walletId, approvalBinding.accountId)
    : getCurrentAccount()
  const accountDisplayName =
    (approvalBinding ? undefined : storageV2Account?.accountDisplayName) ??
    (currentAccount && currentWalletId
      ? getAccountDisplayName(
          currentWalletId,
          currentAccount.id,
          currentAccount.name,
          accountDisplayNames
        )
      : 'Account 1')
  const { setResult, updateStep, data: resultData, clear } = useTransactionResultStore()

  const requestId = searchParams.get('requestId')
  const fundingComplete = searchParams.get('fundingComplete') === '1'

  const [origin, setOrigin] = useState('')
  const [action, setAction] = useState('unknown')
  const [data, setData] = useState<any>({})
  const [error, setError] = useState(requestId ? '' : 'Invalid request')
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [canRetryLoad, setCanRetryLoad] = useState(false)
  const [requestLoaded, setRequestLoaded] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [showResult, setShowResult] = useState(false)
  const [walletReady, setWalletReady] = useState(false)
  const resultListenerRef = useRef<
    Parameters<typeof chrome.runtime.onMessage.addListener>[0] | null
  >(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [selectedScopes, setSelectedScopes] = useState<Record<string, string[]>>({})
  const [expandedScopeId, setExpandedScopeId] = useState<string | null>(null)
  const [editingAccounts, setEditingAccounts] = useState(false)
  const { copyToClipboard, showToast: showCopyToast } = useCopyToClipboard()
  const dappDomain = formatDAppHost(origin)
  const dappPageUrl = resolveDAppFaviconPageUrl(data, origin)

  useEffect(
    () => () => {
      if (resultListenerRef.current)
        chrome.runtime.onMessage.removeListener(resultListenerRef.current)
    },
    []
  )

  const feeTier = useSettingsStore(state => state.feeTier)
  const setFeeTier = useSettingsStore(state => state.setFeeTier)

  const isSend = action === 'sendTransaction'
  const isShield = action === 'shieldFunds'
  const isEvmConnect = action === 'evmConnect'
  const isEvmNetwork = action === 'evmNetwork'
  const evmAddNetwork =
    isEvmNetwork && data.action === 'add' ? parseEvmAddNetworkApproval(data) : null
  const isEvmTransaction = action === 'evmTransaction'
  const isEvmPrivateTransfer = action === 'evmPrivateTransfer'
  const isEvmGasFunding = action === 'evmGasFunding'
  const isEvmMessage = action === 'evmMessage'
  const isBitcoinConnect = action === 'bitcoinConnect'
  const isBitcoinTransaction = action === 'bitcoinTransaction'
  const isBitcoinMessage = action === 'bitcoinMessage'
  const isSolanaConnect = action === 'solanaConnect'
  const isSolanaTransaction = action === 'solanaTransaction'
  const isSolanaMessage = action === 'solanaMessage'
  const isNearConnect = action === 'nearConnect'
  const isNearTransaction = action === 'nearTransaction'
  const isNearMessage = action === 'nearMessage'
  const isMultichainConnect = action === 'multichainConnect'
  const requiresZcashAccountReady =
    action === 'connect' ||
    action === 'sendTransaction' ||
    action === 'signMessage' ||
    action === 'shieldFunds'
  const evmTransactionSummary = isEvmTransaction
    ? parseEvmTransactionSummary(data.review?.summary)
    : null
  const evmPrivateTransfer = isEvmPrivateTransfer ? parseEvmPrivateTransferApproval(data) : null
  const evmMessageSummary = isEvmMessage ? parseEvmMessageSummary(data.review?.summary) : null
  const evmExecutionMode =
    data.executionMode === 'private' || data.executionMode === 'main'
      ? data.executionMode
      : undefined
  const bitcoinSigningSummary = isBitcoinTransaction
    ? parseBitcoinSigningSummary(data.review?.summary, 'transaction')
    : isBitcoinMessage
      ? parseBitcoinSigningSummary(data.review?.summary, 'message')
      : null
  const nativeSigningSummary =
    isSolanaTransaction || isSolanaMessage
      ? parseNativeSigningSummary(
          data.review?.summary,
          'solana',
          isSolanaMessage ? 'message' : 'transaction'
        )
      : isNearTransaction || isNearMessage
        ? parseNativeSigningSummary(
            data.review?.summary,
            'near',
            isNearMessage ? 'message' : 'transaction'
          )
        : null
  const fundingSource: AddressType =
    data.fundingSource === 'transparent' ? 'transparent' : 'shielded'
  const hasEnoughShieldingBalance = !isShield || hasEnoughTransparentBalanceToShield(data.amount)
  const estimateApprovalFee = useCallback(async (): Promise<string> => {
    if (!requestId) throw new Error('Approval request is unavailable')
    const response = await chrome.runtime.sendMessage({ type: 'ESTIMATE_APPROVAL_FEE', requestId })
    if (response?.error || typeof response?.fee !== 'string') {
      throw new Error(getResponseErrorMessage(response) || 'Fee estimation failed')
    }
    return response.fee
  }, [requestId])
  const feeEstimate = useFeeEstimate({
    type: isShield ? 'shield' : 'send',
    to: data.to,
    amount: data.amount,
    memo: data.memo,
    fundingSource,
    estimate: isSend || isShield ? estimateApprovalFee : undefined,
    enabled: (isSend || isShield) && walletReady && hasEnoughShieldingBalance
  })
  const feeByTier = deriveFeeByTier(feeEstimate.feeZats, feeEstimate.error)

  const handleNetworkFeeTierChange = async (nextTier: NetworkFeeTier) => {
    if (!requestId) throw new Error('Approval request is unavailable')
    setIsLoading(true)
    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'DAPP_NETWORK_FEE_TIER_CHANGE',
        requestId,
        feeTier: nextTier
      })) as unknown
      if (typeof response !== 'object' || response === null || Array.isArray(response)) {
        throw new Error('The network fee could not be updated')
      }
      const responseError = Reflect.get(response, 'error')
      if (typeof responseError === 'string') throw new Error(responseError)
      const updatedData = Reflect.get(response, 'data')
      if (typeof updatedData !== 'object' || updatedData === null || Array.isArray(updatedData)) {
        throw new Error('The wallet returned an invalid fee review')
      }
      setData(updatedData)
    } finally {
      setIsLoading(false)
    }
  }

  const handleEvmFeeSelectionChange = async (feeSelection: EvmFeeSelection) => {
    if (!requestId) throw new Error('Approval request is unavailable')
    setIsLoading(true)
    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'DAPP_EVM_FEE_SELECTION_CHANGE',
        requestId,
        feeSelection
      })) as unknown
      if (typeof response !== 'object' || response === null || Array.isArray(response)) {
        throw new Error('The network fee could not be updated')
      }
      const responseError = Reflect.get(response, 'error')
      if (typeof responseError === 'string') throw new Error(responseError)
      const updatedData = Reflect.get(response, 'data')
      if (typeof updatedData !== 'object' || updatedData === null || Array.isArray(updatedData)) {
        throw new Error('The wallet returned an invalid fee review')
      }
      setData(updatedData)
    } finally {
      setIsLoading(false)
    }
  }

  const dappNetworkFeeTier = parseNetworkFeeTier(data.feeTier ?? 'standard')
  const dappEvmFeeSelection = (() => {
    try {
      return parseEvmFeeSelection(data.feeSelection ?? { kind: 'tier', tier: dappNetworkFeeTier })
    } catch {
      return { kind: 'tier' as const, tier: 'standard' as const }
    }
  })()

  const fetchedRequestId = useRef<string | null>(null)

  useEffect(() => {
    if (!requestId) return

    if (fetchedRequestId.current === requestId) return

    fetchedRequestId.current = requestId
    setRequestLoaded(false)
    setError('')
    setCanRetryLoad(false)
    let cancelled = false

    chrome.runtime.sendMessage({ type: 'GET_PENDING_REQUEST', requestId }, (response: unknown) => {
      if (cancelled) return
      const runtimeError = chrome.runtime.lastError
      if (runtimeError) {
        setCanRetryLoad(true)
        setError('Unable to load this approval request.')
        return
      }

      const parsed = parsePendingApprovalResponse(response, requestId)
      if (parsed.status === 'error') {
        setCanRetryLoad(canRetryPendingApprovalLoad(parsed.error))
        setError(parsed.error)
        return
      }

      const requestData = parsed.request.data
      const preselectedIds = Array.isArray(requestData.preselectedIds)
        ? requestData.preselectedIds.filter((id): id is string => typeof id === 'string')
        : []
      setOrigin(parsed.request.origin)
      setAction(parsed.request.action)
      setData(requestData)
      if (
        ['connect', 'sendTransaction', 'signMessage', 'shieldFunds'].includes(
          parsed.request.action
        ) &&
        parsed.request.walletId &&
        parsed.request.accountId
      ) {
        setApprovalBinding({
          walletId: parsed.request.walletId,
          accountId: parsed.request.accountId
        })
        setWalletReady(true)
      }
      setSelectedIds(preselectedIds)
      const scopeSelections: Record<string, string[]> = Object.create(null)
      if (Array.isArray(requestData.scopes)) {
        for (const scope of requestData.scopes) {
          if (
            typeof scope === 'object' &&
            scope !== null &&
            typeof Reflect.get(scope, 'chainId') === 'string' &&
            Array.isArray(Reflect.get(scope, 'preselectedIds'))
          ) {
            scopeSelections[Reflect.get(scope, 'chainId')] = Reflect.get(
              scope,
              'preselectedIds'
            ).filter((id: unknown): id is string => typeof id === 'string')
          }
        }
      }
      setSelectedScopes(scopeSelections)
      setRequestLoaded(true)
    })

    return () => {
      cancelled = true
      if (fetchedRequestId.current === requestId) fetchedRequestId.current = null
    }
  }, [requestId, loadAttempt])

  useEffect(() => {
    if ((!isSend && !isShield) || walletReady || approvalBinding) return
    let cancelled = false
    zcashWalletRuntimeClient
      .waitForAccountReady(20000)
      .then(() => !cancelled && setWalletReady(true))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [isSend, isShield, walletReady, approvalBinding])

  const toggleAccount = (id: string) => {
    const option = Array.isArray(data.accounts)
      ? data.accounts.find((item: unknown) =>
          typeof item === 'object' && item !== null ? Reflect.get(item, 'id') === id : false
        )
      : undefined
    if (option && Reflect.get(option, 'required') === true) return
    setSelectedIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]))
  }

  const toggleScopeAccount = (scope: MultichainScopeOption, account: ChainAccountOption) => {
    if (account.required) return
    setSelectedScopes(previous => {
      const selected = previous[scope.chainId] ?? []
      return {
        ...previous,
        [scope.chainId]: selected.includes(account.id)
          ? selected.filter(id => id !== account.id)
          : [...selected, account.id]
      }
    })
  }

  const handleDecision = async (approved: boolean) => {
    setCanRetryLoad(false)
    if (approved && !requestLoaded) return

    if (!approved) {
      setIsLoading(true)
      try {
        await chrome.runtime.sendMessage({
          type: 'DAPP_APPROVAL_RESULT',
          requestId,
          success: false
        })
      } catch (err) {
        console.error('Failed to send rejection:', err)
      }
      window.close()
      return
    }

    setIsLoading(true)
    try {
      if (requiresZcashAccountReady) {
        const response = await chrome.runtime.sendMessage({
          type: 'GET_PENDING_REQUEST',
          requestId
        })
        if (response?.error || !response?.request) {
          throw new Error(getResponseErrorMessage(response) || 'Request not found or expired')
        }
      }

      if (action === 'sendTransaction' || action === 'shieldFunds') {
        setResult(
          {
            type: 'zcash',
            step: 'pending',
            amount: data.amount || '0',
            toAddress: action === 'shieldFunds' ? 'Shielded Pool' : data.to,
            showTo: action === 'sendTransaction'
          },
          '/'
        )
        setShowResult(true)

        const resultListener = (msg: any, sender: chrome.runtime.MessageSender) => {
          if (getOwnExtensionSenderContext(sender, chrome.runtime.id) !== 'service-worker') return
          if (msg.type === 'DAPP_TX_RESULT' && msg.requestId === requestId) {
            chrome.runtime.onMessage.removeListener(resultListener)
            if (resultListenerRef.current === resultListener) resultListenerRef.current = null
            if (msg.success) {
              updateStep('submitted', { txHash: msg.txHash })
            } else if (msg.completionPending === true) {
              updateStep('pending', { error: msg.error })
            } else {
              updateStep('failed', { error: msg.error })
            }
          }
        }
        resultListenerRef.current = resultListener
        chrome.runtime.onMessage.addListener(resultListener)
        const response = await chrome.runtime.sendMessage({
          type: 'DAPP_APPROVAL_RESULT',
          requestId,
          success: true,
          marginalFeeZats: marginalFeeForTier(feeTier),
          feeZats: feeByTier[feeTier] ?? undefined
        })
        if (response?.success !== true)
          throw new Error(
            getResponseErrorMessage(response) || 'The approval could not be completed'
          )
      } else {
        const response = (await chrome.runtime.sendMessage({
          type: 'DAPP_APPROVAL_RESULT',
          requestId,
          success: true,
          ...(MULTI_ACCOUNT_CONNECT_ACTIONS.has(action) && (data.accounts?.length ?? 0) > 0
            ? { selectedIds }
            : {}),
          ...(isMultichainConnect ? { selectedScopes } : {})
        })) as { success?: boolean; error?: string } | undefined
        if (response?.success !== true) {
          throw new Error(
            getResponseErrorMessage(response) || 'The approval could not be completed'
          )
        }
        window.close()
      }
    } catch (err) {
      if (resultListenerRef.current) {
        chrome.runtime.onMessage.removeListener(resultListenerRef.current)
        resultListenerRef.current = null
      }
      console.error('Failed to send decision:', err)
      setError(classifyError(err).userMessage)
      setIsLoading(false)
    }
  }

  if (error) {
    return (
      <div className="page-container h-full flex flex-col">
        <div className="flex-1 flex items-center justify-center">
          <div className="w-full px-5 text-center space-y-4">
            <Icon icon="lucide:alert-circle" className="w-16 h-16 text-destructive mx-auto" />
            <h2 className="text-xl font-semibold">Request Error</h2>
            <InlineError
              message={error}
              onRetry={canRetryLoad ? () => setLoadAttempt(value => value + 1) : undefined}
            />
            <div className="flex justify-center gap-3">
              <Button onClick={() => window.close()} variant="outline">
                Close
              </Button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (!requestLoaded) {
    return (
      <ApprovalWindowLayout
        footer={
          <Button
            variant="outline"
            className="w-full"
            onClick={() => handleDecision(false)}
            isLoading={isLoading}
            disabled={isLoading}
            size="lg"
          >
            Reject
          </Button>
        }
      >
        <div role="status" aria-label="Loading approval request" className="space-y-8 pt-6">
          <div className="flex flex-col items-center gap-4">
            <Skeleton className="size-16 rounded-2xl" />
            <div className="flex w-full flex-col items-center gap-2">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-3 w-52 bg-white/[0.05]" />
            </div>
          </div>
          <div className="space-y-3 rounded-xl border border-border/50 bg-card/50 p-4">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-3 w-full bg-white/[0.05]" />
            <Skeleton className="h-3 w-4/5 bg-white/[0.05]" />
          </div>
          <div className="space-y-3 rounded-xl border border-border/50 bg-muted/10 p-4">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-full bg-white/[0.05]" />
            <Skeleton className="h-3 w-3/4 bg-white/[0.05]" />
          </div>
        </div>
      </ApprovalWindowLayout>
    )
  }

  if (showResult && resultData && resultData.type === 'zcash') {
    return (
      <div className="page-container">
        <StandardTransactionResult
          step={resultData.step}
          amount={resultData.amount}
          toAddress={resultData.toAddress}
          txHash={resultData.txHash}
          error={resultData.error}
          showTo={resultData.showTo}
          onDone={() => {
            clear()
            window.close()
          }}
          onCancel={() => {
            clear()
            window.close()
          }}
        />
      </div>
    )
  }

  if (isEvmGasFunding) {
    return (
      <EvmGasFundingApproval
        data={data}
        requestId={requestId}
        walletId={storageV2Account?.walletId ?? currentWalletId}
        accountId={storageV2Account?.accountId ?? currentAccount?.id ?? null}
        accountLoading={accountNetworksLoading}
        onRefreshAccount={() => void refreshAccountNetworks()}
        domain={dappDomain}
        pageUrl={dappPageUrl}
        fundingComplete={fundingComplete}
        isLoading={isLoading}
        onDecision={approved => void handleDecision(approved)}
        onFund={navigate}
      />
    )
  }

  const renderInvalidSigningRequest = (message: string, messageRequest: boolean) => (
    <div className="space-y-5">
      <DAppRequestHeader
        domain={dappDomain}
        pageUrl={dappPageUrl}
        action={messageRequest ? 'Sign message' : 'Review transaction'}
        tone="blocked"
      />
      <div className="space-y-3 rounded-xl border border-danger/40 bg-danger/10 p-4 text-center">
        <Icon icon="lucide:shield-alert" className="mx-auto size-10 text-danger" />
        <h2 className="text-sm font-semibold">Unable to review signing request</h2>
        <p className="text-xs leading-5 text-foreground/70">{message}</p>
      </div>
    </div>
  )

  const renderContent = () => {
    switch (action) {
      case 'multichainConnect': {
        const scopes: MultichainScopeOption[] = Array.isArray(data.scopes)
          ? data.scopes.filter(
              (scope: unknown): scope is MultichainScopeOption =>
                typeof scope === 'object' &&
                scope !== null &&
                typeof Reflect.get(scope, 'chainId') === 'string' &&
                typeof Reflect.get(scope, 'chainName') === 'string' &&
                typeof Reflect.get(scope, 'iconChain') === 'string' &&
                Array.isArray(Reflect.get(scope, 'methods')) &&
                Array.isArray(Reflect.get(scope, 'notifications')) &&
                Array.isArray(Reflect.get(scope, 'accounts')) &&
                Array.isArray(Reflect.get(scope, 'preselectedIds'))
            )
          : []
        const selectedAccountCount = scopes.reduce(
          (total, scope) => total + (selectedScopes[scope.chainId]?.length ?? 0),
          0
        )
        return (
          <div className="space-y-5">
            <DAppConnectionHeader domain={dappDomain} pageUrl={dappPageUrl} />

            <section
              aria-label="Accounts and networks"
              className="overflow-hidden rounded-2xl border border-border bg-card/35"
            >
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <div>
                  <h2 className="text-sm font-medium">Accounts and networks</h2>
                  <p className="mt-0.5 text-[11px] text-muted">
                    {scopes.length} networks · {selectedAccountCount} selected
                  </p>
                </div>
                <div className="flex -space-x-2" aria-hidden="true">
                  {scopes.slice(0, 5).map(scope => (
                    <ChainIcon
                      key={scope.chainId}
                      chain={scope.iconChain}
                      width={24}
                      height={24}
                      showTooltip={false}
                      className="size-6 rounded-full border-2 border-card"
                    />
                  ))}
                </div>
              </div>
              {scopes.map(scope => {
                const selected = selectedScopes[scope.chainId] ?? []
                const selectedAccounts = scope.accounts.filter(account =>
                  selected.includes(account.id)
                )
                const expanded = expandedScopeId === scope.chainId
                const accountSummary =
                  selectedAccounts.length === 1
                    ? formatSortAddress(selectedAccounts[0].address)
                    : `${selectedAccounts.length} accounts`
                return (
                  <div
                    key={scope.chainId}
                    data-caip25-scope={scope.chainId}
                    className="border-b border-border last:border-b-0"
                  >
                    <button
                      type="button"
                      aria-expanded={expanded}
                      onClick={() => setExpandedScopeId(expanded ? null : scope.chainId)}
                      className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.025]"
                    >
                      <ChainIcon
                        chain={scope.iconChain}
                        width={32}
                        height={32}
                        showTooltip={false}
                        className="size-8 shrink-0 rounded-full"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {scope.chainName}
                        </span>
                        <span className="block truncate font-mono text-[11px] text-muted">
                          {accountSummary}
                        </span>
                      </span>
                      <span
                        className={cn(
                          'flex size-5 shrink-0 items-center justify-center rounded-full',
                          selectedAccounts.length > 0
                            ? 'bg-primary text-background'
                            : 'border border-muted text-transparent'
                        )}
                      >
                        <ApprovalCheckIcon />
                      </span>
                      <Icon
                        icon="lucide:chevron-down"
                        className={cn(
                          'size-4 shrink-0 text-muted transition-transform',
                          expanded && 'rotate-180'
                        )}
                      />
                    </button>
                    {expanded && (
                      <div className="space-y-1.5 bg-background/20 px-4 pb-3 pt-1">
                        {scope.accounts.map(account => {
                          const checked = selected.includes(account.id)
                          return (
                            <button
                              key={account.id}
                              type="button"
                              disabled={account.required}
                              aria-pressed={checked}
                              data-caip25-account={account.id}
                              onClick={() => toggleScopeAccount(scope, account)}
                              className={cn(
                                'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors',
                                checked ? 'bg-primary/8' : 'hover:bg-white/[0.025]',
                                account.required && 'cursor-default'
                              )}
                            >
                              <span
                                className={cn(
                                  'flex size-5 shrink-0 items-center justify-center rounded-md border',
                                  checked
                                    ? 'border-primary bg-primary text-background'
                                    : 'border-muted text-transparent'
                                )}
                              >
                                <ApprovalCheckIcon />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-xs font-medium">
                                  {account.label}
                                </span>
                                <span className="block truncate font-mono text-[10px] text-muted">
                                  {formatSortAddress(account.address)}
                                </span>
                              </span>
                              {account.required && (
                                <span className="text-[10px] text-muted">Current</span>
                              )}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </section>

            <ConnectionPermissionSummary />
          </div>
        )
      }

      case 'bitcoinConnect':
      case 'solanaConnect':
      case 'nearConnect':
      case 'evmConnect': {
        const address = typeof data.address === 'string' ? data.address : 'Unavailable'
        const accounts: ChainAccountOption[] = Array.isArray(data.accounts)
          ? data.accounts.filter(
              (item: unknown): item is ChainAccountOption =>
                typeof item === 'object' &&
                item !== null &&
                typeof Reflect.get(item, 'id') === 'string' &&
                typeof Reflect.get(item, 'label') === 'string' &&
                typeof Reflect.get(item, 'address') === 'string'
            )
          : []
        const selectedAccounts = accounts.filter(item => selectedIds.includes(item.id))
        const requiredIds = accounts.filter(item => item.required).map(item => item.id)
        const allSelected = accounts.length > 0 && selectedIds.length === accounts.length
        const canEdit = accounts.length > 1
        return (
          <div className="space-y-4">
            <DAppConnectionHeader domain={dappDomain} pageUrl={dappPageUrl} />
            {accounts.length === 0 && (
              <div className="rounded-xl border border-border bg-card/35 p-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{accountDisplayName}</div>
                  <div className="truncate font-mono text-[11px] text-muted">
                    {formatSortAddress(address)}
                  </div>
                </div>
              </div>
            )}
            {accounts.length > 0 &&
              (editingAccounts ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <button
                      type="button"
                      className="flex items-center gap-1 text-xs font-medium text-primary"
                      onClick={() => setEditingAccounts(false)}
                    >
                      <ApprovalBackIcon />
                      Done
                    </button>
                    <button
                      type="button"
                      className="text-xs font-medium text-primary"
                      onClick={() =>
                        setSelectedIds(allSelected ? requiredIds : accounts.map(item => item.id))
                      }
                    >
                      {allSelected ? 'Deselect optional' : 'Select all'}
                    </button>
                  </div>
                  <div className="space-y-2">
                    {accounts.map(item => {
                      const checked = selectedIds.includes(item.id)
                      return (
                        <button
                          key={item.id}
                          type="button"
                          disabled={item.required}
                          data-dapp-account-option="true"
                          data-dapp-account-required={item.required ? 'true' : 'false'}
                          onClick={() => toggleAccount(item.id)}
                          className={cn(
                            'w-full rounded-xl border p-3 text-left transition-colors',
                            checked ? 'border-primary bg-primary/5' : 'border-border/50 bg-card/40',
                            item.required && 'cursor-default'
                          )}
                        >
                          <div className="flex items-start gap-3">
                            <div
                              className={cn(
                                'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border',
                                checked ? 'border-primary bg-primary' : 'border-muted-foreground/40'
                              )}
                            >
                              {checked && (
                                <span className="text-background">
                                  <ApprovalCheckIcon />
                                </span>
                              )}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center justify-between gap-2">
                                <span className="truncate text-sm font-medium">{item.label}</span>
                                {item.required && (
                                  <span className="shrink-0 text-[10px] text-muted-foreground">
                                    Current
                                  </span>
                                )}
                              </div>
                              <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                                {item.address}
                              </div>
                            </div>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">
                      {selectedAccounts.length} selected{' '}
                      {selectedAccounts.length === 1 ? 'account' : 'accounts'}
                    </span>
                    {canEdit && (
                      <button
                        type="button"
                        className="flex items-center gap-1 text-xs font-medium text-primary"
                        onClick={() => setEditingAccounts(true)}
                      >
                        <Icon icon="lucide:pencil" className="size-3.5" />
                        Edit accounts
                      </button>
                    )}
                  </div>
                  <div className="space-y-2">
                    {selectedAccounts.map(item => (
                      <div
                        key={item.id}
                        className="w-full overflow-hidden rounded-xl border border-primary bg-primary/5 p-3"
                      >
                        <div className="truncate text-sm font-medium">{item.label}</div>
                        <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                          {item.address}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            {!editingAccounts && <ConnectionPermissionSummary />}
          </div>
        )
      }

      case 'evmNetwork':
        if (data.action === 'add' && evmAddNetwork === null) {
          return renderInvalidSigningRequest('The network details are invalid.', false)
        }
        return (
          <div className="space-y-5">
            <DAppRequestHeader
              domain={dappDomain}
              pageUrl={dappPageUrl}
              action={data.action === 'add' ? 'Add network' : 'Switch network'}
            />
            {evmAddNetwork ? (
              <EvmAddNetworkDetails network={evmAddNetwork} />
            ) : (
              <DAppNetworkCard
                chain={typeof data.iconChain === 'string' ? data.iconChain : 'custom-evm'}
                network={data.chainName}
                chainId={data.chainId}
              />
            )}
          </div>
        )

      case 'evmTransaction':
      case 'evmMessage': {
        return renderInvalidSigningRequest(
          'The request did not include a valid, immutable signing summary.',
          action === 'evmMessage'
        )
      }

      case 'bitcoinTransaction':
      case 'bitcoinMessage':
        return renderInvalidSigningRequest(
          'The request did not include a valid, immutable Bitcoin signing summary.',
          action === 'bitcoinMessage'
        )

      case 'connect': {
        const accounts: BatchAccountOption[] = data.accounts || []
        const multi = accounts.length > 0
        const allSelected = accounts.length > 0 && selectedIds.length === accounts.length
        const selectedAccounts = accounts.filter(a => selectedIds.includes(a.id))
        const canEdit = accounts.length > 1
        const renderAddresses = (addrs: { transparent: string; shielded: string }) => (
          <div className="mt-1.5 space-y-1">
            {(['shielded', 'transparent'] as AddressType[]).map(type => (
              <div key={type} className="flex items-center gap-2">
                <AddressTypeLabel type={type} size="sm" />
                <span className="text-[11px] text-muted-foreground font-mono truncate flex-1">
                  {formatSortAddress(addrs[type])}
                </span>
              </div>
            ))}
          </div>
        )
        return (
          <div className="space-y-4">
            <DAppConnectionHeader domain={dappDomain} pageUrl={dappPageUrl} />

            {!multi ? (
              <div className="bg-card/50 rounded-xl p-4 border border-border/50 space-y-3 backdrop-blur-sm">
                <div className="flex items-center gap-3 pb-3 border-b border-border/50">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center ring-2 ring-primary/20">
                    <span className="font-semibold text-primary text-sm">
                      {accountDisplayName[0]?.toUpperCase() || 'A'}
                    </span>
                  </div>
                  <div className="flex-1 overflow-hidden">
                    <div className="font-medium text-sm">
                      {formatAccountName(accountDisplayName, 16)}
                    </div>
                    <div className="text-xs text-muted-foreground">Connected Account</div>
                  </div>
                </div>
                <div className="space-y-2">
                  {currentAccount &&
                    (['shielded', 'transparent'] as AddressType[]).map(type => (
                      <div key={type} className="flex items-center gap-2">
                        <AddressTypeLabel type={type} size="sm" />
                        <div className="text-xs text-muted-foreground font-mono truncate flex-1">
                          {formatSortAddress(currentAccount.addresses[type])}
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            ) : editingAccounts ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    className="text-xs text-primary font-medium flex items-center gap-1"
                    onClick={() => setEditingAccounts(false)}
                  >
                    <ApprovalBackIcon />
                    Done
                  </button>
                  <button
                    type="button"
                    className="text-xs text-primary font-medium"
                    onClick={() => setSelectedIds(allSelected ? [] : accounts.map(a => a.id))}
                  >
                    {allSelected ? 'Deselect all' : 'Select all'}
                  </button>
                </div>
                <div className="space-y-2">
                  {accounts.map(acc => {
                    const checked = selectedIds.includes(acc.id)
                    return (
                      <button
                        key={acc.id}
                        type="button"
                        data-dapp-account-option="true"
                        data-dapp-account-required="false"
                        onClick={() => toggleAccount(acc.id)}
                        className={cn(
                          'w-full text-left rounded-xl p-3 border transition-colors',
                          checked ? 'border-primary bg-primary/5' : 'border-border/50 bg-card/40'
                        )}
                      >
                        <div className="flex items-center gap-3">
                          <div
                            className={cn(
                              'w-5 h-5 rounded-md border flex items-center justify-center shrink-0',
                              checked ? 'bg-primary border-primary' : 'border-muted-foreground/40'
                            )}
                          >
                            {checked && (
                              <span className="text-background">
                                <ApprovalCheckIcon />
                              </span>
                            )}
                          </div>
                          <div className="flex-1 overflow-hidden">
                            <div className="font-medium text-sm truncate">{acc.label}</div>
                            {renderAddresses(acc.addresses)}
                          </div>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    {selectedAccounts.length} selected{' '}
                    {selectedAccounts.length === 1 ? 'account' : 'accounts'}
                  </span>
                  {canEdit && (
                    <button
                      type="button"
                      className="text-xs text-primary font-medium flex items-center gap-1"
                      onClick={() => setEditingAccounts(true)}
                    >
                      <Icon icon="lucide:pencil" className="w-3.5 h-3.5" />
                      Edit accounts
                    </button>
                  )}
                </div>
                <div className="space-y-2">
                  {selectedAccounts.length === 0 ? (
                    <div className="rounded-xl p-4 border border-border/50 bg-card/40 text-xs text-muted-foreground text-center">
                      No accounts selected. Tap "Edit accounts" to choose.
                    </div>
                  ) : (
                    selectedAccounts.map(acc => (
                      <div
                        key={acc.id}
                        className="w-full rounded-xl p-3 border border-primary bg-primary/5 overflow-hidden"
                      >
                        <div className="font-medium text-sm truncate">{acc.label}</div>
                        {renderAddresses(acc.addresses)}
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            {!editingAccounts && multi && selectedAccounts.length > 1 && (
              <WarningBox>
                <div className="flex-1">
                  <span className="font-medium">Privacy notice:</span>
                  <p className="mt-1 text-xs">
                    This site will see the addresses and balances of every selected account and can
                    link them together.
                  </p>
                </div>
              </WarningBox>
            )}

            {!editingAccounts && <ConnectionPermissionSummary includesActivity />}
          </div>
        )
      }

      case 'sendTransaction':
        return (
          <div className="space-y-5">
            <DAppRequestHeader
              domain={dappDomain}
              pageUrl={dappPageUrl}
              action="Review transaction"
            />
            <ApprovalDetailCard title="Transaction">
              <div className="space-y-3">
                <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3">
                  <span className="text-xs text-muted">Amount</span>
                  <span className="text-right font-mono text-xs text-foreground/90">
                    <AmountDisplay value={data.amount} symbol="ZEC" />
                  </span>
                </div>
                <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3">
                  <span className="text-xs text-muted">Recipient</span>
                  <span className="break-all text-right font-mono text-xs text-foreground/90">
                    {data.to}
                  </span>
                </div>
                <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3">
                  <span className="text-xs text-muted">Funding source</span>
                  <span className="flex items-center justify-end gap-2 text-xs text-foreground/90">
                    <AddressTypeLabel type={fundingSource} size="sm" />
                    {fundingSource === 'transparent' ? 'Transparent' : 'Shielded'}
                  </span>
                </div>
              </div>
            </ApprovalDetailCard>
            {data.memo && (
              <ApprovalDetailCard title="Memo">
                <p className="whitespace-pre-wrap break-words font-mono text-xs leading-5 text-foreground/90">
                  {data.memo}
                </p>
              </ApprovalDetailCard>
            )}
            {fundingSource === 'transparent' && (
              <WarningBox>
                Spending transparent funds reveals and may link the selected transparent UTXOs
                on-chain.
              </WarningBox>
            )}
            <DAppNetworkCard
              chain="Zcash"
              network={NETWORKS[currentNetwork].name}
              fee={
                <FeeTierPicker
                  tier={feeTier}
                  onTierChange={setFeeTier}
                  feeByTier={feeByTier}
                  loading={feeEstimate.loading}
                  hideLabel
                />
              }
            />
          </div>
        )

      case 'signMessage':
        return (
          <div className="space-y-5">
            <DAppRequestHeader domain={dappDomain} pageUrl={dappPageUrl} action="Sign message" />
            <CopyToast show={showCopyToast} message="Message copied" />
            <ApprovalDetailCard ariaLabel="Message">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm text-foreground/80">Message</h2>
                <button
                  type="button"
                  aria-label="Copy message"
                  title="Copy message"
                  className="flex size-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-foreground/10 hover:text-foreground"
                  onClick={() => void copyToClipboard(data.message)}
                >
                  <Icon icon="lucide:copy" className="size-4" />
                </button>
              </div>
              <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono text-sm leading-6 text-foreground">
                {data.message}
              </p>
            </ApprovalDetailCard>
            <DAppNetworkCard chain="Zcash" network={NETWORKS[currentNetwork].name} />
          </div>
        )

      case 'shieldFunds':
        return (
          <div className="space-y-5">
            <DAppRequestHeader
              domain={dappDomain}
              pageUrl={dappPageUrl}
              action="Review transaction"
            />
            <ApprovalDetailCard title="Transaction">
              <div className="space-y-3">
                <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3">
                  <span className="text-xs text-muted">Amount</span>
                  <span className="text-right font-mono text-xs text-foreground/90">
                    <AmountDisplay value={data.amount} symbol="ZEC" />
                  </span>
                </div>
                <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3">
                  <span className="text-xs text-muted">Destination</span>
                  <span className="text-right text-xs text-foreground/90">Shielded pool</span>
                </div>
              </div>
            </ApprovalDetailCard>
            <DAppNetworkCard
              chain="Zcash"
              network={NETWORKS[currentNetwork].name}
              fee={
                <FeeTierPicker
                  tier={feeTier}
                  onTierChange={setFeeTier}
                  feeByTier={feeByTier}
                  loading={feeEstimate.loading}
                  hideLabel
                />
              }
            />

            {!hasEnoughShieldingBalance && (
              <p className="text-xs text-destructive text-center">
                {MIN_SHIELDING_BALANCE_MESSAGE}
              </p>
            )}
          </div>
        )

      case 'solanaTransaction':
      case 'solanaMessage':
      case 'nearTransaction':
      case 'nearMessage':
        return renderInvalidSigningRequest(
          'The request did not include a valid, immutable signing summary.',
          action === 'solanaMessage' || action === 'nearMessage'
        )

      default:
        return (
          <div className="space-y-5">
            <DAppRequestHeader
              domain={dappDomain}
              pageUrl={dappPageUrl}
              action="Review request"
              tone="blocked"
            />
            <div className="rounded-xl border border-danger/40 bg-danger/10 p-4 text-center">
              <Icon icon="lucide:help-circle" className="mx-auto mb-3 size-10 text-danger" />
              <p className="text-sm text-foreground/80">Unknown request type</p>
            </div>
          </div>
        )
    }
  }

  if (isEvmMessage && evmMessageSummary) {
    return (
      <SigningSummaryReview
        summary={evmMessageSummary}
        chainName="EVM"
        iconChain={typeof data.iconChain === 'string' ? data.iconChain : 'evm'}
        networkName={typeof data.chainName === 'string' ? data.chainName : 'Unknown network'}
        accountName={accountDisplayName}
        accountAddress={evmMessageSummary.fields.signer}
        source={{ kind: 'dapp', domain: dappDomain, pageUrl: dappPageUrl }}
        accountMode={evmExecutionMode}
        isSubmitting={isLoading}
        onReject={() => void handleDecision(false)}
        onConfirm={() => void handleDecision(true)}
      />
    )
  }

  if (isEvmTransaction && evmTransactionSummary) {
    const nativeDecimals =
      Number.isSafeInteger(data.nativeCurrency?.decimals) &&
      data.nativeCurrency.decimals >= 0 &&
      data.nativeCurrency.decimals <= 255
        ? data.nativeCurrency.decimals
        : 18
    const nativeSymbol =
      typeof data.nativeCurrency?.symbol === 'string' ? data.nativeCurrency.symbol : 'Native'
    const feeAmount = formatBaseUnitDecimalAmount(
      evmTransactionSummary.fields.maximumFeeWei,
      nativeDecimals
    )
    return (
      <SigningSummaryReview
        summary={evmTransactionSummary}
        chainName="EVM"
        iconChain={typeof data.iconChain === 'string' ? data.iconChain : 'evm'}
        networkName={typeof data.chainName === 'string' ? data.chainName : 'Unknown network'}
        accountName={accountDisplayName}
        accountAddress={evmTransactionSummary.fields.from}
        source={{ kind: 'dapp', domain: dappDomain, pageUrl: dappPageUrl }}
        accountMode={evmExecutionMode}
        isSubmitting={isLoading}
        evmPresentation={{
          nativeCurrency: { symbol: nativeSymbol, decimals: nativeDecimals },
          directContract: data.privacyRoute === 'direct-contract',
          tokenMetadata: getBundledEvmAssetDefinitions(currentNetwork)
            .filter(
              asset =>
                asset.chainId === evmTransactionSummary.chainId &&
                asset.namespace === 'erc20' &&
                asset.verification === 'trusted'
            )
            .map(asset => ({
              contractAddress: asset.reference,
              symbol: asset.metadata.symbol,
              decimals: asset.metadata.decimals
            }))
        }}
        feeControl={
          data.feeEditingAvailable ? (
            <NetworkFeeTierPicker
              chainFamily="evm"
              tier={dappEvmFeeSelection.kind === 'tier' ? dappEvmFeeSelection.tier : 'standard'}
              selection={dappEvmFeeSelection}
              amount={feeAmount}
              symbol={nativeSymbol}
              onTierChange={handleNetworkFeeTierChange}
              onSelectionChange={handleEvmFeeSelectionChange}
              disabled={isLoading}
            />
          ) : undefined
        }
        onReject={() => void handleDecision(false)}
        onConfirm={() => void handleDecision(true)}
      />
    )
  }

  if (isEvmPrivateTransfer) {
    const valid = evmPrivateTransfer !== null && evmPrivateTransfer.expiresAt > Date.now()
    const formatAsset = (raw: string) =>
      evmPrivateTransfer ? formatBaseUnitDecimalAmount(raw, evmPrivateTransfer.asset.decimals) : '—'
    return (
      <ApprovalWindowLayout
        footer={
          <div className="flex gap-3">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => void handleDecision(false)}
              disabled={isLoading}
              size="lg"
            >
              Reject
            </Button>
            <Button
              className="flex-1 bg-primary hover:bg-primary/90"
              onClick={() => void handleDecision(true)}
              isLoading={isLoading}
              disabled={!valid || isLoading}
              size="lg"
            >
              Send privately
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <DAppRequestHeader
            domain={dappDomain}
            pageUrl={dappPageUrl}
            action="Confidential transfer"
          />
          {evmPrivateTransfer ? (
            <>
              <DAppNetworkCard
                chain={evmPrivateTransfer.iconChain}
                network={evmPrivateTransfer.chainName}
                chainId={String(evmPrivateTransfer.chainId)}
              />
              <ApprovalDetailCard title="Transfer">
                <div className="space-y-3 text-sm">
                  <div className="flex justify-between gap-3">
                    <span className="text-muted">Amount</span>
                    <span className="font-mono font-medium">
                      <AmountDisplay
                        value={formatAsset(evmPrivateTransfer.amountRaw)}
                        symbol={evmPrivateTransfer.asset.symbol}
                      />
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-muted">From</span>
                    <span className="font-mono" title={evmPrivateTransfer.sourceAddress}>
                      {formatSortAddress(evmPrivateTransfer.sourceAddress)}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-muted">To</span>
                    <span className="font-mono" title={evmPrivateTransfer.recipient}>
                      {formatSortAddress(evmPrivateTransfer.recipient)}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-muted">Route</span>
                    <span>Confidential → Intents → Recipient</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-muted">Minimum received</span>
                    <span className="font-mono">
                      <AmountDisplay
                        value={formatAsset(evmPrivateTransfer.minimumOutputRaw)}
                        symbol={evmPrivateTransfer.asset.symbol}
                      />
                    </span>
                  </div>
                </div>
              </ApprovalDetailCard>
              {evmPrivateTransfer.approvalRequired && (
                <WarningBox>This request includes an exact Token spending approval.</WarningBox>
              )}
            </>
          ) : (
            <WarningBox>The Confidential transfer request is invalid or expired.</WarningBox>
          )}
        </div>
      </ApprovalWindowLayout>
    )
  }

  if (bitcoinSigningSummary) {
    const address =
      bitcoinSigningSummary.schema === 'bitcoin.psbt.v1'
        ? bitcoinSigningSummary.fields.signer
        : bitcoinSigningSummary.fields.address
    return (
      <SigningSummaryReview
        summary={bitcoinSigningSummary}
        chainName="Bitcoin"
        networkName={typeof data.chainName === 'string' ? data.chainName : 'Unknown network'}
        accountName={accountDisplayName}
        accountAddress={address}
        source={{ kind: 'dapp', domain: dappDomain, pageUrl: dappPageUrl }}
        isSubmitting={isLoading}
        feeControl={
          isBitcoinTransaction &&
          bitcoinSigningSummary.schema === 'bitcoin.psbt.v1' &&
          data.feeEditingAvailable ? (
            <NetworkFeeTierPicker
              chainFamily="bitcoin"
              tier={dappNetworkFeeTier}
              amount={formatBaseUnitDecimalAmount(bitcoinSigningSummary.fields.feeSats, 8)}
              symbol="BTC"
              onTierChange={handleNetworkFeeTierChange}
              disabled={isLoading}
            />
          ) : undefined
        }
        onReject={() => void handleDecision(false)}
        onConfirm={() => void handleDecision(true)}
      />
    )
  }

  if (nativeSigningSummary) {
    const solana = nativeSigningSummary.schema.startsWith('solana.')
    const address =
      nativeSigningSummary.schema === 'solana.transaction.v1'
        ? nativeSigningSummary.fields.feePayer
        : nativeSigningSummary.schema === 'solana.message.v1'
          ? nativeSigningSummary.fields.signer
          : nativeSigningSummary.fields.signerId
    return (
      <SigningSummaryReview
        summary={nativeSigningSummary}
        chainName={solana ? 'Solana' : 'NEAR'}
        networkName={typeof data.chainName === 'string' ? data.chainName : 'Unknown network'}
        accountName={accountDisplayName}
        accountAddress={address}
        source={{ kind: 'dapp', domain: dappDomain, pageUrl: dappPageUrl }}
        isSubmitting={isLoading}
        onReject={() => void handleDecision(false)}
        onConfirm={() => void handleDecision(true)}
      />
    )
  }

  return (
    <ApprovalWindowLayout
      footer={
        <div className="flex gap-3">
          <Button
            variant="outline"
            className="flex-1"
            onClick={() => handleDecision(false)}
            disabled={isLoading}
            size="lg"
          >
            {isMultichainConnect || MULTI_ACCOUNT_CONNECT_ACTIONS.has(action) ? 'Cancel' : 'Reject'}
          </Button>
          <Button
            className="flex-1 bg-primary hover:bg-primary/90"
            onClick={() => handleDecision(true)}
            isLoading={isLoading}
            disabled={
              isLoading ||
              !hasEnoughShieldingBalance ||
              (isEvmTransaction && evmTransactionSummary === null) ||
              (isEvmNetwork && data.action === 'add' && evmAddNetwork === null) ||
              (isEvmMessage && evmMessageSummary === null) ||
              ((isBitcoinTransaction || isBitcoinMessage) && bitcoinSigningSummary === null) ||
              ((isSolanaTransaction || isSolanaMessage || isNearTransaction || isNearMessage) &&
                nativeSigningSummary === null) ||
              (MULTI_ACCOUNT_CONNECT_ACTIONS.has(action) &&
                (data.accounts?.length ?? 0) > 0 &&
                selectedIds.length === 0) ||
              (isMultichainConnect &&
                (!Array.isArray(data.scopes) ||
                  data.scopes.length === 0 ||
                  data.scopes.some(
                    (scope: MultichainScopeOption) =>
                      (selectedScopes[scope.chainId]?.length ?? 0) === 0
                  )))
            }
            size="lg"
          >
            {isMultichainConnect
              ? 'Connect'
              : MULTI_ACCOUNT_CONNECT_ACTIONS.has(action)
                ? 'Connect'
                : action === 'connect'
                  ? 'Connect'
                  : isEvmConnect
                    ? 'Connect'
                    : isEvmNetwork
                      ? data.action === 'add'
                        ? 'Add Network'
                        : 'Switch Network'
                      : isBitcoinConnect
                        ? 'Connect'
                        : isSolanaConnect || isNearConnect
                          ? 'Connect'
                          : isEvmTransaction
                            ? 'Confirm'
                            : isEvmMessage
                              ? 'Sign message'
                              : isSolanaMessage || isNearMessage
                                ? 'Sign message'
                                : action === 'signMessage'
                                  ? 'Sign message'
                                  : action === 'sendTransaction' || action === 'shieldFunds'
                                    ? 'Confirm'
                                    : 'Approve'}
          </Button>
        </div>
      }
    >
      {renderContent()}
    </ApprovalWindowLayout>
  )
}
