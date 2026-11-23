import { formatSortAddress } from '@/lib/format'
import { Button } from '../ui/button'
import { WarningBox } from '../ui/WarningBox'
import { ApprovalWindowLayout } from './ApprovalWindowLayout'
import { ShieldProviderLogo } from '../portfolio/shield-providers'
import {
  ApprovalDetailCard,
  ConnectionPermissionSummary,
  DAppConnectionHeader,
  DAppRequestHeader
} from './ApprovalRequestPresentation'

type ShieldDappApprovalAction = 'shieldConnect' | 'shieldReceive' | 'shieldTransfer'

interface ShieldDappApprovalProps {
  readonly action: ShieldDappApprovalAction
  readonly data: unknown
  readonly domain: string
  readonly pageUrl: string
  readonly accountDisplayName: string
  readonly isLoading: boolean
  readonly onDecision: (approved: boolean) => void
}

function readText(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

export function ShieldDappApproval(props: ShieldDappApprovalProps) {
  const record =
    typeof props.data === 'object' && props.data !== null && !Array.isArray(props.data)
      ? (props.data as Record<string, unknown>)
      : {}

  if (props.action === 'shieldConnect') {
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
              className="flex-1 bg-primary hover:bg-primary/90"
              onClick={() => props.onDecision(true)}
              isLoading={props.isLoading}
              disabled={props.isLoading}
              size="lg"
            >
              Connect
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <DAppConnectionHeader domain={props.domain} pageUrl={props.pageUrl} />
          <div className="flex items-center gap-3 rounded-xl border border-primary bg-primary/5 p-3">
            <ShieldProviderLogo provider="near-confidential" size={32} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium" title={props.accountDisplayName}>
                {props.accountDisplayName}
              </div>
              <div className="mt-1 truncate text-[11px] text-muted-foreground">
                Shield · NEAR Confidential
              </div>
            </div>
          </div>
          <ConnectionPermissionSummary
            access="View Shield balances and activity."
            safeguard="Each receive and transfer still requires your approval."
          />
        </div>
      </ApprovalWindowLayout>
    )
  }

  const amount = readText(record, 'amount')
  const symbol = readText(record, 'symbol')
  const sourceAddress = readText(record, 'sourceAddress')
  const expectedReceive = readText(record, 'expectedReceive')
  const expectedSymbolText = readText(record, 'expectedSymbol')
  const expectedSymbol = expectedSymbolText.length > 0 ? expectedSymbolText : symbol
  const quoteDifference = readText(record, 'quoteDifference')
  const networkFee = readText(record, 'networkFee')
  const networkFeeSymbol = readText(record, 'networkFeeSymbol')
  const destinationSymbolValue = record.destinationSymbol
  const destinationSymbol =
    typeof destinationSymbolValue === 'string' ? destinationSymbolValue : symbol
  const destinationChainName = readText(record, 'destinationChainName')
  const destinationAddress = readText(record, 'destinationAddress')
  const chainName = readText(record, 'chainName')
  const isTransfer = props.action === 'shieldTransfer'
  const ready =
    amount.length > 0 &&
    symbol.length > 0 &&
    sourceAddress.length > 0 &&
    expectedReceive.length > 0 &&
    (isTransfer
      ? destinationChainName.length > 0 && destinationAddress.length > 0
      : chainName.length > 0)

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
            className="flex-1 bg-primary hover:bg-primary/90"
            onClick={() => props.onDecision(true)}
            isLoading={props.isLoading}
            disabled={props.isLoading || !ready}
            size="lg"
          >
            Confirm
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <DAppRequestHeader
          domain={props.domain}
          pageUrl={props.pageUrl}
          action={isTransfer ? 'Send from Shield' : 'Receive into Shield'}
          description={
            ready
              ? isTransfer
                ? `${amount} ${symbol} to ${destinationAddress} on ${destinationChainName}`
                : `${amount} ${symbol} on ${chainName}`
              : isTransfer
                ? 'Review this transfer.'
                : 'Review this receive.'
          }
        />
        {ready ? (
          <ApprovalDetailCard title="Amount">
            <div className="space-y-3 text-sm">
              <div className="flex justify-between gap-3">
                <span className="text-muted">Privacy layer</span>
                <span className="text-right">
                  <span className="block">NEAR Confidential</span>
                  <span className="block text-muted">near-confidential</span>
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted">From</span>
                <span className="flex min-w-0 flex-col items-end gap-1" title={sourceAddress}>
                  <span>
                    {props.accountDisplayName} ·{' '}
                    {isTransfer ? 'Shield · NEAR Confidential' : chainName}
                  </span>
                  <span className="font-mono">{formatSortAddress(sourceAddress)}</span>
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted">To</span>
                {isTransfer ? (
                  <span
                    className="flex min-w-0 flex-col items-end gap-1"
                    title={destinationAddress}
                  >
                    <span>
                      {destinationSymbol} on {destinationChainName}
                    </span>
                    <span className="font-mono">{formatSortAddress(destinationAddress)}</span>
                  </span>
                ) : (
                  <span className="text-right">
                    {props.accountDisplayName} · Shield · NEAR Confidential
                  </span>
                )}
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted">Amount</span>
                <span className="font-sans font-medium tabular-nums">
                  {amount} {symbol}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted">Estimated receive</span>
                <span className="font-sans font-medium tabular-nums">
                  {expectedReceive} {expectedSymbol}
                </span>
              </div>
              {quoteDifference.length > 0 ? (
                <div className="flex justify-between gap-3">
                  <span className="text-muted">Quote difference</span>
                  <span className="font-sans tabular-nums">
                    {quoteDifference} {symbol}
                  </span>
                </div>
              ) : null}
              {networkFee.length > 0 && networkFeeSymbol.length > 0 ? (
                <div className="flex justify-between gap-3">
                  <span className="text-muted">Max network fee</span>
                  <span className="font-sans tabular-nums">
                    {networkFee} {networkFeeSymbol}
                  </span>
                </div>
              ) : null}
            </div>
          </ApprovalDetailCard>
        ) : (
          <WarningBox>
            {isTransfer
              ? 'The Shield transfer request is invalid or expired.'
              : 'The Shield receive request is invalid or expired.'}
          </WarningBox>
        )}
      </div>
    </ApprovalWindowLayout>
  )
}
