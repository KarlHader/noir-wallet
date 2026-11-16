import { useState, type ReactNode } from 'react'
import { ChainIcon } from '@/popup/components/common/ChainIcon'
import { cn } from '@/lib/utils'

export type ApprovalRequestTone = 'standard' | 'caution' | 'blocked'

interface DAppRequestHeaderProps {
  readonly domain: string
  readonly pageUrl: string
  readonly action: string
  readonly description?: string
  readonly tone?: ApprovalRequestTone
}

function createBrowserFaviconUrl(pageUrl: string): string {
  const faviconUrl = new URL(chrome.runtime.getURL('/_favicon/'))
  faviconUrl.searchParams.set('pageUrl', pageUrl)
  faviconUrl.searchParams.set('size', '64')
  return faviconUrl.href
}

export function DAppRequestHeader({
  domain,
  pageUrl,
  action,
  description,
  tone = 'standard'
}: DAppRequestHeaderProps) {
  const [faviconFailed, setFaviconFailed] = useState(false)
  const faviconUrl = createBrowserFaviconUrl(pageUrl)
  const emphasizesDomain = action === 'Connect to'

  return (
    <header>
      <div className="flex items-center gap-3">
        <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-card">
          {faviconFailed ? (
            <span className="text-lg font-semibold text-foreground/80" aria-hidden="true">
              {domain.charAt(0).toUpperCase() || '?'}
            </span>
          ) : (
            <img
              src={faviconUrl}
              alt={`${domain} favicon`}
              data-testid="dapp-favicon"
              className="size-full object-cover"
              onError={() => setFaviconFailed(true)}
            />
          )}
        </div>
        <div className="min-w-0 flex-1">
          {emphasizesDomain ? (
            <>
              <p className="text-sm text-muted">{action}</p>
              <h1 className="truncate text-xl font-semibold" title={domain}>
                {domain}
              </h1>
            </>
          ) : (
            <>
              <h1
                className={cn(
                  'truncate text-xl font-semibold',
                  tone === 'caution' && 'text-warning',
                  tone === 'blocked' && 'text-danger'
                )}
              >
                {action}
              </h1>
              <h2 className="truncate text-sm font-normal text-muted" title={domain}>
                {domain}
              </h2>
            </>
          )}
        </div>
      </div>
      {description && <p className="mt-3 text-xs leading-5 text-muted">{description}</p>}
    </header>
  )
}

export function DAppConnectionHeader({ domain, pageUrl }: DAppConnectionHeaderProps) {
  return <DAppRequestHeader domain={domain} pageUrl={pageUrl} action="Connect to" />
}

interface DAppConnectionHeaderProps {
  readonly domain: string
  readonly pageUrl: string
}

export interface ApprovalContextRow {
  readonly label: string
  readonly value: ReactNode
  readonly code?: boolean
  readonly title?: string
}

interface ApprovalRequestHeaderProps {
  readonly chain: string
  readonly title: string
  readonly description?: string
  readonly badge?: string
  readonly tone?: ApprovalRequestTone
}

export function ApprovalRequestHeader({
  chain,
  title,
  description,
  badge,
  tone = 'standard'
}: ApprovalRequestHeaderProps) {
  return (
    <header className="text-center">
      <div
        className={cn(
          'mx-auto mb-2.5 flex size-12 items-center justify-center rounded-2xl',
          tone === 'blocked'
            ? 'bg-danger/10'
            : tone === 'caution'
              ? 'bg-warning-surface'
              : 'bg-primary/10'
        )}
      >
        <ChainIcon
          chain={chain}
          width={28}
          height={28}
          className="rounded-lg"
          showTooltip={false}
        />
      </div>
      <h1 className="text-xl font-semibold">{title}</h1>
      {description && (
        <p className="mx-auto mt-1 max-w-[300px] text-xs leading-5 text-muted">{description}</p>
      )}
      {badge && (
        <div
          className={cn(
            'mx-auto mt-3 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium',
            tone === 'blocked'
              ? 'border-danger/40 bg-danger/10 text-danger'
              : tone === 'caution'
                ? 'border-warning/40 bg-warning-surface text-warning'
                : 'border-primary/30 bg-primary/10 text-primary'
          )}
        >
          {badge}
        </div>
      )}
    </header>
  )
}

interface ApprovalContextCardProps {
  readonly rows: readonly ApprovalContextRow[]
  readonly ariaLabel?: string
}

export function ApprovalContextCard({
  rows,
  ariaLabel = 'Request context'
}: ApprovalContextCardProps) {
  return (
    <section
      aria-label={ariaLabel}
      className="space-y-2 rounded-xl border border-border bg-card/35 p-3"
    >
      {rows.map((row, index) => (
        <div
          key={`${row.label}-${index}`}
          className="grid grid-cols-[88px_minmax(0,1fr)] gap-3 py-1"
        >
          <span className="text-xs text-muted">{row.label}</span>
          <div
            className={cn(
              'min-w-0 break-all text-right text-xs text-foreground/90',
              row.code && 'font-mono'
            )}
            title={row.title}
          >
            {row.value}
          </div>
        </div>
      ))}
    </section>
  )
}

interface ApprovalDetailCardProps {
  readonly title?: string
  readonly ariaLabel?: string
  readonly children: ReactNode
  readonly className?: string
}

export function ApprovalDetailCard({
  title,
  ariaLabel = title,
  children,
  className
}: ApprovalDetailCardProps) {
  return (
    <section
      aria-label={ariaLabel}
      className={cn('space-y-3 rounded-2xl bg-card/70 p-4', className)}
    >
      {title && <h2 className="text-sm text-foreground/80">{title}</h2>}
      {children}
    </section>
  )
}

interface DAppNetworkCardProps {
  readonly chain: string
  readonly network: string
  readonly chainId?: string
  readonly fee?: ReactNode
}

export function DAppNetworkCard({ chain, network, chainId, fee }: DAppNetworkCardProps) {
  return (
    <section aria-label="Network" className="space-y-3 rounded-2xl bg-card/70 p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-muted">Network</span>
        <span className="flex min-w-0 items-center gap-2 text-sm text-foreground/90">
          <ChainIcon
            chain={chain}
            width={18}
            height={18}
            className="rounded-full"
            showTooltip={false}
          />
          <span className="truncate">{network}</span>
        </span>
      </div>
      {chainId && (
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-muted">Chain ID</span>
          <span className="font-mono text-sm text-foreground/90">{chainId}</span>
        </div>
      )}
      {fee && (
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-muted">Network fee</span>
          {fee}
        </div>
      )}
    </section>
  )
}
