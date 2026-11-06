import type { ReactNode } from 'react'
import { Icon } from '@iconify/react'
import type { SigningSummary } from '@/core/keyring/domain'
import { cn } from '@/lib/utils'
import { CopyToast, useCopyToClipboard } from '@/popup/components/common/CopyToast'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { ApprovalWindowLayout } from '@/popup/components/dapp/ApprovalWindowLayout'
import {
  ApprovalContextCard,
  ApprovalRequestHeader,
  DAppNetworkCard,
  DAppRequestHeader
} from '@/popup/components/dapp/ApprovalRequestPresentation'
import { Button } from '@/popup/components/ui/button'
import {
  buildSigningSummaryReviewModel,
  type SigningSummaryReviewRow,
  type SigningSummaryReviewSection
} from './signing-summary-review-model'
import type { DAppExecutionMode } from '@/core/dapp/dapp-execution-mode'
import { ExecutionAccountBadge } from '@/popup/components/account/ExecutionAccountSelector'
import type { EvmReviewPresentationOptions } from './signing-summary-review-model-other'

export type SigningRequestSource =
  | { readonly kind: 'wallet' }
  | {
      readonly kind: 'dapp'
      readonly domain: string
      readonly pageUrl: string
    }

export interface SigningSummaryReviewProps {
  readonly summary: SigningSummary
  readonly chainName: string
  readonly iconChain?: string
  readonly networkName: string
  readonly accountName: string
  readonly accountAddress: string
  readonly source: SigningRequestSource
  readonly accountMode?: DAppExecutionMode
  readonly isSubmitting?: boolean
  readonly feeControl?: ReactNode
  readonly notice?: ReactNode
  readonly evmPresentation?: EvmReviewPresentationOptions
  readonly onReject: () => void
  readonly onConfirm: () => void
}

function ReviewValue({
  row,
  accountMode
}: {
  readonly row: SigningSummaryReviewRow
  readonly accountMode?: DAppExecutionMode
}) {
  const showPrivateAccount = row.label === 'From' && accountMode === 'private'

  return (
    <p
      className={cn(
        'min-w-0 whitespace-pre-wrap text-right text-xs leading-5 text-foreground/90',
        row.code && !row.amount && 'font-mono',
        row.breakAll && 'break-all',
        row.tone === 'warning' && 'text-warning',
        row.tone === 'danger' && 'text-danger'
      )}
      title={row.title ?? row.value}
    >
      {row.amount ? (
        <AmountDisplay
          value={row.amount.value}
          symbol={row.amount.symbol}
          profile={row.amount.profile}
        />
      ) : (
        row.value
      )}
      {showPrivateAccount && (
        <span
          aria-label="Confidential execution account"
          className="mt-1.5 flex justify-end leading-none"
        >
          <ExecutionAccountBadge mode="private" />
        </span>
      )}
    </p>
  )
}

function ReviewLabel({ label }: { label: string }) {
  const separatorIndex = label.indexOf('.')
  if (separatorIndex < 0) return label

  return (
    <>
      {label.slice(0, separatorIndex + 1)}
      <wbr />
      {label.slice(separatorIndex + 1)}
    </>
  )
}

function isPrimaryMessageRow(row: SigningSummaryReviewRow): boolean {
  return row.label === 'Content' || row.label.startsWith('Message.')
}

function isAdvancedTransactionRow(sectionTitle: string, row: SigningSummaryReviewRow): boolean {
  if (
    row.label === 'Execution' ||
    sectionTitle === 'Request' ||
    sectionTitle === 'Contract data' ||
    /^Inputs \(/.test(sectionTitle)
  ) {
    return true
  }
  return /^(?:Schema|Chain ID|Signer|PSBT version|Signing inputs|Gas limit|Nonce|Transaction type|Method selector|Gas price|Max fee per gas|Priority fee per gas|Message version|Recent blockhash|Required signers|Address table lookups|Compute unit limit|CU price|Max priority fee|Simulation|Simulated units|Public key|Script|Outpoint|Sighash|Signing hash|TRON prefix|Timestamp|Expiration|Reference |Instruction \d+$)|(?: encoding| size| SHA-256)$/.test(
    row.label
  )
}

function ReviewRows({
  rows,
  accountMode
}: {
  readonly rows: readonly SigningSummaryReviewRow[]
  readonly accountMode?: DAppExecutionMode
}) {
  return rows.map((row, index) => (
    <div
      key={`${row.label}-${index}`}
      className="grid grid-cols-[104px_minmax(0,1fr)] gap-3 py-2.5"
    >
      <span className="min-w-0 break-words text-xs leading-5 text-muted">
        <ReviewLabel label={row.label} />
      </span>
      <ReviewValue row={row} accountMode={accountMode} />
    </div>
  ))
}

function AdvancedReview({
  sections
}: {
  readonly sections: readonly SigningSummaryReviewSection[]
}) {
  if (sections.length === 0) return null

  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center gap-1 px-1 text-sm text-muted transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
        <Icon
          icon="lucide:chevron-right"
          width={15}
          height={15}
          className="transition-transform group-open:rotate-90"
        />
        Advanced
      </summary>
      <div className="mt-2 space-y-3">
        {sections.map(section => (
          <section
            key={section.title}
            aria-label={section.title}
            className="space-y-2 overflow-hidden rounded-xl border border-border bg-card/25 px-3 py-2"
          >
            <ReviewRows rows={section.rows} />
          </section>
        ))}
      </div>
    </details>
  )
}

