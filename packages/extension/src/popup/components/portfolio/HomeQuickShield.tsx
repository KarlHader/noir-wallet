import { useMemo, useRef, useState } from 'react'
import { formatFiatAmount } from '@/lib/number-format'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { cn } from '@/lib/utils'
import { useWalletStore } from '@/store/wallet-store'
import { useSwapTokenCatalog } from '@/popup/hooks/useSwapTokenCatalog'
import { isPortfolioModelForScope } from '@/popup/services/portfolio-cache'
import {
  getQuickShieldAssets,
  summarizeQuickShieldAssets,
  type QuickShieldAsset
} from '@/popup/services/quick-shield'
import { ShieldFundsForm } from '@/popup/pages/transactions/ShieldFunds'
import type { ShieldFundsFormState } from '@/popup/services/shield-funds-route'
import type { ShieldProvider } from '@/popup/services/asset-domains'
import { ShieldTokenPicker } from '@/popup/components/tokens/ShieldTokenPicker'
import { TokenSelectorContent } from '@/popup/components/tokens/TokenSelectorDialog'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/popup/components/ui/dialog'
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
      readonly step: 'form'
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
  const selectAsset = (asset: QuickShieldAsset) => {
    setFormState({ busy: false, reviewing: false, fullHeight: false })
    setSelection({
      step: 'form',
      assetId: asset.asset.asset.id,
      provider: asset.providers[0]
    })
  }
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
      ? formState.busy
        ? 'h-[50dvh]'
        : 'h-[85dvh]'
      : 'h-[85dvh]'
  const { totalUsd, partial } = summarizeQuickShieldAssets(assets)
  const label =
    assets.length === 0
      ? undefined
      : balancesHidden
        ? '••••'
        : totalUsd === null
          ? undefined
          : `${formatFiatAmount(totalUsd, { showSign: true })}${partial ? ' (priced assets)' : ''}`

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
          position={formOpen ? 'bottom' : 'fullscreen'}
          overlayClassName="bg-black/55 backdrop-blur-none"
          scroll="body"
          showCloseButton={false}
          className={cn(
            'gap-0 p-0',
            formOpen && `home-wallet-sheet rounded-t-[20px] ${formHeight}`
          )}
          {...(formOpen ? { 'aria-describedby': undefined } : {})}
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
          {selection &&
            account &&
            (selection.step === 'form' ? (
              <div className="min-h-0 flex-1">
                <DialogTitle asChild className="sr-only">
                  <span>Shield</span>
                </DialogTitle>
                <ShieldFundsForm
                  direction="shield"
                  assetId={selection.assetId}
                  provider={selection.provider}
                  onStateChange={setFormState}
                  onBack={close}
                />
              </div>
            ) : (
              <TokenSelectorContent title="Select asset" onBack={close}>
                <DialogDescription className="sr-only">Choose an asset</DialogDescription>
                <ShieldTokenPicker
                  rows={assets.map(item => ({
                    item,
                    key: item.asset.asset.id,
                    assetId: item.asset.asset.id,
                    symbol: item.asset.metadata.symbol,
                    name: item.asset.metadata.name,
                    contractAddress:
                      item.asset.asset.kind === 'token' ? item.asset.asset.reference : undefined,
                    iconUrl: item.asset.metadata.iconUrl,
                    chainId: item.chain.id,
                    chainName: item.chain.displayName,
                    badgeBlockchain: resolveChainIconAlias(
                      item.chain.family,
                      item.chain.displayName,
                      item.chain.id
                    ),
                    zcashFundingSource:
                      item.chain.family === 'zcash' && item.asset.asset.kind === 'native'
                        ? ('transparent' as const)
                        : undefined,
                    availableRaw: item.availableRaw,
                    decimals: item.asset.metadata.decimals,
                    valueUsd: item.valueUsd
                  }))}
                  policy="funded"
                  balancesHidden={balancesHidden}
                  onSelect={row => selectAsset(row.item)}
                />
              </TokenSelectorContent>
            ))}
        </DialogContent>
      </Dialog>
    )
  }
}
