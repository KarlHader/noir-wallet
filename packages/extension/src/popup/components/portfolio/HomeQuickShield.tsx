import { useMemo, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import { formatSymbol } from '@/lib/format'
import { formatTokenQuantity, formatFiatAmount } from '@/lib/number-format'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { cn } from '@/lib/utils'
import { useWalletStore } from '@/store/wallet-store'
import { useSwapTokenCatalog } from '@/popup/hooks/useSwapTokenCatalog'
import { isPortfolioModelForScope } from '@/popup/services/portfolio-cache'
import {
  getQuickShieldAssets,
  quickShieldAssetAmount,
  summarizeQuickShieldAssets,
  type QuickShieldAsset
} from '@/popup/services/quick-shield'
import { ShieldFundsForm } from '@/popup/pages/transactions/ShieldFunds'
import type { ShieldFundsFormState } from '@/popup/services/shield-funds-route'
import type { ShieldProvider } from '@/popup/services/asset-domains'
import { SHIELD_PROVIDERS, ShieldProviderLogo } from './shield-providers'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import { Dialog, DialogContent, DialogTitle } from '@/popup/components/ui/dialog'
import { Button } from '@/popup/components/ui/button'
import { fullHeightTransactionDialogClassName } from '@/popup/components/transaction/TransactionResult'
import type { MultichainPortfolioPanelProps } from './MultichainPortfolioPanel'

interface HomeQuickShieldProps extends Pick<
  MultichainPortfolioPanelProps,
  'activeAccount' | 'walletId' | 'accountId' | 'model' | 'domain' | 'prices' | 'balancesHidden'
> {
  readonly active: boolean
}

type QuickShieldSelection =
  | { readonly step: 'asset' }
  | {
      readonly step: 'provider' | 'form'
      readonly assetId: string
      readonly provider: ShieldProvider
    }

export function useHomeQuickShield({
  active,
  activeAccount,
  walletId,
  accountId,
  model,
  domain,
  prices,
  balancesHidden = false
}: HomeQuickShieldProps) {
  const network = useWalletStore(state => state.currentNetwork)
  const scopeKey = JSON.stringify([network, walletId, accountId, domain, active])
  const [draft, setDraft] = useState<{ scopeKey: string; selection: QuickShieldSelection | null }>({
    scopeKey,
    selection: null
  })
  if (draft.scopeKey !== scopeKey) setDraft({ scopeKey, selection: null })
  const selection = draft.scopeKey === scopeKey ? draft.selection : null
  const setSelection = (next: QuickShieldSelection | null) =>
    setDraft({ scopeKey, selection: next })
  const [formState, setFormState] = useState<ShieldFundsFormState>({
    busy: false,
    reviewing: false,
    fullHeight: false
  })
  const entryButton = useRef<HTMLButtonElement>(null)
  const account =
    active &&
    (domain === 'public' || domain === 'shield') &&
    activeAccount?.walletId === walletId &&
    activeAccount?.accountId === accountId
      ? activeAccount
      : null
  const catalog = useSwapTokenCatalog(Boolean(account))
  const assets = useMemo(
    () =>
      account && isPortfolioModelForScope(model, walletId, accountId)
        ? getQuickShieldAssets({
            model,
            account,
            network,
            prices,
            catalog: catalog ?? [],
            enabledFlags: __ENABLED_CHAIN_FEATURE_FLAGS__
          })
        : [],
    [account, accountId, catalog, model, network, prices, walletId]
  )
  const byId = useMemo(
    () => new Map<string, QuickShieldAsset>(assets.map(row => [row.asset.asset.id, row])),
    [assets]
  )
  const selectAsset = (asset: QuickShieldAsset) =>
    setSelection({
      step: asset.providers.length === 1 ? 'form' : 'provider',
      assetId: asset.asset.asset.id,
      provider: asset.providers[0]
    })
  const open = (trigger: HTMLButtonElement, asset: QuickShieldAsset | null) => {
    entryButton.current = trigger
    if (asset) selectAsset(asset)
    else setSelection({ step: 'asset' })
  }
  const close = () => {
    if (!formState.busy) setSelection(null)
  }
  const formOpen = selection?.step === 'form'
  const formHeight = formState.fullHeight
    ? fullHeightTransactionDialogClassName
    : formState.reviewing
      ? 'h-[70dvh]'
      : 'h-[50dvh]'
  const selected = selection && selection.step !== 'asset' ? byId.get(selection.assetId) : null
  const { totalUsd, partial } = summarizeQuickShieldAssets(assets)
  const label =
    assets.length === 0
      ? undefined
      : balancesHidden
        ? '••••'
        : totalUsd === null
          ? undefined
          : `≈ ${formatFiatAmount(totalUsd, { showSign: true })}${partial ? ' (priced assets)' : ''}`

  return {
    eligible: assets.length > 0,
    label,
    onOpen: (trigger: HTMLButtonElement) => open(trigger, null),
    onShieldForAsset: (assetId: string) => {
      const asset = byId.get(assetId)
      return asset ? (trigger: HTMLButtonElement) => open(trigger, asset) : undefined
    },
    dialog: (
      <Dialog
        key={scopeKey}
        open={Boolean(selection && account)}
        onOpenChange={visible => !visible && close()}
      >
        <DialogContent
          position="bottom"
          overlayClassName="bg-black/55 backdrop-blur-none"
          scroll="body"
          showCloseButton={!formOpen}
          className={cn(
            'home-wallet-sheet rounded-t-[20px]',
            formOpen ? 'gap-0 p-0' : 'gap-3 px-4 pt-5 pb-4',
            formOpen && formHeight
          )}
          aria-describedby={undefined}
          onEscapeKeyDown={event => {
            if (formState.busy) event.preventDefault()
          }}
          onPointerDownOutside={event => {
            if (formState.busy) event.preventDefault()
          }}
          onCloseAutoFocus={event => {
            const trigger = entryButton.current
            if (!trigger?.isConnected) return
            event.preventDefault()
            trigger.focus()
          }}
        >
          <DialogTitle
            asChild={formOpen}
            className={formOpen ? 'sr-only' : 'min-h-7 pr-10 leading-7'}
          >
            {formOpen ? (
              <span>Quick Shield</span>
            ) : selected ? (
              `Shield ${formatSymbol(selected.asset.metadata.symbol)}`
            ) : (
              'Select asset'
            )}
          </DialogTitle>
          {selection && account && (
            <div
              className={formOpen ? 'min-h-0 flex-1' : 'min-h-0 overflow-y-auto overscroll-contain'}
            >
              {selection.step === 'form' ? (
                <ShieldFundsForm
                  direction="shield"
                  reviewMaximum
                  assetId={selection.assetId}
                  provider={selection.provider}
                  onStateChange={setFormState}
                  onBack={close}
                />
              ) : selection.step === 'provider' && selected ? (
                <div className="space-y-2">
                  {selected.providers.map(provider => (
                    <button
                      key={provider}
                      type="button"
                      aria-pressed={provider === selection.provider}
                      className="wallet-interactive flex min-h-12 w-full items-center gap-3 rounded-lg border border-border px-3 text-left text-sm font-medium aria-pressed:border-primary focus-visible:outline-2 focus-visible:outline-primary"
                      onClick={() => setSelection({ ...selection, provider })}
                    >
                      <ShieldProviderLogo provider={provider} size={24} />
                      {SHIELD_PROVIDERS[provider].name}
                      {provider === selection.provider && (
                        <Icon
                          icon="lucide:check"
                          className="ml-auto size-4 text-primary"
                          aria-hidden="true"
                        />
                      )}
                    </button>
                  ))}
                  <Button
                    size="wallet"
                    className="mt-3 w-full"
                    disabled={!selected.providers.includes(selection.provider)}
                    onClick={() => setSelection({ ...selection, step: 'form' })}
                  >
                    Continue
                  </Button>
                </div>
              ) : (
                <QuickShieldAssetList
                  assets={assets}
                  balancesHidden={balancesHidden}
                  onSelect={selectAsset}
                />
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    )
  }
}

function QuickShieldAssetList({
  assets,
  balancesHidden,
  onSelect
}: {
  readonly assets: readonly QuickShieldAsset[]
  readonly balancesHidden: boolean
  readonly onSelect: (asset: QuickShieldAsset) => void
}) {
  return (
    <ul className="divide-y divide-border/70">
      {assets.map(row => {
        const symbol = formatSymbol(row.asset.metadata.symbol)
        return (
          <li key={row.asset.asset.id}>
            <button
              type="button"
              className="wallet-interactive flex min-h-14 w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-foreground/5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
              onClick={() => onSelect(row)}
            >
              <QuickShieldTokenIcon row={row} size={32} showChainBadge />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{symbol}</span>
                <span className="block truncate text-xs text-muted">{row.chain.displayName}</span>
              </span>
              <span className="min-w-0 max-w-[42%] break-all text-right text-sm">
                {balancesHidden ? '••••' : formatTokenQuantity(quickShieldAssetAmount(row))}
              </span>
              <Icon
                icon="lucide:chevron-right"
                className="size-4 shrink-0 text-muted"
                aria-hidden="true"
              />
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function QuickShieldTokenIcon({
  row,
  size,
  showChainBadge = false
}: {
  readonly row: QuickShieldAsset
  readonly size: number
  readonly showChainBadge?: boolean
}) {
  return (
    <TokenIcon
      assetId={row.asset.asset.id}
      symbol={formatSymbol(row.asset.metadata.symbol)}
      icon={row.asset.metadata.iconUrl}
      blockchain={resolveChainIconAlias(row.chain.family, row.chain.displayName, row.chain.id)}
      showChainBadge={showChainBadge}
      size={size}
      className="shrink-0"
    />
  )
}
