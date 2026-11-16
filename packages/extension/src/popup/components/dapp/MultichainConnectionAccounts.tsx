import { useState } from 'react'
import { Icon } from '@iconify/react'
import { cn } from '@/lib/utils'
import { formatSortAddress } from '@/lib/format'
import {
  getMultichainConnectionAccountSelection,
  groupMultichainConnectionAccounts,
  type MultichainConnectionAccount,
  type MultichainConnectionAccountOption,
  type MultichainConnectionScope
} from '@/popup/services/dapp-connection-presentation'
import { ChainIcon } from '../common/ChainIcon'

interface MultichainConnectionAccountsProps {
  readonly scopes: readonly MultichainConnectionScope[]
  readonly selections: Readonly<Record<string, readonly string[]>>
  readonly onToggleAccount: (account: MultichainConnectionAccount) => void
  readonly onTogglePermission: (
    scope: MultichainConnectionScope,
    account: MultichainConnectionAccountOption
  ) => void
}

export function MultichainConnectionAccounts({
  scopes,
  selections,
  onToggleAccount,
  onTogglePermission
}: MultichainConnectionAccountsProps) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const accounts = groupMultichainConnectionAccounts(scopes)
  const selectedCount = accounts.filter(
    account => getMultichainConnectionAccountSelection(account, selections) !== 'none'
  ).length

  return (
    <section
      aria-label="Accounts"
      className="overflow-hidden rounded-2xl border border-border bg-card/35"
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium">Accounts</h2>
        <span className="text-xs text-muted">
          {selectedCount} {selectedCount === 1 ? 'account' : 'accounts'} selected
        </span>
      </div>
      {accounts.map(account => {
        const selection = getMultichainConnectionAccountSelection(account, selections)
        const current = account.permissions.some(permission => permission.account.required)
        const expanded = expandedKey === account.key
        return (
          <div
            key={account.key}
            data-caip25-account-group={account.key}
            className="border-b border-border last:border-b-0"
          >
            <div
              className={cn(
                'flex items-center gap-3 px-4 py-3',
                selection !== 'none' && 'bg-primary/[0.035]'
              )}
            >
              <button
                type="button"
                role="checkbox"
                aria-label={`Connect ${account.label}`}
                aria-checked={selection === 'some' ? 'mixed' : selection === 'all'}
                disabled={current && selection === 'all'}
                onClick={() => onToggleAccount(account)}
                className={cn(
                  'flex size-5 shrink-0 items-center justify-center rounded-md border focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2',
                  selection !== 'none'
                    ? 'border-primary bg-primary text-background'
                    : 'border-muted text-transparent'
                )}
              >
                {selection === 'some' ? (
                  <span aria-hidden="true" className="h-0.5 w-2.5 rounded-full bg-current" />
                ) : (
                  <Icon icon="lucide:check" className="size-3.5" />
                )}
              </button>
              <button
                type="button"
                aria-label={`View ${account.label} networks`}
                aria-expanded={expanded}
                onClick={() => setExpandedKey(expanded ? null : account.key)}
                className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{account.label}</span>
                    {current && <span className="shrink-0 text-[10px] text-muted">Current</span>}
                  </span>
                  <span className="mt-1.5 flex items-center gap-2">
                    <span className="flex items-center gap-1" aria-hidden="true">
                      {account.networks.slice(0, 5).map(network => (
                        <ChainIcon
                          key={network.chainId}
                          chain={network.iconChain}
                          width={16}
                          height={16}
                          showTooltip={false}
                          className="size-4 shrink-0"
                        />
                      ))}
                    </span>
                    <span className="text-[11px] text-muted">
                      {account.networks.length}{' '}
                      {account.networks.length === 1 ? 'network' : 'networks'}
                      {selection === 'some' && ' · Partial access'}
                    </span>
                  </span>
                </span>
                <Icon
                  icon="lucide:chevron-down"
                  className={cn(
                    'size-4 shrink-0 text-muted transition-transform',
                    expanded && 'rotate-180'
                  )}
                />
              </button>
            </div>
            {expanded && (
              <div className="space-y-1.5 bg-background/20 px-3 pb-3 pt-1">
                {account.permissions.map(({ scope, account: option }) => {
                  const selected = selections[scope.chainId]?.includes(option.id) ?? false
                  return (
                    <div
                      key={scope.chainId}
                      data-caip25-scope={scope.chainId}
                      className="flex items-start gap-3 rounded-xl px-2 py-2.5"
                    >
                      <button
                        type="button"
                        role="checkbox"
                        aria-label={`${scope.chainName} for ${account.label}`}
                        aria-checked={selected}
                        disabled={option.required}
                        data-caip25-account={option.id}
                        onClick={() => onTogglePermission(scope, option)}
                        className={cn(
                          'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2',
                          selected
                            ? 'border-primary bg-primary text-background'
                            : 'border-muted text-transparent'
                        )}
                      >
                        <Icon icon="lucide:check" className="size-3" />
                      </button>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <ChainIcon
                            chain={scope.iconChain}
                            width={18}
                            height={18}
                            showTooltip={false}
                            className="size-[18px] shrink-0"
                          />
                          <span className="text-xs font-medium">{scope.chainName}</span>
                        </div>
                        {(scope.networks?.length ?? 0) > 1 && (
                          <p className="mt-1 text-[11px] leading-relaxed text-muted">
                            {scope.networks!.map(network => network.chainName).join(', ')}
                          </p>
                        )}
                        <p
                          title={option.address}
                          className="mt-1 truncate font-mono text-[11px] text-muted"
                        >
                          {formatSortAddress(option.address)}
                        </p>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </section>
  )
}
