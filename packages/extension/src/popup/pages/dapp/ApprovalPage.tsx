import { useState, useEffect, useRef, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Button } from '../../components/ui/button'
import { WarningBox } from '../../components/ui/WarningBox'
import { useWalletStore } from '@/store/wallet-store'
import { useTransactionResultStore } from '@/store/transaction-result-store'
import { Icon } from '@iconify/react'
import { AddressTypeLabel } from '@/popup/components/account/AddressType'
import { formatAccountName, formatNumber, getAccountDisplayName } from '@/lib/format'
import { StandardTransactionResult } from '../../components/transaction/StandardTransactionResult'
import { FeeTierPicker } from '../../components/transaction/FeeTierPicker'
import { useFeeEstimate } from '../../hooks/useFeeEstimate'
import { useSettingsStore } from '@/store/settings-store'
import { marginalFeeForTier } from '@/config/fee'
import type { AddressType } from '@/types/wallet'
import { formatSortAddress } from '@/lib/format'
import { cn } from '@/lib/utils'
import { classifyError } from '@/lib/errors'
import Big from 'big.js'
import {
  hasEnoughTransparentBalanceToShield,
  MIN_SHIELDING_BALANCE_MESSAGE
} from '@/core/zcash/shielding'

interface BatchAccountOption {
  id: string
  label: string
  addresses: { transparent: string; shielded: string }
}

