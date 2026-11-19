import { useMemo, useState } from 'react'
import { AccountAvatar } from '@/popup/components/account/AccountAvatar'
import { ChainIcon } from '@/popup/components/common/ChainIcon'
import { ChainSelector } from '@/popup/components/common/ChainSelector'
import {
  CopyFeedbackIcon,
  CopyToast,
  useCopyToClipboard
} from '@/popup/components/common/CopyToast'
import { InlineError } from '@/popup/components/common/InlineError'
import { ReceivingAddressLayout } from '@/popup/components/common/ReceivingAddressLayout'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import { TokenSelectorDialog } from '@/popup/components/tokens/TokenSelectorDialog'
import { TokenSelectorView } from '@/popup/components/tokens/TokenSelectorView'
import { usePortfolioSnapshot } from '@/popup/hooks/usePortfolioSnapshot'
import { accountNetworkIconChain } from '@/popup/services/account-network-presentation'
import type { AccountNetworksView } from '@/popup/services/account-networks-client'
import { listPublicReceiveTokens, publicReceiveAddress } from '@/popup/services/public-receive'
import { rankTokenSearchFields } from '@/popup/services/swap-token-selection'
import { useWalletStore } from '@/store/wallet-store'
import { ReceiveField, ReceiveForm, type ReceiveMode } from './ReceiveForm'

