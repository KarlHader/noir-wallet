import { useMemo, useState, type ReactNode } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { Icon } from '@iconify/react'
import { formatSymbol } from '@/lib/format'
import providerPlaceholder from '@/images/figma-receive-provider.svg'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { ChainIcon } from '@/popup/components/common/ChainIcon'
import { ChainSelector } from '@/popup/components/common/ChainSelector'
import type { Network } from '@/types/wallet'
import { PageHeader } from '@/popup/components/common/PageHeader'
import { ShieldProviderDialog } from '@/popup/components/portfolio/ShieldProviderPicker'
import {
  ShieldReceiveAddress,
  ShieldReceiveAddressSkeleton
} from '@/popup/components/portfolio/ShieldReceiveAddress'
import { SHIELD_PROVIDERS, ShieldProviderLogo } from '@/popup/components/portfolio/shield-providers'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import { ShieldTokenPicker } from '@/popup/components/tokens/ShieldTokenPicker'
import { TokenSelectorDialog } from '@/popup/components/tokens/TokenSelectorDialog'
import { TransactionNotice } from '@/popup/components/transaction/TransactionNotice'
import { Skeleton } from '@/popup/components/ui/skeleton'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import { useCachedAssetPrices } from '@/popup/hooks/useCachedAssetPrices'
import { usePortfolioSnapshot } from '@/popup/hooks/usePortfolioSnapshot'
import { useShieldReceiveCatalog } from '@/popup/hooks/useShieldReceiveCatalog'
import type {
  AccountNetworksCatalogView,
  AccountNetworksView
} from '@/popup/services/account-networks-client'
import type { ShieldProvider } from '@/popup/services/asset-domains'
import {
  buildShieldReceivePickerRows,
  canReceiveNearShield,
  listShieldReceiveTokens,
  resolveShieldReceiveSelection,
  type ShieldReceiveToken
} from '@/popup/services/shield-receive'
import { useSettingsStore } from '@/store/settings-store'
import { useSwapPreferences } from '@/store/swap-store'
import { useWalletStore } from '@/store/wallet-store'

function receiveTokenIcon(token: ShieldReceiveToken) {
  return token.id === 'native-zec' ? (
    <ChainIcon chain="zcash" width={32} height={32} showTooltip={false} />
  ) : (
    <TokenIcon
      assetId={token.routes[0]?.assetId}
      symbol={formatSymbol(token.symbol)}
      icon={token.iconUrl}
      size={32}
    />
  )
}

const fieldClass =
  'wallet-interactive relative flex h-[62px] w-full items-center gap-2.5 rounded-xl bg-accent px-4 text-left focus-within:outline-2 focus-within:outline-ring'

