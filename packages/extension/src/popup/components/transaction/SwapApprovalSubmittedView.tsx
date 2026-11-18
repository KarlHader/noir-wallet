import { formatChainName, formatSortAddress, formatSymbol } from '@/lib/format'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { InlineError } from '@/popup/components/common/InlineError'
import { Button } from '@/popup/components/ui/button'
import type { TransactionGraph } from '@/core/transactions/domain'
import type { RheaSwapToken } from '@/core/services/rhea-swap'
import { formatChainTransactionExplorerUrl } from '@/popup/services/chain-explorer'
import type { Network } from '@/types'
import { TransactionResult } from './TransactionResult'

export function SwapApprovalSubmittedView({
  approval,
  token,
  networkName,
  network,
  isSend,
  disabled,
  loading,
  error,
  onContinue,
  onOpenActivity
}: {
  approval: { graph: TransactionGraph; amountRaw: string; spender: string }
  token: RheaSwapToken
  networkName?: string
  network: Network
  isSend: boolean
  disabled: boolean
  loading: boolean
  error: string | null
  onContinue: () => void
  onOpenActivity: () => void
}) {
  const origin = approval.graph.segments.find(segment => segment.role === 'origin')
  const originHash = origin?.evidence?.transactionHash
  const chainId = origin?.target.kind === 'onchain' ? origin.target.chainId : undefined

  return (
    <TransactionResult
      status="submitted"
      title="Token approval submitted"
      footer={
        <div className="w-full space-y-2">
          {error && <InlineError message={error} />}
          <Button
            className="h-[45px] w-full"
            onClick={onContinue}
            disabled={disabled}
            isLoading={loading}
          >
            {isSend ? 'Continue Send' : 'Continue Swap'}
          </Button>
          <Button variant="outline" className="h-[45px] w-full" onClick={onOpenActivity}>
            View Activity
          </Button>
        </div>
      }
    >
      <div className="divide-y divide-border/60 rounded-xl bg-card/60 px-4">
        <div className="flex justify-between gap-3 py-3 text-xs">
          <span className="text-muted">Approval amount</span>
          <AmountDisplay
            value={formatBaseUnitDecimalAmount(approval.amountRaw, token.decimals)}
            symbol={formatSymbol(token.symbol)}
          />
        </div>
        <div className="flex justify-between gap-3 py-3 text-xs">
          <span className="text-muted">Network</span>
          <span>{networkName ?? formatChainName(token.blockchain)}</span>
        </div>
        <div className="flex justify-between gap-3 py-3 text-xs">
          <span className="text-muted">Spender</span>
          <span className="font-mono" title={approval.spender}>
            {formatSortAddress(approval.spender)}
          </span>
        </div>
        {originHash && chainId && (
          <div className="flex justify-between gap-3 py-3 text-xs">
            <span className="text-muted">Transaction ID</span>
            <a
              href={formatChainTransactionExplorerUrl(chainId, originHash, network)}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-primary"
              title={originHash}
            >
              {formatSortAddress(originHash)}
            </a>
          </div>
        )}
      </div>
    </TransactionResult>
  )
}
