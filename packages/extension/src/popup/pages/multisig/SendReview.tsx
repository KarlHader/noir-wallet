import { useEffect, useState } from 'react'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { ZEC_DECIMALS } from '@/config/wallet'
import { PageHeader } from '@/popup/components/common/PageHeader'
import { InlineError } from '@/popup/components/common/InlineError'
import { FlowButton } from '@/popup/components/multisig/FlowButton'
import type { VaultSendReview } from '@/core/multisig/send-rpc'
import type { MultisigGroupRecord } from '@/core/multisig/types'

interface SendReviewProps {
  review: VaultSendReview
  group: MultisigGroupRecord
  isCancelling: boolean
  feedback: string | null
  onApprove: () => void
  onCancel: () => void
}

export function SendReview({
  review,
  group,
  isCancelling,
  feedback,
  onApprove,
  onCancel
}: SendReviewProps) {
  const [isExpired, setIsExpired] = useState(() => Date.now() >= review.binding.expiresAt)
  useEffect(() => {
    setIsExpired(Date.now() >= review.binding.expiresAt)
    const timer = window.setTimeout(
      () => setIsExpired(true),
      Math.max(0, review.binding.expiresAt - Date.now())
    )
    return () => window.clearTimeout(timer)
  }, [review.binding.expiresAt])
  const selectedPhones = group.devices
    .filter(device => review.binding.selectedSlots.includes(device.slot - 1) && device.slot !== 1)
    .map(device => device.name)
    .join(', ')
  const expiresAt = new Date(review.binding.expiresAt).toLocaleTimeString()
  const details = [
    ['To', review.summary.recipient],
    ['Amount', `${formatBaseUnitDecimalAmount(review.summary.amount, ZEC_DECIMALS)} ZEC`],
    ['Network fee', `${formatBaseUnitDecimalAmount(review.summary.fee, ZEC_DECIMALS)} ZEC`],
    ['Signers', selectedPhones],
    ['Network', review.binding.network === 'mainnet' ? 'Mainnet' : 'Testnet'],
    ['Review expires', expiresAt]
  ]

  return (
    <div className="page-container page-container--tab">
      <PageHeader title="Review transfer" showBack onBack={onCancel} />
      <div className="page-content space-y-5 pb-4">
        <h2 className="text-lg font-semibold">Confirm private ZEC transfer</h2>
        <dl className="space-y-4">
          {details.map(([label, value]) => (
            <div key={label} className="min-w-0 border-b border-border pb-3">
              <dt className="text-xs text-muted">{label}</dt>
              <dd className="mt-1 break-all text-sm text-foreground">{value}</dd>
            </div>
          ))}
          {review.summary.memo && (
            <div className="min-w-0 border-b border-border pb-3">
              <dt className="text-xs text-muted">Memo</dt>
              <dd className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground">
                {review.summary.memo}
              </dd>
            </div>
          )}
        </dl>
      </div>
      <div className="page-footer space-y-3">
        {feedback && <InlineError message={feedback} />}
        <FlowButton disabled={isCancelling || isExpired} onClick={onApprove}>
          Approve and start signing
        </FlowButton>
        {isExpired && (
          <InlineError message="This transfer review expired. Close it and prepare again." />
        )}
        <FlowButton variant="outline" disabled={isCancelling} onClick={onCancel}>
          {isCancelling ? 'Closing review…' : 'Cancel'}
        </FlowButton>
      </div>
    </div>
  )
}