function FieldContent({
  icon,
  label,
  value,
  placeholderIcon
}: {
  icon?: ReactNode
  label: string
  value?: string
  placeholderIcon: ReactNode
}) {
  return (
    <>
      <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center">
        {icon ?? (
          <span className="grid size-8 place-items-center rounded-md bg-[#393e46] text-muted">
            {placeholderIcon}
          </span>
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 font-medium">
        <span className="text-xs leading-4 text-muted">{label}</span>
        {value && <span className="truncate text-base leading-5">{value}</span>}
      </span>
      <svg aria-hidden="true" width="10" height="6" viewBox="0 0 10 6" fill="none">
        <path d="m.5 1 4.5 4 4.5-4" stroke="currentColor" />
      </svg>
    </>
  )
}

interface ShieldReceiveEntry {
  readonly assetId: string | null
  readonly provider: ShieldProvider | null
}

function ShieldReceiveFormSkeleton() {
  return (
    <div className="space-y-2.5 pt-[14px]">
      <Skeleton className="h-[62px] w-full rounded-xl" />
      <Skeleton className="h-[62px] w-full rounded-xl" />
      <Skeleton className="h-[62px] w-full rounded-xl" />
      <ShieldReceiveAddressSkeleton />
    </div>
  )
}

export function ShieldReceive() {
  const [params] = useSearchParams()
  const { key: navigationKey } = useLocation()
  const walletId = params.get('walletId')
  const accountId = params.get('accountId')
  const network = useWalletStore(state => state.currentNetwork)
  const { activeAccount, catalog, loading, error, contextChanging, refresh } =
    useActiveAccountNetworks()
  const accountChanged = Boolean(
    activeAccount &&
    ((walletId !== null && walletId !== activeAccount.walletId) ||
      (accountId !== null && accountId !== activeAccount.accountId))
  )
  const provider = params.get('provider')
  const entry = {
    assetId: params.get('assetId'),
    provider: provider === 'zcash-shield' || provider === 'near-confidential' ? provider : null
  } satisfies ShieldReceiveEntry

  return (
    <div className="page-container" data-wallet-mode="shield">
      <PageHeader title="Receive" showBack />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-5">
        <div className="mx-auto w-full max-w-[440px]">
          {activeAccount && !accountChanged && !contextChanging ? (
            <ShieldReceiveForm
              key={JSON.stringify([
                navigationKey,
                network,
                activeAccount.walletId,
                activeAccount.accountId,
                entry
              ])}
              account={activeAccount}
              accountCatalog={catalog}
              network={network}
              entry={entry}
            />
          ) : accountChanged ? (
            <TransactionNotice tone="muted" message="Account changed. Reopen Receive." />
          ) : !error && (loading || contextChanging) ? (
            <ShieldReceiveFormSkeleton />
          ) : (
            <TransactionNotice
              message="Could not load the account."
              onRetry={() => void refresh()}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function ShieldReceiveForm({
  account,
  accountCatalog,
  network,
  entry
}: {
  readonly account: AccountNetworksView
  readonly accountCatalog: AccountNetworksCatalogView | null
  readonly network: Network
  readonly entry: ShieldReceiveEntry
}) {
  const slippageBps = useSwapPreferences(state => Math.round(state.slippage * 100))
  const catalog = useShieldReceiveCatalog(canReceiveNearShield(network, account))
  const tokens = useMemo(
    () => listShieldReceiveTokens(network, account, catalog.tokens),
    [network, account, catalog.tokens]
  )
  const { model } = usePortfolioSnapshot(account.walletId, account.accountId, {
    autoRefresh: false
  })
  const prices = useCachedAssetPrices(network)
  const balancesHidden = useSettingsStore(state => state.balancesHidden)
  const tokenPickerRows = useMemo(
    () => buildShieldReceivePickerRows(tokens, model, prices),
    [tokens, model, prices]
  )
  const tokenPickerNetworks = useMemo(
    () => [
      ...new Map(
        tokens.flatMap(item =>
          item.routes.map(
            route =>
              [
                route.chain.id,
                {
                  id: route.chain.id,
                  label: route.chain.displayName,
                  iconChain: resolveChainIconAlias(
                    route.chain.family,
                    route.chain.displayName,
                    route.chain.id
                  )
                }
              ] as const
          )
        )
      ).values()
    ],
    [tokens]
  )
  const [picker, setPicker] = useState<'token' | 'network' | 'provider' | null>(() =>
    entry.assetId || entry.provider ? null : 'token'
  )
  const closePicker = () => setPicker(null)
  const [selection, setSelection] = useState<{
    tokenId: string
    routeId: string | null
    provider?: ShieldProvider
  } | null>(null)
  const { token, route } = resolveShieldReceiveSelection(tokens, selection, entry, !catalog.loading)
  const networks = [...new Map(token?.routes.map(item => [item.chain.id, item.chain])).values()]
  const chain = route?.chain
  const providerRoutes = token?.routes.filter(item => item.chain.id === chain?.id) ?? []
  const catalogError = catalog.error ? (
    <TransactionNotice message="Could not load NEAR Confidential tokens." onRetry={catalog.retry} />
  ) : null

  return (
    <>
      <div className="space-y-2.5 pt-[14px]">
        <button
          type="button"
          aria-haspopup="dialog"
          className={fieldClass}
          onClick={() => setPicker('token')}
        >
          <FieldContent
            icon={token && receiveTokenIcon(token)}
            placeholderIcon={<Icon icon="lucide:coins" width={16} />}
            label={token ? 'Token' : 'Select token'}
            value={token ? formatSymbol(token.symbol) : undefined}
          />
        </button>
        <button
          type="button"
          aria-label="Network"
          aria-haspopup="dialog"
          className={fieldClass}
          disabled={networks.length === 0}
          onClick={() => setPicker('network')}
        >
          <FieldContent
            label={chain ? 'Network' : 'Select Network'}
            value={chain?.displayName}
            placeholderIcon={<Icon icon="lucide:globe" width={16} />}
            icon={
              chain && (
                <ChainIcon
                  chain={resolveChainIconAlias(chain.family, chain.displayName, chain.id)}
                  width={32}
                  height={32}
                  showTooltip={false}
                />
              )
            }
          />
        </button>
        <button
          type="button"
          aria-label="Shield provider"
          aria-haspopup="dialog"
          className={fieldClass}
          disabled={providerRoutes.length === 0}
          onClick={() => setPicker('provider')}
        >
          <FieldContent
            label="Shield provider"
            value={route ? SHIELD_PROVIDERS[route.provider].detailName : undefined}
            placeholderIcon={<img src={providerPlaceholder} alt="" width={15} height={16} />}
            icon={route && <ShieldProviderLogo provider={route.provider} size={32} />}
          />
        </button>
        {catalogError ??
          (catalog.loading && !token ? (
            <ShieldReceiveAddressSkeleton />
          ) : !catalog.loading && tokens.length === 0 ? (
            <TransactionNotice
              tone="muted"
              message="No Shield receiving options for this account."
            />
          ) : !catalog.loading && !selection && entry.assetId && !token ? (
            <TransactionNotice
              tone="muted"
              message="This token is unavailable for Shield Receive."
            />
          ) : null)}
      </div>
      {route && (
        <ShieldReceiveAddress
          key={route.id}
          inline
          enabled
          provider={route.provider}
          network={network}
          account={account}
          accountCatalog={accountCatalog}
          asset={route.provider === 'near-confidential' ? route.asset : null}
          zcashAddress={route.provider === 'zcash-shield' ? route.address : undefined}
          slippageBps={slippageBps}
        />
      )}
      <TokenSelectorDialog open={picker === 'token'} onOpenChange={open => !open && closePicker()}>
        <ShieldTokenPicker
          rows={tokenPickerRows}
          networks={tokenPickerNetworks}
          policy="grouped"
          loading={catalog.loading}
          toolbar={catalogError}
          balancesHidden={balancesHidden}
          selectedKey={token?.id}
          onSelect={item => {
            const selectedToken = tokens.find(candidate => candidate.id === item.key)
            const chainIds = new Set(selectedToken?.routes.map(candidate => candidate.chain.id))
            setSelection({ tokenId: item.key, routeId: null })
            setPicker(chainIds.size > 1 ? 'network' : null)
          }}
        />
      </TokenSelectorDialog>
      <ChainSelector
        open={picker === 'network'}
        onOpenChange={open => !open && closePicker()}
        options={networks.map(item => ({
          id: item.id,
          name: item.displayName,
          icon: resolveChainIconAlias(item.family, item.displayName, item.id)
        }))}
        selectedId={chain?.id}
        onSelect={id => {
          if (id === chain?.id) return
          const next =
            token?.routes.find(
              item => item.chain.id === id && item.provider === selection?.provider
            ) ?? token?.routes.find(item => item.chain.id === id)
          if (token && next) setSelection({ tokenId: token.id, routeId: next.id })
        }}
      />
      <ShieldProviderDialog
        open={picker === 'provider'}
        onClose={closePicker}
        selected={route?.provider ?? null}
        available={{
          'zcash-shield': providerRoutes.some(item => item.provider === 'zcash-shield'),
          'near-confidential': providerRoutes.some(item => item.provider === 'near-confidential')
        }}
        onSelect={provider => {
          if (provider !== route?.provider) {
            const next = providerRoutes.find(item => item.provider === provider)
            if (token && next) setSelection({ tokenId: token.id, routeId: next.id })
          }
          closePicker()
        }}
        networks={account.networks.map(item => item.chain)}
        tokens={catalog.tokens}
      />
    </>
  )
}
