import { Button } from '../ui/button'
import { TransactionResult } from './TransactionResult'
import { formatSortAddress } from '@/lib/format'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { getZcashChainId } from '@/core/chains/registry'
import { formatChainTransactionExplorerUrl } from '@/popup/services/chain-explorer'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { useAddressBookStore } from '@/store/address-book-store'
import type { TransactionStep } from '@/popup/hooks/useTransaction'
import { getStandardTransactionResultCopy } from '@/lib/transaction-status-copy'
import { InlineError } from '@/popup/components/common/InlineError'

export interface StandardTransactionResultProps {
  step: TransactionStep
  amount: string

  fromAddress?: string
  toAddress?: string
  txHash?: string
  timestamp?: number
  error?: string | null
  shield?: boolean

  customTitle?: string
  customDescription?: string

  showFrom?: boolean
  showTo?: boolean
  showTxHash?: boolean
  showTime?: boolean
  extraDetails?: Array<{ label: string; value: string }>

  failureAction?: {
    label: string
    onClick: () => void
    retry?: boolean
  }
  onDone: () => void
  onCancel?: () => void
}

export function StandardTransactionResult({
  step,
  amount,
  fromAddress,
  toAddress,
  txHash,
  timestamp,
  error,
  shield,
  customTitle,
  customDescription,
  showFrom = false,
  showTo = true,
  showTxHash = true,
  showTime = true,
  extraDetails,
  failureAction,
  onDone,
  onCancel
}: StandardTransactionResultProps) {
  const zcashChainId = getZcashChainId(DEFAULT_NETWORK)
  const toContact = useAddressBookStore(state =>
    toAddress ? state.getContact(zcashChainId, toAddress) : undefined
  )
  const baseConfig = getStandardTransactionResultCopy(step, { error, shield })
  const title = customTitle || baseConfig.title
  const description = customDescription || baseConfig.description

  const footer =
    step === 'success' ||
    step === 'submitted' ||
    step === 'confirming' ||
    (step === 'pending' && error) ? (
      <Button onClick={onDone} className="w-full h-[45px]">
        Done
      </Button>
    ) : step === 'failed' ? (
      <div className="space-y-3">
        {failureAction && !failureAction.retry && (
          <Button onClick={failureAction.onClick} className="w-full h-[45px]">
            {failureAction.label}
          </Button>
        )}
        {onCancel && (
          <Button variant="ghost" onClick={onCancel} className="w-full h-[45px]">
            Cancel
          </Button>
        )}
      </div>
    ) : undefined

  return (
    <TransactionResult
      status={baseConfig.resultStatus}
      title={title}
      description={step === 'failed' && failureAction?.retry ? undefined : description}
      footer={footer}
    >
      {step === 'failed' && failureAction?.retry && (
        <InlineError message={description || error || title} onRetry={failureAction.onClick} />
      )}
      {step !== 'failed' && (
        <div className="w-full space-y-3">
          <div className="flex justify-between items-center py-3 border-b border-white/10">
            <span className="text-sm text-muted">Amount</span>
            <span className="text-sm font-medium">
              <AmountDisplay value={amount} symbol="ZEC" />
            </span>
          </div>

          {showFrom && fromAddress && (
            <div className="flex justify-between items-center py-3 border-b border-white/10">
              <span className="text-sm text-muted">From</span>
              <span className="text-sm font-mono text-muted">{formatSortAddress(fromAddress)}</span>
            </div>
          )}

          {showTo && toAddress && (
            <div className="flex justify-between items-center py-3 border-b border-white/10">
              <span className="text-sm text-muted">To</span>
              <div className="flex flex-col items-end">
                {toContact?.znsName && (
                  <span className="text-xs text-primary">{toContact.znsName}</span>
                )}
                <span className="text-sm font-mono text-muted">{formatSortAddress(toAddress)}</span>
              </div>
            </div>
          )}

          {extraDetails?.map(detail => (
            <div
              key={detail.label}
              className="flex justify-between items-center py-3 border-b border-white/10"
            >
              <span className="text-sm text-muted">{detail.label}</span>
              <span className="text-sm font-medium">{detail.value}</span>
            </div>
          ))}

          {(step === 'success' || step === 'submitted' || step === 'confirming') &&
            showTime &&
            timestamp && (
              <div className="flex justify-between items-center py-3 border-b border-white/10">
                <span className="text-sm text-muted">Time</span>
                <span className="text-sm font-medium text-muted">
                  {new Date(timestamp).toLocaleString()}
                </span>
              </div>
            )}

          {showTxHash && txHash && (
            <div className="flex justify-between items-center py-3">
              <span className="text-sm text-muted">Transaction Hash</span>
              <a
                href={formatChainTransactionExplorerUrl(
                  getZcashChainId(DEFAULT_NETWORK),
                  txHash,
                  DEFAULT_NETWORK
                )}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-mono text-primary cursor-pointer hover:underline"
              >
                {formatSortAddress(txHash)}
              </a>
            </div>
          )}
        </div>
      )}
    </TransactionResult>
  )
}
