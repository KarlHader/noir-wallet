import { useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Icon } from '@iconify/react'
import { formatSymbol } from '@/lib/format'
import providerPlaceholder from '@/images/figma-receive-provider.svg'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { ChainIcon } from '@/popup/components/common/ChainIcon'
import type { Network } from '@/types/wallet'
import { PageHeader } from '@/popup/components/common/PageHeader'
import { ShieldReceiveAddress } from '@/popup/components/portfolio/ShieldReceiveAddress'
import { SHIELD_PROVIDERS, ShieldProviderLogo } from '@/popup/components/portfolio/shield-providers'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import { TokenPicker, type TokenPickerAdapter } from '@/popup/components/tokens/TokenPicker'
import { TransactionNotice } from '@/popup/components/transaction/TransactionNotice'
import { Dialog, DialogContent, DialogTitle } from '@/popup/components/ui/dialog'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import { useShieldReceiveCatalog } from '@/popup/hooks/useShieldReceiveCatalog'
import type {
  AccountNetworksCatalogView,
  AccountNetworksView
} from '@/popup/services/account-networks-client'
import type { ShieldProvider } from '@/popup/services/asset-domains'
import {
  canReceiveNearShield,
  listShieldReceiveTokens,
  resolveShieldReceiveSelection,
  type ShieldReceiveToken
} from '@/popup/services/shield-receive'
import { useSwapPreferences } from '@/store/swap-store'
import { useWalletStore } from '@/store/wallet-store'

const tokenPickerAdapter: TokenPickerAdapter<ShieldReceiveToken> = {
  chainId: () => 'all',
  searchFields: token => ({
    symbol: token.symbol,
    name: token.name,
    searchTerms: [token.subtitle ?? '']
  })
}

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

export function ShieldReceive() {
  const [params] = useSearchParams()
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
            <p role="status" className="py-6 text-center text-sm text-muted">
              Loading account…
            </p>
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
  const [pickerOpen, setPickerOpen] = useState(false)
  const [selection, setSelection] = useState<{ tokenId: string; routeId: string | null } | null>(
    null
  )
  const { token, route } = resolveShieldReceiveSelection(tokens, selection, entry, !catalog.loading)
  const networks = [...new Map(token?.routes.map(item => [item.chain.id, item.chain])).values()]
  const chain = route?.chain
  const providerRoutes = token?.routes.filter(item => item.chain.id === chain?.id) ?? []
  const selectClass =
    'absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default'

  return (
    <>
      <div className="space-y-2.5 pt-[14px]">
        <button
          type="button"
          aria-haspopup="dialog"
          className={fieldClass}
          disabled={tokens.length === 0}
          onClick={() => setPickerOpen(true)}
        >
          <FieldContent
            icon={token && receiveTokenIcon(token)}
            placeholderIcon={<Icon icon="lucide:coins" width={16} />}
            label={token ? 'Token' : 'Select token'}
            value={token ? formatSymbol(token.symbol) : undefined}
          />
        </button>
        <label className={fieldClass}>
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
          <select
            aria-label="Network"
            className={selectClass}
            value={chain?.id ?? ''}
            disabled={!token || !networks.length}
            onChange={event => {
              const next = token?.routes.find(item => item.chain.id === event.target.value)
              if (token && next) setSelection({ tokenId: token.id, routeId: next.id })
            }}
          >
            <option value="" disabled>
              Select Network
            </option>
            {networks.map(item => (
              <option key={item.id} value={item.id}>
                {item.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className={fieldClass}>
          <FieldContent
            label="Shield provider"
            value={route ? SHIELD_PROVIDERS[route.provider].name : undefined}
            placeholderIcon={<img src={providerPlaceholder} alt="" width={15} height={16} />}
            icon={route && <ShieldProviderLogo provider={route.provider} size={32} />}
          />
          <select
            aria-label="Shield provider"
            className={selectClass}
            value={route?.id ?? ''}
            disabled={!providerRoutes.length}
            onChange={event => {
              if (token) setSelection({ tokenId: token.id, routeId: event.target.value })
            }}
          >
            <option value="" disabled>
              Shield provider
            </option>
            {providerRoutes.map(item => (
              <option key={item.id} value={item.id}>
                {SHIELD_PROVIDERS[item.provider].name}
              </option>
            ))}
          </select>
        </label>
        {catalog.error ? (
          <TransactionNotice
            message="Could not load NEAR Confidential tokens."
            onRetry={catalog.retry}
          />
        ) : catalog.loading && !token ? (
          <p role="status" className="text-sm text-muted">
            Loading tokens…
          </p>
        ) : !catalog.loading && tokens.length === 0 ? (
          <TransactionNotice tone="muted" message="No Shield receiving options for this account." />
        ) : !catalog.loading && !selection && entry.assetId && !token ? (
          <TransactionNotice tone="muted" message="This token is unavailable for Shield Receive." />
        ) : null}
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
      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent position="bottom" scroll="body">
          <DialogTitle>Select token</DialogTitle>
          <TokenPicker
            rows={tokens}
            networks={[]}
            adapter={tokenPickerAdapter}
            selectedKey={token?.id}
            toItem={item => ({
              key: item.id,
              symbol: formatSymbol(item.symbol),
              icon: receiveTokenIcon(item),
              subtitle: item.subtitle
            })}
            onSelect={item => {
              setSelection({ tokenId: item.id, routeId: null })
              setPickerOpen(false)
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  )
}
