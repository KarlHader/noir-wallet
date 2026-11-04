import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { NoirPublicAssets } from '@/core/services/noir-protocol/public/types'
import { formatDisplayTokenAmount } from '@/popup/components/portfolio/portfolio-format'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import { PageHeader } from '@/popup/components/common/PageHeader'
import { noirPublicWalletClient } from '@/popup/services/noir-public-wallet-client'
import { useSettingsStore } from '@/store/settings-store'
import { useWalletStore } from '@/store/wallet-store'
import { publicTokenIcon } from '@/popup/services/noir-public-portfolio-presentation'
import { formatSymbol } from '@/lib/format'

export function NoirPublicAssetDetail() {
  const [searchParams] = useSearchParams()
  const tokenId = searchParams.get('tokenId')
  const balancesHidden = useSettingsStore(state => state.balancesHidden)
  const walletId = useWalletStore(state => state.currentWalletId)
  const accountId = useWalletStore(state => state.currentAccountId)
  const network = useWalletStore(state => state.currentNetwork)
  const scope = JSON.stringify([walletId, accountId, network])
  const [assets, setAssets] = useState<NoirPublicAssets | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadedScope, setLoadedScope] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setAssets(null)
    setError(null)
    setLoadedScope(null)
    if (!walletId || !accountId || network !== 'mainnet') return
    const load = async () => {
      try {
        const cached = await noirPublicWalletClient.getAssets(false)
        if (!active) return
        setAssets(cached)
        setLoadedScope(scope)
      } catch {
        // A fresh read can recover when the cache is unavailable.
      }
      try {
        const fresh = await noirPublicWalletClient.getAssets(true)
        if (!active) return
        setAssets(fresh)
        setError(null)
        setLoadedScope(scope)
      } catch (cause) {
        if (!active) return
        setError(cause instanceof Error ? cause.message : 'Unable to refresh asset')
        setLoadedScope(scope)
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [tokenId, walletId, accountId, network, scope])

  const visibleAssets = loadedScope === scope ? assets : null
  const visibleError = loadedScope === scope ? error : null
  const asset = visibleAssets?.assets.find(item => item.tokenId === tokenId)
  const symbol = formatSymbol(asset?.symbol)
  return (
    <div className="page-container flex h-full flex-col">
      <PageHeader title="Asset" showBack />
      {visibleError && (
        <p role="alert" className="px-5 py-3 text-sm text-danger">
          {visibleError}
        </p>
      )}
      {!walletId || !accountId || network !== 'mainnet' ? (
        <p className="px-5 py-3 text-sm text-muted">Asset unavailable</p>
      ) : (
        !visibleError &&
        !visibleAssets && (
          <p role="status" className="px-5 py-3 text-sm text-muted">
            Loading asset
          </p>
        )
      )}
      {visibleAssets && !asset && <p className="px-5 py-3 text-sm text-muted">Asset unavailable</p>}
      {asset && (
        <div className="px-5 pt-5">
          <div className="flex items-center gap-3">
            <TokenIcon
              symbol={symbol}
              icon={publicTokenIcon(asset.tokenId)}
              blockchain="zec"
              size="lg"
            />
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold">{asset.name}</h1>
              <p className="text-sm text-muted">{symbol} · Zcash · Public</p>
            </div>
          </div>
          <p className="mt-7 break-all font-mono text-2xl font-semibold">
            {balancesHidden
              ? '••••'
              : asset.balanceRaw === null
                ? '—'
                : `${formatDisplayTokenAmount(asset.balanceRaw, asset.decimals)} ${symbol}`}
          </p>
          {asset.status !== 'fresh' && (
            <p className="mt-2 text-xs text-muted">
              {asset.status === 'stale' ? 'Last known balance' : 'Balance unavailable'}
            </p>
          )}
          <div className="mt-7 border-t border-border pt-4">
            <p className="text-xs text-muted">Token contract</p>
            <p className="mt-1 break-all font-mono text-xs">{asset.tokenId}</p>
          </div>
        </div>
      )}
    </div>
  )
}
