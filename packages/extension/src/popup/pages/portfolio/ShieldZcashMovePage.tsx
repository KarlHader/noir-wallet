import { useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { getZcashChainId } from '@/core/chains/registry'
import { getFundingSourceUnavailableReason } from '@/core/wallet/funding-source'
import { useWalletStore } from '@/store/wallet-store'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import { useHomePortfolio } from '@/popup/hooks/useHomePortfolio'
import {
  balanceTransferLabel,
  fixedTransferSide,
  getPrivateTransferChainIds,
  resolveBalanceTransferIntent
} from '@/popup/services/private-balance-transfer'
import { getConfidentialZcashMoveRecipients } from '@/popup/services/zcash-self-move'
import { resolveShieldNativeZecSwapAvailable } from '@/popup/services/shield-swap-zec-sources'
import { useNavigate } from '@/popup/provider/Router'
import { PageHeader } from '@/popup/components/common/PageHeader'
import { ZcashMoveAccountCard } from '@/popup/components/transaction/ZcashMoveLayout'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/popup/components/ui/dialog'
import { ZcashTransfer } from '@/popup/components/transaction/ZcashTransfer'
import { ShieldWithdrawForm } from './ShieldWithdrawPage'

type ZcashMoveDomain = 'transparent' | 'shielded' | 'confidential'

export function ShieldZcashMovePage() {
  const network = useWalletStore(state => state.currentNetwork)
  const walletId = useWalletStore(state => state.currentWalletId)
  const accountId = useWalletStore(state => state.currentAccountId)
  return <ShieldZcashMoveContent key={`${network}:${walletId}:${accountId}`} />
}

function ShieldZcashMoveContent() {
  const [params] = useSearchParams()
  const location = useLocation()
  const { navigate } = useNavigate()
  const network = useWalletStore(state => state.currentNetwork)
  const walletId = useWalletStore(state => state.currentWalletId)
  const accountId = useWalletStore(state => state.currentAccountId)
  const currentWallet = useWalletStore(state => state.getCurrentWallet())
  const currentAccount = useWalletStore(state => state.getCurrentAccount())
  const { activeAccount, loading } = useActiveAccountNetworks()
  const { model } = useHomePortfolio(walletId, accountId)
  const [state, setState] = useState({ reviewing: false, busy: false })
  const [picker, setPicker] = useState<'source' | 'destination' | null>(null)
  const chainId = getZcashChainId(network)
  const assetId = `${chainId}/slip44:133`
  const recipients = getConfidentialZcashMoveRecipients(activeAccount, network)
  const nativeSources = recipients.filter(
    item => !getFundingSourceUnavailableReason(currentWallet?.keySource, item.privacy)
  )
  const confidentialAvailable = Boolean(
    activeAccount?.walletSource.kind === 'software' &&
    getPrivateTransferChainIds(activeAccount, network === 'mainnet').length > 0 &&
    recipients.length > 0
  )
  const nativeToConfidentialAvailable = Boolean(
    confidentialAvailable &&
    network === 'mainnet' &&
    resolveShieldNativeZecSwapAvailable({
      network,
      portfolio: null,
      enabledFlags: __ENABLED_CHAIN_FEATURE_FLAGS__,
      zcashAccountEnabled: recipients.length > 0
    })
  )
  const options: ZcashMoveDomain[] = [
    ...nativeSources.map(item => item.privacy),
    ...(confidentialAvailable ? (['confidential'] as const) : [])
  ]
  const requestedSource = params.get('from')
  const source: ZcashMoveDomain =
    requestedSource === 'transparent' ||
    requestedSource === 'shielded' ||
    requestedSource === 'confidential'
      ? requestedSource
      : 'confidential'
  const requestedDestination = params.get('to')
  const defaultDestination =
    source === 'confidential'
      ? (recipients[0]?.privacy ?? 'transparent')
      : nativeToConfidentialAvailable
        ? 'confidential'
        : source === 'transparent'
          ? 'shielded'
          : 'transparent'
  const destination: ZcashMoveDomain =
    requestedDestination === 'transparent' ||
    requestedDestination === 'shielded' ||
    requestedDestination === 'confidential'
      ? requestedDestination
      : defaultDestination
  const accountMatches = Boolean(
    walletId &&
    accountId &&
    params.get('sourceWalletId') === walletId &&
    params.get('sourceAccountId') === accountId &&
    activeAccount?.walletId === walletId &&
    activeAccount.accountId === accountId
  )
  const canRoute = (from: ZcashMoveDomain, to: ZcashMoveDomain) =>
    from !== to &&
    options.includes(from) &&
    (to === 'confidential'
      ? nativeToConfidentialAvailable
      : recipients.some(item => item.privacy === to))
  const available =
    accountMatches && params.get('assetId') === assetId && canRoute(source, destination)
  const intent = resolveBalanceTransferIntent(params.get('intent'))
  const fixedSide = fixedTransferSide(intent)
  const actionLabel = balanceTransferLabel(
    intent ?? (destination === 'transparent' ? 'withdraw' : 'deposit')
  )
  const canReverse = !fixedSide && canRoute(destination, source)
  const openSourcePicker = fixedSide === 'from' ? undefined : () => setPicker('source')
  const openDestinationPicker = fixedSide === 'to' ? undefined : () => setPicker('destination')

  const updateDirection = (nextSource: ZcashMoveDomain, nextDestination: ZcashMoveDomain) => {
    const next = new URLSearchParams(params)
    next.set('from', nextSource)
    next.set('to', nextDestination)
    next.set('move', '1')
    navigate(`${location.pathname}?${next.toString()}`, { replace: true, state: location.state })
    setPicker(null)
  }
  const selectSource = (next: ZcashMoveDomain) => {
    if (fixedSide === 'from' || (fixedSide === 'to' && next === destination)) return
    const nextDestination =
      next === destination
        ? source === 'confidential' && next !== 'confidential'
          ? 'confidential'
          : source
        : destination
    if (canRoute(next, nextDestination)) updateDirection(next, nextDestination)
  }
  const selectDestination = (next: ZcashMoveDomain) => {
    if (fixedSide === 'to') return
    if (canRoute(source, next)) updateDirection(source, next)
  }
  const addressFor = (domain: ZcashMoveDomain) =>
    domain === 'confidential'
      ? ''
      : (recipients.find(item => item.privacy === domain)?.address ?? '')

  return (
    <div className="page-container">
      {!state.reviewing && <PageHeader title={actionLabel} showBack backDisabled={state.busy} />}
      {available ? (
        source === 'confidential' ? (
          <ShieldWithdrawForm
            key={`${source}:${destination}`}
            active
            moveToOwnZcash
            balanceAction={actionLabel}
            lockMoveDestination={fixedSide === 'to'}
            entry={{
              assetId,
              networkId: chainId,
              recipient: addressFor(destination),
              provider: 'near-confidential'
            }}
            onStateChange={setState}
            model={model}
            initialAsset={model?.assets.find(item => item.asset.id === assetId) ?? null}
            onSelectPublic={() => {}}
            onOpenSourcePicker={() => {}}
            onMoveSourceSelect={openSourcePicker}
            onMoveDestinationSelect={openDestinationPicker}
            onMoveReverse={canReverse ? () => updateDirection(destination, source) : undefined}
          />
        ) : (
          <ZcashTransfer
            key={`${source}:${destination}`}
            embedded
            moveDestination={destination}
            onMoveSourceSelect={openSourcePicker}
            onMoveDestinationSelect={openDestinationPicker}
            onMoveReverse={canReverse ? () => updateDirection(destination, source) : undefined}
            onMoveStateChange={setState}
          />
        )
      ) : (
        <p role="status" className="px-4 py-6 text-center text-sm text-muted">
          {loading
            ? 'Loading account…'
            : accountMatches
              ? `${actionLabel} is unavailable for this account`
              : 'Account changed. Reopen this transfer.'}
        </p>
      )}
      <Dialog open={available && picker !== null} onOpenChange={open => !open && setPicker(null)}>
        <DialogContent
          position="bottom"
          className="max-h-[80vh] min-h-0 overflow-y-auto bg-wallet-surface p-4 pb-6"
        >
          <DialogTitle>{picker === 'source' ? 'Select source' : 'Select destination'}</DialogTitle>
          <DialogDescription className="sr-only">Select a ZEC balance</DialogDescription>
          <div className="space-y-2">
            {options
              .filter(option => {
                if (picker === 'destination') return canRoute(source, option)
                if (fixedSide === 'to') return canRoute(option, destination)
                const nextDestination =
                  option === destination
                    ? source === 'confidential' && option !== 'confidential'
                      ? 'confidential'
                      : source
                    : destination
                return canRoute(option, nextDestination)
              })
              .map(option => (
                <ZcashMoveAccountCard
                  key={option}
                  label={picker === 'source' ? 'From' : 'To'}
                  source={option}
                  accountName={activeAccount?.accountDisplayName ?? currentAccount?.name ?? ''}
                  address={addressFor(option)}
                  selected={option === (picker === 'source' ? source : destination)}
                  onClick={() =>
                    picker === 'source' ? selectSource(option) : selectDestination(option)
                  }
                />
              ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
