import type { ComponentProps, ReactNode } from 'react'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { cn } from '@/lib/utils'
import { AccountDomainBadge } from '../account/AccountDomainBadge'
import { ChainIcon } from '../common/ChainIcon'
import { ShieldProviderLogo, SHIELD_PROVIDERS } from '../portfolio/shield-providers'
import { TransactionReferenceValue } from './TransactionReferenceValue'

export type ReviewPartyChain =
  | { readonly name: string; readonly icon: string }
  | { readonly displayName: string; readonly family: string; readonly id: string }

export function TransactionReviewParty({
  accountName,
  domain,
  badge,
  address,
  chain,
  confidential,
  fullAddress,
  align = 'end'
}: {
  readonly accountName?: string
  readonly domain?: ComponentProps<typeof AccountDomainBadge>['domain']
  readonly badge?: ReactNode
  readonly address?: string
  readonly chain?: ReviewPartyChain
  readonly confidential?: boolean
  readonly fullAddress?: boolean
  readonly align?: 'start' | 'end'
}) {
  const name = chain && ('name' in chain ? chain.name : chain.displayName)
  const icon =
    chain &&
    ('icon' in chain
      ? chain.icon
      : resolveChainIconAlias(chain.family, chain.displayName, chain.id))
  const network = confidential ? SHIELD_PROVIDERS['near-confidential'].detailName : name
  const row = cn('flex min-w-0 items-center gap-1.5', align === 'end' && 'justify-end')

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {(accountName || domain || badge) && (
        <div className={row}>
          {accountName && (
            <span className="truncate" title={accountName}>
              {accountName}
            </span>
          )}
          {badge ?? (domain && <AccountDomainBadge domain={domain} />)}
        </div>
      )}
      {(network || address) && (
        <div
          className={cn(row, 'gap-2 text-xs font-normal text-muted', fullAddress && 'flex-wrap')}
        >
          {network && (
            <span className="flex min-w-0 items-center gap-1.5">
              {confidential ? (
                <ShieldProviderLogo provider="near-confidential" size={14} />
              ) : (
                icon && (
                  <ChainIcon
                    chain={icon}
                    width={14}
                    height={14}
                    showTooltip={false}
                    className="shrink-0"
                    aria-hidden="true"
                  />
                )
              )}
              <span className="truncate" title={network}>
                {network}
              </span>
            </span>
          )}
          {address &&
            (fullAddress ? (
              <span className="min-w-0 break-all font-mono" title={address}>
                {address}
              </span>
            ) : (
              <span className="shrink-0 whitespace-nowrap">
                <TransactionReferenceValue hash={address} url="" compact />
              </span>
            ))}
        </div>
      )}
    </div>
  )
}
