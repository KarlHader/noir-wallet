import { useEffect, useState } from 'react'
import { Icon } from '@iconify/react'
import { AmountDisplay } from '../common/AmountDisplay'
import { InlineError } from '../common/InlineError'
import { Button } from '../ui/button'
import { ApprovalWindowLayout } from './ApprovalWindowLayout'
import { DAppRequestHeader } from './ApprovalRequestPresentation'
import { formatSortAddress } from '@/lib/format'
import {
  formatEvmGasFundingAmount,
  loadEvmGasFundingPreview,
  parseEvmGasFundingDetails,
  type EvmGasFundingPreview
} from '@/popup/services/evm-gas-funding'
import { buildPrivateGasFundingPath } from '@/popup/pages/transactions/evm-send-validation'

interface EvmGasFundingApprovalProps {
  readonly data: unknown
  readonly requestId: string | null
  readonly walletId: string | null
  readonly accountId: string | null
  readonly accountLoading: boolean
  readonly onRefreshAccount: () => void
  readonly domain: string
  readonly pageUrl: string
  readonly fundingComplete: boolean
  readonly isLoading: boolean
  readonly onDecision: (approved: boolean) => void
  readonly onFund: (path: string) => void
}

export function EvmGasFundingApproval(props: EvmGasFundingApprovalProps) {
  const details = parseEvmGasFundingDetails(props.data)
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<{ scope: string; preview: EvmGasFundingPreview } | null>(
    null
  )
  const scope = JSON.stringify([props.requestId, props.walletId, props.accountId, details, attempt])
  useEffect(() => {
    if (!details || !props.walletId || !props.accountId || props.fundingComplete) return
    let cancelled = false
    void loadEvmGasFundingPreview(details, { walletId: props.walletId, accountId: props.accountId })
      .then(preview => {
        if (!cancelled) setLoaded({ scope, preview })
      })
      .catch(() => {
        if (!cancelled)
          setLoaded({
            scope,
            preview: {
              publicBalanceRaw: null,
              suggestedOutputRaw: null,
              error: 'Unable to check gas funding. Try again.'
            }
          })
      })
    return () => {
      cancelled = true
    }
  }, [scope, props.fundingComplete])

  const preview = loaded?.scope === scope ? loaded.preview : null
  const hasAccount = Boolean(props.walletId && props.accountId)
  const loading =
    !props.fundingComplete &&
    details !== null &&
    (hasAccount ? preview === null : props.accountLoading)
  const error =
    details === null
      ? 'Gas funding details are unavailable. Reject this request and try again.'
      : !props.fundingComplete && !hasAccount && !props.accountLoading
        ? 'Unable to load the funding account. Try again.'
        : preview?.error
  const format = (raw: string | null) =>
    details ? formatEvmGasFundingAmount(raw, details.decimals) : null
  const hasEstimate = details !== null && BigInt(details.maximumGasCostRaw) > 0n
  const canFund =
    details !== null && preview !== null && !preview.error && preview.suggestedOutputRaw !== null

  return (
    <ApprovalWindowLayout
      footer={
        <div className="flex gap-3">
          <Button
            variant="outline"
            className="flex-1"
            onClick={() => props.onDecision(false)}
            disabled={props.isLoading}
            size="lg"
          >
            Reject
          </Button>
          <Button
            className="flex-1"
            size="lg"
            isLoading={loading}
            disabled={
              props.isLoading ||
              !details ||
              !props.requestId ||
              (!props.fundingComplete && !canFund)
            }
            onClick={() => {
              if (props.fundingComplete) {
                props.onDecision(true)
              } else if (details && props.requestId && canFund && preview?.suggestedOutputRaw) {
                props.onFund(
                  buildPrivateGasFundingPath({
                    chainId: details.chainId,
                    nativeAssetId: details.nativeAssetId,
                    requestId: props.requestId,
                    minimumOutputRaw: details.shortfallRaw,
                    suggestedOutputRaw: preview.suggestedOutputRaw
                  })
                )
              }
            }}
          >
            {props.fundingComplete ? 'Continue' : 'Fund gas'}
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        <DAppRequestHeader
          domain={props.domain}
          pageUrl={props.pageUrl}
          action={props.fundingComplete ? 'Confidential Gas added' : 'Fund Confidential Gas'}
        />
        {details && (
          <section className="overflow-hidden rounded-2xl border border-border bg-card/35">
            <div className="flex items-center gap-3 border-b border-border px-4 py-3.5">
              <span className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Icon icon="solar:incognito-outline" width={20} height={20} />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium">Confidential account</p>
                <p className="truncate font-mono text-xs text-muted" title={details.privateAddress}>
                  {formatSortAddress(details.privateAddress)}
                </p>
              </div>
            </div>
            {!props.fundingComplete && (
              <div className="space-y-3 px-4 py-3.5 text-sm">
                <div className="flex justify-between gap-3">
                  <span className="text-muted">Current Gas</span>
                  <span className="font-mono">
                    <AmountDisplay value={format(details.availableRaw)} symbol={details.symbol} />
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted">Maximum Gas</span>
                  <span className="font-mono">
                    <AmountDisplay
                      value={hasEstimate ? format(details.maximumGasCostRaw) : null}
                      symbol={details.symbol}
                      profile="fee"
                    />
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted">Public balance</span>
                  <span className="font-mono">
                    <AmountDisplay
                      value={format(preview?.publicBalanceRaw ?? null)}
                      symbol={details.symbol}
                    />
                  </span>
                </div>
                {hasEstimate && (
                  <div className="flex justify-between gap-3 font-medium">
                    <span>Minimum</span>
                    <span className="font-mono text-primary">
                      <AmountDisplay value={format(details.shortfallRaw)} symbol={details.symbol} />
                    </span>
                  </div>
                )}
                <div className="flex justify-between gap-3 font-medium">
                  <span>Suggested</span>
                  <span className="font-mono text-primary">
                    <AmountDisplay
                      value={format(preview?.suggestedOutputRaw ?? null)}
                      symbol={details.symbol}
                    />
                  </span>
                </div>
              </div>
            )}
          </section>
        )}
        {error && (
          <InlineError
            message={error}
            onRetry={
              details
                ? () => {
                    if (!hasAccount) props.onRefreshAccount()
                    else setAttempt(value => value + 1)
                  }
                : undefined
            }
            retrying={loading}
          />
        )}
      </div>
    </ApprovalWindowLayout>
  )
}
