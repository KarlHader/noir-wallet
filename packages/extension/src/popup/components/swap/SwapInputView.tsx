import { useState, useRef } from 'react'
import { Icon } from '@iconify/react'
import type { AddressType, FundingSource } from '@/types'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { AddressTypeSwitch } from '../../components/account/AddressType'
import { TokenIdentity } from '../../components/tokens/TokenIdentity'
import { FeeTierPicker } from '../../components/transaction/FeeTierPicker'
import { isZecToken, type SwapToken } from '@/core/services/intents-api'
import type { FeeTier } from '@/config/fee'
import {
  formatChainName,
  formatNumber,
  formatPrice,
  formatSortAddress,
  formatSymbol
} from '@/lib/format'
import Big from 'big.js'
import { safeBig } from '@/lib/big'
import { BalanceHelp } from '../transaction/BalanceHelp'

function AddressInputWithRecent({
  label,
  value,
  placeholder,
  recentAddresses,
  onChange
}: {
  label: string
  value: string
  placeholder: string
  recentAddresses: string[]
  onChange: (value: string) => void
}) {
  const [showRecent, setShowRecent] = useState(false)
  const blurTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const handleFocus = () => {
    clearTimeout(blurTimer.current)
    if (!value && recentAddresses.length > 0) setShowRecent(true)
  }

  const handleBlur = () => {
    blurTimer.current = setTimeout(() => setShowRecent(false), 150)
  }

  const handleSelect = (addr: string) => {
    onChange(addr)
    setShowRecent(false)
  }

  return (
    <div className="mb-2">
      <span className="text-sm text-muted mb-2 block">{label}</span>
      <div className="relative">
        <Input
          value={value}
          onChange={e => {
            onChange(e.target.value)
            setShowRecent(false)
          }}
          onFocus={handleFocus}
          onBlur={handleBlur}
          placeholder={placeholder}
          className="h-[54px] bg-card border-none rounded-xl"
        />
        {showRecent && recentAddresses.length > 0 && (
          <div className="absolute left-0 right-0 top-full mt-1 bg-card border border-border rounded-xl shadow-lg z-20 overflow-hidden">
            <p className="text-[11px] text-muted px-3 pt-2 pb-1">Recent</p>
            {recentAddresses.map(addr => (
              <button
                key={addr}
                onMouseDown={e => e.preventDefault()}
                onClick={() => handleSelect(addr)}
                className="w-full text-left px-3 py-2.5 text-sm hover:bg-white/5 transition-colors truncate"
                title={addr}
              >
                {formatSortAddress(addr)}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

interface SwapInputViewProps {
  tokenIn: SwapToken | null
  tokenOut: SwapToken | null
  isZecToOther: boolean
  amountIn: string
  estimatedOut: string
  fromFiat: string
  toFiat: string
  rate: string
  addressType: AddressType
  fundingSource: FundingSource
  availableBalance: string
  spendableBalance: string
  pendingBalance: string
  recipientAddress: string
  refundAddress: string
  slippage: number
  isQuoting: boolean
  areTokensLoading: boolean
  canGetQuote: boolean
  hasInsufficientFunds?: boolean
  amountError?: string
  recentRefundAddresses?: string[]
  recentRecipientAddresses?: string[]
  /** ZIP-317 fee tier props (only meaningful when isZecToOther). */
  feeTier?: FeeTier
  onFeeTierChange?: (tier: FeeTier) => void
  /** Estimated fee per tier in zats; null while pending. */
  feeByTier?: Record<FeeTier, number | null>
  feeLoading?: boolean
  feeLoadingByTier?: Record<FeeTier, boolean>
  onAmountInChange: (value: string) => void
  onMaxClick?: () => void
  onRecipientAddressChange: (value: string) => void
  onRefundAddressChange: (value: string) => void
  onSelectToken: (type: 'in' | 'out') => void
  onSelectZecAddress: () => void
  onSelectFundingSource: () => void
  onSwitchTokens: () => void
  onOpenSlippageSetting: () => void
  onGetQuote: () => void
}

interface SwapCurrencyInputProps {
  label: string
  token: SwapToken | null
  amount: string
  fiatValue: string
  onTokenSelect: () => void
  onAmountChange?: (value: string) => void
  isReadOnly?: boolean
  labelAccessory?: React.ReactNode
  extraHeader?: React.ReactNode
  extraFooter?: React.ReactNode
  showBalance?: boolean
  isLoading?: boolean
  isLoadingTokens?: boolean
}

function SwapCurrencyInput({
  label,
  token,
  amount,
  fiatValue,
  onTokenSelect,
  onAmountChange,
  isReadOnly = false,
  labelAccessory,
  extraHeader,
  extraFooter,
  isLoading = false
}: SwapCurrencyInputProps) {
  void isLoading

  const tokenSelector = isZecToken(token) ? (
    token && <TokenIdentity token={token} className="shrink-0" />
  ) : (
    <button
      onClick={onTokenSelect}
      className="cursor-pointer flex items-center gap-2 shrink-0 hover:opacity-80 transition-opacity"
    >
      {token ? <TokenIdentity token={token} /> : <span className="text-muted">Select</span>}
      <Icon icon="lucide:chevron-down" width={16} height={16} className="text-muted" />
    </button>
  )

  return (
    <div className="mb-2">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-sm text-muted">{label}</span>
          {labelAccessory}
        </div>
        {extraHeader}
      </div>

      <div className="relative">
        {isReadOnly ? (
          <div className="flex items-center justify-between gap-4">
            {tokenSelector}
            <div className="text-right min-w-0">
              <p className="text-2xl font-semibold truncate">
                {formatNumber(amount || '0', { useUnit: true })}
              </p>
            </div>
          </div>
        ) : (
          <div className="flex gap-3">
            <div className="flex-1 rounded-xl flex items-center  h-[56px]">{tokenSelector}</div>
            <Input
              type="text"
              value={amount}
              onChange={e => onAmountChange?.(e.target.value.replace(/[^0-9.]/g, ''))}
              placeholder="0"
              className="flex-1 h-[56px] bg-card border-none rounded-xl text-right text-2xl font-semibold px-4 shadow-none"
            />
          </div>
        )}
      </div>

      <div
        className={`mt-1 flex items-center gap-2 ${extraFooter ? 'justify-between' : 'justify-end'}`}
      >
        {extraFooter}
        <span className="text-sm text-muted">{formatPrice(fiatValue, { showSign: true })}</span>
      </div>
    </div>
  )
}

export function SwapInputView({
  tokenIn,
  tokenOut,
  isZecToOther,
  amountIn,
  estimatedOut,
  fromFiat,
  toFiat,
  rate,
  addressType,
  fundingSource,
  availableBalance,
  spendableBalance,
  pendingBalance,
  recipientAddress,
  refundAddress,
  slippage,
  isQuoting,
  areTokensLoading,
  canGetQuote,
  hasInsufficientFunds,
  amountError,
  recentRefundAddresses = [],
  recentRecipientAddresses = [],
  feeTier,
  onFeeTierChange,
  feeByTier,
  feeLoading,
  feeLoadingByTier,
  onAmountInChange,
  onMaxClick,
  onRecipientAddressChange,
  onRefundAddressChange,
  onSelectToken,
  onSelectZecAddress,
  onSelectFundingSource,
  onSwitchTokens,
  onOpenSlippageSetting,
  onGetQuote
}: SwapInputViewProps) {
  void areTokensLoading

  const showFeeTier = isZecToOther && feeTier && onFeeTierChange && feeByTier

  return (
    <>
      <div className="flex-1 px-5 py-2 overflow-y-auto">
        <SwapCurrencyInput
          label="From"
          token={tokenIn}
          amount={amountIn}
          fiatValue={fromFiat}
          onTokenSelect={() => onSelectToken('in')}
          onAmountChange={onAmountInChange}
          labelAccessory={
            isZecToOther ? (
              <AddressTypeSwitch
                type={fundingSource}
                onClick={onSelectFundingSource}
                ariaLabel="Select funding source"
              />
            ) : undefined
          }
          extraHeader={
            isZecToOther ? (
              <div className="min-w-0 text-right">
                <div className="flex min-w-0 items-center justify-end gap-1">
                  <button
                    type="button"
                    onClick={() => (onMaxClick ? onMaxClick() : onAmountInChange(spendableBalance))}
                    disabled={safeBig(spendableBalance).lte(0)}
                    className="min-w-0 truncate text-xs font-medium text-muted transition-colors hover:text-primary disabled:opacity-50"
                  >
                    Available {formatNumber(availableBalance, { rm: Big.roundDown })} ZEC
                  </button>
                  <BalanceHelp kind="available" />
                </div>
                {safeBig(pendingBalance ?? '0').gt(0) && (
                  <span className="mt-0.5 flex min-w-0 items-center justify-end gap-1 text-[11px] text-muted">
                    <span className="truncate">
                      {formatNumber(pendingBalance, { rm: Big.roundDown })} ZEC pending
                    </span>
                    <BalanceHelp kind="pending" />
                  </span>
                )}
              </div>
            ) : undefined
          }
        />
        {hasInsufficientFunds && (
          <p className="text-warning text-xs mt-2 px-1" role="alert">
            {amountError || 'Amount exceeds available balance.'}
          </p>
        )}
        {!isZecToOther && tokenIn && !isZecToken(tokenIn) && (
          <AddressInputWithRecent
            label="Refund Address"
            value={refundAddress}
            placeholder={`${formatChainName(tokenIn.blockchain)} address...`}
            recentAddresses={recentRefundAddresses}
            onChange={onRefundAddressChange}
          />
        )}

        {/* Switch tokens button */}
        <div className="flex items-center justify-center my-1">
          <div className="flex-1 h-px bg-white/10" />
          <Button
            onClick={onSwitchTokens}
            className="mx-4 rounded-md"
            size="icon-sm"
            variant="secondary"
          >
            <Icon icon="lucide:arrow-down-up" width={18} height={18} />
          </Button>
          <div className="flex-1 h-px bg-white/10" />
        </div>
        <SwapCurrencyInput
          label="To"
          token={tokenOut}
          amount={estimatedOut}
          fiatValue={toFiat}
          onTokenSelect={() => onSelectToken('out')}
          isReadOnly
          extraHeader={
            !isZecToOther ? (
              <AddressTypeSwitch
                type={addressType}
                onClick={onSelectZecAddress}
                size="md"
                ariaLabel="Select address type"
              />
            ) : undefined
          }
        />
        {isZecToOther && tokenOut && (
          <AddressInputWithRecent
            label="Address"
            value={recipientAddress}
            placeholder={`${formatChainName(tokenOut.blockchain)} address...`}
            recentAddresses={recentRecipientAddresses}
            onChange={onRecipientAddressChange}
          />
        )}
        {/* Rate, slippage, fee tier */}
        <div className="space-y-3 pt-2">
          <div className="flex justify-between items-center">
            <span className="text-sm text-muted">Slippage tolerance</span>
            <Button
              onClick={onOpenSlippageSetting}
              variant="secondary"
              className="flex items-center gap-1"
              size="sm"
            >
              <span className="text-sm">{slippage}%</span>
              <Icon icon="lucide:settings" width={14} height={14} />
            </Button>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm text-muted">Rate</span>

            <span className="text-sm">
              1 {formatSymbol(tokenIn?.symbol) || 'ZEC'} = {formatNumber(rate)}{' '}
              {formatSymbol(tokenOut?.symbol) || '...'}
            </span>
          </div>
          {showFeeTier && (
            <FeeTierPicker
              tier={feeTier!}
              onTierChange={onFeeTierChange!}
              feeByTier={feeByTier!}
              loading={feeLoading}
              loadingByTier={feeLoadingByTier}
            />
          )}
        </div>
      </div>

      <div className="page-footer">
        <Button
          onClick={onGetQuote}
          disabled={!canGetQuote || hasInsufficientFunds}
          isLoading={isQuoting}
          className={`w-full h-[50px] font-semibold rounded-xl ${
            canGetQuote && !hasInsufficientFunds && !isQuoting
              ? 'bg-primary hover:bg-primary/90 text-black'
              : 'bg-[#2C2C2E] text-muted cursor-not-allowed'
          }`}
        >
          Get a quote
        </Button>
      </div>
    </>
  )
}