export function ApprovalPage() {
  const [searchParams] = useSearchParams()
  const { getAccount, accountDisplayNames } = useWalletStore()
  const [binding, setBinding] = useState<{ walletId: string; accountId: string } | null>(null)
  const currentWalletId = binding?.walletId
  const currentAccount = binding ? getAccount(binding.walletId, binding.accountId) : null
  const accountDisplayName =
    currentAccount && currentWalletId
      ? getAccountDisplayName(
          currentWalletId,
          currentAccount.id,
          currentAccount.name,
          accountDisplayNames
        )
      : 'Account 1'
  const { setResult, updateStep, data: resultData, clear } = useTransactionResultStore()

  const requestId = searchParams.get('requestId')

  const [origin, setOrigin] = useState('Unknown Origin')
  const [action, setAction] = useState('unknown')
  const [data, setData] = useState<any>({})
  const [error, setError] = useState('')
  const [decisionError, setDecisionError] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const decisionInFlight = useRef(false)
  const [showResult, setShowResult] = useState(false)
  const [walletReady, setWalletReady] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [editingAccounts, setEditingAccounts] = useState(false)

  const feeTier = useSettingsStore(state => state.feeTier)
  const setFeeTier = useSettingsStore(state => state.setFeeTier)

  const isSend = action === 'sendTransaction'
  const isShield = action === 'shieldFunds'
  const fundingSource: AddressType =
    data.fundingSource === 'transparent' ? 'transparent' : 'shielded'
  const hasEnoughShieldingBalance = !isShield || hasEnoughTransparentBalanceToShield(data.amount)
  const estimate = useCallback(
    async (tier: 'standard' | 'fast') => {
      const response = await chrome.runtime.sendMessage({
        type: 'ESTIMATE_APPROVAL_FEE',
        requestId,
        feeTier: tier
      })
      if (
        response?.error ||
        typeof response?.fee !== 'string' ||
        typeof response?.marginalFeeZats !== 'string' ||
        !response.feeQuote
      ) {
        throw new Error(response?.error || 'Fee estimation failed')
      }
      return {
        feeZats: response.fee,
        marginalFeeZats: response.marginalFeeZats,
        feeQuote: response.feeQuote
      }
    },
    [requestId, binding?.walletId, binding?.accountId]
  )
  const feeEstimate = useFeeEstimate({
    type: isShield ? 'shield' : 'send',
    to: data.to,
    amount: data.amount,
    memo: data.memo,
    fundingSource,
    feeTier,
    estimate,
    enabled: (isSend || isShield) && walletReady && hasEnoughShieldingBalance
  })
  const feeByTier = feeEstimate.feeByTier
  const feeReady =
    !!feeEstimate.feeQuote &&
    feeEstimate.feeQuote.expiresAt > Date.now() &&
    feeEstimate.feeZats != null &&
    !feeEstimate.loading &&
    !feeEstimate.error

  const hasFetched = useRef(false)

  useEffect(() => {
    if (!requestId) {
      setError('Invalid request')
      return
    }

    if (hasFetched.current) {
      return
    }

    hasFetched.current = true

    chrome.runtime.sendMessage({ type: 'GET_PENDING_REQUEST', requestId }, response => {
      if (chrome.runtime.lastError || !response || response.error) {
        setError(response?.error || 'Request not found or expired')
      } else if (response.request) {
        setOrigin(response.request.origin)
        setAction(response.request.action)
        setData(response.request.data || {})
        setBinding({ walletId: response.request.walletId, accountId: response.request.accountId })
        setWalletReady(true)
        if (response.request.data?.preselectedIds) {
          setSelectedIds(response.request.data.preselectedIds)
        }
      }
    })
  }, [requestId])

  useEffect(() => {
    if (binding && !currentAccount) setError('Account is no longer available')
  }, [binding, currentAccount])

  const toggleAccount = (id: string) => {
    setSelectedIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]))
  }

  const handleDecision = async (approved: boolean) => {
    if (decisionInFlight.current) return
    decisionInFlight.current = true
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

    setDecisionError('')
    setIsLoading(true)
    let resultListener: Parameters<typeof chrome.runtime.onMessage.addListener>[0] | null = null
    try {
      const context = await chrome.runtime.sendMessage({ type: 'GET_PENDING_REQUEST', requestId })
      if (context?.error || !context?.request) throw new Error(context?.error || 'Request expired')

      if (action === 'sendTransaction' || action === 'shieldFunds') {
        if (!feeReady || !feeEstimate.feeQuote || feeEstimate.feeZats == null) {
          throw new Error('Network fee estimate is unavailable. Please try again.')
        }
        const approvalFee = await chrome.runtime.sendMessage({
          type: 'ESTIMATE_APPROVAL_FEE',
          requestId,
          marginalFeeZats: marginalFeeForTier(
            feeTier,
            feeEstimate.feeQuote.standardMarginalFeeZats
          ),
          feeQuoteId: feeEstimate.feeQuote.id
        })
        if (
          approvalFee?.error ||
          approvalFee?.feeQuote?.id !== feeEstimate.feeQuote.id ||
          approvalFee?.fee !== String(feeEstimate.feeZats)
        ) {
          feeEstimate.refresh()
          setIsLoading(false)
          decisionInFlight.current = false
          return
        }
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

        const listener: Parameters<typeof chrome.runtime.onMessage.addListener>[0] = msg => {
          if (msg.type === 'DAPP_TX_RESULT' && msg.requestId === requestId) {
            chrome.runtime.onMessage.removeListener(listener)
            if (msg.success) {
              updateStep('submitted', { txHash: msg.txHash })
            } else if (msg.completionPending === true) {
              updateStep('pending', { error: msg.error })
            } else {
              updateStep('failed', { error: msg.error })
            }
          }
        }
        resultListener = listener
        chrome.runtime.onMessage.addListener(listener)
        const approvalResponse = await chrome.runtime.sendMessage({
          type: 'DAPP_APPROVAL_RESULT',
          requestId,
          success: true,
          marginalFeeZats: marginalFeeForTier(
            feeTier,
            feeEstimate.feeQuote.standardMarginalFeeZats
          ),
          feeQuoteId: feeEstimate.feeQuote.id,
          feeTier,
          feeZats: feeEstimate.feeZats
        })
        if (approvalResponse?.success === false || approvalResponse?.error) {
          throw new Error(approvalResponse.error || 'Approval failed')
        }
      } else {
        await chrome.runtime.sendMessage({
          type: 'DAPP_APPROVAL_RESULT',
          requestId,
          success: true,
          ...(action === 'connect' && (data.accounts?.length ?? 0) > 0 ? { selectedIds } : {})
        })
        window.close()
      }
    } catch (err) {
      if (resultListener) chrome.runtime.onMessage.removeListener(resultListener)
      console.error('Failed to send decision:', err)
      setShowResult(false)
      clear()
      setDecisionError(classifyError(err).userMessage)
      setIsLoading(false)
      decisionInFlight.current = false
    }
  }

  if (error) {
    return (
      <div className="page-container h-full flex flex-col">
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-4">
            <Icon icon="lucide:alert-circle" className="w-16 h-16 text-destructive mx-auto" />
            <h2 className="text-xl font-semibold">Request Error</h2>
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button onClick={() => window.close()} variant="outline">
              Close
            </Button>
          </div>
        </div>
      </div>
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

  const renderContent = () => {
    switch (action) {
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
          <div className="space-y-6">
            <div className="flex flex-col items-center justify-center space-y-4 mb-5">
              <div className="relative">
                <div className="w-20 h-20 rounded-2xl bg-card border-2 border-border flex items-center justify-center overflow-hidden shadow-lg">
                  <img
                    src={`https://www.google.com/s2/favicons?domain=${origin}&sz=128`}
                    alt={origin}
                    className="w-12 h-12"
                    onError={e => {
                      e.currentTarget.style.display = 'none'
                      const nextEl = e.currentTarget.nextElementSibling as HTMLElement
                      if (nextEl) nextEl.classList.remove('hidden')
                    }}
                  />
                  <Icon icon="lucide:globe" className="w-12 h-12 text-muted-foreground hidden" />
                </div>
                <div className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-primary flex items-center justify-center border-2 border-background shadow-md">
                  <Icon icon="lucide:wallet" className="w-4 h-4 text-background" />
                </div>
              </div>

              <div className="text-center space-y-1">
                <h2 className="text-xl font-semibold">Connect Request</h2>
                <p
                  className="text-sm font-medium text-foreground truncate max-w-full"
                  title={origin}
                >
                  {origin}
                </p>
                <p className="text-xs text-muted-foreground">wants to connect to your wallet</p>
              </div>
            </div>

            <div className="bg-muted/10 rounded-xl p-4 space-y-3 border border-border/50">
              <div className="flex items-center gap-2 mb-3">
                <Icon icon="lucide:shield-check" className="w-4 h-4 text-primary" />
                <h3 className="text-sm font-medium">Permissions Requested</h3>
              </div>
              <ul className="space-y-2">
                <li className="flex items-center gap-3">
                  <Icon icon="lucide:eye" className="w-3 h-3 text-muted-foreground/80" />
                  <span className="text-sm text-muted-foreground">
                    View your wallet addresses and balances
                  </span>
                </li>
                <li className="flex items-center gap-3">
                  <Icon icon="lucide:pen-tool" className="w-3 h-3 text-muted-foreground/80" />
                  <span className="text-sm text-muted-foreground">
                    Request approval for transactions
                  </span>
                </li>
              </ul>
            </div>

            {multi && selectedAccounts.length > 1 && (
              <WarningBox>
                <div className="flex-1">
                  <span className="font-medium">Privacy notice:</span>
                  <p className="text-xs mt-1">
                    This site will see the addresses and balances of every selected wallet and can
                    link them together.
                  </p>
                </div>
              </WarningBox>
            )}

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
                    <Icon icon="lucide:chevron-left" className="w-3.5 h-3.5" />
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
                              <Icon icon="lucide:check" className="w-3.5 h-3.5 text-background" />
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
                    {selectedAccounts.length > 1 ? `${selectedAccounts.length} wallets` : 'Wallet'}
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
                      No wallets selected. Tap "Edit accounts" to choose.
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
          </div>
        )
      }

      case 'sendTransaction':
        return (
          <div className="space-y-6">
            <div className="text-center space-y-2">
              <div className="w-16 h-16 bg-primary/10 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <Icon icon="lucide:send" className="w-8 h-8 text-primary" />
              </div>
              <h2 className="text-xl font-semibold">Sign Transaction</h2>
              <p className="text-sm font-medium text-foreground truncate max-w-full" title={origin}>
                {origin}
              </p>
              <p className="text-xs text-muted-foreground">wants to send a transaction</p>
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2 mb-2">
                <Icon icon="lucide:coins" className="w-4 h-4 text-muted-foreground/80" />
                <h3 className="text-sm font-medium text-muted-foreground/80">Amount</h3>
              </div>
              <div className="text-3xl font-bold font-mono text-primary">
                {formatNumber(data.amount, { rm: Big.roundDown })}
                <span className="text-base text-muted-foreground font-normal ml-2">ZEC</span>
              </div>
            </div>

            <div className="">
              <div className="flex items-center gap-2 mb-2">
                <Icon icon="lucide:user" className="w-4 h-4 text-muted-foreground/80" />
                <h3 className="text-sm font-medium text-muted-foreground/80">Recipient</h3>
              </div>
              <div className="font-mono text-xs break-all bg-card/20 rounded-xl p-4 border border-border/30">
                {data.to}
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2 mb-2">
                <Icon icon="lucide:wallet-cards" className="w-4 h-4 text-muted-foreground/80" />
                <h3 className="text-sm font-medium text-muted-foreground/80">Funding source</h3>
              </div>
              <div className="flex items-center gap-2 bg-card/20 rounded-xl p-4 border border-border/30">
                <AddressTypeLabel type={fundingSource} size="sm" />
                <span className="font-mono text-xs truncate">
                  {formatSortAddress(currentAccount?.addresses[fundingSource] || '')}
                </span>
              </div>
              {fundingSource === 'transparent' && (
                <WarningBox>
                  Spending transparent funds reveals and may link the selected transparent UTXOs
                  on-chain.
                </WarningBox>
              )}
            </div>

            {data.memo && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 mb-2">
                  <Icon icon="lucide:message-square" className="w-4 h-4 text-muted-foreground/80" />
                  <h3 className="text-sm font-medium text-muted-foreground/80">Memo</h3>
                </div>
                <div className="text-sm bg-card/20 rounded-xl p-4 border border-border/30">
                  {data.memo}
                </div>
              </div>
            )}

            <div className="space-y-2">
              <div className="flex items-center gap-2 mb-2">
                <Icon icon="lucide:zap" className="w-4 h-4 text-muted-foreground/80" />
                <h3 className="text-sm font-medium text-muted-foreground/80">Network Fee</h3>
              </div>
              <div className="bg-card/20 rounded-xl p-4 border border-border/30">
                <FeeTierPicker
                  tier={feeTier}
                  onTierChange={setFeeTier}
                  feeByTier={feeByTier}
                  loadingByTier={feeEstimate.loadingByTier}
                  loading={feeEstimate.loading}
                  hideLabel
                />
                {feeEstimate.error && (
                  <button
                    type="button"
                    className="mt-2 text-xs text-destructive"
                    onClick={feeEstimate.refresh}
                  >
                    Fee estimate unavailable. Retry
                  </button>
                )}
              </div>
            </div>
          </div>
        )

      case 'signMessage':
        return (
          <div className="space-y-6">
            <div className="text-center space-y-2">
              <div className="w-16 h-16 bg-primary/10 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <Icon icon="lucide:pen-line" className="w-8 h-8 text-primary" />
              </div>
              <h2 className="text-xl font-semibold">Sign Message</h2>
              <p className="text-sm font-medium text-foreground truncate max-w-full" title={origin}>
                {origin}
              </p>
              <p className="text-xs text-muted-foreground">wants you to sign a message</p>
            </div>

            <div className="">
              <div className="flex items-center gap-2 mb-2">
                <Icon icon="lucide:file-text" className="w-4 h-4 text-muted-foreground/80" />
                <h3 className="text-sm font-medium text-muted-foreground/80">Message</h3>
              </div>
              <div className="bg-card/20 rounded-xl p-4 border border-border/30 text-sm font-mono wrap-break-word whitespace-pre-wrap max-h-40 overflow-y-auto">
                {data.message}
              </div>
            </div>

            <WarningBox>
              <div className="flex-1">
                <span className="font-medium">Security Warning:</span>
                <p className="text-xs mt-1">
                  Signing a message can have security implications. Only sign messages from trusted
                  sites.
                </p>
              </div>
            </WarningBox>
          </div>
        )

      case 'shieldFunds':
        return (
          <div className="space-y-6">
            <div className="text-center space-y-2">
              <div className="w-16 h-16 bg-primary/10 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <Icon icon="lucide:shield" className="w-8 h-8 text-primary" />
              </div>
              <h2 className="text-xl font-semibold">Shield Funds</h2>
              <p className="text-sm font-medium text-foreground truncate max-w-full" title={origin}>
                {origin}
              </p>
              <p className="text-xs text-muted-foreground">
                wants to shield your transparent funds to the private pool
              </p>
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2 mb-2">
                <Icon icon="lucide:coins" className="w-4 h-4 text-muted-foreground/80" />
                <h3 className="text-sm font-medium text-muted-foreground/80">Amount</h3>
              </div>
              <div className="text-3xl font-bold font-mono text-primary">
                {formatNumber(data.amount, { rm: Big.roundDown })}
                <span className="text-base text-muted-foreground font-normal ml-2">ZEC</span>
              </div>
            </div>

            <div className="">
              <div className="flex items-center gap-2 mb-2">
                <Icon icon="lucide:arrow-right" className="w-4 h-4 text-muted-foreground/80" />
                <h3 className="text-sm font-medium text-muted-foreground/80">Destination</h3>
              </div>
              <div className="text-sm bg-card/20 rounded-xl p-4 border border-border/30">
                Shielded Pool (Private Balance)
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2 mb-2">
                <Icon icon="lucide:zap" className="w-4 h-4 text-muted-foreground/80" />
                <h3 className="text-sm font-medium text-muted-foreground/80">Network Fee</h3>
              </div>
              <div className="bg-card/20 rounded-xl p-4 border border-border/30">
                <FeeTierPicker
                  tier={feeTier}
                  onTierChange={setFeeTier}
                  feeByTier={feeByTier}
                  loadingByTier={feeEstimate.loadingByTier}
                  loading={feeEstimate.loading}
                  hideLabel
                />
                {feeEstimate.error && (
                  <button
                    type="button"
                    className="mt-2 text-xs text-destructive"
                    onClick={feeEstimate.refresh}
                  >
                    Fee estimate unavailable. Retry
                  </button>
                )}
              </div>
            </div>

            <WarningBox>
              <div className="flex-1">
                <p className="text-xs">
                  This will move all transparent balance into the shielded pool for enhanced
                  privacy.
                </p>
              </div>
            </WarningBox>

            {!hasEnoughShieldingBalance && (
              <p className="text-xs text-destructive text-center">
                {MIN_SHIELDING_BALANCE_MESSAGE}
              </p>
            )}
          </div>
        )

      default:
        return (
          <div className="text-center py-10">
            <Icon
              icon="lucide:help-circle"
              className="w-12 h-12 text-muted-foreground mx-auto mb-3"
            />
            <p className="text-muted-foreground">Unknown request type</p>
          </div>
        )
    }
  }

  return (
    <div className="page-container h-full flex flex-col">
      <div className="flex-1 px-5 pt-6 pb-30 overflow-y-auto">{renderContent()}</div>

      <div className="fixed bottom-0 left-0 right-0 p-5 bg-background/95 backdrop-blur-md shadow-lg">
        {decisionError && (
          <p className="mb-2 text-xs text-destructive" role="alert">
            {decisionError}
          </p>
        )}
        <div className="flex gap-3">
          <Button
            variant="outline"
            className="flex-1"
            onClick={() => handleDecision(false)}
            disabled={isLoading}
            size="lg"
          >
            Reject
          </Button>
          <Button
            className="flex-1 bg-primary hover:bg-primary/90"
            onClick={() => handleDecision(true)}
            isLoading={isLoading}
            disabled={
              isLoading ||
              !hasEnoughShieldingBalance ||
              ((isSend || isShield) && !feeReady) ||
              (action === 'connect' && (data.accounts?.length ?? 0) > 0 && selectedIds.length === 0)
            }
            size="lg"
          >
            {action === 'connect' && (data.accounts?.length ?? 0) > 0
              ? `Connect${selectedIds.length ? ` (${selectedIds.length})` : ''}`
              : 'Approve'}
          </Button>
        </div>
      </div>
    </div>
  )
}
