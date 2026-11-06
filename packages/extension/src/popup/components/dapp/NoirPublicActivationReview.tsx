import { Icon } from '@iconify/react'
import type { NoirPublicActivationReview as ActivationReview } from '@/popup/services/noir-public-approval-review'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { DetailRow } from '@/popup/components/common/DetailRow'
import { ApprovalDetailCard } from './ApprovalRequestPresentation'

export function NoirPublicActivationReview({ review }: { readonly review: ActivationReview }) {
  return (
    <div className="space-y-4">
      <section aria-label="Total payment" className="py-4 text-center">
        <p className="mb-2 text-xs text-muted">Total payment</p>
        <AmountDisplay
          value={review.totalPayment}
          symbol={review.sourceSymbol}
          className="text-2xl font-medium"
        />
      </section>

      <ApprovalDetailCard ariaLabel="Payment breakdown">
        <DetailRow label="Activation payment">
          <AmountDisplay value={review.amount} symbol={review.sourceSymbol} className="text-sm" />
        </DetailRow>
        <DetailRow label="Network fee">
          <AmountDisplay
            value={review.fee}
            symbol={review.sourceSymbol}
            profile="fee"
            className="text-sm"
          />
        </DetailRow>
      </ApprovalDetailCard>

      <ApprovalDetailCard ariaLabel="Public account balance">
        <DetailRow label="Receive in Public">
          <AmountDisplay
            value={review.expectedCredit}
            symbol="ZEC"
            className="text-sm text-primary"
          />
        </DetailRow>
      </ApprovalDetailCard>

      <details className="group text-xs">
        <summary className="flex cursor-pointer list-none items-center justify-between py-2 text-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
          Account and payment details
          <Icon
            icon="lucide:chevron-down"
            className="size-4 transition-transform group-open:rotate-180"
          />
        </summary>
        <div className="mt-2 space-y-3 rounded-2xl bg-card/70 p-4">
          <DetailRow label="Creation fee">
            <AmountDisplay value={review.creationFee} symbol="ZEC" className="text-xs" />
          </DetailRow>
          <div className="space-y-1">
            <p className="text-muted">Public address</p>
            <p className="break-all font-mono">{review.account.address}</p>
          </div>
          <div className="space-y-1">
            <p className="text-muted">Payment address</p>
            <p className="break-all font-mono">{review.depositAddress}</p>
          </div>
        </div>
      </details>
    </div>
  )
}
