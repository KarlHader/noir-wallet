import { Icon } from '@iconify/react'
import { ExecutionAccountBadge } from './ExecutionAccountSelector'

export function AccountDomainBadge({
  domain
}: {
  readonly domain: 'public' | 'private' | 'shield'
}) {
  if (domain !== 'shield') {
    return <ExecutionAccountBadge mode={domain === 'private' ? 'private' : 'main'} />
  }
  return (
    <span className="inline-flex shrink-0 items-center justify-center gap-1 rounded-md bg-success/10 px-1.5 py-0.5 text-[10px] font-medium leading-4 text-success">
      <Icon icon="lucide:shield" width={11} height={11} />
      Shield
    </span>
  )
}