function DAppMessageReview({
  model,
  chainName,
  iconChain,
  networkName
}: {
  readonly model: ReturnType<typeof buildSigningSummaryReviewModel>
  readonly chainName: string
  readonly iconChain?: string
  readonly networkName: string
}) {
  const { copyToClipboard, showToast } = useCopyToClipboard()
  const primaryRows = model.sections.flatMap(section => section.rows.filter(isPrimaryMessageRow))
  const fallbackRows = model.sections.find(section => section.title !== 'Request')?.rows ?? []
  const messageRows = primaryRows.length > 0 ? primaryRows : fallbackRows
  const advancedSections = model.sections
    .map(section => ({
      ...section,
      rows: section.rows.filter(row => !messageRows.includes(row))
    }))
    .filter(section => section.rows.length > 0)
  const copyValue = messageRows.map(row => row.value).join('\n')

  return (
    <>
      <CopyToast show={showToast} message="Message copied" />
      <section aria-label="Message" className="rounded-2xl bg-card/70 p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm text-foreground/80">Message</h2>
          <button
            type="button"
            aria-label="Copy message"
            title="Copy message"
            className="flex size-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-foreground/10 hover:text-foreground"
            onClick={() => void copyToClipboard(copyValue)}
          >
            <Icon icon="lucide:copy" width={16} height={16} />
          </button>
        </div>
        {messageRows.length === 1 ? (
          <p className="whitespace-pre-wrap break-words font-mono text-sm leading-6 text-foreground">
            {messageRows[0]?.value}
          </p>
        ) : (
          <div className="space-y-3">
            {messageRows.map((row, index) => (
              <div key={`${row.label}-${index}`} className="min-w-0">
                <p className="text-xs text-muted">{row.label.replace(/^Message\./, '')}</p>
                <p className="mt-1 whitespace-pre-wrap break-all font-mono text-sm leading-5 text-foreground">
                  {row.value}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      <DAppNetworkCard chain={iconChain ?? chainName} network={networkName} />
      <AdvancedReview sections={advancedSections} />
    </>
  )
}

function DAppTransactionReview({
  model,
  chainName,
  iconChain,
  networkName,
  accountMode,
  feeControl
}: {
  readonly model: ReturnType<typeof buildSigningSummaryReviewModel>
  readonly chainName: string
  readonly iconChain?: string
  readonly networkName: string
  readonly accountMode?: DAppExecutionMode
  readonly feeControl?: ReactNode
}) {
  const feeRow = model.sections
    .flatMap(section => section.rows)
    .find(
      row => row.label === 'Fee' || row.label === 'Maximum fee' || row.label === 'RPC total fee'
    )
  const networkFee =
    feeControl ??
    (feeRow ? (
      <span
        title={feeRow.title ?? feeRow.value}
        className="font-sans text-sm tabular-nums text-foreground/90"
      >
        {feeRow.value}
      </span>
    ) : undefined)
  const detailSections = model.sections
    .filter(section => section.title !== 'Request')
    .map(section => ({
      ...section,
      rows: section.rows.filter(
        row => !isAdvancedTransactionRow(section.title, row) && row !== feeRow
      )
    }))
    .filter(section => section.rows.length > 0)
  const advancedSections = model.sections
    .map(section => ({
      ...section,
      rows: section.rows.filter(row => isAdvancedTransactionRow(section.title, row))
    }))
    .filter(section => section.rows.length > 0)

  return (
    <>
      {detailSections.slice(0, 1).map(section => (
        <section
          key={section.title}
          aria-label={section.title}
          className="overflow-hidden rounded-2xl bg-card/70"
        >
          <h2 className="px-4 pt-3.5 text-sm text-foreground/80">{section.title}</h2>
          <div className="space-y-2 px-4 pb-3">
            <ReviewRows rows={section.rows} accountMode={accountMode} />
          </div>
        </section>
      ))}
      <DAppNetworkCard chain={iconChain ?? chainName} network={networkName} fee={networkFee} />
      {detailSections.slice(1).map(section => (
        <section
          key={section.title}
          aria-label={section.title}
          className="overflow-hidden rounded-2xl bg-card/70"
        >
          <h2 className="px-4 pt-3.5 text-sm text-foreground/80">{section.title}</h2>
          <div className="space-y-2 px-4 pb-3">
            <ReviewRows rows={section.rows} />
          </div>
        </section>
      ))}
      <AdvancedReview sections={advancedSections} />
    </>
  )
}

export function SigningSummaryReview({
  summary,
  chainName,
  iconChain,
  networkName,
  accountName,
  accountAddress,
  source,
  accountMode,
  isSubmitting = false,
  feeControl,
  notice,
  evmPresentation,
  onReject,
  onConfirm
}: SigningSummaryReviewProps) {
  const model = buildSigningSummaryReviewModel(summary, evmPresentation)
  const isBlocked = model.level === 'blocked'
  const isDAppMessage = source.kind === 'dapp' && model.operation === 'message'
  const isDAppTransaction = source.kind === 'dapp' && model.operation === 'transaction'
  const hideReviewableUnknownEvmCall =
    isDAppTransaction && summary.schema === 'evm.transaction.v1' && model.level === 'caution'
  const visibleIssues = hideReviewableUnknownEvmCall
    ? model.issues.filter(issue => issue.code !== 'unrecognized-call')
    : model.issues
  const isCaution = model.level === 'caution' && visibleIssues.length > 0
  const confirmLabel = isBlocked
    ? 'Signing blocked'
    : isCaution
      ? 'Confirm anyway'
      : model.operation === 'message'
        ? 'Sign message'
        : 'Confirm'
  const requestTone = isBlocked ? 'blocked' : isCaution ? 'caution' : 'standard'

  return (
    <ApprovalWindowLayout
      footer={
        <div className="flex gap-3">
          <Button
            variant="outline"
            size="lg"
            className="flex-1"
            disabled={isSubmitting}
            onClick={onReject}
          >
            Reject
          </Button>
          <Button
            variant={isBlocked ? 'secondary' : 'default'}
            size="lg"
            className="flex-1"
            disabled={isBlocked}
            isLoading={isSubmitting}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      }
    >
      <main aria-label="Signing request review" className="space-y-5">
        {source.kind === 'dapp' ? (
          <DAppRequestHeader
            domain={source.domain}
            pageUrl={source.pageUrl}
            action={model.operation === 'message' ? 'Sign message' : 'Review transaction'}
            description={model.description}
            tone={requestTone}
          />
        ) : (
          <ApprovalRequestHeader
            chain={chainName}
            title={model.title}
            description={model.description}
            badge={isBlocked ? 'Blocked' : isCaution ? 'Extra review required' : 'Decoded request'}
            tone={requestTone}
          />
        )}

        {source.kind === 'wallet' && (
          <ApprovalContextCard
            ariaLabel="Signing context"
            rows={[
              { label: 'Network', value: `${chainName} · ${networkName}` },
              { label: 'Account', value: accountName },
              { label: 'Address', value: accountAddress, code: true, title: accountAddress }
            ]}
          />
        )}

        {source.kind === 'dapp' && accountMode === 'private' && !isDAppTransaction && (
          <section
            aria-label="Confidential execution account"
            className="flex min-w-0 items-center gap-2 rounded-xl bg-primary/6 px-3 py-2"
          >
            <ExecutionAccountBadge mode="private" />
            <span
              className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted"
              title={accountAddress}
            >
              {accountAddress}
            </span>
          </section>
        )}

        {notice}

        {source.kind === 'wallet' && feeControl && (
          <section
            aria-label="Network fee"
            className="rounded-xl border border-border bg-card/35 p-3"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted">Network fee</span>
              {feeControl}
            </div>
          </section>
        )}

        {visibleIssues.length > 0 && (
          <section
            role={isBlocked ? 'alert' : 'status'}
            aria-label={isBlocked ? 'Signing blocked' : 'Signing warnings'}
            className={cn(
              'space-y-3 rounded-xl border p-3',
              isBlocked ? 'border-danger/40 bg-danger/10' : 'border-warning/40 bg-warning/10'
            )}
          >
            {visibleIssues.map((issue, index) => (
              <div key={`${issue.title}-${index}`} className="min-w-0">
                <h2 className="text-xs font-semibold">{issue.title}</h2>
                <p className="mt-0.5 text-xs leading-5 text-foreground/70">{issue.description}</p>
              </div>
            ))}
          </section>
        )}

        {isDAppMessage ? (
          <DAppMessageReview
            model={model}
            chainName={chainName}
            iconChain={iconChain}
            networkName={networkName}
          />
        ) : isDAppTransaction ? (
          <DAppTransactionReview
            model={model}
            chainName={chainName}
            iconChain={iconChain}
            networkName={networkName}
            accountMode={accountMode}
            feeControl={feeControl}
          />
        ) : (
          model.sections.map(section => (
            <section key={section.title} aria-label={section.title} className="space-y-2">
              <h2 className="px-1 text-xs font-medium uppercase tracking-wide text-muted">
                {section.title}
              </h2>
              <div className="space-y-2 overflow-hidden rounded-xl border border-border bg-card/25 px-3 py-2">
                {section.rows
                  .filter(
                    row => !feeControl || (row.label !== 'Fee' && row.label !== 'Maximum fee')
                  )
                  .map((row, index) => (
                    <div
                      key={`${row.label}-${index}`}
                      className="grid grid-cols-[104px_minmax(0,1fr)] gap-3 py-2.5"
                    >
                      <span className="min-w-0 break-words text-xs leading-5 text-muted">
                        <ReviewLabel label={row.label} />
                      </span>
                      <ReviewValue row={row} />
                    </div>
                  ))}
              </div>
            </section>
          ))
        )}
      </main>
    </ApprovalWindowLayout>
  )
}
