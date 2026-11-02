import { ChainIcon } from '@/popup/components/common/ChainIcon'
import type { EvmAddNetworkApprovalSummary } from '@/popup/services/dapp-approval-summary'
import { ApprovalDetailCard } from './ApprovalRequestPresentation'

export function EvmAddNetworkDetails({
  network
}: {
  readonly network: EvmAddNetworkApprovalSummary
}) {
  return (
    <ApprovalDetailCard ariaLabel="Network" className="space-y-4">
      <div className="flex items-center gap-3">
        <ChainIcon
          chain={network.iconChain}
          alt={`${network.chainName} network icon`}
          className="size-10 shrink-0 rounded-full"
          showTooltip={false}
        />
        <h2 className="min-w-0 break-words text-lg font-semibold">{network.chainName}</h2>
      </div>
      <dl className="space-y-4 border-t border-border pt-4 text-sm leading-5">
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted">Chain ID</dt>
          <dd className="font-mono">{network.numericChainId}</dd>
        </div>
        <div className="flex items-start justify-between gap-3">
          <dt className="shrink-0 text-muted">Currency symbol</dt>
          <dd className="min-w-0 break-all text-right">{network.nativeCurrency.symbol}</dd>
        </div>
        <div>
          <dt className="text-muted">RPC URL</dt>
          <dd className="mt-1 break-all font-mono text-xs leading-5">{network.rpcUrl}</dd>
        </div>
        {network.explorerUrl && (
          <div>
            <dt className="text-muted">Block explorer</dt>
            <dd className="mt-1 break-all font-mono text-xs leading-5">{network.explorerUrl}</dd>
          </div>
        )}
      </dl>
    </ApprovalDetailCard>
  )
}