export function PublicReceive({
  account,
  assetId,
  chainId,
  loading,
  shieldAvailable,
  refresh,
  onModeChange
}: {
  readonly account: AccountNetworksView | null
  readonly assetId: string | null
  readonly chainId: string | null
  readonly loading: boolean
  readonly shieldAvailable: boolean
  readonly refresh: () => Promise<void>
  readonly onModeChange: (mode: ReceiveMode) => void
}) {
  const network = useWalletStore(state => state.currentNetwork)
  const { model } = usePortfolioSnapshot(account?.walletId ?? null, account?.accountId ?? null, {
    autoRefresh: false
  })
  const choices = useMemo(
    () => listPublicReceiveTokens(network, account?.networks ?? [], model?.assets ?? []),
    [network, account?.networks, model?.assets]
  )
  const [picker, setPicker] = useState<'token' | 'network' | null>(null)
  const [search, setSearch] = useState('')
  const [selection, setSelection] = useState<{ tokenId: string; chainId: string | null } | null>(
    null
  )
  const [showAddress, setShowAddress] = useState(false)
  const { copyToClipboard, isCopied, copyFailed, showToast } = useCopyToClipboard()
  const preset = assetId
    ? choices.find(choice => choice.variants.some(item => item.assetId === assetId))
    : undefined
  const choice = selection ? choices.find(item => item.id === selection.tokenId) : preset
  const networkOptions = (account?.networks ?? []).filter(item =>
    choice?.variants.some(variant => variant.chainId === item.chain.id)
  )
  const selectedNetwork = networkOptions.find(
    item => item.chain.id === (selection ? selection.chainId : chainId)
  )
  const address = selectedNetwork && publicReceiveAddress(selectedNetwork)
  const networkName = selectedNetwork?.chain.displayName
  const iconChain = selectedNetwork && accountNetworkIconChain(selectedNetwork)

  if (showAddress && address && selectedNetwork) {
    return (
      <>
        <ReceivingAddressLayout
          onClose={() => setShowAddress(false)}
          qrValue={address.value}
          qrLabel={`${networkName} address QR code`}
          qrSize={172}
          identity={
            <div className="flex min-w-0 items-center gap-2.5">
              <AccountAvatar
                walletId={account?.walletId ?? null}
                className="size-9 shrink-0 rounded-full object-cover"
              />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{account?.accountDisplayName}</p>
                <p className="truncate text-xs text-muted">{networkName}</p>
              </div>
            </div>
          }
        >
          <h2 className="mt-5 text-center text-xl font-medium">
            {networkName}{' '}
            {selectedNetwork.chain.family === 'zcash' ? 'transparent address' : 'address'}
          </h2>
          <p className="mt-1 text-center text-sm text-muted">
            Receive {choice?.token.symbol} on {networkName} only.
          </p>
          <div className="mt-5 flex min-h-12 w-full items-center gap-2 rounded-lg border border-border bg-wallet-surface px-3 py-2">
            <p className="min-w-0 flex-1 break-all text-sm" title={address.value}>
              {address.value}
            </p>
            <button
              type="button"
              aria-label={isCopied(address.value) ? 'Address copied' : 'Copy receiving address'}
              title="Copy receiving address"
              onClick={() =>
                void copyToClipboard(address.value, address.value, { toastOnSuccess: true })
              }
              className="wallet-interactive flex size-9 shrink-0 items-center justify-center rounded-md hover:bg-wallet-selected focus-visible:outline-2 focus-visible:outline-primary"
            >
              <CopyFeedbackIcon copied={isCopied(address.value)} width={17} height={17} />
            </button>
          </div>
        </ReceivingAddressLayout>
        <CopyToast show={showToast} error={copyFailed} message="Address copied" />
      </>
    )
  }

  const visibleChoices = choices
    .map(item => ({ item, rank: rankTokenSearchFields(item.token, search) }))
    .filter(({ rank }) => rank < 99)
    .sort((left, right) => left.rank - right.rank)
    .map(({ item }) => ({
      key: item.id,
      symbol: item.token.symbol,
      subtitle:
        item.variants.length > 1
          ? item.token.name
          : (account?.networks.find(entry => entry.chain.id === item.token.chainId)?.chain
              .displayName ?? item.token.name),
      icon: (
        <TokenIcon
          assetId={item.token.assetId}
          symbol={item.token.symbol}
          icon={item.token.icon}
          size={32}
        />
      )
    }))

  return (
    <>
      <ReceiveForm
        mode="public"
        onModeChange={onModeChange}
        shieldAvailable={shieldAvailable}
        disabled={!address}
        onShowAddress={() => setShowAddress(true)}
      >
        <ReceiveField
          label="Receive Token"
          value={choice?.token.symbol}
          icon={
            choice && (
              <TokenIcon
                assetId={choice.token.assetId}
                symbol={choice.token.symbol}
                icon={choice.token.icon}
                size={32}
              />
            )
          }
          placeholderIcon="lucide:coins"
          disabled={choices.length === 0}
          onClick={() => {
            setSearch('')
            setPicker('token')
          }}
        />
        <ReceiveField
          label={selectedNetwork ? 'Network' : 'Select Network'}
          value={networkName}
          icon={
            iconChain && <ChainIcon chain={iconChain} showTooltip={false} width={32} height={32} />
          }
          placeholderIcon="lucide:globe"
          disabled={networkOptions.length === 0}
          onClick={() => setPicker('network')}
        />
        {!loading && choices.length === 0 && (
          <InlineError
            message="Public receiving addresses unavailable"
            onRetry={() => void refresh()}
          />
        )}
      </ReceiveForm>
      <TokenSelectorDialog
        open={picker === 'token'}
        onOpenChange={open => !open && setPicker(null)}
      >
        <TokenSelectorView
          search={search}
          onSearchChange={setSearch}
          networks={[]}
          selectedNetwork="all"
          onNetworkChange={() => {}}
          items={visibleChoices}
          selectedKey={choice?.id}
          onSelect={tokenId => {
            setSelection({
              tokenId,
              chainId: choice?.id === tokenId ? (selectedNetwork?.chain.id ?? null) : null
            })
            setPicker(null)
          }}
        />
      </TokenSelectorDialog>
      <ChainSelector
        open={picker === 'network'}
        onOpenChange={open => setPicker(open ? 'network' : null)}
        options={networkOptions.map(item => ({
          id: item.chain.id,
          name: item.chain.displayName,
          icon: accountNetworkIconChain(item)
        }))}
        selectedId={selectedNetwork?.chain.id ?? null}
        onSelect={id => {
          if (choice) setSelection({ tokenId: choice.id, chainId: id })
        }}
      />
    </>
  )
}
